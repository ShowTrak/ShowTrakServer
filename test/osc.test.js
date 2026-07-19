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

// A tag whose membership scope is "group 1", so it expands to clients a + b.
const FOH_SCOPE = { Workspace: false, Groups: [1], Clients: [] };

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
        // Slug is the encouraged addressing key; UUID resolves only via Get above.
        GetBySlug: async (slug) =>
          slug === 'stage-left' ? { UUID: 'good', Slug: 'stage-left' } : null,
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
        Get: async (id) =>
          Number(id) === 1 ? [null, { GroupID: 1, Title: 'Main' }] : [null, null],
        // Groups are addressed by slug; a numeric GroupID resolves via Get above.
        GetBySlug: async (slug) =>
          slug === 'main' ? { GroupID: 1, Title: 'Main', Slug: 'main' } : null,
      },
    },
    '../DummyClientManager': {
      Manager: {
        Heartbeat: async () => [null, true],
      },
    },
    '../TagManager': {
      Manager: {
        Get: async (id) =>
          Number(id) === 5 ? [null, { TagID: 5, Slug: 'foh', Scope: FOH_SCOPE }] : [null, null],
        // Tags are addressed by slug; a numeric TagID resolves via Get above.
        GetBySlug: async (slug) =>
          slug === 'foh' ? { TagID: 5, Slug: 'foh', Scope: FOH_SCOPE } : null,
      },
    },
    '../ScriptWhitelistManager': {
      // Real predicate: Workspace = all, else by explicit UUID or matching group.
      Manager: {
        IsClientAllowed: (scope, client) => {
          if (!scope || scope.Workspace) return true;
          if (!client || !client.UUID) return false;
          if ((scope.Clients || []).includes(client.UUID)) return true;
          if (client.GroupID != null && (scope.Groups || []).includes(Number(client.GroupID)))
            return true;
          return false;
        },
      },
    },
    ...overrides,
  };

  const { OSC } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'OSC', 'index.js'),
    mocks
  );
  return { OSC, handlers, broadcastEvents };
}

test('OSC registers the built-in routes', () => {
  const { OSC } = loadOSC();
  const routes = OSC.GetRoutes().map((r) => r.Path);
  assert.ok(routes.includes('/API/Shutdown'));
  assert.ok(routes.includes('/API/Shutdown/Force'));
  // Clients and groups are addressed by slug (UUID/GroupID still resolve as a
  // fallback, but the route param leads with the slug).
  assert.ok(routes.includes('/API/Client/:Slug/WakeOnLAN'));
  assert.ok(routes.includes('/API/Client/:Slug/RunScript/:ScriptID'));
  assert.ok(routes.includes('/API/Group/:Slug/WakeOnLAN'));
  assert.ok(routes.includes('/API/Group/:Slug/RunScript/:ScriptID'));
  // Tags mirror the group actions, addressed by slug (TagID resolves as a fallback).
  assert.ok(routes.includes('/API/Tag/:Slug/WakeOnLAN'));
  assert.ok(routes.includes('/API/Tag/:Slug/RunScript/:ScriptID'));
  assert.ok(routes.includes('/API/All/WakeOnLAN'));
  assert.ok(routes.includes('/API/All/RunScript/:ScriptID'));
});

// Selection was deprecated and removed: the OSC module no longer keeps a
// selection set, so no route may reintroduce one. The HTTP surface is generated
// from this same table (Server/index.ts), so this covers both protocols.
test('OSC exposes no selection routes', () => {
  const { OSC } = loadOSC();
  const routes = OSC.GetRoutes().map((r) => r.Path);
  const selectionRoutes = routes.filter((p) => /\/(?:De)?Select$|^\/API\/Selection\//i.test(p));
  assert.deepEqual(selectionRoutes, [], 'selection routes were deprecated and must stay removed');
});

test('OSC force shutdown route emits ShutdownForce broadcast', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Shutdown/Force']);
  assert.ok(broadcastEvents.some(([event]) => event === 'ShutdownForce'));
});

test('OSC dispatches a client route with a valid UUID', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/good/WakeOnLAN']);
  assert.ok(
    broadcastEvents.some(
      ([event, action, uuids]) =>
        event === 'OSCBulkAction' && action === 'WOL' && uuids[0] === 'good'
    )
  );
});

test('OSC reports an error notification for an invalid UUID', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/bad/WakeOnLAN']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
});

test('OSC dispatches a client route addressed by slug', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  // "stage-left" is not a UUID (Get fails); it resolves via GetBySlug.
  await handlers.message(['/API/Client/stage-left/WakeOnLAN']);
  assert.ok(
    broadcastEvents.some(
      ([event, action, uuids]) =>
        event === 'OSCBulkAction' && action === 'WOL' && uuids[0] === 'good'
    )
  );
});

test('OSC dispatches a tag route addressed by slug', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  // "foh" resolves via the tag slug; its scope (group 1) expands to clients a + b.
  await handlers.message(['/API/Tag/foh/WakeOnLAN']);
  const bulk = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'WOL'
  );
  assert.ok(bulk, 'expected an OSCBulkAction WOL for the tag');
  assert.deepEqual(bulk[2], ['a', 'b']);
});

test('OSC reports an error notification for an invalid tag', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Tag/nope/WakeOnLAN']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
});

test('OSC Tag/RunScript validates script and tag membership', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Tag/foh/RunScript/script1']);
  const bulk = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'ExecuteScript'
  );
  assert.ok(bulk, 'expected an ExecuteScript bulk action');
  assert.deepEqual(bulk[2], ['a', 'b']);
  assert.equal(bulk[3], 'script1');
});

test('OSC dispatches a group route addressed by slug', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  // "main" is non-numeric, so it resolves via the group slug, not GroupID.
  await handlers.message(['/API/Group/main/WakeOnLAN']);
  assert.ok(
    broadcastEvents.some(([event, action]) => event === 'OSCBulkAction' && action === 'WOL')
  );
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

test('OSC Group route broadcasts only matching group clients', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  // Numeric "1" resolves as a GroupID (the transitional fallback) and expands to
  // just that group's members, not the whole workspace.
  await handlers.message(['/API/Group/1/WakeOnLAN']);
  const wol = broadcastEvents.find(
    ([event, action]) => event === 'OSCBulkAction' && action === 'WOL'
  );
  assert.ok(wol);
  assert.deepEqual(wol[2], ['a', 'b']);
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
  await handlers.message(['/API/Group/999/WakeOnLAN']);
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
