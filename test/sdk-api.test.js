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

// A tag whose scope is "group 1", expanding to clients a + b (b is integrated).
const FOH_SCOPE = { Workspace: false, Groups: [1], Clients: [] };

const PJLINK_ACTIONS = {
  'power.on': { ID: 'power.on', Label: 'Power On' },
  'power.off': { ID: 'power.off', Label: 'Power Off' },
  'input.set': {
    ID: 'input.set',
    Label: 'Set Input',
    Params: [
      { Key: 'Input', Label: 'Input', Type: 'string', Default: '' },
      { Key: 'Delay', Label: 'Delay', Type: 'string', Default: '' },
    ],
  },
};

function loadControlService({ __identifyResult, __executions, ...overrides } = {}) {
  const broadcastEvents = [];
  const handlerCalls = [];
  const modeCalls = [];
  const alertCalls = [];
  const identifyCalls = [];
  const actionCalls = [];
  const kioskCalls = [];
  const heartbeatCalls = [];
  // The execution panel's rows, for the retry command to choose from.
  const executions = __executions || [];
  // Overridable per test so the failure path (offline client, too-old agent) can
  // be exercised as well as the happy one.
  const identifyResult = __identifyResult || [null, true];

  // Shared IPC handlers the ControlService dispatches real actions through.
  const handlers = {
    ExecuteScript: (...args) => {
      handlerCalls.push(['ExecuteScript', ...args]);
      return [null, true];
    },
    TriggerIntegratedEvent: (...args) => {
      handlerCalls.push(['TriggerIntegratedEvent', ...args]);
      return [null, true];
    },
    WakeOnLan: (...args) => {
      handlerCalls.push(['WakeOnLan', ...args]);
      return [null, true];
    },
    'Show:Save': (...args) => {
      handlerCalls.push(['Show:Save', ...args]);
      return [null, true];
    },
    'Scripts:RetryExecutions': (...args) => {
      handlerCalls.push(['Scripts:RetryExecutions', ...args]);
      return [null, { Retried: args[1].length }];
    },
    'Scripts:ClearSettledExecutions': (...args) => {
      handlerCalls.push(['Scripts:ClearSettledExecutions', ...args]);
      return undefined;
    },
  };

  const mocks = {
    '../Logger': noopLogger,
    '../Broadcast': { Manager: { emit: (...args) => broadcastEvents.push(args) } },
    '../ClientManager': {
      Manager: {
        Get: async (uuid) => (uuid === 'good' ? [null, { UUID: 'good' }] : ['not found', null]),
        GetBySlug: async (slug) => {
          if (slug === 'stage-left') return { UUID: 'good', Slug: 'stage-left' };
          if (slug === 'qlab') return { UUID: 'q', Slug: 'qlab', Integrated: true };
          return null;
        },
        GetAll: async () => [
          null,
          [
            { UUID: 'a', GroupID: 1 },
            { UUID: 'b', GroupID: 1, Integrated: true },
            { UUID: 'c', GroupID: 2 },
          ],
        ],
      },
    },
    '../GroupManager': {
      Manager: {
        Get: async (id) => (Number(id) === 1 ? [null, { GroupID: 1 }] : [null, null]),
        GetBySlug: async (slug) => (slug === 'main' ? { GroupID: 1, Slug: 'main' } : null),
      },
    },
    '../TagManager': {
      Manager: {
        Get: async (id) =>
          Number(id) === 5 ? [null, { TagID: 5, Slug: 'foh', Scope: FOH_SCOPE }] : [null, null],
        GetBySlug: async (slug) =>
          slug === 'foh' ? { TagID: 5, Slug: 'foh', Scope: FOH_SCOPE } : null,
        GetAllViews: async () => [{ TagID: 5, Slug: 'foh', Scope: FOH_SCOPE }],
      },
    },
    '../ScriptManager': {
      Manager: { Get: async (id) => (id === 'reboot' ? { ID: 'reboot' } : null) },
    },
    '../ScriptWhitelistManager': {
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
    '../ModeManager': {
      Manager: {
        Get: () => 'SHOW',
        Set: (mode) => modeCalls.push(mode),
      },
    },
    '../AlertsManager': {
      Manager: {
        GetActionsEnabled: () => true,
        SetActionsEnabled: (enabled) => {
          alertCalls.push(!!enabled);
          return !!enabled;
        },
      },
    },
    '../MonitoringTargetManager': {
      Manager: {
        GetBySlug: async (slug) => {
          if (slug === 'ping-foh') return { TargetID: 7, Slug: 'ping-foh' };
          if (slug === 'proj-sl') return { TargetID: 4, Slug: 'proj-sl' };
          return null;
        },
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
    // The real IPCValidation runs over this catalogue: PJLink with a parameterless
    // power pair and an input selector taking one value.
    '../MonitoringMethods': {
      Manager: {
        Has: (method) => method === 'pjlink',
        GetAction: (method, actionID) =>
          PJLINK_ACTIONS[method === 'pjlink' ? actionID : ''] || null,
        NormalizeActionParams: (method, actionID, value) => {
          const Action = PJLINK_ACTIONS[actionID];
          const Out = {};
          for (const Field of (Action && Action.Params) || []) {
            if (value[Field.Key] !== undefined) Out[Field.Key] = String(value[Field.Key]);
          }
          return Out;
        },
      },
    },
    '../DummyClientManager': {
      Manager: {
        GetBySlug: async (slug) =>
          slug === 'spare-1' ? { UUID: 'dummy-uuid-1', DummyID: 'spare-1' } : null,
        Heartbeat: async (slug, ip) => {
          heartbeatCalls.push([slug, ip]);
          return slug === 'spare-1' ? [null, true] : [`Unknown Dummy ID "${slug}"`, null];
        },
      },
    },
    '../ScriptExecutionManager': {
      Manager: { GetAllExecutions: async () => executions },
    },
    // Unstubbed, the real manager requires ../DB and opens a live sqlite
    // connection at module load: green locally, fails on CI where there is no
    // database. ControlService resolves terminals by slug.
    '../FreeKioskManager': {
      Manager: {
        GetBySlug: async (slug) =>
          slug === 'lobby' ? { UUID: 'kiosk-uuid-1', Slug: 'lobby', GroupID: 1 } : null,
        // Two terminals in group 1 (so also tag "foh"), one in group 2.
        GetAll: async () => [
          null,
          [
            { UUID: 'kiosk-uuid-1', Slug: 'lobby', GroupID: 1 },
            { UUID: 'kiosk-2', Slug: 'bar', GroupID: 1 },
            { UUID: 'kiosk-3', Slug: 'stage', GroupID: 2 },
          ],
        ],
        // Only the lobby terminal refuses "lock", so a group send fails partially.
        SendCommand: async (uuids, commandID, params) => {
          kioskCalls.push([uuids, commandID, params]);
          const Results = uuids.map((UUID) =>
            commandID === 'lock' && UUID === 'kiosk-uuid-1'
              ? { UUID, Success: false, Error: 'Needs Device Owner' }
              : { UUID, Success: true, Error: null }
          );
          const Failed = Results.filter((r) => !r.Success).length;
          return [null, { Total: uuids.length, Succeeded: uuids.length - Failed, Failed, Results }];
        },
      },
    },
    // Identify is the one ControlService command that reaches a manager rather
    // than the handler registry, because it is addressed at a specific client's
    // own screen. Stubbed for the usual reason: the real manager pulls in ../DB.
    '../IdentifyManager': {
      Manager: {
        Identify: async (uuid) => {
          identifyCalls.push(['Identify', uuid]);
          return identifyResult;
        },
        Stop: async (uuid) => {
          identifyCalls.push(['Stop', uuid]);
          return identifyResult;
        },
      },
    },
    // The live levels hub reaches the real monitor manager (and its DB) from
    // main/, under a request string the stubs above do not cover.
    '../../main/monitoring-live': {
      OpenMonitorLiveLevels: () => ({ TargetID: 0, Checks: [] }),
      CloseMonitorLiveLevels: () => undefined,
    },
    '../../main/handler-registry': { GetHandler: (channel) => handlers[channel] },
    ...overrides,
  };

  const { ControlService } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ControlService', 'index.js'),
    mocks
  );
  return {
    ControlService,
    broadcastEvents,
    handlerCalls,
    modeCalls,
    alertCalls,
    identifyCalls,
    actionCalls,
    kioskCalls,
    heartbeatCalls,
  };
}

// Identify is the one command here that is safe in SHOW mode and mutates
// nothing; it exists for the operator standing at a rack with a phone, working
// out which machine is which. It resolves a slug to a UUID because that is what
// IdentifyManager addresses.
test('Identify resolves a client slug and identifies by UUID', async () => {
  const { ControlService, identifyCalls } = loadControlService();
  const result = await ControlService.Identify('stage-left');
  assert.equal(result.ok, true);
  assert.deepEqual(identifyCalls, [['Identify', 'good']]);
});

test('StopIdentify resolves a client slug and stops by UUID', async () => {
  const { ControlService, identifyCalls } = loadControlService();
  const result = await ControlService.StopIdentify('stage-left');
  assert.equal(result.ok, true);
  assert.deepEqual(identifyCalls, [['Stop', 'good']]);
});

test('Identify with an unknown slug fails without touching the manager', async () => {
  const { ControlService, identifyCalls } = loadControlService();
  const result = await ControlService.Identify('nope');
  assert.equal(result.ok, false);
  assert.match(result.detail, /Invalid Client/);
  assert.deepEqual(identifyCalls, []);
});

// A manager refusal (offline client, agent too old, integrated client) has to
// surface as a failed command with the manager's own reason, not a bare "ok".
test('Identify surfaces the manager error', async () => {
  const { ControlService } = loadControlService({ __identifyResult: ['Client is offline.', null] });
  const result = await ControlService.Identify('stage-left');
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'Client is offline.');
});

test('OpenClientModal resolves a client slug and emits OpenClientModal', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.OpenClientModal('stage-left');
  assert.equal(result.ok, true);
  const bulk = broadcastEvents.find(
    ([e, action]) => e === 'OSCBulkAction' && action === 'OpenClientModal'
  );
  assert.ok(bulk);
  assert.deepEqual(bulk[2], ['good']);
});

