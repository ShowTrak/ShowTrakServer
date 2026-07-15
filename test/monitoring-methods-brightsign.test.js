const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const {
  makeBrightSignDws,
  INFO_HEALTHY,
  VIDEO_HEALTHY,
  INFO_PATH,
  VIDEO_PATH,
} = require('../test-support/brightsign-dws-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loadBs(dws) {
  return loadWithMocks(methodPath('brightsign.js'), { http: dws.http, https: dws.https });
}

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

test('brightsign (health) module exposes the expected shape', () => {
  const bs = loadBs(makeBrightSignDws({}));
  assert.equal(bs.ID, 'brightsign');
  assert.equal(bs.Name, 'Player Health (BrightSign)');
  const keys = bs.Settings.map((s) => s.Key);
  for (const key of [
    'Protocol',
    'Port',
    'Username',
    'Password',
    'ExpectedFirmware',
    'IncludeVideo',
  ]) {
    assert.ok(keys.includes(key), `missing setting ${key}`);
  }
  // The username is always 'admin' on BrightSignOS, so it should default to it.
  assert.equal(bs.Settings.find((s) => s.Key === 'Username').Default, 'admin');
});

test('a healthy player is online and reports its identity', async () => {
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: INFO_HEALTHY } });
  const bs = loadBs(dws);
  const result = await bs.Run(target());

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.Firmware, '8.5.33');
  assert.equal(result.Model, 'HD1024');
  assert.equal(result.Serial, 'TKD27R001940');
  assert.equal(result.UptimeSeconds, 6561);
  assert.equal(result.PowerSource, 'AC');
  assert.equal(result.HasVideoApi, true);
});

test('digest auth is performed: an unauthenticated probe is retried with an Authorization header', async () => {
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: INFO_HEALTHY } });
  const bs = loadBs(dws);
  await bs.Run(target());

  assert.equal(dws.calls.length, 2, 'expected a challenge then an authenticated retry');
  assert.equal(dws.calls[0].Authorization, null);
  assert.match(dws.calls[1].Authorization, /^Digest /);
  assert.match(dws.calls[1].Authorization, /username="admin"/);
  assert.match(dws.calls[1].Authorization, /qop=auth/);
});

test('a wrong password is offline, not degraded', async () => {
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: INFO_HEALTHY } });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ Password: 'wrong-serial' }));

  assert.equal(result.Success, false);
  assert.match(result.Error, /Authentication failed/);
});

test('a player with auth disabled works without credentials', async () => {
  const dws = makeBrightSignDws({ auth: null, routes: { [INFO_PATH]: INFO_HEALTHY } });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ Password: '' }));

  assert.equal(result.Success, true);
  assert.equal(dws.calls.length, 1, 'no challenge means no retry');
});

test('an unreachable player is offline', async () => {
  const dws = makeBrightSignDws({ refuse: true });
  const bs = loadBs(dws);
  const result = await bs.Run(target());

  assert.equal(result.Success, false);
  assert.match(result.Error, /ECONNREFUSED/);
});

test('a silent player times out rather than hanging', async () => {
  const dws = makeBrightSignDws({ silent: true });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ Timeout: 600 }));

  assert.equal(result.Success, false);
  assert.match(result.Error, /timed out/i);
});

test('an HTTP->HTTPS redirect is followed (BrightSignOS 9.0.218+ behaviour)', async () => {
  const dws = makeBrightSignDws({
    auth: CREDS,
    redirectToHttps: true,
    routes: { [INFO_PATH]: INFO_HEALTHY },
  });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ Protocol: 'http' }));

  assert.equal(result.Success, true, 'a check configured for HTTP should survive the upgrade');
  assert.ok(
    dws.calls.some((c) => c.Scheme === 'https'),
    'expected the retry to land on https'
  );
});

test('the self-signed certificate is tolerated by default', async () => {
  const dws = makeBrightSignDws({ routes: { [INFO_PATH]: INFO_HEALTHY } });
  const bs = loadBs(dws);
  await bs.Run(target({ Protocol: 'https' }));

  assert.equal(dws.calls[0].RejectUnauthorized, false);
});

test('a non-BrightSign device answering JSON is a clear error, not a silent pass', async () => {
  const dws = makeBrightSignDws({
    routes: { [INFO_PATH]: { Status: 200, Body: '{"hello":"world"}' } },
  });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ Password: '' }));

  assert.equal(result.Success, false);
  assert.match(result.Error, /BrightSign/);
});

test('a missing address fails before any request is made', async () => {
  const dws = makeBrightSignDws({});
  const bs = loadBs(dws);
  const result = await bs.Run({ Address: '', Settings: BASE_SETTINGS });

  assert.equal(result.Success, false);
  assert.match(result.Error, /No address/);
  assert.equal(dws.calls.length, 0);
});

