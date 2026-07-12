const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

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

function modulePath() {
  return path.join(__dirname, '..', 'dist', 'Modules', 'NetworkInterfaces', 'index.js');
}

// Load the module with a controllable fake `os` so we can drive interface churn
// deterministically instead of depending on the host's real NICs.
function loadWithFakeOs(initial) {
  const state = { ifaces: initial };
  const os = { networkInterfaces: () => state.ifaces };
  const mod = loadWithMocks(modulePath(), { os, '../Logger': loggerStub() });
  return { mod, state };
}

function iface(name, address, cidr, internal = false) {
  return { family: 'IPv4', address, netmask: '255.255.255.0', cidr, mac: '00:00:00:00:00:00', internal };
}

// --- pure diff ---------------------------------------------------------------

test('ComputeChange reports added and removed interfaces by address', () => {
  const { mod } = loadWithFakeOs({});
  const prev = [
    { Name: 'en0', Address: '10.0.0.5', CIDR: '10.0.0.5/24', Netmask: '', MAC: null, Internal: false },
    { Name: 'en1', Address: '10.0.1.5', CIDR: '10.0.1.5/24', Netmask: '', MAC: null, Internal: false },
  ];
  const current = [
    { Name: 'en0', Address: '10.0.0.5', CIDR: '10.0.0.5/24', Netmask: '', MAC: null, Internal: false },
    { Name: 'en2', Address: '10.0.2.9', CIDR: '10.0.2.9/24', Netmask: '', MAC: null, Internal: false },
  ];
  const { Added, Removed } = mod.ComputeChange(prev, current);
  assert.deepEqual(Added.map((i) => i.Address), ['10.0.2.9']);
  assert.deepEqual(Removed.map((i) => i.Address), ['10.0.1.5']);
});

// --- accessors ---------------------------------------------------------------

test('List excludes internal interfaces and Addresses maps to strings', () => {
  const { mod } = loadWithFakeOs({
    lo0: [iface('lo0', '127.0.0.1', '127.0.0.1/8', true)],
    en0: [iface('en0', '10.0.0.5', '10.0.0.5/24')],
    en1: [iface('en1', '192.168.5.9', '192.168.5.9/24')],
  });
  const list = mod.Manager.List(false);
  assert.deepEqual(list.map((i) => i.Address).sort(), ['10.0.0.5', '192.168.5.9']);
  assert.equal(list.every((i) => !i.Internal), true);
  assert.deepEqual(mod.Manager.Addresses().sort(), ['10.0.0.5', '192.168.5.9']);
  // Internal is available on request.
  assert.equal(mod.Manager.List(true).some((i) => i.Address === '127.0.0.1'), true);
});

// --- change notification -----------------------------------------------------

test('Poll emits a change with added/removed once the interface set changes', () => {
  const { mod, state } = loadWithFakeOs({ en0: [iface('en0', '10.0.0.5', '10.0.0.5/24')] });
  mod.Manager.Init({ PollIntervalMs: 60000 }); // establishes baseline, no emit
  const events = [];
  const unsub = mod.Manager.OnChange((c) => events.push(c));

  // No change yet -> no event.
  mod._internal.Poll();
  assert.equal(events.length, 0);

  // A new NIC appears.
  state.ifaces = {
    en0: [iface('en0', '10.0.0.5', '10.0.0.5/24')],
    en1: [iface('en1', '10.0.9.9', '10.0.9.9/24')],
  };
  mod._internal.Poll();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].Added.map((i) => i.Address), ['10.0.9.9']);
  assert.deepEqual(events[0].Removed.map((i) => i.Address), []);
  assert.deepEqual(events[0].Current.map((i) => i.Address).sort(), ['10.0.0.5', '10.0.9.9']);

  // The original NIC goes away.
  state.ifaces = { en1: [iface('en1', '10.0.9.9', '10.0.9.9/24')] };
  mod._internal.Poll();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].Removed.map((i) => i.Address), ['10.0.0.5']);

  // Unsubscribe stops delivery.
  unsub();
  state.ifaces = {};
  mod._internal.Poll();
  assert.equal(events.length, 2);

  mod.Manager.Stop();
});

test('Init is idempotent and Stop halts polling', () => {
  const { mod } = loadWithFakeOs({ en0: [iface('en0', '10.0.0.5', '10.0.0.5/24')] });
  mod.Manager.Init({ PollIntervalMs: 60000 });
  mod.Manager.Init({ PollIntervalMs: 60000 }); // must not throw or double-start
  const unsub = mod.Manager.OnChange(() => {});
  unsub();
  mod.Manager.Stop();
  assert.equal(mod._internal.Emitter.listenerCount('change'), 0);
});
