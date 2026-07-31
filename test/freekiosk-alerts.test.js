// FreeKiosk metric alarms as alert triggers.
//
// Two behaviours matter here and neither is obvious from the code:
//
//   1. An alarm fires ONCE, on the false->true edge. A terminal polling every
//      30 seconds with a flat battery would otherwise raise an alert every 30
//      seconds for as long as it stayed flat.
//   2. Something already breaching the first time ShowTrak sees a terminal is a
//      pre-existing condition, not an event. Alerting on it would mean every
//      restart mid-show fires every alarm at once — the same reason a client
//      that was already offline at start-up is suppressed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { TRIGGERS } = require('../dist/Modules/AlertsManager/triggers');
const { triggerMatches } = require('../dist/Modules/AlertsManager/evaluation');

// A rule that watches the whole workspace for FreeKiosk metric alarms.
function rule(overrides = {}) {
  return {
    RuleID: 1,
    Title: 'Kiosk alarms',
    Scope: JSON.stringify({ Workspace: true, Groups: [], Clients: [], Tags: [] }),
    TriggerType: JSON.stringify([TRIGGERS.FREEKIOSK_METRIC_ALARM]),
    TriggerConfig: JSON.stringify(overrides.TriggerConfig || {}),
    Actions: JSON.stringify([{ Type: 'http-api', Settings: {} }]),
    Enabled: 1,
    Timestamp: 1,
    UpdatedAt: 1,
  };
}

function boot(rules = [rule()]) {
  const executed = [];
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {}, debug: () => {}, log: () => {} }) },
    '../DB': {
      Manager: {
        All: async (sql) => (String(sql).includes('AlertRules') ? [null, rules] : [null, []]),
        Run: async () => [null, { changes: 1 }],
        Get: async () => [null, null],
      },
    },
    '../AlertActions': {
      Manager: {
        GetAll: () => [{ ID: 'http-api', Name: 'HTTP API' }],
        // AlertActions.Execute(Action, EventContext) — the context is the
        // second argument, not the third.
        Execute: async (_action, context) => {
          executed.push(context);
          return { Success: true };
        },
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../Utils': require('../dist/Modules/Utils'),
    '../TagManager': { Manager: { GetAllViews: async () => [] } },
  });
  return { Manager, executed };
}

function terminal(alarms, overrides = {}) {
  return {
    UUID: 'kiosk-1',
    Nickname: 'Lobby Kiosk',
    Online: true,
    Degraded: alarms.length > 0,
    GroupID: null,
    IP: '10.0.0.5',
    Alarms: alarms,
    ...overrides,
  };
}

const BATTERY = {
  Key: 'battery_level',
  Label: 'Battery Level',
  Value: 12,
  Reason: 'Battery Level 12% is below 20%',
};
const SCREEN = {
  Key: 'content_displaying',
  Label: 'Displaying Content',
  Value: false,
  Reason: 'Displaying Content: No',
};

test('the metric alarm trigger is offered to the rule editor', async () => {
  const { Manager } = boot();
  const ids = Manager.GetTriggers().map((t) => t.ID);
  assert.ok(ids.includes(TRIGGERS.FREEKIOSK_METRIC_ALARM));
});

test('an alarm that starts breaching fires once, not on every poll', async () => {
  const { Manager, executed } = boot();
  await Manager.Init();

  // First sighting establishes the baseline; nothing is breaching yet.
  await Manager.HandleFreeKioskTerminalUpdated(terminal([]));
  assert.equal(executed.length, 0);

  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));
  assert.equal(executed.length, 1);
  assert.equal(executed[0].MetricKey, 'battery_level');
  assert.equal(executed[0].EntityType, 'freekiosk');
  assert.equal(executed[0].EntityName, 'Lobby Kiosk');
  assert.match(executed[0].Description, /Lobby Kiosk — Battery Level 12% is below 20%/);

  // Still breaching on the next three polls — no further alerts.
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));
  assert.equal(executed.length, 1);
});

test('an alarm that clears and returns fires again', async () => {
  const { Manager, executed } = boot();
  await Manager.Init();

  await Manager.HandleFreeKioskTerminalUpdated(terminal([]));
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));
  assert.equal(executed.length, 1);

  await Manager.HandleFreeKioskTerminalUpdated(terminal([]));
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));
  assert.equal(executed.length, 2);
});

