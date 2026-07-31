// Exercises src/UI/js/app/lib/metric-chart.ts — the first real chart in this
// app, and the first thing here that draws a VALUE rather than a verdict.
//
// Two properties matter more than the geometry:
//
//   1. Its buckets must line up with the block timeline's, because a chart and
//      a timeline appear stacked in the same modal. If they drifted, an
//      operator comparing "when did the battery drop" against "when did it go
//      degraded" would be reading two different clocks.
//   2. A bucket with no reading must BREAK the line, never interpolate across
//      it. A straight line over an outage is a claim about data nobody has.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const base = (...parts) =>
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', ...parts);

const { BuildMetricChartModel, RenderMetricChartSvg } = require(base('metric-chart.js'));
const { MONITOR_HISTORY_BLOCK_COUNT, MONITOR_HISTORY_WINDOW_MS } = require(
  base('history-window.js')
);

const NOW = 1_700_000_000_000;

/** A reading n at `minutesAgo` minutes before NOW. */
function sample(minutesAgo, n, overrides = {}) {
  return {
    ts: NOW - minutesAgo * 60_000,
    ok: n != null,
    n,
    s: null,
    breach: false,
    ...overrides,
  };
}

const build = (samples, options = {}) => BuildMetricChartModel(samples, { now: NOW, ...options });

// ---- Bucketing ------------------------------------------------------------

test('the bucket grid matches the block timeline exactly', () => {
  // Same window, same count, same half-open [start, end) membership as
  // BuildStatusBlocksFromSamples — this is what keeps a stacked chart and
  // timeline aligned column for column.
  const model = build([]);
  assert.equal(model.buckets.length, MONITOR_HISTORY_BLOCK_COUNT);

  const bucketMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  assert.equal(model.buckets[0].start, NOW - MONITOR_HISTORY_WINDOW_MS);
  assert.equal(model.buckets[0].end - model.buckets[0].start, bucketMs);
  for (let i = 1; i < model.buckets.length; i += 1) {
    assert.equal(model.buckets[i].start, model.buckets[i - 1].end, `bucket ${i} must abut`);
  }
  const last = model.buckets[model.buckets.length - 1];
  assert.equal(last.end, NOW);
});

test('a sample lands in exactly one bucket, on the half-open boundary rule', () => {
  const bucketMs = MONITOR_HISTORY_WINDOW_MS / MONITOR_HISTORY_BLOCK_COUNT;
  const start = NOW - MONITOR_HISTORY_WINDOW_MS;
  const model = build([
    { ts: start, ok: true, n: 1, s: null, breach: false },
    { ts: start + bucketMs, ok: true, n: 2, s: null, breach: false },
  ]);
  assert.equal(model.buckets[0].count, 1);
  assert.equal(model.buckets[0].last, 1);
  assert.equal(model.buckets[1].count, 1);
  assert.equal(model.buckets[1].last, 2);
});

test('a bucket aggregates min, max, average and last', () => {
  const model = build([sample(30, 10), sample(30, 30), sample(30, 20)]);
  const bucket = model.buckets.find((b) => b.count > 0);
  assert.equal(bucket.min, 10);
  assert.equal(bucket.max, 30);
  assert.equal(bucket.avg, 20);
  assert.equal(bucket.last, 20);
  assert.equal(bucket.ok, true);
});

test('samples outside the window are ignored', () => {
  const model = build([sample(120, 50), sample(30, 10)]);
  assert.equal(model.buckets.filter((b) => b.count > 0).length, 1);
});

test('a breach anywhere in a bucket marks the bucket', () => {
  const model = build([sample(30, 10), sample(30, 12, { breach: true })]);
  assert.equal(model.buckets.find((b) => b.count > 0).breach, true);
});

// ---- Gaps -----------------------------------------------------------------

test('a gap breaks the line rather than interpolating across it', () => {
  const model = build([sample(50, 10), sample(10, 90)]);
  // Two separate readings with nothing between them: two segments, not one
  // line implying a smooth ramp nobody measured.
  assert.equal((model.linePath.match(/M/g) || []).length, 2);
  assert.ok(model.gaps.length > 0);
});

test('a continuous series is one unbroken segment', () => {
  const samples = [];
  // Mid-bucket: a sample landing exactly on a boundary belongs to the NEXT
  // bucket (membership is half-open), which would leave the oldest one empty.
  for (let i = 0; i < MONITOR_HISTORY_BLOCK_COUNT; i += 1) samples.push(sample(i + 0.5, 50));
  const model = build(samples);
  assert.equal((model.linePath.match(/M/g) || []).length, 1);
  assert.deepEqual(model.gaps, []);
});

test('a sample marked not-ok is a gap, not a zero', () => {
  const model = build([{ ts: NOW - 60_000, ok: false, n: null, s: null, breach: false }]);
  const bucket = model.buckets.find((b) => b.count > 0);
  assert.equal(bucket.ok, false);
  assert.equal(bucket.avg, null);
  assert.equal(model.linePath, '');
});

test('an empty series reports itself empty rather than drawing a flat zero', () => {
  const model = build([]);
  assert.equal(model.empty, true);
  assert.equal(model.linePath, '');
  assert.equal(model.gaps.length, MONITOR_HISTORY_BLOCK_COUNT);
});

