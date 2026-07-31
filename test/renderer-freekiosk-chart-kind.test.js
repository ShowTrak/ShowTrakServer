// Exercises MetricChartKind in src/UI/js/app/freekiosk-modal.ts — what gets
// drawn under a metric's reading in the view modal.
//
// The rule is a two-part decision and neither part is obvious from the registry
// alone. `Chart` describes the VALUE: is its shape over time worth a graph?
// Uptime, storage and the rotation index say no. But arming a check asks a
// different question — "was it within limits?" — which has a shape even when the
// number does not, so those metrics still get the pass/fail timeline once
// somebody is watching them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { MetricChartKind } = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'freekiosk-modal.js')
);

const metric = (Chart, over = {}) => ({
  Key: 'k',
  Label: 'L',
  Type: 'number',
  Section: 'Storage',
  Chart,
  Operators: [],
  ...over,
});

test('nothing is charted unless a check is armed on it', () => {
  // Without a check there is no standard to judge a reading against, so a chart
  // could only report that the device answered. Worse, a block timeline would be
  // solid green whatever the reading was — nothing breaches when nothing is
  // being judged — which reads as a verdict rather than as an absence of one.
  for (const chart of ['line', 'blocks', 'none']) {
    assert.equal(MetricChartKind(metric(chart), false), 'none', chart);
  }
});

test('an armed metric is charted the way the registry says', () => {
  assert.equal(MetricChartKind(metric('line'), true), 'line');
  assert.equal(MetricChartKind(metric('blocks', { Type: 'boolean' }), true), 'blocks');
});

test('an armed value-only metric gets pass/fail rather than a graph', () => {
  // Uptime and storage are read as "what is it now" — the number's shape says
  // nothing. Whether it has been WITHIN LIMITS is a different question, and one
  // worth a timeline.
  assert.equal(MetricChartKind(metric('none'), true), 'blocks');
});

// A section with monitoring switched off has no case here at all: RenderSection
// drops the entire section before any row is built, so nothing that reaches this
// function is unmonitored. That is why it takes no "monitored" argument — a
// parameter nothing can ever pass false to is a claim the code cannot keep.

test('the registry metrics that lost their graphs can still show pass/fail', () => {
  const { FREEKIOSK_METRICS_BY_KEY } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'metrics.js')
  );
  for (const key of [
    'device_uptime',
    'storage_usedPercent',
    'storage_availableMB',
    'rotation_interval',
    'sensors_light',
  ]) {
    const m = FREEKIOSK_METRICS_BY_KEY.get(key);
    assert.equal(m.Chart, 'none', `${key} should be value-only`);
    assert.ok(m.Operators.length, `${key} must still be alarmable, or the rule is moot`);
    assert.equal(MetricChartKind(m, true), 'blocks', key);
    assert.equal(MetricChartKind(m, false), 'none', key);
  }
});

test('a metric that cannot be alarmed on never gets a timeline', () => {
  // Wi-Fi frequency is shown beside the channel purely as a reference reading.
  const { FREEKIOSK_METRICS_BY_KEY } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'metrics.js')
  );
  const frequency = FREEKIOSK_METRICS_BY_KEY.get('wifi_frequency');
  assert.deepEqual(frequency.Operators, []);
  assert.equal(MetricChartKind(frequency, false), 'none');
});
