const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loadMotive() {
  return loadWithMocks(methodPath('motive.js'), {});
}

function loadShared() {
  return loadWithMocks(methodPath('_natnet-shared.js'), {});
}

// --- NatNet encoders, written independently from the module from the SDK
// samples' layouts (PacketClient.cpp / NatNetClient.py / NatNetTypes.h). ---

const NAT = {
  CONNECT: 0,
  SERVERINFO: 1,
  REQUEST: 2,
  RESPONSE: 3,
  REQUEST_MODELDEF: 4,
  MODELDEF: 5,
  FRAMEOFDATA: 7,
  MESSAGESTRING: 8,
  DISCONNECT: 9,
  KEEPALIVE: 10,
  UNRECOGNIZED: 100,
};

function packet(id, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

const i32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
};
const i16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v, 0);
  return b;
};
const f32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v, 0);
  return b;
};
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const floats = (n) => Buffer.alloc(n * 4);

function serverInfo({ name, appVersion, natnet, connection }) {
  const sender = Buffer.alloc(264);
  Buffer.from(name, 'utf8').copy(sender, 0, 0, 255);
  Buffer.from(appVersion).copy(sender, 256);
  Buffer.from(natnet).copy(sender, 260);
  if (!connection) return sender;
  const tail = Buffer.alloc(15);
  tail.writeBigUInt64LE(10000000n, 0);
  tail.writeUInt16LE(connection.dataPort, 8);
  tail[10] = connection.multicast ? 1 : 0;
  Buffer.from(connection.group.split('.').map(Number)).copy(tail, 11);
  return Buffer.concat([sender, tail]);
}

function rigidBodyDescription([major, minor], { name, id, markers = 3 }) {
  const parts = [cstr(name), i32(id), i32(-1), floats(3)];
  if (major > 4 || (major === 4 && minor >= 2)) parts.push(floats(4));
  parts.push(i32(markers), floats(markers * 3), Buffer.alloc(markers * 4));
  if (major >= 4) for (let m = 0; m < markers; m++) parts.push(cstr(`${name}_${m + 1}`));
  return Buffer.concat(parts);
}

// items: { type: 0, name, markers: [names] } | { type: 1, name, id } |
//        { type: 2, name, id, bones: [{ name, id }] } | { type: N, raw: Buffer }
function modelDef(version, items) {
  const [major, minor] = version;
  const sized = major > 4 || (major === 4 && minor >= 1);
  const parts = [i32(items.length)];
  for (const item of items) {
    let body;
    if (item.type === 0) {
      body = Buffer.concat([cstr(item.name), i32(item.markers.length), ...item.markers.map(cstr)]);
    } else if (item.type === 1) {
      body = rigidBodyDescription(version, item);
    } else if (item.type === 2) {
      body = Buffer.concat([
        cstr(item.name),
        i32(item.id),
        i32(item.bones.length),
        ...item.bones.map((b) => rigidBodyDescription(version, b)),
      ]);
    } else {
      body = item.raw;
    }
    parts.push(i32(item.type));
    if (sized) parts.push(i32(item.size == null ? body.length : item.size));
    parts.push(body);
  }
  return Buffer.concat(parts);
}

// A frame up to (and a little past) the rigid body section.
function frame(
  version,
  frameNumber,
  bodies,
  { markerSets = [], others = 0, badRbSize = false } = {}
) {
  const [major, minor] = version;
  const sized = major > 4 || (major === 4 && minor >= 1);
  const ms = Buffer.concat(
    markerSets.map((m) => Buffer.concat([cstr(m.name), i32(m.count), floats(m.count * 3)]))
  );
  const other = floats(others * 3);
  const rbs = Buffer.concat(
    bodies.map((b) => Buffer.concat([i32(b.id), floats(7), f32(0.0004), i16(b.tracked ? 1 : 0)]))
  );
  const parts = [i32(frameNumber), i32(markerSets.length)];
  if (sized) parts.push(i32(ms.length));
  parts.push(ms, i32(others));
  if (sized) parts.push(i32(other.length));
  parts.push(other, i32(bodies.length));
  if (sized) parts.push(i32(badRbSize ? rbs.length + 2 : rbs.length));
  parts.push(rbs, i32(0)); // skeleton count: present, ignored by the parser
  return Buffer.concat(parts);
}

