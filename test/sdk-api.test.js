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

function loadControlService(overrides = {}) {
  const broadcastEvents = [];
  const handlerCalls = [];
  const modeCalls = [];
  const alertCalls = [];

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
        GetBySlug: async (slug) => (slug === 'ping-foh' ? { TargetID: 7, Slug: 'ping-foh' } : null),
      },
    },
    '../DummyClientManager': {
      Manager: {
        GetBySlug: async (slug) =>
          slug === 'spare-1' ? { UUID: 'dummy-uuid-1', DummyID: 'spare-1' } : null,
      },
    },
    '../../main/handler-registry': { GetHandler: (channel) => handlers[channel] },
    ...overrides,
  };

  const { ControlService } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ControlService', 'index.js'),
    mocks
  );
  return { ControlService, broadcastEvents, handlerCalls, modeCalls, alertCalls };
}

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