test('OpenClientModal with an invalid slug fails', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.OpenClientModal('nope');
  assert.equal(result.ok, false);
  assert.ok(!broadcastEvents.some(([e]) => e === 'OSCBulkAction'));
});

test('OpenClientModal refuses non-ShowTrak (integrated) clients', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.OpenClientModal('qlab');
  assert.equal(result.ok, false);
  assert.ok(!broadcastEvents.some(([e]) => e === 'OSCBulkAction'));
});

test('OpenClientModal resolves a monitor slug and tags it as a monitor', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.OpenClientModal('ping-foh');
  assert.equal(result.ok, true);
  const bulk = broadcastEvents.find(
    ([e, action]) => e === 'OSCBulkAction' && action === 'OpenClientModal'
  );
  assert.ok(bulk);
  assert.deepEqual(bulk[2], ['7']); // TargetID, stringified
  assert.equal(bulk[3], 'monitor'); // entity type carried in Args
});

test('OpenClientModal resolves a dummy slug and tags it as a dummy', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.OpenClientModal('spare-1');
  assert.equal(result.ok, true);
  const bulk = broadcastEvents.find(
    ([e, action]) => e === 'OSCBulkAction' && action === 'OpenClientModal'
  );
  assert.ok(bulk);
  assert.deepEqual(bulk[2], ['dummy-uuid-1']);
  assert.equal(bulk[3], 'dummy');
});

