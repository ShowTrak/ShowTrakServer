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

  // Both entities are seen healthy first: a degraded alert is a transition
  // between two observed states, so the first snapshot only sets the baseline.
  await Manager.HandleClientUpdated({
    UUID: 'client-5',
    Online: true,
    Degraded: false,
    Nickname: 'Player PC 5',
    GroupID: 9,
    IP: '10.0.0.12',
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
    Degraded: false,
    Nickname: 'Web Check',
    Address: 'web.local',
    GroupID: 2,
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

  // First sighting: already degraded. This is what a server restart looks like
  // to the alert engine, and it must NOT alert — the fault predates us, so
  // announcing it as fresh would bury the real ones under a start-up wave.
  await Manager.HandleClientUpdated({
    UUID: 'client-10',
    Online: true,
    Degraded: true,
    Nickname: 'Client 10',
    GroupID: 1,
    IP: '10.0.0.20',
  });
  assert.equal(executeCalls.length, 0);

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

  // Two: the recovery-then-degrade, and the reconnect-still-degraded. The
  // opening snapshot seeded the baseline and the repeat of it changed nothing.
  const degradedCalls = executeCalls.filter(
    (c) => c.context.TriggerType === 'CLIENT_DEGRADED' && c.context.EntityType === 'client'
  );
  assert.equal(degradedCalls.length, 2);
});

// The start-up case that made monitors the loudest source of false alerts: the
// rig is still coming up, so the first tick of a multi-check target finds the
// projector answering and the show-control app not yet listening. That is a
// state we inherited, not an event — the tile shows it, and the alert waits for
// something to actually change.
test('AlertsManager treats a monitor found degraded on its first tick as a baseline', async () => {
  const executeCalls = [];

  const rules = [
    {
      RuleID: 1,
      Title: 'Monitor Degraded Workspace',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: ['check:7'] }),
      TriggerType: 'CLIENT_DEGRADED',
      TriggerConfig: JSON.stringify({ Source: 'monitor' }),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/degraded' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
  ];

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': {
      Manager: {
        All: async () => [null, rules],
        Run: async () => [null, { changes: 1 }],
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
      },
    },
    '../AlertActions': {
      Manager: {
        GetAll: () => [],
        Execute: async (action, context) => {
          executeCalls.push({ action, context });
          return { Success: true };
        },
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();

  const target = (degraded) => ({
    TargetID: 3,
    Online: true,
    Degraded: degraded,
    Nickname: 'Stage Rack',
    Address: '10.0.0.30',
    GroupID: null,
    LastError: degraded ? 'Check down' : null,
    Checks: [
      { CheckID: 7, Name: 'QLab', Method: 'qlab', Online: true, Degraded: degraded },
      { CheckID: 8, Name: 'Ping', Method: 'ping', Online: true, Degraded: false },
    ],
  });

  await Manager.HandleMonitoringTargetUpdated(target(true));
  assert.equal(
    executeCalls.length,
    0,
    'the first tick establishes the baseline, it does not alert'
  );

  // Still degraded on the next tick: nothing changed, so nothing new to say.
  await Manager.HandleMonitoringTargetUpdated(target(true));
  assert.equal(executeCalls.length, 0);

  // It recovers as the rig finishes booting, then genuinely fails later in the
  // show. That transition is a real fault and alerts at both levels.
  await Manager.HandleMonitoringTargetUpdated(target(false));
  await Manager.HandleMonitoringTargetUpdated(target(true));
  const entityTypes = executeCalls.map((c) => c.context.EntityType).sort();
  assert.deepEqual(entityTypes, ['monitor', 'monitor-check']);
});

