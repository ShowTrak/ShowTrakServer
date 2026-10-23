const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// A monitor's tile widget comes from its check's method, and only when that
// check is the monitor's only one: the tile has room for one widget.

const calls = [];
const { MonitoringTarget } = loadWithMocks(
  path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringTargetManager', 'target.js'),
  {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': { Manager: { Run: async () => [null, { changes: 1 }] } },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../MonitoringMethods': {
      Manager: {
        Run: async () => ({ Success: true, LatencyMs: 10, Level: -6 }),
        BuildDebug: () => null,
        GetActionOptions: () => ({}),
        GetTileWidget: (method, check, result) => {
          calls.push([method, result]);
          return method === 'tascam-mx8a' ? { Kind: 'levels' } : null;
        },
      },
    },
  }
);

function check(id, method) {
  return { CheckID: id, TargetID: 1, Name: '', Address: 'a', Method: method, Settings: '{}' };
}

function target(checks) {
  return new MonitoringTarget(
    { TargetID: 1, Nickname: 'T', Interval: 30000, GroupID: null, Weight: 1, Timestamp: 1 },
    checks
  );
}

test('the only check of a monitor gives it its tile widget', async () => {
  const T = target([check(11, 'tascam-mx8a')]);
  assert.deepEqual(T.ToJSON().TileWidget, { Kind: 'levels', CheckID: 11 });
  // The check's last result is handed to the method once there is one.
  await T.Checks[0].Run();
  T.ToJSON();
  assert.deepEqual(calls[calls.length - 1], [
    'tascam-mx8a',
    { Success: true, LatencyMs: 10, Level: -6 },
  ]);
});

test('no widget with several checks, or a method without one', () => {
  assert.equal(target([check(11, 'tascam-mx8a'), check(12, 'ping')]).ToJSON().TileWidget, null);
  assert.equal(target([check(11, 'ping')]).ToJSON().TileWidget, null);
  assert.equal(target([]).ToJSON().TileWidget, null);
});
