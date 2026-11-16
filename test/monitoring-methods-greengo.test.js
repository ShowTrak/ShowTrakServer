const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const dir = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods');
const M = loadWithMocks(path.join(dir, 'greengo.js'), {});
const { EncodeOscMessage, ParseOscPacket } = require(path.join(dir, '_osc-shared.js'));

test.after(() => M._internal.Receiver.Stop());

function freePort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// The state dump the published osc-remote.gg5t sends for /ggo/cmd/update.
function stateDump({ members = [1, 0, 3, 1, 1, 1] } = {}) {
  const out = [];
  for (let ch = 1; ch <= 6; ch++) {
    out.push(['/ggo/state/channel/talk', [ch === 1 ? 1 : 0, ch]]);
    out.push(['/ggo/state/channel/call', [0, ch]]);
    out.push(['/ggo/state/channel/cue', [0, ch]]);
    out.push(['/ggo/state/channel/listen', [1, ch]]);
    out.push(['/ggo/state/channel/level', [-6, ch]]);
    out.push(['/ggo/state/channel/input', [members[ch - 1], ch]]);
    out.push(['/ggo/state/channel/input/call', [0, ch]]);
  }
  out.push(['/ggo/state/level/main', [0]]);
  out.push(['/ggo/state/level/pgm', [-12]]);
  out.push(['/ggo/state/level/direct', [0]]);
  out.push(['/ggo/state/audio/gain', [3]]);
  out.push(['/ggo/state/audio/source', [1]]);
  out.push(['/ggo/state/mode/isolate', [0]]);
  out.push(['/ggo/state/updated', [1]]);
  return out;
}

// A fake Green-GO device running the script: answers /ggo/cmd/update with the
// state dump, sent to remoteIP:controlPort (the ShowTrak listen port).
function startDevice({ listenPort, reply = stateDump(), silent = false, junk = false } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const received = [];
    sock.on('message', (msg) => {
      const parsed = ParseOscPacket(msg);
      received.push(...parsed);
      if (silent) return;
      if (!parsed.some((m) => m.Address === '/ggo/cmd/update')) return;
      if (junk) {
        sock.send(Buffer.from('not osc at all'), listenPort, '127.0.0.1');
        sock.send(EncodeOscMessage('/other/thing', [1]), listenPort, '127.0.0.1');
        sock.send(EncodeOscMessage('/ggo/state/channel/talk', ['x', 1]), listenPort, '127.0.0.1');
        return;
      }
      for (const [addr, args] of reply)
        sock.send(EncodeOscMessage(addr, args), listenPort, '127.0.0.1');
    });
    sock.bind(0, '127.0.0.1', () => resolve({ sock, port: sock.address().port, received }));
  });
}

function target(listenPort, devicePort, settings = {}) {
  return {
    Address: '127.0.0.1',
    Settings: { Port: listenPort, DevicePort: devicePort, Timeout: 800, ...settings },
  };
}

test('greengo: answers the state request, online with channel states', async () => {
  const listen = await freePort();
  const dev = await startDevice({ listenPort: listen });
  try {
    const R = await M.Run(target(listen, dev.port));
    assert.equal(R.Success, true, R.Error);
    assert.equal(R.StateRefreshed, true);
    assert.equal(typeof R.LatencyMs, 'number');
    assert.equal(R.Degraded, undefined);
    assert.equal(R.Channels[1].talk, 1);
    assert.equal(R.Channels[3].input, 3);
    assert.equal(R.Device['level/pgm'], -12);
    // The only thing sent is the documented read request.
    assert.deepEqual(
      dev.received.map((m) => [m.Address, m.Args]),
      [['/ggo/cmd/update', [1]]]
    );
  } finally {
    dev.sock.close();
  }
});

test('greengo: channel that needs members but has none is degraded', async () => {
  const listen = await freePort();
  const dev = await startDevice({ listenPort: listen });
  try {
    const R = await M.Run(target(listen, dev.port, { RequireMembers: ['1', '2', 9] }));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, true);
    // Channel 9 was never reported, so it is not judged.
    assert.equal(R.DegradedReason, 'Ch 2: no members');
  } finally {
    dev.sock.close();
  }
});

