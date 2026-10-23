const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const modulePath = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'MonitoringTargetManager',
  'target.js'
);

const { MonitoringTarget } = loadWithMocks(modulePath, {
  '../Logger': { CreateLogger: () => ({ error: () => {} }) },
  '../DB': { Manager: { Run: async () => [null, { changes: 1 }] } },
  '../Broadcast': { Manager: { emit: () => {} } },
  '../MonitoringMethods': {
    Manager: { Run: async () => ({ Success: true, LatencyMs: 10 }), GetTileWidget: () => null },
  },
});

function buildTarget(checks) {
  const target = new MonitoringTarget(
    {
      TargetID: 1,
      Nickname: 'Test Target',
      Interval: 30000,
      GroupID: null,
      Weight: 100,
      Timestamp: Date.now(),
    },
    checks
  );

  target.Checks.forEach((check, index) => {
    const state = checks[index].State || {};
    // Every fixture describes a check that has reached a verdict unless it says
    // otherwise; one with no verdict is left out of the aggregate.
    check.LastChecked = state.LastChecked === undefined ? 1 : state.LastChecked;
    check.Online = !!state.Online;
    check.Degraded = !!state.Degraded;
    check.LastError = state.LastError || null;
    check.LastLatencyMs =
      typeof state.LastLatencyMs === 'number' ? state.LastLatencyMs : check.LastLatencyMs;
  });

  target.RecomputeAggregate();
  return target;
}

test('MonitoringTarget aggregate reports multiple faults for mixed degraded/offline checks', () => {
  const target = buildTarget([
    {
      CheckID: 11,
      TargetID: 1,
      Name: 'HTTP Health',
      Address: 'a.local',
      Method: 'http',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: false, LastError: 'Connection refused' },
    },
    {
      CheckID: 12,
      TargetID: 1,
      Name: 'QLab',
      Address: 'b.local',
      Method: 'qlab5',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: true, Degraded: true, LastError: 'Incorrect Workspace' },
    },
  ]);

  assert.equal(target.Online, true);
  assert.equal(target.Degraded, true);
  assert.equal(target.LastError, 'Multiple faults (1 down, 1 degraded)');
});

test('MonitoringTarget aggregate reports multiple faults when multiple checks are degraded', () => {
  const target = buildTarget([
    {
      CheckID: 21,
      TargetID: 1,
      Name: 'Check A',
      Address: 'a.local',
      Method: 'http',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: true, Degraded: true, LastError: 'High latency' },
    },
    {
      CheckID: 22,
      TargetID: 1,
      Name: 'Check B',
      Address: 'b.local',
      Method: 'ping',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: true, Degraded: true, LastError: 'High latency' },
    },
  ]);

  assert.equal(target.Online, true);
  assert.equal(target.Degraded, true);
  assert.equal(target.LastError, 'Multiple faults (2 degraded checks)');
});

test('MonitoringTarget aggregate reports multiple faults when all checks are offline', () => {
  const target = buildTarget([
    {
      CheckID: 31,
      TargetID: 1,
      Name: 'Check A',
      Address: 'a.local',
      Method: 'http',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: false, LastError: 'Timeout' },
    },
    {
      CheckID: 32,
      TargetID: 1,
      Name: 'Check B',
      Address: 'b.local',
      Method: 'ping',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: false, LastError: 'Timeout' },
    },
  ]);

  assert.equal(target.Online, false);
  assert.equal(target.Degraded, false);
  assert.equal(target.LastError, 'Multiple faults (2 checks down)');
});

test('MonitoringTarget aggregate preserves single degraded reason for one faulted check', () => {
  const target = buildTarget([
    {
      CheckID: 41,
      TargetID: 1,
      Name: 'Check A',
      Address: 'a.local',
      Method: 'http',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: true, Degraded: true, LastError: 'Incorrect Workspace' },
    },
    {
      CheckID: 42,
      TargetID: 1,
      Name: 'Check B',
      Address: 'b.local',
      Method: 'ping',
      Settings: '{}',
      DegradedThresholdMs: 1000,
      Weight: 100,
      LastSuccessAt: null,
      Timestamp: 1,
      State: { Online: true, Degraded: false, LastLatencyMs: 25 },
    },
  ]);

  assert.equal(target.Online, true);
  assert.equal(target.Degraded, true);
  assert.equal(target.LastError, 'Incorrect Workspace');
});

test('MonitoringTarget with no checks is idle (Online=false, Degraded=false, LastError=null)', () => {
  const target = new MonitoringTarget({
    TargetID: 99,
    Nickname: 'Empty Target',
    Interval: 30000,
    GroupID: null,
    Weight: 100,
    Timestamp: Date.now(),
  });

  assert.equal(target.Online, false);
  assert.equal(target.Degraded, false);
  assert.equal(target.LastError, null);
  assert.equal(target.Checks.length, 0);

  // RecomputeAggregate should preserve idle state.
  target.RecomputeAggregate();
  assert.equal(target.Online, false);
  assert.equal(target.Degraded, false);
  assert.equal(target.LastError, null);
});

test('MonitoringTarget aggregate leaves checks with no verdict out', () => {
  // A check still inside its failure threshold on first contact is unknown, not
  // down, so a sibling that is healthy carries the target on its own.
  const target = buildTarget([
    {
      CheckID: 31,
      TargetID: 1,
      Method: 'ping',
      Timestamp: 1,
      State: { Online: true, LastLatencyMs: 4 },
    },
    {
      CheckID: 32,
      TargetID: 1,
      Method: 'http',
      Timestamp: 1,
      State: { Online: false, LastChecked: null },
    },
  ]);

  assert.equal(target.Online, true);
  assert.equal(target.Degraded, false);
  assert.equal(target.LastError, null);
});

test('MonitoringTarget with no verdict on any check has no LastChecked', () => {
  // LastChecked null is what the tile reads as "Checking" and what alerts and
  // history read as "nothing to record yet".
  const target = buildTarget([
    {
      CheckID: 33,
      TargetID: 1,
      Method: 'ping',
      Timestamp: 1,
      State: { Online: false, LastChecked: null },
    },
  ]);

  assert.equal(target.LastChecked, null);
  assert.equal(target.Online, false);
  assert.equal(target.LastError, null);
});
