const test = require('node:test');
const assert = require('node:assert/strict');
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

// No interfaces and no change events: nothing in this suite touches the network.
function interfacesStub() {
  return {
    Manager: {
      List: () => [],
      Addresses: () => [],
      OnChange: () => () => {},
    },
  };
}

function loadLink() {
  return loadWithMocks(methodPath('ableton-link.js'), {
    '../Logger': loggerStub(),
    '../NetworkInterfaces': interfacesStub(),
  });
}

// A module whose receiver never binds a socket: packets are fed through the same
// Ingest() the socket handler uses.
function loadOffline() {
  const mod = loadLink();
  const rx = mod._internal.LinkReceiver;
  rx.EnsureStarted = () => {};
  return { mod, rx };
}

// --- Fixtures, built from the Link source definitions ---------------------------
//
// Header (discovery/v1/Messages.hpp): '_asdp_v' 0x01, uint8 type, uint8 ttl,
// uint16 group, 8-byte node id. Entries (discovery/Payload.hpp): uint32 key,
// uint32 size, value. Integers big-endian.

const KEYS = {
  tmln: 0x746d6c6e,
  sess: 0x73657373,
  stst: 0x73747374,
  artl: 0x6172746c,
  mep4: 0x6d657034,
  aep4: 0x61657034,
};

function header({ type = 1, ttl = 5, group = 0, node = '0102030405060708' } = {}) {
  const buf = Buffer.alloc(20);
  Buffer.from('_asdp_v', 'ascii').copy(buf, 0);
  buf[7] = 1;
  buf[8] = type;
  buf[9] = ttl;
  buf.writeUInt16BE(group, 10);
  Buffer.from(node, 'hex').copy(buf, 12);
  return buf;
}

function entry(key, value) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(key, 0);
  head.writeUInt32BE(value.length, 4);
  return Buffer.concat([head, value]);
}

function int64s(...values) {
  const buf = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => buf.writeBigInt64BE(BigInt(v), i * 8));
  return buf;
}

// Timeline: Tempo (int64 µs per beat), Beats (int64 micro-beats), int64 µs.
function tmln(bpm, beatOrigin = 0, timeOrigin = 0) {
  return entry(KEYS.tmln, int64s(Math.round(60e6 / bpm), beatOrigin, timeOrigin));
}

function sess(id) {
  return entry(KEYS.sess, Buffer.from(id, 'hex'));
}

// StartStopState: bool (uint8), Beats (int64), timestamp (int64 µs).
function stst(isPlaying, beats, timestamp) {
  return entry(
    KEYS.stst,
    Buffer.concat([Buffer.from([isPlaying ? 1 : 0]), int64s(beats, timestamp)])
  );
}

function mep4(ip, port) {
  const buf = Buffer.alloc(6);
  ip.split('.').forEach((o, i) => (buf[i] = Number(o)));
  buf.writeUInt16BE(port, 4);
  return entry(KEYS.mep4, buf);
}

function alive(opts = {}) {
  const {
    node = '0102030405060708',
    session = node,
    bpm = 120,
    playing = null,
    ststTimestamp = 1000,
    ttl = 5,
    type = 1,
    extra = [],
  } = opts;
  const parts = [header({ type, ttl, node }), tmln(bpm), sess(session)];
  if (playing !== null) parts.push(stst(playing, 0, ststTimestamp));
  parts.push(mep4('10.0.0.5', 50000), ...extra);
  return Buffer.concat(parts);
}

function byebye(node) {
  return header({ type: 3, ttl: 0, node });
}

// --- Decoder ------------------------------------------------------------------------