// ---- Scaling --------------------------------------------------------------

test('a declared domain is used verbatim', () => {
  // A battery pinned at 100% must draw as a flat line at the top, not as
  // amplified noise across the full height.
  const model = build([sample(10, 100), sample(5, 100)], { min: 0, max: 100 });
  assert.equal(model.yMin, 0);
  assert.equal(model.yMax, 100);
});

test('without a domain the scale follows the data, with headroom', () => {
  const model = build([sample(10, 40), sample(5, 60)]);
  assert.ok(model.yMin < 40);
  assert.ok(model.yMax > 60);
});

test('a constant series never divides by zero', () => {
  const model = build([sample(10, 7), sample(5, 7)]);
  assert.ok(model.yMax > model.yMin);
  assert.ok(Number.isFinite(model.yMin));
  assert.ok(Number.isFinite(model.yMax));
  assert.ok(!model.linePath.includes('NaN'));
});

test('the threshold is always inside the scale, even when the data is far away', () => {
  // Otherwise the band an operator configured would be invisible.
  const model = build([sample(10, 95), sample(5, 96)], {
    threshold: { operator: 'below', value: 20 },
  });
  assert.ok(model.yMin <= 20);
  assert.equal(model.thresholdLines.length, 1);
  assert.equal(model.thresholdLines[0].value, 20);
});

test('a negative-scale metric charts without inverting', () => {
  const model = build([sample(10, -80), sample(5, -50)], { min: -100, max: -30 });
  assert.equal(model.yMin, -100);
  assert.equal(model.yMax, -30);
  assert.ok(!model.linePath.includes('NaN'));
});

// ---- Threshold bands ------------------------------------------------------

const bandOptions = (operator, value, value2) => ({
  min: 0,
  max: 100,
  threshold: { operator, value, value2 },
});

test('a below threshold shades everything under it', () => {
  const model = build([sample(10, 50)], bandOptions('below', 20));
  assert.equal(model.bands.length, 1);
  // Lower values are further down the SVG, so the band starts at the line.
  assert.ok(model.bands[0].y > 0);
  assert.ok(model.bands[0].height > 0);
});

test('an above threshold shades everything over it', () => {
  const model = build([sample(10, 50)], bandOptions('above', 80));
  assert.equal(model.bands.length, 1);
  assert.ok(model.bands[0].height > 0);
});

test('an outside range shades both tails', () => {
  const model = build([sample(10, 50)], bandOptions('outside', 20, 80));
  assert.equal(model.bands.length, 2);
  assert.equal(model.thresholdLines.length, 2);
});

test('an inside range shades the middle only', () => {
  const model = build([sample(10, 50)], bandOptions('inside', 20, 80));
  assert.equal(model.bands.length, 1);
  assert.ok(model.bands[0].height > 0);
});

test('a range threshold with no second bound draws no band', () => {
  const model = build([sample(10, 50)], bandOptions('outside', 20, null));
  assert.deepEqual(model.bands, []);
});

test('no threshold means no band at all', () => {
  const model = build([sample(10, 50)], { min: 0, max: 100 });
  assert.deepEqual(model.bands, []);
  assert.deepEqual(model.thresholdLines, []);
});

// ---- Rendering ------------------------------------------------------------

test('the SVG carries one hit target per bucket, for the shared tooltip', () => {
  const model = build([sample(10, 50)]);
  const svg = RenderMetricChartSvg(model, { label: 'Battery Level', unit: '%', decimals: 0 });
  assert.equal((svg.match(/class="metric-chart-hit"/g) || []).length, MONITOR_HISTORY_BLOCK_COUNT);
  assert.match(svg, /data-avg=/);
  assert.match(svg, /data-breach=/);
  assert.match(svg, /data-unit="%"/);
});

test('the label is escaped into the accessible name', () => {
  const model = build([]);
  const svg = RenderMetricChartSvg(model, { label: '<script>x</script>' });
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /&lt;script&gt;/);
});

test('an empty chart says so instead of drawing nothing at all', () => {
  const svg = RenderMetricChartSvg(build([]), { label: 'Battery' });
  assert.match(svg, /No readings yet/);
  assert.ok(!svg.includes('metric-chart-line'));
});

test('a custom formatter is used for the axis labels', () => {
  const model = build([sample(10, 3600)], { min: 0, max: 7200 });
  const svg = RenderMetricChartSvg(model, {
    label: 'Uptime',
    formatted: (value) => `${Math.round(value / 3600)}h`,
  });
  assert.match(svg, /2h<\/text>/);
});

test('the viewBox has no horizontal padding, so it aligns with the timeline', () => {
  const model = build([sample(10, 50)], { width: 1000, height: 120 });
  const svg = RenderMetricChartSvg(model, { label: 'X' });
  assert.match(svg, /viewBox="0 0 1000 120"/);
  assert.match(svg, /<rect class="metric-chart-hit" x="0"/);
});

test('junk input yields an empty model rather than throwing', () => {
  for (const input of [null, undefined, 'nope', 42, [null], [{ ts: 'x' }]]) {
    assert.doesNotThrow(() => BuildMetricChartModel(input, { now: NOW }));
    const model = BuildMetricChartModel(input, { now: NOW });
    assert.equal(model.buckets.length, MONITOR_HISTORY_BLOCK_COUNT);
  }
});