test('CloseModals emits a targetless CloseModals bulk action', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.CloseModals();
  assert.equal(result.ok, true);
  const bulk = broadcastEvents.find(
    ([e, action]) => e === 'OSCBulkAction' && action === 'CloseModals'
  );
  assert.ok(bulk);
  assert.deepEqual(bulk[2], []);
});

// The modal actions drive the operator's own desktop window; the web namespace
// must drop them so a Companion press does not open/close modals in every
// logged-in browser as well.
test('the modal bulk actions are suppressed on the web push', () => {
  const { WEB_SUPPRESSED_BULK_ACTIONS, WEB_PUSH_ALLOWLIST } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'Server', 'webui-namespace.js')
  );
  assert.ok(WEB_PUSH_ALLOWLIST.has('OSCBulkAction'));
  assert.ok(WEB_SUPPRESSED_BULK_ACTIONS.has('OpenClientModal'));
  assert.ok(WEB_SUPPRESSED_BULK_ACTIONS.has('CloseModals'));
  // Actions that are legitimate server-wide state stay on the web push.
  for (const action of ['Select', 'Deselect', 'WOL', 'ExecuteScript']) {
    assert.ok(!WEB_SUPPRESSED_BULK_ACTIONS.has(action));
  }
});

test('RunScriptOnClient validates script and dispatches ExecuteScript', async () => {
  const { ControlService, handlerCalls } = loadControlService();
  const result = await ControlService.RunScriptOnClient('stage-left', 'reboot');
  assert.equal(result.ok, true);
  const call = handlerCalls.find(([c]) => c === 'ExecuteScript');
  assert.ok(call);
  // [channel, event(null), scriptSlug, uuids, resetList]
  assert.equal(call[2], 'reboot');
  assert.deepEqual(call[3], ['good']);
  assert.equal(call[4], false);
});

