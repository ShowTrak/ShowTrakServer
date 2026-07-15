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

function loadSacn() {
  return loadWithMocks(methodPath('_sacn-shared.js'), { '../Logger': loggerStub() });
}

// Build a well-formed E1.31 data packet for the given fields.
function buildPacket(opts = {}) {
  const {
    universe = 1,
    priority = 100,
    sourceName = 'Test Source',
    sequence = 0,
    rootVector = 0x00000004,
    framingVector = 0x00000002,
    validAcnId = true,
  } = opts;
  const buf = Buffer.alloc(126);
  buf.writeUInt16BE(0x0010, 0); // preamble size
  buf.writeUInt16BE(0x0000, 2); // post-amble size
  const acnId = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0]);
  (validAcnId ? acnId : Buffer.alloc(12)).copy(buf, 4);
  buf.writeUInt32BE(rootVector, 18);
  buf.writeUInt32BE(framingVector, 40);
  Buffer.from(sourceName, 'utf8').copy(buf, 44);
  buf[108] = priority;
  buf[111] = sequence;
  buf.writeUInt16BE(universe, 113);
  return buf;
}

// --- packet parsing ----------------------------------------------------------

test('ParseSacnPacket extracts universe, priority, name and source IP', () => {
  const { ParseSacnPacket } = loadSacn();
  const parsed = ParseSacnPacket(
    buildPacket({ universe: 42, priority: 150, sourceName: 'Console A' }),
    '10.0.0.5'
  );
  assert.equal(parsed.Universe, 42);
  assert.equal(parsed.Priority, 150);
  assert.equal(parsed.SourceName, 'Console A');
  assert.equal(parsed.Address, '10.0.0.5');
});

test('ParseSacnPacket normalizes IPv4-mapped source addresses', () => {
  const { ParseSacnPacket } = loadSacn();
  const parsed = ParseSacnPacket(buildPacket(), '::ffff:192.168.1.9');
  assert.equal(parsed.Address, '192.168.1.9');
});

test('ParseSacnPacket rejects non-E1.31 and malformed packets', () => {
  const { ParseSacnPacket } = loadSacn();
  assert.equal(ParseSacnPacket(Buffer.alloc(10), '1.2.3.4'), null, 'runt');
  assert.equal(ParseSacnPacket(buildPacket({ validAcnId: false }), '1.2.3.4'), null, 'bad ACN id');
  assert.equal(
    ParseSacnPacket(buildPacket({ rootVector: 0x00000008 }), '1.2.3.4'),
    null,
    'sync/other root vector'
  );
  assert.equal(
    ParseSacnPacket(buildPacket({ framingVector: 0x00000003 }), '1.2.3.4'),
    null,
    'non-data framing vector'
  );
  assert.equal(
    ParseSacnPacket(buildPacket({ universe: 0 }), '1.2.3.4'),
    null,
    'reserved universe 0'
  );
  assert.equal(
    ParseSacnPacket(buildPacket({ universe: 64000 }), '1.2.3.4'),
    null,
    'reserved universe 64000'
  );
});

// --- multicast address mapping ----------------------------------------------

test('MulticastAddressForUniverse maps universes to 239.255.x.y', () => {
  const { MulticastAddressForUniverse } = loadSacn();
  assert.equal(MulticastAddressForUniverse(1), '239.255.0.1');
  assert.equal(MulticastAddressForUniverse(256), '239.255.1.0');
  assert.equal(MulticastAddressForUniverse(63999), '239.255.249.255');
});

// --- evaluation logic (pure) -------------------------------------------------

function source(overrides = {}) {
  return {
    Address: '10.0.0.5',
    Priority: 100,
    SourceName: 'Src',
    Sequence: 0,
    Universe: 1,
    LastSeenAt: 1000,
    ...overrides,
  };
}

function baseParams(overrides = {}) {
  return {
    Snapshot: { Ready: true, Error: null, Sources: [] },
    Address: '10.0.0.5',
    Universe: 1,
    Priority: null,
    RequirePriority: false,
    GracePeriodMs: 5000,
    Now: 2000,
    ...overrides,
  };
}

test('EvaluateSacn is online when the target source is transmitting the universe', () => {
  const { EvaluateSacn } = loadSacn();
  const res = EvaluateSacn(
    baseParams({ Snapshot: { Ready: true, Error: null, Sources: [source()] } })
  );
  assert.equal(res.Success, true);
  assert.equal(res.Matched, true);
  assert.equal(res.LatencyMs, 1000); // Now - LastSeenAt
});

test('EvaluateSacn is offline when the universe is seen from nobody', () => {
  const { EvaluateSacn } = loadSacn();
  const res = EvaluateSacn(baseParams());
  assert.equal(res.Success, false);
  assert.equal(res.Degraded, undefined);
  assert.match(res.Error, /No sACN data for universe 1/);
});

