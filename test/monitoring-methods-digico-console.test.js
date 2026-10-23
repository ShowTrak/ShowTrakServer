const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const { EncodeOscMessage, ParseOscPacket } = require(methodPath('_osc-shared.js'));

function load() {
  return loadWithMocks(methodPath('digico-console.js'), {});
}

function freeUdpPort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A fake DiGiCo console: answers "<path>/?" queries by sending "<path> value"
// to a FIXED feedback port (the DiGiCo Pad device's Send port), never to the
// port the query came from — the behaviour the method has to cope with.
//
// Options:
//   feedbackPort   where replies go (required)
//   name, session, snapshot, inputs   values, or null to stay silent
//   mutes          { channel: 0|1 } sent as floats
//   names          { channel: 'Name' }
//   dropFirst      true: ignore the first query for every address (lossy UDP)
//   silent         true: never answer
//   garbage        true: send a junk datagram before every reply
//   ignoreSets     true: accept but do not apply mute sets (no command file)
function startConsole(options) {
  const {
    feedbackPort,
    name = 'SD12',
    session = 'Main Show.ses',
    snapshot = 3,
    inputs = 48,
    mutes = {},
    names = {},
    dropFirst = false,
    silent = false,
    garbage = false,
    ignoreSets = false,
  } = options;
  const received = [];
  const seen = new Set();
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf) => {
      for (const msg of ParseOscPacket(buf)) {
        received.push(msg);
        const set = /^\/Input_Channels\/(\d+)\/mute$/.exec(msg.Address);
        if (set && !silent && !ignoreSets && typeof msg.Args[0] === 'number') {
          mutes[set[1]] = msg.Args[0] >= 0.5 ? 1 : 0;
        }
        if (silent || !msg.Address.endsWith('/?')) continue;
        const p = msg.Address.slice(0, -2);
        if (dropFirst && !seen.has(p)) {
          seen.add(p);
          continue;
        }
        let args = null;
        if (p === '/Console/Name' && name != null) args = [name];
        else if (p === '/Console/Session/Filename' && session != null) args = [session];
        else if (p === '/Snapshots/Current_Snapshot' && snapshot != null) args = [snapshot];
        else if (p === '/Console/Input_Channels' && inputs != null) args = [inputs];
        else {
          const m = /^\/Input_Channels\/(\d+)\/(mute|Channel_Input\/name)$/.exec(p);
          if (m && Number(m[1]) <= inputs) {
            args = m[2] === 'mute' ? [{ Float: mutes[m[1]] ? 1 : 0 }] : [names[m[1]] || ''];
          }
        }
        if (!args) continue;
        if (garbage) sock.send(Buffer.from('not osc at all'), feedbackPort, '127.0.0.1');
        sock.send(EncodeOscMessage(p, args), feedbackPort, '127.0.0.1');
      }
    });
    sock.bind(0, '127.0.0.1', () => {
      resolve({
        port: sock.address().port,
        received,
        close: () => new Promise((r) => sock.close(r)),
      });
    });
  });
}

async function withConsole(options, fn) {
  const listenPort = await freeUdpPort();
  const desk = await startConsole({ feedbackPort: listenPort, ...options });
  const digico = load();
  try {
    return await fn(desk, digico, listenPort);
  } finally {
    digico._internal.DigicoReceiver.Stop();
    await desk.close();
  }
}

function run(digico, desk, listenPort, settings = {}) {
  return digico.Run({
    Address: '127.0.0.1',
    Settings: { Port: desk.port, ListenPort: listenPort, Timeout: 1500, ...settings },
  });
}

test('digico: reads console name, session and snapshot using only "/?" queries', async () => {
  await withConsole({}, async (desk, digico, listenPort) => {
    const r = await run(digico, desk, listenPort);
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.ConsoleName, 'SD12');
    assert.equal(r.Session, 'Main Show.ses');
    assert.equal(r.CurrentSnapshot, 3);
    assert.equal(typeof r.LatencyMs, 'number');
    assert.ok(desk.received.length >= 3);
    for (const msg of desk.received) {
      assert.match(msg.Address, /\/\?$/);
      assert.deepEqual(msg.Args, []);
    }
  });
});

