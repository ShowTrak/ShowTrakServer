const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loggerStub() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    child: () => logger,
  };
  return { CreateLogger: () => logger };
}

// Load the method and its shared module once, so both see one session manager.
const atem = loadWithMocks(methodPath('atem.js'), { '../Logger': loggerStub() });
const shared = require(methodPath('_atem-shared.js'));
const Manager = shared._internal.AtemSessionManager;

function reset(timings = null) {
  Manager.Stop();
  shared._internal.ConfigureTimings(timings);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 3000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

// --- Wire helpers --------------------------------------------------------------

function header(flags, length, session, ackId, remoteId) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE((flags << 11) | length, 0);
  b.writeUInt16BE(session, 2);
  b.writeUInt16BE(ackId, 4);
  b.writeUInt16BE(remoteId, 10);
  return b;
}

function cmd(name, body) {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(8 + body.length, 0);
  h.write(name, 4, 'latin1');
  return Buffer.concat([h, body]);
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}

function str(s, len) {
  const b = Buffer.alloc(len);
  b.write(s, 0, 'utf8');
  return b;
}

function verBody(major, minor) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(((major << 16) | minor) >>> 0, 0);
  return b;
}

function pinBody(name, model) {
  const b = Buffer.alloc(44);
  b.write(name, 0, 'utf8');
  b.writeUInt8(model, 40);
  return b;
}

function meBody(me, source, len = 4) {
  const b = Buffer.alloc(len);
  b.writeUInt8(me, 0);
  b.writeUInt8(0x65, 1); // junk, as real switchers send
  b.writeUInt16BE(source, 2);
  return b;
}

function inPrBody(id, long, short) {
  const b = Buffer.alloc(36);
  b.writeUInt16BE(id, 0);
  b.write(long, 2, 'utf8');
  b.write(short, 22, 'utf8');
  return b;
}

function statusBody(raw, extra = 2) {
  return Buffer.concat([u16(raw), Buffer.alloc(extra)]);
}

function buildDump(o) {
  const cmds = [
    cmd('_ver', verBody(2, 30)),
    cmd('_pin', pinBody(o.product, o.model)),
    cmd('_top', Buffer.alloc(20)), // unknown to the parser: skipped
    cmd('Powr', Buffer.from([o.power, 0xcb, 0x20, 0xa0])),
    ...o.inputs.map(([id, long, short]) => cmd('InPr', inPrBody(id, long, short))),
    cmd('PrgI', meBody(0, o.program)),
    cmd('PrvI', meBody(0, o.preview, 8)),
    cmd('PrgI', meBody(1, 9999)), // ME 2: must not overwrite ME 1
  ];
  if (o.streaming != null) cmds.push(cmd('StRS', statusBody(o.streaming)));
  if (o.recording != null) cmds.push(cmd('RTMS', statusBody(o.recording, 6)));
  cmds.push(cmd('InCm', Buffer.from([1, 0, 0, 0])));
  // Split across several reliable packets.
  const per = Math.ceil(cmds.length / o.packets);
  const out = [];
  for (let i = 0; i < cmds.length; i += per) out.push(Buffer.concat(cmds.slice(i, i + per)));
  return out;
}

