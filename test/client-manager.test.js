const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  return {
    debug: () => {},
    error: () => {},
    log: () => {},
    warn: () => {},
  };
}

test('ClientManager ignores dirty tracking for automatic heartbeat and system info updates', async () => {
  const trackedRuns = [];
  const untrackedRuns = [];
  const events = [];
  const clientRow = {
    UUID: 'client-1',
    Hostname: 'Initial Host',
    Version: null,
    IP: null,
    MacAddress: null,
    GroupID: null,
    Weight: 100,
    Timestamp: Date.now(),
  };

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async (sql, params) => {
          if (
            String(sql).includes('SELECT * FROM Clients WHERE UUID = ?') &&
            params[0] === 'client-1'
          ) {
            return [null, { ...clientRow }];
          }
          return [null, null];
        },
        Run: async (sql, params) => {
          trackedRuns.push([sql, params]);
          return [null, { changes: 1 }];
        },
        RunWithoutDirtyTracking: async (sql, params) => {
          untrackedRuns.push([sql, params]);
          return [null, { changes: 1 }];
        },
        All: async () => [null, []],
      },
    },
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
    '../SettingsManager': { Manager: { GetValue: async () => false } },
    '../Utils': require('../src/Modules/Utils'),
  });

  const [heartbeatErr] = await Manager.Heartbeat(
    'client-1',
    { Version: '1.2.3', Vitals: { CPU: { Usage: 42 }, Ram: {}, Uptime: {} } },
    '10.0.0.5'
  );
  assert.equal(heartbeatErr, null);

  const [systemInfoErr] = await Manager.SystemInfo(
    'client-1',
    {
      Hostname: 'Arcade PC',
      MacAddresses: {
        ethernet: { ipv4: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:ff' },
      },
    },
    '10.0.0.5'
  );
  assert.equal(systemInfoErr, null);

  assert.deepEqual(trackedRuns, []);
  assert.deepEqual(
    untrackedRuns.map(([sql]) => sql),
    [
      'UPDATE Clients SET Version = ? WHERE UUID = ?',
      'UPDATE Clients SET IP = ? WHERE UUID = ?',
      'UPDATE Clients SET Hostname = ? WHERE UUID = ?',
      'UPDATE Clients SET MacAddress = ? WHERE UUID = ?',
    ]
  );
  assert.ok(events.some(([event]) => event === 'ClientUpdated'));
});

test('ClientManager manual updates still use dirty-tracked writes', async () => {
  const trackedRuns = [];
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async () => [
          null,
          {
            UUID: 'client-2',
            Hostname: 'Original',
            Nickname: 'Original',
            Version: '1.0.0',
            IP: '10.0.0.2',
            MacAddress: null,
            GroupID: null,
            Weight: 100,
            Timestamp: Date.now(),
          },
        ],
        Run: async (sql, params) => {
          trackedRuns.push([sql, params]);
          return [null, { changes: 1 }];
        },
        RunWithoutDirtyTracking: async () => {
          throw new Error('Manual update should not bypass dirty tracking');
        },
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../SettingsManager': { Manager: { GetValue: async () => false } },
    '../Utils': require('../src/Modules/Utils'),
  });

  const [updateErr] = await Manager.Update('client-2', { Nickname: 'Renamed' });
  assert.equal(updateErr, null);
  assert.deepEqual(trackedRuns, [
    ['UPDATE Clients SET Nickname = ? WHERE UUID = ?', ['Renamed', 'client-2']],
  ]);
});
