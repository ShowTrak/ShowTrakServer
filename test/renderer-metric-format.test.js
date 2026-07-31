// Exercises src/UI/js/app/lib/metric-format.ts — how a FreeKiosk reading is
// worded in the view modal and on a tile.
//
// The one that matters: a metric with NO reading must read as "—", never as 0
// or blank. A tablet with no light sensor and a tablet reporting zero lux are
// different facts, and showing both as "0 lux" would let an operator believe a
// threshold was met when nothing was measured.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  FormatMetricValue,
  FormatMetricCompact,
  FormatDuration,
  FormatMegabytes,
  RoundTo,
} = require(path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', 'metric-format.js'));

const metric = (overrides = {}) => ({
  Key: 'battery_level',
  Label: 'Battery Level',
  Type: 'number',
  Section: 'Battery',
  Chart: 'line',
  Operators: [],
  ...overrides,
});

test('a percentage has no space before its sign', () => {
  assert.equal(FormatMetricValue(metric({ Unit: '%' }), 87), '87%');
});

test('every other unit is spaced', () => {
  assert.equal(FormatMetricValue(metric({ Unit: '°C', Decimals: 1 }), 24.53), '24.5 °C');
  assert.equal(FormatMetricValue(metric({ Unit: 'dBm' }), -52), '-52 dBm');
  assert.equal(FormatMetricValue(metric({ Unit: 'Mbps' }), 217), '217 Mbps');
});

test('a unitless number is shown bare', () => {
  assert.equal(FormatMetricValue(metric({}), 30), '30');
});

test('precision follows the metric declaration', () => {
  assert.equal(FormatMetricValue(metric({ Decimals: 2 }), 4.3211), '4.32');
  assert.equal(FormatMetricValue(metric({ Decimals: 0 }), 4.9), '5');
});

test('booleans read as Yes and No', () => {
  const bool = metric({ Type: 'boolean' });
  assert.equal(FormatMetricValue(bool, true), 'Yes');
  assert.equal(FormatMetricValue(bool, false), 'No');
});

test('a boolean stored as a select string reads the same as a real boolean', () => {
  // Alarm thresholds round-trip through a <select>, so they come back as the
  // STRING "false" — which is truthy. A bare cast printed an armed "expected No"
  // as "expected Yes", i.e. the precise opposite of the configured alarm.
  const bool = metric({ Type: 'boolean' });
  assert.equal(FormatMetricValue(bool, 'false'), 'No');
  assert.equal(FormatMetricValue(bool, 'true'), 'Yes');
  assert.equal(FormatMetricValue(bool, 'No'), 'No');
  // Anything that is not a recognised boolean word is no reading at all, rather
  // than being silently rounded to Yes.
  assert.equal(FormatMetricValue(bool, 'maybe'), '—');
});

test('a missing reading is an em dash, not a zero', () => {
  for (const type of ['number', 'boolean', 'string', 'enum']) {
    assert.equal(FormatMetricValue(metric({ Type: type }), null), '—', type);
    assert.equal(FormatMetricValue(metric({ Type: type }), undefined), '—', type);
  }
  assert.equal(FormatMetricValue(metric({}), ''), '—');
  // A genuine zero is still a reading, and must survive.
  assert.equal(FormatMetricValue(metric({ Unit: '%' }), 0), '0%');
});

test('a non-numeric value in a numeric metric is a missing reading', () => {
  assert.equal(FormatMetricValue(metric({}), 'nope'), '—');
  assert.equal(FormatMetricValue(metric({}), NaN), '—');
});

test('durations use the largest two informative units', () => {
  const uptime = metric({ Format: 'duration', Unit: 's' });
  assert.equal(FormatMetricValue(uptime, 93600), '1d 2h');
  assert.equal(FormatMetricValue(uptime, 3661), '1h 1m');
  assert.equal(FormatMetricValue(uptime, 90), '1m 30s');
  assert.equal(FormatMetricValue(uptime, 5), '5s');
  assert.equal(FormatDuration(-10), '0s');
});

test('megabytes roll up to gigabytes past 1024', () => {
  const storage = metric({ Format: 'megabytes', Unit: 'MB' });
  assert.equal(FormatMetricValue(storage, 15000), '14.6 GB');
  assert.equal(FormatMetricValue(storage, 512), '512 MB');
  assert.equal(FormatMegabytes(1024), '1 GB');
});

test('a long URL is truncated so it fits a row', () => {
  const url = metric({ Type: 'string', Format: 'url' });
  const long = `https://example.com/${'a'.repeat(300)}`;
  const shown = FormatMetricValue(url, long);
  assert.equal(shown.length, 60);
  assert.ok(shown.endsWith('...'));
  // A short one is left alone.
  assert.equal(FormatMetricValue(url, 'https://example.com'), 'https://example.com');
});

test('an explicit length cap overrides the default', () => {
  const text = metric({ Type: 'string' });
  assert.equal(FormatMetricValue(text, 'abcdefghij', { MaxLength: 5 }).length, 5);
  // Without a cap a plain string is never truncated.
  assert.equal(FormatMetricValue(text, 'abcdefghij'), 'abcdefghij');
});

test('the compact form drops the space on percentages and caps everything else', () => {
  assert.equal(FormatMetricCompact(metric({ Unit: '%' }), 87.6), '88%');
  assert.equal(FormatMetricCompact(metric({ Type: 'boolean' }), true), 'Yes');
  assert.equal(FormatMetricCompact(metric({ Type: 'string' }), 'x'.repeat(50)).length, 24);
  assert.equal(FormatMetricCompact(metric({}), null), '—');
  assert.equal(FormatMetricCompact(null, 5), '—');
});

test('an unknown metric still prints something rather than throwing', () => {
  assert.equal(FormatMetricValue(null, 42), '42');
  assert.equal(FormatMetricValue(undefined, null), '—');
});

test('rounding is half-up and stable', () => {
  assert.equal(RoundTo(2.345, 2), 2.35);
  assert.equal(RoundTo(2.5, 0), 3);
  assert.equal(RoundTo(-2.5, 0), -2);
  assert.equal(RoundTo(Infinity, 2), Infinity);
});