test('RunScriptOnClient rejects an unknown script', async () => {
  const { ControlService, handlerCalls } = loadControlService();
  const result = await ControlService.RunScriptOnClient('stage-left', 'missing');
  assert.equal(result.ok, false);
  assert.ok(!handlerCalls.some(([c]) => c === 'ExecuteScript'));
});

test('WakeClient dispatches the WakeOnLan handler', async () => {
  const { ControlService, handlerCalls } = loadControlService();
  await ControlService.WakeClient('stage-left');
  const call = handlerCalls.find(([c]) => c === 'WakeOnLan');
  assert.ok(call);
  assert.deepEqual(call[2], ['good']);
});

test('TriggerEventOnGroup targets only integrated members', async () => {
  const { ControlService, handlerCalls } = loadControlService();
  const result = await ControlService.TriggerEventOnGroup('main', 'go');
  assert.equal(result.ok, true);
  const call = handlerCalls.find(([c]) => c === 'TriggerIntegratedEvent');
  assert.ok(call);
  assert.equal(call[2], 'go');
  assert.deepEqual(call[3], ['b']); // only b is integrated
});

test('SetMode sets the mode manager', async () => {
  const { ControlService, modeCalls } = loadControlService();
  await ControlService.SetMode('edit');
  assert.deepEqual(modeCalls, ['EDIT']);
});

test('SetAlertsEnabled toggles the alerts manager', async () => {
  const { ControlService, alertCalls } = loadControlService();
  await ControlService.SetAlertsEnabled(false);
  assert.deepEqual(alertCalls, [false]);
});

test('OpenClientModal emits an OSCBulkAction OpenClientModal', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  await ControlService.OpenClientModal('stage-left');
  const bulk = broadcastEvents.find(
    ([e, action]) => e === 'OSCBulkAction' && action === 'OpenClientModal'
  );
  assert.ok(bulk);
  assert.deepEqual(bulk[2], ['good']);
});

test('SaveShow dispatches the Show:Save handler and notifies', async () => {
  const { ControlService, handlerCalls, broadcastEvents } = loadControlService();
  const result = await ControlService.SaveShow();
  assert.equal(result.ok, true);
  assert.ok(handlerCalls.some(([c]) => c === 'Show:Save'));
  assert.ok(
    broadcastEvents.some(
      ([e, msg, type]) => e === 'Notify' && type === 'success' && /saved/i.test(String(msg))
    )
  );
});

