const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('aja-device.js'), {});
}

// AJA's own documented examples (REST API chapter 08): the Dropped Frames alarm
// in the NORMAL state and in the ALARM state with an explanation entry.
const ALARM_NORMAL = 'CAAQABogCg5Ecm9wcGVkIEZyYW1lcxIORHJvcHBlZCBGcmFtZXM=';
const ALARM_ACTIVE =
  'CAEQABogCg5Ecm9wcGVkIEZyYW1lcxIORHJvcHBlZCBGcmFtZXMaKAomUGxheWJhY2sgY29udGludWVkIGFmdGVyIGRyb3BwZWQgZnJhbWU=';

// Encode an Alarm protobuf the way alarm.proto describes it, for cases the
// documented examples do not cover (other severities and labels).
function encodeAlarm(state, severity, texts) {
  const varint = (n) => {
    const out = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  };
  const ld = (field, buf) => Buffer.from([(field << 3) | 2, ...varint(buf.length), ...buf]);
  const parts = [Buffer.from([0x08, state, 0x10, severity])];
  for (const t of texts) {
    parts.push(ld(3, ld(1, Buffer.from(t, 'utf8'))));
  }
  return Buffer.concat(parts).toString('base64');
}

function descriptor(id, alarm = false) {
  return {
    param_type: alarm ? 'data' : 'enum',
    param_id: id,
    param_name: id,
    string_attributes: alarm
      ? [
          { name: 'Content-Type', value: 'application/vnd.google.protobuf' },
          { name: 'protobuf_message', value: '/alarm.proto' },
        ]
      : [{ name: 'description', value: 'x' }],
  };
}

const KIPRO_PARAMS = {
  eParamID_SysName: { value: 'Ki Pro A', value_name: 'Ki Pro A' },
  eParamID_TransportState: { value: '2', value_name: 'Recording' },
  eParamID_CurrentMediaAvailable: { value: '64', value_name: '64' },
  eParamID_MediaState: { value: '0', value_name: 'Record-Play' },
  eParamID_VideoInSelect: { value: '0', value_name: 'SDI' },
  eParamID_DisplayTimecode: { value: '01:02:03:04', value_name: '01:02:03:04' },
};

// A fake AJA web server. `params` maps paramid -> {value, value_name}; `alarms`
// maps alarm paramid -> base64. Every request URL is recorded so tests can prove
// the probe only ever reads.
function startAja(opts = {}) {
  const {
    params = KIPRO_PARAMS,
    alarms = { eParamID_Dropped_Frames_Alarm: ALARM_NORMAL },
    desc = true,
    password = null,
    delayMs = 0,
    garbage = false,
    // paramid -> true (accept the set), an HTTP status, or 'garbage'.
    sets = null,
  } = opts;
  const received = [];
  let logins = 0;
  const server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://x');
    const reply = (status, body, headers = {}) =>
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(body);
      }, delayMs);
    if (garbage) return reply(200, '<html>router login</html>');
    if (url.pathname === '/authenticator/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        logins++;
        const ok = password && body === `password_provided=${encodeURIComponent(password)}`;
        reply(
          200,
          JSON.stringify({ login: ok ? 'success' : 'Login Failed - Passwords did not match' }),
          ok ? { 'Set-Cookie': 'session=abc123; path=/' } : {}
        );
      });
      return;
    }
    if (password && req.headers.cookie !== 'session=abc123') return reply(404, '');
    if (url.pathname === '/desc.json') {
      if (!desc) return reply(404, '');
      const all = [
        ...Object.keys(params).map((id) => descriptor(id)),
        ...Object.keys(alarms).map((id) => descriptor(id, true)),
      ];
      return reply(200, JSON.stringify(all));
    }
    if (url.pathname === '/config') {
      const id = url.searchParams.get('paramid');
      if (url.searchParams.get('action') === 'set' && sets && id in sets) {
        const how = sets[id];
        if (typeof how === 'number') return reply(how, '');
        if (how === 'garbage') return reply(200, '<html>ok</html>');
        const value = url.searchParams.get('value');
        return reply(200, JSON.stringify({ paramid: '9', name: id, value, value_name: '' }));
      }
      if (url.searchParams.get('action') !== 'get') return reply(400, '');
      if (params[id]) return reply(200, JSON.stringify({ paramid: '1', name: id, ...params[id] }));
      if (alarms[id] !== undefined) {
        return reply(
          200,
          JSON.stringify({ paramid: '2', name: id, value: alarms[id], value_name: '' })
        );
      }
      return reply(200, JSON.stringify({ paramid: '0', name: '', value: '', value_name: '' }));
    }
    reply(404, '');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        received,
        logins: () => logins,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('DecodeAlarm reads AJA’s documented NORMAL and ALARM examples', () => {
  const { _internal } = load();
  const normal = _internal.DecodeAlarm('eParamID_Dropped_Frames_Alarm', ALARM_NORMAL);
  assert.equal(normal.Active, false);
  assert.equal(normal.Label, 'Dropped Frames');
  assert.deepEqual(normal.Details, []);
  const active = _internal.DecodeAlarm('eParamID_Dropped_Frames_Alarm', ALARM_ACTIVE);
  assert.equal(active.Active, true);
  assert.equal(active.Severity, 0);
  assert.deepEqual(active.Details, ['Playback continued after dropped frame']);
});

