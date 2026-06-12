const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function withFakeTimers(fn) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];

  global.setTimeout = (cb, ms) => {
    const handle = { cb, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle) handle.cleared = true;
  };

  return Promise.resolve()
    .then(() => fn(timers))
    .finally(() => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });
}

test('MonitoringTargetManager initializes rows and handles create/update/delete lifecycle', async () => {
  await withFakeTimers(async (timers) => {
    const runCalls = [];
    const untrackedRunCalls = [];
    const events = [];
    const normalizeCalls = [];

    const dbMock = {
      Manager: {
        All: async () => [
          null,
          [
            {
              TargetID: 7,
              Nickname: 'API Health',
              Address: 'api.local',
              Method: 'http',
              Interval: 1,
              Settings: JSON.stringify({ Path: '/health' }),
              GroupID: 3,
              Weight: 80,
              LastSuccessAt: null,
              DegradedThresholdMs: 999999,
              Timestamp: 10,
            },
          ],
        ],
        Run: async (sql, params) => {
          runCalls.push([sql, params]);
          if (sql.includes('INSERT INTO MonitoringTargets')) return [null, { lastID: 12 }];
          return [null, { changes: 1 }];
        },
        RunWithoutDirtyTracking: async (sql, params) => {
          untrackedRunCalls.push([sql, params]);
          return [null, { changes: 1 }];
        },
      },
    };

    const methodSet = new Set(['ping', 'http']);

    const monitoringMethodsMock = {
      Manager: {
        Has: (id) => methodSet.has(id),
        NormalizeSettings: (id, settings) => {
          normalizeCalls.push([id, settings]);
          return { method: id, ...settings };
        },
        Run: async () => ({ Success: true, LatencyMs: 25 }),
      },
    };

    const modulePath = path.join(
      __dirname,
      '..',
      'src',
      'Modules',
      'MonitoringTargetManager',
      'index.js'
    );
    const { Manager } = loadWithMocks(modulePath, {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': dbMock,
      '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
      '../MonitoringMethods': monitoringMethodsMock,
      '../Utils': require('../src/Modules/Utils'),
    });

    await Manager.Init();

    const [allErr, allTargets] = await Manager.GetAll();
    assert.equal(allErr, null);
    assert.equal(allTargets.length, 1);
    assert.equal(allTargets[0].Interval, Manager.MIN_INTERVAL_MS);
    assert.equal(allTargets[0].DegradedThresholdMs, 600000);
    assert.deepEqual(allTargets[0].Settings, { Path: '/health' });

    const [createFailErr, createFailValue] = await Manager.Create({
      Nickname: 'Bad',
      Address: 'bad.local',
      Method: 'dns',
      Interval: 1000,
      Settings: {},
    });
    assert.match(createFailErr, /Unknown monitoring method/i);
    assert.equal(createFailValue, null);

    const [createErr, created] = await Manager.Create({
      Nickname: 'Ping Check',
      Address: '10.0.0.12',
      Method: 'ping',
      Interval: 1,
      Settings: { Timeout: 555 },
      GroupID: 4,
      Weight: 90,
      DegradedThresholdMs: -10,
    });
    assert.equal(createErr, null);
    assert.equal(created.Interval, Manager.MIN_INTERVAL_MS);
    assert.equal(created.DegradedThresholdMs, 0);

    const insertCall = runCalls.find(([sql]) => sql.includes('INSERT INTO MonitoringTargets'));
    assert.ok(insertCall);
    assert.equal(insertCall[1][3], Manager.MIN_INTERVAL_MS);
    assert.equal(insertCall[1][4], 1);

    const firstScheduledTick = timers.find(
      (handle) => handle && !handle.cleared && typeof handle.cb === 'function'
    );
    assert.ok(firstScheduledTick);
    await firstScheduledTick.cb();

    assert.ok(
      untrackedRunCalls.some(([sql]) =>
        sql.includes('UPDATE MonitoringTargets SET LastSuccessAt = ? WHERE TargetID = ?')
      )
    );

    const [updateErr, updated] = await Manager.Update(12, {
      Method: 'http',
      Interval: 99999999,
      Settings: { Path: '/status' },
      DegradedThresholdMs: 700000,
    });
    assert.equal(updateErr, null);
    assert.equal(updated.Interval, Manager.MAX_INTERVAL_MS);
    assert.equal(updated.DegradedThresholdMs, 600000);
    assert.equal(updated.Method, 'http');
    assert.deepEqual(updated.Settings, { method: 'http', Path: '/status' });

    const [groupErr, groupResult] = await Manager.SetGroupAndWeight(12, 11, 123);
    assert.equal(groupErr, null);
    assert.equal(groupResult, true);

    const [getErr, fetched] = await Manager.Get(12);
    assert.equal(getErr, null);
    assert.equal(fetched.GroupID, 11);
    assert.equal(fetched.Weight, 123);

    const [deleteErr, deleted] = await Manager.Delete(12);
    assert.equal(deleteErr, null);
    assert.equal(deleted, true);

    const [missingDeleteErr, missingDeleteValue] = await Manager.Delete(999);
    assert.match(missingDeleteErr, /not found/i);
    assert.equal(missingDeleteValue, null);

    assert.ok(normalizeCalls.some(([id]) => id === 'ping'));
    assert.ok(normalizeCalls.some(([id]) => id === 'http'));
    assert.ok(events.some(([event]) => event === 'MonitoringTargetListChanged'));
  });
});

