// FreeKioskManager.Init() under the boot race.
//
// Boot fires Init() without awaiting it, and BackfillSlugs() and the renderer's
// first GetAll() then run `if (!Initialized) await Init()` while that first run
// is still awaiting the DB. Before Init was single-flight each of those built its
// own TerminalList and started its own poll loops; the losing list kept polling
// with the settings it was loaded with, out of reach of every edit. The field
// symptom was a Power Source condition re-set to "Expected ac" that still raised
// "Power Source is ac (expected anything but ac)" for a moment every interval —
// the orphan's broadcast, immediately overwritten by the live loop's.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { STATUS_HEALTHY } = require('./helpers/freekiosk-device');

const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'FreeKioskManager', 'index.js');

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

// The show file as it stood before the edit: alarming while the tablet is on
// a wall charger, which the healthy fixture (plugged: 'ac') is.
const STORED_ROW = {
  UUID: 'kiosk-1',
  Slug: 'kiosk-1',
  Nickname: 'Lobby',
  Address: '192.168.1.50',
  Port: 8080,
  ApiKey: null,
  Interval: 30000,
  TimeoutMs: 5000,
  Settings: JSON.stringify({
    G_Battery_On: true,
    A_battery_plugged_On: true,
    A_battery_plugged_Op: 'is',
    A_battery_plugged_V: 'ac',
  }),
  GroupID: null,
  Weight: 100,
  LastSuccessAt: null,
  Timestamp: 10,
};

function loadManager({ events, onTerminalsRead }) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // Every read is deliberately slow so a second Init would interleave rather
  // than run to completion first.
  const dbMock = {
    Manager: {
      All: async (sql) => {
        await tick();
        await tick();
        if (String(sql).includes('FROM FreeKioskTerminals')) {
          if (onTerminalsRead) onTerminalsRead();
          return [null, [{ ...STORED_ROW }]];
        }
        return [null, []];
      },
      Run: async () => {
        await tick();
        return [null, { changes: 1 }];
      },
      RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
    },
  };

  delete require.cache[require.resolve('../dist/Modules/Slug/index.js')];
  return loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ debug: () => {}, error: () => {}, log: () => {}, warn: () => {} }),
    },
    '../DB': dbMock,
    '../Broadcast': { Manager: { emit: (event, payload) => events.push([event, payload]) } },
    '../FreeKiosk/client': {
      ...require('../dist/Modules/FreeKiosk/client'),
      GetStatus: async () => [null, { Status: STATUS_HEALTHY, LatencyMs: 5 }],
    },
    '../Utils': require('../dist/Modules/Utils'),
  }).Manager;
}

test('concurrent Init() calls share one run instead of building competing terminal lists', async () => {
  await withFakeTimers(async () => {
    const events = [];
    let terminalsReads = 0;
    const Manager = loadManager({ events, onTerminalsRead: () => (terminalsReads += 1) });

    // Boot's fire-and-forget Init, then the two callers that race it.
    await Promise.all([Manager.Init(), Manager.BackfillSlugs(), Manager.GetAll()]);

    assert.equal(
      terminalsReads,
      1,
      'a second rebuild means a second FreeKioskTerminal polling the same device'
    );
    assert.equal(
      events.filter(([event]) => event === 'FreeKioskTerminalListChanged').length,
      1,
      'Init must announce the list exactly once'
    );
    await Manager.Shutdown();
  });
});

test('a condition changed after boot is judged by exactly one loop, with the new settings', async () => {
  await withFakeTimers(async (timers) => {
    const events = [];
    const Manager = loadManager({ events });

    await Promise.all([Manager.Init(), Manager.BackfillSlugs(), Manager.GetAll()]);

    const [, [before]] = await Manager.GetAll();
    const [updateErr] = await Manager.Update('kiosk-1', {
      Settings: { ...before.Settings, A_battery_plugged_Op: 'isNot' },
    });
    assert.equal(updateErr, null);

    // Fire every armed timer, twice over, as successive intervals would. An
    // orphaned terminal from a duplicate Init would still hold `is ac` and
    // broadcast a degraded snapshot here.
    events.length = 0;
    for (let round = 0; round < 2; round++) {
      const live = timers.filter((handle) => handle && !handle.cleared && !handle.fired);
      for (const handle of live) handle.fired = true;
      await Promise.all(live.map((handle) => handle.cb()));
    }

    const polls = events.filter(([event]) => event === 'FreeKioskTerminalUpdated');
    assert.equal(polls.length, 2, 'one terminal, polled once per interval');
    for (const [, snapshot] of polls) {
      assert.equal(snapshot.Degraded, false);
      assert.deepEqual(snapshot.Alarms, []);
    }

    const [, all] = await Manager.GetAll();
    assert.equal(all.length, 1, 'the terminal must not be duplicated in the list');
    await Manager.Shutdown();
  });
});

test('a reload during an in-flight Init still leaves one loop per terminal', async () => {
  await withFakeTimers(async (timers) => {
    const events = [];
    const Manager = loadManager({ events });

    await Promise.all([Manager.Init(), Manager.Reload()]);

    events.length = 0;
    const live = timers.filter((handle) => handle && !handle.cleared);
    await Promise.all(live.map((handle) => handle.cb()));

    const polls = events.filter(([event]) => event === 'FreeKioskTerminalUpdated');
    assert.equal(polls.length, 1, 'the first run’s loops must not survive the reload');
    await Manager.Shutdown();
  });
});
