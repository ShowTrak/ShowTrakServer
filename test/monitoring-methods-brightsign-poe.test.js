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
  loadWithMocks(methodPath('brightsign-poe.js'), { http: dws.http, https: dws.https });

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

function withPoe(poe) {
  return makeBrightSignDws({
    auth: CREDS,
    routes: { [INFO_PATH]: { ...INFO_HEALTHY, poe } },
  });
}

test('brightsign-poe module exposes the expected shape', () => {
  const m = load(makeBrightSignDws({}));
  assert.equal(m.ID, 'brightsign-poe');
  assert.equal(m.Name, 'Player PoE Status (BrightSign)');
  assert.ok(m.Settings.map((s) => s.Key).includes('ExpectedStatus'));
});

test('a PoE-capable player reporting a status is online', async () => {
  const m = load(withPoe({ result: { status: 'active' } }));
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.PoeStatus, 'active');
});

test('hardware without PoE is degraded — the check is misapplied', async () => {
  const m = load(withPoe({ result: { status: 'not_supported' } }));
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /not supported/i);
});

test('a status other than the expected one is degraded', async () => {
  const m = load(withPoe({ result: { status: 'inactive' } }));
  const result = await m.Run(target({ ExpectedStatus: 'active' }));

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /inactive.*expected active/);
});

test('the expected status match is case-insensitive', async () => {
  const m = load(withPoe({ result: { status: 'Active' } }));
  const result = await m.Run(target({ ExpectedStatus: 'active' }));

  assert.ok(!result.Degraded);
});

test('a PoE block the player failed to read is degraded', async () => {
  const m = load(withPoe({ error: 'Not supported on this platform' }));
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /not reported/i);
});

test('a missing status field is degraded rather than passing', async () => {
  const m = load(withPoe({ result: {} }));
  const result = await m.Run(target());

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /did not report/i);
});

test('an unreachable player is offline', async () => {
  const m = load(makeBrightSignDws({ refuse: true }));
  const result = await m.Run(target());

  assert.equal(result.Success, false);
});

test('Debug renders the PoE rows', () => {
  const m = load(makeBrightSignDws({}));
  const html = m.Debug(
    { Success: true, LatencyMs: 5, PoeStatus: 'active', Expected: 'active' },
    target()
  );
  assert.match(html, /active/);
});
