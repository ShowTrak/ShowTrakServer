const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

test('AlertsManager supports CRUD and action type metadata', async () => {
  const runCalls = [];
  const events = [];

  const dbMock = {
    Manager: {
      All: async () => [
        null,
        [
          {
            RuleID: 1,
            Title: 'Offline Workspace',
            Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
            TriggerType: 'CLIENT_OFFLINE',
            TriggerConfig: JSON.stringify({}),
            Actions: JSON.stringify([{ Type: 'http-api', Settings: {} }]),
            Enabled: 1,
            Timestamp: 1,
            UpdatedAt: 1,
          },
        ],
      ],
      Run: async (sql, params) => {
        runCalls.push([sql, params]);
        if (sql.includes('INSERT INTO AlertRules')) return [null, { lastID: 9 }];
        return [null, { changes: 1 }];
      },
    },
  };

  const actionsMock = {
    Manager: {
      GetAll: () => [{ ID: 'http-api', Name: 'HTTP API' }],
      Execute: async () => ({ Success: true }),
    },
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../AlertActions': actionsMock,
    '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  const [allErr, allRules] = await Manager.GetAll();
  assert.equal(allErr, null);
  assert.equal(allRules.length, 1);
  // Legacy rows storing a bare trigger string normalize to a one-item list.
  assert.deepEqual(allRules[0].TriggerTypes, ['CLIENT_OFFLINE']);

  const [createErr, created] = await Manager.Create({
    Title: 'Rule 2',
    Scope: { Workspace: true, Groups: [], Clients: [] },
    TriggerTypes: ['CLIENT_ONLINE', 'CLIENT_OFFLINE'],
    TriggerConfig: {},
    Actions: [{ Type: 'http-api', Settings: {} }],
    Enabled: true,
  });
  assert.equal(createErr, null);
  assert.equal(created.RuleID, 9);
  assert.deepEqual(created.TriggerTypes, ['CLIENT_ONLINE', 'CLIENT_OFFLINE']);

  // The TriggerType column persists a JSON array of the selected trigger IDs.
  const insertCall = runCalls.find(([sql]) => sql.includes('INSERT INTO AlertRules'));
  assert.ok(insertCall);
  assert.equal(insertCall[1][2], JSON.stringify(['CLIENT_ONLINE', 'CLIENT_OFFLINE']));

  const [updateErr, updated] = await Manager.Update(9, { Enabled: false, Title: 'Rule 2 Updated' });
  assert.equal(updateErr, null);
  assert.equal(updated.Enabled, false);

  const [setEnabledErr, enabledResult] = await Manager.SetEnabled(9, true);
  assert.equal(setEnabledErr, null);
  assert.equal(enabledResult.Enabled, true);

  const [getErr, fetched] = await Manager.Get(9);
  assert.equal(getErr, null);
  assert.equal(fetched.Title, 'Rule 2 Updated');

  const [deleteErr, deleted] = await Manager.Delete(9);
  assert.equal(deleteErr, null);
  assert.equal(deleted, true);

  const triggers = Manager.GetTriggers();
  assert.ok(triggers.some((t) => t.ID === 'CLIENT_OFFLINE'));
  assert.ok(triggers.some((t) => t.ID === 'NON_CRITICAL_USB_DEVICE_CONNECTED'));
  assert.ok(triggers.some((t) => t.ID === 'NON_CRITICAL_USB_DEVICE_DISCONNECTED'));
  assert.ok(triggers.some((t) => t.ID === 'CRITICAL_USB_DEVICE_CONNECTED'));
  assert.ok(triggers.some((t) => t.ID === 'CRITICAL_USB_DEVICE_DISCONNECTED'));
  assert.ok(triggers.some((t) => t.ID === 'APPLICATION_STARTED'));
  assert.ok(triggers.some((t) => t.ID === 'APPLICATION_STOPPED'));
  assert.ok(triggers.some((t) => t.ID === 'CRITICAL_APPLICATION_STARTED'));
  assert.ok(triggers.some((t) => t.ID === 'CRITICAL_APPLICATION_STOPPED'));
  assert.ok(triggers.some((t) => t.ID === 'NON_CRITICAL_APPLICATION_STARTED'));
  assert.ok(triggers.some((t) => t.ID === 'NON_CRITICAL_APPLICATION_STOPPED'));

  const actionTypes = Manager.GetActionTypes();
  assert.deepEqual(actionTypes, [{ ID: 'http-api', Name: 'HTTP API' }]);

  assert.ok(runCalls.some(([sql]) => sql.includes('INSERT INTO AlertRules')));
  assert.ok(runCalls.some(([sql]) => sql.includes('UPDATE AlertRules')));
  assert.ok(runCalls.some(([sql]) => sql.includes('DELETE FROM AlertRules')));
  assert.ok(events.filter(([event]) => event === 'AlertRuleListChanged').length >= 3);
});

test('AlertsManager evaluates client, monitor, and script contexts against matching rules', async () => {
  const executeCalls = [];
  const runCalls = [];
  const untrackedRunCalls = [];
  const events = [];

  const rules = [
    {
      RuleID: 1,
      Title: 'Client Offline Workspace',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'CLIENT_OFFLINE',
      TriggerConfig: JSON.stringify({}),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/offline' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
    {
      RuleID: 2,
      Title: 'Monitor Degraded Workspace',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'CLIENT_DEGRADED',
      TriggerConfig: JSON.stringify({ Source: 'monitor' }),
      Actions: JSON.stringify([{ Type: 'discord-webhook', Settings: {} }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
    {
      RuleID: 3,
      Title: 'Script Failure Group 5',
      Scope: JSON.stringify({ Workspace: false, Groups: [5], Clients: [] }),
      TriggerType: 'SCRIPT_EXECUTION_FAILED',
      TriggerConfig: JSON.stringify({}),
      Actions: JSON.stringify([{ Type: 'osc-trigger', Settings: {} }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
    {
      RuleID: 4,
      Title: 'Critical USB Connected',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'CRITICAL_USB_DEVICE_CONNECTED',
      TriggerConfig: JSON.stringify({}),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/critical-usb' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
    {
      RuleID: 5,
      Title: 'Non-Critical USB Connected',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'NON_CRITICAL_USB_DEVICE_CONNECTED',
      TriggerConfig: JSON.stringify({}),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/non-critical-usb' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
    {
      RuleID: 6,
      Title: 'Client Degraded Workspace',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'CLIENT_DEGRADED',
      TriggerConfig: JSON.stringify({ Source: 'client' }),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/client-degraded' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
    {
      RuleID: 7,
      Title: 'Critical Application Started',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'CRITICAL_APPLICATION_STARTED',
      TriggerConfig: JSON.stringify({}),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/critical-app-started' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
  ];

  const dbMock = {
    Manager: {
      All: async () => [null, rules],
      Run: async (sql, params) => {
        runCalls.push([sql, params]);
        return [null, { changes: 1 }];
      },
      RunWithoutDirtyTracking: async (sql, params) => {
        untrackedRunCalls.push([sql, params]);
        return [null, { changes: 1 }];
      },
    },
  };

  const actionsMock = {
    Manager: {
      GetAll: () => [],
      Execute: async (action, context) => {
        executeCalls.push({ action, context });
        return { Success: true };
      },
    },
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../AlertActions': actionsMock,
    '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();

  await Manager.HandleClientUpdated({
    UUID: 'client-1',
    Online: true,
    Nickname: 'Player PC',
    GroupID: 5,
    IP: '10.0.0.8',
  });
  await Manager.HandleClientUpdated({
    UUID: 'client-1',
    Online: false,
    Nickname: 'Player PC',
    GroupID: 5,
    IP: '10.0.0.8',
  });

  await Manager.HandleClientUpdated({
    UUID: 'client-5',
    Online: true,
    Degraded: true,
    Nickname: 'Player PC 5',
    GroupID: 9,
    IP: '10.0.0.12',
  });

  await Manager.HandleMonitoringTargetUpdated({
    TargetID: 42,
    Online: true,
    Degraded: true,
    Nickname: 'Web Check',
    Address: 'web.local',
    GroupID: 2,
    LastError: 'HTTP 503',
  });

  await Manager.HandleScriptExecutionUpdated([
    {
      Status: 'Failed',
      Client: { UUID: 'client-2', GroupID: 5, Nickname: 'Booth 2', IP: '10.0.0.9' },
      Script: { ID: 'script-1', Name: 'Deploy' },
      Error: 'Crash',
    },
  ]);

  await Manager.HandleCriticalUSBDeviceConnected(
    {
      UUID: 'client-3',
      Nickname: 'Cabinet 3',
      GroupID: 7,
      IP: '10.0.0.10',
    },
    {
      ManufacturerName: 'SanDisk',
      ProductName: 'Ultra',
      SerialNumber: 'S2',
    }
  );

  await Manager.HandleNonCriticalUSBDeviceConnected(
    {
      UUID: 'client-4',
      Nickname: 'Cabinet 4',
      GroupID: 8,
      IP: '10.0.0.11',
    },
    {
      ManufacturerName: 'Kingston',
      ProductName: 'DataTraveler',
      SerialNumber: 'S3',
    }
  );

  await Manager.HandleCriticalApplicationStarted(
    {
      UUID: 'client-6',
      Nickname: 'Cabinet 6',
      GroupID: 8,
      IP: '10.0.0.16',
    },
    {
      Name: 'Spotify',
    }
  );

  assert.equal(executeCalls.length, 7);
  assert.ok(executeCalls.some((c) => c.action.Type === 'http-api'));
  assert.ok(executeCalls.some((c) => c.action.Type === 'discord-webhook'));
  assert.ok(executeCalls.some((c) => c.action.Type === 'osc-trigger'));

  const historyWrites = untrackedRunCalls.filter(([sql]) =>
    sql.includes('INSERT INTO AlertHistory')
  );
  assert.equal(historyWrites.length, 7);

  const triggeredEvents = events.filter(([event]) => event === 'AlertTriggered');
  assert.equal(triggeredEvents.length, 7);
  assert.ok(triggeredEvents.some(([, payload]) => payload.TriggerType === 'CLIENT_OFFLINE'));
  assert.ok(triggeredEvents.some(([, payload]) => payload.TriggerType === 'CLIENT_DEGRADED'));
  assert.ok(
    triggeredEvents.some(([, payload]) => payload.TriggerType === 'SCRIPT_EXECUTION_FAILED')
  );
  assert.ok(
    triggeredEvents.some(
      ([, payload]) => payload.TriggerType === 'NON_CRITICAL_USB_DEVICE_CONNECTED'
    )
  );
  assert.ok(
    triggeredEvents.some(([, payload]) => payload.TriggerType === 'CRITICAL_USB_DEVICE_CONNECTED')
  );
  assert.ok(
    triggeredEvents.some(([, payload]) => payload.TriggerType === 'CRITICAL_APPLICATION_STARTED')
  );
  assert.ok(
    executeCalls.some(
      (c) => c.context.TriggerType === 'CLIENT_DEGRADED' && c.context.EntityType === 'client'
    )
  );
});

test('AlertsManager fires client degraded only on state transitions', async () => {
  const executeCalls = [];

  const rules = [
    {
      RuleID: 1,
      Title: 'Client Degraded Workspace',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'CLIENT_DEGRADED',
      TriggerConfig: JSON.stringify({ Source: 'client' }),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/client-degraded' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
  ];

  const dbMock = {
    Manager: {
      All: async () => [null, rules],
      Run: async () => [null, { changes: 1 }],
      RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
    },
  };

  const actionsMock = {
    Manager: {
      GetAll: () => [],
      Execute: async (action, context) => {
        executeCalls.push({ action, context });
        return { Success: true };
      },
    },
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../AlertActions': actionsMock,
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();

  await Manager.HandleClientUpdated({
    UUID: 'client-10',
    Online: true,
    Degraded: true,
    Nickname: 'Client 10',
    GroupID: 1,
    IP: '10.0.0.20',
  });
  await Manager.HandleClientUpdated({
    UUID: 'client-10',
    Online: true,
    Degraded: true,
    Nickname: 'Client 10',
    GroupID: 1,
    IP: '10.0.0.20',
  });
  await Manager.HandleClientUpdated({
    UUID: 'client-10',
    Online: true,
    Degraded: false,
    Nickname: 'Client 10',
    GroupID: 1,
    IP: '10.0.0.20',
  });
  await Manager.HandleClientUpdated({
    UUID: 'client-10',
    Online: true,
    Degraded: true,
    Nickname: 'Client 10',
    GroupID: 1,
    IP: '10.0.0.20',
  });
  await Manager.HandleClientUpdated({
    UUID: 'client-10',
    Online: false,
    Degraded: true,
    Nickname: 'Client 10',
    GroupID: 1,
    IP: '10.0.0.20',
  });
  await Manager.HandleClientUpdated({
    UUID: 'client-10',
    Online: true,
    Degraded: true,
    Nickname: 'Client 10',
    GroupID: 1,
    IP: '10.0.0.20',
  });

  const degradedCalls = executeCalls.filter(
    (c) => c.context.TriggerType === 'CLIENT_DEGRADED' && c.context.EntityType === 'client'
  );
  assert.equal(degradedCalls.length, 3);
});

test('AlertsManager fires a rule when ANY of its multiple triggers matches', async () => {
  const executeCalls = [];

  const rules = [
    {
      RuleID: 1,
      Title: 'Client Online or Offline',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      // TriggerType column now holds a JSON array of trigger IDs.
      TriggerType: JSON.stringify(['CLIENT_ONLINE', 'CLIENT_OFFLINE']),
      TriggerConfig: JSON.stringify({}),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/on-off' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
  ];

  const dbMock = {
    Manager: {
      All: async () => [null, rules],
      Run: async () => [null, { changes: 1 }],
      RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
    },
  };

  const actionsMock = {
    Manager: {
      GetAll: () => [],
      Execute: async (action, context) => {
        executeCalls.push({ action, context });
        return { Success: true };
      },
    },
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../AlertActions': actionsMock,
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();

  const [, rulesList] = await Manager.GetAll();
  assert.deepEqual(rulesList[0].TriggerTypes, ['CLIENT_ONLINE', 'CLIENT_OFFLINE']);

  const base = { UUID: 'client-20', Nickname: 'Client 20', GroupID: 1, IP: '10.0.0.30' };
  // Seed the online baseline (no transition), then toggle offline then online.
  await Manager.HandleClientUpdated({ ...base, Online: true });
  await Manager.HandleClientUpdated({ ...base, Online: false }); // matches CLIENT_OFFLINE
  await Manager.HandleClientUpdated({ ...base, Online: true }); // matches CLIENT_ONLINE

  const fired = executeCalls.map((c) => c.context.TriggerType);
  assert.deepEqual(fired.sort(), ['CLIENT_OFFLINE', 'CLIENT_ONLINE']);
});

// An unassigned client is a reserved slot with no hardware behind it, so it is
// offline permanently by design. A workspace-scoped CLIENT_OFFLINE rule would
// otherwise fire on every such slot, which is noise rather than a fault.
test('AlertsManager suppresses offline alerts for unassigned client slots', async () => {
  const executeCalls = [];

  const rules = [
    {
      RuleID: 1,
      Title: 'Anything Offline',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: 'CLIENT_OFFLINE',
      TriggerConfig: JSON.stringify({}),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/offline' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
  ];

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': {
      Manager: { All: async () => [null, rules], Run: async () => [null, { changes: 1 }] },
    },
    '../AlertActions': {
      Manager: {
        GetAll: () => [],
        Execute: async (action, context) => {
          executeCalls.push(context.EntityName);
          return { Success: true };
        },
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();

  const fired = () => executeCalls.slice();

  // A real client transitioning online -> offline still alerts (control case:
  // proves the rule and the harness work).
  await Manager.HandleClientUpdated({ UUID: 'real-1', Online: true, Nickname: 'Real PC' });
  await Manager.HandleClientUpdated({ UUID: 'real-1', Online: false, Nickname: 'Real PC' });
  assert.deepEqual(fired(), ['Real PC']);

  // A slot churning while offline stays silent.
  const slot = { UUID: 'slot-1', Online: false, Nickname: 'Empty Slot', Unassigned: true };
  await Manager.HandleClientUpdated(slot);
  await Manager.HandleClientUpdated(slot);
  assert.deepEqual(fired(), ['Real PC']);

  // Even a flagged slot that somehow reports online then drops stays silent.
  await Manager.HandleClientUpdated({
    UUID: 'slot-2',
    Online: true,
    Nickname: 'Odd Slot',
    Unassigned: true,
  });
  await Manager.HandleClientUpdated({
    UUID: 'slot-2',
    Online: false,
    Nickname: 'Odd Slot',
    Unassigned: true,
  });
  assert.deepEqual(fired(), ['Real PC']);

  // Filling slot-1 clears the flag. It is still offline, and its tracked
  // baseline was already false, so no alert fires for the promotion itself...
  await Manager.HandleClientUpdated({
    UUID: 'slot-1',
    Online: false,
    Nickname: 'Now Real',
    Unassigned: false,
  });
  assert.deepEqual(fired(), ['Real PC']);

  // ...but once it is an ordinary client, a genuine drop alerts as normal.
  await Manager.HandleClientUpdated({
    UUID: 'slot-1',
    Online: true,
    Nickname: 'Now Real',
    Unassigned: false,
  });
  await Manager.HandleClientUpdated({
    UUID: 'slot-1',
    Online: false,
    Nickname: 'Now Real',
    Unassigned: false,
  });
  assert.deepEqual(fired(), ['Real PC', 'Now Real']);
});