test('greengo: silent device with a fresh heartbeat is online but not refreshed', async () => {
  const listen = await freePort();
  const dev = await startDevice({ listenPort: listen, silent: true });
  try {
    // Prime the listener, then deliver a heartbeat as the script's timer would.
    await M.Run(target(listen, dev.port, { Timeout: 200 }));
    await new Promise((r) =>
      dev.sock.send(EncodeOscMessage('/ggo/state/heartbeat', [1]), listen, '127.0.0.1', r)
    );
    await new Promise((r) => setTimeout(r, 50));
    const R = await M.Run(target(listen, dev.port, { Timeout: 200 }));
    assert.equal(R.Success, true);
    assert.equal(R.StateRefreshed, false);
    assert.equal(R.LatencyMs, null);
    assert.ok(R.HeartbeatAgeMs >= 0);
  } finally {
    dev.sock.close();
  }
});

test('greengo: no device is offline within the timeout', async () => {
  const listen = await freePort();
  const devicePort = await freePort();
  const Started = Date.now();
  // 500 ms is the smallest timeout the setting allows.
  const R = await M.Run(target(listen, devicePort, { Timeout: 100 }));
  assert.equal(R.Success, false);
  assert.match(R.Error, /No reply from 127\.0\.0\.1 within 500ms/);
  assert.ok(Date.now() - Started < 1500);
});

test('greengo: malformed and foreign OSC never counts as alive', async () => {
  const listen = await freePort();
  const dev = await startDevice({ listenPort: listen, junk: true });
  try {
    const R = await M.Run(target(listen, dev.port, { Timeout: 300 }));
    assert.equal(R.Success, false);
  } finally {
    dev.sock.close();
  }
});

test('greengo: ApplyMessage parses only well-formed Green-GO state', () => {
  const { ApplyMessage, NewSource } = M._internal;
  const S = NewSource('10.0.0.9', 0);
  assert.equal(ApplyMessage(S, { Address: '/ggo/state/channel/input', Args: [1, 2] }, 5), true);
  assert.equal(S.Channels[2].input, 1);
  assert.equal(ApplyMessage(S, { Address: '/ggo/state/channel/input', Args: [1, 99] }, 5), false);
  assert.equal(ApplyMessage(S, { Address: '/ggo/state/channel/bogus', Args: [1, 1] }, 5), false);
  assert.equal(ApplyMessage(S, { Address: '/ggo/state/channel/talk', Args: [1] }, 5), false);
  assert.equal(ApplyMessage(S, { Address: '/ggo/state/mode/isolate', Args: [true] }, 5), true);
  assert.equal(S.Device['mode/isolate'], 1);
  assert.equal(ApplyMessage(S, { Address: '/ggo/cmd/update', Args: [1] }, 5), false);
  assert.equal(ApplyMessage(S, { Address: '/ggo/state/heartbeat', Args: [1] }, 7), true);
  assert.equal(S.LastHeartbeatAt, 7);
});

test('greengo: listener is reaped after the interest TTL', async () => {
  const listen = await freePort();
  const devicePort = await freePort();
  await M.Run(target(listen, devicePort, { Timeout: 100 }));
  const Before = M._internal.Receiver.PortCount();
  assert.ok(Before >= 1);
  M._internal.Receiver.Sweep(Date.now() + 24 * 60 * 60 * 1000);
  assert.equal(M._internal.Receiver.PortCount(), 0);
});

test('greengo: config parsing', () => {
  const C = M._internal.ParseConfig({
    Address: ' 10.0.0.2 ',
    Settings: { RequireMembers: '3, 1, x, 40, 1', GracePeriodMs: 10, DevicePort: 70000 },
  });
  assert.equal(C.Address, '10.0.0.2');
  assert.equal(C.Port, 8000);
  assert.equal(C.DevicePort, 0);
  assert.deepEqual(C.RequireMembers, [1, 3]);
  assert.equal(C.GraceMs, 3000);
});

test('greengo: debug escapes and explains', () => {
  const evil = '<b onmouseover=alert(1)>';
  const T = { Address: evil, Settings: { Port: 8000, RequireMembers: [2] } };
  const Off = M.Debug({ Success: false, Error: evil }, T);
  assert.ok(!Off.includes('<b '));
  assert.match(Off, /OSC remote script/);
  const On = M.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: evil,
      StateRefreshed: true,
      HeartbeatAgeMs: 1500,
      LatencyMs: 4,
      Device: { 'mode/isolate': 1, 'level/main': 0 },
      Channels: { 1: { input: 3, talk: 1, listen: 1 }, 2: { input: 0 } },
    },
    T
  );
  assert.ok(!On.includes('<b '));
  assert.match(On, /VOX active/);
  assert.match(On, /No members/);
  assert.match(On, /talking/);
  assert.match(M.Debug({ Success: true, Channels: {} }, T), /No channel state reported yet/);
});
