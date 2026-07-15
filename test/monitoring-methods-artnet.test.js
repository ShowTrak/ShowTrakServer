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

function loadArtnet() {
  return loadWithMocks(methodPath('artnet-universe.js'), { '../Logger': loggerStub() })._internal;
}

// Build a well-formed ArtDmx packet for the given fields.
function buildPacket(opts = {}) {
  const {
    universe = 0,
    sequence = 0,
    opcode = 0x5000,
    protver = 14,
    validId = true,
    length = 18,
  } = opts;
  const buf = Buffer.alloc(length);
  const id = Buffer.from([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]); // "Art-Net\0"
  (validId ? id : Buffer.alloc(8)).copy(buf, 0);
  buf.writeUInt16LE(opcode, 8); // OpCode (little-endian on the wire)
  buf.writeUInt16BE(protver, 10); // ProtVer (big-endian)
  buf[12] = sequence;
  buf[14] = universe & 0xff; // SubUni (low byte)
  buf[15] = (universe >> 8) & 0x7f; // Net (high 7 bits)
  return buf;
}

// --- packet parsing ----------------------------------------------------------

test('ParseArtnetPacket extracts the 15-bit universe and source IP', () => {
  const { ParseArtnetPacket } = loadArtnet();
  const parsed = ParseArtnetPacket(buildPacket({ universe: 0x1234, sequence: 7 }), '10.0.0.5');
  assert.equal(parsed.Universe, 0x1234);
  assert.equal(parsed.Sequence, 7);
  assert.equal(parsed.Address, '10.0.0.5');
});

test('ParseArtnetPacket combines Net and SubUni into the Port-Address', () => {
  const { ParseArtnetPacket } = loadArtnet();
  assert.equal(ParseArtnetPacket(buildPacket({ universe: 0 }), '1.2.3.4').Universe, 0);
  assert.equal(ParseArtnetPacket(buildPacket({ universe: 256 }), '1.2.3.4').Universe, 256);
  assert.equal(ParseArtnetPacket(buildPacket({ universe: 32767 }), '1.2.3.4').Universe, 32767);
});

test('ParseArtnetPacket normalizes IPv4-mapped source addresses', () => {
  const { ParseArtnetPacket } = loadArtnet();
  const parsed = ParseArtnetPacket(buildPacket(), '::ffff:192.168.1.9');
  assert.equal(parsed.Address, '192.168.1.9');
});

test('ParseArtnetPacket rejects non-ArtDmx and malformed packets', () => {
  const { ParseArtnetPacket } = loadArtnet();
  assert.equal(ParseArtnetPacket(Buffer.alloc(10), '1.2.3.4'), null, 'runt');
  assert.equal(
    ParseArtnetPacket(buildPacket({ validId: false }), '1.2.3.4'),
    null,
    'bad Art-Net id'
  );
  assert.equal(
    ParseArtnetPacket(buildPacket({ opcode: 0x2000 }), '1.2.3.4'),
    null,
    'ArtPoll opcode'
  );
  assert.equal(
    ParseArtnetPacket(buildPacket({ protver: 13 }), '1.2.3.4'),
    null,
    'old protocol version'
  );
});

// --- evaluation logic (pure) -------------------------------------------------

function source(overrides = {}) {
  return {
    Address: '10.0.0.5',
    Sequence: 0,
    Universe: 0,
    LastSeenAt: 1000,
    ...overrides,
  };
}

function baseParams(overrides = {}) {
  return {
    Snapshot: { Ready: true, Error: null, Sources: [] },
    Address: '10.0.0.5',
    Universe: 0,
    GracePeriodMs: 5000,
    Now: 2000,
    ...overrides,
  };
}

test('EvaluateArtnet is online when the target source is transmitting the universe', () => {
  const { EvaluateArtnet } = loadArtnet();
  const res = EvaluateArtnet(
    baseParams({ Snapshot: { Ready: true, Error: null, Sources: [source()] } })
  );
  assert.equal(res.Success, true);
  assert.equal(res.Matched, true);
  assert.equal(res.LatencyMs, 1000); // Now - LastSeenAt
});

test('EvaluateArtnet is offline when the universe is seen from nobody', () => {
  const { EvaluateArtnet } = loadArtnet();
  const res = EvaluateArtnet(baseParams());
  assert.equal(res.Success, false);
  assert.equal(res.Degraded, undefined);
  assert.match(res.Error, /No Art-Net data for universe 0/);
});

test('EvaluateArtnet reports listener-starting before the socket is ready', () => {
  const { EvaluateArtnet } = loadArtnet();
  const res = EvaluateArtnet(baseParams({ Snapshot: { Ready: false, Error: null, Sources: [] } }));
  assert.equal(res.Success, false);
  assert.match(res.Error, /starting/);
});

test('EvaluateArtnet degrades when the universe comes from a different source', () => {
  const { EvaluateArtnet } = loadArtnet();
  const res = EvaluateArtnet(
    baseParams({
      Snapshot: { Ready: true, Error: null, Sources: [source({ Address: '10.0.0.99' })] },
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.Degraded, true);
  assert.match(res.DegradedReason, /from 10\.0\.0\.99, not 10\.0\.0\.5/);
});

test('EvaluateArtnet ignores sources older than the grace period', () => {
  const { EvaluateArtnet } = loadArtnet();
  const res = EvaluateArtnet(
    baseParams({
      Now: 10000,
      Snapshot: { Ready: true, Error: null, Sources: [source({ LastSeenAt: 1000 })] },
    })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /No Art-Net data/);
});

test('EvaluateArtnet surfaces a listener error', () => {
  const { EvaluateArtnet } = loadArtnet();
  const res = EvaluateArtnet(
    baseParams({ Snapshot: { Ready: false, Error: 'EADDRINUSE', Sources: [] } })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /EADDRINUSE/);
});

// --- end-to-end receiver (best-effort; skips if port 6454 is unavailable) -----

test('ArtnetReceiver ingests a real datagram for an observed universe', async (t) => {
  const { ArtnetReceiver } = loadArtnet();
  const UNIVERSE = 4321;

  ArtnetReceiver.Observe(UNIVERSE);
  // Give the socket a moment to bind.
  await new Promise((r) => setTimeout(r, 150));

  let snap = ArtnetReceiver.Snapshot(UNIVERSE);
  if (!snap.Ready) {
    ArtnetReceiver.Stop();
    t.skip(
      `Art-Net socket not ready (${snap.Error || 'binding'}) — environment cannot bind udp/6454`
    );
    return;
  }

  const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const packet = buildPacket({ universe: UNIVERSE, sequence: 3 });
  await new Promise((resolve, reject) => {
    client.send(packet, 6454, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });

  // Poll for the datagram to be received and parsed.
  for (let i = 0; i < 20; i++) {
    snap = ArtnetReceiver.Snapshot(UNIVERSE);
    if (snap.Sources.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  client.close();
  ArtnetReceiver.Stop();

  const src = snap.Sources.find((s) => s.Universe === UNIVERSE);
  if (!src) {
    t.skip('loopback delivery not available in this environment');
    return;
  }
  assert.equal(src.Sequence, 3);
  assert.equal(src.Address, '127.0.0.1');
});
