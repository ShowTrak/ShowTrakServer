const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');
const {
  makeBrightSignDws,
  INFO_HEALTHY,
  INFO_PATH,
} = require('../test-support/brightsign-dws-mock');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// The configured Timeout is a budget for the WHOLE probe, not per round trip.
// These tests drive slow multi-round-trip probes whose total sequential time
// exceeds the budget while no single gap does, so the fix (an absolute
// whole-probe cap) is what ends them — the old per-request / idle timeouts would
// have let them run to completion.

test('NUT probe is bounded by an absolute whole-probe deadline, not the idle timeout', async () => {
  // Each reply arrives after 150ms — under the 500ms idle timeout, which the
  // mock socket never fires anyway — but LIST UPS + four GET VARs run ~750ms
  // sequentially, past the 500ms budget.
  const { ProbeNut } = loadWithMocks(methodPath('_nut-shared.js'), {
    net: makeNutNet({
      vars: {
        'ups.status': 'OL',
        'battery.charge': '100',
        'ups.load': '20',
        'input.voltage': '230',
      },
      delayMs: 150,
    }),
  });

  const started = Date.now();
  const probe = await ProbeNut('ups.local', 3493, 500, 'ups', '', '', [
    'ups.status',
    'battery.charge',
    'ups.load',
    'input.voltage',
  ]);
  const elapsed = Date.now() - started;

  assert.equal(probe.Reachable, false, 'the probe must be cut off by the whole-probe deadline');
  assert.match(String(probe.Error), /exceeded/i);
  assert.ok(elapsed < 900, `probe should be capped near the 500ms budget, took ${elapsed}ms`);
});

test('BrightSign probe budget spans the redirect + auth handshake, not each request', async () => {
  // http -> 302 https -> 401 challenge -> authed request, each delayed 200ms, so
  // the handshake needs ~600ms sequentially. Under the old code every SendOnce
  // armed its own full timeout, so the whole thing completed; now the shared
  // 500ms budget cuts it off.
  const dws = makeBrightSignDws({
    routes: { [INFO_PATH]: INFO_HEALTHY },
    auth: { username: 'admin', password: 'serial123' },
    redirectToHttps: true,
    delayMs: 200,
  });
  const bs = loadWithMocks(methodPath('brightsign.js'), { http: dws.http, https: dws.https });

  const started = Date.now();
  const result = await bs.Run({
    Address: 'player.local',
    Settings: { Protocol: 'http', Password: 'serial123', Timeout: 500 },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.Success, false, 'the probe must be cut off by the whole-probe budget');
  assert.match(String(result.Error), /timed out/i);
  assert.ok(elapsed < 900, `probe should be capped near the 500ms budget, took ${elapsed}ms`);
});
