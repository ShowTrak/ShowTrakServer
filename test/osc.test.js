const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const noopLogger = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    debug: () => {},
  }),
};

function loadOSC(overrides = {}) {
  const handlers = {};
  const oscMock = {
    Server: class {
      constructor(_port, _host, cb) {
        if (typeof cb === 'function') cb();
      }
      on(event, handler) {
        handlers[event] = handler;
      }
    },
  };

  const broadcastEvents = [];
  const mocks = {
    'node-osc': oscMock,
    '../Logger': noopLogger,
    '../ClientManager': {
      Manager: {
        Get: async (uuid) => (uuid === 'good' ? [null, { UUID: 'good' }] : ['not found', null]),
        GetAll: async () => [null, [{ UUID: 'a' }, { UUID: 'b' }]],
      },
    },
    '../Broadcast': { Manager: { emit: (...args) => broadcastEvents.push(args) } },
    '../ScriptManager': {
      Manager: { Get: async (id) => (id === 'script1' ? { ID: 'script1' } : null) },
    },
    '../DummyClientManager': {
      Manager: {
        Heartbeat: async () => [null, true],
      },
    },
    ...overrides,
  };

  const { OSC } = loadWithMocks(
    path.join(__dirname, '..', 'src', 'Modules', 'OSC', 'index.js'),
    mocks
  );
  return { OSC, handlers, broadcastEvents };
}

test('OSC registers the built-in routes', () => {
  const { OSC } = loadOSC();
  const routes = OSC.GetRoutes().map((r) => r.Path);
  assert.ok(routes.includes('/ShowTrak/Shutdown'));
  assert.ok(routes.includes('/ShowTrak/Shutdown/Force'));
  assert.ok(routes.includes('/ShowTrak/Client/:UUID/Select'));
  assert.ok(routes.includes('/ShowTrak/Client/:UUID/RunScript/:ScriptID'));
  assert.ok(routes.includes('/ShowTrak/All/WakeOnLAN'));
});

test('OSC force shutdown route emits ShutdownForce broadcast', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/ShowTrak/Shutdown/Force']);
  assert.ok(broadcastEvents.some(([event]) => event === 'ShutdownForce'));
});

test('OSC dispatches a client select route with a valid UUID', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/ShowTrak/Client/good/Select']);
  assert.ok(
    broadcastEvents.some(
      ([event, action, uuids]) =>
        event === 'OSCBulkAction' && action === 'Select' && uuids[0] === 'good'
    )
  );
});

test('OSC reports an error notification for an invalid UUID', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/ShowTrak/Client/bad/Select']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
});

test('OSC RunScript route validates both UUID and script', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/ShowTrak/Client/good/RunScript/script1']);
  assert.ok(
    broadcastEvents.some(
      ([event, action, uuids, scriptId]) =>
        event === 'OSCBulkAction' &&
        action === 'ExecuteScript' &&
        uuids[0] === 'good' &&
        scriptId === 'script1'
    )
  );

  broadcastEvents.length = 0;
  await handlers.message(['/ShowTrak/Client/good/RunScript/missing']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
});

test('OSC All/WakeOnLAN broadcasts to every client', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/ShowTrak/All/WakeOnLAN']);
  const wol = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'WOL'
  );
  assert.ok(wol);
  assert.deepEqual(wol[2], ['a', 'b']);
});

test('OSC ignores routes that do not match any registered path', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/Unknown/Route']);
  assert.ok(
    !broadcastEvents.some(
      ([event]) => event === 'OSCBulkAction' || event === 'Notify' || event === 'Shutdown'
    )
  );
});

test('OSC.CreateRoute registers custom routes', () => {
  const { OSC } = loadOSC();
  const before = OSC.GetRoutes().length;
  OSC.CreateRoute('/Custom/:Value', async () => true, 'Custom route');
  assert.equal(OSC.GetRoutes().length, before + 1);
});
