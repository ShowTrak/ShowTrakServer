const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// Load companion-status with the shared HTTP helper stubbed out so nothing
// touches the network. The stub returns whatever scripted MonitoringResult the
// test hands it, and records the options it was called with.
function loadCompanion(scriptedResult) {
  const calls = [];
  const httpShared = {
    PerformHttpRequest: async (target, opts) => {
      calls.push({ target, opts });
      return scriptedResult;
    },
    // Debug() calls BuildHttpDebug; keep a trivial pass-through for coverage.
    BuildHttpDebug: () => '<debug/>',
  };
  const mod = loadWithMocks(methodPath('companion-status.js'), {
    './_http-shared': httpShared,
  });
  return { mod, calls };
}

const Target = { Address: '10.0.0.5', Settings: { Port: 8000, Path: '/' } };

test('companion-status: exports the expected identity and settings', () => {
  const { mod } = loadCompanion({ Success: true, Status: 200, LatencyMs: 3 });
  assert.equal(mod.ID, 'companion-status');
  assert.equal(mod.Name, 'Bitfocus Companion');
  const keys = mod.Settings.map((s) => s.Key);
  for (const k of ['Port', 'Path', 'ExpectedStatusMin', 'ExpectedStatusMax', 'Timeout']) {
    assert.ok(keys.includes(k), `missing setting ${k}`);
  }
  const port = mod.Settings.find((s) => s.Key === 'Port');
  assert.equal(port.Default, 8000);
  assert.equal(port.Min, 1);
  assert.equal(port.Max, 65535);
});

test('companion-status: online when status is within the expected range', async () => {
  const { mod, calls } = loadCompanion({ Success: true, Status: 200, LatencyMs: 7, Body: 'ok' });
  const res = await mod.Run(Target);
  assert.equal(res.Success, true);
  assert.equal(res.Status, 200);
  assert.equal(res.LatencyMs, 7);
  // Uses the http helper with port 8000 default and body capture.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.Protocol, 'http');
  assert.equal(calls[0].opts.DefaultPort, 8000);
  assert.equal(calls[0].opts.CaptureBody, true);
});

test('companion-status: online result surfaces an extractable version', async () => {
  const body = '<html>{"appVersion":"3.5.2"} Companion</html>';
  const { mod } = loadCompanion({ Success: true, Status: 200, LatencyMs: 4, Body: body });
  const res = await mod.Run(Target);
  assert.equal(res.Success, true);
  assert.equal(res.Version, '3.5.2');
});

test('companion-status: offline when there is no response', async () => {
  const { mod } = loadCompanion({ Success: false, Error: 'connect ECONNREFUSED' });
  const res = await mod.Run(Target);
  assert.equal(res.Success, false);
  assert.match(res.Error, /ECONNREFUSED/);
});

test('companion-status: offline when status is outside the expected range', async () => {
  // The shared helper shapes an out-of-range status as Success:false already.
  const { mod } = loadCompanion({
    Success: false,
    Error: 'HTTP 500 (expected 200-399)',
    Status: 500,
  });
  const res = await mod.Run(Target);
  assert.equal(res.Success, false);
  assert.equal(res.Status, 500);
  assert.match(res.Error, /500/);
});

test('companion-status: offline when no address is configured', async () => {
  const { mod, calls } = loadCompanion({ Success: true, Status: 200 });
  const res = await mod.Run({ Settings: {} });
  assert.equal(res.Success, false);
  assert.match(res.Error, /No address/i);
  // Must short-circuit before hitting the network.
  assert.equal(calls.length, 0);
});

test('companion-status: _internal.ExtractVersion parses known shapes and rejects noise', () => {
  const { mod } = loadCompanion({ Success: true });
  const { ExtractVersion } = mod._internal;
  assert.equal(ExtractVersion('{"appVersion":"3.5.2"}'), '3.5.2');
  assert.equal(ExtractVersion('Companion v4.0.0-beta'), '4.0.0-beta');
  assert.equal(ExtractVersion('no version here'), null);
  assert.equal(ExtractVersion(''), null);
  assert.equal(ExtractVersion(null), null);
});