// --- Client-list layout -------------------------------------------------------

const bulkOf = (events, type) =>
  events.find(([event, action]) => event === 'OSCBulkAction' && action === type);

test('SetView names the layout to show', async () => {
  for (const Mode of ['grid', 'compact', 'list', 'LIST']) {
    const { ControlService, broadcastEvents } = loadControlService();
    const result = await ControlService.SetView(Mode);
    assert.equal(result.ok, true);
    assert.deepEqual(bulkOf(broadcastEvents, 'SetViewMode').slice(2), [[], Mode.toLowerCase()]);
  }
});

// SDKs before 1.8 send { compact: boolean } and nothing else. The command was
// declared from the first release but never reached the renderer until now, so
// those SDKs' enterCompactView / enterExpandedView start working unchanged.
test('SetView still understands the compact flag older SDKs send', async () => {
  const On = loadControlService();
  await On.ControlService.SetView(undefined, true);
  assert.equal(bulkOf(On.broadcastEvents, 'SetViewMode')[3], 'compact');
  const Off = loadControlService();
  await Off.ControlService.SetView(undefined, false);
  assert.equal(bulkOf(Off.broadcastEvents, 'SetViewMode')[3], 'grid');
});

test('SetView refuses a layout it does not know', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.SetView('carousel', true);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Unknown view "carousel"/);
  assert.deepEqual(broadcastEvents, []);
});

test('ToggleCompactView emits the toggle the renderer already handles', async () => {
  const { ControlService, broadcastEvents } = loadControlService();
  const result = await ControlService.ToggleCompactView();
  assert.equal(result.ok, true);
  assert.ok(bulkOf(broadcastEvents, 'ToggleCompactView'));
});

// The renderer applies the layout switches wherever it runs; only the modal
// actions are kept off the Web UI.
test('the view switches are not suppressed on the web push', () => {
  const { WEB_SUPPRESSED_BULK_ACTIONS } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'Server', 'webui-namespace.js')
  );
  for (const action of ['SetViewMode', 'SetCompactView', 'ToggleCompactView']) {
    assert.ok(!WEB_SUPPRESSED_BULK_ACTIONS.has(action), action);
  }
});

// --- Monitoring check actions -------------------------------------------------

test('RunMonitorAction runs an action on a monitor addressed by slug', async () => {
  const { ControlService, actionCalls } = loadControlService();
  const result = await ControlService.RunMonitorAction('proj-sl', 'pjlink', 'power.on');
  assert.equal(result.ok, true);
  assert.match(result.detail, /Power On sent to "proj-sl"/);
  assert.deepEqual(actionCalls, [[[4], 'pjlink', 'power.on', {}]]);
});

test("RunMonitorAction fills the action's first parameter from the value", async () => {
  const { ControlService, actionCalls } = loadControlService();
  await ControlService.RunMonitorAction('proj-sl', 'pjlink', 'input.set', 31);
  assert.deepEqual(actionCalls, [[[4], 'pjlink', 'input.set', { Input: '31' }]]);
});

test('RunMonitorAction takes named parameters, which win over the value', async () => {
  const { ControlService, actionCalls } = loadControlService();
  await ControlService.RunMonitorAction('proj-sl', 'pjlink', 'input.set', '11', {
    Input: '31',
    Delay: '2',
    Smuggled: 'x',
  });
  // Normalised against the action's own schema: undeclared keys are dropped.
  assert.deepEqual(actionCalls, [[[4], 'pjlink', 'input.set', { Input: '31', Delay: '2' }]]);
});

test('RunMonitorAction treats a blank value as no value', async () => {
  const { ControlService, actionCalls } = loadControlService();
  const result = await ControlService.RunMonitorAction('proj-sl', 'pjlink', 'power.on', '  ');
  assert.equal(result.ok, true);
  assert.deepEqual(actionCalls, [[[4], 'pjlink', 'power.on', {}]]);
});

