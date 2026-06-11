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
    OperatingSystem: null,
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
      OperatingSystem: 'Windows',
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
      'UPDATE Clients SET OperatingSystem = ? WHERE UUID = ?',
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
            OperatingSystem: null,
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

test('ClientManager stores running applications as runtime-only state', async () => {
  const trackedRuns = [];
  const untrackedRuns = [];
  const events = [];
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async () => [
          null,
          {
            UUID: 'client-3',
            Hostname: 'Arcade PC',
            Nickname: 'Arcade PC',
            Version: '1.0.0',
            IP: '10.0.0.3',
            OperatingSystem: 'Windows',
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

  const [setErr] = await Manager.SetRunningApplications('client-3', {
    SampledAt: 123456,
    TotalCount: 3,
    Truncated: false,
    Items: [
      { Name: 'Chrome', Count: 2 },
      { Name: 'chrome', Count: 1 },
      { Name: 'Spotify', Count: 1 },
    ],
  });
  assert.equal(setErr, null);

  const [getErr, client] = await Manager.Get('client-3');
  assert.equal(getErr, null);
  assert.deepEqual(client.RunningApplications, {
    SampledAt: 123456,
    TotalCount: 3,
    Truncated: false,
    Status: {
      State: 'ok',
      Message: null,
      Platform: null,
    },
    Items: [
      {
        Name: 'Chrome',
        Count: 3,
        Key: 'chrome',
        IsRunning: true,
        IsCritical: false,
        Missing: false,
      },
      {
        Name: 'Spotify',
        Count: 1,
        Key: 'spotify',
        IsRunning: true,
        IsCritical: false,
        Missing: false,
      },
    ],
  });
  assert.deepEqual(trackedRuns, []);
  assert.deepEqual(untrackedRuns, []);
  assert.ok(events.some(([event]) => event === 'ClientUpdated'));
});

test('ClientManager tracks critical applications and emits started/stopped transitions', async () => {
  const trackedRuns = [];
  const events = [];
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async (sql, params) => {
          if (String(sql).includes('SELECT * FROM Clients WHERE UUID = ?') && params[0] === 'client-4') {
            return [
              null,
              {
                UUID: 'client-4',
                Hostname: 'Arcade PC',
                Nickname: 'Arcade PC',
                Version: '1.0.0',
                IP: '10.0.0.4',
                OperatingSystem: 'Windows',
                MacAddress: null,
                GroupID: null,
                Weight: 100,
                Timestamp: Date.now(),
              },
            ];
          }
          return [null, null];
        },
        Run: async (sql, params) => {
          trackedRuns.push([sql, params]);
          return [null, { changes: 1 }];
        },
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
        All: async () => [null, []],
      },
    },
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
    '../SettingsManager': { Manager: { GetValue: async () => false } },
    '../Utils': require('../src/Modules/Utils'),
  });

  const [markErr] = await Manager.MarkApplicationCritical('client-4', { Name: 'Spotify' });
  assert.equal(markErr, null);

  const [runningErr] = await Manager.SetRunningApplications('client-4', {
    SampledAt: 100,
    TotalCount: 1,
    Truncated: false,
    Items: [{ Name: 'Chrome', Count: 1 }],
  });
  assert.equal(runningErr, null);

  const [, clientAfterFirstSnapshot] = await Manager.Get('client-4');
  clientAfterFirstSnapshot.SetOnline(true);
  assert.equal(clientAfterFirstSnapshot.Degraded, true);
  assert.deepEqual(clientAfterFirstSnapshot.DegradedWarnings, ['Critical Application Issue']);
  assert.ok(
    clientAfterFirstSnapshot.RunningApplications.Items.some(
      (Entry) => Entry.Name === 'Spotify' && Entry.IsRunning === false && Entry.IsCritical === true
    )
  );

  const [secondRunningErr] = await Manager.SetRunningApplications('client-4', {
    SampledAt: 200,
    TotalCount: 2,
    Truncated: false,
    Items: [
      { Name: 'Chrome', Count: 1 },
      { Name: 'Spotify', Count: 1 },
    ],
  });
  assert.equal(secondRunningErr, null);

  assert.ok(events.some(([event, _client, app]) => event === 'ApplicationStarted' && app?.Name === 'Chrome'));
  assert.ok(events.some(([event, _client, app]) => event === 'ApplicationStarted' && app?.Name === 'Spotify'));

  const [thirdRunningErr] = await Manager.SetRunningApplications('client-4', {
    SampledAt: 300,
    TotalCount: 0,
    Truncated: false,
    Items: [],
  });
  assert.equal(thirdRunningErr, null);
  assert.ok(events.some(([event, _client, app]) => event === 'ApplicationStopped' && app?.Name === 'Chrome'));
  assert.ok(events.some(([event, _client, app]) => event === 'ApplicationStopped' && app?.Name === 'Spotify'));

  assert.ok(
    trackedRuns.some(([sql]) => sql.includes('INSERT OR REPLACE INTO CriticalApplications'))
  );
});