test('firmware drift degrades the player', async () => {
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: INFO_HEALTHY } });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ ExpectedFirmware: '9.0.218' }));

  assert.equal(result.Success, true, 'the player is reachable, so it stays online');
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /8\.5\.33.*expected 9\.0\.218/);
});

test('running on battery degrades the player', async () => {
  const onBattery = {
    ...INFO_HEALTHY,
    power: { result: { battery: 'discharging', source: 'battery', switch_mode: 'hard' } },
  };
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: onBattery } });
  const bs = loadBs(dws);
  const result = await bs.Run(target());

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /discharging/i);
});

test('a power sub-object that errored does not crash or falsely pass', async () => {
  // The DWS returns 200 with {"error"} instead of {"result"} when a sub-probe
  // fails — the whole payload must not be treated as healthy.
  const brokenPower = { ...INFO_HEALTHY, power: { error: 'Not supported on this platform' } };
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: brokenPower } });
  const bs = loadBs(dws);
  const result = await bs.Run(target());

  assert.equal(result.Success, true);
  assert.equal(result.PowerSource, null);
  assert.ok(!result.Degraded, 'an unreported power block is skipped, not failed');
});

test('video is not polled unless asked for', async () => {
  const dws = makeBrightSignDws({
    auth: CREDS,
    routes: { [INFO_PATH]: INFO_HEALTHY, [VIDEO_PATH]: VIDEO_HEALTHY },
  });
  const bs = loadBs(dws);
  await bs.Run(target({ IncludeVideo: false }));

  assert.ok(!dws.calls.some((c) => c.Path === VIDEO_PATH));
});

test('IncludeVideo adds the video request and reports the active mode', async () => {
  const dws = makeBrightSignDws({
    auth: CREDS,
    routes: { [INFO_PATH]: INFO_HEALTHY, [VIDEO_PATH]: VIDEO_HEALTHY },
  });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ IncludeVideo: true }));

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.VideoMode, '1920x1080x60p');
  assert.ok(dws.calls.some((c) => c.Path === VIDEO_PATH));
});

test('IncludeVideo degrades when the display is gone', async () => {
  const noDisplay = {
    ...VIDEO_HEALTHY,
    status: { result: { outputPresent: false, unstable: false } },
  };
  const dws = makeBrightSignDws({
    auth: CREDS,
    routes: { [INFO_PATH]: INFO_HEALTHY, [VIDEO_PATH]: noDisplay },
  });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ IncludeVideo: true }));

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /No display detected/);
});

test('IncludeVideo is skipped on an audio-only player rather than 404ing', async () => {
  const audioOnly = { ...INFO_HEALTHY, api_features: { video: false } };
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [INFO_PATH]: audioOnly } });
  const bs = loadBs(dws);
  const result = await bs.Run(target({ IncludeVideo: true }));

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, 'no video API is not a fault on an audio-only player');
  assert.equal(result.HasVideoApi, false);
  assert.ok(!dws.calls.some((c) => c.Path === VIDEO_PATH));
});

test('EvaluateHealth collects every failing factor at once', () => {
  const bs = loadBs(makeBrightSignDws({}));
  const reasons = bs._internal.EvaluateHealth(
    {
      Firmware: '8.5.33',
      PowerSource: 'battery',
      Battery: 'discharging',
      Video: {
        ActiveMode: '1920x1080x60p',
        OutputPresent: false,
        Unstable: true,
        PowerSave: null,
        Errors: [],
      },
    },
    '9.0.218'
  );

  assert.equal(reasons.length, 4);
  assert.match(reasons.join('; '), /expected 9\.0\.218/);
  assert.match(reasons.join('; '), /discharging/);
  assert.match(reasons.join('; '), /No display detected/);
  assert.match(reasons.join('; '), /unstable/);
});

test('EvaluateHealth skips fields the player did not report', () => {
  const bs = loadBs(makeBrightSignDws({}));
  assert.deepEqual(
    bs._internal.EvaluateHealth({ Firmware: null, PowerSource: null, Battery: null }, ''),
    []
  );
});

test('Debug renders the identity rows and escapes player-supplied text', () => {
  const bs = loadBs(makeBrightSignDws({}));
  const html = bs.Debug(
    {
      Success: true,
      LatencyMs: 12,
      Firmware: '8.5.33',
      Model: '<script>x</script>',
      UptimeSeconds: 6561,
    },
    target()
  );

  assert.match(html, /8\.5\.33/);
  assert.match(html, /1h 49m/);
  assert.ok(!html.includes('<script>'), 'player-supplied values must be escaped');
});