// --- A fake Motive on 127.0.0.1 ---------------------------------------------
//   multicast        : server info says multicast (frames go to setFrameTarget)
//   bodies           : [{ id, name, tracked, inModel = true, streamed = true }]
//   unrecognised     : commands answered with NAT_UNRECOGNIZED_REQUEST
//   duplicateReplies : send every NAT_RESPONSE twice (late-duplicate case)
//   dropFirst        : swallow this many incoming datagrams (UDP loss)
//   raw              : (msgId, payload) => Buffer[] | null overrides replies
function startMotive({
  name = 'Motive',
  appVersion = [3, 1, 0, 0],
  natnet = [4, 1, 0, 0],
  connection = 'default',
  multicast = false,
  dataPort = 1511,
  group = '239.255.42.99',
  mode = 0,
  frameRate = 120,
  units = 1000,
  sessionPath = 'C:/Users/Public/Documents/OptiTrack/Session 2026-10-16/',
  bodies = [],
  extraModel = [],
  modelOverride = null,
  frameOptions = {},
  sendFrames = true,
  unrecognised = [],
  duplicateReplies = false,
  dropFirst = 0,
  replyDelay = 0,
  raw = null,
} = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const received = [];
    let dropped = 0;
    let client = null;
    let frameTarget = null;
    let frameNo = 1;
    const pending = new Set();
    const version = natnet;
    const conn = connection === 'default' ? { dataPort, multicast, group } : connection; // null = pre-3.0 info

    const send = (buf, port, address) => sock.send(buf, port, address);
    const frameTimer = setInterval(() => {
      if (!sendFrames) return;
      const target = multicast ? frameTarget : client;
      if (!target) return;
      const streamed = bodies.filter((b) => b.streamed !== false);
      send(
        packet(NAT.FRAMEOFDATA, frame(version, frameNo++, streamed, frameOptions)),
        target.port,
        target.address
      );
    }, 5);

    sock.on('message', (buf, rinfo) => {
      if (dropped < dropFirst) {
        dropped++;
        return;
      }
      const id = buf.readUInt16LE(0);
      const payload = buf.subarray(4, 4 + buf.readUInt16LE(2));
      const text = id === NAT.REQUEST ? payload.toString('utf8').replace(/\0.*$/s, '') : null;
      received.push({ id, text, size: payload.length });
      const reply = (b) => send(b, rinfo.port, rinfo.address);
      // A slow Motive: command and model-list replies arrive after replyDelay.
      const later = (b) => {
        if (!replyDelay) return reply(b);
        const t = setTimeout(() => {
          pending.delete(t);
          reply(b);
        }, replyDelay);
        pending.add(t);
      };
      if (raw) {
        const out = raw(id, payload, text, reply);
        if (out) {
          for (const b of out) reply(b);
          return;
        }
      }
      if (id === NAT.CONNECT) {
        client = { port: rinfo.port, address: rinfo.address };
        reply(packet(NAT.SERVERINFO, serverInfo({ name, appVersion, natnet, connection: conn })));
      } else if (id === NAT.DISCONNECT) {
        client = null;
      } else if (id === NAT.REQUEST) {
        if (unrecognised.includes(text)) {
          later(packet(NAT.UNRECOGNIZED));
          return;
        }
        let out = null;
        if (text === 'CurrentMode') out = i32(mode);
        else if (text === 'FrameRate') out = f32(frameRate);
        else if (text === 'UnitsToMillimeters') out = f32(units);
        else if (text === 'CurrentSessionPath') out = cstr(sessionPath);
        if (!out) {
          later(packet(NAT.UNRECOGNIZED));
          return;
        }
        later(packet(NAT.RESPONSE, out));
        if (duplicateReplies) later(packet(NAT.RESPONSE, out));
      } else if (id === NAT.REQUEST_MODELDEF) {
        const model =
          modelOverride ||
          modelDef(version, [
            ...extraModel,
            ...bodies
              .filter((b) => b.inModel !== false)
              .map((b) => ({ type: 1, name: b.name, id: b.id })),
          ]);
        later(packet(NAT.MODELDEF, model));
      }
    });
    sock.bind(0, '127.0.0.1', () => {
      resolve({
        port: sock.address().port,
        received,
        commands: () => received.filter((r) => r.id === NAT.REQUEST).map((r) => r.text),
        has: (msgId) => received.some((r) => r.id === msgId),
        setFrameTarget: (port) => {
          frameTarget = { port, address: '127.0.0.1' };
        },
        close: () =>
          new Promise((r) => {
            clearInterval(frameTimer);
            for (const t of pending) clearTimeout(t);
            sock.close(r);
          }),
      });
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// Multicast frames arrive through a loopback socket the fake server streams
// to, so the test never depends on the host's multicast routes.
function useLoopbackFrameListener(motive, server, seen = []) {
  motive._internal.SetFrameListenerFactory((options, onPacket) => {
    seen.push(options);
    const s = dgram.createSocket('udp4');
    s.on('message', (b, r) => onPacket(b, r.address));
    s.bind(0, '127.0.0.1', () => server.setFrameTarget(s.address().port));
    return { Close: () => s.close() };
  });
  return seen;
}

const run = (motive, server, settings = {}) =>
  motive.Run({
    Address: '127.0.0.1',
    Settings: { Port: server.port, Timeout: 2000, ...settings },
  });

// --- Tests ------------------------------------------------------------------

test('motive exposes its identity and read-only defaults', () => {
  const m = loadMotive();
  assert.equal(m.ID, 'motive');
  assert.equal(m.Name, 'OptiTrack Motive');
  assert.equal(typeof m.Run, 'function');
  assert.equal(typeof m.Debug, 'function');
  const byKey = Object.fromEntries(m.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 1510);
  assert.equal(byKey.Port.Required, true);
  assert.equal(byKey.CheckLiveMode.Default, true);
  assert.equal(byKey.CheckFrameRate.Default, false);
  assert.deepEqual(byKey.ExpectedFrameRate.VisibleWhen, { Key: 'CheckFrameRate', Equals: true });
  assert.equal(byKey.CheckRigidBodies.Default, false);
  assert.equal(byKey.TrackedRigidBodies.Type, 'list');
  assert.deepEqual(byKey.TrackedRigidBodies.VisibleWhen, { Key: 'CheckRigidBodies', Equals: true });
  assert.equal(byKey.Timeout.Default, 4000);
  assert.equal(byKey.Timeout.Advanced, true);
  assert.ok(!m.Actions, 'checks are read-only');
  // Absent toggle = on; explicit false = off.
  assert.equal(m._internal.ParseHealthOptions({ Settings: {} }).CheckLiveMode, true);
  assert.equal(
    m._internal.ParseHealthOptions({ Settings: { CheckLiveMode: false } }).CheckLiveMode,
    false
  );
});

test('motive happy path reads versions, mode, rate, units and session', async () => {
  const m = loadMotive();
  const server = await startMotive();
  try {
    const result = await run(m, server);
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.AppName, 'Motive');
    assert.equal(result.AppVersion, '3.1');
    assert.equal(result.NatNetVersion, '4.1');
    assert.equal(result.IsMotive, true);
    assert.equal(result.Mode, 0);
    assert.equal(result.ModeName, 'Live');
    assert.equal(result.FrameRate, 120);
    assert.equal(result.UnitsToMillimeters, 1000);
    assert.equal(result.SessionPath, 'C:/Users/Public/Documents/OptiTrack/Session 2026-10-16/');
    assert.deepEqual(result.Streaming, {
      Multicast: false,
      Group: '239.255.42.99',
      DataPort: 1511,
    });
    assert.equal(typeof result.LatencyMs, 'number');
    // Commands go one at a time, in the shape-alternating order.
    assert.deepEqual(server.commands(), [
      'CurrentMode',
      'FrameRate',
      'CurrentSessionPath',
      'UnitsToMillimeters',
    ]);
    // The connect is PacketClient's 273-byte payload; no model list without
    // the rigid body check.
    assert.equal(server.received[0].id, NAT.CONNECT);
    assert.equal(server.received[0].size, 273);
    assert.ok(!server.has(NAT.REQUEST_MODELDEF));
  } finally {
    await server.close();
  }
});

test('motive re-sends a lost connect and a lost command', async () => {
  const m = loadMotive();
  // Drop the first NAT_CONNECT and the first CurrentMode.
  let droppedMode = false;
  const server = await startMotive({
    dropFirst: 1,
    raw: (id, _p, text) => {
      if (text === 'CurrentMode' && !droppedMode) {
        droppedMode = true;
        return [];
      }
      return null;
    },
  });
  try {
    const result = await run(m, server, { Timeout: 3000 });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Mode, 0);
    assert.ok(server.commands().filter((c) => c === 'CurrentMode').length >= 2);
  } finally {
    await server.close();
  }
});

test('motive ignores a late duplicate answer instead of taking it for the next command', async () => {
  const m = loadMotive();
  const server = await startMotive({ duplicateReplies: true, mode: 0, frameRate: 240, units: 10 });
  try {
    const result = await run(m, server);
    assert.equal(result.Mode, 0);
    assert.equal(result.FrameRate, 240);
    assert.equal(result.UnitsToMillimeters, 10);
    assert.ok(result.SessionPath);
  } finally {
    await server.close();
  }
});

test('motive degrades when a different NatNet server answers, without sending commands', async () => {
  const m = loadMotive();
  const server = await startMotive({ name: 'Arena' });
  try {
    const result = await run(m, server);
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'NatNet server is "Arena", not Motive');
    assert.deepEqual(server.commands(), []);
  } finally {
    await server.close();
  }
});

