// The FreeKiosk metric history store.
//
// The interesting behaviour is the compression. A terminal poll writes ~60
// series every 30 seconds, so storing every reading would be ~86k points per
// terminal over the 12h window for data that mostly never changes. Flat runs are
// collapsed to their two endpoints — which has to preserve the SHAPE of a step
// signal exactly, or a chart would lie about when something changed.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordFreeKioskHistorySamples,
  syncFreeKioskHistoryStore,
  getFreeKioskMetricHistory,
  pruneFreeKioskHistory,
  dropFreeKioskHistory,
  FREEKIOSK_HISTORY_MAX_SERIES_POINTS,
} = require('../dist/main/freekiosk-history');
const { FREEKIOSK_METRICS, AlarmFieldKeys } = require('../dist/Modules/FreeKiosk/metrics');

const HOUR = 60 * 60 * 1000;

// Only a metric with a check armed on it is recorded, so a fixture that arms
// nothing would store nothing. These are the metrics a terminal CAN be watched
// on; individual tests switch pieces of it off.
const ALARMABLE = FREEKIOSK_METRICS.filter((m) => m.Operators.length);
const ARM_EVERYTHING = Object.fromEntries(ALARMABLE.map((m) => [AlarmFieldKeys(m.Key).On, true]));

function terminal(overrides = {}) {
  return {
    UUID: 'uuid-1',
    Online: true,
    Metrics: { battery_level: 80, screen_on: true },
    Alarms: [],
    Settings: ARM_EVERYTHING,
    ...overrides,
  };
}

test('a section with monitoring switched off records nothing', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({
      UUID: uuid,
      Metrics: { battery_level: 80, memory_usedPercent: 50 },
      Settings: { ...ARM_EVERYTHING, G_Memory_On: false },
    })
  );
  assert.equal(seriesFor(uuid, 'battery_level').length, 1, 'monitored sections still record');
  assert.equal(seriesFor(uuid, 'memory_usedPercent').length, 0);
});

test('switching a section off releases the history it had already collected', () => {
  // Left in place it would draw a chart that stops dead at the moment the switch
  // was thrown, which reads as an outage rather than as a deliberate choice.
  const uuid = nextUUID();
  const metrics = { memory_usedPercent: 50 };
  recordFreeKioskHistorySamples(terminal({ UUID: uuid, Metrics: metrics }));
  assert.equal(seriesFor(uuid, 'memory_usedPercent').length, 1);

  recordFreeKioskHistorySamples(
    terminal({ UUID: uuid, Metrics: metrics, Settings: { ...ARM_EVERYTHING, G_Memory_On: false } })
  );
  assert.equal(seriesFor(uuid, 'memory_usedPercent').length, 0);
});

test('a reading the display mode rules out is not recorded', () => {
  // The store inherits this from ParseAlarmSettings rather than checking modes
  // itself, which is the point: one funnel decides what is being watched, so the
  // chart, the alarm and the history cannot disagree about a retained URL.
  const uuid = nextUUID();
  const metrics = { webview_currentUrl: 'https://showtrak.co.uk', battery_level: 80 };
  recordFreeKioskHistorySamples(
    terminal({
      UUID: uuid,
      Metrics: metrics,
      Settings: { ...ARM_EVERYTHING, DisplayMode: 'external_app' },
    })
  );
  assert.equal(seriesFor(uuid, 'webview_currentUrl').length, 0);
  assert.equal(seriesFor(uuid, 'battery_level').length, 1, 'mode-independent metrics still record');

  // In WebView mode the same poll records it — otherwise this test would pass
  // on a fixture that recorded nothing at all.
  const web = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({
      UUID: web,
      Metrics: metrics,
      Settings: { ...ARM_EVERYTHING, DisplayMode: 'webview' },
    })
  );
  assert.equal(seriesFor(web, 'webview_currentUrl').length, 1);
});

