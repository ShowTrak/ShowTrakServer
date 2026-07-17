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
    let nextInsertID = 100;

    const dbMock = {
      Manager: {
        All: async (sql) => {
          if (String(sql).includes('MonitoringChecks')) {
            return [
              null,
              [
                {
                  CheckID: 70,
                  TargetID: 7,
                  Name: 'Health',
                  Address: 'api.local',
                  Method: 'http',
                  Settings: JSON.stringify({ Path: '/health' }),
                  DegradedThresholdMs: 999999,
                  Weight: 100,
                  LastSuccessAt: null,
                  Timestamp: 10,
                },
              ],
            ];
          }
          return [
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
          ];
        },
        Run: async (sql, params) => {
          runCalls.push([sql, params]);
          if (sql.includes('INSERT INTO MonitoringTargets')) return [null, { lastID: 12 }];
          if (sql.includes('INSERT INTO MonitoringChecks'))
            return [null, { lastID: nextInsertID++ }];
          return [null, { changes: 1 }];
        },
        RunWithoutDirtyTracking: async (sql, params) => {
          untrackedRunCalls.push([sql, params]);
          return [null, { changes: 1 }];
        },
        WithTransaction: async (fn) => {
          try {
            return [null, await fn(dbMock.Manager.Run)];
          } catch (err) {
            return [err, null];
          }
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
      'dist',
      'Modules',
      'MonitoringTargetManager',
      'index.js'
    );
    const { Manager } = loadWithMocks(modulePath, {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': dbMock,
      '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
      '../MonitoringMethods': monitoringMethodsMock,
      '../Utils': require('../dist/Modules/Utils'),
    });

    await Manager.Init();

    const [allErr, allTargets] = await Manager.GetAll();
    assert.equal(allErr, null);
    assert.equal(allTargets.length, 1);
    assert.equal(allTargets[0].Interval, Manager.MIN_INTERVAL_MS);
    assert.equal(allTargets[0].Checks.length, 1);
    assert.equal(allTargets[0].Checks[0].DegradedThresholdMs, 600000);
    assert.deepEqual(allTargets[0].Checks[0].Settings, { Path: '/health', Protocol: 'http' });

    const [createFailErr, createFailValue] = await Manager.Create({
      Nickname: 'Bad',
      Interval: 1000,
      Checks: [{ Address: 'bad.local', Method: 'dns', Settings: {} }],
    });
    assert.match(createFailErr, /Unknown monitoring method/i);
    assert.equal(createFailValue, null);

    const [createErr, created] = await Manager.Create({
      Nickname: 'Ping Check',
      Interval: 1,
      GroupID: 4,
      Weight: 90,
      Checks: [
        {
          Name: 'Ping',
          Address: '10.0.0.12',
          Method: 'ping',
          Settings: { Timeout: 555 },
          DegradedThresholdMs: -10,
        },
      ],
    });
    assert.equal(createErr, null);
    assert.equal(created.Interval, Manager.MIN_INTERVAL_MS);
    assert.equal(created.Checks.length, 1);
    assert.equal(created.Checks[0].DegradedThresholdMs, 0);

    const targetInsert = runCalls.find(([sql]) => sql.includes('INSERT INTO MonitoringTargets'));
    assert.ok(targetInsert);
    assert.equal(targetInsert[1][3], Manager.MIN_INTERVAL_MS);
    const checkInsert = runCalls.find(([sql]) => sql.includes('INSERT INTO MonitoringChecks'));
    assert.ok(checkInsert);
    assert.deepEqual(JSON.parse(checkInsert[1][4]), { method: 'ping', Timeout: 555 });

    const firstScheduledTick = timers.find(
      (handle) => handle && !handle.cleared && typeof handle.cb === 'function'
    );
    assert.ok(firstScheduledTick);
    await firstScheduledTick.cb();

    assert.ok(
      untrackedRunCalls.some(([sql]) =>
        sql.includes('UPDATE MonitoringChecks SET LastSuccessAt = ? WHERE CheckID = ?')
      )
    );

    // Update: edit the existing check (method change) + add a second check.
    const createdCheckID = created.Checks[0].CheckID;
    const [updateErr, updated] = await Manager.Update(12, {
      Interval: 99999999,
      Checks: [
        {
          CheckID: createdCheckID,
          Address: '10.0.0.12',
          Method: 'http',
          Settings: { Path: '/status' },
          DegradedThresholdMs: 700000,
        },
        { Address: '10.0.0.13', Method: 'ping', Settings: {} },
      ],
    });
    assert.equal(updateErr, null);
    assert.equal(updated.Interval, Manager.MAX_INTERVAL_MS);
    assert.equal(updated.Checks.length, 2);
    assert.equal(updated.Checks[0].Method, 'http');
    assert.equal(updated.Checks[0].DegradedThresholdMs, 600000);
    assert.deepEqual(updated.Checks[0].Settings, { method: 'http', Path: '/status' });

    // Update again removing the second check.
    const [shrinkErr, shrunk] = await Manager.Update(12, {
      Checks: [{ CheckID: createdCheckID, Address: '10.0.0.12', Method: 'http', Settings: {} }],
    });
    assert.equal(shrinkErr, null);
    assert.equal(shrunk.Checks.length, 1);
    assert.ok(
      runCalls.some(([sql]) => sql.includes('DELETE FROM MonitoringChecks WHERE CheckID = ?'))
    );

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
    assert.ok(
      runCalls.some(([sql]) => sql.includes('DELETE FROM MonitoringChecks WHERE TargetID = ?'))
    );

    const [missingDeleteErr, missingDeleteValue] = await Manager.Delete(999);
    assert.match(missingDeleteErr, /not found/i);
    assert.equal(missingDeleteValue, null);

    // A target may be created with zero checks; it surfaces as idle.
    const [emptyErr, emptyCreated] = await Manager.Create({
      Nickname: 'No Checks',
      Interval: 5000,
      Checks: [],
    });
    assert.equal(emptyErr, null);
    assert.equal(emptyCreated.Checks.length, 0);
    assert.equal(emptyCreated.Online, false);
    assert.equal(emptyCreated.Degraded, false);
    assert.equal(emptyCreated.LastError, null);

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
      'dist',
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
      '../Utils': require('../dist/Modules/Utils'),
    });

    await Manager.Init();
    const [_beforeErr, before] = await Manager.GetAll();
    assert.equal(before.length, 1);
    assert.equal(before[0].TargetID, 1);

    await Manager.Reload();
    const [_afterErr, after] = await Manager.GetAll();
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
      'dist',
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
      '../Utils': require('../dist/Modules/Utils'),
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