test('DecodeAlarm marks garbage as unreadable rather than throwing', () => {
  const { _internal } = load();
  assert.equal(_internal.DecodeAlarm('eParamID_X_Alarm', 'not base64!!').Undecodable, true);
  assert.equal(_internal.DecodeAlarm('eParamID_X_Alarm', '').Undecodable, true);
  assert.equal(_internal.DecodeAlarm('eParamID_X_Alarm', 'AAAA').Undecodable, true);
});

test('ParseParamReply rejects a reply for a different parameter', () => {
  const { _internal } = load();
  const body = JSON.stringify({ paramid: '1', name: 'eParamID_A', value: '1', value_name: 'x' });
  assert.ok(_internal.ParseParamReply(body, 'eParamID_A'));
  assert.equal(_internal.ParseParamReply(body, 'eParamID_B'), null);
  assert.equal(_internal.ParseParamReply('<html>', 'eParamID_A'), null);
});

test('ParseDescriptors finds the alarm parameters', () => {
  const { _internal } = load();
  const d = _internal.ParseDescriptors(
    JSON.stringify([descriptor('eParamID_SysName'), descriptor('eParamID_Temp_Alarm', true)])
  );
  assert.ok(d.Params.has('eParamID_SysName'));
  assert.deepEqual(d.Alarms, ['eParamID_Temp_Alarm']);
  assert.equal(_internal.ParseDescriptors('{}'), null);
});

test('healthy Ki Pro: reads status and alarms with GET action=get only', async () => {
  const aja = await startAja();
  try {
    const m = load();
    const r = await m.Run(target(aja.port, { CheckRecording: true, CheckMediaRemaining: true }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.SystemName, 'Ki Pro A');
    assert.equal(r.Transport, 'Recording');
    assert.equal(r.Recording, true);
    assert.equal(r.MediaRemainingPercent, 64);
    assert.equal(r.Alarms.length, 1);
    for (const line of aja.received) {
      assert.ok(
        line === 'GET /desc.json' || /^GET \/config\?action=get&paramid=eParamID_\w+$/.test(line),
        `unexpected request ${line}`
      );
    }
    // Only parameters the descriptors list are asked for.
    assert.ok(!aja.received.some((l) => l.includes('ReplicatorRecordState')));
    const html = m.Debug(r, target(aja.port));
    assert.match(html, /Ki Pro A/);
    assert.match(html, /Dropped Frames/);
  } finally {
    await aja.close();
  }
});

test('an active alarm degrades; a warning is ignored when the minimum is Error', async () => {
  const aja = await startAja({
    alarms: {
      eParamID_Dropped_Frames_Alarm: ALARM_ACTIVE,
      eParamID_Video_Input_Alarm: encodeAlarm(1, 1, ['No Input', 'SDI 1 has no signal']),
    },
  });
  try {
    const m = load();
    const r = await m.Run(target(aja.port));
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Dropped Frames \(warning\)/);
    assert.match(r.DegradedReason, /No Input \(error\): SDI 1 has no signal/);
    assert.equal(r.ActiveAlarms, 2);

    const r2 = await m.Run(target(aja.port, { AlarmMinSeverity: 'error', Timeout: 2001 }));
    assert.doesNotMatch(r2.DegradedReason, /Dropped Frames/);
    assert.match(r2.DegradedReason, /No Input/);

    const r3 = await m.Run(target(aja.port, { CheckAlarms: false, Timeout: 2002 }));
    assert.equal(r3.Degraded, undefined);
    const html = m.Debug(r, target(aja.port));
    assert.match(html, /2 active of 2/);
    assert.match(html, /SDI 1 has no signal/);
  } finally {
    await aja.close();
  }
});