test('motive degrades in Edit mode only while the toggle is on', async () => {
  const m = loadMotive();
  const server = await startMotive({ mode: 1 });
  try {
    const on = await run(m, server);
    assert.equal(on.Degraded, true);
    assert.equal(on.DegradedReason, 'Motive is in Edit mode');
    assert.equal(on.ModeName, 'Edit');
    const off = await run(m, server, { CheckLiveMode: false });
    assert.ok(!off.Degraded, off.DegradedReason);
  } finally {
    await server.close();
  }
});

test('motive flags a frame rate outside ±0.5 Hz', async () => {
  const m = loadMotive();
  const slow = await startMotive({ frameRate: 100 });
  const close = await startMotive({ frameRate: 120.4 });
  try {
    const bad = await run(m, slow, { CheckFrameRate: true, ExpectedFrameRate: 120 });
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'Frame rate 100 Hz (expected 120)');
    const ok = await run(m, close, { CheckFrameRate: true, ExpectedFrameRate: 120 });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const ignored = await run(m, slow, { ExpectedFrameRate: 120 });
    assert.ok(!ignored.Degraded, 'rate is not checked while the toggle is off');
  } finally {
    await slow.close();
    await close.close();
  }
});

test('motive reports an unsupported command instead of hanging on it', async () => {
  const m = loadMotive();
  const server = await startMotive({ unrecognised: ['CurrentMode'] });
  try {
    const result = await run(m, server);
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Failed to read Motive’s mode');
    assert.deepEqual(result.Unsupported, ['CurrentMode']);
    assert.equal(result.FrameRate, 120, 'later commands still run');
  } finally {
    await server.close();
  }
});