test('MonitoringTargetManager.RunCheckNow runs a check, broadcasts, and returns fresh debug', async () => {
  await withFakeTimers(async () => {
    const events = [];
    const untrackedRunCalls = [];

    const dbMock = {
      Manager: {
        All: async (sql) => {
          if (String(sql).includes('MonitoringChecks')) {
            return [
              null,
              [
                {
                  CheckID: 55,
                  TargetID: 9,
                  Name: 'Ping',
                  Address: '10.0.0.9',
                  Method: 'ping',
                  Settings: JSON.stringify({}),
                  DegradedThresholdMs: 0,
                  Weight: 100,
                  LastSuccessAt: null,
                  Timestamp: 1,
                },
              ],
            ];
          }
          return [
            null,
            [
              {
                TargetID: 9,
                Nickname: 'Node',
                Address: '10.0.0.9',
                Method: 'ping',
                Interval: 5000,
                Settings: JSON.stringify({}),
                GroupID: null,
                Weight: 100,
                LastSuccessAt: null,
                DegradedThresholdMs: 0,
                Timestamp: 1,
              },
            ],
          ];
        },
        Run: async () => [null, { changes: 1 }],
        RunWithoutDirtyTracking: async (sql, params) => {
          untrackedRunCalls.push([sql, params]);
          return [null, { changes: 1 }];
        },
      },
    };

    let runInvocations = 0;
    const monitoringMethodsMock = {
      Manager: {
        Has: () => true,
        NormalizeSettings: (_id, settings) => settings,
        Run: async () => {
          runInvocations += 1;
          return { Success: true, LatencyMs: 7 };
        },
        BuildDebug: () => '<div>debug-panel</div>',
      },
    };

    const modulePath = path.join(
      __dirname,
      '..',
      'dist',
      'Modules',
      'MonitoringTargetManager',
      'index.js'
    );
    const { Manager } = loadWithMocks(modulePath, {
      '../Logger': { CreateLogger: () => ({ error: () => {}, warn: () => {} }) },
      '../DB': dbMock,
      '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
      '../MonitoringMethods': monitoringMethodsMock,
      '../Utils': require('../dist/Modules/Utils'),
    });

    await Manager.Init();

    const [err, debug] = await Manager.RunCheckNow(55);
    assert.equal(err, null);
    assert.ok(runInvocations >= 1, 'the probe should have been executed');
    assert.equal(debug.CheckID, 55);
    assert.equal(debug.Method, 'ping');
    assert.equal(debug.Html, '<div>debug-panel</div>');
    assert.equal(debug.Online, true);
    assert.equal(debug.LastLatencyMs, 7);
    // The manual run persists the success timestamp and broadcasts an update.
    assert.ok(
      untrackedRunCalls.some(([sql]) => sql.includes('UPDATE MonitoringChecks SET LastSuccessAt'))
    );
    assert.ok(events.some(([event]) => event === 'MonitoringTargetUpdated'));

    const [missingErr, missingValue] = await Manager.RunCheckNow(999);
    assert.match(missingErr, /not found/i);
    assert.equal(missingValue, null);
  });
});
