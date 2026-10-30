const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// A check's LastSuccessAt used to be written to the database on every
// successful probe (one autocommit each, ~100/s for 300 checks at 3 s). It is
// now kept current in memory and written only when it matters: the first
// success, the first after a failure, every few minutes, and at shutdown.

const PERSIST_MS = require('../dist/Modules/Config/constants').MONITORING_LAST_SUCCESS_PERSIST_MS;
const distPath = (...P) => path.join(__dirname, '..', 'dist', 'Modules', ...P);

function loadCheck({ writes, results }) {
  return loadWithMocks(distPath('MonitoringTargetManager', 'target.js'), {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': { Manager: {} },
    '../DB/repositories/monitoring-checks': {
      CreateMonitoringChecksRepository: () => ({
        SetLastSuccessAt: async (Ts, CheckID) => {
          writes.push([CheckID, Ts]);
          return [null, { changes: 1 }];
        },
      }),
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../MonitoringMethods': {
      Manager: {
        Run: async () => results.shift(),
        BuildDebug: () => null,
        GetActionOptions: () => ({}),
      },
    },
  }).MonitoringCheck;
}

const Row = (Extra = {}) => ({
  CheckID: 5,
  TargetID: 1,
  Method: 'ping',
  Address: 'a',
  Timestamp: 0,
  ...Extra,
});
const Ok = { Success: true, LatencyMs: 1 };
const Fail = { Success: false, Error: 'down' };

test('a healthy check writes on its first success, then only every few minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const writes = [];
  const results = [];
  const MonitoringCheck = loadCheck({ writes, results });
  const Check = new MonitoringCheck(Row());

  results.push(Ok);
  await Check.Run(1);
  assert.deepEqual(writes, [[5, 1_000_000]], 'first success is written');

  for (let I = 1; I <= 9; I++) {
    t.mock.timers.tick(30_000);
    results.push(Ok);
    await Check.Run(1);
  }
  assert.equal(writes.length, 1, 'steady successes inside the window are not written');
  assert.equal(Check.LastSuccessAt, 1_000_000 + 9 * 30_000, 'but are tracked in memory');

  t.mock.timers.tick(PERSIST_MS - 9 * 30_000);
  results.push(Ok);
  await Check.Run(1);
  assert.equal(writes.length, 2, 'written again once the window has passed');
  assert.equal(writes[1][1], 1_000_000 + PERSIST_MS);
});

test('the first success after a failure is written at once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  const writes = [];
  const results = [];
  const MonitoringCheck = loadCheck({ writes, results });
  const Check = new MonitoringCheck(Row());

  results.push(Ok);
  await Check.Run(1);
  t.mock.timers.tick(10_000);
  results.push(Fail);
  await Check.Run(1);
  assert.equal(Check.Online, false);
  t.mock.timers.tick(10_000);
  results.push(Ok);
  await Check.Run(1);
  assert.deepEqual(
    writes.map((W) => W[1]),
    [2_000_000, 2_020_000]
  );
});

test('the first failure after a run of successes writes the latest success', async (t) => {
  // Otherwise a crash or power loss during the outage would leave "offline
  // since" as stale as the throttle window.
  t.mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
  const writes = [];
  const results = [];
  const MonitoringCheck = loadCheck({ writes, results });
  const Check = new MonitoringCheck(Row());

  results.push(Ok);
  await Check.Run(1);
  t.mock.timers.tick(30_000);
  results.push(Ok);
  await Check.Run(1);
  assert.equal(writes.length, 1, 'the second success is only in memory');

  t.mock.timers.tick(30_000);
  results.push(Fail, Fail);
  await Check.Run(3);
  await Check.Run(3);
  assert.deepEqual(
    writes.map((W) => W[1]),
    [3_000_000, 3_030_000],
    'written once at the first failure, not again'
  );
});