// A slow Motive that does not know `command`: the first send goes unanswered
// until the re-send, then BOTH sends are answered "unrecognised" — the second
// arriving 30 ms later, while the next request (whose own reply takes 100 ms)
// is in flight.
function slowUnrecognised(command) {
  let sends = 0;
  return (id, _payload, text, reply) => {
    if (text !== command) return null;
    sends++;
    if (sends === 2) {
      reply(packet(NAT.UNRECOGNIZED));
      setTimeout(() => reply(packet(NAT.UNRECOGNIZED)), 30);
    }
    return [];
  };
}

test('motive does not pin a slow duplicate "unrecognised" reply on the next command', async () => {
  const m = loadMotive();
  const server = await startMotive({ raw: slowUnrecognised('CurrentMode'), replyDelay: 100 });
  try {
    const result = await run(m, server, {
      Timeout: 1200,
      CheckLiveMode: false,
      CheckFrameRate: true,
      ExpectedFrameRate: 120,
    });
    assert.equal(result.FrameRate, 120);
    assert.deepEqual(result.Unsupported, ['CurrentMode']);
    assert.ok(!result.Degraded, result.DegradedReason);
  } finally {
    await server.close();
  }
});

test('motive does not pin a slow duplicate "unrecognised" reply on the model list', async () => {
  const m = loadMotive();
  const server = await startMotive({
    raw: slowUnrecognised('UnitsToMillimeters'),
    replyDelay: 100,
    bodies: [{ id: 1, name: 'Actor_Head', tracked: true }],
  });
  try {
    const result = await run(m, server, {
      Timeout: 2000,
      CheckRigidBodies: true,
      TrackedRigidBodies: ['Actor_Head'],
    });
    assert.deepEqual(result.Unsupported, ['UnitsToMillimeters']);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.RigidBodies[0].State, 'tracked');
  } finally {
    await server.close();
  }
});