test('digico: session check matches without case or extension, and flags a different one', async () => {
  await withConsole({}, async (desk, digico, listenPort) => {
    const ok = await run(digico, desk, listenPort, {
      CheckSession: true,
      ExpectedSession: 'main show',
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await run(digico, desk, listenPort, {
      CheckSession: true,
      ExpectedSession: 'Rehearsal',
    });
    assert.equal(bad.Success, true);
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /Session "Main Show.ses" \(expected "Rehearsal"\)/);
  });
});

test('digico: session check reports a session the console did not send', async () => {
  await withConsole({ session: null }, async (desk, digico, listenPort) => {
    const r = await run(digico, desk, listenPort, {
      Timeout: 600,
      CheckSession: true,
      ExpectedSession: 'Main Show',
    });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Session not reported/);
  });
});

test('digico: channel mutes with names, and channels beyond the console', async () => {
  await withConsole(
    { inputs: 48, mutes: { 2: 1 }, names: { 1: 'Kick', 2: 'Snare' } },
    async (desk, digico, listenPort) => {
      const r = await run(digico, desk, listenPort, {
        Timeout: 800,
        CheckChannelMutes: true,
        MonitoredChannels: [1, 2, 99],
      });
      assert.equal(r.Success, true);
      assert.equal(r.Degraded, true);
      assert.match(r.DegradedReason, /Ch 2 \(Snare\): muted/);
      assert.match(r.DegradedReason, /Ch 99: not on this console/);
      assert.doesNotMatch(r.DegradedReason, /Ch 1/);
      assert.equal(r.InputCount, 48);
      const ch1 = r.Channels.find((c) => c.Channel === 1);
      assert.deepEqual(ch1, { Channel: 1, Supported: true, Name: 'Kick', Muted: false });
    }
  );
});

test('digico: lost datagrams are re-sent until answered, junk packets ignored', async () => {
  await withConsole({ dropFirst: true, garbage: true }, async (desk, digico, listenPort) => {
    const r = await run(digico, desk, listenPort, {
      Timeout: 2000,
      CheckChannelMutes: true,
      MonitoredChannels: [1],
    });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.ConsoleName, 'SD12');
    assert.equal(r.Channels[0].Muted, false);
  });
});

