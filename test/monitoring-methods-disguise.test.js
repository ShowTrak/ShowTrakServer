const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// Load disguise-status.js with a mocked ./_http-shared so PerformHttpRequest returns
// a canned response and never touches the network. BuildHttpDebug is stubbed since
// Debug() is not exercised by the Run() mapping tests.
function loadDisguise(perform) {
  return loadWithMocks(methodPath('disguise-status.js'), {
    './_http-shared': {
      PerformHttpRequest: perform,
      BuildHttpDebug: () => '',
    },
  });
}

const HEALTHY_BODY = JSON.stringify({
  status: { code: 0, message: 'OK', details: [] },
  result: [
    {
      machine: { uid: 'abc', name: 'RX-01', hostname: 'rx-01' },
      status: { averageFPS: 60, videoDroppedFrames: 0, videoMissedFrames: 0 },
      states: [{ name: 'ok', detail: '', category: 'system', severity: 'info' }],
    },
  ],
});

test('disguise-status: ID and required exports', () => {
  const Mod = loadDisguise(async () => ({ Success: true, LatencyMs: 5, Status: 200, Body: '{}' }));
  assert.equal(Mod.ID, 'disguise-status');
  assert.equal(Mod.Name, 'disguise (d3)');
  assert.equal(typeof Mod.Run, 'function');
  assert.equal(typeof Mod.Debug, 'function');
  assert.ok(Array.isArray(Mod.Settings));
});

test('disguise-status: no address -> offline without hitting HTTP', async () => {
  let Called = false;
  const Mod = loadDisguise(async () => {
    Called = true;
    return { Success: true };
  });
  const Res = await Mod.Run({ Address: '', Settings: {} });
  assert.equal(Res.Success, false);
  assert.match(Res.Error, /No address/i);
  assert.equal(Called, false);
});

test('disguise-status: reachable healthy response -> online', async () => {
  let SeenTarget = null;
  const Mod = loadDisguise(async (Target) => {
    SeenTarget = Target;
    return { Success: true, LatencyMs: 12, Status: 200, Body: HEALTHY_BODY };
  });
  const Res = await Mod.Run({ Address: '10.0.0.5', Settings: {} });
  assert.equal(Res.Success, true);
  assert.equal(Res.Degraded, undefined);
  assert.equal(Res.LatencyMs, 12);
  assert.equal(Res.MachineName, 'RX-01');
  assert.equal(Res.AverageFps, 60);
  // Defaults the confirmed disguise health path when unset.
  assert.equal(SeenTarget.Settings.Path, '/api/session/status/health');
});

test('disguise-status: connection failure -> offline', async () => {
  const Mod = loadDisguise(async () => ({ Success: false, Error: 'ECONNREFUSED' }));
  const Res = await Mod.Run({ Address: '10.0.0.5', Settings: {} });
  assert.equal(Res.Success, false);
  assert.match(Res.Error, /ECONNREFUSED/);
});

test('disguise-status: assertion passes -> online', async () => {
  const Mod = loadDisguise(async () => ({
    Success: true,
    LatencyMs: 8,
    Status: 200,
    Body: HEALTHY_BODY,
  }));
  const Res = await Mod.Run({
    Address: '10.0.0.5',
    Settings: { JsonPath: 'status.code', ExpectedValue: '0' },
  });
  assert.equal(Res.Success, true);
  assert.equal(Res.Degraded, undefined);
  assert.equal(Res.MatchedValue, '0');
});

test('disguise-status: assertion mismatch -> degraded', async () => {
  const Mod = loadDisguise(async () => ({
    Success: true,
    LatencyMs: 8,
    Status: 200,
    Body: HEALTHY_BODY,
  }));
  const Res = await Mod.Run({
    Address: '10.0.0.5',
    Settings: { JsonPath: 'result.0.status.averageFPS', ExpectedValue: '30' },
  });
  assert.equal(Res.Success, true);
  assert.equal(Res.Degraded, true);
  assert.match(Res.DegradedReason, /averageFPS/);
});

test('disguise-status: assertion configured but invalid JSON -> offline', async () => {
  const Mod = loadDisguise(async () => ({
    Success: true,
    LatencyMs: 8,
    Status: 200,
    Body: 'not json',
  }));
  const Res = await Mod.Run({
    Address: '10.0.0.5',
    Settings: { JsonPath: 'status.code', ExpectedValue: '0' },
  });
  assert.equal(Res.Success, false);
  assert.match(Res.Error, /not valid JSON/i);
});

test('disguise-status: assertion path missing -> offline', async () => {
  const Mod = loadDisguise(async () => ({
    Success: true,
    LatencyMs: 8,
    Status: 200,
    Body: HEALTHY_BODY,
  }));
  const Res = await Mod.Run({
    Address: '10.0.0.5',
    Settings: { JsonPath: 'status.nonexistent', ExpectedValue: '0' },
  });
  assert.equal(Res.Success, false);
  assert.match(Res.Error, /not found/i);
});

test('disguise-status: _internal.EvaluateHealth maps outcomes', () => {
  const Mod = loadDisguise(async () => ({ Success: true }));
  const { EvaluateHealth, ExtractHealthSummary, ResolveJsonPath } = Mod._internal;

  assert.equal(EvaluateHealth(HEALTHY_BODY, '', '').Kind, 'online');
  assert.equal(EvaluateHealth(HEALTHY_BODY, 'status.code', '0').Kind, 'online');
  assert.equal(EvaluateHealth(HEALTHY_BODY, 'status.code', '5').Kind, 'degraded');
  assert.equal(EvaluateHealth('nope', 'status.code', '0').Kind, 'offline');
  assert.equal(EvaluateHealth(HEALTHY_BODY, 'status.missing', '0').Kind, 'offline');

  assert.equal(ResolveJsonPath({ a: { b: 1 } }, 'a.b'), 1);
  const Summary = ExtractHealthSummary(HEALTHY_BODY);
  assert.equal(Summary.MachineName, 'RX-01');
  assert.equal(Summary.AverageFps, 60);
  assert.deepEqual(ExtractHealthSummary('garbage'), {});
});