test('motive tracks rigid bodies over unicast (NatNet 4.1) by name and by id', async () => {
  const m = loadMotive();
  const server = await startMotive({
    bodies: [
      { id: 1, name: 'Actor_Head', tracked: true },
      { id: 2, name: 'Prop', tracked: false },
      { id: 3, name: 'Wand', tracked: true, streamed: false },
    ],
    extraModel: [{ type: 0, name: 'Actor', markers: ['a', 'b'] }],
    frameOptions: { markerSets: [{ name: 'Actor', count: 2 }], others: 3 },
  });
  try {
    const result = await run(m, server, {
      CheckRigidBodies: true,
      TrackedRigidBodies: ['actor_head', 'Prop', 'Wand', 'Missing', '1', '7', 'Prop'],
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      'Rigid body Prop: not tracked; Rigid body Wand: not streamed; ' +
        'Rigid body Missing: not found in Motive; Rigid body 7: not found in Motive'
    );
    const byEntry = Object.fromEntries(result.RigidBodies.map((r) => [r.Entry, r]));
    assert.equal(byEntry.actor_head.State, 'tracked');
    assert.equal(byEntry.actor_head.Name, 'Actor_Head');
    assert.equal(byEntry['1'].State, 'tracked');
    assert.equal(byEntry['1'].Name, 'Actor_Head');
    assert.ok(result.FramesSampled > 0);
    assert.ok(server.has(NAT.REQUEST_MODELDEF));
    assert.ok(server.has(NAT.KEEPALIVE), 'unicast clients send keep-alives');
    // The probe signs off so Motive stops streaming to a closed port.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(server.has(NAT.DISCONNECT));
  } finally {
    await server.close();
  }
});

test('motive finishes early once every listed rigid body is tracked', async () => {
  const m = loadMotive();
  const server = await startMotive({ bodies: [{ id: 4, name: 'Cam', tracked: true }] });
  try {
    const started = Date.now();
    const result = await run(m, server, { CheckRigidBodies: true, TrackedRigidBodies: ['Cam'] });
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.ok(Date.now() - started < 450, 'does not wait out the sampling window');
  } finally {
    await server.close();
  }
});

test('motive joins the multicast group the server names (NatNet 4.2, sized model list)', async () => {
  const m = loadMotive();
  const camera = Buffer.concat([cstr('Prime 41 #1234'), floats(7)]);
  const server = await startMotive({
    natnet: [4, 2, 0, 0],
    appVersion: [3, 2, 0, 0],
    multicast: true,
    dataPort: 1600,
    group: '239.1.2.3',
    bodies: [{ id: 9, name: 'Drone', tracked: false }],
    // An unparsed description (camera) BEFORE the rigid body, skipped by size,
    // and a skeleton whose bones must not be mistaken for top-level bodies.
    extraModel: [
      { type: 5, raw: camera },
      { type: 2, name: 'Actor', id: 1, bones: [{ name: 'Hip', id: 1 }] },
    ],
  });
  const seen = useLoopbackFrameListener(m, server);
  try {
    const result = await run(m, server, {
      CheckRigidBodies: true,
      TrackedRigidBodies: ['Drone', 'Hip'],
    });
    assert.deepEqual(seen, [{ Group: '239.1.2.3', Port: 1600 }]);
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      'Rigid body Drone: not tracked; Rigid body Hip: not found in Motive'
    );
    assert.ok(!server.has(NAT.KEEPALIVE), 'no keep-alive in multicast mode');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!server.has(NAT.DISCONNECT), 'no disconnect in multicast mode');
  } finally {
    m._internal.SetFrameListenerFactory(null);
    await server.close();
  }
});

test('motive reports a multicast listen failure as a rigid body reason', async () => {
  const m = loadMotive();
  const server = await startMotive({
    multicast: true,
    bodies: [{ id: 1, name: 'A', tracked: true }],
  });
  m._internal.SetFrameListenerFactory((_o, _p, onError) => {
    setTimeout(() => onError(new Error('bind EADDRINUSE 0.0.0.0:1511')), 5);
    return { Close() {} };
  });
  try {
    const result = await run(m, server, { CheckRigidBodies: true, TrackedRigidBodies: ['A'] });
    assert.equal(result.Success, true);
    assert.equal(
      result.DegradedReason,
      'Rigid bodies: failed to listen for frame data on 239.255.42.99:1511 (bind EADDRINUSE 0.0.0.0:1511)'
    );
  } finally {
    m._internal.SetFrameListenerFactory(null);
    await server.close();
  }
});

