const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loadNut(netMock) {
  return loadWithMocks(methodPath('nut-ups.js'), { net: netMock });
}

const BASE_SETTINGS = { Port: 3493, UPSName: 'ups', Timeout: 2000 };

// A UPS reporting a perfectly healthy state on all fronts.
const HEALTHY_VARS = {
  'ups.status': 'OL',
  'battery.charge': '100',
  'ups.load': '35',
  'ups.temperature': '28',
  'input.voltage': '231',
  'input.voltage.nominal': '230',
};

test('nut-ups (health) module exposes the expected shape', () => {
  const nut = loadNut(makeNutNet({}));
  assert.equal(nut.ID, 'nut-ups');
  assert.equal(nut.Name, 'UPS Health (NUT)');
  assert.ok(Array.isArray(nut.Settings));
  const keys = nut.Settings.map((s) => s.Key);
  // Connection settings plus the health thresholds.
  assert.ok(keys.includes('Port'));
  assert.ok(keys.includes('UPSName'));
  assert.ok(keys.includes('MinCharge'));
  assert.ok(keys.includes('MaxLoad'));
  assert.ok(keys.includes('MaxTemperature'));
  assert.ok(keys.includes('VoltageTolerancePercent'));
});

test('nut-ups (health) is online when every factor is within limits', async () => {
  const nut = loadNut(makeNutNet({ vars: HEALTHY_VARS }));
  const r = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.Status, 'OL');
  assert.equal(r.BatteryCharge, 100);
  assert.equal(r.Load, 35);
});

test('nut-ups (health) is degraded on battery', async () => {
  const nut = loadNut(makeNutNet({ vars: { ...HEALTHY_VARS, 'ups.status': 'OB DISCHRG' } }));
  const r = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /battery/i);
});

test('nut-ups (health) combines multiple breached factors into one reason', async () => {
  const nut = loadNut(
    makeNutNet({
      vars: { ...HEALTHY_VARS, 'battery.charge': '20', 'ups.load': '99' },
    })
  );
  const r = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /Charge/);
  assert.match(r.DegradedReason, /Load/);
  assert.match(r.DegradedReason, /;/); // multiple reasons joined
});

test('nut-ups (health) skips variables the UPS does not report', async () => {
  // Only status + charge available; no load/temp/voltage. Should still be online.
  const nut = loadNut(makeNutNet({ vars: { 'ups.status': 'OL', 'battery.charge': '90' } }));
  const r = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
});

test('nut-ups (health) is degraded (UPS not found) when the named UPS is absent', async () => {
  const nut = loadNut(makeNutNet({ vars: HEALTHY_VARS }));
  const r = await nut.Run({
    Address: '127.0.0.1',
    Settings: { ...BASE_SETTINGS, UPSName: 'missing' },
  });
  assert.equal(r.Success, true);
  assert.equal(r.Degraded, true);
  assert.equal(r.DegradedReason, 'UPS not found');
});

test('nut-ups (health) is offline when the connection is refused', async () => {
  const nut = loadNut(makeNutNet({ refuse: true }));
  const r = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(r.Success, false);
  assert.match(r.Error, /ECONNREFUSED/);
});

test('nut-ups (health) is offline on ERR ACCESS-DENIED during auth', async () => {
  const nut = loadNut(makeNutNet({ auth: { PASSWORD: 'ERR ACCESS-DENIED\n' } }));
  const r = await nut.Run({
    Address: '127.0.0.1',
    Settings: { ...BASE_SETTINGS, Username: 'admin', Password: 'wrong' },
  });
  assert.equal(r.Success, false);
  assert.match(r.Error, /ACCESS-DENIED/i);
});

test('nut-ups (health) validates address and UPS name before probing', async () => {
  const nut = loadNut(makeNutNet({}));
  assert.equal((await nut.Run({})).Success, false);
  assert.equal(
    (await nut.Run({ Address: '127.0.0.1', Settings: { Port: 3493, UPSName: '' } })).Success,
    false
  );
  assert.equal(
    (await nut.Run({ Address: '127.0.0.1', Settings: { Port: 70000, UPSName: 'ups' } })).Success,
    false
  );
});

test('nut-ups EvaluateHealth flags each factor correctly', () => {
  const nut = loadNut(makeNutNet({}));
  const { EvaluateHealth } = nut._internal;
  const T = { MinCharge: 50, MaxLoad: 90, MaxTemperature: 45, VoltageTolerancePercent: 15 };

  assert.deepEqual(
    EvaluateHealth(
      { Status: 'OL', Charge: 100, Load: 20, Temperature: 25, Voltage: 230, Nominal: 230 },
      T
    ),
    []
  );
  assert.equal(EvaluateHealth({ Status: 'OB' }, T).length, 1);
  assert.match(EvaluateHealth({ Charge: 10 }, T)[0], /Charge/);
  assert.match(EvaluateHealth({ Load: 99 }, T)[0], /Load/);
  assert.match(EvaluateHealth({ Temperature: 60 }, T)[0], /Temp/);
  assert.match(EvaluateHealth({ Voltage: 180, Nominal: 230 }, T)[0], /Voltage/);
  // Unreported factors (null) are skipped.
  assert.deepEqual(EvaluateHealth({ Status: 'OL' }, T), []);
});
