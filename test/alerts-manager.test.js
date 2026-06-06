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

  assert.equal(executeCalls.length, 3);
  assert.ok(executeCalls.some((c) => c.action.Type === 'http-api'));
  assert.ok(executeCalls.some((c) => c.action.Type === 'discord-webhook'));
  assert.ok(executeCalls.some((c) => c.action.Type === 'osc-trigger'));

  const historyWrites = untrackedRunCalls.filter(([sql]) => sql.includes('INSERT INTO AlertHistory'));
  assert.equal(historyWrites.length, 3);

  const triggeredEvents = events.filter(([event]) => event === 'AlertTriggered');
  assert.equal(triggeredEvents.length, 3);
  assert.ok(triggeredEvents.some(([, payload]) => payload.TriggerType === 'CLIENT_OFFLINE'));
  assert.ok(triggeredEvents.some(([, payload]) => payload.TriggerType === 'CLIENT_DEGRADED'));
  assert.ok(triggeredEvents.some(([, payload]) => payload.TriggerType === 'SCRIPT_EXECUTION_FAILED'));
});