test('HELO: replicator failing degrades under alarms; idle degrades only with CheckRecording', async () => {
  const aja = await startAja({
    params: {
      eParamID_ReplicatorRecordState: { value: '3', value_name: 'eRRSFailingInIdle' },
      eParamID_ReplicatorStreamState: { value: '1', value_name: 'eRRSIdle' },
      eParamID_CurrentMediaAvailable: { value: '5', value_name: '5' },
    },
    alarms: {},
  });
  try {
    const m = load();
    const r = await m.Run(target(aja.port));
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Recorder: Failing \(idle\)/);
    assert.equal(r.RecordState, 'Failing (idle)');

    const r2 = await m.Run(
      target(aja.port, {
        CheckAlarms: false,
        CheckRecording: true,
        CheckMediaRemaining: true,
        Timeout: 2001,
      })
    );
    assert.match(r2.DegradedReason, /Not recording/);
    assert.match(r2.DegradedReason, /5% media remaining \(minimum 10%\)/);
    assert.match(m.Debug(r2, target(aja.port)), /no alarm parameters/);
  } finally {
    await aja.close();
  }
});

test('Ki Pro error transport state is a fault', async () => {
  const aja = await startAja({
    params: { eParamID_TransportState: { value: '17', value_name: '' } },
    alarms: {},
  });
  try {
    const r = await load().Run(target(aja.port));
    assert.match(r.DegradedReason, /Transport: Record error/);
  } finally {
    await aja.close();
  }
});