test('motive parses NatNet 3.1 frames and model lists without section sizes', async () => {
  const m = loadMotive();
  const server = await startMotive({
    natnet: [3, 1, 0, 0],
    appVersion: [2, 1, 0, 0],
    bodies: [
      { id: 1, name: 'Head', tracked: true },
      { id: 5, name: 'Late', tracked: true },
    ],
    frameOptions: { markerSets: [{ name: 'all', count: 4 }], others: 1 },
    // Pre-4.1 lists carry no size, so an unknown type ends the walk: 'Late'
    // (described after it) cannot be resolved by name, only by id.
    modelOverride: modelDef(
      [3, 1],
      [
        { type: 0, name: 'all', markers: ['m1'] },
        { type: 1, name: 'Head', id: 1, markers: 2 },
        { type: 5, raw: Buffer.alloc(40) },
        { type: 1, name: 'Late', id: 5 },
      ]
    ),
  });
  try {
    const result = await run(m, server, {
      CheckRigidBodies: true,
      TrackedRigidBodies: ['Head', 'Late', '5'],
    });
    assert.equal(result.NatNetVersion, '3.1');
    assert.equal(
      result.DegradedReason,
      'Rigid body Late: failed to resolve the name; use its Streaming ID'
    );
    const byEntry = Object.fromEntries(result.RigidBodies.map((r) => [r.Entry, r]));
    assert.equal(byEntry.Head.State, 'tracked');
    assert.equal(byEntry['5'].State, 'tracked');
  } finally {
    await server.close();
  }
});

test('motive refuses rigid body sampling on a pre-3.0 NatNet server', async () => {
  const m = loadMotive();
  const server = await startMotive({
    natnet: [2, 10, 0, 0],
    appVersion: [1, 10, 0, 0],
    connection: null,
  });
  try {
    const result = await run(m, server, { CheckRigidBodies: true, TrackedRigidBodies: ['A'] });
    assert.equal(result.Success, true);
    assert.equal(
      result.DegradedReason,
      'Rigid bodies: NatNet 2.10 is too old for rigid body tracking (needs NatNet 3.0, Motive 2.0 or later)'
    );
    assert.equal(result.Streaming, null);
    assert.ok(!server.has(NAT.REQUEST_MODELDEF));
  } finally {
    await server.close();
  }
});

test('motive rejects frames whose rigid body byte count disagrees with the version', async () => {
  const m = loadMotive();
  const server = await startMotive({
    bodies: [{ id: 1, name: 'A', tracked: true }],
    frameOptions: { badRbSize: true },
  });
  try {
    const result = await run(m, server, {
      Timeout: 1500,
      CheckRigidBodies: true,
      TrackedRigidBodies: ['A'],
    });
    assert.equal(
      result.DegradedReason,
      'Rigid bodies: frame data could not be decoded as NatNet 4.1'
    );
  } finally {
    await server.close();
  }
});

test('motive reports no frame data when Motive streams none', async () => {
  const m = loadMotive();
  const server = await startMotive({ bodies: [{ id: 1, name: 'A' }], sendFrames: false });
  try {
    const result = await run(m, server, {
      Timeout: 1000,
      CheckRigidBodies: true,
      TrackedRigidBodies: ['A'],
    });
    assert.equal(result.Success, true);
    assert.equal(result.DegradedReason, 'Rigid bodies: no frame data received');
  } finally {
    await server.close();
  }
});

test('motive survives short, truncated and junk datagrams', async () => {
  const m = loadMotive();
  const server = await startMotive({
    raw: (id) =>
      id === NAT.CONNECT
        ? [
            Buffer.from([1, 0]),
            Buffer.from([1, 0, 0x10, 0x01, 1, 2, 3]), // claims 272 bytes, has 3
            packet(NAT.SERVERINFO, Buffer.alloc(100)), // too short for sSender
            Buffer.from('HTTP/1.1 400 Bad Request\r\n'),
            packet(NAT.FRAMEOFDATA, Buffer.from([0xff, 0xff, 0xff])),
          ]
        : null,
  });
  try {
    const result = await run(m, server, { Timeout: 600 });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Responded, but not with NatNet server info');
  } finally {
    await server.close();
  }
});

test('motive is offline when nothing answers', async () => {
  const m = loadMotive();
  const port = await freeUdpPort();
  const started = Date.now();
  const result = await m.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 600 } });
  assert.equal(result.Success, false);
  // The deadline, or an ICMP reset surfaced as a socket error (Windows).
  assert.ok(result.Error);
  assert.ok(Date.now() - started < 1500);
});