test('ParseLinkMessage decodes an ALIVE peer state', () => {
  const { _internal } = loadLink();
  const msg = _internal.ParseLinkMessage(
    alive({ node: 'aabbccddeeff0011', session: '1122334455667788', bpm: 128, playing: true })
  );
  assert.equal(msg.Type, 1);
  assert.equal(msg.Ttl, 5);
  assert.equal(msg.NodeId, 'aabbccddeeff0011');
  assert.equal(msg.SessionId, '1122334455667788');
  assert.equal(msg.MicrosPerBeat, 468750);
  assert.equal(msg.Tempo, 128);
  assert.equal(msg.IsPlaying, true);
  assert.equal(msg.StartStopTimestamp, 1000);
  assert.equal(msg.MeasurementEndpoint, '10.0.0.5:50000');
});

test('ParseLinkMessage reads a RESPONSE like an ALIVE and a BYEBYE without payload', () => {
  const { _internal } = loadLink();
  assert.equal(_internal.ParseLinkMessage(alive({ type: 2 })).Type, 2);
  const bye = _internal.ParseLinkMessage(byebye('0000000000000042'));
  assert.deepEqual(bye, { Type: 3, NodeId: '0000000000000042' });
});

test('ParseLinkMessage skips unknown and optional entries', () => {
  const { _internal } = loadLink();
  const msg = _internal.ParseLinkMessage(
    alive({
      extra: [
        entry(0x7a7a7a7a, Buffer.from('anything at all')),
        entry(KEYS.artl, int64s(0, 16000000, 5)),
        entry(KEYS.aep4, Buffer.alloc(6)),
      ],
    })
  );
  assert.equal(msg.Tempo, 120);
  assert.equal(msg.IsPlaying, null, 'no stst entry: Link before 3.0');
});

test('ParseLinkMessage defaults a missing session to the all-zero ID', () => {
  const { _internal } = loadLink();
  const msg = _internal.ParseLinkMessage(Buffer.concat([header(), tmln(90)]));
  assert.equal(msg.SessionId, '0000000000000000');
  // 90 BPM travels as 666667 µs per beat, so it reads back a hair under 90,
  // exactly as in Link (link/Tempo.hpp:40-41).
  assert.equal(msg.MicrosPerBeat, 666667);
  assert.ok(Math.abs(msg.Tempo - 90) < 1e-3);
  assert.equal(_internal.FormatTempo(msg.Tempo), '90');
});

test('ParseLinkMessage rejects what Link itself would ignore', () => {
  const { _internal } = loadLink();
  const P = _internal.ParseLinkMessage;
  assert.equal(P(Buffer.alloc(10)), null, 'runt');
  assert.equal(P(Buffer.from('not a link packet at all')), null, 'other protocol');
  const v2 = alive();
  v2[7] = 2;
  assert.equal(P(v2), null, 'other protocol version');
  assert.equal(P(Buffer.concat([header({ group: 1 }), tmln(120)])), null, 'non-zero group');
  assert.equal(P(header({ type: 0 })), null, 'invalid type');
  assert.equal(P(header({ type: 9 })), null, 'unknown type');
  // Entry header cut short.
  assert.equal(P(Buffer.concat([header(), Buffer.alloc(4)])), null, 'truncated entry header');
  // Entry size runs past the end of the datagram.
  const overrun = Buffer.concat([header(), tmln(120)]);
  overrun.writeUInt32BE(100, 24);
  assert.equal(P(overrun), null, 'entry overruns');
  // A known entry whose value is not exactly its size.
  assert.equal(
    P(Buffer.concat([header(), entry(KEYS.tmln, Buffer.alloc(16))])),
    null,
    'short tmln'
  );
  assert.equal(P(Buffer.concat([header(), entry(KEYS.sess, Buffer.alloc(9))])), null, 'long sess');
});

test('ParseLinkMessage leaves the tempo unknown for a non-positive beat length', () => {
  const { _internal } = loadLink();
  const msg = _internal.ParseLinkMessage(
    Buffer.concat([header(), entry(KEYS.tmln, int64s(0, 0, 0))])
  );
  assert.equal(msg.Tempo, null);
});

// --- Receiver: peers, TTL expiry, BYEBYE, interest -------------------------------------

