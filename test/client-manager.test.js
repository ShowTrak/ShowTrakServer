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

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js');
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
    '../Utils': require('../dist/Modules/Utils'),
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
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js');
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
    '../Utils': require('../dist/Modules/Utils'),
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
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js');
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
    '../Utils': require('../dist/Modules/Utils'),
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
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async (sql, params) => {
          if (
            String(sql).includes('SELECT * FROM Clients WHERE UUID = ?') &&
            params[0] === 'client-4'
          ) {
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
    '../Utils': require('../dist/Modules/Utils'),
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

  // The first snapshot of a connection is a baseline, not a set of transitions.
  // Diffing it against the empty list this process started with would announce
  // every application on the machine as freshly started — which is what every
  // client did at once whenever the server restarted.
  assert.equal(
    events.filter(([event]) => event === 'ApplicationStarted').length,
    0,
    'the opening snapshot must not report applications as started'
  );

  const [, clientAfterFirstSnapshot] = await Manager.Get('client-4');
  clientAfterFirstSnapshot.SetOnline(true);
  // Backdated past the start-up window (CLIENT_STARTUP_GRACE_MS): a machine
  // that has finished booting has its missing critical application published
  // rather than held. The window itself is covered in the integration tests.
  clientAfterFirstSnapshot.OnlineSince = 0;
  clientAfterFirstSnapshot._refreshClientHealthState();
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

  // Chrome was already in the baseline, so only Spotify actually started.
  assert.ok(
    events.some(
      ([event, _client, app]) => event === 'ApplicationStarted' && app?.Name === 'Spotify'
    )
  );
  assert.ok(
    !events.some(
      ([event, _client, app]) => event === 'ApplicationStarted' && app?.Name === 'Chrome'
    )
  );

  const [thirdRunningErr] = await Manager.SetRunningApplications('client-4', {
    SampledAt: 300,
    TotalCount: 0,
    Truncated: false,
    Items: [],
  });
  assert.equal(thirdRunningErr, null);
  assert.ok(
    events.some(([event, _client, app]) => event === 'ApplicationStopped' && app?.Name === 'Chrome')
  );
  assert.ok(
    events.some(
      ([event, _client, app]) => event === 'ApplicationStopped' && app?.Name === 'Spotify'
    )
  );

  assert.ok(
    trackedRuns.some(([sql]) => sql.includes('INSERT OR REPLACE INTO CriticalApplications'))
  );
});

