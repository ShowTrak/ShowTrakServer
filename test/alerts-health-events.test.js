const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { ALERT_BASELINE_SETTLE_MS } = require('../dist/Modules/Config/constants');

// How the AlertsManager turns a client's health events into alerts: moments
// (a restart, a display unplugged) fire at once; conditions (CPU over its
// threshold, an application hung) raised while the server is still settling are
// held and only announced if they outlast the settle period; and CLIENT_RECOVERED
// follows only a degraded alert that was actually raised.

function rule(TriggerTypes, RuleID = 1) {
  return {
    RuleID,
    Title: `Rule ${RuleID}`,
    Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [] }),
    TriggerType: JSON.stringify(TriggerTypes),
    TriggerConfig: JSON.stringify({}),
    Actions: JSON.stringify([{ Type: 'http-api', Settings: {} }]),
    Enabled: 1,
    Timestamp: 1,
    UpdatedAt: 1,
  };
}

async function load(Rules) {
  const executed = [];
  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js'),
    {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': {
        Manager: {
          All: async () => [null, Rules],
          Run: async () => [null, { changes: 1 }],
          RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
        },
      },
      '../AlertActions': {
        Manager: {
          GetAll: () => [],
          Execute: async (_action, context) => {
            executed.push(context);
            return { Success: true };
          },
        },
      },
      '../Broadcast': { Manager: { emit: () => {} } },
      '../Utils': require('../dist/Modules/Utils'),
    }
  );
  await Manager.Init();
  return { Manager, executed };
}

const CLIENT = { UUID: 'c1', Nickname: 'Media Server', GroupID: 3, IP: '10.0.0.4' };

test.afterEach(() => mock.timers.reset());

test('a health moment is evaluated at once, with its details and a description', async () => {
  const { Manager, executed } = await load([rule(['CLIENT_REBOOTED'])]);
  await Manager.HandleClientHealthEvent(CLIENT, {
    TriggerTypes: ['CLIENT_REBOOTED'],
    Severity: 'warning',
    Details: { UptimeSeconds: 40, PreviousUptimeSeconds: 9000 },
  });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].TriggerType, 'CLIENT_REBOOTED');
  assert.equal(executed[0].EntityName, 'Media Server');
  assert.equal(executed[0].UptimeSeconds, 40);
  assert.equal(executed[0].Description, 'Media Server restarted');
});

test('only rules naming a trigger fire, once per matching trigger', async () => {
  const { Manager, executed } = await load([
    rule(['CRITICAL_DISPLAY_DISCONNECTED'], 1),
    rule(['DISPLAY_DISCONNECTED', 'CRITICAL_DISPLAY_DISCONNECTED'], 2),
    rule(['CLIENT_OFFLINE'], 3),
  ]);
  await Manager.HandleClientHealthEvent(CLIENT, {
    TriggerTypes: ['DISPLAY_DISCONNECTED', 'CRITICAL_DISPLAY_DISCONNECTED'],
    Severity: 'warning',
    Details: { Display: { Label: 'LED Wall' }, IsCritical: true },
  });
  // Rule 1 matches the critical trigger; rule 2 matches both triggers.
  assert.equal(executed.length, 3);
  assert.ok(
    executed.some((C) => C.Description === 'LED Wall (monitored) disconnected from Media Server')
  );
});

test('a condition raised while the server settles is held, then announced if it lasts', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { Manager, executed } = await load([rule(['CPU_USAGE_HIGH'])]);
  await Manager.HandleClientHealthEvent(CLIENT, {
    TriggerTypes: ['CPU_USAGE_HIGH'],
    Severity: 'warning',
    Details: { Metric: 'cpu', Value: 97, Threshold: 90 },
    Condition: { Key: 'resource:cpu', Active: true },
  });
  assert.equal(executed.length, 0, 'held at start-up');

  mock.timers.setTime(Date.now() + ALERT_BASELINE_SETTLE_MS + 1);
  assert.equal(await Manager.FlushSettledBaselineFaults(ALERT_BASELINE_SETTLE_MS), 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].Description, 'Media Server CPU at 97% (limit 90%)');
});

