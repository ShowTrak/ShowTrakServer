const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const {
  makeBrightSignDws,
  INFO_HEALTHY,
  INFO_PATH,
} = require('../test-support/brightsign-dws-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}
const load = (dws) =>
  loadWithMocks(methodPath('brightsign-power.js'), { http: dws.http, https: dws.https });

const CREDS = { username: 'admin', password: 'TKD27R001940' };
const BASE_SETTINGS = {
  Protocol: 'http',
  Port: 0,
  Username: 'admin',
  Password: 'TKD27R001940',
  IgnoreTlsErrors: true,
  Timeout: 2000,
};
const target = (Settings = {}) => ({
  Address: '10.0.0.9',
  Settings: { ...BASE_SETTINGS, ...Settings },
});

function withPower(power) {
  return makeBrightSignDws({
    auth: CREDS,
    routes: { [INFO_PATH]: { ...INFO_HEALTHY, power: { result: power } } },
  });
}

test('brightsign-power module exposes the expected shape', () => {
  const m = load(makeBrightSignDws({}));
  assert.equal(m.ID, 'brightsign-power');
  assert.equal(m.Name, 'Player Power Source (BrightSign)');
  assert.ok(m.Settings.map((s) => s.Key).includes('ExpectedSource'));
});

test('a player on AC with no battery is online', async () => {
  const m = load(withPower({ battery: 'absent', source: 'AC', switch_mode: 'hard' }));
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.PowerSource, 'AC');
  assert.equal(result.Battery, 'absent');
  assert.equal(result.SwitchMode, 'hard');
});

test('a discharging battery is degraded', async () => {
  const m = load(withPower({ battery: 'discharging', source: 'AC' }));
  const result = await m.Run(target());

  assert.equal(result.Success, true, 'the player is answering, so it is not offline');
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /discharging/i);
});

test('running on battery power is degraded', async () => {
  const m = load(withPower({ battery: 'present', source: 'battery' }));
  const result = await m.Run(target());

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /Running on battery/i);
});

test('a low battery is degraded', async () => {
  const m = load(withPower({ battery: 'low', source: 'AC' }));
  const result = await m.Run(target());

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /low/i);
});

test('an unexpected source is degraded when an expected source is configured', async () => {
  const m = load(withPower({ battery: 'absent', source: 'PoE' }));
  const result = await m.Run(target({ ExpectedSource: 'AC' }));

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /PoE.*expected AC/);
});

test('the expected source match is case-insensitive', async () => {
  const m = load(withPower({ battery: 'absent', source: 'AC' }));
  const result = await m.Run(target({ ExpectedSource: 'ac' }));

  assert.ok(!result.Degraded);
});

test('an unrecognised source is not alarmed on when no expectation is set', async () => {
  // The vocabulary is undocumented beyond AC/absent, so unknown values must not
  // generate false alerts.
  const m = load(withPower({ battery: 'absent', source: 'DC-IN' }));
  const result = await m.Run(target({ ExpectedSource: '' }));

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.PowerSource, 'DC-IN');
});

test('a power block the player failed to read is degraded, not silently healthy', async () => {
  const m = load(
    makeBrightSignDws({
      auth: CREDS,
      routes: { [INFO_PATH]: { ...INFO_HEALTHY, power: { error: 'probe failed' } } },
    })
  );
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /probe failed/);
});

test('an unreachable player is offline', async () => {
  const m = load(makeBrightSignDws({ refuse: true }));
  const result = await m.Run(target());

  assert.equal(result.Success, false);
});

test('Debug renders the power rows', () => {
  const m = load(makeBrightSignDws({}));
  const html = m.Debug(
    { Success: true, LatencyMs: 5, PowerSource: 'AC', Battery: 'absent', SwitchMode: 'hard' },
    target()
  );
  assert.match(html, /AC/);
  assert.match(html, /absent/);
});
