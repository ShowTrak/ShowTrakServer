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

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../AlertActions': actionsMock,
    '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
    '../Utils': require('../src/Modules/Utils'),
  });

  const [allErr, allRules] = await Manager.GetAll();
  assert.equal(allErr, null);
  assert.equal(allRules.length, 1);

  const [createErr, created] = await Manager.Create({
    Title: 'Rule 2',
    Scope: { Workspace: true, Groups: [], Clients: [] },
    TriggerType: 'CLIENT_ONLINE',
    TriggerConfig: {},
    Actions: [{ Type: 'http-api', Settings: {} }],
    Enabled: true,
  });
  assert.equal(createErr, null);
  assert.equal(created.RuleID, 9);

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

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../AlertActions': actionsMock,
    '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
    '../Utils': require('../src/Modules/Utils'),
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

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../AlertActions': actionsMock,
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../src/Modules/Utils'),
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