test('MonitoringTargetManager reload replaces runtime list from latest DB rows', async () => {
  await withFakeTimers(async () => {
    let allCall = 0;
    const dbMock = {
      Manager: {
        All: async () => {
          allCall += 1;
          if (allCall === 1) {
            return [
              null,
              [
                {
                  TargetID: 1,
                  Nickname: 'Old Target',
                  Address: 'old.local',
                  Method: 'ping',
                  Interval: 30000,
                  Settings: '{}',
                  GroupID: null,
                  Weight: 100,
                  LastSuccessAt: null,
                  DegradedThresholdMs: 0,
                  Timestamp: 1,
                },
              ],
            ];
          }
          return [
            null,
            [
              {
                TargetID: 2,
                Nickname: 'Restored Target',
                Address: 'restored.local',
                Method: 'ping',
                Interval: 30000,
                Settings: '{}',
                GroupID: null,
                Weight: 100,
                LastSuccessAt: null,
                DegradedThresholdMs: 0,
                Timestamp: 2,
              },
            ],
          ];
        },
        Run: async () => [null, { changes: 1 }],
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
      },
    };

    const modulePath = path.join(
      __dirname,
      '..',
      'src',
      'Modules',
      'MonitoringTargetManager',
      'index.js'
    );
    const { Manager } = loadWithMocks(modulePath, {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': dbMock,
      '../Broadcast': { Manager: { emit: () => {} } },
      '../MonitoringMethods': {
        Manager: {
          Has: () => true,
          NormalizeSettings: (_id, settings) => settings,
          Run: async () => ({ Success: true, LatencyMs: 10 }),
        },
      },
      '../Utils': require('../src/Modules/Utils'),
    });

    await Manager.Init();
    let [_beforeErr, before] = await Manager.GetAll();
    assert.equal(before.length, 1);
    assert.equal(before[0].TargetID, 1);

    await Manager.Reload();
    let [_afterErr, after] = await Manager.GetAll();
    assert.equal(after.length, 1);
    assert.equal(after[0].TargetID, 2);
    assert.equal(after[0].Nickname, 'Restored Target');
  });
});

test('MonitoringTargetManager moves group members and orphaned targets to no group', async () => {
  await withFakeTimers(async () => {
    const runCalls = [];
    const events = [];

    const dbMock = {
      Manager: {
        All: async () => [
          null,
          [
            {
              TargetID: 1,
              Nickname: 'A',
              Address: 'a.local',
              Method: 'ping',
              Interval: 30000,
              Settings: '{}',
              GroupID: 3,
              Weight: 100,
              LastSuccessAt: null,
              DegradedThresholdMs: 0,
              Timestamp: 1,
            },
            {
              TargetID: 2,
              Nickname: 'B',
              Address: 'b.local',
              Method: 'ping',
              Interval: 30000,
              Settings: '{}',
              GroupID: 99,
              Weight: 100,
              LastSuccessAt: null,
              DegradedThresholdMs: 0,
              Timestamp: 2,
            },
          ],
        ],
        Run: async (sql, params) => {
          runCalls.push([sql, params]);
          return [null, { changes: 1 }];
        },
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
      },
    };

    const modulePath = path.join(
      __dirname,
      '..',
      'src',
      'Modules',
      'MonitoringTargetManager',
      'index.js'
    );
    const { Manager } = loadWithMocks(modulePath, {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': dbMock,
      '../Broadcast': { Manager: { emit: (event) => events.push(event) } },
      '../MonitoringMethods': {
        Manager: {
          Has: () => true,
          NormalizeSettings: (_id, settings) => settings,
          Run: async () => ({ Success: true, LatencyMs: 10 }),
        },
      },
      '../Utils': require('../src/Modules/Utils'),
    });

    await Manager.Init();

    const [moveErr, movedCount] = await Manager.MoveGroupToNoGroup(3);
    assert.equal(moveErr, null);
    assert.equal(movedCount, 1);

    const [reconcileErr, reconciledCount] = await Manager.ReconcileOrphanedGroups([3]);
    assert.equal(reconcileErr, null);
    assert.equal(reconciledCount, 1);

    const [allErr, allTargets] = await Manager.GetAll();
    assert.equal(allErr, null);
    assert.equal(allTargets[0].GroupID, null);
    assert.equal(allTargets[1].GroupID, null);

    assert.ok(
      runCalls.some(
        ([sql, params]) =>
          sql.includes('UPDATE MonitoringTargets SET GroupID = ? WHERE TargetID = ?') &&
          params[0] === null
      )
    );
    assert.ok(events.filter((event) => event === 'MonitoringTargetListChanged').length >= 2);
  });
});
