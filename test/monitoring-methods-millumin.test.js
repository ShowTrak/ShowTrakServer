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

// A fake dgram whose sockets never touch the network but let a test inject
// inbound datagrams via socket.emit('message', ...).
function fakeDgram() {
  const sockets = [];
  return {
    _sockets: sockets,
    createSocket() {
      const { EventEmitter } = require('node:events');
      const socket = new EventEmitter();
      socket.bind = () => {
        // Simulate an async successful bind.
        setImmediate(() => socket.emit('listening'));
      };
      socket.close = () => {};
      socket.unref = () => {};
      socket.addMembership = () => {};
      sockets.push(socket);
      return socket;
    },
  };
}

function loadMillumin(dgramMock) {
  return loadWithMocks(methodPath('_millumin-shared.js'), {
    '../Logger': loggerStub(),
    dgram: dgramMock || fakeDgram(),
  });
}

// --- OSC address parsing -----------------------------------------------------

// Encode a null-terminated, 4-byte-padded OSC string.
function oscString(str) {
  const body = Buffer.from(String(str), 'utf8');
  const withNull = Buffer.concat([body, Buffer.from([0])]);
  const pad = (4 - (withNull.length % 4)) % 4;
  return pad ? Buffer.concat([withNull, Buffer.alloc(pad)]) : withNull;
}

// Minimal OSC message: address + ",f" typetag + one float arg.
function oscMessage(address) {
  const arg = Buffer.alloc(4);
  return Buffer.concat([oscString(address), oscString(',f'), arg]);
}

// OSC #bundle wrapping the given element messages.
function oscBundle(addresses) {
  const parts = [oscString('#bundle'), Buffer.alloc(8)];
  for (const addr of addresses) {
    const el = oscMessage(addr);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(el.length, 0);
    parts.push(size, el);
  }
  return Buffer.concat(parts);
}

test('ParseOscAddresses reads a plain message address', () => {
  const { ParseOscAddresses } = loadMillumin();
  assert.deepEqual(ParseOscAddresses(oscMessage('/millumin/layer:one/opacity')), [
    '/millumin/layer:one/opacity',
  ]);
});

test('ParseOscAddresses reads all addresses inside a bundle', () => {
  const { ParseOscAddresses } = loadMillumin();
  const addrs = ParseOscAddresses(
    oscBundle(['/millumin/board/launchedColumn', '/millumin/selectedLayer/media/time'])
  );
  assert.deepEqual(addrs, ['/millumin/board/launchedColumn', '/millumin/selectedLayer/media/time']);
});

test('ParseOscAddresses ignores non-address and runt packets', () => {
  const { ParseOscAddresses } = loadMillumin();
  assert.deepEqual(ParseOscAddresses(Buffer.alloc(2)), []);
  assert.deepEqual(ParseOscAddresses(oscMessage('not-an-osc-address')), []);
});

// --- filter matching ---------------------------------------------------------

test('MatchesFilter: empty filter matches anything, prefix is case-insensitive', () => {
  const { MatchesFilter } = loadMillumin();
  assert.equal(MatchesFilter('/millumin/x', ''), true);
  assert.equal(MatchesFilter('/MILLUMIN/x', '/millumin'), true);
  assert.equal(MatchesFilter('/other/x', '/millumin'), false);
});

// --- evaluation logic (pure) -------------------------------------------------

function source(overrides = {}) {
  const recent = overrides.Recent || [
    { OscAddress: '/millumin/board/launchedColumn', ReceivedAt: 1500 },
  ];
  return {
    Address: '10.0.0.5',
    LastSeenAt: 1500,
    LastOscAddress: recent[recent.length - 1].OscAddress,
    Count: recent.length,
    ...overrides,
    Recent: recent,
  };
}

function baseParams(overrides = {}) {
  return {
    Snapshot: { Ready: true, Error: null, Sources: [] },
    Address: '10.0.0.5',
    ListenPort: 5001,
    AddressFilter: '',
    GracePeriodMs: 8000,
    Now: 2000,
    ...overrides,
  };
}

test('EvaluateMillumin is online when matching OSC from the target is within grace', () => {
  const { EvaluateMillumin } = loadMillumin();
  const res = EvaluateMillumin(
    baseParams({ Snapshot: { Ready: true, Error: null, Sources: [source()] } })
  );
  assert.equal(res.Success, true);
  assert.equal(res.Matched, true);
  assert.equal(res.LatencyMs, 500); // Now - ReceivedAt
  assert.equal(res.LastOscAddress, '/millumin/board/launchedColumn');
});

