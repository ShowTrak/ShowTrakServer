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
        GetAll: async () => [
          null,
          [
            { UUID: 'a', GroupID: 1 },
            { UUID: 'b', GroupID: 1 },
            { UUID: 'c', GroupID: 2 },
          ],
        ],
      },
    },
    '../Broadcast': { Manager: { emit: (...args) => broadcastEvents.push(args) } },
    '../ScriptManager': {
      Manager: { Get: async (id) => (id === 'script1' ? { ID: 'script1' } : null) },
    },
    '../GroupManager': {
      Manager: {
        Get: async (id) => (Number(id) === 1 ? [null, { GroupID: 1, Title: 'Main' }] : [null, null]),
      },
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
  assert.ok(routes.includes('/API/Shutdown'));
  assert.ok(routes.includes('/API/Shutdown/Force'));
  assert.ok(routes.includes('/API/Client/:UUID/Select'));
  assert.ok(routes.includes('/API/Client/:UUID/RunScript/:ScriptID'));
  assert.ok(routes.includes('/API/Group/:GroupID/Select'));
  assert.ok(routes.includes('/API/Group/:GroupID/RunScript/:ScriptID'));
  assert.ok(routes.includes('/API/All/Select'));
  assert.ok(routes.includes('/API/All/Deselect'));
  assert.ok(routes.includes('/API/Selection/WakeOnLAN'));
  assert.ok(routes.includes('/API/Selection/RunScript/:ScriptID'));
  assert.ok(routes.includes('/API/All/WakeOnLAN'));
});

test('OSC force shutdown route emits ShutdownForce broadcast', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Shutdown/Force']);
  assert.ok(broadcastEvents.some(([event]) => event === 'ShutdownForce'));
});

test('OSC dispatches a client select route with a valid UUID', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/good/Select']);
  assert.ok(
    broadcastEvents.some(
      ([event, action, uuids]) =>
        event === 'OSCBulkAction' && action === 'Select' && uuids[0] === 'good'
    )
  );
});

test('OSC reports an error notification for an invalid UUID', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/bad/Select']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
});

test('OSC RunScript route validates both UUID and script', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/good/RunScript/script1']);
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
  await handlers.message(['/API/Client/good/RunScript/missing']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
});

test('OSC All/WakeOnLAN broadcasts to every client', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/All/WakeOnLAN']);
  const wol = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'WOL'
  );
  assert.ok(wol);
  assert.deepEqual(wol[2], ['a', 'b', 'c']);
});

test('OSC All/Select broadcasts to every client', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/All/Select']);
  const select = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'Select'
  );
  assert.ok(select);
  assert.deepEqual(select[2], ['a', 'b', 'c']);
});

test('OSC All/Deselect clears selected clients', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/All/Select']);
  await handlers.message(['/API/All/Deselect']);
  const deselect = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'Deselect'
  );
  assert.ok(deselect);
  assert.deepEqual(deselect[2], ['a', 'b', 'c']);
});

test('OSC Selection/WakeOnLAN targets currently selected clients', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/good/Select']);
  await handlers.message(['/API/Selection/WakeOnLAN']);
  const wol = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'WOL'
  );
  assert.ok(wol);
  assert.deepEqual(wol[2], ['good']);
});

test('OSC Selection/RunScript targets currently selected clients', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/good/Select']);
  await handlers.message(['/API/Selection/RunScript/script1']);
  const run = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'ExecuteScript'
  );
  assert.ok(run);
  assert.deepEqual(run[2], ['good']);
  assert.equal(run[3], 'script1');
});

test('OSC Group/Select broadcasts only matching group clients', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Group/1/Select']);
  const select = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'Select'
  );
  assert.ok(select);
  assert.deepEqual(select[2], ['a', 'b']);
});

test('OSC Group/RunScript validates script and group', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Group/1/RunScript/script1']);
  assert.ok(
    broadcastEvents.some(
      ([event, action, uuids, scriptId]) =>
        event === 'OSCBulkAction' &&
        action === 'ExecuteScript' &&
        scriptId === 'script1' &&
        Array.isArray(uuids) &&
        uuids.length === 2
    )
  );

  broadcastEvents.length = 0;
  await handlers.message(['/API/Group/999/Select']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
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
