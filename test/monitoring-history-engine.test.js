const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises the sample engine at the core of src/main/monitoring-history.ts.
//
// The per-entity wrappers already have tests (client-usb-history,
// client-application-history, client-display-history). What was untested is the
// engine underneath: how a sample is recorded, when two samples are collapsed
// into one, when old ones are dropped, and when a whole entity's history is
// evicted.
//
// This store is what draws the status timeline an operator reads to answer "has
// this been flapping all day, or did it just go down?". Two failure directions:
//
//   - collapse too eagerly and a brief outage disappears entirely, so the
//     timeline shows a healthy hour that was not;
//   - collapse too little and a fast poll grows the array without bound for
//     every check, in a process that stays up for the run of a show.

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'monitoring-history.js');

const History = require(MODULE_PATH);
const {
  MONITORING_HISTORY_MAX_AGE_MS,
  recordEntityHistorySample,
  syncEntityHistoryStore,
  getEntityHistorySamples,
  pruneMonitoringHistoryStore,
  recordMonitoringHistorySample,
  syncMonitoringHistoryStore,
  getMonitoringCheckHistory,
  recordDummyHistorySample,
  getDummyHistorySamples,
} = History;

const MONITOR = 'monitor-target';
const DUMMY = 'dummy-client';

const START = 1_700_000_000_000;

/** Take control of the clock; the engine stamps every sample with Date.now(). */
function startClock(At = START) {
  mock.timers.enable({ apis: ['Date'], now: At });
}
const advance = (Ms) => mock.timers.setTime(Date.now() + Ms);

/** Clear every store by syncing each entity type to an empty list. */
function resetStores() {
  for (const Type of [MONITOR, DUMMY, 'client']) {
    syncEntityHistoryStore(
      Type,
      [],
      () => null,
      () => ({})
    );
  }
}

test.beforeEach(() => {
  mock.timers.reset();
  resetStores();
});
test.afterEach(() => mock.timers.reset());

// --- Recording --------------------------------------------------------------

test('a sample is stored against its entity', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, degraded: false, latencyMs: 12 });

  const Samples = getEntityHistorySamples(MONITOR, 7);
  assert.equal(Samples.length, 1);
  assert.deepEqual(Samples[0], { ts: START, online: true, degraded: false, latencyMs: 12 });
});

test('entity types keep separate stores', () => {
  // A monitor check and a dummy client can share a numeric-looking id; mixing
  // them would splice one device's history into another's timeline.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });
  recordEntityHistorySample(DUMMY, '7', { online: false });

  assert.equal(getEntityHistorySamples(MONITOR, 7)[0].online, true);
  assert.equal(getEntityHistorySamples(DUMMY, '7')[0].online, false);
});

test('an unknown entity type is ignored rather than creating a store', () => {
  startClock();
  assert.doesNotThrow(() => recordEntityHistorySample('not-a-type', 1, { online: true }));
  assert.deepEqual(getEntityHistorySamples('not-a-type', 1), []);
});

test('an unusable id is ignored', () => {
  startClock();
  for (const Id of [undefined, 'abc', NaN, {}]) {
    recordEntityHistorySample(MONITOR, Id, { online: true });
    assert.deepEqual(getEntityHistorySamples(MONITOR, Id), [], `id ${String(Id)}`);
  }
});

test('a null monitor id lands under check 0 — documented, not endorsed', () => {
  // Number(null) is a finite 0, so a null id normalises to the key 0 rather
  // than being rejected. Left alone because it is not reachable: both callers
  // that reach this for monitor targets (recordMonitoringHistorySample and
  // syncMonitoringHistoryStore) already skip checks whose CheckID is null, and
  // there is a test below for each.
  startClock();
  recordEntityHistorySample(MONITOR, null, { online: true });
  assert.equal(getEntityHistorySamples(MONITOR, 0).length, 1);
});

test('a dummy id is trimmed, and a blank one is ignored', () => {
  startClock();
  recordEntityHistorySample(DUMMY, '  d-1  ', { online: true });
  assert.equal(getEntityHistorySamples(DUMMY, 'd-1').length, 1);

  for (const Id of ['', '   ', null, 42]) {
    recordEntityHistorySample(DUMMY, Id, { online: true });
  }
  assert.equal(getEntityHistorySamples(DUMMY, '').length, 0);
});

test('a missing sample is ignored', () => {
  startClock();
  for (const Sample of [null, undefined]) {
    recordEntityHistorySample(MONITOR, 7, Sample);
  }
  assert.deepEqual(getEntityHistorySamples(MONITOR, 7), []);
});

test('online and degraded are coerced to real booleans', () => {
  // They are rendered as timeline colours; a truthy string would work by
  // accident and an object would not.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: 'yes', degraded: 1 });

  const [Sample] = getEntityHistorySamples(MONITOR, 7);
  assert.equal(Sample.online, true);
  assert.equal(Sample.degraded, true);
});

