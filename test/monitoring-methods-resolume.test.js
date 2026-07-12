const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// Load resolume-status with the shared HTTP helper stubbed so nothing touches
// the network. `responder` receives the derived Target (whose Settings.Path is
// either /api/v1/product or /api/v1/composition) and returns a scripted
// MonitoringResult, letting a single test script both requests.
function loadResolume(responder) {
  const calls = [];
  const httpShared = {
    PerformHttpRequest: async (target, opts) => {
      const requestPath = target && target.Settings && target.Settings.Path;
      calls.push({ target, opts, path: requestPath });
      return responder(requestPath, target, opts);
    },
    BuildHttpDebug: () => '<debug/>',
  };
  const mod = loadWithMocks(methodPath('resolume-status.js'), {
    './_http-shared': httpShared,
  });
  return { mod, calls };
}

const PRODUCT_BODY = JSON.stringify({
  name: 'Arena',
  major: 7,
  minor: 13,
  micro: 2,
  revision: 12345,
});

function compositionBody(name) {
  return JSON.stringify({
    name: { id: 1641335430527, valuetype: 'ParamString', value: name },
    layers: [],
  });
}

const Target = { Address: '10.0.0.9', Settings: { Port: 8080, ExpectedComposition: '' } };

test('resolume-status: exports the expected identity and settings', () => {
  const { mod } = loadResolume(() => ({
    Success: true,
    Status: 200,
    LatencyMs: 3,
    Body: PRODUCT_BODY,
  }));
  assert.equal(mod.ID, 'resolume-status');
  assert.equal(mod.Name, 'Resolume');
  const keys = mod.Settings.map((s) => s.Key);
  for (const k of ['Port', 'ExpectedComposition', 'Timeout']) {
    assert.ok(keys.includes(k), `missing setting ${k}`);
  }
  const port = mod.Settings.find((s) => s.Key === 'Port');
  assert.equal(port.Default, 8080);
  assert.equal(port.Min, 1);
  assert.equal(port.Max, 65535);
  const timeout = mod.Settings.find((s) => s.Key === 'Timeout');
  assert.equal(timeout.Default, 6000);
  assert.equal(timeout.Advanced, true);
});

test('resolume-status: online (no composition assert) when product responds', async () => {
  const { mod, calls } = loadResolume((requestPath) => {
    assert.equal(requestPath, '/api/v1/product');
    return { Success: true, Status: 200, LatencyMs: 8, Body: PRODUCT_BODY };
  });
  const res = await mod.Run(Target);
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, undefined);
  assert.equal(res.LatencyMs, 8);
  assert.equal(res.ProductName, 'Arena');
  assert.equal(res.Version, '7.13.2');
  // Only the product endpoint is hit when no composition is configured.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.Protocol, 'http');
  assert.equal(calls[0].opts.DefaultPort, 8080);
  assert.equal(calls[0].opts.CaptureBody, true);
});

test('resolume-status: online when the expected composition matches', async () => {
  const target = { Address: '10.0.0.9', Settings: { ExpectedComposition: 'Main Show' } };
  const { mod, calls } = loadResolume((requestPath) => {
    if (requestPath === '/api/v1/product') {
      return { Success: true, Status: 200, LatencyMs: 5, Body: PRODUCT_BODY };
    }
    return { Success: true, Status: 200, LatencyMs: 4, Body: compositionBody('Main Show') };
  });
  const res = await mod.Run(target);
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, undefined);
  assert.equal(res.CurrentComposition, 'Main Show');
  assert.equal(res.ExpectedComposition, 'Main Show');
  // Both endpoints are queried.
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/api/v1/product', '/api/v1/composition']
  );
});

test('resolume-status: degraded when the composition name mismatches', async () => {
  const target = { Address: '10.0.0.9', Settings: { ExpectedComposition: 'Main Show' } };
  const { mod } = loadResolume((requestPath) => {
    if (requestPath === '/api/v1/product') {
      return { Success: true, Status: 200, LatencyMs: 5, Body: PRODUCT_BODY };
    }
    return { Success: true, Status: 200, LatencyMs: 4, Body: compositionBody('Rehearsal') };
  });
  const res = await mod.Run(target);
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, true);
  assert.equal(res.DegradedReason, 'Wrong composition');
  assert.equal(res.CurrentComposition, 'Rehearsal');
  assert.equal(res.ExpectedComposition, 'Main Show');
});

test('resolume-status: offline when the product request fails (connection refused)', async () => {
  const { mod } = loadResolume(() => ({ Success: false, Error: 'connect ECONNREFUSED' }));
  const res = await mod.Run(Target);
  assert.equal(res.Success, false);
  assert.match(res.Error, /ECONNREFUSED/);
});

test('resolume-status: offline when the product returns a non-2xx status', async () => {
  // The shared helper shapes an out-of-range status as Success:false already.
  const { mod } = loadResolume(() => ({
    Success: false,
    Error: 'HTTP 404 (expected 200-299)',
    Status: 404,
  }));
  const res = await mod.Run(Target);
  assert.equal(res.Success, false);
  assert.equal(res.Status, 404);
  assert.match(res.Error, /404/);
});

test('resolume-status: offline when the product body is not valid JSON', async () => {
  const { mod } = loadResolume(() => ({
    Success: true,
    Status: 200,
    LatencyMs: 2,
    Body: '<html>nope',
  }));
  const res = await mod.Run(Target);
  assert.equal(res.Success, false);
  assert.match(res.Error, /not valid JSON/i);
});

test('resolume-status: offline when the composition request fails', async () => {
  const target = { Address: '10.0.0.9', Settings: { ExpectedComposition: 'Main Show' } };
  const { mod } = loadResolume((requestPath) => {
    if (requestPath === '/api/v1/product') {
      return { Success: true, Status: 200, LatencyMs: 5, Body: PRODUCT_BODY };
    }
    return { Success: false, Error: 'Request timed out after 6000ms' };
  });
  const res = await mod.Run(target);
  assert.equal(res.Success, false);
  assert.match(res.Error, /timed out/i);
});

test('resolume-status: offline when no address is configured', async () => {
  const { mod, calls } = loadResolume(() => ({ Success: true, Status: 200, Body: PRODUCT_BODY }));
  const res = await mod.Run({ Settings: {} });
  assert.equal(res.Success, false);
  assert.match(res.Error, /No address/i);
  assert.equal(calls.length, 0);
});

test('resolume-status: _internal helpers parse and compare correctly', () => {
  const { mod } = loadResolume(() => ({ Success: true }));
  const { ParseProduct, ParseCompositionName, CompositionMatches } = mod._internal;

  assert.deepEqual(ParseProduct(PRODUCT_BODY), { Name: 'Arena', Version: '7.13.2' });
  assert.equal(ParseProduct('not json'), null);
  assert.equal(ParseProduct(JSON.stringify({ major: 7 })), null); // no name -> invalid

  assert.equal(ParseCompositionName(compositionBody('My Comp')), 'My Comp');
  assert.equal(ParseCompositionName('not json'), null);
  assert.equal(ParseCompositionName(JSON.stringify({ name: 'no-value-wrapper' })), null);

  assert.equal(CompositionMatches('  Show  ', 'Show'), true);
  assert.equal(CompositionMatches('Show', 'Other'), false);
});