test('EvaluateSacn reports listener-starting before the socket is ready', () => {
  const { EvaluateSacn } = loadSacn();
  const res = EvaluateSacn(baseParams({ Snapshot: { Ready: false, Error: null, Sources: [] } }));
  assert.equal(res.Success, false);
  assert.match(res.Error, /starting/);
});

test('EvaluateSacn degrades when the universe comes from a different source', () => {
  const { EvaluateSacn } = loadSacn();
  const res = EvaluateSacn(
    baseParams({
      Snapshot: { Ready: true, Error: null, Sources: [source({ Address: '10.0.0.99' })] },
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.Degraded, true);
  assert.match(res.DegradedReason, /from 10\.0\.0\.99, not 10\.0\.0\.5/);
});

test('EvaluateSacn ignores sources older than the grace period', () => {
  const { EvaluateSacn } = loadSacn();
  const res = EvaluateSacn(
    baseParams({
      Now: 10000,
      Snapshot: { Ready: true, Error: null, Sources: [source({ LastSeenAt: 1000 })] },
    })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /No sACN data/);
});

test('EvaluateSacn matches on priority when required', () => {
  const { EvaluateSacn } = loadSacn();
  const ok = EvaluateSacn(
    baseParams({
      RequirePriority: true,
      Priority: 150,
      Snapshot: { Ready: true, Error: null, Sources: [source({ Priority: 150 })] },
    })
  );
  assert.equal(ok.Success, true);
  assert.equal(ok.Matched, true);
});

test('EvaluateSacn degrades on a priority mismatch from the target', () => {
  const { EvaluateSacn } = loadSacn();
  const res = EvaluateSacn(
    baseParams({
      RequirePriority: true,
      Priority: 150,
      Snapshot: { Ready: true, Error: null, Sources: [source({ Priority: 100 })] },
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.Degraded, true);
  assert.match(res.DegradedReason, /Priority 100 \(expected 150\)/);
});

test('EvaluateSacn surfaces a listener error', () => {
  const { EvaluateSacn } = loadSacn();
  const res = EvaluateSacn(
    baseParams({ Snapshot: { Ready: false, Error: 'EADDRINUSE', Sources: [] } })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /EADDRINUSE/);
});

// --- Run() / config validation ----------------------------------------------

test('RunSacn rejects a missing source IP and out-of-range universe', () => {
  const { RunSacn } = loadSacn();
  assert.match(
    RunSacn({ Address: '', Settings: { Universe: 1 } }, { RequirePriority: false }).Error,
    /No source IP/
  );
  assert.match(
    RunSacn({ Address: '1.2.3.4', Settings: { Universe: 70000 } }, { RequirePriority: false })
      .Error,
    /Invalid universe/
  );
});

// --- end-to-end receiver (best-effort; skips if port 5568 is unavailable) ----

// Sends over multicast (not loopback unicast) because sACN is a multicast
// protocol: a multicast datagram is delivered to every socket that joined the
// group, so this works even when other software already shares udp/5568.
test('SacnReceiver ingests a real multicast datagram for an observed universe', async (t) => {
  const { SacnReceiver, MulticastAddressForUniverse } = loadSacn();
  const UNIVERSE = 12345;
  const GROUP = MulticastAddressForUniverse(UNIVERSE);

  SacnReceiver.Observe(UNIVERSE);
  // Give the socket a moment to bind.
  await new Promise((r) => setTimeout(r, 150));

  let snap = SacnReceiver.Snapshot(UNIVERSE);
  if (!snap.Ready) {
    SacnReceiver.Stop();
    t.skip(`sACN socket not ready (${snap.Error || 'binding'}) — environment cannot bind udp/5568`);
    return;
  }

  const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const packet = buildPacket({ universe: UNIVERSE, priority: 77, sourceName: 'E2E' });
  await new Promise((resolve, reject) => {
    client.send(packet, 5568, GROUP, (err) => (err ? reject(err) : resolve()));
  });

  // Poll for the datagram to be received and parsed.
  for (let i = 0; i < 20; i++) {
    snap = SacnReceiver.Snapshot(UNIVERSE);
    if (snap.Sources.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  client.close();
  SacnReceiver.Stop();

  const src = snap.Sources.find((s) => s.Universe === UNIVERSE);
  if (!src) {
    // Multicast loopback is environment-dependent (isolated CI has no NIC to
    // loop the group back on). The parse/evaluate paths are covered above.
    t.skip('multicast loopback not available in this environment');
    return;
  }
  assert.equal(src.Priority, 77);
  assert.equal(src.SourceName, 'E2E');
});