test('LinkReceiver keeps one entry per node and expires it after TTL plus padding', () => {
  const { rx } = loadOffline();
  rx.Ingest(alive({ node: '0000000000000001' }), '::ffff:10.0.0.5', 1000);
  rx.Ingest(alive({ node: '0000000000000001', bpm: 121 }), '10.0.0.5', 2000);
  let snap = rx.Snapshot(2000);
  assert.equal(snap.Peers.length, 1);
  assert.equal(snap.Peers[0].Address, '10.0.0.5');
  assert.equal(snap.Peers[0].FirstSeenAt, 1000);
  assert.equal(snap.Peers[0].ExpiresAt, 2000 + 5000 + 1000);
  snap = rx.Snapshot(7999);
  assert.equal(snap.Peers.length, 1, 'still within TTL + 1 s');
  snap = rx.Snapshot(8000);
  assert.equal(snap.Peers.length, 0, 'expired');
  rx.Stop();
});

test('LinkReceiver honours a peer TTL other than 5 s', () => {
  const { rx } = loadOffline();
  rx.Ingest(alive({ ttl: 1 }), '10.0.0.5', 0);
  assert.equal(rx.Snapshot(1999).Peers.length, 1);
  assert.equal(rx.Snapshot(2000).Peers.length, 0);
  rx.Stop();
});

test('LinkReceiver removes a peer on BYEBYE at once', () => {
  const { rx } = loadOffline();
  rx.Ingest(alive({ node: '0000000000000001' }), '10.0.0.5', 1000);
  rx.Ingest(alive({ node: '0000000000000002' }), '10.0.0.6', 1000);
  rx.Ingest(byebye('0000000000000001'), '10.0.0.5', 1100);
  const peers = rx.Snapshot(1100).Peers;
  assert.deepEqual(
    peers.map((p) => p.NodeId),
    ['0000000000000002']
  );
  rx.Stop();
});

test('LinkReceiver ignores garbage', () => {
  const { rx } = loadOffline();
  rx.Ingest(Buffer.from('hello'), '10.0.0.5', 1000);
  assert.equal(rx.Snapshot(1000).Peers.length, 0);
  rx.Stop();
});

test('LinkReceiver closes once no check has asked for the interest TTL', () => {
  const { rx } = loadOffline();
  rx.Observe();
  rx.Ingest(alive(), '10.0.0.5', Date.now());
  rx.Sweep(Date.now());
  assert.equal(rx.Snapshot().Peers.length, 1, 'kept while watched');
  rx.Sweep(Date.now() + 11 * 60 * 1000);
  assert.equal(rx.Snapshot().Peers.length, 0, 'forgotten after the interest TTL');
  assert.equal(rx.IsOpen(), false);
  rx.Stop();
});

// --- Evaluation ------------------------------------------------------------------------

function snapshotOf(rx, now) {
  return rx.Snapshot(now);
}

function evaluate(mod, rx, settings, now = 1000) {
  const { EvaluateLink, ParseOptions } = mod._internal;
  return EvaluateLink({
    Snapshot: { ...snapshotOf(rx, now), Ready: true, Error: null },
    Options: ParseOptions({ Settings: settings }),
    Now: now,
  });
}

test('EvaluateLink is online with peers in one session', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(
    alive({ node: '0000000000000001', session: '00000000000000aa', bpm: 120, playing: true }),
    '10.0.0.5',
    900
  );
  rx.Ingest(
    alive({ node: '0000000000000002', session: '00000000000000aa', bpm: 120, playing: true }),
    '10.0.0.6',
    950
  );
  const res = evaluate(mod, rx, { MinPeers: 2 });
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, undefined);
  assert.equal(res.PeerCount, 2);
  assert.equal(res.SessionCount, 1);
  assert.deepEqual(res.Tempos, [120]);
  assert.equal(res.Playing, true);
  assert.equal(res.LatencyMs, 50);
  rx.Stop();
});

