// Exercises DescribeExpected in src/UI/js/app/freekiosk-modal.ts — the wording
// shown beside a breaching metric's current value.
//
// The whole point of this string is the inversion. A stored operator states the
// ALARM condition, never the healthy one: "below 20" is armed to fire UNDER 20,
// so the expected value is "20% or more". Print the operator verbatim and the
// operator reads "expected below 20%" next to a reading of 1% and concludes the
// alarm is wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { DescribeExpected } = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'freekiosk-modal.js')
);

const metric = (overrides = {}) => ({
  Key: 'battery_level',
  Label: 'Battery Level',
  Type: 'number',
  Section: 'Battery',
  Chart: 'line',
  Operators: [],
  ...overrides,
});

const armed = (operator, value, value2) => ({ operator, value, value2 });

test('a numeric threshold is stated as the healthy side of the line', () => {
  const battery = metric({ Unit: '%' });
  assert.equal(DescribeExpected(battery, armed('below', 20)), 'expected 20% or more');
  assert.equal(DescribeExpected(battery, armed('above', 90)), 'expected 90% or less');
});

test('a range operator names both bounds, and inside is the complement of outside', () => {
  const temp = metric({ Unit: '°C', Decimals: 1 });
  assert.equal(DescribeExpected(temp, armed('outside', 5, 45)), 'expected 5 °C to 45 °C');
  assert.equal(DescribeExpected(temp, armed('inside', 5, 45)), 'expected outside 5 °C to 45 °C');
});

test('a boolean states the value it was armed with, verbatim', () => {
  // Booleans arm `isNot`, so the stored value already IS the expected state.
  // Crucially it arrives off a <select> as the string "false" — which is truthy,
  // so anything that negates it prints the exact opposite of the truth.
  const displaying = metric({
    Key: 'content_displaying',
    Label: 'Displaying Content',
    Type: 'boolean',
  });
  assert.equal(DescribeExpected(displaying, armed('isNot', 'true')), 'expected Yes');
  assert.equal(DescribeExpected(displaying, armed('isNot', 'false')), 'expected No');
  assert.equal(DescribeExpected(displaying, armed('isNot', true)), 'expected Yes');
  assert.equal(DescribeExpected(displaying, armed('isNot', false)), 'expected No');
});

test('an enum has more than two values, so it can only exclude the armed one', () => {
  const health = metric({ Key: 'battery_health', Type: 'enum', Options: ['good', 'overheat'] });
  assert.equal(DescribeExpected(health, armed('is', 'overheat')), 'expected anything but overheat');
  assert.equal(DescribeExpected(health, armed('isNot', 'good')), 'expected good');
});

test('substring operators quote the needle', () => {
  const url = metric({ Key: 'webview_currentUrl', Type: 'string' });
  assert.equal(
    DescribeExpected(url, armed('contains', 'error')),
    'expected not to contain "error"'
  );
  assert.equal(
    DescribeExpected(url, armed('notContains', 'dashboard')),
    'expected to contain "dashboard"'
  );
});

test('edge operators have no threshold to name', () => {
  const uptime = metric({ Key: 'device_uptime', Format: 'duration', Unit: 's' });
  assert.equal(DescribeExpected(uptime, armed('decreases')), 'expected never to go backwards');
  assert.equal(DescribeExpected(uptime, armed('changes')), 'expected to hold steady');
});

test('an unarmed metric says nothing at all', () => {
  assert.equal(DescribeExpected(metric(), null), '');
});

test('a threshold that is not a scalar degrades rather than printing [object Object]', () => {
  // Settings survive a JSON round trip, so nothing guarantees a scalar landed
  // back in the field a number was saved into.
  const shown = DescribeExpected(metric({ Unit: '%' }), armed('below', { nope: true }));
  assert.equal(shown, 'expected — or more');
});
