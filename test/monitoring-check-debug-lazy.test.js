const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// A check's "last response" debug panel is rendered from its last raw result
// only when the check editor asks for it, not after every probe. For the
// body-carrying methods (HTTP JSON, disguise, Resolume) rendering re-parsed and
// pretty-printed the whole response each time, for a panel almost never open.

const debugCalls = [];
let nextResult = { Success: true, LatencyMs: 4 };
const { MonitoringCheck } = loadWithMocks(
  path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringTargetManager', 'target.js'),
  {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': { Manager: { Run: async () => [null, { changes: 1 }] } },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../MonitoringMethods': {
      Manager: {
        Run: async () => nextResult,
        BuildDebug: (method, result, target) => {
          debugCalls.push([method, result, { Address: target.Address, Settings: target.Settings }]);
          return `<div>${method} ${target.Address} ${result.LatencyMs}</div>`;
        },
        GetActionOptions: () => ({}),
        GetSettingOptions: () => ({}),
        GetTileWidget: () => null,
      },
    },
  }
);

function check() {
  return new MonitoringCheck({
    CheckID: 5,
    TargetID: 1,
    Name: '',
    Address: '10.0.0.5',
    Method: 'ping',
    Settings: '{"Timeout":2000}',
    Timestamp: 1,
  });
}

test.beforeEach(() => {
  debugCalls.length = 0;
  nextResult = { Success: true, LatencyMs: 4 };
});

test('probes do not render the debug panel; asking does, once per probe', async () => {
  const C = check();
  assert.equal(C.DebugHtml(), null, 'nothing to show before the first probe');
  await C.Run();
  await C.Run();
  assert.equal(debugCalls.length, 0, 'no probe rendered a panel');

  assert.equal(C.DebugHtml(), '<div>ping 10.0.0.5 4</div>');
  assert.equal(C.DebugHtml(), '<div>ping 10.0.0.5 4</div>');
  assert.equal(debugCalls.length, 1, 'a repeat ask reuses the rendered panel');

  nextResult = { Success: true, LatencyMs: 9 };
  await C.Run();
  assert.equal(C.DebugHtml(), '<div>ping 10.0.0.5 9</div>', 'a new probe renders afresh');
  assert.equal(debugCalls.length, 2);
});

test('the panel shows the configuration the probe ran with, not a later edit', async () => {
  const C = check();
  await C.Run();
  // Edited after the probe (the manager replaces Settings rather than editing it).
  C.Address = '10.0.0.99';
  C.Method = 'tcp-port';
  C.Settings = { Port: 80 };
  assert.equal(C.DebugHtml(), '<div>ping 10.0.0.5 4</div>');
  assert.deepEqual(debugCalls[0][2], { Address: '10.0.0.5', Settings: { Timeout: 2000 } });
});