test('switching to app mode releases the URL history already collected', () => {
  // Left in place, the chart would show an hour of a page that stopped being on
  // screen the moment the mode changed.
  const uuid = nextUUID();
  const metrics = { webview_currentUrl: 'https://showtrak.co.uk' };
  recordFreeKioskHistorySamples(terminal({ UUID: uuid, Metrics: metrics }));
  assert.equal(seriesFor(uuid, 'webview_currentUrl').length, 1);

  recordFreeKioskHistorySamples(
    terminal({
      UUID: uuid,
      Metrics: metrics,
      Settings: { ...ARM_EVERYTHING, DisplayMode: 'external_app' },
    })
  );
  assert.equal(seriesFor(uuid, 'webview_currentUrl').length, 0);
});

test('a terminal with no section switches at all records every armed metric', () => {
  // Backwards compatibility: a show file written before the switches existed.
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid, Metrics: { memory_usedPercent: 50 } }));
  assert.equal(seriesFor(uuid, 'memory_usedPercent').length, 1);
});

function seriesFor(uuid, key) {
  const found = getFreeKioskMetricHistory(uuid).find((s) => s.MetricKey === key);
  return found ? found.Samples : [];
}

// Each test uses its own UUID so the module-level store does not leak between
// them (the store is a main-process singleton by design).
let counter = 0;
const nextUUID = () => `uuid-${(counter += 1)}`;

test('records one series per armed metric', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }));
  const series = getFreeKioskMetricHistory(uuid);
  assert.equal(series.length, ALARMABLE.length);
  assert.ok(series.some((s) => s.MetricKey === 'poll_latencyMs'));
});

test('a metric with nothing armed on it is not recorded at all', () => {
  // An unarmed sample would carry breach:false because nothing was judging it,
  // not because the reading was good. Storing those and then arming a check
  // would hand the operator an hour of green that was never assessed.
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({
      UUID: uuid,
      Metrics: { battery_level: 80, screen_on: true },
      Settings: { [AlarmFieldKeys('battery_level').On]: true },
    })
  );
  assert.equal(seriesFor(uuid, 'battery_level').length, 1);
  assert.equal(seriesFor(uuid, 'screen_on').length, 0);
});

test('disarming a check releases the history it collected', () => {
  // Left behind it would draw a chart that stops dead mid-window, which reads as
  // an outage rather than as somebody switching the check off.
  const uuid = nextUUID();
  const armed = { [AlarmFieldKeys('battery_level').On]: true };
  recordFreeKioskHistorySamples(terminal({ UUID: uuid, Settings: armed }));
  assert.equal(seriesFor(uuid, 'battery_level').length, 1);

  recordFreeKioskHistorySamples(terminal({ UUID: uuid, Settings: {} }));
  assert.equal(seriesFor(uuid, 'battery_level').length, 0);
});

test('poll latency is recorded even with nothing armed anywhere', () => {
  // It is ShowTrak's own measurement and the series the terminal's status
  // timeline is drawn from, so gating it would blank that timeline.
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({ UUID: uuid, Metrics: { poll_latencyMs: 18 }, Settings: {} })
  );
  assert.equal(seriesFor(uuid, 'poll_latencyMs')[0].n, 18);
  assert.equal(getFreeKioskMetricHistory(uuid).length, 1);
});

test('numeric readings land in n and categorical ones in s', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({
      UUID: uuid,
      Metrics: { battery_level: 80, screen_on: true, wifi_ssid: 'Backstage' },
    })
  );
  assert.deepEqual(seriesFor(uuid, 'battery_level')[0], {
    ts: seriesFor(uuid, 'battery_level')[0].ts,
    ok: true,
    n: 80,
    s: null,
    breach: false,
  });
  assert.equal(seriesFor(uuid, 'screen_on')[0].s, 'true');
  assert.equal(seriesFor(uuid, 'wifi_ssid')[0].s, 'Backstage');
});

test('numeric readings are rounded to the metric declared precision', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({ UUID: uuid, Metrics: { battery_temperature: 24.5678, battery_level: 80.4 } })
  );
  assert.equal(seriesFor(uuid, 'battery_temperature')[0].n, 24.6);
  assert.equal(seriesFor(uuid, 'battery_level')[0].n, 80);
});