test('digico: a silent console is offline with the External Control hint, within budget', async () => {
  await withConsole({ silent: true }, async (desk, digico, listenPort) => {
    const started = Date.now();
    const r = await run(digico, desk, listenPort, { Timeout: 600 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /DiGiCo Pad/);
    assert.match(r.Error, new RegExp(`Send port ${listenPort}`));
    assert.ok(Date.now() - started < 1300);
  });
});

test('digico: the shared listener expires when no probe has used it within the TTL', async () => {
  await withConsole({}, async (desk, digico, listenPort) => {
    await run(digico, desk, listenPort);
    const { DigicoReceiver } = digico._internal;
    assert.deepEqual(DigicoReceiver.OpenPorts(), [listenPort]);
    DigicoReceiver.Sweep(Date.now() + 60 * 60 * 1000);
    assert.deepEqual(DigicoReceiver.OpenPorts(), []);
    // And the next probe binds it again.
    const r = await run(digico, desk, listenPort);
    assert.equal(r.Success, true);
  });
});

test('digico: a listen port held by another program is reported, not hung on', async () => {
  const listenPort = await freeUdpPort();
  const squatter = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((r) => squatter.bind(listenPort, r));
  const digico = load();
  try {
    const started = Date.now();
    const r = await digico.Run({
      Address: '127.0.0.1',
      Settings: { Port: 9, ListenPort: listenPort, Timeout: 600 },
    });
    assert.equal(r.Success, false);
    assert.ok(Date.now() - started < 1300);
    // Either the bind is refused outright, or (where the OS lets both sockets
    // bind) the squatter gets the datagrams and the console reads silent.
    assert.match(r.Error, /Cannot listen on UDP port|No reply/);
  } finally {
    digico._internal.DigicoReceiver.Stop();
    await new Promise((r) => squatter.close(r));
  }
});

test('digico: config validation and value parsing', async () => {
  const digico = load();
  assert.deepEqual(await digico.Run({ Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const { ParseMute, NormalizeSession, QueryPacket, ParseConfig } = digico._internal;
  assert.equal(ParseMute(1), true);
  assert.equal(ParseMute(0.0), false);
  assert.equal(ParseMute(true), true);
  assert.equal(ParseMute('1'), null);
  assert.equal(NormalizeSession(' Show.SES '), 'show');
  assert.deepEqual(ParseOscPacket(QueryPacket('/Console/Name')), [
    { Address: '/Console/Name/?', Args: [] },
  ]);
  const cfg = ParseConfig({ Address: 'x', Settings: {} });
  assert.equal(cfg.Port, 7001);
  assert.equal(cfg.ListenPort, 7000);
});

test('digico: Debug renders offline, online and channel cards', () => {
  const digico = load();
  const target = {
    Address: '10.0.0.9',
    Settings: { Port: 7001, ListenPort: 7000, CheckChannelMutes: true, MonitoredChannels: [1, 2] },
  };
  const offline = digico.Debug({ Success: false, Error: 'No reply from the console' }, target);
  assert.match(offline, /Offline/);
  assert.match(offline, /DiGiCo Pad/);

  const online = digico.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: 'Ch 2: muted',
      LatencyMs: 4,
      ConsoleName: '<i>SD7</i>',
      Session: 'Tour.ses',
      InputCount: 128,
      CurrentSnapshot: -1,
      Channels: [
        { Channel: 1, Supported: true, Name: 'Kick', Muted: false },
        { Channel: 2, Supported: true, Name: null, Muted: true },
      ],
    },
    target
  );
  assert.match(online, /Tour\.ses/);
  assert.match(online, /None/);
  assert.match(online, /Muted/);
  assert.doesNotMatch(online, /<i>SD7<\/i>/);
});

// --- Actions -------------------------------------------------------------------

function act(digico, desk, listenPort, id, params, settings = {}) {
  return digico.RunAction(
    {
      Address: '127.0.0.1',
      Settings: { Port: desk.port, ListenPort: listenPort, Timeout: 800, ...settings },
    },
    id,
    params
  );
}

// Every message the desk received that is not a "/?" query.
function sets(desk) {
  return desk.received.filter((m) => !m.Address.endsWith('/?'));
}

test('digico actions: declared with the right flags and first params', () => {
  const { Actions } = load();
  const byId = Object.fromEntries(Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId).sort(), ['mute.off', 'mute.on', 'snapshot.fire']);
  assert.equal(byId['snapshot.fire'].Destructive, true);
  assert.equal(byId['mute.on'].Destructive, true);
  assert.ok(!byId['mute.off'].Destructive);
  for (const a of Actions) {
    assert.ok(!a.AllowedWhileOffline);
    // No Default/Min/Max: the shared normaliser must never invent a target.
    for (const p of a.Params) {
      assert.equal(p.Default, undefined);
      assert.equal(p.Min, undefined);
      assert.equal(p.Max, undefined);
    }
  }
  assert.equal(byId['snapshot.fire'].Params[0].Key, 'Snapshot');
  assert.equal(byId['mute.on'].Params[0].Key, 'Channel');
});

test('digico actions: Fire Snapshot sends one Recall_Snapshot with no arguments', async () => {
  await withConsole({}, async (desk, digico, listenPort) => {
    const r = await act(digico, desk, listenPort, 'snapshot.fire', { Snapshot: '12' });
    assert.deepEqual(r, { Success: true, Detail: 'Snapshot 12 fired' });
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(sets(desk), [{ Address: '/Snapshots/Recall_Snapshot/12', Args: [] }]);
  });
});

test('digico actions: Mute and Unmute send a float, and read the mute back', async () => {
  await withConsole({ names: { 5: 'Vox' } }, async (desk, digico, listenPort) => {
    const on = await act(digico, desk, listenPort, 'mute.on', { Channel: 5 });
    assert.deepEqual(on, { Success: true, Detail: 'Ch 5 (Vox) muted' });
    const off = await act(digico, desk, listenPort, 'mute.off', { Channel: '5' });
    assert.deepEqual(off, { Success: true, Detail: 'Ch 5 (Vox) unmuted' });
    const s = sets(desk);
    assert.equal(s.length, 2);
    assert.equal(s[0].Address, '/Input_Channels/5/mute');
    assert.equal(s[1].Address, '/Input_Channels/5/mute');
    assert.deepEqual([s[0].Args[0], s[1].Args[0]], [1, 0]);
    // Sent as an OSC float (tag f), as the command table types it.
    const raw = digico._internal.MuteSetPacket(5, true);
    assert.ok(raw.includes(Buffer.from(',f\0\0')));
  });
});

test('digico actions: a console that ignores the mute is a specific error', async () => {
  await withConsole({ ignoreSets: true }, async (desk, digico, listenPort) => {
    const r = await act(digico, desk, listenPort, 'mute.on', { Channel: 2 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /still reports Ch 2 as unmuted/);
    assert.match(r.Error, /Commands Allowed/);
  });
});

test('digico actions: bad params and missing channels are refused before anything is sent', async () => {
  await withConsole({ inputs: 8 }, async (desk, digico, listenPort) => {
    for (const p of [
      {},
      { Snapshot: '' },
      { Snapshot: 'x' },
      { Snapshot: -1 },
      { Snapshot: 1.5 },
      { Snapshot: true },
    ]) {
      const r = await act(digico, desk, listenPort, 'snapshot.fire', p);
      assert.equal(r.Success, false, JSON.stringify(p));
      assert.match(r.Error, /Snapshot index must be/);
    }
    const c = await act(digico, desk, listenPort, 'mute.on', { Channel: 0 });
    assert.match(c.Error, /whole number/);
    const beyond = await act(digico, desk, listenPort, 'mute.on', { Channel: 20 });
    assert.equal(beyond.Success, false);
    assert.match(beyond.Error, /Ch 20 is not on this console \(it has 8 inputs\)/);
    const unknown = await act(digico, desk, listenPort, 'console.reboot', {});
    assert.match(unknown.Error, /Unknown DiGiCo action/);
    assert.deepEqual(sets(desk), []);
  });
});

test('digico actions: a silent console gets nothing and the operator is told', async () => {
  await withConsole({ silent: true }, async (desk, digico, listenPort) => {
    const r = await act(digico, desk, listenPort, 'snapshot.fire', { Snapshot: 1 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /Nothing was sent\./);
    assert.deepEqual(sets(desk), []);
  });
});

test('digico actions: DescribeAction binds the param', () => {
  const { DescribeAction } = load();
  assert.equal(DescribeAction('snapshot.fire', { Snapshot: 4 }), 'Fire Snapshot (index 4)');
  assert.equal(DescribeAction('mute.on', { Channel: '7' }), 'Mute Ch 7');
  assert.equal(DescribeAction('mute.off', { Channel: 7 }), 'Unmute Ch 7');
  assert.equal(DescribeAction('mute.on', {}), null);
});

test('digico: Run never sends anything but "/?" queries, whatever the settings', async () => {
  await withConsole({}, async (desk, digico, listenPort) => {
    for (const settings of [
      {},
      { CheckChannelMutes: true, MonitoredChannels: [1, '2', 'x', -3, 9999] },
      { CheckChannelMutes: 'true', MonitoredChannels: '4', CheckSession: 1, ExpectedSession: {} },
    ]) {
      await run(digico, desk, listenPort, settings);
    }
    assert.ok(desk.received.length > 0);
    for (const m of desk.received) {
      assert.ok(m.Address.endsWith('/?'), m.Address);
      assert.deepEqual(m.Args, []);
    }
  });
});

test('digico: replies are matched to the console by source address on a shared port', async () => {
  await withConsole({}, async (desk, digico, listenPort) => {
    const { DigicoReceiver } = digico._internal;
    const acquired = await DigicoReceiver.Acquire(listenPort);
    assert.ok(acquired.Socket);
    const here = [];
    const other = [];
    const offA = DigicoReceiver.Subscribe(listenPort, '127.0.0.1', (m) => here.push(m.Address));
    const offB = DigicoReceiver.Subscribe(listenPort, '10.255.0.9', (m) => other.push(m.Address));
    const sock = dgram.createSocket('udp4');
    await new Promise((res) =>
      sock.send(EncodeOscMessage('/Console/Name', ['X']), listenPort, '127.0.0.1', res)
    );
    await new Promise((res) => setTimeout(res, 50));
    sock.close();
    offA();
    offB();
    assert.deepEqual(here, ['/Console/Name']);
    assert.deepEqual(other, []);
  });
});

test('digico: an IPv6 address is refused with a clear message', async () => {
  const digico = load();
  const r = await digico.Run({ Address: '::1', Settings: { Timeout: 500 } });
  assert.equal(r.Success, false);
  assert.match(r.Error, /IPv4/);
  digico._internal.DigicoReceiver.Stop();
});
