// The renderer's half of display-mode gating.
//
// The renderer cannot import src/Modules (its tsconfig rootDir is src/UI), so
// the mode rule is mirrored in src/UI/js/app/freekiosk.ts. These tests exist to
// keep the mirror honest: the server force-disables the alarms regardless of
// what the renderer draws, so a drifted copy would not corrupt anything — it
// would just put a stale URL back on screen, which is the entire bug.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { GetFreeKioskDisplayMode, IsFreeKioskMetricInMode } = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'freekiosk.js')
);
const { GetDisplayMode, IsMetricInDisplayMode, FREEKIOSK_METRICS_BY_KEY } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'metrics.js')
);

const CASES = [
  undefined,
  null,
  {},
  { DisplayMode: '' },
  { DisplayMode: 'webview' },
  { DisplayMode: 'external_app' },
  { DisplayMode: 'media_player' },
  { DisplayMode: 'nonsense' },
  { DisplayMode: 'WEBVIEW' },
];

test('the renderer resolves a mode exactly as the server does', () => {
  for (const Settings of CASES) {
    assert.equal(
      GetFreeKioskDisplayMode(Settings),
      GetDisplayMode(Settings),
      JSON.stringify(Settings)
    );
  }
});

test('the renderer gates the same metrics the server gates', () => {
  for (const Metric of FREEKIOSK_METRICS_BY_KEY.values()) {
    for (const Settings of CASES) {
      assert.equal(
        IsFreeKioskMetricInMode(Settings, Metric),
        IsMetricInDisplayMode(Settings, Metric),
        `${Metric.Key} / ${JSON.stringify(Settings)}`
      );
    }
  }
});

test('a metric with no RequiresMode is never gated, however the field arrives', () => {
  // The catalogue omits the property entirely for ungated metrics rather than
  // sending an empty array, so both shapes have to read as "applies always".
  for (const Metric of [{}, { RequiresMode: undefined }, { RequiresMode: [] }]) {
    assert.equal(IsFreeKioskMetricInMode({ DisplayMode: 'external_app' }, Metric), true);
  }
});

test('a WebView reading is hidden in app mode and shown in WebView mode', () => {
  const Url = { RequiresMode: ['webview'] };
  assert.equal(IsFreeKioskMetricInMode({ DisplayMode: 'external_app' }, Url), false);
  assert.equal(IsFreeKioskMetricInMode({ DisplayMode: 'media_player' }, Url), false);
  assert.equal(IsFreeKioskMetricInMode({ DisplayMode: 'webview' }, Url), true);
  assert.equal(IsFreeKioskMetricInMode({}, Url), true);
});
