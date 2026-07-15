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
  loadWithMocks(methodPath('brightsign-firmware.js'), { http: dws.http, https: dws.https });

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
const healthyDws = () => makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: INFO_HEALTHY } });

test('brightsign-firmware module exposes the expected shape', () => {
  const m = load(makeBrightSignDws({}));
  assert.equal(m.ID, 'brightsign-firmware');
  assert.equal(m.Name, 'Player Firmware (BrightSign)');
  assert.ok(m.Settings.map((s) => s.Key).includes('ExpectedFirmware'));
});

test('a matching firmware version is online', async () => {
  const m = load(healthyDws());
  const result = await m.Run(target({ ExpectedFirmware: '8.5.33' }));

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.Firmware, '8.5.33');
  assert.equal(result.BootVersion, '8.0.152');
});

test('a mismatched firmware version is degraded, naming both versions', async () => {
  const m = load(healthyDws());
  const result = await m.Run(target({ ExpectedFirmware: '9.0.218' }));

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /8\.5\.33/);
  assert.match(result.DegradedReason, /9\.0\.218/);
});

test('a blank expected version reports the firmware without alerting', async () => {
  const m = load(healthyDws());
  const result = await m.Run(target({ ExpectedFirmware: '' }));

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.Firmware, '8.5.33');
  assert.equal(result.Expected, null);
});

test('the comparison is exact — a prefix must not pass as a match', async () => {
  const m = load(healthyDws());
  const result = await m.Run(target({ ExpectedFirmware: '8.5' }));

  assert.equal(result.Degraded, true);
});

test('a player that reports no firmware is degraded', async () => {
  const noFw = { ...INFO_HEALTHY };
  delete noFw.FWVersion;
  const m = load(makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: noFw } }));
  const result = await m.Run(target({ ExpectedFirmware: '8.5.33' }));

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /did not report/);
});

test('an unreachable player is offline', async () => {
  const m = load(makeBrightSignDws({ refuse: true }));
  const result = await m.Run(target());

  assert.equal(result.Success, false);
});

test('Debug renders the version rows', () => {
  const m = load(makeBrightSignDws({}));
  const html = m.Debug(
    {
      Success: true,
      LatencyMs: 9,
      Firmware: '8.5.33',
      BootVersion: '8.0.152',
      Expected: '9.0.218',
    },
    target()
  );
  assert.match(html, /8\.5\.33/);
  assert.match(html, /9\.0\.218/);
});
