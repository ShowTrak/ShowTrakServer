// Exercises src/UI/js/app/lib/metric-series.ts.
//
// The history store compresses flat runs: once two consecutive samples agree it
// stops pushing and just moves the second one's timestamp forward. A sample
// therefore means "this held from here until the next sample". Both bucketers
// disagreed — they count samples per bucket and paint an empty bucket grey — so
// a terminal with a steady reading drew one live column and fifty-nine dead
// ones. This expansion is what reconciles the two.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ExpandMetricSeries } = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', 'metric-series.js')
);

const NOW = 1_700_000_000_000;
const WINDOW = 3_600_000;
const BUCKETS = 60;
const BUCKET = WINDOW / BUCKETS;
const opts = { now: NOW, windowMs: WINDOW, bucketCount: BUCKETS };

// How the consumers read it: which buckets end up with at least one sample.
const occupied = (samples) => {
  const seen = new Set();
  for (const s of samples) {
    const i = Math.floor((s.ts - (NOW - WINDOW)) / BUCKET);
    if (i >= 0 && i < BUCKETS) seen.add(i);
  }
  return seen;
};

const sample = (ts, over = {}) => ({ ts, ok: true, n: 100, s: null, breach: false, ...over });

test('a two-point flat run fills every bucket between its ends', () => {
  // Exactly what the store produces for a battery that has sat at 100% for an
  // hour: the first sample of the run, and the latest.
  const compressed = [sample(NOW - WINDOW + 60_000), sample(NOW - 1000)];
  assert.equal(occupied(compressed).size, 2, 'the raw series really is that sparse');

  const expanded = ExpandMetricSeries(compressed, opts);
  assert.equal(occupied(expanded).size, BUCKETS - 1, 'every bucket from the first sample on');
  // The carried value is the reading, not a placeholder.
  for (const s of expanded) assert.equal(s.n, 100);
});

test('buckets before the first sample stay empty', () => {
  // Nothing was recorded then — history is RAM-only, so the app may simply not
  // have been running. Filling them would claim knowledge nobody has.
  const half = NOW - WINDOW / 2;
  const expanded = ExpandMetricSeries([sample(half), sample(NOW - 1000)], opts);
  const seen = occupied(expanded);
  assert.equal(seen.has(0), false);
  assert.equal(seen.has(BUCKETS / 2), true);
});

test('a run that started before the window still carries into it', () => {
  // The compressed pair can both be older than the window's start edge only in
  // the degenerate case; the common case is one old anchor plus a recent one.
  const expanded = ExpandMetricSeries([sample(NOW - WINDOW * 3), sample(NOW - 1000)], opts);
  assert.equal(occupied(expanded).size, BUCKETS, 'no dead columns at the left edge');
});

test('an outage carries forward as an outage, not as a reading', () => {
  const expanded = ExpandMetricSeries(
    [
      sample(NOW - WINDOW + 1000, { ok: false, n: null }),
      sample(NOW - 1000, { ok: false, n: null }),
    ],
    opts
  );
  assert.ok(expanded.length > 2);
  for (const s of expanded) assert.equal(s.ok, false);
});

test('breach state is carried with the reading it belonged to', () => {
  const expanded = ExpandMetricSeries(
    [sample(NOW - WINDOW + 1000, { breach: true }), sample(NOW - 1000, { breach: true })],
    opts
  );
  for (const s of expanded) assert.equal(s.breach, true);
});

test('a bucket that already has a sample is left alone', () => {
  // One sample per poll, uncompressed — expansion must add nothing.
  const dense = [];
  for (let i = 0; i < BUCKETS; i += 1) dense.push(sample(NOW - WINDOW + i * BUCKET + BUCKET / 2));
  const expanded = ExpandMetricSeries(dense, opts);
  assert.equal(expanded.length, dense.length);
});

test('the result is ordered, which every bucketer assumes', () => {
  const expanded = ExpandMetricSeries([sample(NOW - 1000), sample(NOW - WINDOW + 1000)], opts);
  for (let i = 1; i < expanded.length; i += 1) {
    assert.ok(expanded[i].ts >= expanded[i - 1].ts, `out of order at ${i}`);
  }
});

test('an empty or junk series expands to nothing rather than throwing', () => {
  for (const input of [null, undefined, [], [{ ts: 'nope' }]]) {
    assert.deepEqual(ExpandMetricSeries(input, opts), []);
  }
});
