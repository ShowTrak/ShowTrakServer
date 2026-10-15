const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { HISTORY_RETENTION_MS } = require('../dist/Modules/Config/constants');

// Nothing ShowTrak remembers is kept beyond 12 hours, and a steady signal does
// not cost a reading per heartbeat. These pin both halves: the thinning of
// steady runs in the status timelines (without ever leaving a one-minute block
// empty, which the timeline would draw grey), and the age-out of every store —
// including the ones nothing records into any more.

const History = require(path.join(__dirname, '..', 'dist', 'main', 'monitoring-history.js'));

const START = 1_700_000_000_000;
const startClock = () => mock.timers.enable({ apis: ['Date'], now: START });
const advance = (Ms) => mock.timers.setTime(Date.now() + Ms);

test.beforeEach(() => {
  mock.timers.reset();
  History.syncClientHistoryStore([]);
  History.syncClientApplicationHistoryStore([]);
});
test.afterEach(() => mock.timers.reset());

test('every store shares the 12 hour retention', () => {
  assert.equal(History.MONITORING_HISTORY_MAX_AGE_MS, 12 * 60 * 60 * 1000);
  assert.equal(HISTORY_RETENTION_MS, History.MONITORING_HISTORY_MAX_AGE_MS);
});

test('a client heartbeating every second for an hour keeps a few readings per minute, not 3600', () => {
  startClock();
  for (let Second = 0; Second < 3600; Second++) {
    History.recordClientHistorySample({ UUID: 'steady', Online: true, Degraded: false });
    advance(1000);
  }
  const Samples = History.getClientHistorySamples('steady');
  // About one every 15 seconds: four or five a minute, against sixty before.
  assert.ok(Samples.length <= 300, `kept ${Samples.length}`);
  // No one-minute block of the timeline is left without a reading.
  for (let Minute = 0; Minute < 59; Minute++) {
    const From = START + Minute * 60000;
    assert.ok(
      Samples.some((S) => S.ts >= From && S.ts < From + 60000),
      `minute ${Minute} has a reading`
    );
  }
});

test('a change inside a steady run is recorded the moment it happens', () => {
  startClock();
  for (let Second = 0; Second < 30; Second++) {
    History.recordClientHistorySample({ UUID: 'flip', Online: true, Degraded: false });
    advance(1000);
  }
  History.recordClientHistorySample({ UUID: 'flip', Online: true, Degraded: true });
  const Last = History.getClientHistorySamples('flip').at(-1);
  assert.deepEqual({ ts: Last.ts, degraded: Last.degraded }, { ts: START + 30000, degraded: true });
});

test("an offline client's critical-application history ages out without new samples", () => {
  startClock();
  const Client = {
    UUID: 'gone-quiet',
    Online: true,
    RunningApplications: {
      Status: { State: 'ok' },
      Items: [{ Name: 'QLab', Key: 'qlab', IsCritical: true, IsRunning: true }],
    },
  };
  History.recordClientApplicationHistorySamples(Client);
  assert.equal(History.getClientApplicationHistorySamples('gone-quiet').length, 1);

  // The client goes offline (no further recordings), and half a day passes.
  advance(HISTORY_RETENTION_MS + 1000);
  History.pruneMonitoringHistoryStore();
  assert.deepEqual(History.getClientApplicationHistorySamples('gone-quiet'), []);
});

test('the retention sweep reaches every store', () => {
  startClock();
  History.recordClientHistorySample({ UUID: 'old', Online: false, Degraded: false });
  advance(HISTORY_RETENTION_MS + 1);
  const { SweepExpiredHistory } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'main', 'history-retention.js'),
    {
      '../Modules/Logger': { CreateLogger: () => ({ debug: () => {}, error: () => {} }) },
      '../Modules/ScriptExecutionManager': { Manager: { PruneSettledBefore: () => 0 } },
      // The store under test, not a fresh copy the loader would otherwise build.
      './monitoring-history': History,
      './freekiosk-history': { pruneFreeKioskHistory: () => {} },
    }
  );
  SweepExpiredHistory();
  assert.deepEqual(History.getClientHistorySamples('old'), []);
});

test('alert history is pruned by age as well as by count', async () => {
  const Untracked = [];
  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'index.js'),
    {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': {
        Manager: {
          All: async () => [null, []],
          Run: async () => [null, { changes: 0 }],
          RunWithoutDirtyTracking: async (Sql, Params) => {
            Untracked.push([Sql, Params]);
            return [null, { changes: 0 }];
          },
        },
      },
      '../AlertActions': {
        Manager: { GetAll: () => [], Execute: async () => ({ Success: true }) },
      },
      '../Broadcast': { Manager: { emit: () => {} } },
      '../Utils': require('../dist/Modules/Utils'),
    }
  );
  const Before = Date.now();
  await Manager.Init();
  // Pruning runs asynchronously off Init.
  await new Promise((resolve) => setImmediate(resolve));
  const ByAge = Untracked.find(([Sql]) => Sql.includes('WHERE Timestamp < ?'));
  assert.ok(ByAge, 'an age-based prune ran');
  assert.ok(ByAge[1][0] >= Before - HISTORY_RETENTION_MS - 1000);
  assert.ok(ByAge[1][0] <= Date.now() - HISTORY_RETENTION_MS + 1000);
  assert.ok(
    Untracked.some(([Sql]) => Sql.includes('LIMIT ?')),
    'the row cap still applies'
  );
});