test('EvaluateLink is offline with no peers, and while the listener starts', () => {
  const { mod, rx } = loadOffline();
  const res = evaluate(mod, rx, {});
  assert.equal(res.Success, false);
  assert.match(res.Error, /No Ableton Link peers heard/);
  const { EvaluateLink, ParseOptions } = mod._internal;
  const starting = EvaluateLink({
    Snapshot: { Ready: false, Error: null, Peers: [] },
    Options: ParseOptions({}),
    Now: 0,
  });
  assert.match(starting.Error, /starting…/);
  const failed = EvaluateLink({
    Snapshot: { Ready: false, Error: 'EADDRINUSE', Peers: [] },
    Options: ParseOptions({}),
    Now: 0,
  });
  assert.equal(failed.Success, false);
  assert.match(failed.Error, /^Failed to listen for Ableton Link: EADDRINUSE/);
  rx.Stop();
});

test('EvaluateLink applies the minimum peer count as Offline or Degraded', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(alive(), '10.0.0.5', 900);
  const off = evaluate(mod, rx, { MinPeers: 3 });
  assert.equal(off.Success, false);
  assert.equal(off.Error, '1 Link peer heard (minimum 3)');
  const deg = evaluate(mod, rx, { MinPeers: 3, BelowMinimum: 'degraded' });
  assert.equal(deg.Success, true);
  assert.equal(deg.Degraded, true);
  assert.equal(deg.DegradedReason, '1 Link peer heard (minimum 3)');
  rx.Stop();
});

test('EvaluateLink degrades on a session split unless told not to', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(alive({ node: '0000000000000001', session: '0000000000000001' }), '10.0.0.5', 900);
  rx.Ingest(alive({ node: '0000000000000002', session: '0000000000000002' }), '10.0.0.6', 900);
  const res = evaluate(mod, rx, {});
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, true);
  assert.equal(res.DegradedReason, 'Link session split (2 sessions)');
  assert.equal(res.SessionCount, 2);
  const ok = evaluate(mod, rx, { ExpectSingleSession: false });
  assert.equal(ok.Degraded, undefined);
  rx.Stop();
});

test('EvaluateLink checks the tempo against the tolerance', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(alive({ bpm: 120.4 }), '10.0.0.5', 900);
  const within = evaluate(mod, rx, { CheckTempo: true, ExpectedTempo: 120, TempoTolerance: 0.5 });
  assert.equal(within.Degraded, undefined);
  const outside = evaluate(mod, rx, { CheckTempo: true, ExpectedTempo: 128, TempoTolerance: 1 });
  assert.equal(outside.Degraded, true);
  assert.equal(outside.DegradedReason, 'Tempo 120.4 BPM (expected 128 ± 1)');
  const unchecked = evaluate(mod, rx, { ExpectedTempo: 128 });
  assert.equal(unchecked.Degraded, undefined);
  rx.Stop();
});

test('EvaluateLink takes the newest start/stop state in a session', () => {
  const { mod, rx } = loadOffline();
  const session = '00000000000000aa';
  rx.Ingest(
    alive({ node: '0000000000000001', session, playing: false, ststTimestamp: 500 }),
    '10.0.0.5',
    900
  );
  rx.Ingest(
    alive({ node: '0000000000000002', session, playing: true, ststTimestamp: 900 }),
    '10.0.0.6',
    900
  );
  const playing = evaluate(mod, rx, { CheckPlaying: true, ExpectedPlaying: 'playing' });
  assert.equal(playing.Playing, true);
  assert.equal(playing.Degraded, undefined);
  const stopped = evaluate(mod, rx, { CheckPlaying: true, ExpectedPlaying: 'stopped' });
  assert.equal(stopped.Degraded, true);
  assert.equal(stopped.DegradedReason, 'Transport playing (expected stopped)');
  rx.Stop();
});

