const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('ptz-camera.js'), {});
}

// --- Panasonic mock -----------------------------------------------------------

const PANASONIC_HEALTHY = {
  ptz: { O: 'p1', RER: 'rER00', DA: 'dA1' },
  cam: { QID: 'OID:AW-UE150', QSV: 'OSV:2.40', QER: 'OER:0' },
};

// A fake AW camera. `answers` maps command -> body; unknown commands answer
// ER1 like the spec says. Requests are recorded with their arrival time so the
// tests can prove queries only and the 130 ms gap.
function startPanasonic(opts = {}) {
  const { answers = PANASONIC_HEALTHY, auth = null, delayMs = 0, garbage = false } = opts;
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, at: Date.now(), auth: req.headers.authorization || '' });
    const send = (status, body, headers = {}) =>
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
        res.end(body);
      }, delayMs);
    if (garbage) return send(200, '<html>NAS</html>');
    if (auth) {
      const header = req.headers.authorization || '';
      const ok =
        auth.scheme === 'basic'
          ? header === `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`
          : /^Digest /.test(header) &&
            header.includes(`username="${auth.user}"`) &&
            digestOk(header, auth);
      if (!ok) {
        return send(401, '', {
          'WWW-Authenticate':
            auth.scheme === 'basic'
              ? 'Basic realm="Control"'
              : 'Digest realm="Control", nonce="0123456789abcdef", qop="auth"',
        });
      }
    }
    const url = new URL(req.url, 'http://x');
    const cmd = url.searchParams.get('cmd') || '';
    if (url.searchParams.get('res') !== '1') return send(400, '');
    if (url.pathname === '/cgi-bin/aw_ptz' && cmd.startsWith('#')) {
      const body = answers.ptz[cmd.slice(1)];
      return send(200, body !== undefined ? body : `er1:${cmd.slice(1)}`);
    }
    if (url.pathname === '/cgi-bin/aw_cam') {
      const body = answers.cam[cmd];
      return send(200, body !== undefined ? body : `ER1:${cmd}`);
    }
    send(404, '');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((r) => server.close(r)),
      })
    )
  );
}

