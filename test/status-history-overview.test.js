// The list view's history column reads every row's overall-status series in one
// call (src/main/status-history-overview.ts). What is at stake:
//
//   - the window: too short and the oldest blocks of every row's graph go grey;
//     everything older is payload the renderer throws away, on every refresh,
//     for every row;
//   - the keys: the renderer looks rows up by client/dummy UUID, CheckID and
//     terminal UUID, so a series filed under the wrong key is a grey graph;
//   - a FreeKiosk terminal's flat run is ONE stored sample, possibly from hours
//     ago — dropping it for being outside the window would draw a terminal that
//     has answered steadily all afternoon as having no data at all.
const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');

const History = require('../dist/main/monitoring-history');
const {
  recordFreeKioskHistorySamples,
  dropFreeKioskHistory,
} = require('../dist/main/freekiosk-history');
const {
  getStatusHistoryOverview,
  STATUS_HISTORY_OVERVIEW_WINDOW_MS,
} = require('../dist/main/status-history-overview');

const START = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const at = (Ts) => mock.timers.setTime(Ts);

function resetStores() {
  for (const Type of ['monitor-target', 'dummy-client', 'client']) {
    History.syncEntityHistoryStore(
      Type,
      [],
      () => null,
      () => ({})
    );
  }
  dropFreeKioskHistory('kiosk-1');
}

test.beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: START - 3 * 60 * MINUTE });
  resetStores();
});
test.afterEach(() => mock.timers.reset());

test('the window is an hour plus a minute of slack', () => {
  assert.equal(STATUS_HISTORY_OVERVIEW_WINDOW_MS, 61 * MINUTE);
});

test('each store is keyed the way the renderer looks rows up', () => {
  at(START - 10 * MINUTE);
  History.recordClientHistorySample({ UUID: 'client-1', Online: true, Degraded: false });
  History.recordDummyHistorySample({ UUID: 'dummy-1', Online: false, Degraded: false });
  History.recordMonitoringHistorySample({
    TargetID: 4,
    Checks: [{ CheckID: 9, LastChecked: START, Online: true, Degraded: true, LastLatencyMs: 12 }],
  });
  at(START);

  const Overview = getStatusHistoryOverview();
  assert.deepEqual(Object.keys(Overview.Clients), ['client-1']);
  assert.deepEqual(Object.keys(Overview.Dummies), ['dummy-1']);
  // By check, not by target: the renderer combines a target's checks itself.
  assert.deepEqual(Object.keys(Overview.Checks), ['9']);
  assert.equal(Overview.Checks['9'][0].latencyMs, 12);
  assert.equal(Overview.Dummies['dummy-1'][0].online, false);
});

test('samples older than the window are left out', () => {
  // Alternating states, so the store keeps every reading rather than collapsing.
  at(START - 2 * 60 * MINUTE);
  History.recordClientHistorySample({ UUID: 'client-1', Online: true });
  at(START - 30 * MINUTE);
  History.recordClientHistorySample({ UUID: 'client-1', Online: false });
  at(START - 1 * MINUTE);
  History.recordClientHistorySample({ UUID: 'client-1', Online: true });
  at(START);

  const Samples = getStatusHistoryOverview().Clients['client-1'];
  assert.deepEqual(
    Samples.map((S) => S.ts),
    [START - 30 * MINUTE, START - 1 * MINUTE]
  );
});

test('a client with nothing inside the window is absent rather than empty', () => {
  at(START - 2 * 60 * MINUTE);
  History.recordClientHistorySample({ UUID: 'client-1', Online: true });
  at(START);
  assert.equal(getStatusHistoryOverview().Clients['client-1'], undefined);
});

test('returned samples are copies, not the live store', () => {
  at(START - MINUTE);
  History.recordClientHistorySample({ UUID: 'client-1', Online: true });
  at(START);
  getStatusHistoryOverview().Clients['client-1'][0].online = false;
  assert.equal(History.getClientHistorySamples('client-1')[0].online, true);
});

test('a kiosk keeps the reading its window opens on', () => {
  // Steady for hours: the store holds the run's two endpoints, both older than
  // the window.
  const Terminal = { UUID: 'kiosk-1', Online: true, Metrics: { poll_latencyMs: 20 } };
  recordFreeKioskHistorySamples(Terminal, START - 3 * 60 * MINUTE);
  recordFreeKioskHistorySamples(Terminal, START - 2 * 60 * MINUTE);
  at(START);

  const Samples = getStatusHistoryOverview().Kiosks['kiosk-1'];
  assert.equal(Samples.length, 1, 'the newest pre-window sample is carried');
  assert.equal(Samples[0].ts, START - 2 * 60 * MINUTE);
  assert.equal(Samples[0].ok, true);
});

test('a kiosk sends the pre-window sample plus everything inside the window', () => {
  recordFreeKioskHistorySamples(
    { UUID: 'kiosk-1', Online: true, Metrics: { poll_latencyMs: 20 } },
    START - 2 * 60 * MINUTE
  );
  recordFreeKioskHistorySamples(
    { UUID: 'kiosk-1', Online: false, Metrics: {} },
    START - 10 * MINUTE
  );
  at(START);

  const Samples = getStatusHistoryOverview().Kiosks['kiosk-1'];
  assert.deepEqual(
    Samples.map((S) => [S.ts, S.ok]),
    [
      [START - 2 * 60 * MINUTE, true],
      [START - 10 * MINUTE, false],
    ]
  );
});