// The other side of the baseline rule: a fault that predates the server is not
// announced as it is found, but it is not forgotten either. Anything still
// faulty once the settle period has passed gets exactly one alert, so a device
// that was genuinely dead at start-up is not discoverable only by looking at
// the screen.
test('AlertsManager announces start-up faults that outlast the settle period', async () => {
  const executeCalls = [];

  const rules = [
    {
      RuleID: 1,
      Title: 'Anything Offline Or Degraded',
      Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
      TriggerType: JSON.stringify(['CLIENT_OFFLINE', 'CLIENT_DEGRADED']),
      TriggerConfig: JSON.stringify({ Source: 'any' }),
      Actions: JSON.stringify([{ Type: 'http-api', Settings: { Route: '/fault' } }]),
      Enabled: 1,
      Timestamp: 1,
      UpdatedAt: 1,
    },
  ];

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': {
      Manager: {
        All: async () => [null, rules],
        Run: async () => [null, { changes: 1 }],
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
      },
    },
    '../AlertActions': {
      Manager: {
        GetAll: () => [],
        Execute: async (action, context) => {
          executeCalls.push({ action, context });
          return { Success: true };
        },
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();

  // Target 1 is dead when we first look and stays dead. Target 2 is down on its
  // first tick because its device is mid-boot, and comes up.
  await Manager.HandleMonitoringTargetUpdated({
    TargetID: 1,
    Online: false,
    Nickname: 'Dead Projector',
    Address: '10.0.0.1',
    LastError: 'Timed out',
  });
  await Manager.HandleMonitoringTargetUpdated({
    TargetID: 2,
    Online: false,
    Nickname: 'Booting Rack',
    Address: '10.0.0.2',
  });
  await Manager.HandleMonitoringTargetUpdated({
    TargetID: 2,
    Online: true,
    Nickname: 'Booting Rack',
    Address: '10.0.0.2',
  });
  assert.equal(executeCalls.length, 0, 'nothing is announced while the rig comes up');

  // MinAge 0: everything still pending has outlasted the period.
  const Raised = await Manager.FlushSettledBaselineFaults(0, [
    // Never reported at all — a machine that was off when the server started.
    { UUID: 'client-off', Nickname: 'Booth 3', Online: false },
    // A reserved slot is offline by definition and is never a fault.
    { UUID: 'client-slot', Nickname: 'Spare', Online: false, Unassigned: true },
    { UUID: 'client-up', Nickname: 'Booth 1', Online: true },
  ]);

  assert.equal(Raised, 2);
  const announced = executeCalls.map((c) => c.context.EntityName).sort();
  assert.deepEqual(announced, ['Booth 3', 'Dead Projector']);
  assert.ok(
    executeCalls.every((c) => c.context.TriggerType === 'CLIENT_OFFLINE'),
    'both are offline faults, not degraded ones'
  );

  // Announced once and once only, however often the sweep runs.
  const Again = await Manager.FlushSettledBaselineFaults(0, [
    { UUID: 'client-off', Nickname: 'Booth 3', Online: false },
  ]);
  assert.equal(Again, 0);
  assert.equal(executeCalls.length, 2);

  // And the entity is now tracked, so its recovery is a normal transition.
  await Manager.HandleMonitoringTargetUpdated({
    TargetID: 1,
    Online: true,
    Nickname: 'Dead Projector',
    Address: '10.0.0.1',
  });
  await Manager.HandleMonitoringTargetUpdated({
    TargetID: 1,
    Online: false,
    Nickname: 'Dead Projector',
    Address: '10.0.0.1',
    LastError: 'Timed out',
  });
  assert.equal(executeCalls.length, 3, 'a genuine outage after start-up still alerts immediately');
});

test('AlertsManager holds a start-up fault until the settle period has actually passed', async () => {
  const executeCalls = [];

  const rules = [
    {
      RuleID: 1,
      Title: 'Offline Workspace',
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
      Manager: {
        All: async () => [null, rules],
        Run: async () => [null, { changes: 1 }],
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
      },
    },
    '../AlertActions': {
      Manager: {
        GetAll: () => [],
        Execute: async (action, context) => {
          executeCalls.push({ action, context });
          return { Success: true };
        },
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();
  await Manager.HandleMonitoringTargetUpdated({
    TargetID: 9,
    Online: false,
    Nickname: 'Rack',
    Address: '10.0.0.9',
  });

  // A sweep that runs before the period is up announces nothing — including for
  // clients that never reported, which is what stops a sweep landing seconds
  // after boot from alerting for every machine still powering on.
  const Early = await Manager.FlushSettledBaselineFaults(60_000, [
    { UUID: 'client-off', Nickname: 'Booth 3', Online: false },
  ]);
  assert.equal(Early, 0);
  assert.equal(executeCalls.length, 0);
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