test('without desc.json every status parameter is tried and alarms are unknown', async () => {
  const aja = await startAja({ desc: false });
  try {
    const m = load();
    const r = await m.Run(target(aja.port, { CheckRecording: true }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.HaveDescriptors, false);
    assert.ok(aja.received.some((l) => l.includes('ReplicatorRecordState')));
    assert.match(m.Debug(r, target(aja.port)), /desc\.json/);
  } finally {
    await aja.close();
  }
});

test('password: logs in, reuses the session, and reports a wrong password', async () => {
  const aja = await startAja({ password: 'honk' });
  try {
    const m = load();
    const r = await m.Run(target(aja.port, { Password: 'honk' }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(aja.logins(), 1);
    assert.ok(aja.received.includes('POST /authenticator/login'));
    await m.Run(target(aja.port, { Password: 'honk', Timeout: 2001 }));
    assert.equal(aja.logins(), 1, 'the cached session is reused');

    const bad = await m.Run(target(aja.port, { Password: 'nope' }));
    assert.equal(bad.Success, true);
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /refused the password/);
  } finally {
    await aja.close();
  }
});

test('an expired session triggers one fresh login', async () => {
  const aja = await startAja({ password: 'honk' });
  try {
    const m = load();
    m._internal.SESSION_CACHE.Clear();
    // Seed a stale cookie for this host so the first GET is refused with 404.
    const crypto = require('node:crypto');
    const key = `127.0.0.1|${aja.port}|${crypto.createHash('sha256').update('honk').digest('hex').slice(0, 16)}`;
    m._internal.SESSION_CACHE.Set(key, 'session=stale', 60000);
    const r = await m.Run(target(aja.port, { Password: 'honk' }));
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(aja.logins(), 1);
  } finally {
    await aja.close();
  }
});

test('a web server that is not AJA is reachable but degraded', async () => {
  const aja = await startAja({ garbage: true });
  try {
    const m = load();
    const r = await m.Run(target(aja.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /does not look like an AJA device/);
    assert.doesNotMatch(m.Debug(r, target(aja.port)), /Alarms/);
  } finally {
    await aja.close();
  }
});

test('nothing listening is offline', async () => {
  const aja = await startAja();
  const port = aja.port;
  await aja.close();
  const m = load();
  const r = await m.Run(target(port));
  assert.equal(r.Success, false);
  assert.match(r.Error, /ECONNREFUSED/);
  assert.match(m.Debug(r, target(port)), /Failed to reach the AJA REST API/);
});

test('the Timeout bounds the whole probe', async () => {
  const aja = await startAja({ delayMs: 150, desc: false });
  try {
    const started = Date.now();
    const r = await load().Run(target(aja.port, { Timeout: 500 }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 900, `took ${elapsed}ms`);
    assert.equal(r.Success, true);
    assert.match(String(r.DegradedReason), /Timed out reading/);
  } finally {
    await aja.close();
  }
});

test('no address / bad port are configuration errors', async () => {
  const m = load();
  assert.equal((await m.Run({ Settings: {} })).Error, 'No address configured');
  assert.match((await m.Run({ Address: 'x', Settings: { Port: 70000 } })).Error, /Invalid port/);
});

// --- Actions ---------------------------------------------------------------------

const KIPRO_WITH_TRANSPORT = {
  ...KIPRO_PARAMS,
  eParamID_TransportCommand: { value: '0', value_name: 'No Command' },
};
const HELO_PARAMS = {
  eParamID_ReplicatorRecordState: { value: '1', value_name: 'eRRSIdle' },
  eParamID_ReplicatorStreamState: { value: '1', value_name: 'eRRSIdle' },
  eParamID_ReplicatorCommand: { value: '0', value_name: 'No Command' },
};
const setsOf = (aja) => aja.received.filter((r) => /action=set/.test(r));

test('actions: IDs and Destructive flags', () => {
  const m = load();
  const byId = Object.fromEntries(m.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), [
    'record.start',
    'record.stop',
    'play',
    'stream.start',
    'stream.stop',
  ]);
  assert.ok(!byId['record.start'].Destructive);
  assert.equal(byId['record.stop'].Destructive, true);
  assert.ok(!byId.play.Destructive);
  assert.ok(!byId['stream.start'].Destructive);
  assert.equal(byId['stream.stop'].Destructive, true);
  for (const a of m.Actions) assert.ok(!a.AllowedWhileOffline && !a.Params, a.ID);
});

test('Ki Pro actions: TransportCommand 3 / 4 / 1; streaming refused before any set', async () => {
  const aja = await startAja({
    params: KIPRO_WITH_TRANSPORT,
    desc: false,
    sets: { eParamID_TransportCommand: true },
  });
  try {
    const m = load();
    const t = target(aja.port);
    assert.deepEqual(await m.RunAction(t, 'record.start'), {
      Success: true,
      Detail: 'Record started',
    });
    assert.deepEqual(await m.RunAction(t, 'record.stop'), { Success: true, Detail: 'Stop sent' });
    assert.deepEqual(await m.RunAction(t, 'play'), { Success: true, Detail: 'Play started' });
    const r = await m.RunAction(t, 'stream.start');
    assert.equal(r.Success, false);
    assert.match(r.Error, /This Ki Pro has no streaming control/);
    assert.deepEqual(setsOf(aja), [
      'GET /config?action=set&paramid=eParamID_TransportCommand&value=3',
      'GET /config?action=set&paramid=eParamID_TransportCommand&value=4',
      'GET /config?action=set&paramid=eParamID_TransportCommand&value=1',
    ]);
  } finally {
    await aja.close();
  }
});

test('HELO actions: ReplicatorCommand 1 / 2 / 3 / 4; play refused', async () => {
  const aja = await startAja({
    params: HELO_PARAMS,
    alarms: {},
    sets: { eParamID_ReplicatorCommand: true },
  });
  try {
    const m = load();
    const t = target(aja.port);
    // With desc.json cached by a probe, the family comes from the descriptors.
    await m.Run(t);
    const before = aja.received.length;
    assert.equal((await m.RunAction(t, 'record.start')).Detail, 'Record started');
    assert.equal(
      aja.received.length,
      before + 1,
      'no detection request once descriptors are known'
    );
    assert.equal((await m.RunAction(t, 'record.stop')).Detail, 'Recording stopped');
    assert.equal((await m.RunAction(t, 'stream.start')).Detail, 'Streaming started');
    assert.equal((await m.RunAction(t, 'stream.stop')).Detail, 'Streaming stopped');
    assert.match((await m.RunAction(t, 'play')).Error, /This HELO has no play control/);
    assert.deepEqual(
      setsOf(aja).map((r) => r.split('&').slice(1).join('&')),
      [
        'paramid=eParamID_ReplicatorCommand&value=1',
        'paramid=eParamID_ReplicatorCommand&value=2',
        'paramid=eParamID_ReplicatorCommand&value=3',
        'paramid=eParamID_ReplicatorCommand&value=4',
      ]
    );
  } finally {
    await aja.close();
  }
});

test('actions: a device without transport control, refusals and garbage', async () => {
  const fs = await startAja({ desc: false });
  try {
    const r = await load().RunAction(target(fs.port), 'record.start');
    assert.match(r.Error, /no transport control/);
    assert.equal(setsOf(fs).length, 0);
  } finally {
    await fs.close();
  }

  const refusing = await startAja({
    params: KIPRO_WITH_TRANSPORT,
    desc: false,
    sets: { eParamID_TransportCommand: 500 },
  });
  try {
    const r = await load().RunAction(target(refusing.port), 'record.start');
    assert.match(r.Error, /did not accept the command \(HTTP 500\)/);
  } finally {
    await refusing.close();
  }

  const junk = await startAja({
    params: KIPRO_WITH_TRANSPORT,
    desc: false,
    sets: { eParamID_TransportCommand: 'garbage' },
  });
  try {
    const r = await load().RunAction(target(junk.port), 'record.start');
    assert.match(r.Error, /not with a command confirmation/);
  } finally {
    await junk.close();
  }

  const m = load();
  assert.match((await m.RunAction(target(1), 'rewind')).Error, /Unknown AJA action/);
  assert.equal((await m.RunAction({ Settings: {} }, 'play')).Error, 'No address configured');
});

test('actions: log in with the password; a wrong one is refused; offline', async () => {
  const aja = await startAja({
    params: KIPRO_WITH_TRANSPORT,
    desc: false,
    password: 'secret',
    sets: { eParamID_TransportCommand: true },
  });
  try {
    const m = load();
    const ok = await m.RunAction(target(aja.port, { Password: 'secret' }), 'record.start');
    assert.equal(ok.Success, true, ok.Error);
    assert.equal(setsOf(aja).length, 1);
    const wrong = await m.RunAction(target(aja.port, { Password: 'nope' }), 'record.start');
    assert.equal(wrong.Error, 'The device refused the password');
    const none = await m.RunAction(target(aja.port), 'record.start');
    assert.match(none.Error, /needs a password/);
    assert.equal(setsOf(aja).length, 1);
  } finally {
    await aja.close();
  }

  const gone = await startAja();
  const port = gone.port;
  await gone.close();
  const off = await load().RunAction(target(port, { Timeout: 500 }), 'record.start');
  assert.equal(off.Success, false);
  assert.ok(off.Error);
});

test('InvalidateCaches drops the snapshot', async () => {
  const aja = await startAja();
  try {
    const m = load();
    const t = target(aja.port, { Timeout: 2001 });
    await m.Run(t);
    const n = aja.received.length;
    await m.Run(t);
    assert.equal(aja.received.length, n);
    m.InvalidateCaches(t);
    await m.Run(t);
    assert.ok(aja.received.length > n);
  } finally {
    await aja.close();
  }
});

test('the protobuf reader skips fixed-width fields instead of stopping', () => {
  const { _internal } = load();
  // A fixed32 field 9 (tag 0x4d) before the documented ALARM example's fields.
  const raw = Buffer.concat([Buffer.from([0x4d, 1, 2, 3, 4]), Buffer.from(ALARM_ACTIVE, 'base64')]);
  const a = _internal.DecodeAlarm('eParamID_Dropped_Frames_Alarm', raw.toString('base64'));
  assert.equal(a.Active, true);
  assert.equal(a.Label, 'Dropped Frames');
});
