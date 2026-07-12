const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load(netMock) {
  return loadWithMocks(methodPath('nut-ups-load.js'), { net: netMock });
}

const BASE = { Port: 3493, UPSName: 'ups', Timeout: 2000 };

test('nut-ups-load exposes the expected shape', () => {
  const m = load(makeNutNet({}));
  assert.equal(m.ID, 'nut-ups-load');
  assert.equal(m.Name, 'UPS Load (NUT)');
  assert.ok(m.Settings.some((s) => s.Key === 'MaxLoad'));
});

test('nut-ups-load is online at or below the maximum', async () => {
  const m = load(makeNutNet({ vars: { 'ups.load': '42' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, MaxLoad: 80 } });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.Load, 42);
});

test('nut-ups-load is degraded above the maximum', async () => {
  const m = load(makeNutNet({ vars: { 'ups.load': '92' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, MaxLoad: 80 } });
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /load high/i);
});

test('nut-ups-load is degraded when ups.load is unavailable', async () => {
  const m = load(makeNutNet({ vars: {} }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'Load unavailable');
});