test('a metric with no reading records an explicit gap, not a missing series', () => {
  // A straight line across an outage would misrepresent the data; an explicit
  // ok:false point is what lets the chart break its path.
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid, Metrics: { battery_level: null } }));
  const [sample] = seriesFor(uuid, 'battery_level');
  assert.equal(sample.ok, false);
  assert.equal(sample.n, null);
});

test('an offline terminal records gaps across every metric', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({ UUID: uuid, Online: false, Metrics: { battery_level: 80 } })
  );
  // Retained readings are shown in the modal, but they are NOT current, so they
  // must not be charted as though the device had just reported them.
  assert.equal(seriesFor(uuid, 'battery_level')[0].ok, false);
});

test('a breaching alarm is recorded on the sample itself', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(
    terminal({
      UUID: uuid,
      Metrics: { battery_level: 5 },
      Alarms: [{ Key: 'battery_level', Label: 'Battery Level', Reason: 'low' }],
    })
  );
  assert.equal(seriesFor(uuid, 'battery_level')[0].breach, true);
  assert.equal(seriesFor(uuid, 'screen_on')[0].breach, false);
});

test('long categorical values are capped so a URL cannot bloat the store', () => {
  const uuid = nextUUID();
  const long = `https://example.com/${'a'.repeat(500)}`;
  recordFreeKioskHistorySamples(terminal({ UUID: uuid, Metrics: { webview_currentUrl: long } }));
  assert.equal(seriesFor(uuid, 'webview_currentUrl')[0].s.length, 64);
});

// ---- Compression ----------------------------------------------------------

test('a rapid repeat inside the collapse window updates the existing point', () => {
  const uuid = nextUUID();
  const base = Date.now();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }), base);
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }), base + 100);
  const samples = seriesFor(uuid, 'battery_level');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].ts, base + 100);
});

test('a flat run collapses to two points but keeps both its ends', () => {
  const uuid = nextUUID();
  const base = Date.now() - HOUR;
  for (let i = 0; i < 20; i += 1) {
    recordFreeKioskHistorySamples(terminal({ UUID: uuid }), base + i * 30000);
  }
  const samples = seriesFor(uuid, 'battery_level');
  assert.equal(samples.length, 2, 'twenty identical readings are two points');
  assert.equal(samples[0].ts, base, 'the run must keep the instant it started');
  assert.equal(samples[1].ts, base + 19 * 30000, 'and the instant it was last seen');
});

test('a step is reproduced exactly, with no timing lost to compression', () => {
  // This is what the compression must not break: the chart has to show the
  // change happening between the right two polls.
  const uuid = nextUUID();
  const base = Date.now() - HOUR;
  const at = (i) => base + i * 30000;
  for (let i = 0; i < 5; i += 1) {
    recordFreeKioskHistorySamples(terminal({ UUID: uuid, Metrics: { battery_level: 80 } }), at(i));
  }
  for (let i = 5; i < 10; i += 1) {
    recordFreeKioskHistorySamples(terminal({ UUID: uuid, Metrics: { battery_level: 40 } }), at(i));
  }
  const samples = seriesFor(uuid, 'battery_level');
  assert.deepEqual(
    samples.map((s) => [s.ts - base, s.n]),
    [
      [0, 80],
      [at(4) - base, 80],
      [at(5) - base, 40],
      [at(9) - base, 40],
    ]
  );
});

test('an alternating series is not collapsed at all', () => {
  const uuid = nextUUID();
  const base = Date.now() - HOUR;
  for (let i = 0; i < 6; i += 1) {
    recordFreeKioskHistorySamples(
      terminal({ UUID: uuid, Metrics: { battery_level: i % 2 ? 10 : 90 } }),
      base + i * 30000
    );
  }
  assert.equal(seriesFor(uuid, 'battery_level').length, 6);
});