// The client reports an EMPTY list with a non-ok status when its sampler fails —
// macOS withholding automation permission at start-up being the common one.
// Diffing against that used to announce every application on the machine as
// stopped, firing a critical-application alert for software that never stopped,
// and then announcing them all as started again when the sampler recovered.
test('ClientManager ignores a failed application sample instead of reporting everything stopped', async () => {
  const events = [];
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async (sql, params) => {
          if (
            String(sql).includes('SELECT * FROM Clients WHERE UUID = ?') &&
            params[0] === 'client-9'
          ) {
            return [
              null,
              {
                UUID: 'client-9',
                Hostname: 'Booth PC',
                Nickname: 'Booth PC',
                Version: '1.0.0',
                IP: '10.0.0.9',
                OperatingSystem: 'macOS',
                MacAddress: null,
                GroupID: null,
                Weight: 100,
                Timestamp: Date.now(),
              },
            ];
          }
          return [null, null];
        },
        Run: async () => [null, { changes: 1 }],
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
        All: async () => [null, []],
      },
    },
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
    '../SettingsManager': { Manager: { GetValue: async () => false } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  const ok = { State: 'ok', Message: null, Platform: 'darwin' };

  // Baseline, then a second sample so the baseline is an observed one.
  await Manager.SetRunningApplications('client-9', {
    SampledAt: 100,
    TotalCount: 1,
    Truncated: false,
    Items: [{ Name: 'QLab', Count: 1 }],
    Status: ok,
  });
  await Manager.SetRunningApplications('client-9', {
    SampledAt: 200,
    TotalCount: 2,
    Truncated: false,
    Items: [
      { Name: 'QLab', Count: 1 },
      { Name: 'Finder', Count: 1 },
    ],
    Status: ok,
  });
  assert.ok(
    events.some(([event, , app]) => event === 'ApplicationStarted' && app?.Name === 'Finder'),
    'a genuine start is still reported'
  );

  const before = events.length;
  await Manager.SetRunningApplications('client-9', {
    SampledAt: 300,
    TotalCount: 0,
    Truncated: false,
    Items: [],
    Status: {
      State: 'permission_denied',
      Message: 'macOS denied access to System Events.',
      Platform: 'darwin',
    },
  });
  const duringFailure = events.slice(before);
  assert.equal(
    duringFailure.filter(([event]) => event === 'ApplicationStopped').length,
    0,
    'a sample that failed is not evidence that anything stopped'
  );
  // The status itself is still stored, so the UI can explain the gap.
  const [, client] = await Manager.Get('client-9');
  assert.equal(client.RunningApplications.Status.State, 'permission_denied');

  // Recovery does not replay the whole machine as freshly started either: the
  // failed sample left no baseline worth diffing, so the next one becomes it.
  const beforeRecovery = events.length;
  await Manager.SetRunningApplications('client-9', {
    SampledAt: 400,
    TotalCount: 2,
    Truncated: false,
    Items: [
      { Name: 'QLab', Count: 1 },
      { Name: 'Finder', Count: 1 },
    ],
    Status: ok,
  });
  assert.equal(
    events.slice(beforeRecovery).filter(([event]) => event === 'ApplicationStarted').length,
    0,
    'recovering the sampler is not a start event for everything it can see'
  );

  // From there, real transitions report again.
  await Manager.SetRunningApplications('client-9', {
    SampledAt: 500,
    TotalCount: 1,
    Truncated: false,
    Items: [{ Name: 'QLab', Count: 1 }],
    Status: ok,
  });
  assert.ok(
    events.some(([event, , app]) => event === 'ApplicationStopped' && app?.Name === 'Finder')
  );
});

// A failed persist must not leave RAM claiming a change the row rejected: the
// setter rolls its in-memory value back, and Manager.Update surfaces the failure
// instead of reporting Ok.
test('ClientManager.Update reports a persist failure and rolls back the in-memory value', async () => {
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async () => [
          null,
          {
            UUID: 'client-rollback',
            Hostname: 'Original',
            Nickname: 'Original',
            Version: '1.0.0',
            IP: '10.0.0.9',
            OperatingSystem: null,
            MacAddress: null,
            GroupID: null,
            Weight: 100,
            Timestamp: Date.now(),
          },
        ],
        // Every dirty-tracked write fails, so the Nickname persist is rejected.
        Run: async () => ['disk full', null],
        RunWithoutDirtyTracking: async () => ['disk full', null],
        All: async () => [null, []],
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../SettingsManager': { Manager: { GetValue: async () => false } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  const [updateErr] = await Manager.Update('client-rollback', { Nickname: 'Renamed' });
  assert.ok(updateErr, 'Update must surface the persist failure');

  // The cached instance must still read as the original name, not the rejected one.
  const [, client] = await Manager.Get('client-rollback');
  assert.equal(client.Nickname, 'Original');
});

// A no-op update (value unchanged) is success, and Update returns the client.
test('ClientManager.Update returns Ok when a setter persists successfully', async () => {
  const trackedRuns = [];
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async () => [
          null,
          {
            UUID: 'client-ok',
            Hostname: 'Original',
            Nickname: 'Original',
            Version: '1.0.0',
            IP: '10.0.0.8',
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
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
        All: async () => [null, []],
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../SettingsManager': { Manager: { GetValue: async () => false } },
    '../Utils': require('../dist/Modules/Utils'),
  });

  const [updateErr, updated] = await Manager.Update('client-ok', { Nickname: 'Booth' });
  assert.equal(updateErr, null);
  assert.equal(updated.Nickname, 'Booth');
  assert.deepEqual(trackedRuns, [
    ['UPDATE Clients SET Nickname = ? WHERE UUID = ?', ['Booth', 'client-ok']],
  ]);
});