test('RunMonitorAction refuses unknown monitors, actions and stray values without touching a device', async () => {
  const { ControlService, actionCalls } = loadControlService();
  const Cases = [
    [['nope', 'pjlink', 'power.on'], /Invalid Monitor "nope"/],
    [['proj-sl', 'pjlink', 'not-an-action'], /Unknown action "pjlink\/not-an-action"/],
    [['proj-sl', 'not-a-method', 'power.on'], /Unknown action/],
    [['proj-sl', 'pjlink', 'power.on', '31'], /takes no value/],
    [['proj-sl', 'pjlink', 'input.set', null, ['31']], /must be an object/],
  ];
  for (const [Args, Pattern] of Cases) {
    const result = await ControlService.RunMonitorAction(...Args);
    assert.equal(result.ok, false, JSON.stringify(Args));
    assert.match(result.detail, Pattern);
  }
  assert.deepEqual(actionCalls, []);
});

test("RunMonitorAction surfaces the device's own refusal", async () => {
  const { ControlService } = loadControlService();
  const result = await ControlService.RunMonitorAction('proj-sl', 'pjlink', 'power.off');
  assert.equal(result.ok, false);
  assert.match(result.detail, /Power Off on "proj-sl": ERR3 - the projector is busy/);
});

// --- FreeKiosk terminal commands ----------------------------------------------

test('FreeKioskCommandOnTerminal sends a command to a terminal addressed by slug', async () => {
  const { ControlService, kioskCalls } = loadControlService();
  const result = await ControlService.FreeKioskCommandOnTerminal('lobby', 'reboot');
  assert.equal(result.ok, true);
  assert.deepEqual(kioskCalls, [[['kiosk-uuid-1'], 'reboot', {}]]);
});

test('a FreeKiosk level goes through the real validator', async () => {
  const { ControlService, kioskCalls } = loadControlService();
  await ControlService.FreeKioskCommandOnTerminal('lobby', 'brightness', '40.6');
  await ControlService.FreeKioskCommandOnTerminal('lobby', 'volume', 20);
  assert.deepEqual(kioskCalls, [
    [['kiosk-uuid-1'], 'brightness', { value: 41 }],
    [['kiosk-uuid-1'], 'volume', { value: 20 }],
  ]);
});

test('FreeKiosk commands refuse bad values and commands off the allowlist', async () => {
  const { ControlService, kioskCalls } = loadControlService();
  const Cases = [
    [['lobby', 'volume', '150'], /between 0 and 100/],
    [['lobby', 'volume', ''], /needs a value/],
    [['lobby', 'reboot', 'now'], /takes no value/],
    // /api/js runs arbitrary JavaScript in the kiosk WebView: never reachable.
    [['lobby', 'js'], /Unknown FreeKiosk command "js"/],
    [['nope', 'reboot'], /Invalid FreeKiosk Terminal "nope"/],
  ];
  for (const [Args, Pattern] of Cases) {
    const result = await ControlService.FreeKioskCommandOnTerminal(...Args);
    assert.equal(result.ok, false, JSON.stringify(Args));
    assert.match(result.detail, Pattern);
  }
  assert.deepEqual(kioskCalls, []);
});

test('FreeKiosk group, tag and all commands reach exactly the terminals they cover', async () => {
  const { ControlService, kioskCalls } = loadControlService();
  assert.equal((await ControlService.FreeKioskCommandOnGroup('main', 'reboot')).ok, true);
  assert.equal((await ControlService.FreeKioskCommandOnGroup('1', 'wake')).ok, true);
  assert.equal((await ControlService.FreeKioskCommandOnTag('foh', 'screen.off')).ok, true);
  assert.equal((await ControlService.FreeKioskCommandOnAll('brightness', 40)).ok, true);
  assert.deepEqual(kioskCalls, [
    [['kiosk-uuid-1', 'kiosk-2'], 'reboot', {}],
    [['kiosk-uuid-1', 'kiosk-2'], 'wake', {}],
    [['kiosk-uuid-1', 'kiosk-2'], 'screen.off', {}],
    [['kiosk-uuid-1', 'kiosk-2', 'kiosk-3'], 'brightness', { value: 40 }],
  ]);
});

