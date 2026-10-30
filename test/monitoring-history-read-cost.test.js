// Reads of the in-memory status history no longer prune every store (that was
// a walk over every series of every client and check, three times per list-view
// poll), and the named per-entity stores no longer copy a whole series on every
// sample. These pin what that must not change: an expired sample never comes
// back from a read even before the sweep runs, and a series a reader holds
// never moves under it.
const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');

const History = require('../dist/main/monitoring-history');
const { HISTORY_RETENTION_MS } = require('../dist/Modules/Config/constants');

const START = 1_700_000_000_000;
const at = (Ts) => mock.timers.setTime(Ts);

test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: START }));
test.afterEach(() => {
  for (const Type of ['monitor-target', 'dummy-client', 'client']) {
    History.syncEntityHistoryStore(
      Type,
      [],
      () => null,
      () => ({})
    );
  }
  History.syncClientUSBHistoryStore([]);
  mock.timers.reset();
});

test('an expired sample is not returned by a read, though no sweep has run', () => {
  History.recordClientHistorySample({ UUID: 'idle', Online: false });
  History.recordClientHistorySample({ UUID: 'busy', Online: true });
  at(START + HISTORY_RETENTION_MS + 60_000);
  // 'busy' keeps reporting; 'idle' went quiet, so nothing trims its series.
  History.recordClientHistorySample({ UUID: 'busy', Online: true });

  assert.deepEqual(History.getClientHistorySamples('idle'), []);
  assert.equal(History.getClientHistorySamples('busy').length, 1);
  const Overview = History.getStatusHistoryOverviewSamples(0);
  assert.deepEqual(Object.keys(Overview.Clients), ['busy']);

  // The sweep is what actually frees it.
  History.pruneMonitoringHistoryStore();
  assert.deepEqual(History.getClientHistorySamples('idle'), []);
});

test('a read returns its own array: later samples do not change what a reader holds', () => {
  History.recordClientHistorySample({ UUID: 'c1', Online: true });
  const Held = History.getClientHistorySamples('c1');
  at(START + 60_000);
  History.recordClientHistorySample({ UUID: 'c1', Online: false });
  assert.equal(Held.length, 1);
  assert.equal(History.getClientHistorySamples('c1').length, 2);
});

test('a named series read stays put while the store keeps recording in place', () => {
  // A serial-guarded critical device: connected, then reported missing.
  const Client = (Present) => ({
    UUID: 'c1',
    Online: true,
    USBDeviceList: [
      {
        IsCritical: true,
        SerialNumber: 'S1',
        ProductName: 'Interface',
        IsConnected: Present,
        Missing: !Present,
      },
    ],
  });
  History.recordClientUSBHistorySamples(Client(true));
  const Before = History.getClientUSBHistorySamples('c1');
  assert.equal(Before.length, 1);
  const HeldSamples = Before[0].samples;
  const HeldPoint = { ...HeldSamples[HeldSamples.length - 1] };

  // A repeat extends the newest point; a change appends one.
  at(START + 5_000);
  History.recordClientUSBHistorySamples(Client(true));
  at(START + 60_000);
  History.recordClientUSBHistorySamples(Client(false));

  assert.equal(HeldSamples.length, 1, 'the held array did not grow');
  assert.deepEqual(HeldSamples[HeldSamples.length - 1], HeldPoint, 'the held point did not move');
  const After = History.getClientUSBHistorySamples('c1')[0].samples;
  assert.deepEqual(
    After.map((P) => [P.ts, P.online]),
    [
      [START, true],
      [START + 5_000, true],
      [START + 60_000, false],
    ],
    'the store itself recorded both'
  );
});
