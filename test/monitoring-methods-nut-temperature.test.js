const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load(netMock) {
  return loadWithMocks(methodPath('nut-ups-temperature.js'), { net: netMock });
}

const BASE = { Port: 3493, UPSName: 'ups', Timeout: 2000 };

test('nut-ups-temperature exposes the expected shape', () => {
  const m = load(makeNutNet({}));
  assert.equal(m.ID, 'nut-ups-temperature');
  assert.equal(m.Name, 'UPS Temperature (NUT)');
  assert.ok(m.Settings.some((s) => s.Key === 'MaxTemperature'));
});

test('nut-ups-temperature is online at or below the maximum', async () => {
  const m = load(makeNutNet({ vars: { 'ups.temperature': '30' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, MaxTemperature: 40 } });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.Temperature, 30);
});

test('nut-ups-temperature is degraded above the maximum', async () => {
  const m = load(makeNutNet({ vars: { 'ups.temperature': '55' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, MaxTemperature: 40 } });
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /temperature high/i);
});

test('nut-ups-temperature falls back to battery.temperature', async () => {
  const m = load(makeNutNet({ vars: { 'battery.temperature': '25' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, MaxTemperature: 40 } });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.Temperature, 25);
});

test('nut-ups-temperature is degraded when no temperature is reported', async () => {
  const m = load(makeNutNet({ vars: {} }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'Temperature unavailable');
});