// A fake ATEM: answers the hello, dumps its state over several reliable packets
// (resending any not yet acked), then keeps sending empty reliable keepalives.
function startFakeAtem(opts = {}) {
  const o = {
    mode: 'atem', // 'atem' | 'silent' | 'echo' | 'junk'
    helloStatus: 0x02,
    product: 'ATEM 2 M/E Production Studio 4K',
    model: 0x06,
    power: 0x03,
    program: 1,
    preview: 2,
    inputs: [
      [1, 'Camera 1', 'CAM1'],
      [2, 'Camera 2', 'CAM2'],
    ],
    streaming: null,
    recording: null,
    packets: 3,
    pingMs: 100,
    dropOnce: [],
    junkAfterHandshake: false,
    ...opts,
  };
  const sock = dgram.createSocket('udp4');
  const stats = { hellos: 0, acks: [], ackSessions: new Set(), dumps: 0 };
  let peer = null;
  let session = 0;
  let sessionCounter = 0;
  let nextId = 1;
  let unacked = new Map();
  let awaitingHandshakeAck = false;
  let pingTimer = null;
  const dropped = new Set();

  const send = (buf) => {
    if (peer) sock.send(buf, peer.port, peer.address);
  };

  function sendReliable(payload) {
    const id = nextId++;
    const buf = Buffer.concat([header(0x01, 12 + payload.length, session, 0, id), payload]);
    unacked.set(id, buf);
    if (o.dropOnce.includes(id) && !dropped.has(id)) {
      dropped.add(id);
      return;
    }
    send(buf);
  }

  const retransmit = setInterval(() => {
    if (o.mode !== 'atem') return;
    for (const buf of unacked.values()) {
      const copy = Buffer.from(buf);
      copy.writeUInt16BE(copy.readUInt16BE(0) | (0x04 << 11), 0);
      send(copy);
    }
  }, 30);

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function startSession() {
    session = 0x8000 | ++sessionCounter;
    nextId = 1;
    unacked = new Map();
    stats.dumps += 1;
    for (const p of buildDump(o)) sendReliable(p);
    if (o.junkAfterHandshake) {
      send(Buffer.from([0x01, 0x02, 0x03])); // shorter than a header
      send(Buffer.concat([header(0x01, 40, session, 0, 99), Buffer.alloc(4)])); // length lies
    }
    stopPing();
    pingTimer = setInterval(() => {
      if (o.mode === 'atem') sendReliable(Buffer.alloc(0));
    }, o.pingMs);
  }

  function sendHelloAnswer(clientSession, status) {
    const payload = Buffer.alloc(8);
    payload.writeUInt8(status, 0);
    send(Buffer.concat([header(0x02, 20, clientSession, 0, 0), payload]));
    awaitingHandshakeAck = status !== 0x03;
  }

  sock.on('message', (msg, rinfo) => {
    if (o.mode === 'silent') return;
    if (o.mode === 'echo') return sock.send(msg, rinfo.port, rinfo.address);
    if (o.mode === 'junk')
      return sock.send(Buffer.from('Who goes there?'), rinfo.port, rinfo.address);
    if (msg.length < 12) return;
    const flags = msg.readUInt8(0) >> 3;
    if (flags & 0x02) {
      stats.hellos += 1;
      peer = { port: rinfo.port, address: rinfo.address };
      stopPing();
      unacked = new Map();
      sendHelloAnswer(msg.readUInt16BE(2), o.helloStatus);
      return;
    }
    if (flags & 0x10) {
      const ack = msg.readUInt16BE(4);
      stats.acks.push(ack);
      if (awaitingHandshakeAck && ack === 0) {
        awaitingHandshakeAck = false;
        startSession();
        return;
      }
      stats.ackSessions.add(msg.readUInt16BE(2));
      for (const id of [...unacked.keys()]) if (id <= ack) unacked.delete(id);
    }
  });

  return new Promise((resolve) => {
    sock.bind(0, '127.0.0.1', () => {
      resolve({
        port: sock.address().port,
        stats,
        opts: o,
        unackedCount: () => unacked.size,
        currentSession: () => session,
        // Stop answering and sending entirely (switcher unplugged / rebooting).
        silence() {
          o.mode = 'silent';
          stopPing();
        },
        // Come back as a fresh switcher, optionally with different state.
        reboot(next = {}) {
          Object.assign(o, next, { mode: 'atem' });
          peer = null;
          unacked = new Map();
        },
        // A supply changes state mid-session.
        sendPower(bits) {
          o.power = bits;
          sendReliable(cmd('Powr', Buffer.from([bits, 0, 0, 0])));
        },
        // Switcher-initiated new session in the middle of an established one.
        newSessionMidway(next = {}) {
          Object.assign(o, next);
          stopPing();
          unacked = new Map();
          const payload = Buffer.alloc(8);
          payload.writeUInt8(0x02, 0);
          send(Buffer.concat([header(0x02, 20, 0x1234, 0, 0), payload]));
          awaitingHandshakeAck = true;
        },
        close: () =>
          new Promise((r) => {
            stopPing();
            clearInterval(retransmit);
            sock.close(r);
          }),
      });
    });
  });
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

// --- Pure: packet codec ------------------------------------------------------

test('ParsePacket decodes the header and rejects short or length-mismatched datagrams', () => {
  const p = shared.ParsePacket(
    Buffer.concat([header(0x01 | 0x04, 16, 0x8001, 7, 42), Buffer.from([1, 2, 3, 4])])
  );
  assert.equal(p.Flags, 0x05);
  assert.equal(p.Length, 16);
  assert.equal(p.SessionId, 0x8001);
  assert.equal(p.AckId, 7);
  assert.equal(p.RemotePacketId, 42);
  assert.deepEqual([...p.Payload], [1, 2, 3, 4]);
  assert.equal(shared.ParsePacket(Buffer.alloc(11)), null);
  assert.equal(
    shared.ParsePacket(Buffer.concat([header(0x01, 20, 1, 0, 1), Buffer.alloc(2)])),
    null
  );
  assert.equal(shared.ParsePacket('nope'), null);
});

test('BuildHello matches atem-connection’s hello apart from the client session id', () => {
  const hello = shared.BuildHello(0x53ab);
  assert.equal(
    hello.toString('hex'),
    '101453ab00000000003a00000100000000000000' // atem-connection COMMAND_CONNECT_HELLO
  );
  const other = shared.BuildHello(0x1234);
  assert.equal(other.readUInt16BE(2), 0x1234);
  assert.equal(shared.ParsePacket(other).Flags, shared.PacketFlag.NewSessionId);
});

test('BuildAck matches the ack atem-connection sends for the hello answer', () => {
  // From atem-connection's socket-child.spec: session 0x531b, ack id 0.
  assert.equal(shared.BuildAck(0x531b, 0).toString('hex'), '800c531b0000000000000000');
  const ack = shared.ParsePacket(shared.BuildAck(0x8003, 517));
  assert.equal(ack.Flags, shared.PacketFlag.AckReply);
  assert.equal(ack.AckId, 517);
});

test('SplitCommands walks concatenated commands and stops at a bad or truncated one', () => {
  const payload = Buffer.concat([
    cmd('_ver', verBody(2, 30)),
    cmd('InCm', Buffer.from([1, 0, 0, 0])),
  ]);
  assert.deepEqual(
    shared.SplitCommands(payload).map((c) => c.Name),
    ['_ver', 'InCm']
  );
  // Length runs past the end: the truncated command is dropped.
  const truncated = Buffer.concat([
    cmd('_ver', verBody(2, 30)),
    cmd('Powr', Buffer.alloc(4)).subarray(0, 9),
  ]);
  assert.deepEqual(
    shared.SplitCommands(truncated).map((c) => c.Name),
    ['_ver']
  );
  // Length below the 8-byte header ends parsing.
  const bad = Buffer.from('0004000041424344', 'hex');
  assert.deepEqual(shared.SplitCommands(bad), []);
  assert.deepEqual(shared.SplitCommands(Buffer.alloc(5)), []);
});

// --- Pure: command parsers (bodies taken from real switcher dumps) -----------

test('_ver parses major.minor', () => {
  assert.deepEqual(shared.ParseVersion(Buffer.from('0002001e', 'hex')), { Major: 2, Minor: 30 });
  assert.equal(shared.ParseVersion(Buffer.alloc(3)), null);
});

test('_pin parses the product name and model byte', () => {
  // ATEM 2 M/E Production Studio 4K, from atem-connection's 2me4k-v8.4 dump.
  const body = Buffer.from(
    '4154454d2032204d2f452050726f64756374696f6e2053747564696f20344b00000000000000000006000000',
    'hex'
  );
  assert.deepEqual(shared.ParseProductIdentifier(body), {
    Name: 'ATEM 2 M/E Production Studio 4K',
    Model: 6,
  });
  assert.deepEqual(shared.ParseProductIdentifier(str('ATEM Mini', 12)), {
    Name: 'ATEM Mini',
    Model: null,
  });
  assert.equal(shared.ParseProductIdentifier(Buffer.alloc(0)), null);
});

test('Powr parses the two supply bits and ignores the padding', () => {
  assert.deepEqual(shared.ParsePower(Buffer.from('02000000', 'hex')), [false, true]);
  assert.deepEqual(shared.ParsePower(Buffer.from('03d1f4d0', 'hex')), [true, true]);
  assert.deepEqual(shared.ParsePower(Buffer.from('01cb20a0', 'hex')), [true, false]);
  assert.equal(shared.ParsePower(Buffer.alloc(0)), null);
});

test('PrgI / PrvI parse the ME index and source id', () => {
  assert.deepEqual(shared.ParseMeSource(Buffer.from('00652724', 'hex')), {
    MixEffect: 0,
    Source: 10020,
  });
  assert.deepEqual(shared.ParseMeSource(Buffer.from('0057177000310160', 'hex')), {
    MixEffect: 0,
    Source: 6000,
  });
  assert.equal(shared.ParseMeSource(Buffer.alloc(3)), null);
});

test('InPr parses the id and NUL-terminated names past junk padding', () => {
  // From the Television Studio 4K8 dump: junk follows the long name's NUL.
  const body = Buffer.from(
    '000143616d657261203100005f4d654300040000000c43414d31016c0001000100141f01',
    'hex'
  );
  assert.deepEqual(shared.ParseInputProperties(body), {
    Id: 1,
    LongName: 'Camera 1',
    ShortName: 'CAM1',
  });
  assert.equal(shared.ParseInputProperties(Buffer.alloc(25)), null);
});

test('StRS decodes like atem-connection', () => {
  const p = (hex) => {
    const r = shared.ParseStreamingStatus(Buffer.from(hex, 'hex'));
    return r && `${r.State}/${r.Error}`;
  };
  assert.equal(p('00010280'), 'Idle/None'); // real Mini Extreme ISO dump
  assert.equal(p('0002'), 'Connecting/None');
  assert.equal(p('0004'), 'Streaming/None');
  assert.equal(p('0024'), 'Stopping/None');
  assert.equal(p('0014'), 'Streaming/InvalidState');
  assert.equal(p('8001'), 'Idle/Unknown');
  assert.equal(p('00'), null);
});

test('RTMS decodes like atem-connection', () => {
  const p = (hex) => {
    const r = shared.ParseRecordingStatus(Buffer.from(hex, 'hex'));
    return r && `${r.State}/${r.Error}`;
  };
  assert.equal(p('0002008000008aeb'), 'Idle/None'); // real: disk present
  assert.equal(p('00000800ffffffff'), 'Idle/NoMedia'); // real: no disk
  assert.equal(p('00000000'), 'Idle/NoMedia'); // real Mini Pro: 4-byte body
  assert.equal(p('0003'), 'Recording/None');
  assert.equal(p('0023'), 'Recording/DroppingFrames');
  assert.equal(p('0007'), 'Recording/MediaFull');
  assert.equal(p('0082'), 'Stopping/None');
  assert.equal(p('00'), null);
});

test('InCm marks the dump complete; ApplyCommand ignores ME 2 and short bodies', () => {
  const st = shared.EmptyState();
  shared.ApplyCommand(st, { Name: 'PrgI', Body: meBody(0, 3) });
  shared.ApplyCommand(st, { Name: 'PrgI', Body: meBody(1, 4) });
  shared.ApplyCommand(st, { Name: 'Powr', Body: Buffer.alloc(0) });
  shared.ApplyCommand(st, { Name: 'Zzzz', Body: Buffer.alloc(4) });
  assert.equal(st.Program, 3);
  assert.equal(st.PowerBits, null);
  assert.equal(st.DumpComplete, false);
  shared.ApplyCommand(st, { Name: 'InCm', Body: Buffer.alloc(4) });
  assert.equal(st.DumpComplete, true);
});

test('PsuCountFor uses atem-connection’s dual-supply list plus what the switcher has shown', () => {
  assert.equal(shared.PsuCountFor(0x06, false), 2); // 2 M/E 4K
  assert.equal(shared.PsuCountFor(0x0b, false), 2); // Constellation
  assert.equal(shared.PsuCountFor(0x0d, false), 1); // Mini
  assert.equal(shared.PsuCountFor(0x1a, true), 2); // TVS HD8 that has reported supply 2
  assert.equal(shared.PsuCountFor(null, false), 1);
});

// --- Pure: evaluation ----------------------------------------------------------

const psu = (Index, Ok, SeenOk = Ok) => ({ Index, Ok, SeenOk });

function snap(over = {}) {
  return {
    PowerSupplies: [psu(1, true), psu(2, true)],
    Streaming: null,
    Recording: null,
    ...over,
  };
}

const ON = { CheckPower: true, CheckStreaming: false, CheckRecording: false };

test('Evaluate: power fails only for a supply that was seen OK and is now down', () => {
  const E = atem._internal.Evaluate;
  assert.deepEqual(E(snap(), ON), []);
  assert.deepEqual(E(snap({ PowerSupplies: [psu(1, true), psu(2, false, true)] }), ON), [
    'Power supply 2 failed',
  ]);
  // Never seen OK: not connected, not failed.
  assert.deepEqual(E(snap({ PowerSupplies: [psu(1, true), psu(2, false, false)] }), ON), []);
  assert.deepEqual(E(snap({ PowerSupplies: [psu(1, false, true)] }), ON), []); // single supply
  assert.deepEqual(E(snap({ PowerSupplies: null }), ON), []);
  assert.deepEqual(
    E(snap({ PowerSupplies: [psu(1, false, true), psu(2, true)] }), { ...ON, CheckPower: false }),
    []
  );
});

test('Evaluate: streaming must be live when enabled', () => {
  const E = atem._internal.Evaluate;
  const O = { ...ON, CheckStreaming: true };
  assert.deepEqual(E(snap({ Streaming: { State: 'Streaming', Error: 'None' } }), O), []);
  assert.deepEqual(E(snap({ Streaming: { State: 'Idle', Error: 'None' } }), O), ['Not streaming']);
  assert.deepEqual(E(snap({ Streaming: { State: 'Connecting', Error: 'None' } }), O), [
    'Streaming: connecting',
  ]);
  assert.deepEqual(E(snap({ Streaming: { State: 'Idle', Error: 'InvalidState' } }), O), [
    'Not streaming (invalid state)',
  ]);
  assert.deepEqual(E(snap(), O), ['Streaming status not reported by this switcher']);
});

test('Evaluate: recording must be running and fault-free when enabled', () => {
  const E = atem._internal.Evaluate;
  const O = { ...ON, CheckRecording: true };
  assert.deepEqual(E(snap({ Recording: { State: 'Recording', Error: 'None' } }), O), []);
  assert.deepEqual(E(snap({ Recording: { State: 'Recording', Error: 'NoMedia' } }), O), []);
  assert.deepEqual(E(snap({ Recording: { State: 'Recording', Error: 'DroppingFrames' } }), O), [
    'Recording: dropping frames',
  ]);
  assert.deepEqual(E(snap({ Recording: { State: 'Idle', Error: 'NoMedia' } }), O), [
    'Not recording (no media)',
  ]);
  assert.deepEqual(E(snap({ Recording: { State: 'Stopping', Error: 'None' } }), O), [
    'Recording: stopping',
  ]);
  assert.deepEqual(E(snap(), O), ['Recording status not reported by this switcher']);
});

test('settings defaults: port 9910, power on, streaming/recording off, advanced timeout', () => {
  const by = Object.fromEntries(atem.Settings.map((s) => [s.Key, s]));
  assert.equal(atem.ID, 'atem');
  assert.equal(atem.Group, 'Video');
  assert.equal(by.Port.Default, 9910);
  assert.equal(by.Port.Required, true);
  assert.equal(by.CheckPower.Default, true);
  assert.equal(by.CheckStreaming.Default, false);
  assert.equal(by.CheckRecording.Default, false);
  assert.equal(by.Timeout.Default, 4000);
  assert.equal(by.Timeout.Advanced, true);
  assert.equal(atem.SupportsLatencyThreshold, false);
  assert.deepEqual(atem._internal.ParseOptions({ Settings: {} }), ON);
});

test('Run rejects a missing address or an invalid port without opening anything', async () => {
  reset();
  assert.deepEqual(await atem.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const r = await atem.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.equal(r.Success, false);
  assert.match(r.Error, /Invalid port/);
  assert.equal(Manager.Count(), 0);
});

// --- Live: fake switcher -----------------------------------------------------

const FAST = {
  LostAfterMs: 300,
  HelloTimeoutMs: 200,
  RetryBaseMs: 50,
  RetryMaxMs: 100,
  WatchdogIntervalMs: 25,
};

test('happy path: handshake, multi-packet dump, acks, and one session for repeat runs', async () => {
  reset();
  const server = await startFakeAtem();
  try {
    const r = await atem.Run(target(server.port));
    assert.equal(r.Success, true, r.Error);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(typeof r.LatencyMs, 'number');
    assert.equal(r.ProductName, 'ATEM 2 M/E Production Studio 4K');
    assert.equal(r.ProtocolVersion, '2.30');
    assert.equal(r.Model, 6);
    assert.deepEqual(r.PowerSupplies, [psu(1, true), psu(2, true)]);
    assert.deepEqual(r.Program, { Id: 1, Name: 'Camera 1', ShortName: 'CAM1' });
    assert.deepEqual(r.Preview, { Id: 2, Name: 'Camera 2', ShortName: 'CAM2' });
    assert.equal(r.Streaming, null);
    assert.equal(r.Recording, null);
    // Every reliable packet acked, with the switcher's post-handshake session id.
    assert.ok(await waitFor(() => server.unackedCount() === 0));
    assert.deepEqual([...server.stats.ackSessions], [server.currentSession()]);
    // Keepalives keep being acked.
    const acks = server.stats.acks.length;
    await sleep(350);
    assert.ok(server.stats.acks.length > acks, 'keepalives acked');
    // A second probe reuses the held session.
    const again = await atem.Run(target(server.port));
    assert.equal(again.Success, true);
    assert.equal(server.stats.hellos, 1);
    assert.equal(Manager.Count(), 1);
  } finally {
    reset();
    await server.close();
  }
});

test('a dual-supply switcher run on one supply is not Degraded', async () => {
  reset();
  const server = await startFakeAtem({ power: 0x01 });
  try {
    const r = await atem.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.deepEqual(r.PowerSupplies, [psu(1, true), psu(2, false, false)]);
  } finally {
    reset();
    await server.close();
  }
});

test('a supply that dies mid-session is Degraded by default', async () => {
  reset();
  const server = await startFakeAtem({ power: 0x03 });
  try {
    const first = await atem.Run(target(server.port));
    assert.ok(!first.Degraded, first.DegradedReason);
    server.sendPower(0x01);
    assert.ok(
      await waitFor(async () => (await atem.Run(target(server.port))).Degraded === true),
      'failure seen'
    );
    const r = await atem.Run(target(server.port));
    assert.equal(r.DegradedReason, 'Power supply 2 failed');
    assert.deepEqual(r.PowerSupplies, [psu(1, true), psu(2, false, true)]);
    const off = await atem.Run(target(server.port, { CheckPower: false }));
    assert.ok(!off.Degraded);
  } finally {
    reset();
    await server.close();
  }
});

test('a single-supply model never fails the power check', async () => {
  reset();
  const server = await startFakeAtem({ model: 0x0d, product: 'ATEM Mini', power: 0x01 });
  try {
    const r = await atem.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded);
    assert.deepEqual(r.PowerSupplies, [psu(1, true)]);
  } finally {
    reset();
    await server.close();
  }
});

test('streaming and recording checks read StRS / RTMS', async () => {
  reset();
  const server = await startFakeAtem({
    model: 0x0e,
    product: 'ATEM Mini Pro',
    power: 0x01,
    streaming: 0x0001,
    recording: 0x0003,
  });
  try {
    const r = await atem.Run(target(server.port, { CheckStreaming: true, CheckRecording: true }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Not streaming');
    assert.deepEqual(r.Streaming, { State: 'Idle', Error: 'None' });
    assert.deepEqual(r.Recording, { State: 'Recording', Error: 'None' });
  } finally {
    reset();
    await server.close();
  }
});

test('a lost packet mid-dump is recovered from the switcher’s resend', async () => {
  reset();
  const server = await startFakeAtem({ dropOnce: [2], packets: 4 });
  try {
    const r = await atem.Run(target(server.port));
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.ProductName, 'ATEM 2 M/E Production Studio 4K');
    assert.deepEqual(r.Program, { Id: 1, Name: 'Camera 1', ShortName: 'CAM1' });
  } finally {
    reset();
    await server.close();
  }
});

test('malformed and short datagrams in a live session are ignored', async () => {
  reset(FAST);
  const server = await startFakeAtem({ junkAfterHandshake: true, pingMs: 50 });
  try {
    const r = await atem.Run(target(server.port));
    assert.equal(r.Success, true, r.Error);
    assert.ok(!r.Degraded);
    // Junk seen inside a session must not later read as "not an ATEM".
    server.silence();
    const key = `127.0.0.1|${server.port}`;
    assert.ok(await waitFor(() => !Manager.Snapshot(key).Connected), 'loss detected');
    const down = await atem.Run(target(server.port, { Timeout: 500 }));
    assert.equal(down.Success, false);
    assert.ok(!down.Degraded);
  } finally {
    reset();
    await server.close();
  }
});

test('no reply within the timeout is Offline', async () => {
  reset();
  const server = await startFakeAtem({ mode: 'silent' });
  try {
    const started = Date.now();
    const r = await atem.Run(target(server.port, { Timeout: 600 }));
    assert.equal(r.Success, false);
    assert.equal(r.Error, 'No reply from the switcher');
    assert.ok(Date.now() - started < 1500);
  } finally {
    reset();
    await server.close();
  }
});

test('an echo of our hello is Degraded as not an ATEM', async () => {
  reset();
  const server = await startFakeAtem({ mode: 'echo' });
  try {
    const r = await atem.Run(target(server.port, { Timeout: 1000 }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /not an ATEM switcher/);
  } finally {
    reset();
    await server.close();
  }
});

test('a non-ATEM UDP reply is Degraded as not an ATEM', async () => {
  reset();
  const server = await startFakeAtem({ mode: 'junk' });
  try {
    const r = await atem.Run(target(server.port, { Timeout: 600 }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /not an ATEM switcher/);
  } finally {
    reset();
    await server.close();
  }
});

test('a switcher with no free client slots is Degraded', async () => {
  reset();
  const server = await startFakeAtem({ helloStatus: 0x03 });
  try {
    const r = await atem.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /no free connections/);
  } finally {
    reset();
    await server.close();
  }
});

// "No free slots" is an answer, so it must not outlive the switcher giving it:
// one that was full and has since gone silent (powered off, cable pulled) has to
// read Offline, not stay Online-but-Degraded and mask the outage.
test('a full switcher that then goes silent reads Offline, not Degraded', async () => {
  reset(FAST);
  const server = await startFakeAtem({ helloStatus: 0x03 });
  try {
    const First = await atem.Run(target(server.port, { Timeout: 1000 }));
    assert.equal(First.Degraded, true);
    assert.match(First.DegradedReason, /no free connections/);

    server.silence();
    // Let several unanswered retry hellos go out.
    await sleep(600);
    const Second = await atem.Run(target(server.port, { Timeout: 1000 }));
    assert.equal(Second.Success, false);
    assert.doesNotMatch(String(Second.DegradedReason || ''), /no free connections/);
  } finally {
    reset();
    await server.close();
  }
});

// A session is only kept alive by its check's own Run(), so the reap window must
// outlast the longest interval a target can have. Shorter, and a slow check
// reaps its own session between runs, losing the power-supply memory each time.
test('the session reap window outlasts the longest monitoring interval', () => {
  const { MAX_MONITORING_INTERVAL_MS } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'Config', 'constants.js')
  );
  assert.ok(shared._internal.DEFAULT_TIMINGS.InterestTtlMs > MAX_MONITORING_INTERVAL_MS);
});

test('silence drops the session; a rebooted switcher is reconnected with fresh state', async () => {
  reset(FAST);
  const server = await startFakeAtem({ pingMs: 50 });
  try {
    const first = await atem.Run(target(server.port));
    assert.equal(first.Success, true, first.Error);
    assert.equal(first.Program.Id, 1);

    server.silence();
    const key = `127.0.0.1|${server.port}`;
    assert.ok(await waitFor(() => !Manager.Snapshot(key).Connected), 'loss detected');
    const down = await atem.Run(target(server.port, { Timeout: 500 }));
    assert.equal(down.Success, false);

    // It comes back with supply 2 down: remembered as seen OK, so it has failed.
    server.reboot({ program: 2, power: 0x01 });
    const back = await atem.Run(target(server.port, { Timeout: 2000 }));
    assert.equal(back.Success, true, back.Error);
    assert.equal(back.Program.Id, 2);
    assert.equal(back.DegradedReason, 'Power supply 2 failed');
    assert.ok(server.stats.hellos >= 2);
  } finally {
    reset();
    await server.close();
  }
});

test('a new session started by the switcher mid-session resets and reloads state', async () => {
  reset();
  const server = await startFakeAtem();
  try {
    const first = await atem.Run(target(server.port));
    assert.equal(first.Program.Id, 1);
    server.newSessionMidway({ program: 2, power: 0x01 });
    assert.ok(
      await waitFor(async () => {
        const r = await atem.Run(target(server.port));
        return r.Success && r.Program && r.Program.Id === 2;
      })
    );
    const r = await atem.Run(target(server.port));
    assert.equal(r.DegradedReason, 'Power supply 2 failed');
    assert.equal(server.stats.hellos, 1); // no reconnect needed
    assert.equal(server.stats.dumps, 2);
  } finally {
    reset();
    await server.close();
  }
});

test('a session nobody asks about is reaped and stops acking', async () => {
  reset({ InterestTtlMs: 150, SweepIntervalMs: 40 });
  const server = await startFakeAtem({ pingMs: 30 });
  try {
    const r = await atem.Run(target(server.port));
    assert.equal(r.Success, true, r.Error);
    assert.ok(await waitFor(() => Manager.Count() === 0, 2000), 'reaped');
    await sleep(100);
    const acks = server.stats.acks.length;
    await sleep(200);
    assert.equal(server.stats.acks.length, acks, 'no acks after reaping');
    // Reaping forgets which supplies were seen OK: a fresh watch of the same
    // address treats a dead supply 2 as never connected.
    server.opts.power = 0x01;
    const fresh = await atem.Run(target(server.port));
    assert.equal(fresh.Success, true, fresh.Error);
    assert.ok(!fresh.Degraded, fresh.DegradedReason);
    assert.deepEqual(fresh.PowerSupplies, [psu(1, true), psu(2, false, false)]);
  } finally {
    reset();
    await server.close();
  }
});

// --- Debug -------------------------------------------------------------------

test('Debug escapes device-supplied strings and shows PSU and ME 1 rows', () => {
  const html = atem.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: 'Power supply 2 failed',
      LatencyMs: 1.4,
      ProductName: '<script>alert(1)</script>',
      ProtocolVersion: '2.30',
      PowerSupplies: [psu(1, true), psu(2, false, true)],
      Program: { Id: 1, Name: '<img src=x onerror=1>', ShortName: 'CAM1' },
      Preview: { Id: 3010, Name: null, ShortName: null },
      Streaming: { State: 'Streaming', Error: 'None' },
      Recording: { State: 'Idle', Error: 'NoMedia' },
    },
    target(9910)
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /PSU 1 OK/);
  assert.match(html, /bg-danger[^"]*">PSU 2 failed/);
  const notConnected = atem.Debug(
    { Success: true, PowerSupplies: [psu(1, true), psu(2, false, false)] },
    target(9910)
  );
  assert.match(notConnected, /bg-ghost-light[^"]*">PSU 2 Not connected/);
  assert.ok(!notConnected.includes('failed'));
  assert.match(html, /ME 1 program/);
  assert.match(html, /Source 3010/);
  assert.match(html, /Not recording \(no media\)/);
  assert.match(html, /Degraded/);
});

test('Debug for an offline result shows the error detail', () => {
  const html = atem.Debug(
    { Success: false, Error: 'No reply from the switcher <x>' },
    { Address: '10.0.0.5', Settings: {} }
  );
  assert.match(html, /Offline/);
  assert.match(html, /10\.0\.0\.5:9910/);
  assert.ok(html.includes('&lt;x&gt;'));
});

test.after(() => {
  reset();
});