test('EvaluateLink treats a never-set or missing start/stop state as unknown', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(alive({ node: '0000000000000001', playing: false, ststTimestamp: 0 }), '10.0.0.5', 900);
  let res = evaluate(mod, rx, { CheckPlaying: true });
  assert.equal(res.Playing, null);
  assert.equal(res.DegradedReason, 'Transport state unknown (expected playing)');
  rx.Stop();
  rx.Ingest(alive({ node: '0000000000000001', playing: null }), '10.0.0.5', 900);
  res = evaluate(mod, rx, { CheckPlaying: true, ExpectedPlaying: 'stopped' });
  assert.equal(res.Playing, null);
  assert.equal(res.DegradedReason, 'Transport state unknown (expected stopped)');
  rx.Stop();
});

test('EvaluateLink counts only the configured peer addresses', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(alive({ node: '0000000000000001' }), '10.0.0.5', 900);
  rx.Ingest(alive({ node: '0000000000000002' }), '10.0.0.6', 900);
  const one = evaluate(mod, rx, { PeerAddresses: ['10.0.0.6'] });
  assert.equal(one.Success, true);
  assert.equal(one.PeerCount, 1);
  assert.equal(one.TotalPeerCount, 2);
  const none = evaluate(mod, rx, { PeerAddresses: ['10.0.0.9'] });
  assert.equal(none.Success, false);
  assert.equal(none.Error, 'No Ableton Link peers heard from 10.0.0.9 (2 other peers heard)');
  rx.Stop();
});

test('EvaluateLink joins several degraded reasons', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(
    alive({ node: '0000000000000001', session: '0000000000000001', bpm: 100 }),
    '10.0.0.5',
    900
  );
  rx.Ingest(
    alive({ node: '0000000000000002', session: '0000000000000002', bpm: 140 }),
    '10.0.0.6',
    900
  );
  const res = evaluate(mod, rx, { CheckTempo: true, ExpectedTempo: 140, TempoTolerance: 0 });
  assert.equal(
    res.DegradedReason,
    'Link session split (2 sessions); Tempo 100 BPM (expected 140 ± 0)'
  );
  rx.Stop();
});

test('ParseOptions clamps and defaults', () => {
  const { _internal } = loadLink();
  const o = _internal.ParseOptions({
    Settings: {
      MinPeers: 0,
      ExpectedTempo: 5000,
      TempoTolerance: -1,
      PeerAddresses: [' ::ffff:10.0.0.5 ', '10.0.0.5', ''],
    },
  });
  assert.equal(o.MinPeers, 1);
  assert.equal(o.ExpectedTempo, 999);
  assert.equal(o.TempoTolerance, 0);
  assert.deepEqual(o.PeerAddresses, ['10.0.0.5']);
  assert.equal(o.ExpectSingleSession, true);
  assert.equal(o.BelowMinimum, 'offline');
  assert.equal(o.ExpectedPlaying, true);
});

// --- Debug ----------------------------------------------------------------------------

test('Debug escapes every network-derived value', () => {
  const { mod, rx } = loadOffline();
  rx.Ingest(alive(), '10.0.0.5', 900);
  const res = evaluate(mod, rx, {});
  res.Sessions[0].SessionId = '<script>x</script>';
  res.Sessions[0].Peers[0].Address = '<img onerror=1>';
  res.Sessions[0].Peers[0].NodeId = '"&\'';
  const html = mod.Debug(res, { Settings: { PeerAddresses: ['<b>'] } });
  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;&amp;&#39;/);
  const empty = mod.Debug({ Success: false, Error: '<x>' }, {});
  assert.doesNotMatch(empty, /<x>/);
  rx.Stop();
});

test('Method module shape matches the registry contract', () => {
  const mod = loadLink();
  assert.equal(mod.ID, 'ableton-link');
  assert.equal(mod.UsesAddress, false);
  assert.equal(mod.SupportsLatencyThreshold, false);
  assert.equal(typeof mod.Run, 'function');
  assert.equal(typeof mod.Debug, 'function');
  assert.ok(Array.isArray(mod.Settings));
  for (const field of mod.Settings) {
    if (field.Note) assert.match(field.Note, /\.$/, `${field.Key} note ends with a full stop`);
  }
});
