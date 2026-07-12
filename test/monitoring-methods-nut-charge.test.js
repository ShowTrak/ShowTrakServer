const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load(netMock) {
  return loadWithMocks(methodPath('nut-ups-charge.js'), { net: netMock });
}

const BASE = { Port: 3493, UPSName: 'ups', Timeout: 2000 };

test('nut-ups-charge exposes the expected shape', () => {
  const m = load(makeNutNet({}));
  assert.equal(m.ID, 'nut-ups-charge');
  assert.equal(m.Name, 'UPS Battery Charge (NUT)');
  assert.ok(m.Settings.some((s) => s.Key === 'MinCharge'));
});

test('nut-ups-charge is online when charge is at or above the minimum', async () => {
  const m = load(makeNutNet({ vars: { 'battery.charge': '95' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, MinCharge: 50 } });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.BatteryCharge, 95);
});

test('nut-ups-charge is degraded when charge is below the minimum', async () => {
  const m = load(makeNutNet({ vars: { 'battery.charge': '30' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, MinCharge: 50 } });
  assert.equal(r.Success, true);
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /charge low/i);
});

test('nut-ups-charge uses the default minimum (50%) when unset', async () => {
  const m = load(makeNutNet({ vars: { 'battery.charge': '40' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Degraded, true);
});

test('nut-ups-charge is degraded when battery.charge is unavailable', async () => {
  const m = load(makeNutNet({ vars: {} }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'Charge unavailable');
});

test('nut-ups-charge is offline when the connection is refused', async () => {
  const m = load(makeNutNet({ refuse: true }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Success, false);
});
