const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const {
  makeBrightSignDws,
  VIDEO_HEALTHY,
  VIDEO_PATH,
} = require('../test-support/brightsign-dws-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}
const load = (dws) =>
  loadWithMocks(methodPath('brightsign-video.js'), { http: dws.http, https: dws.https });

const CREDS = { username: 'admin', password: 'TKD27R001940' };
const BASE_SETTINGS = {
  Protocol: 'http',
  Port: 0,
  Username: 'admin',
  Password: 'TKD27R001940',
  IgnoreTlsErrors: true,
  Timeout: 2000,
  VideoOutput: 0,
};
const target = (Settings = {}) => ({ Address: '10.0.0.9', Settings: { ...BASE_SETTINGS, ...Settings } });

function withVideo(payload, routePath = VIDEO_PATH) {
  return makeBrightSignDws({ auth: CREDS, routes: { [routePath]: payload } });
}

test('brightsign-video module exposes the expected shape', () => {
  const m = load(makeBrightSignDws({}));
  assert.equal(m.ID, 'brightsign-video');
  assert.equal(m.Name, 'Player Video Output (BrightSign)');
  const keys = m.Settings.map((s) => s.Key);
  assert.ok(keys.includes('ExpectedMode'));
  assert.ok(keys.includes('VideoOutput'));
});

test('a healthy output is online and reports the active mode', async () => {
  const m = load(withVideo(VIDEO_HEALTHY));
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.ActiveMode, '1920x1080x60p');
  assert.equal(result.BestMode, '1920x1080x60p');
  assert.equal(result.OutputPresent, true);
  assert.equal(result.Unstable, false);
});

test('a matching expected mode is online', async () => {
  const m = load(withVideo(VIDEO_HEALTHY));
  const result = await m.Run(target({ ExpectedMode: '1920x1080x60p' }));

  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
});

test('a mismatched mode is degraded, naming both modes', async () => {
  const m = load(withVideo(VIDEO_HEALTHY));
  const result = await m.Run(target({ ExpectedMode: '3840x2160x60p' }));

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /1920x1080x60p/);
  assert.match(result.DegradedReason, /3840x2160x60p/);
});

test('a blank expected mode reports the mode without alerting', async () => {
  const m = load(withVideo(VIDEO_HEALTHY));
  const result = await m.Run(target({ ExpectedMode: '' }));

  assert.ok(!result.Degraded);
  assert.equal(result.ActiveMode, '1920x1080x60p');
});

test('a disconnected display is degraded', async () => {
  const m = load(
    withVideo({ ...VIDEO_HEALTHY, status: { result: { outputPresent: false, unstable: false } } })
  );
  const result = await m.Run(target());

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /No display detected/);
});

test('an unstable signal is degraded', async () => {
  const m = load(
    withVideo({ ...VIDEO_HEALTHY, status: { result: { outputPresent: true, unstable: true } } })
  );
  const result = await m.Run(target());

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /unstable/i);
});

test('an output blanked for power save is degraded', async () => {
  const m = load(withVideo({ ...VIDEO_HEALTHY, powerSaveStatus: { result: true } }));
  const result = await m.Run(target());

  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /power save/i);
});

test('every fault is reported together, not just the first', async () => {
  const m = load(
    withVideo({
      ...VIDEO_HEALTHY,
      status: { result: { outputPresent: false, unstable: true } },
      powerSaveStatus: { result: true },
    })
  );
  const result = await m.Run(target({ ExpectedMode: '3840x2160x60p' }));

  const reason = result.DegradedReason;
  assert.match(reason, /No display detected/);
  assert.match(reason, /unstable/i);
  assert.match(reason, /power save/i);
  assert.match(reason, /3840x2160x60p/);
});

test('the output index selects the right endpoint (0-indexed, dual-output players)', async () => {
  const dws = makeBrightSignDws({
    auth: CREDS,
    routes: { '/api/v1/video/hdmi/output/1': VIDEO_HEALTHY },
  });
  const m = load(dws);
  const result = await m.Run(target({ VideoOutput: 1 }));

  assert.equal(result.Success, true);
  assert.equal(result.VideoOutput, 1);
  assert.ok(dws.calls.every((c) => c.Path === '/api/v1/video/hdmi/output/1'));
});

test('an audio-only player (404) is degraded, not offline', async () => {
  // Audio-only players have no video API at all — that is a misapplied check,
  // not an unreachable player.
  const m = load(makeBrightSignDws({ auth: CREDS, routes: {} }));
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /does not support the video API/);
});

test('sub-objects that errored are surfaced rather than reported healthy', async () => {
  const m = load(
    withVideo({ activeMode: { error: 'probe failed' }, status: { error: 'probe failed' } })
  );
  const result = await m.Run(target());

  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /not reported/i);
});

test('an unreachable player is offline', async () => {
  const m = load(makeBrightSignDws({ refuse: true }));
  const result = await m.Run(target());

  assert.equal(result.Success, false);
});

test('Debug renders the output rows and escapes player-supplied text', () => {
  const m = load(makeBrightSignDws({}));
  const html = m.Debug(
    {
      Success: true,
      LatencyMs: 7,
      VideoOutput: 0,
      ActiveMode: '<img src=x onerror=1>',
      OutputPresent: true,
      Unstable: false,
    },
    target()
  );
  assert.match(html, /hdmi:0/);
  assert.ok(!html.includes('<img'), 'player-supplied values must be escaped');
});