test('EvaluateMillumin is offline when no OSC has been seen', () => {
  const { EvaluateMillumin } = loadMillumin();
  const res = EvaluateMillumin(baseParams());
  assert.equal(res.Success, false);
  assert.equal(res.Degraded, undefined);
  assert.match(res.Error, /No Millumin OSC from 10\.0\.0\.5/);
});

test('EvaluateMillumin is offline when the last OSC is older than the grace window', () => {
  const { EvaluateMillumin } = loadMillumin();
  const stale = source({ Recent: [{ OscAddress: '/millumin/x', ReceivedAt: 1000 }] });
  const res = EvaluateMillumin(
    baseParams({ Now: 20000, Snapshot: { Ready: true, Error: null, Sources: [stale] } })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /No Millumin OSC/);
});

test('EvaluateMillumin is offline (with a hint) when OSC arrives from a different IP', () => {
  const { EvaluateMillumin } = loadMillumin();
  const other = source({ Address: '10.0.0.99' });
  const res = EvaluateMillumin(
    baseParams({ Snapshot: { Ready: true, Error: null, Sources: [other] } })
  );
  // Configured machine is not confirmed sending -> Offline; the other source is
  // surfaced in the Error as a diagnostic hint. Degraded is only honoured on
  // Success:true results, so it must not be set here.
  assert.equal(res.Success, false);
  assert.equal(res.Degraded, undefined);
  assert.match(res.Error, /from 10\.0\.0\.99, not 10\.0\.0\.5/);
});

test('EvaluateMillumin applies the address filter (non-matching -> offline)', () => {
  const { EvaluateMillumin } = loadMillumin();
  const nonMatching = source({ Recent: [{ OscAddress: '/other/thing', ReceivedAt: 1500 }] });
  const res = EvaluateMillumin(
    baseParams({
      AddressFilter: '/millumin',
      Snapshot: { Ready: true, Error: null, Sources: [nonMatching] },
    })
  );
  assert.equal(res.Success, false);
  assert.match(res.Error, /matching "\/millumin"/);
});

test('EvaluateMillumin is online when a filtered address matches', () => {
  const { EvaluateMillumin } = loadMillumin();
  const matching = source({
    Recent: [{ OscAddress: '/millumin/layer:a/opacity', ReceivedAt: 1600 }],
  });
  const res = EvaluateMillumin(
    baseParams({
      AddressFilter: '/millumin',
      Snapshot: { Ready: true, Error: null, Sources: [matching] },
    })
  );
  assert.equal(res.Success, true);
  assert.equal(res.Matched, true);
});

test('EvaluateMillumin surfaces a listener error and a not-ready state', () => {
  const { EvaluateMillumin } = loadMillumin();
  const err = EvaluateMillumin(
    baseParams({ Snapshot: { Ready: false, Error: 'EADDRINUSE', Sources: [] } })
  );
  assert.equal(err.Success, false);
  assert.match(err.Error, /EADDRINUSE/);

  const starting = EvaluateMillumin(
    baseParams({ Snapshot: { Ready: false, Error: null, Sources: [] } })
  );
  assert.equal(starting.Success, false);
  assert.match(starting.Error, /starting/);
});

// --- Run() / config validation ----------------------------------------------

test('RunMillumin rejects a missing address and out-of-range port', () => {
  const { RunMillumin } = loadMillumin();
  assert.match(RunMillumin({ Address: '', Settings: {} }).Error, /No address configured/);
  assert.match(
    RunMillumin({ Address: '1.2.3.4', Settings: { ListenPort: 70000 } }).Error,
    /Invalid listen port/
  );
});

// --- end-to-end receiver with a fake dgram ----------------------------------

test('MilluminReceiver ingests an injected OSC datagram and Run() reads it online', async () => {
  const dg = fakeDgram();
  const mod = loadMillumin(dg);
  const { MilluminReceiver, RunMillumin } = mod;

  MilluminReceiver.Observe(5001);
  // Let the fake socket finish "binding".
  await new Promise((r) => setImmediate(r));

  const socket = dg._sockets[0];
  assert.ok(socket, 'a socket was created');
  socket.emit('message', oscMessage('/millumin/board/launchedColumn'), { address: '192.168.1.50' });

  const res = RunMillumin({ Address: '192.168.1.50', Settings: { ListenPort: 5001 } });
  assert.equal(res.Success, true);
  assert.equal(res.Matched, true);
  assert.equal(res.LastOscAddress, '/millumin/board/launchedColumn');

  MilluminReceiver.Stop();
});
