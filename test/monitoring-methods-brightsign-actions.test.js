const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeBrightSignDws } = require('../test-support/brightsign-dws-mock');

// The BrightSign check's actions: reboot, and display power save on the HDMI
// output the check watches. The mock verifies real digest auth, so a PUT that
// signed itself as a GET would be rejected here exactly as a player rejects it.

function loadBs(dws) {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'brightsign.js'),
    { http: dws.http, https: dws.https }
  );
}

const CREDS = { username: 'admin', password: 'TKD27R001940' };
const SETTINGS = { Protocol: 'http', Port: 0, Password: 'TKD27R001940', Timeout: 2000 };
const REBOOT = '/api/v1/control/reboot';

test('reboot is the one control that stays enabled while the check is offline', () => {
  const bs = loadBs(makeBrightSignDws({}));
  const byId = Object.fromEntries(bs.Actions.map((Action) => [Action.ID, Action]));
  assert.deepEqual(Object.keys(byId), ['reboot', 'display.wake', 'display.sleep']);
  assert.equal(byId.reboot.AllowedWhileOffline, true);
  assert.equal(byId.reboot.Destructive, true);
  assert.ok(!byId['display.wake'].AllowedWhileOffline);
  assert.ok(!byId['display.sleep'].AllowedWhileOffline);
  assert.equal(byId['display.sleep'].Destructive, true);
});

test('Reboot Player sends a digest-signed PUT to the control endpoint', async () => {
  const dws = makeBrightSignDws({
    auth: CREDS,
    routes: { [REBOOT]: { success: true, reboot: true } },
  });
  const bs = loadBs(dws);
  const r = await bs.RunAction({ Address: '10.0.0.20', Settings: SETTINGS }, 'reboot', {});
  assert.deepEqual(r, { Success: true, Detail: 'Reboot started' });
  // Challenged, then signed: both requests are PUTs to the reboot endpoint.
  assert.deepEqual(
    dws.calls.map((Call) => [Call.Method, Call.Path, !!Call.Authorization]),
    [
      ['PUT', REBOOT, false],
      ['PUT', REBOOT, true],
    ]
  );
});

test('a player that answers success:false is reported as refusing', async () => {
  const dws = makeBrightSignDws({ routes: { [REBOOT]: { success: false, reboot: false } } });
  const r = await loadBs(dws).RunAction({ Address: '10.0.0.20', Settings: SETTINGS }, 'reboot');
  assert.equal(r.Success, false);
  assert.match(r.Error, /refused to reboot/);
});

test('a wrong password fails the reboot with the same message as the probe', async () => {
  const dws = makeBrightSignDws({ auth: CREDS, routes: { [REBOOT]: { success: true } } });
  const r = await loadBs(dws).RunAction(
    { Address: '10.0.0.20', Settings: { ...SETTINGS, Password: 'wrong' } },
    'reboot'
  );
  assert.equal(r.Success, false);
  assert.match(r.Error, /check the password/);
});

test('an HTTP->HTTPS redirect re-sends the reboot as a PUT, not a GET', async () => {
  const dws = makeBrightSignDws({
    redirectToHttps: true,
    routes: { [REBOOT]: { success: true, reboot: true } },
  });
  const r = await loadBs(dws).RunAction({ Address: '10.0.0.20', Settings: SETTINGS }, 'reboot');
  assert.equal(r.Success, true);
  assert.deepEqual(
    dws.calls.map((Call) => [Call.Scheme, Call.Method]),
    [
      ['http', 'PUT'],
      ['https', 'PUT'],
    ]
  );
});

test('Wake Display clears power save on the output the check watches', async () => {
  const Path = '/api/v1/video/hdmi/output/1/power-save';
  const dws = makeBrightSignDws({ routes: { [Path]: true } });
  const bs = loadBs(dws);
  const target = { Address: '10.0.0.20', Settings: { ...SETTINGS, VideoOutput: 1 } };

  const woke = await bs.RunAction(target, 'display.wake');
  assert.deepEqual(woke, { Success: true, Detail: 'Display woken' });
  const slept = await bs.RunAction(target, 'display.sleep');
  assert.deepEqual(slept, { Success: true, Detail: 'Display put into power save' });

  assert.deepEqual(
    dws.calls.map((Call) => [Call.Method, Call.Path, JSON.parse(Call.Body)]),
    [
      ['PUT', Path, { enabled: false }],
      ['PUT', Path, { enabled: true }],
    ]
  );
});

test('display actions on a player with no such output say so', async () => {
  // No route: the mock answers 404, as an audio-only player does for /video.
  const r = await loadBs(makeBrightSignDws({})).RunAction(
    { Address: '10.0.0.20', Settings: SETTINGS },
    'display.wake'
  );
  assert.equal(r.Success, false);
  assert.match(r.Error, /no HDMI output 0/);
});

test('the probe still reads with a plain GET', async () => {
  const dws = makeBrightSignDws({ routes: { '/api/v1/info': { model: 'HD1024' } } });
  await loadBs(dws).Run({ Address: '10.0.0.20', Settings: SETTINGS });
  assert.equal(dws.calls[0].Method, 'GET');
  assert.equal(dws.calls[0].Body, null);
});