test('a change in breach state alone breaks a flat run', () => {
  // Same value, but the operator moved the threshold: the chart shading has to
  // change at the right moment, so this cannot be collapsed away.
  const uuid = nextUUID();
  const base = Date.now() - HOUR;
  const reading = (breach, ts) =>
    recordFreeKioskHistorySamples(
      terminal({
        UUID: uuid,
        Metrics: { battery_level: 25 },
        Alarms: breach ? [{ Key: 'battery_level' }] : [],
      }),
      ts
    );
  reading(false, base);
  reading(false, base + 30000);
  reading(true, base + 60000);
  const samples = seriesFor(uuid, 'battery_level');
  assert.equal(samples.length, 3);
  assert.equal(samples[2].breach, true);
});

// ---- Retention ------------------------------------------------------------

test('samples older than the 12h window are pruned', () => {
  const uuid = nextUUID();
  const now = Date.now();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }), now - 13 * HOUR);
  recordFreeKioskHistorySamples(
    terminal({ UUID: uuid, Metrics: { battery_level: 50 } }),
    now - HOUR
  );
  pruneFreeKioskHistory(now);
  const samples = seriesFor(uuid, 'battery_level');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].n, 50);
});

test('a series cannot grow past its hard cap however much it flaps', () => {
  const uuid = nextUUID();
  const base = Date.now() - 11 * HOUR;
  for (let i = 0; i < FREEKIOSK_HISTORY_MAX_SERIES_POINTS + 250; i += 1) {
    recordFreeKioskHistorySamples(
      terminal({ UUID: uuid, Metrics: { battery_level: i % 2 ? 10 : 90 } }),
      base + i * 1000
    );
  }
  assert.equal(seriesFor(uuid, 'battery_level').length, FREEKIOSK_HISTORY_MAX_SERIES_POINTS);
});

test('a terminal that disappears from a full list is forgotten', () => {
  const a = nextUUID();
  const b = nextUUID();
  syncFreeKioskHistoryStore([terminal({ UUID: a }), terminal({ UUID: b })]);
  assert.ok(getFreeKioskMetricHistory(a).length);

  syncFreeKioskHistoryStore([terminal({ UUID: b })]);
  assert.deepEqual(getFreeKioskMetricHistory(a), []);
  assert.ok(getFreeKioskMetricHistory(b).length);
});

test('a deleted terminal can be dropped outright', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }));
  dropFreeKioskHistory(uuid);
  assert.deepEqual(getFreeKioskMetricHistory(uuid), []);
});

// ---- Reading --------------------------------------------------------------

test('a metric filter narrows the response', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }));
  const series = getFreeKioskMetricHistory(uuid, ['battery_level', 'screen_on']);
  assert.deepEqual(series.map((s) => s.MetricKey).sort(), ['battery_level', 'screen_on']);
  // An empty filter means "everything recorded", not "nothing".
  assert.equal(getFreeKioskMetricHistory(uuid, []).length, ALARMABLE.length);
});

test('series are returned in registry order so the modal renders consistently', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }));
  const keys = getFreeKioskMetricHistory(uuid).map((s) => s.MetricKey);
  assert.deepEqual(
    keys,
    ALARMABLE.map((m) => m.Key)
  );
});

test('reading returns copies, so a caller cannot mutate the store', () => {
  const uuid = nextUUID();
  recordFreeKioskHistorySamples(terminal({ UUID: uuid }));
  const samples = seriesFor(uuid, 'battery_level');
  samples[0].n = 999;
  assert.equal(seriesFor(uuid, 'battery_level')[0].n, 80);
});

test('junk input is ignored rather than throwing', () => {
  for (const input of [null, undefined, {}, { UUID: '' }, { UUID: '  ' }, 42, 'nope']) {
    assert.doesNotThrow(() => recordFreeKioskHistorySamples(input));
  }
  for (const input of [null, undefined, '', 42, {}]) {
    assert.deepEqual(getFreeKioskMetricHistory(input), []);
  }
  assert.doesNotThrow(() => syncFreeKioskHistoryStore(null));
  assert.doesNotThrow(() => syncFreeKioskHistoryStore('nope'));
});