test('an alarm already breaching at start-up is a baseline, not an event', async () => {
  // Otherwise restarting ShowTrak mid-show fires every armed alarm at once.
  const { Manager, executed } = boot();
  await Manager.Init();

  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY, SCREEN]));
  assert.equal(executed.length, 0);

  // A NEW alarm appearing afterwards is a real event and does fire.
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY, SCREEN]));
  assert.equal(executed.length, 0);
});

test('each metric is tracked separately', async () => {
  const { Manager, executed } = boot();
  await Manager.Init();

  await Manager.HandleFreeKioskTerminalUpdated(terminal([]));
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));
  assert.equal(executed.length, 1);

  // Screen alarm joins while the battery one is still breaching: one new alert,
  // not two, and not zero.
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY, SCREEN]));
  assert.equal(executed.length, 2);
  assert.equal(executed[1].MetricKey, 'content_displaying');
});

test('the alert context carries everything an action template needs', async () => {
  const { Manager, executed } = boot();
  await Manager.Init();
  await Manager.HandleFreeKioskTerminalUpdated(terminal([]));
  await Manager.HandleFreeKioskTerminalUpdated(terminal([BATTERY]));

  const context = executed[0];
  assert.equal(context.MetricKey, 'battery_level');
  assert.equal(context.MetricLabel, 'Battery Level');
  assert.equal(context.MetricValue, 12);
  assert.equal(context.Reason, 'Battery Level 12% is below 20%');
  assert.equal(context.UUID, 'kiosk-1');
  assert.equal(context.IP, '10.0.0.5');
  assert.equal(context.Severity, 'warning');
});

test('a junk or identity-less snapshot is ignored rather than throwing', async () => {
  const { Manager } = boot();
  await Manager.Init();
  for (const input of [null, undefined, {}, { UUID: '' }, { UUID: 'x' }]) {
    await assert.doesNotReject(() => Manager.HandleFreeKioskTerminalUpdated(input));
  }
});

// ---- The metric filter ----------------------------------------------------

const context = (metricKey) => ({
  TriggerType: TRIGGERS.FREEKIOSK_METRIC_ALARM,
  EntityType: 'freekiosk',
  UUID: 'kiosk-1',
  MetricKey: metricKey,
});

test('an unfiltered rule matches every metric', () => {
  // Rules saved before the filter existed have no Metrics list and must keep
  // matching everything rather than silently going quiet.
  for (const config of [{}, { Metrics: [] }, { Metrics: null }]) {
    const Rule = { TriggerTypes: [TRIGGERS.FREEKIOSK_METRIC_ALARM], TriggerConfig: config };
    assert.equal(triggerMatches(Rule, context('battery_level')), true, JSON.stringify(config));
    assert.equal(triggerMatches(Rule, context('wifi_ssid')), true);
  }
});

test('a filtered rule matches only the metrics it names', () => {
  const Rule = {
    TriggerTypes: [TRIGGERS.FREEKIOSK_METRIC_ALARM],
    TriggerConfig: { Metrics: ['battery_level', 'battery_temperature'] },
  };
  assert.equal(triggerMatches(Rule, context('battery_level')), true);
  assert.equal(triggerMatches(Rule, context('battery_temperature')), true);
  assert.equal(triggerMatches(Rule, context('wifi_ssid')), false);
});

test('the metric trigger does not fire on unrelated events', () => {
  const Rule = { TriggerTypes: [TRIGGERS.FREEKIOSK_METRIC_ALARM], TriggerConfig: {} };
  assert.equal(
    triggerMatches(Rule, { TriggerType: TRIGGERS.CLIENT_OFFLINE, EntityType: 'freekiosk' }),
    false
  );
});

test('a client-degraded rule still covers a terminal, via the shared lifecycle', () => {
  // The terminal's online/degraded lifecycle is routed through the client
  // handler, so it presents as EntityType 'client' and existing rules keep
  // working with no per-type configuration.
  const Rule = {
    TriggerTypes: [TRIGGERS.CLIENT_DEGRADED],
    TriggerConfig: {},
  };
  assert.equal(
    triggerMatches(Rule, {
      TriggerType: TRIGGERS.CLIENT_DEGRADED,
      EntityType: 'client',
      Degraded: true,
    }),
    true
  );
});
