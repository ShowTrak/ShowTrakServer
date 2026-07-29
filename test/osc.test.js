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

// `WithSocket` mirrors node-osc exposing its dgram socket as `_sock`; pass false
// to model a build where that internal is gone and the Server is the only place
// a socket error can surface.
function loadOSC(overrides = {}, { WithSocket = true } = {}) {
  const handlers = {};
  const socketHandlers = {};
  const oscMock = {
    Server: class {
      constructor(_port, _host, cb) {
        if (WithSocket) {
          this._sock = {
            on(event, handler) {
              socketHandlers[event] = handler;
            },
          };
        }
        if (typeof cb === 'function') cb();
      }
      on(event, handler) {
        handlers[event] = handler;
      }
      close() {}
    },
  };

  const broadcastEvents = [];
  // Integrated-event routes delegate to ControlService (the SDK's command
  // surface) rather than the renderer OSCBulkAction path, so record the calls.
  const controlCalls = [];
  const mocks = {
    '../ControlService': {
      ControlService: {
        TriggerEventOnAll: async (eventSlug) => {
          controlCalls.push(['all', eventSlug]);
          return { ok: true, detail: `Event "${eventSlug}" queued` };
        },
        TriggerEventOnClient: async (slug, eventSlug) => {
          controlCalls.push(['client', slug, eventSlug]);
          if (slug === 'bad') return { ok: false, detail: `Invalid Client "${slug}"` };
          return { ok: true, detail: `Event "${eventSlug}" queued` };
        },
        TriggerEventOnGroup: async (slug, eventSlug) => {
          controlCalls.push(['group', slug, eventSlug]);
          return { ok: true, detail: `Event "${eventSlug}" queued` };
        },
        TriggerEventOnTag: async (slug, eventSlug) => {
          controlCalls.push(['tag', slug, eventSlug]);
          return { ok: true, detail: `Event "${eventSlug}" queued` };
        },
      },
    },
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
        // The whole list, so a tag that absorbs other tags can be expanded.
        GetAllViews: async () => [{ TagID: 5, Slug: 'foh', Scope: FOH_SCOPE }],
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
  return { OSC, handlers, socketHandlers, broadcastEvents, controlCalls };
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
  // Integrated events mirror the script actions across all four scopes.
  assert.ok(routes.includes('/API/Client/:Slug/TriggerEvent/:EventID'));
  assert.ok(routes.includes('/API/Group/:Slug/TriggerEvent/:EventID'));
  assert.ok(routes.includes('/API/Tag/:Slug/TriggerEvent/:EventID'));
  assert.ok(routes.includes('/API/All/TriggerEvent/:EventID'));
  assert.ok(routes.includes('/API/Dummy/:Slug/Heartbeat'));
});

test('OSC TriggerEvent routes delegate to ControlService for every scope', async () => {
  const { handlers, controlCalls } = loadOSC();
  await handlers.message(['/API/Client/stage-left/TriggerEvent/go']);
  await handlers.message(['/API/Group/main/TriggerEvent/go']);
  await handlers.message(['/API/Tag/foh/TriggerEvent/go']);
  await handlers.message(['/API/All/TriggerEvent/go']);
  assert.deepEqual(controlCalls, [
    ['client', 'stage-left', 'go'],
    ['group', 'main', 'go'],
    ['tag', 'foh', 'go'],
    ['all', 'go'],
  ]);
});

test('OSC TriggerEvent surfaces a ControlService failure as an error notification', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Client/bad/TriggerEvent/go']);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'error'));
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

// node-osc reports an undecodable datagram as an 'error' on the Server, always
// carrying the sender's remote-info. It must stay a warning: one malformed UDP
// packet from anywhere on the network cannot be allowed to take OSC down.
test('OSC absorbs a malformed inbound packet without tearing the server down', () => {
  const { broadcastEvents, handlers } = loadOSC();
  handlers.error(new Error("can't decode incoming message"), { address: '10.0.0.9', port: 5000 });
  assert.deepEqual(
    broadcastEvents.filter(([event]) => event === 'Notify'),
    []
  );
});

// Since node-osc 11 the Server re-emits underlying socket errors too, with no
// remote-info. The `_sock` listener already reports those, so the Server handler
// must not also mislabel them as a bad packet — one socket error, one report.
test('OSC reports a socket error once when the dgram socket is reachable', () => {
  const { broadcastEvents, handlers, socketHandlers } = loadOSC();
  const Err = Object.assign(new Error('bind EADDRINUSE 0.0.0.0:57121'), { code: 'EADDRINUSE' });
  socketHandlers.error(Err);
  handlers.error(Err);
  assert.equal(
    broadcastEvents.filter(([event, , level]) => event === 'Notify' && level === 'error').length,
    1
  );
});

// ...and if a future node-osc drops `_sock`, the Server handler is the only path
// left, so it has to take over rather than swallow the error silently.
test('OSC falls back to the Server error event when the dgram socket is hidden', () => {
  const { broadcastEvents, handlers } = loadOSC({}, { WithSocket: false });
  handlers.error(Object.assign(new Error('bind EADDRINUSE 0.0.0.0:57121'), { code: 'EADDRINUSE' }));
  assert.equal(
    broadcastEvents.filter(([event, , level]) => event === 'Notify' && level === 'error').length,
    1
  );
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
