const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load(netMock) {
  return loadWithMocks(methodPath('nut-ups-voltage.js'), { net: netMock });
}

const BASE = { Port: 3493, UPSName: 'ups', Timeout: 2000 };

test('nut-ups-voltage exposes the expected shape', () => {
  const m = load(makeNutNet({}));
  assert.equal(m.ID, 'nut-ups-voltage');
  assert.equal(m.Name, 'UPS Input Voltage (NUT)');
  assert.ok(m.Settings.some((s) => s.Key === 'TolerancePercent'));
});

test('nut-ups-voltage is online within the auto band around nominal', async () => {
  const m = load(
    makeNutNet({ vars: { 'input.voltage': '232', 'input.voltage.nominal': '230' } })
  );
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, TolerancePercent: 10 } });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.Voltage, 232);
});

test('nut-ups-voltage is degraded on a brownout (below the auto band)', async () => {
  const m = load(
    makeNutNet({ vars: { 'input.voltage': '190', 'input.voltage.nominal': '230' } })
  );
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, TolerancePercent: 10 } });
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /voltage low/i);
});

test('nut-ups-voltage is degraded on a surge (above the auto band)', async () => {
  const m = load(
    makeNutNet({ vars: { 'input.voltage': '260', 'input.voltage.nominal': '230' } })
  );
  const r = await m.Run({ Address: '127.0.0.1', Settings: { ...BASE, TolerancePercent: 10 } });
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /voltage high/i);
});

test('nut-ups-voltage explicit Min/Max override the nominal band', async () => {
  const m = load(
    makeNutNet({ vars: { 'input.voltage': '120', 'input.voltage.nominal': '230' } })
  );
  const r = await m.Run({
    Address: '127.0.0.1',
    Settings: { ...BASE, MinVoltage: 110, MaxVoltage: 130 },
  });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
});

test('nut-ups-voltage is online (cannot judge) with no nominal and no Min/Max', async () => {
  const m = load(makeNutNet({ vars: { 'input.voltage': '400' } }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
});

test('nut-ups-voltage is degraded when input.voltage is unavailable', async () => {
  const m = load(makeNutNet({ vars: {} }));
  const r = await m.Run({ Address: '127.0.0.1', Settings: BASE });
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'Voltage unavailable');
});

test('ResolveBand derives a tolerance band and honours explicit bounds', () => {
  const m = load(makeNutNet({}));
  const { ResolveBand } = m._internal;
  const auto = ResolveBand({ MinVoltage: 0, MaxVoltage: 0, TolerancePercent: 10 }, 230);
  assert.equal(auto.Lower, 207);
  assert.equal(auto.Upper, 253);
  const explicit = ResolveBand({ MinVoltage: 110, MaxVoltage: 130, TolerancePercent: 10 }, 230);
  assert.equal(explicit.Lower, 110);
  assert.equal(explicit.Upper, 130);
  const none = ResolveBand({ MinVoltage: 0, MaxVoltage: 0, TolerancePercent: 10 }, null);
  assert.equal(none.Lower, null);
  assert.equal(none.Upper, null);
});