test('a held failure below the threshold still counts as recovering', async (t) => {
  // ConsecutiveFailures > 0 while still reading online: the success that ends
  // the run is written, so the stored value never hides a blip.
  t.mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
  const writes = [];
  const results = [];
  const MonitoringCheck = loadCheck({ writes, results });
  const Check = new MonitoringCheck(Row());
  results.push(Ok, Fail, Ok);
  await Check.Run(3);
  t.mock.timers.tick(1000);
  await Check.Run(3);
  assert.equal(Check.Online, true, 'one miss under a threshold of 3 holds');
  t.mock.timers.tick(1000);
  await Check.Run(3);
  assert.equal(writes.length, 2);
});

test('a check loaded with a stored value is throttled from that value', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 4_000_000 });
  const writes = [];
  const results = [];
  const MonitoringCheck = loadCheck({ writes, results });
  const Check = new MonitoringCheck(Row({ LastSuccessAt: 4_000_000 - 1000 }));
  // Never confirmed online since boot: the first success is written.
  results.push(Ok);
  await Check.Run(1);
  assert.equal(writes.length, 1);
});

test('PersistLastSuccessAt writes only a value that moved, and a failed write is retried', async () => {
  const writes = [];
  const MonitoringCheck = loadCheck({ writes, results: [] });
  const Check = new MonitoringCheck(Row({ LastSuccessAt: 100 }));
  await Check.PersistLastSuccessAt();
  assert.deepEqual(writes, [], 'unchanged since load');
  Check.LastSuccessAt = 200;
  await Check.PersistLastSuccessAt();
  await Check.PersistLastSuccessAt();
  assert.deepEqual(writes, [[5, 200]]);
});

test('Shutdown writes each check’s latest LastSuccessAt', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const writes = [];
  const dbMock = {
    Manager: {
      All: async (sql) => {
        if (String(sql).includes('MonitoringChecks')) {
          return [
            null,
            [70, 71].map((CheckID) => ({
              CheckID,
              TargetID: 7,
              Method: 'http',
              Address: 'x',
              Settings: '{}',
              Weight: CheckID,
              LastSuccessAt: null,
              Timestamp: 1,
            })),
          ];
        }
        return [null, [{ TargetID: 7, Nickname: 'T', Interval: 30000, Weight: 1, Timestamp: 1 }]];
      },
      Get: async () => [null, null],
      Run: async () => [null, { changes: 1 }],
      RunWithoutDirtyTracking: async (sql, params) => {
        if (String(sql).includes('LastSuccessAt')) writes.push(params);
        return [null, { changes: 1 }];
      },
      WithTransaction: async (fn) => [null, await fn(dbMock.Manager.Run)],
    },
  };
  const Manager = loadWithMocks(distPath('MonitoringTargetManager', 'index.js'), {
    '../Logger': { CreateLogger: () => ({ error: () => {}, log: () => {}, warn: () => {} }) },
    '../DB': dbMock,
    '../Broadcast': { Manager: { emit: () => {} } },
    '../MonitoringMethods': {
      Manager: {
        GetTileWidget: () => null,
        Has: () => true,
        NormalizeSettings: (_id, S) => ({ ...S }),
        Run: async () => ({ Success: true }),
        BuildDebug: () => null,
        GetActionOptions: () => ({}),
      },
    },
    '../Utils': require('../dist/Modules/Utils'),
  }).Manager;
  t.after(() => Manager.Shutdown());

  await Manager.Init();
  await Manager.RunAllChecksNow(7);
  assert.deepEqual(writes, [
    [5_000_000, 70],
    [5_000_000, 71],
  ]);
  t.mock.timers.tick(60_000);
  await Manager.RunAllChecksNow(7);
  assert.equal(writes.length, 2, 'a healthy re-check inside the window is not written');

  await Manager.Shutdown();
  assert.deepEqual(writes.slice(2), [
    [5_060_000, 70],
    [5_060_000, 71],
  ]);
  await Manager.Shutdown();
  assert.equal(writes.length, 4, 'a second shutdown has nothing left to write');
});
