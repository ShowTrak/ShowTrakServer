// The list view's history column reads every row's overall-status series in one
// call (src/main/status-history-overview.ts). What is at stake:
//
//   - the window: too short and the oldest blocks of every row's graph go grey;
//     everything older is payload the renderer throws away, on every refresh,
//     for every row;
//   - the keys: the renderer looks rows up by client/dummy UUID, CheckID and
//     terminal UUID, so a series filed under the wrong key is a grey graph;
//   - a FreeKiosk terminal's flat run is ONE stored sample, possibly from hours
//     ago; dropping it for being outside the window would draw a terminal that
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

// --- Monitored items of expanded clients ---------------------------------------
//
// An expanded client in the list shows a row per monitored item, each with its
// own timeline. Those series are read only for the clients the renderer names
// (every client's every item on every refresh would be wasted payload), and are
// keyed `<kind>:<item key>`, which is how lib/client-items.ts looks rows up.

function recordItems(UUID, { Online = true, CpuFailing = false, AppRunning = true } = {}) {
  const Client = {
    UUID,
    Online,
    SystemChecks: { Cpu: { MaxPercent: 90 } },
    ResourceAlarms: CpuFailing ? [{ Key: 'cpu' }] : [],
    RunningApplications: {
      Status: { State: 'ok' },
      Items: [{ IsCritical: true, Key: 'qlab', Name: 'QLab', IsRunning: AppRunning }],
    },
    USBDeviceList: [
      { IsCritical: true, SerialNumber: 'SN1', ProductName: 'Stream Deck' },
      { IsCritical: true, IsCriticalByName: true, NameKey: 'Gamepad', ProductName: 'Gamepad' },
    ],
  };
  History.recordClientSystemCheckHistorySamples(Client);
  History.recordClientApplicationHistorySamples(Client);
  History.recordClientUSBHistorySamples(Client);
}

function dropItems() {
  for (const Sync of [
    History.syncClientSystemCheckHistoryStore,
    History.syncClientApplicationHistoryStore,
    History.syncClientUSBHistoryStore,
  ]) {
    Sync([]);
  }
}

test('no items are read unless clients are named', () => {
  dropItems();
  at(START - MINUTE);
  recordItems('client-1');
  at(START);
  assert.equal(getStatusHistoryOverview().ClientItems, undefined);
  assert.equal(getStatusHistoryOverview(START, { Clients: [] }).ClientItems, undefined);
  assert.equal(getStatusHistoryOverview(START, { Clients: 'client-1' }).ClientItems, undefined);
  // A bare list (no { Clients }) is not a request.
  assert.equal(getStatusHistoryOverview(START, ['client-1']).ClientItems, undefined);
});

test("a named client's items are keyed the way the renderer looks rows up", () => {
  dropItems();
  at(START - 10 * MINUTE);
  recordItems('client-1', { CpuFailing: true, AppRunning: false });
  recordItems('client-2');
  at(START);

  const Items = getStatusHistoryOverview(START, { Clients: ['client-1'] }).ClientItems;
  assert.deepEqual(Object.keys(Items), ['client-1'], 'only the clients named');
  assert.deepEqual(Object.keys(Items['client-1']).sort(), [
    'app:qlab',
    'system:cpu',
    'usb:SN1',
    'usb:usbname:gamepad',
  ]);
  assert.equal(Items['client-1']['system:cpu'][0].degraded, true);
  assert.equal(Items['client-1']['app:qlab'][0].online, false);
});

test('item samples older than the window are left out, and junk names are ignored', () => {
  dropItems();
  at(START - 2 * 60 * MINUTE);
  recordItems('client-1', { AppRunning: true });
  at(START - 5 * MINUTE);
  recordItems('client-1', { AppRunning: false });
  at(START);

  const Items = getStatusHistoryOverview(START, {
    Clients: [42, null, 'x'.repeat(200), 'client-1', 'client-1'],
  }).ClientItems;
  assert.deepEqual(Object.keys(Items), ['client-1']);
  assert.deepEqual(
    Items['client-1']['app:qlab'].map((S) => [S.ts, S.online]),
    [[START - 5 * MINUTE, false]]
  );
});

test('a named client with no monitored items gets an empty map', () => {
  dropItems();
  at(START);
  assert.deepEqual(getStatusHistoryOverview(START, { Clients: ['client-9'] }).ClientItems, {
    'client-9': {},
  });
});

// --- Monitored readings of expanded FreeKiosk terminals ------------------------

test("a named terminal's armed readings come back by metric, with the sample the window opens on", () => {
  dropFreeKioskHistory('kiosk-1');
  const Terminal = (Level) => ({
    UUID: 'kiosk-1',
    Online: true,
    Settings: { A_battery_level_On: true, A_battery_level_Op: 'below', A_battery_level_V: 20 },
    Metrics: { battery_level: Level, poll_latencyMs: 20, screen_brightness: 50 },
    Alarms: Level < 20 ? [{ Key: 'battery_level' }] : [],
  });
  recordFreeKioskHistorySamples(Terminal(80), START - 2 * 60 * MINUTE);
  recordFreeKioskHistorySamples(Terminal(10), START - 5 * MINUTE);
  at(START);

  const Overview = getStatusHistoryOverview(START, { Kiosks: ['kiosk-1'] });
  assert.equal(Overview.ClientItems, undefined, 'no clients were named');
  const Series = Overview.KioskItems['kiosk-1'];
  assert.ok(Series.battery_level, 'the armed reading');
  assert.equal(Series.screen_brightness, undefined, 'an unarmed reading is never recorded');
  assert.deepEqual(
    Series.battery_level.map((S) => [S.ts, S.n, S.breach]),
    [
      [START - 2 * 60 * MINUTE, 80, false],
      [START - 5 * MINUTE, 10, true],
    ]
  );
  assert.equal(getStatusHistoryOverview(START).KioskItems, undefined);
  assert.deepEqual(getStatusHistoryOverview(START, { Kiosks: ['nope'] }).KioskItems, { nope: {} });
});