test('motive rejects a missing address, a bad port and IPv6 without probing', async () => {
  const m = loadMotive();
  assert.deepEqual(await m.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const bad = await m.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.match(bad.Error, /Invalid port/);
  const v6 = await m.Run({ Address: '::1', Settings: { Timeout: 600 } });
  assert.equal(v6.Success, false);
  assert.match(v6.Error, /IPv4 only/);
});

test('motive Debug escapes device-supplied strings', async () => {
  const m = loadMotive();
  const server = await startMotive({
    name: 'Motive<script>alert(1)</script>',
    sessionPath: 'C:/<img src=x onerror=alert(2)>/',
    bodies: [{ id: 1, name: '<b>Head</b>', tracked: false }],
  });
  try {
    const target = {
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        Timeout: 2000,
        CheckRigidBodies: true,
        TrackedRigidBodies: ['<b>Head</b>'],
      },
    };
    const result = await m.Run(target);
    assert.equal(result.IsMotive, true);
    const html = m.Debug(result, target);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<b>Head'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;b&gt;Head&lt;/b&gt;'));
    assert.ok(html.includes('Not tracked'));
    const offline = m.Debug({ Success: false, Error: '<x>' }, target);
    assert.ok(offline.includes('&lt;x&gt;'));
    assert.match(offline, /Settings → Streaming/);
    assert.match(offline, /Local Interface/);
  } finally {
    await server.close();
  }
});

test('motive EvaluateHealth is pure and gated by its toggles', () => {
  const { EvaluateHealth } = loadMotive()._internal;
  const snap = {
    IsNatNet: true,
    IsMotive: true,
    AppName: 'Motive',
    NatNetVersion: '4.1',
    Mode: 1,
    FrameRate: 60,
    RigidBodyDefs: [{ Id: 1, Name: 'A' }],
    ModelDefComplete: true,
    FramesSampled: 10,
    FrameBodies: [{ Id: 1, Frames: 10, TrackedFrames: 0 }],
    FrameError: null,
  };
  const off = {
    CheckLiveMode: false,
    CheckFrameRate: false,
    ExpectedFrameRate: 120,
    CheckRigidBodies: false,
    RigidBodies: ['A'],
  };
  assert.deepEqual(EvaluateHealth(snap, off), []);
  assert.deepEqual(EvaluateHealth(snap, { ...off, CheckLiveMode: true }), [
    'Motive is in Edit mode',
  ]);
  assert.deepEqual(EvaluateHealth({ ...snap, Mode: 3 }, { ...off, CheckLiveMode: true }), [
    'Motive reports an unknown mode (3)',
  ]);
  assert.deepEqual(EvaluateHealth(snap, { ...off, CheckFrameRate: true }), [
    'Frame rate 60 Hz (expected 120)',
  ]);
  assert.deepEqual(EvaluateHealth({ ...snap, FrameRate: null }, { ...off, CheckFrameRate: true }), [
    'Failed to read the frame rate',
  ]);
  assert.deepEqual(EvaluateHealth(snap, { ...off, CheckRigidBodies: true }), [
    'Rigid body A: not tracked',
  ]);
  assert.deepEqual(
    EvaluateHealth(
      { ...snap, RigidBodyDefs: null },
      { ...off, CheckRigidBodies: true, RigidBodies: ['A', '1'] }
    ),
    ['Failed to read Motive’s rigid body list', 'Rigid body 1: not tracked']
  );
  assert.deepEqual(EvaluateHealth({ ...snap, IsNatNet: false }, off), [
    'Responded, but not with NatNet server info',
  ]);
});

test('motive ResolveRigidBodies prefers a name over a numeric id', () => {
  const { ResolveRigidBodies, ParseRigidBodyList } = loadMotive()._internal;
  const evidence = {
    RigidBodyDefs: [
      { Id: 7, Name: '3' },
      { Id: 3, Name: 'Other' },
    ],
    ModelDefComplete: true,
    FramesSampled: 1,
    FrameBodies: [
      { Id: 7, Frames: 1, TrackedFrames: 1 },
      { Id: 3, Frames: 1, TrackedFrames: 0 },
    ],
  };
  const [byName] = ResolveRigidBodies(['3'], evidence);
  assert.equal(byName.Id, 7);
  assert.equal(byName.State, 'tracked');
  assert.deepEqual(ParseRigidBodyList([' A ', 'a', '', null, 'B']), ['A', 'B']);
  assert.deepEqual(ParseRigidBodyList('Solo'), ['Solo']);
  assert.deepEqual(ParseRigidBodyList(undefined), []);
});