function digestOk(header, auth) {
  const p = {};
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]] = m[2] ?? m[3];
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${auth.user}:${p.realm}:${auth.pass}`);
  const ha2 = md5(`GET:${p.uri}`);
  return p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
}

function pana(port, settings = {}) {
  return {
    Address: '127.0.0.1',
    Settings: { Protocol: 'panasonic', Port: port, Timeout: 3000, ...settings },
  };
}

test('Panasonic healthy: power, model, firmware, tally; queries only, 130 ms apart', async () => {
  const cam = await startPanasonic();
  try {
    const m = load();
    const r = await m.Run(pana(cam.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.Power, 'on');
    assert.equal(r.Model, 'AW-UE150');
    assert.equal(r.Firmware, '2.40');
    assert.equal(r.Tally, true);
    const cmds = cam.received.map((x) => new URL(x.url, 'http://x').searchParams.get('cmd'));
    assert.deepEqual(cmds, ['#O', 'QID', 'QSV', '#RER', 'QER', '#DA']);
    for (let i = 1; i < cam.received.length; i++) {
      const gap = cam.received[i].at - cam.received[i - 1].at;
      assert.ok(gap >= 125, `gap ${gap}ms between commands`);
    }
    const html = m.Debug(r, pana(cam.port));
    assert.match(html, /AW-UE150/);
    assert.match(html, /None reported/);
  } finally {
    await cam.close();
  }
});

test('Panasonic standby and errors degrade; toggles turn them off', async () => {
  const cam = await startPanasonic({
    answers: {
      ptz: { O: 'p0', RER: 'rER03', DA: 'dA0' },
      cam: { QID: 'OID:AW-HE40', QER: 'OER:1' },
    },
  });
  try {
    const m = load();
    const r = await m.Run(pana(cam.port));
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Camera is in standby/);
    assert.match(r.DegradedReason, /Motor driver error \(03h\)/);
    assert.match(r.DegradedReason, /Fan error/);
    assert.equal(r.ErrorCode, '03');
    // QSV was refused with ER1: unknown, not a fault.
    assert.equal(r.Firmware, null);
    assert.ok(r.Refused.some((x) => /software version: ER1/.test(x)));

    const r2 = await m.Run(
      pana(cam.port, { CheckStandby: false, CheckErrors: false, Timeout: 3001 })
    );
    assert.equal(r2.Degraded, undefined);
    assert.match(m.Debug(r, pana(cam.port)), /Standby/);
  } finally {
    await cam.close();
  }
});

test('Panasonic unknown error codes are shown as hex', () => {
  const { _internal } = load();
  assert.equal(_internal.DescribePanasonicError('33'), 'Error code 33h');
  assert.equal(_internal.ParsePanasonicRer('rER00'), '00');
  assert.equal(_internal.ParsePanasonicRer('garbage'), null);
  assert.equal(_internal.ParsePanasonicPower('p3'), 'starting');
  assert.equal(_internal.ParsePanasonicPower('nope'), undefined);
  assert.equal(_internal.ParsePanasonicRefusal('er2:O'), '2');
});

test('Panasonic Digest and Basic authentication', async () => {
  for (const scheme of ['digest', 'basic']) {
    const cam = await startPanasonic({ auth: { scheme, user: 'admin', pass: '12345' } });
    try {
      const m = load();
      const r = await m.Run(pana(cam.port, { Username: 'admin', Password: '12345' }));
      assert.equal(r.Degraded, undefined, `${scheme}: ${r.DegradedReason}`);
      assert.equal(r.Model, 'AW-UE150');

      const none = await m.Run(pana(cam.port, { Timeout: 3001 }));
      assert.equal(none.Success, true);
      assert.match(none.DegradedReason, /requires a username and password/);
    } finally {
      await cam.close();
    }
  }
});

test('Panasonic: something else on port 80 is reachable but not a camera', async () => {
  const cam = await startPanasonic({ garbage: true });
  try {
    const r = await load().Run(pana(cam.port));
    assert.equal(r.Success, true);
    assert.match(r.DegradedReason, /does not look like a Panasonic camera/);
    assert.equal(cam.received.length, 1, 'stops after the failed fingerprint');
  } finally {
    await cam.close();
  }
});

test('Panasonic: offline and whole-probe timeout', async () => {
  const cam = await startPanasonic();
  const port = cam.port;
  await cam.close();
  const m = load();
  const off = await m.Run(pana(port));
  assert.equal(off.Success, false);
  assert.match(m.Debug(off, pana(port)), /Failed to reach the camera/);

  const slow = await startPanasonic({ delayMs: 120 });
  try {
    const started = Date.now();
    const r = await m.Run(pana(slow.port, { Timeout: 600 }));
    assert.ok(Date.now() - started < 1000);
    assert.equal(r.Success, true);
    assert.match(r.DegradedReason, /Timed out reading/);
  } finally {
    await slow.close();
  }
});

// --- Sony mock ------------------------------------------------------------------

const POWER_INQ = '8109040 0ff'.replace(' ', '');
const INQUIRIES = {
  '81090400ff': 'power',
  '81090002ff': 'version',
  '81090610ff': 'pantilt',
  '81097e010aff': 'tally',
};

// A fake Sony camera on a random UDP port. `answers` maps inquiry name -> the
// VISCA reply bytes (hex) or null to stay silent.
function startSony(opts = {}) {
  const {
    answers = {
      power: '905002ff',
      version: '90500001051c0210 02ff'.replace(' ', ''),
      pantilt: '90502800ff',
      tally: '905003ff',
    },
    garbage = false,
    controlReply = false,
    // VISCA command payload (hex) -> reply (hex); unlisted commands are ACKed.
    commands = {},
  } = opts;
  const received = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    received.push(msg.toString('hex'));
    const type = msg.readUInt16BE(0);
    const len = msg.readUInt16BE(2);
    const seq = msg.readUInt32BE(4);
    const payload = msg.subarray(8, 8 + len).toString('hex');
    if (garbage) return sock.send(Buffer.from('hello'), rinfo.port, rinfo.address);
    const name = INQUIRIES[payload];
    let body = name ? answers[name] : '906002ff';
    if (type === 0x0100) body = payload in commands ? commands[payload] : '9041ff';
    // Sony sends CAM_VersionInq as a device setting command (0x0120).
    const expected = type === 0x0100 ? 0x0100 : name === 'version' ? 0x0120 : 0x0110;
    let replyType = 0x0111;
    if (controlReply) {
      body = '0f01';
      replyType = 0x0201;
    }
    if (type !== expected || body === null || body === undefined) return;
    const data = Buffer.from(body, 'hex');
    const out = Buffer.alloc(8 + data.length);
    out.writeUInt16BE(replyType, 0);
    out.writeUInt16BE(data.length, 2);
    out.writeUInt32BE(seq, 4);
    data.copy(out, 8);
    sock.send(out, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) =>
    sock.bind(0, '127.0.0.1', () =>
      resolve({
        port: sock.address().port,
        received,
        close: () => new Promise((r) => sock.close(r)),
      })
    )
  );
}

function sony(port, settings = {}) {
  return {
    Address: '127.0.0.1',
    Settings: { Protocol: 'sony', ViscaPort: port, Timeout: 2000, ...settings },
  };
}

test('Sony healthy: power, model from VersionInq, inquiries only', async () => {
  const cam = await startSony();
  try {
    const m = load();
    const r = await m.Run(sony(cam.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.Power, 'on');
    assert.equal(r.Model, 'BRC-X400');
    assert.equal(r.Firmware, 'ROM 0210');
    assert.equal(r.Tally, false);
    assert.equal(r.PanTiltStatus, 0x2800);
    for (const hex of cam.received) {
      const want = INQUIRIES[hex.slice(16)] === 'version' ? '0120' : '0110';
      assert.equal(hex.slice(0, 4), want, 'inquiries only (VersionInq as a device setting)');
      assert.ok(INQUIRIES[hex.slice(16)], `unexpected payload ${hex.slice(16)}`);
    }
    assert.match(m.Debug(r, sony(cam.port)), /BRC-X400/);
  } finally {
    await cam.close();
  }
});

test('Sony standby and pan/tilt faults degrade; unsupported tally is unknown', async () => {
  const cam = await startSony({
    answers: {
      power: '905003ff',
      version: '9050000105190100 02ff'.replace(' ', ''),
      // Pan defective (bits 5..4 = 01) + initialization failed (bits 13..12 = 11).
      pantilt: '90503010ff',
      tally: '906002ff',
    },
  });
  try {
    const m = load();
    const r = await m.Run(sony(cam.port));
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Camera is in standby/);
    assert.match(r.DegradedReason, /Pan mechanism is defective/);
    assert.match(r.DegradedReason, /initialization failed/);
    assert.equal(r.Tally, null);
    assert.ok(r.Refused.some((x) => /tally: not supported/.test(x)));
    assert.match(m.Debug(r, sony(cam.port)), /Not answered by this camera/);
  } finally {
    await cam.close();
  }
});

test('Sony: a silent later inquiry does not eat the whole budget', async () => {
  const cam = await startSony({
    answers: { power: '905002ff', version: null, pantilt: '90500000ff', tally: '905002ff' },
  });
  try {
    const r = await load().Run(sony(cam.port, { Timeout: 2000 }));
    assert.equal(r.Success, true);
    assert.equal(r.Model, null);
    assert.equal(r.Tally, true);
  } finally {
    await cam.close();
  }
});

test('Sony: garbage is not a camera, silence is offline, control reply is reported', async () => {
  const m = load();
  const junk = await startSony({ garbage: true });
  try {
    const r = await m.Run(sony(junk.port, { Timeout: 600 }));
    // Garbage cannot be matched to our sequence number, so it reads as silence.
    assert.equal(r.Success, false);
  } finally {
    await junk.close();
  }

  const quiet = await startSony({ answers: { power: null } });
  try {
    const started = Date.now();
    const r = await m.Run(sony(quiet.port, { Timeout: 500 }));
    assert.ok(Date.now() - started < 900);
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply/);
    assert.match(m.Debug(r, sony(quiet.port)), /No VISCA over IP reply/);
  } finally {
    await quiet.close();
  }

  const ctl = await startSony({ controlReply: true });
  try {
    const r = await m.Run(sony(ctl.port, { Timeout: 1500 }));
    assert.equal(r.Success, true);
    assert.equal(r.Power, null);
    assert.ok(r.Refused.some((x) => /rejected by the camera/.test(x)));
  } finally {
    await ctl.close();
  }
});

test('pan/tilt status decoding and packet framing', () => {
  const { _internal } = load();
  assert.deepEqual(_internal.SonyPanTiltFaults(0x2800), []);
  assert.deepEqual(_internal.SonyPanTiltFaults(0x0100), ['Tilt mechanism is defective']);
  const pkt = _internal.BuildViscaPacket(7, [0x81, 0x09, 0x04, 0x00, 0xff]);
  assert.equal(pkt.toString('hex'), '0110000500000007' + POWER_INQ);
  assert.equal(_internal.ParseViscaPacket(Buffer.from('0111')), null);
});

test('config: protocol picks the port; bad input', async () => {
  const m = load();
  assert.equal(m._internal.ParseConfig({ Settings: { Protocol: 'sony' } }).Port, 52381);
  assert.equal(m._internal.ParseConfig({ Settings: {} }).Port, 80);
  assert.equal((await m.Run({ Settings: {} })).Error, 'No address configured');
});

// --- Actions ---------------------------------------------------------------------

const cmdsOf = (cam) => cam.received.map((x) => new URL(x.url, 'http://x').searchParams.get('cmd'));

test('actions: IDs, Destructive flags and the preset parameter', () => {
  const m = load();
  const byId = Object.fromEntries(m.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['power.on', 'power.standby', 'preset.recall']);
  assert.ok(!byId['power.on'].Destructive);
  assert.equal(byId['power.standby'].Destructive, true);
  assert.equal(byId['preset.recall'].Destructive, true);
  for (const a of m.Actions) assert.ok(!a.AllowedWhileOffline, a.ID);
  const [param] = byId['preset.recall'].Params;
  assert.equal(param.Key, 'Preset');
  // No Default/Min/Max: normalization would turn a blank or 150 into a real
  // preset. RunAction refuses anything outside 1-100 instead.
  assert.equal(param.Default, undefined);
  assert.equal(param.Min, undefined);
  assert.equal(param.Max, undefined);
  assert.equal(m.DescribeAction('preset.recall', { Preset: 7 }), 'Recall Preset 7');
  assert.equal(m.DescribeAction('preset.recall', { Preset: 0 }), null);
  assert.equal(m.DescribeAction('power.on', {}), null);
});

test('Panasonic actions: #O1 / #O0 / #R<nn> with the camera answers checked', async () => {
  const cam = await startPanasonic({
    answers: { ptz: { O1: 'p1', O0: 'p0', R00: 's00', R99: 's99', R41: 's41' }, cam: {} },
  });
  try {
    const m = load();
    const t = pana(cam.port);
    assert.deepEqual(await m.RunAction(t, 'power.on', {}), {
      Success: true,
      Detail: 'Camera powered on',
    });
    assert.deepEqual(await m.RunAction(t, 'power.standby', {}), {
      Success: true,
      Detail: 'Camera put into standby',
    });
    assert.deepEqual(await m.RunAction(t, 'preset.recall', { Preset: 1 }), {
      Success: true,
      Detail: 'Preset 1 recalled',
    });
    assert.equal((await m.RunAction(t, 'preset.recall', { Preset: '100' })).Success, true);
    assert.equal(
      (await m.RunAction(t, 'preset.recall', { Preset: 42 })).Detail,
      'Preset 42 recalled'
    );
    assert.deepEqual(cmdsOf(cam), ['#O1', '#O0', '#R00', '#R99', '#R41']);
    for (const r of cam.received)
      assert.match(r.url, /^\/cgi-bin\/aw_ptz\?cmd=%23[A-Z0-9]+&res=1$/);
  } finally {
    await cam.close();
  }
});

test('Panasonic actions: bad preset, refusals, wrong answer, auth and offline', async () => {
  const cam = await startPanasonic({
    answers: { ptz: { O1: 'eR2:O1', R05: 'ER3:R05', O0: 'p1' }, cam: {} },
  });
  try {
    const m = load();
    const t = pana(cam.port);
    for (const bad of [0, 101, 2.5, 'x', '', undefined]) {
      const r = await m.RunAction(t, 'preset.recall', { Preset: bad });
      assert.equal(r.Success, false);
      assert.match(r.Error, /whole number from 1 to 100/);
    }
    assert.equal(cam.received.length, 0, 'nothing sent for a bad preset');
    assert.match((await m.RunAction(t, 'power.on', {})).Error, /busy or in standby/);
    assert.match((await m.RunAction(t, 'preset.recall', { Preset: 6 })).Error, /out of range/);
    // An unknown command answers ER1 in the mock.
    assert.match((await m.RunAction(t, 'preset.recall', { Preset: 9 })).Error, /does not support/);
    assert.match((await m.RunAction(t, 'power.standby', {})).Error, /Unexpected answer.*p1/);
    assert.match((await m.RunAction(t, 'zoom.in', {})).Error, /Unknown PTZ camera action/);
  } finally {
    await cam.close();
  }

  const locked = await startPanasonic({
    auth: { scheme: 'digest', user: 'admin', pass: '12345' },
    answers: { ptz: { O1: 'p1' }, cam: {} },
  });
  try {
    const m = load();
    const ok = await m.RunAction(
      pana(locked.port, { Username: 'admin', Password: '12345' }),
      'power.on',
      {}
    );
    assert.equal(ok.Success, true);
    const no = await m.RunAction(pana(locked.port), 'power.on', {});
    assert.match(no.Error, /requires a username and password/);
  } finally {
    await locked.close();
  }

  const gone = await startPanasonic();
  const port = gone.port;
  await gone.close();
  const off = await load().RunAction(pana(port, { Timeout: 500 }), 'power.on', {});
  assert.equal(off.Success, false);
  assert.ok(off.Error);
});

test('Sony actions: VISCA command frames (0x0100) for power and preset recall', async () => {
  const cam = await startSony({ commands: { '8101043f0263ff': '9051ff' } });
  try {
    const m = load();
    const t = sony(cam.port);
    assert.deepEqual(await m.RunAction(t, 'power.on', {}), {
      Success: true,
      Detail: 'Camera powered on',
    });
    assert.equal((await m.RunAction(t, 'power.standby', {})).Success, true);
    assert.equal((await m.RunAction(t, 'preset.recall', { Preset: 1 })).Success, true);
    // A Completion (90 5z FF) settles it as well as an ACK.
    assert.equal(
      (await m.RunAction(t, 'preset.recall', { Preset: 100 })).Detail,
      'Preset 100 recalled'
    );
    assert.deepEqual(
      cam.received.map((hex) => [hex.slice(0, 4), hex.slice(16)]),
      [
        ['0100', '8101040002ff'],
        ['0100', '8101040003ff'],
        ['0100', '8101043f0200ff'],
        ['0100', '8101043f0263ff'],
      ]
    );
  } finally {
    await cam.close();
  }
});

test('Sony actions: error replies, control reply and silence', async () => {
  const cam = await startSony({
    commands: {
      '8101043f0210ff': '906002ff',
      '8101043f0201ff': '906141ff',
      '8101040002ff': '906003ff',
    },
  });
  try {
    const m = load();
    const t = sony(cam.port);
    assert.match((await m.RunAction(t, 'preset.recall', { Preset: 17 })).Error, /does not support/);
    assert.match(
      (await m.RunAction(t, 'preset.recall', { Preset: 2 })).Error,
      /cannot do that right now/
    );
    assert.match((await m.RunAction(t, 'power.on', {})).Error, /busy with two other commands/);
    assert.match((await m.RunAction(t, 'preset.recall', { Preset: 300 })).Error, /1 to 100/);
  } finally {
    await cam.close();
  }

  const ctl = await startSony({ controlReply: true });
  try {
    const r = await load().RunAction(sony(ctl.port), 'power.on', {});
    assert.match(r.Error, /rejected the message \(control reply 0f01\)/);
  } finally {
    await ctl.close();
  }

  const quiet = await startSony({ commands: { '8101040002ff': null } });
  try {
    const started = Date.now();
    const r = await load().RunAction(sony(quiet.port, { Timeout: 500 }), 'power.on', {});
    assert.ok(Date.now() - started < 900);
    assert.match(r.Error, /No reply/);
  } finally {
    await quiet.close();
  }
});

test('InvalidateCaches drops the snapshot so the next probe reads the camera again', async () => {
  const cam = await startPanasonic();
  try {
    const m = load();
    const t = pana(cam.port, { Timeout: 3002 });
    await m.Run(t);
    const first = cam.received.length;
    await m.Run(t);
    assert.equal(cam.received.length, first, 'second run served from the snapshot');
    m.InvalidateCaches(t);
    await m.Run(t);
    assert.ok(cam.received.length > first);
  } finally {
    await cam.close();
  }
});