test('an unusable latency is stored as null, never as NaN or a bogus zero', () => {
  // The timeline averages latency per block, so one NaN poisons a block's
  // average and one spurious zero drags it down.
  //
  // null is the case that matters most: a check sets LastLatencyMs to null on
  // EVERY failure, so without an explicit guard (Number(null) is a finite 0)
  // every offline sample would be recorded as "answered in 0ms" and averaged
  // into exactly the block an operator inspects after an outage.
  startClock();
  for (const [Index, Latency] of [null, undefined, '', 'fast', -1, NaN, Infinity, {}].entries()) {
    recordEntityHistorySample(MONITOR, 100 + Index, { online: true, latencyMs: Latency });
    const [Sample] = getEntityHistorySamples(MONITOR, 100 + Index);
    assert.equal(Sample.latencyMs, null, `latency ${String(Latency)}`);
  }
});

test('an offline check records no latency at all', () => {
  // The end-to-end shape of the case above, as the monitoring manager produces
  // it: a failed check reports Online false with LastLatencyMs null.
  startClock();
  recordMonitoringHistorySample({
    TargetID: 1,
    Checks: [{ CheckID: 20, Online: false, LastLatencyMs: null }],
  });

  const [Sample] = getMonitoringCheckHistory(20);
  assert.equal(Sample.online, false);
  assert.equal(Sample.latencyMs, null, 'an outage must not read as a 0ms reply');
});

test('a zero latency is kept, because it is a real measurement', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 0 });
  assert.equal(getEntityHistorySamples(MONITOR, 7)[0].latencyMs, 0);
});

// --- Coalescing -------------------------------------------------------------

test('an unchanged sample within a second updates the timestamp instead of appending', () => {
  // Several subsystems can push the same status in quick succession. Appending
  // each one would grow the array without bound across a show-length run.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10 });
  advance(400);
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10 });

  const Samples = getEntityHistorySamples(MONITOR, 7);
  assert.equal(Samples.length, 1);
  assert.equal(Samples[0].ts, START + 400, 'the surviving sample should carry the newer time');
});

test('a STATE CHANGE always appends, however quickly it arrives', () => {
  // The property that keeps a brief outage visible. Collapsing this would erase
  // exactly the event the timeline exists to show.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });
  advance(50);
  recordEntityHistorySample(MONITOR, 7, { online: false });
  advance(50);
  recordEntityHistorySample(MONITOR, 7, { online: true });

  assert.deepEqual(
    getEntityHistorySamples(MONITOR, 7).map((S) => S.online),
    [true, false, true]
  );
});

test('a degraded transition appends even with the same online state', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, degraded: false });
  advance(50);
  recordEntityHistorySample(MONITOR, 7, { online: true, degraded: true });

  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 2);
});

test('samples a second or more apart are always kept separately', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10 });
  advance(900);
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10 });

  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 2);
});

test('a latency change of less than a millisecond does not append', () => {
  // Comparison is on the rounded value, so jitter below the resolution the UI
  // shows does not create a new sample.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10.1 });
  advance(100);
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10.4 });

  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 1);
});

test('a real latency change appends', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10 });
  advance(100);
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 250 });

  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 2);
});

test('gaining or losing a latency reading appends', () => {
  // Going from "answered in 10ms" to "answered with no timing" is a change
  // worth seeing, not the same sample.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: 10 });
  advance(100);
  recordEntityHistorySample(MONITOR, 7, { online: true, latencyMs: null });

  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 2);
});

// --- Ageing out -------------------------------------------------------------

test('the retention window is twelve hours', () => {
  // Long enough to cover a get-in and a show without holding a day of samples
  // per check in memory.
  assert.equal(MONITORING_HISTORY_MAX_AGE_MS, 12 * 60 * 60 * 1000);
});

test('samples older than the window are dropped as new ones arrive', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });

  advance(MONITORING_HISTORY_MAX_AGE_MS + 1000);
  recordEntityHistorySample(MONITOR, 7, { online: false });

  const Samples = getEntityHistorySamples(MONITOR, 7);
  assert.equal(Samples.length, 1);
  assert.equal(Samples[0].online, false);
});

test('a sample exactly at the cutoff is kept', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });
  advance(MONITORING_HISTORY_MAX_AGE_MS);
  recordEntityHistorySample(MONITOR, 7, { online: false });

  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 2);
});

test('pruning removes an entity whose samples have all expired', () => {
  // Without the delete, a check removed from the config would leave an empty
  // array in the store for the life of the process.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });
  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 1);

  advance(MONITORING_HISTORY_MAX_AGE_MS + 1000);
  pruneMonitoringHistoryStore();

  assert.deepEqual(getEntityHistorySamples(MONITOR, 7), []);
});

test('reading history prunes on the way, so a stale timeline is never returned', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });

  advance(MONITORING_HISTORY_MAX_AGE_MS + 1000);
  assert.deepEqual(getEntityHistorySamples(MONITOR, 7), []);
});

// --- Sync and eviction ------------------------------------------------------