test('FreeKiosk group and tag commands refuse unknown targets', async () => {
  const { ControlService, kioskCalls } = loadControlService();
  const Group = await ControlService.FreeKioskCommandOnGroup('nope', 'reboot');
  const Tag = await ControlService.FreeKioskCommandOnTag('nope', 'reboot');
  assert.match(Group.detail, /Invalid Group "nope"/);
  assert.match(Tag.detail, /Invalid Tag "nope"/);
  assert.deepEqual(kioskCalls, []);
});

test("a FreeKiosk command names each terminal's own refusal", async () => {
  const { ControlService } = loadControlService();
  const result = await ControlService.FreeKioskCommandOnGroup('main', 'lock');
  assert.equal(result.ok, false);
  assert.match(result.detail, /\(1 failed\): "lobby": Needs Device Owner/);
});

// --- Dummy clients ------------------------------------------------------------

test('DummyHeartbeat delivers a heartbeat without recording the relay as the IP', async () => {
  const { ControlService, heartbeatCalls } = loadControlService();
  const result = await ControlService.DummyHeartbeat('spare-1');
  assert.equal(result.ok, true);
  assert.deepEqual(heartbeatCalls, [['spare-1', null]]);
});

test('DummyHeartbeat surfaces an unknown dummy', async () => {
  const { ControlService } = loadControlService();
  const result = await ControlService.DummyHeartbeat('nope');
  assert.equal(result.ok, false);
  assert.match(result.detail, /Unknown Dummy ID "nope"/);
});

// --- Script executions --------------------------------------------------------

function execution(RequestID, Status, Extra = {}) {
  return {
    RequestID,
    Status,
    Internal: false,
    Client: { UUID: 'good' },
    Script: { ID: 'reboot', Name: 'Reboot' },
    ...Extra,
  };
}

test('RetryFailedExecutions retries only the failures the panel could retry', async () => {
  const { ControlService, handlerCalls } = loadControlService({
    __executions: [
      execution('11111111-1111-4111-8111-111111111111', 'Failed'),
      execution('22222222-2222-4222-8222-222222222222', 'Completed'),
      execution('33333333-3333-4333-8333-333333333333', 'Pending'),
      // A deployment: internal and not an integrated event, so not retryable.
      execution('44444444-4444-4444-8444-444444444444', 'Failed', {
        Internal: true,
        Script: { ID: 'deploy', Name: 'Deploy Scripts' },
      }),
      // An integrated event failure is retryable.
      execution('55555555-5555-4555-8555-555555555555', 'Failed', {
        Internal: true,
        Script: { ID: 'x', Name: 'Integrated Event: go' },
      }),
    ],
  });
  const result = await ControlService.RetryFailedExecutions();
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'Retried 2 failed executions');
  const Call = handlerCalls.find(([c]) => c === 'Scripts:RetryExecutions');
  assert.deepEqual(Call[2], [
    '11111111-1111-4111-8111-111111111111',
    '55555555-5555-4555-8555-555555555555',
  ]);
});

test('RetryFailedExecutions with nothing to retry succeeds without calling the handler', async () => {
  const { ControlService, handlerCalls } = loadControlService({
    __executions: [execution('22222222-2222-4222-8222-222222222222', 'Completed')],
  });
  const result = await ControlService.RetryFailedExecutions();
  assert.equal(result.ok, true);
  assert.match(result.detail, /No failed executions/);
  assert.deepEqual(handlerCalls, []);
});

test('ClearSettledExecutions clears the finished rows through the shared handler', async () => {
  const { ControlService, handlerCalls } = loadControlService();
  const result = await ControlService.ClearSettledExecutions();
  assert.equal(result.ok, true);
  assert.ok(handlerCalls.some(([c]) => c === 'Scripts:ClearSettledExecutions'));
});
