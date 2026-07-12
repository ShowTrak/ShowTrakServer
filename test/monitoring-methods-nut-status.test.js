const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load(netMock) {
  return loadWithMocks(methodPath('nut-ups-status.js'), { net: netMock });
}

const BASE = { Port: 3493, UPSName: 'ups', Timeout: 2000 };

test('nut-ups-status exposes the expected shape', () => {
  const m = load(makeNutNet({}));
  assert.equal(m.ID, 'nut-ups-status');
  assert.equal(m.Name, 'UPS Status (NUT)');
});

test('nut-ups-status is online when ups.status is OL', async () => {
  const m = load(makeNutNet({ vars: { 'ups.status': 'OL' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.Status, 'OL');
});

test('nut-ups-status is degraded (On battery) for OB', async () => {
  const m = load(makeNutNet({ vars: { 'ups.status': 'OB DISCHRG' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Success, true);
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'On battery');
});

test('nut-ups-status is degraded (Low battery) for LB', async () => {
  const m = load(makeNutNet({ vars: { 'ups.status': 'OB LB' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.DegradedReason, 'Low battery');
});

test('nut-ups-status is degraded when ups.status is unreadable', async () => {
  const m = load(makeNutNet({ vars: {} })); // GET VAR -> ERR VAR-NOT-SUPPORTED
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Success, true);
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'Status unavailable');
});

test('nut-ups-status is offline when the connection is refused', async () => {
  const m = load(makeNutNet({ refuse: true }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Success, false);
  assert.match(r.Error, /ECONNREFUSED/);
});

test('nut-ups-status is degraded (UPS not found) for an unknown UPS', async () => {
  const m = load(makeNutNet({ vars: { 'ups.status': 'OL' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, UPSName: 'missing' } });
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'UPS not found');
});
