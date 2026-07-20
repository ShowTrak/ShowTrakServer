const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const modulePath = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'MonitoringTargetManager',
  'index.js'
);

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

// Boot fires MonitoringTargetManager.Init() without awaiting it, and both
// BackfillSlugs() and GetAll() then run `if (!Initialized) await Init()` while
// that first run is still awaiting the DB. Every read below is deliberately slow
// so a second Init would interleave rather than run to completion first.
function loadManager({ events, onTargetsRead }) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const dbMock = {
    Manager: {
      All: async (sql) => {
        await tick();
        await tick();
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
                Settings: '{}',
                DegradedThresholdMs: 1000,
                Weight: 100,
                LastSuccessAt: null,
                Timestamp: 10,
              },
            ],
          ];
        }
        if (onTargetsRead) onTargetsRead();
        return [
          null,
          [
            {
              TargetID: 7,
              Nickname: 'API Health',
              Address: '',
              Method: '',
              Interval: 30000,
              Settings: '{}',
              GroupID: null,
              Weight: 100,
              LastSuccessAt: null,
              DegradedThresholdMs: 1000,
              Timestamp: 10,
            },
          ],
        ];
      },
      Run: async () => {
        await tick();
        return [null, { changes: 1 }];
      },
      RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
      WithTransaction: async (fn) => [null, await fn(dbMock.Manager.Run)],
    },
  };

  return loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {}, log: () => {} }) },
    '../DB': dbMock,
    '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
    '../MonitoringMethods': {
      Manager: {
        Has: (id) => id === 'http' || id === 'ping',
        NormalizeSettings: (_id, settings) => ({ ...settings }),
        Run: async () => ({ Success: true, LatencyMs: 25 }),
        BuildDebug: () => '<div>debug</div>',
      },
    },
    '../Utils': require('../dist/Modules/Utils'),
  }).Manager;
}

test('Concurrent Init() calls share one run instead of building competing target lists', async () => {
  await withFakeTimers(async () => {
    const events = [];
    let targetsReads = 0;
    const Manager = loadManager({ events, onTargetsRead: () => (targetsReads += 1) });

    // Boot's fire-and-forget Init, then the two callers that race it.
    const boot = Manager.Init();
    const backfill = Manager.Init();
    const hydrate = Manager.GetAll();
    await Promise.all([boot, backfill, hydrate]);

    assert.equal(
      targetsReads,
      1,
      'a second rebuild means a second set of MonitoringTarget objects for the same TargetID'
    );
    assert.equal(
      events.filter(([event]) => event === 'MonitoringTargetListChanged').length,
      1,
      'Init must announce the rebuilt list exactly once'
    );
  });
});

test('A target renamed after boot has exactly one live loop broadcasting its name', async () => {
  await withFakeTimers(async (timers) => {
    const events = [];
    const Manager = loadManager({ events });

    await Promise.all([Manager.Init(), Manager.Init(), Manager.GetAll()]);

    const [updateErr] = await Manager.Update(7, { Nickname: 'Renamed' });
    assert.equal(updateErr, null);

    // Fire every armed timer. An orphaned target from a duplicate Init would
    // still be holding the pre-rename Nickname and broadcast it here, which is
    // what makes the tile alternate between the old and new name.
    events.length = 0;
    const live = timers.filter((handle) => handle && !handle.cleared);
    await Promise.all(live.map((handle) => handle.cb()));

    const names = events
      .filter(([event]) => event === 'MonitoringTargetUpdated')
      .map(([, payload]) => payload.Nickname);
    assert.ok(names.length > 0, 'the surviving loop must still be polling');
    assert.deepEqual(
      [...new Set(names)],
      ['Renamed'],
      'every broadcast for this target must carry the current name'
    );

    const [, all] = await Manager.GetAll();
    assert.equal(all.length, 1, 'the target must not be duplicated in the list');

    await Manager.Shutdown();
  });
});