test('natnet codec parses the sample layouts', () => {
  const nn = loadShared();
  const info = nn.ParseServerInfo(
    serverInfo({
      name: 'Motive',
      appVersion: [3, 0, 1, 0],
      natnet: [4, 0, 0, 0],
      connection: { dataPort: 1511, multicast: true, group: '239.255.42.99' },
    })
  );
  assert.equal(info.AppName, 'Motive');
  assert.equal(nn.FormatVersion(info.AppVersion), '3.0.1');
  assert.equal(nn.FormatVersion(info.NatNetVersion), '4.0');
  assert.deepEqual(info.Connection, {
    DataPort: 1511,
    Multicast: true,
    MulticastGroup: '239.255.42.99',
  });
  // 264-byte (pre-3.0 shaped) info has no connection block.
  assert.equal(
    nn.ParseServerInfo(serverInfo({ name: 'M', appVersion: [3, 0, 0, 0], natnet: [4, 0, 0, 0] }))
      .Connection,
    null
  );
  assert.equal(nn.DecodeResponse(i32(1), 'int'), 1);
  assert.equal(nn.DecodeResponse(f32(119.88), 'float').toFixed(2), '119.88');
  assert.equal(nn.DecodeResponse(cstr('C:/x/'), 'string'), 'C:/x/');
  assert.equal(nn.DecodeResponse(f32(1), 'string'), null);
  assert.equal(nn.DecodeResponse(cstr('abcdef'), 'float'), null);
  // Encoders match the samples.
  assert.deepEqual([...nn.EncodeRequest('FrameRate').subarray(0, 4)], [2, 0, 10, 0]);
  assert.deepEqual([...nn.EncodeSimple(10)], [10, 0, 0, 0]);
  const connect = nn.EncodeConnect();
  assert.equal(connect.readUInt16LE(2), 273);
  assert.ok(connect.subarray(4).every((b) => b === 0));
  // NatNet 4.0 frame (no sizes) and model list with marker names.
  const f = nn.ParseFrameRigidBodies(
    frame([4, 0], 42, [{ id: 3, tracked: true }], { markerSets: [{ name: 'x', count: 1 }] }),
    4,
    0
  );
  assert.deepEqual(f, { FrameNumber: 42, Bodies: [{ Id: 3, Tracked: true }] });
  const defs = nn.ParseModelDefs(modelDef([4, 0], [{ type: 1, name: 'R', id: 3 }]), 4, 0);
  assert.deepEqual(defs, { RigidBodies: [{ Id: 3, Name: 'R' }], Complete: true });
  // A 4.1+ description whose size disagrees with the parse stops the walk.
  const lying = nn.ParseModelDefs(
    modelDef(
      [4, 1],
      [
        { type: 1, name: 'R', id: 3, size: 5 },
        { type: 1, name: 'S', id: 4 },
      ]
    ),
    4,
    1
  );
  assert.equal(lying.Complete, false);
  assert.deepEqual(lying.RigidBodies, [{ Id: 3, Name: 'R' }]);
  assert.equal(nn.ParseFrameRigidBodies(frame([2, 10], 1, []), 2, 10), null);
});

test('natnet parsers never throw on random or truncated input', () => {
  const nn = loadShared();
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const good = [
    packet(NAT.FRAMEOFDATA, frame([4, 1], 1, [{ id: 1, tracked: true }], { others: 2 })),
    packet(NAT.MODELDEF, modelDef([4, 2], [{ type: 1, name: 'R', id: 1 }])),
    packet(
      NAT.SERVERINFO,
      serverInfo({ name: 'Motive', appVersion: [3, 1, 0, 0], natnet: [4, 1, 0, 0] })
    ),
  ];
  const inputs = [];
  for (const g of good) for (let n = 0; n <= g.length; n++) inputs.push(g.subarray(0, n));
  for (let i = 0; i < 1500; i++) {
    const b = Buffer.alloc(rand() % 600);
    for (let j = 0; j < b.length; j++) b[j] = rand() & 0xff;
    inputs.push(b);
  }
  for (const buf of inputs) {
    const pkt = nn.ParsePacket(buf);
    const payload = pkt ? pkt.Payload : buf;
    for (const [maj, min] of [
      [3, 0],
      [4, 0],
      [4, 1],
      [4, 2],
    ]) {
      nn.ParseFrameRigidBodies(payload, maj, min);
      nn.ParseModelDefs(payload, maj, min);
    }
    nn.ParseServerInfo(payload);
    nn.DecodeResponse(payload, 'int');
    nn.DecodeResponse(payload, 'string');
  }
  assert.equal(nn.ParsePacket(Buffer.from([1, 0])), null);
  assert.equal(nn.ParsePacket(null), null);
});
