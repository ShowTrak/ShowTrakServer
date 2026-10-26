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
  // Monitoring check actions go through MonitoringTargetManager.RunAction.
  const actionCalls = [];
  // FreeKiosk commands go through FreeKioskManager.SendCommand.
  const kioskCalls = [];
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
    '../MonitoringTargetManager': {
      Manager: {
        GetBySlug: async (slug) =>
          slug === 'proj-sl' ? { TargetID: 4, Slug: 'proj-sl', Nickname: 'Projector SL' } : null,
        RunAction: async (targetIDs, method, actionID, params) => {
          actionCalls.push([targetIDs, method, actionID, params]);
          if (actionID === 'power.off') {
            return [
              null,
              {
                Total: 1,
                Succeeded: 0,
                Failed: 1,
                Results: [{ Success: false, Error: 'ERR3 - the projector is busy' }],
              },
            ];
          }
          return [null, { Total: 1, Succeeded: 1, Failed: 0, Results: [{ Success: true }] }];
        },
      },
    },
    '../FreeKioskManager': {
      Manager: {
        GetBySlug: async (slug) =>
          slug === 'lobby-tablet' ? { UUID: 'kiosk-1', Slug: 'lobby-tablet', GroupID: 1 } : null,
        // Two terminals in group 1 (so also tag "foh"), one in group 2.
        GetAll: async () => [
          null,
          [
            { UUID: 'kiosk-1', Slug: 'lobby-tablet', GroupID: 1 },
            { UUID: 'kiosk-2', Slug: 'bar-tablet', GroupID: 1 },
            { UUID: 'kiosk-3', Slug: 'stage-tablet', GroupID: 2 },
          ],
        ],
        // Only kiosk-1 refuses "lock", so a group send fails partially.
        SendCommand: async (uuids, commandID, params) => {
          kioskCalls.push([uuids, commandID, params]);
          const Results = uuids.map((UUID) =>
            commandID === 'lock' && UUID === 'kiosk-1'
              ? { UUID, Success: false, Error: 'Needs Device Owner' }
              : { UUID, Success: true, Error: null }
          );
          const Failed = Results.filter((r) => !r.Success).length;
          return [null, { Total: uuids.length, Succeeded: uuids.length - Failed, Failed, Results }];
        },
      },
    },
    '../MonitoringMethods': {
      Manager: {
        // The catalogue the Monitor routes document their accepted values from.
        GetAll: () => [
          {
            ID: 'pjlink',
            Name: 'PJLink',
            Actions: [
              { ID: 'power.on', Label: 'Power On' },
              {
                ID: 'input.set',
                Label: 'Set Input',
                Params: [{ Key: 'Input', Label: 'Input', Type: 'string', Default: '' }],
              },
            ],
          },
          { ID: 'ping', Name: 'Ping' },
        ],
        GetAction: (method, actionID) => {
          if (method !== 'pjlink') return null;
          if (actionID === 'power.on') return { ID: 'power.on', Label: 'Power On' };
          if (actionID === 'power.off') return { ID: 'power.off', Label: 'Power Off' };
          if (actionID === 'input.set') {
            return {
              ID: 'input.set',
              Label: 'Set Input',
              Params: [{ Key: 'Input', Label: 'Input', Type: 'string', Default: '' }],
            };
          }
          return null;
        },
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
  return {
    OSC,
    handlers,
    socketHandlers,
    broadcastEvents,
    controlCalls,
    actionCalls,
    kioskCalls,
  };
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
  // Check actions name the method that owns them, so every check type shares
  // one route shape and a new one needs no route of its own.
  assert.ok(routes.includes('/API/Monitor/:Slug/:Method/:ActionID'));
  assert.ok(routes.includes('/API/Monitor/:Slug/:Method/:ActionID/:Value'));
  assert.ok(routes.includes('/API/FreeKiosk/:Slug/:CommandID'));
  assert.ok(routes.includes('/API/FreeKiosk/:Slug/:CommandID/:Value'));
  assert.ok(routes.includes('/API/Group/:Slug/FreeKiosk/:CommandID'));
  assert.ok(routes.includes('/API/Group/:Slug/FreeKiosk/:CommandID/:Value'));
  assert.ok(routes.includes('/API/Tag/:Slug/FreeKiosk/:CommandID'));
  assert.ok(routes.includes('/API/Tag/:Slug/FreeKiosk/:CommandID/:Value'));
  assert.ok(routes.includes('/API/All/FreeKiosk/:CommandID'));
  assert.ok(routes.includes('/API/All/FreeKiosk/:CommandID/:Value'));
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
// must not also mislabel them as a bad packet: one socket error, one report.
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

test('OSC runs a check action on a monitoring target addressed by slug', async () => {
  const { handlers, actionCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Monitor/proj-sl/pjlink/power.on']);
  assert.deepEqual(actionCalls, [[[4], 'pjlink', 'power.on', {}]]);
  assert.ok(broadcastEvents.some(([event, , level]) => event === 'Notify' && level === 'success'));
});

test('OSC fills an action parameter from the trailing path value', async () => {
  const { handlers, actionCalls } = loadOSC();
  await handlers.message(['/API/Monitor/proj-sl/pjlink/input.set/31']);
  // The value lands on the action's FIRST declared parameter, the only one a
  // single-value route can address unambiguously.
  assert.deepEqual(actionCalls, [[[4], 'pjlink', 'input.set', { Input: '31' }]]);
});

test('OSC rejects a value sent to an action that takes none', async () => {
  const { handlers, actionCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Monitor/proj-sl/pjlink/power.on/31']);
  assert.deepEqual(actionCalls, [], 'nothing should reach the device');
  assert.ok(
    broadcastEvents.every(([event, , level]) => !(event === 'Notify' && level === 'success'))
  );
});

test('OSC reports an unknown target or action without touching a device', async () => {
  const { handlers, actionCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Monitor/nope/pjlink/power.on']);
  await handlers.message(['/API/Monitor/proj-sl/pjlink/not-an-action']);
  await handlers.message(['/API/Monitor/proj-sl/not-a-method/power.on']);
  assert.deepEqual(actionCalls, []);
  const errors = broadcastEvents.filter(
    ([event, , level]) => event === 'Notify' && level === 'error'
  );
  assert.equal(errors.length, 3);
});

test("OSC surfaces the projector's own refusal rather than a bare failure", async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Monitor/proj-sl/pjlink/power.off']);
  const error = broadcastEvents.find(([event, , level]) => event === 'Notify' && level === 'error');
  assert.ok(error, 'a refusal must be reported');
  assert.match(String(error[1]), /busy/i);
});

// --- FreeKiosk commands -------------------------------------------------------

const successNotified = (events) =>
  events.some(([event, , level]) => event === 'Notify' && level === 'success');
const errorNotices = (events) =>
  events.filter(([event, , level]) => event === 'Notify' && level === 'error');

test('OSC reboots a FreeKiosk terminal addressed by slug', async () => {
  const { handlers, kioskCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/FreeKiosk/lobby-tablet/reboot']);
  assert.deepEqual(kioskCalls, [[['kiosk-1'], 'reboot', {}]]);
  assert.ok(successNotified(broadcastEvents));
});

test('OSC fills a FreeKiosk level from the trailing value, through the real validator', async () => {
  const { handlers, kioskCalls } = loadOSC();
  await handlers.message(['/API/FreeKiosk/lobby-tablet/brightness/40.6']);
  // The validator rounds and types it exactly as it does for the view modal.
  assert.deepEqual(kioskCalls, [[['kiosk-1'], 'brightness', { value: 41 }]]);
});

test('OSC refuses an out-of-range or missing FreeKiosk level without touching the device', async () => {
  const { handlers, kioskCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/FreeKiosk/lobby-tablet/volume/150']);
  await handlers.message(['/API/FreeKiosk/lobby-tablet/volume/loud']);
  await handlers.message(['/API/FreeKiosk/lobby-tablet/volume']);
  assert.deepEqual(kioskCalls, []);
  const errors = errorNotices(broadcastEvents);
  assert.equal(errors.length, 3);
  assert.match(String(errors[0][1]), /between 0 and 100/);
  assert.match(String(errors[2][1]), /needs a value/);
});

test('OSC rejects a value sent to a FreeKiosk command that takes none', async () => {
  const { handlers, kioskCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/FreeKiosk/lobby-tablet/reboot/now']);
  assert.deepEqual(kioskCalls, []);
  assert.match(String(errorNotices(broadcastEvents)[0][1]), /takes no value/);
});

test('OSC only sends FreeKiosk commands on the allowlist', async () => {
  // /api/js would run arbitrary JavaScript in the kiosk WebView; it must stay
  // unreachable by any spelling, exactly as it is from the UI.
  const { handlers, kioskCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/FreeKiosk/lobby-tablet/js']);
  await handlers.message(['/API/FreeKiosk/lobby-tablet/api/js']);
  await handlers.message(['/API/FreeKiosk/nope/reboot']);
  assert.deepEqual(kioskCalls, []);
  // `api/js` lands on the value route as command "api", which is refused too.
  assert.equal(errorNotices(broadcastEvents).length, 3);
});

test("OSC surfaces the terminal's own refusal of a FreeKiosk command", async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/FreeKiosk/lobby-tablet/lock']);
  const [error] = errorNotices(broadcastEvents);
  assert.ok(error, 'a refusal must be reported');
  assert.match(String(error[1]), /Device Owner/);
  assert.ok(!successNotified(broadcastEvents));
});

test('OSC sends a FreeKiosk command to every terminal in a group, and only those', async () => {
  const { handlers, kioskCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Group/main/FreeKiosk/reboot']);
  await handlers.message(['/API/Group/1/FreeKiosk/brightness/40']);
  assert.deepEqual(kioskCalls, [
    [['kiosk-1', 'kiosk-2'], 'reboot', {}],
    [['kiosk-1', 'kiosk-2'], 'brightness', { value: 40 }],
  ]);
  assert.ok(successNotified(broadcastEvents));
});

test('OSC sends a FreeKiosk command to every terminal a tag covers', async () => {
  const { handlers, kioskCalls } = loadOSC();
  // "foh" scopes group 1, which holds kiosk-1 and kiosk-2.
  await handlers.message(['/API/Tag/foh/FreeKiosk/screen.off']);
  await handlers.message(['/API/Tag/5/FreeKiosk/volume/20']);
  assert.deepEqual(kioskCalls, [
    [['kiosk-1', 'kiosk-2'], 'screen.off', {}],
    [['kiosk-1', 'kiosk-2'], 'volume', { value: 20 }],
  ]);
});

test('OSC sends a FreeKiosk command to every terminal over the All route', async () => {
  const { handlers, kioskCalls, broadcastEvents } = loadOSC();
  await handlers.message(['/API/All/FreeKiosk/wake']);
  await handlers.message(['/API/All/FreeKiosk/brightness/40']);
  assert.deepEqual(kioskCalls, [
    [['kiosk-1', 'kiosk-2', 'kiosk-3'], 'wake', {}],
    [['kiosk-1', 'kiosk-2', 'kiosk-3'], 'brightness', { value: 40 }],
  ]);
  assert.ok(successNotified(broadcastEvents));
});

test('OSC All/FreeKiosk refuses when there are no terminals', async () => {
  const { handlers, kioskCalls, broadcastEvents } = loadOSC({
    '../FreeKioskManager': {
      Manager: {
        GetAll: async () => [null, []],
        SendCommand: async () => [null, { Total: 0, Succeeded: 0, Failed: 0, Results: [] }],
      },
    },
  });
  await handlers.message(['/API/All/FreeKiosk/reboot']);
  assert.deepEqual(kioskCalls, []);
  assert.match(String(errorNotices(broadcastEvents)[0][1]), /No FreeKiosk terminals$/);
});

test('OSC group/tag FreeKiosk routes refuse unknown targets, bad commands and empty sets', async () => {
  const { handlers, kioskCalls, broadcastEvents } = loadOSC({
    '../GroupManager': {
      Manager: {
        Get: async () => [null, null],
        GetBySlug: async (slug) =>
          slug === 'empty' ? { GroupID: 9, Title: 'Empty', Slug: 'empty' } : null,
      },
    },
  });
  await handlers.message(['/API/Group/nope/FreeKiosk/reboot']);
  await handlers.message(['/API/Tag/nope/FreeKiosk/reboot']);
  await handlers.message(['/API/Tag/foh/FreeKiosk/js']);
  await handlers.message(['/API/Tag/foh/FreeKiosk/volume/150']);
  await handlers.message(['/API/Group/empty/FreeKiosk/reboot']);
  assert.deepEqual(kioskCalls, []);
  const errors = errorNotices(broadcastEvents).map(([, detail]) => String(detail));
  assert.equal(errors.length, 5);
  assert.match(errors[0], /Invalid Group "nope"/);
  assert.match(errors[1], /Invalid Tag "nope"/);
  assert.match(errors[2], /Unknown FreeKiosk command/);
  assert.match(errors[3], /between 0 and 100/);
  assert.match(errors[4], /No FreeKiosk terminals in group "Empty"/);
});

test('OSC names each refusing terminal when a group FreeKiosk command partly fails', async () => {
  const { handlers, broadcastEvents } = loadOSC();
  await handlers.message(['/API/Group/main/FreeKiosk/lock']);
  const [error] = errorNotices(broadcastEvents);
  assert.ok(error, 'a partial failure must be reported');
  assert.match(String(error[1]), /2 FreeKiosk terminals in group "Main" \(main\) \(1 failed\)/);
  assert.match(String(error[1]), /"lobby-tablet": Needs Device Owner/);
  assert.doesNotMatch(String(error[1]), /bar-tablet/);
});

// --- Documented values --------------------------------------------------------

test('the FreeKiosk routes document every allowlisted command, split by whether it takes a value', () => {
  const { OSC } = loadOSC();
  const { FREEKIOSK_COMMANDS } = require('../dist/Modules/FreeKiosk/commands');
  const byPath = new Map(OSC.GetRoutes().map((r) => [r.Path, r]));
  const bare = byPath.get('/API/FreeKiosk/:Slug/:CommandID').Values;
  const valued = byPath.get('/API/FreeKiosk/:Slug/:CommandID/:Value').Values;

  const documented = [...bare.Entries, ...valued.Entries].map((e) => e.Value.split('/')[0]);
  assert.deepEqual(documented.sort(), FREEKIOSK_COMMANDS.map((c) => c.ID).sort());
  assert.ok(bare.Entries.some((e) => e.Value === 'reboot'));
  assert.ok(valued.Entries.some((e) => e.Value === 'brightness/<0-100>'));
  // A WebView-only command says so, since it is refused in the other modes.
  assert.match(bare.Entries.find((e) => e.Value === 'reload').Note, /WebView mode only/);
});

test('the Monitor routes document every declared action from the method catalogue', () => {
  const { OSC } = loadOSC();
  const byPath = new Map(OSC.GetRoutes().map((r) => [r.Path, r]));
  assert.deepEqual(
    byPath.get('/API/Monitor/:Slug/:Method/:ActionID').Values.Entries.map((e) => e.Value),
    ['pjlink/power.on']
  );
  assert.deepEqual(
    byPath.get('/API/Monitor/:Slug/:Method/:ActionID/:Value').Values.Entries.map((e) => e.Value),
    ['pjlink/input.set/<Input>']
  );
});

test('route value catalogues survive the JSON clone that ships them to the renderer', () => {
  const { OSC } = loadOSC();
  const cloned = JSON.parse(JSON.stringify(OSC.GetRoutes()));
  const kiosk = cloned.find((r) => r.Path === '/API/FreeKiosk/:Slug/:CommandID');
  assert.ok(kiosk.Values.Entries.length > 0);
  // Routes whose values are the operator's own data carry no catalogue.
  assert.equal(cloned.find((r) => r.Path === '/API/All/WakeOnLAN').Values, undefined);
});
