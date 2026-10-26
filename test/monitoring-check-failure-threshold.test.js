const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// The failure threshold is what stops one dropped packet from painting a
// device red and paging someone. A check only reads offline after N failed
// probes IN A ROW; below that its last verdict stands. The resolution order is
// check -> target -> server-wide setting, and each level's null means inherit.

const DIR = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringTargetManager');

// Results the mocked probe hands back, in order. Each test fills it.
let probeResults = [];

function load() {
  const { MonitoringTarget } = loadWithMocks(path.join(DIR, 'target.js'), {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': { Manager: { Run: async () => [null, { changes: 1 }] } },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../MonitoringMethods': {
      Manager: {
        GetTileWidget: () => null,
        Run: async () => probeResults.shift(),
        BuildDebug: () => null,
        GetActionOptions: () => ({}),
      },
    },
  });
  // Same instance target.js required: loadWithMocks evicted the folder, so
  // this is the fresh copy with the compiled-in default of 1.
  const Normalize = require(path.join(DIR, 'normalize.js'));
  return { MonitoringTarget, Normalize };
}

const OK = { Success: true, LatencyMs: 5 };
const FAIL = { Success: false, Error: 'Timed out' };

function makeTarget(MonitoringTarget, { targetThreshold, checkThreshold } = {}) {
  return new MonitoringTarget(
    { TargetID: 1, Nickname: 'Projector', Interval: 30000, FailureThreshold: targetThreshold },
    [
      {
        CheckID: 10,
        TargetID: 1,
        Method: 'ping',
        Address: '10.0.0.1',
        FailureThreshold: checkThreshold,
        Timestamp: 1,
      },
    ]
  );
}

async function runAll(target, results) {
  probeResults = results.slice();
  for (let i = 0; i < results.length; i++) await target.RunChecks();
}

test('with the default threshold of 1 the first failure is an outage', async () => {
  const { MonitoringTarget } = load();
  const target = makeTarget(MonitoringTarget);
  await runAll(target, [OK, FAIL]);

  const [check] = target.Checks;
  assert.equal(check.Online, false);
  assert.equal(check.LastError, 'Timed out');
  assert.equal(target.Online, false);
});

test('an online check rides out misses below the threshold', async () => {
  const { MonitoringTarget } = load();
  const target = makeTarget(MonitoringTarget, { targetThreshold: 3 });
  await runAll(target, [OK, FAIL, FAIL]);

  const [check] = target.Checks;
  assert.equal(check.Online, true, 'two misses of three is not offline');
  assert.equal(check.ConsecutiveFailures, 2);
  assert.equal(check.LastLatencyMs, 5, 'the last good reading is kept');
  assert.equal(check.LastError, null);
  assert.equal(target.Online, true);

  const view = target.ToJSON().Checks[0];
  assert.equal(view.ConsecutiveFailures, 2);
  assert.equal(view.EffectiveFailureThreshold, 3);
});

test('the Nth failure in a row marks the check offline', async () => {
  const { MonitoringTarget } = load();
  const target = makeTarget(MonitoringTarget, { targetThreshold: 3 });
  await runAll(target, [OK, FAIL, FAIL, FAIL]);

  assert.equal(target.Checks[0].Online, false);
  assert.equal(target.Checks[0].LastError, 'Timed out');
  assert.equal(target.Online, false);
});

test('a success resets the run, so scattered misses never add up', async () => {
  const { MonitoringTarget } = load();
  const target = makeTarget(MonitoringTarget, { targetThreshold: 3 });
  await runAll(target, [OK, FAIL, FAIL, OK, FAIL, FAIL]);

  assert.equal(target.Checks[0].Online, true);
  assert.equal(target.Checks[0].ConsecutiveFailures, 2);
});

test('a check that has never answered stays unknown until the threshold is met', async () => {
  // Unknown is not down: a device that drops the very first probe after the
  // server starts must read "Checking", not offline.
  const { MonitoringTarget } = load();
  const target = makeTarget(MonitoringTarget, { targetThreshold: 2 });

  await runAll(target, [FAIL]);
  assert.equal(target.Checks[0].LastChecked, null);
  assert.equal(target.LastChecked, null);
  assert.equal(target.Online, false);
  assert.equal(target.LastError, null);

  probeResults = [FAIL];
  await target.RunChecks();
  assert.notEqual(target.Checks[0].LastChecked, null, 'now it is a verdict');
  assert.equal(target.Checks[0].Online, false);
  assert.equal(target.LastError, 'Timed out');
});

test('an offline check stays offline on the next failure without re-counting', async () => {
  const { MonitoringTarget } = load();
  const target = makeTarget(MonitoringTarget, { targetThreshold: 2 });
  await runAll(target, [FAIL, FAIL]);
  // Raising the threshold while it is down must not flip it back to "online".
  target.FailureThreshold = 10;
  probeResults = [{ Success: false, Error: 'Refused' }];
  await target.RunChecks();

  assert.equal(target.Checks[0].Online, false);
  assert.equal(target.Checks[0].LastError, 'Refused');
});

test('a check override beats the target, and the target beats the global', async () => {
  const { MonitoringTarget, Normalize } = load();
  Normalize.SetDefaultFailureThreshold(5);

  const inherits = makeTarget(MonitoringTarget);
  assert.equal(inherits.ToJSON().Checks[0].EffectiveFailureThreshold, 5);

  const targetLevel = makeTarget(MonitoringTarget, { targetThreshold: 3 });
  assert.equal(targetLevel.ToJSON().Checks[0].EffectiveFailureThreshold, 3);

  const checkLevel = makeTarget(MonitoringTarget, { targetThreshold: 3, checkThreshold: 1 });
  assert.equal(checkLevel.ToJSON().Checks[0].EffectiveFailureThreshold, 1);
  await runAll(checkLevel, [OK, FAIL]);
  assert.equal(checkLevel.Checks[0].Online, false, 'the check said 1, so one miss is enough');
});

test('a change to the global setting applies from the next probe', async () => {
  const { MonitoringTarget, Normalize } = load();
  const target = makeTarget(MonitoringTarget);
  await runAll(target, [OK]);

  Normalize.SetDefaultFailureThreshold(2);
  probeResults = [FAIL];
  await target.RunChecks();
  assert.equal(target.Checks[0].Online, true);
});

test('thresholds are clamped to 1-10 and blanks mean inherit', () => {
  const { Normalize } = load();
  assert.equal(Normalize.ClampFailureThreshold(null), null);
  assert.equal(Normalize.ClampFailureThreshold(undefined), null);
  assert.equal(Normalize.ClampFailureThreshold(''), null);
  assert.equal(Normalize.ClampFailureThreshold('abc'), null);
  assert.equal(Normalize.ClampFailureThreshold(0), 1);
  assert.equal(Normalize.ClampFailureThreshold(99), 10);
  assert.equal(Normalize.ClampFailureThreshold('4'), 4);

  // A garbage global value is ignored rather than wiping the current default.
  Normalize.SetDefaultFailureThreshold(4);
  Normalize.SetDefaultFailureThreshold('nope');
  assert.equal(Normalize.GetDefaultFailureThreshold(), 4);
});