test('syncing records a sample for every entity in the list', () => {
  startClock();
  syncEntityHistoryStore(
    MONITOR,
    [
      { id: 1, up: true },
      { id: 2, up: false },
    ],
    (Item) => Item.id,
    (Item) => ({ online: Item.up })
  );

  assert.equal(getEntityHistorySamples(MONITOR, 1)[0].online, true);
  assert.equal(getEntityHistorySamples(MONITOR, 2)[0].online, false);
});

test('syncing evicts entities that are no longer in the list', () => {
  // A check the operator deleted must not keep its history: the next check to
  // reuse that id would inherit a timeline that was never its own.
  startClock();
  syncEntityHistoryStore(
    MONITOR,
    [{ id: 1 }, { id: 2 }],
    (I) => I.id,
    () => ({ online: true })
  );
  assert.equal(getEntityHistorySamples(MONITOR, 2).length, 1);

  syncEntityHistoryStore(
    MONITOR,
    [{ id: 1 }],
    (I) => I.id,
    () => ({ online: true })
  );

  assert.equal(getEntityHistorySamples(MONITOR, 1).length, 1, 'the surviving entity was evicted');
  assert.deepEqual(getEntityHistorySamples(MONITOR, 2), []);
});

test('syncing an empty or absent list clears the store', () => {
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });

  for (const List of [[], null, undefined, 'nope']) {
    syncEntityHistoryStore(
      MONITOR,
      List,
      (I) => I && I.id,
      () => ({ online: true })
    );
    assert.deepEqual(getEntityHistorySamples(MONITOR, 7), [], `list ${JSON.stringify(List)}`);
  }
});

test('entries with an unusable key are skipped without evicting the rest', () => {
  startClock();
  syncEntityHistoryStore(
    MONITOR,
    [{ id: 1 }, { id: null }, { id: 'abc' }, { id: 2 }],
    (I) => I.id,
    () => ({ online: true })
  );

  assert.equal(getEntityHistorySamples(MONITOR, 1).length, 1);
  assert.equal(getEntityHistorySamples(MONITOR, 2).length, 1);
});

test('syncing without usable resolvers does nothing rather than wiping the store', () => {
  // A caller mistake must not clear a timeline the operator is looking at.
  startClock();
  recordEntityHistorySample(MONITOR, 7, { online: true });

  for (const [Key, Sample] of [
    [null, () => ({})],
    [(I) => I, null],
    ['nope', 'nope'],
  ]) {
    syncEntityHistoryStore(MONITOR, [{ id: 7 }], Key, Sample);
  }
  assert.equal(getEntityHistorySamples(MONITOR, 7).length, 1);
});

// --- The monitoring and dummy wrappers -------------------------------------

test('a monitoring target records one sample per check', () => {
  // History is per CHECK, not per target: a target with a failing ping and a
  // healthy HTTP check has two different stories to tell.
  startClock();
  recordMonitoringHistorySample({
    TargetID: 1,
    Checks: [
      { CheckID: 10, Online: true, LastLatencyMs: 5 },
      { CheckID: 11, Online: false },
    ],
  });

  assert.equal(getMonitoringCheckHistory(10)[0].online, true);
  assert.equal(getMonitoringCheckHistory(10)[0].latencyMs, 5);
  assert.equal(getMonitoringCheckHistory(11)[0].online, false);
});

test('a target with no id or no checks records nothing', () => {
  startClock();
  for (const Target of [
    null,
    undefined,
    {},
    { TargetID: 0 },
    { TargetID: 1 },
    { TargetID: 1, Checks: 'nope' },
  ]) {
    assert.doesNotThrow(() => recordMonitoringHistorySample(Target));
  }
  assert.deepEqual(getMonitoringCheckHistory(10), []);
});

test('a check with no id is skipped without losing its siblings', () => {
  startClock();
  recordMonitoringHistorySample({
    TargetID: 1,
    Checks: [null, { CheckID: null }, { CheckID: 12, Online: true }],
  });

  assert.equal(getMonitoringCheckHistory(12).length, 1);
});

test('syncing targets evicts checks that no longer exist', () => {
  // Deleting a check from a target must take its timeline with it.
  startClock();
  syncMonitoringHistoryStore([
    {
      TargetID: 1,
      Checks: [
        { CheckID: 10, Online: true },
        { CheckID: 11, Online: true },
      ],
    },
  ]);
  assert.equal(getMonitoringCheckHistory(11).length, 1);

  syncMonitoringHistoryStore([{ TargetID: 1, Checks: [{ CheckID: 10, Online: true }] }]);

  assert.equal(getMonitoringCheckHistory(10).length, 1);
  assert.deepEqual(getMonitoringCheckHistory(11), []);
});

test('a dummy client records against its UUID', () => {
  startClock();
  recordDummyHistorySample({ UUID: 'd-1', Online: true, Degraded: true });

  const [Sample] = getDummyHistorySamples('d-1');
  assert.equal(Sample.online, true);
  assert.equal(Sample.degraded, true);
});

test('a dummy with no UUID records nothing', () => {
  startClock();
  for (const Dummy of [null, undefined, {}, { UUID: '' }]) {
    assert.doesNotThrow(() => recordDummyHistorySample(Dummy));
  }
  assert.deepEqual(getDummyHistorySamples(''), []);
});