test('a held condition that ends before the settle period is never announced', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { Manager, executed } = await load([rule(['APPLICATION_NOT_RESPONDING'])]);
  await Manager.HandleClientHealthEvent(CLIENT, {
    TriggerTypes: ['APPLICATION_NOT_RESPONDING'],
    Severity: 'warning',
    Details: { Application: { Name: 'QLab' } },
    Condition: { Key: 'app-hung:qlab', Active: true },
  });
  await Manager.HandleClientHealthEvent(CLIENT, {
    TriggerTypes: [],
    Severity: 'success',
    Details: {},
    Condition: { Key: 'app-hung:qlab', Active: false },
  });
  mock.timers.setTime(Date.now() + ALERT_BASELINE_SETTLE_MS + 1);
  assert.equal(await Manager.FlushSettledBaselineFaults(ALERT_BASELINE_SETTLE_MS), 0);
  assert.equal(executed.length, 0);
});

test('once settled, a condition fires the moment it is raised', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { Manager, executed } = await load([rule(['THERMAL_STATE_HIGH'])]);
  mock.timers.setTime(Date.now() + ALERT_BASELINE_SETTLE_MS + 1);
  await Manager.HandleClientHealthEvent(CLIENT, {
    TriggerTypes: ['THERMAL_STATE_HIGH'],
    Severity: 'warning',
    Details: { Metric: 'thermal', Value: 'serious', Threshold: 'fair' },
    Condition: { Key: 'resource:thermal', Active: true },
  });
  assert.equal(executed.length, 1);
  assert.match(executed[0].Description, /throttling/);
});

test('a reserved (unassigned) slot raises nothing', async () => {
  const { Manager, executed } = await load([rule(['CLIENT_REBOOTED'])]);
  await Manager.HandleClientHealthEvent(
    { ...CLIENT, Unassigned: true },
    { TriggerTypes: ['CLIENT_REBOOTED'], Severity: 'warning', Details: {} }
  );
  assert.equal(executed.length, 0);
});

test('CLIENT_RECOVERED follows an announced degraded alert, and only while online', async () => {
  const { Manager, executed } = await load([rule(['CLIENT_DEGRADED', 'CLIENT_RECOVERED'])]);
  const Snapshot = (Online, Degraded) => ({ ...CLIENT, Online, Degraded });

  await Manager.HandleClientUpdated(Snapshot(true, false));
  await Manager.HandleClientUpdated(Snapshot(true, true));
  await Manager.HandleClientUpdated(Snapshot(true, false));
  assert.deepEqual(
    executed.map((C) => C.TriggerType),
    ['CLIENT_DEGRADED', 'CLIENT_RECOVERED']
  );
  assert.equal(executed[1].Description, 'Media Server recovered');

  // Degraded, then dropping offline: not a recovery.
  await Manager.HandleClientUpdated(Snapshot(true, true));
  await Manager.HandleClientUpdated(Snapshot(false, false));
  await Manager.HandleClientUpdated(Snapshot(true, false));
  assert.deepEqual(
    executed.map((C) => C.TriggerType),
    ['CLIENT_DEGRADED', 'CLIENT_RECOVERED', 'CLIENT_DEGRADED']
  );
});

test('a degraded state held at start-up and fixed before announcement does not "recover"', async () => {
  const { Manager, executed } = await load([rule(['CLIENT_RECOVERED'])]);
  await Manager.HandleClientUpdated({ ...CLIENT, Online: true, Degraded: true });
  await Manager.HandleClientUpdated({ ...CLIENT, Online: true, Degraded: false });
  assert.equal(executed.length, 0);
});

test('every new trigger is in the catalog with a name', async () => {
  const { Manager } = await load([]);
  const { TRIGGERS } = require('../dist/Modules/AlertsManager/triggers');
  const Catalog = new Map(Manager.GetTriggers().map((T) => [T.ID, T.Name]));
  for (const ID of Object.values(TRIGGERS)) {
    assert.ok(Catalog.get(ID), `${ID} is offered to rules`);
  }
});
