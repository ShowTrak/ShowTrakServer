const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Covers src/main/autosave.ts — the periodic snapshot of the open show file back
// to its path. The other half of not losing a show (see
// test/main-shutdown-coordinator.test.js for the shutdown half).
//
// The real interval is at minimum 60s, so these drive node:test's mock timers
// rather than waiting.

let state;
let calls;

function resetState(overrides = {}) {
  state = {
    enabled: true,
    intervalMinutes: 5,
    currentFilePath: '/shows/current.showtrak',
    saveResult: [null, true],
    getValueThrows: false,
    ...overrides,
  };
  calls = { save: [], errors: [] };
}
resetState();

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: (...args) => calls.errors.push(args),
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

const restore = installModuleMocks([
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  {
    match: matchesModule('/Modules/SettingsManager'),
    value: {
      Manager: {
        GetValue: async (key) => {
          if (state.getValueThrows) throw new Error('settings unavailable');
          if (key === 'SYSTEM_AUTOSAVE_ENABLED') return state.enabled;
          if (key === 'SYSTEM_AUTOSAVE_INTERVAL_MINUTES') return state.intervalMinutes;
          return null;
        },
      },
    },
  },
  {
    match: matchesModule('/Modules/BackupManager'),
    value: {
      Manager: {
        GetCurrentFilePath: () => state.currentFilePath,
        Save: async (path) => {
          calls.save.push(path);
          return state.saveResult;
        },
      },
    },
  },
]);
test.after(() => restore());

/** Re-require autosave.ts so its module-level timer handle starts null. */
function freshAutosave(overrides = {}) {
  resetState(overrides);
  const Resolved = require.resolve('../dist/main/autosave');
  delete require.cache[Resolved];
  return require(Resolved);
}

/** Let the async tick body settle after the timer fires. */
async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
}

const MINUTE = 60 * 1000;

test.beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval'] });
});
test.afterEach(() => {
  mock.timers.reset();
});

// --- Scheduling -------------------------------------------------------------

test('scheduleAutosave installs no timer when autosave is disabled', async () => {
  const A = freshAutosave({ enabled: false });
  await A.scheduleAutosave();
  mock.timers.tick(60 * MINUTE);
  await flush();
  assert.deepEqual(calls.save, []);
});

test('scheduleAutosave ticks at the configured interval', async () => {
  const A = freshAutosave({ intervalMinutes: 5 });
  await A.scheduleAutosave();

  mock.timers.tick(5 * MINUTE - 1);
  await flush();
  assert.deepEqual(calls.save, [], 'fired early');

  mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls.save, ['/shows/current.showtrak']);

  mock.timers.tick(5 * MINUTE);
  await flush();
  assert.equal(calls.save.length, 2, 'the interval should repeat, not fire once');
});

test('scheduleAutosave clamps a nonsensical interval to one minute', async () => {
  for (const Interval of [0, -5, 0.5, 'not a number', null, undefined, NaN]) {
    const A = freshAutosave({ intervalMinutes: Interval });
    await A.scheduleAutosave();
    mock.timers.tick(MINUTE);
    await flush();
    assert.equal(calls.save.length, 1, `interval ${String(Interval)} did not clamp to 1 minute`);
    A.stopAutosave();
    mock.timers.reset();
    mock.timers.enable({ apis: ['setInterval'] });
  }
});

test('scheduleAutosave coerces a numeric string interval', async () => {
  const A = freshAutosave({ intervalMinutes: '3' });
  await A.scheduleAutosave();
  mock.timers.tick(3 * MINUTE);
  await flush();
  assert.equal(calls.save.length, 1);
});

test('rescheduling replaces the previous timer instead of stacking another', async () => {
  // main.ts calls this on every AutosaveSettingsChanged broadcast; a leaked
  // timer would multiply saves on each settings edit.
  const A = freshAutosave({ intervalMinutes: 2 });
  await A.scheduleAutosave();
  await A.scheduleAutosave();
  await A.scheduleAutosave();

  mock.timers.tick(2 * MINUTE);
  await flush();
  assert.equal(calls.save.length, 1);
});

test('rescheduling to disabled cancels the running timer', async () => {
  const A = freshAutosave({ intervalMinutes: 2 });
  await A.scheduleAutosave();
  state.enabled = false;
  await A.scheduleAutosave();

  mock.timers.tick(10 * MINUTE);
  await flush();
  assert.deepEqual(calls.save, []);
});

// --- Tick behaviour ---------------------------------------------------------

test('a tick is a no-op once autosave has been turned off in settings', async () => {
  // The timer is only rescheduled on a settings broadcast, so the tick itself
  // re-reads the flag rather than trusting that it was cancelled in time.
  const A = freshAutosave({ intervalMinutes: 1 });
  await A.scheduleAutosave();
  state.enabled = false;

  mock.timers.tick(MINUTE);
  await flush();
  assert.deepEqual(calls.save, []);
});

test('a tick is a no-op when no show file is open', async () => {
  const A = freshAutosave({ intervalMinutes: 1, currentFilePath: null });
  await A.scheduleAutosave();
  mock.timers.tick(MINUTE);
  await flush();
  assert.deepEqual(calls.save, []);
});

test('a tick follows the current file path when the show is saved elsewhere', async () => {
  const A = freshAutosave({ intervalMinutes: 1 });
  await A.scheduleAutosave();

  mock.timers.tick(MINUTE);
  await flush();
  state.currentFilePath = '/shows/renamed.showtrak';
  mock.timers.tick(MINUTE);
  await flush();

  assert.deepEqual(calls.save, ['/shows/current.showtrak', '/shows/renamed.showtrak']);
});

test('a failed save is logged and the schedule keeps running', async () => {
  // A transient failure (locked file, network drive blip) must not silently
  // stop autosaving for the rest of the session.
  const A = freshAutosave({ intervalMinutes: 1, saveResult: ['disk full', null] });
  await A.scheduleAutosave();

  mock.timers.tick(MINUTE);
  await flush();
  assert.equal(calls.errors.length, 1);
  assert.match(String(calls.errors[0][0]), /Autosave failed/);

  state.saveResult = [null, true];
  mock.timers.tick(MINUTE);
  await flush();
  assert.equal(calls.save.length, 2);
});

test('a throwing settings read during a tick is caught, not left unhandled', async () => {
  const A = freshAutosave({ intervalMinutes: 1 });
  await A.scheduleAutosave();
  state.getValueThrows = true;

  mock.timers.tick(MINUTE);
  await flush();
  assert.equal(calls.errors.length, 1);
  assert.match(String(calls.errors[0][0]), /Autosave tick error/);

  // And it recovers once settings are readable again.
  state.getValueThrows = false;
  mock.timers.tick(MINUTE);
  await flush();
  assert.equal(calls.save.length, 1);
});

// --- stopAutosave -----------------------------------------------------------

test('stopAutosave halts further ticks', async () => {
  const A = freshAutosave({ intervalMinutes: 1 });
  await A.scheduleAutosave();
  mock.timers.tick(MINUTE);
  await flush();
  assert.equal(calls.save.length, 1);

  A.stopAutosave();
  mock.timers.tick(10 * MINUTE);
  await flush();
  assert.equal(calls.save.length, 1);
});

test('stopAutosave is safe to call when nothing is scheduled', () => {
  const A = freshAutosave();
  assert.doesNotThrow(() => A.stopAutosave());
  assert.doesNotThrow(() => A.stopAutosave());
});

test('autosave can be rescheduled after being stopped', async () => {
  const A = freshAutosave({ intervalMinutes: 1 });
  await A.scheduleAutosave();
  A.stopAutosave();
  await A.scheduleAutosave();

  mock.timers.tick(MINUTE);
  await flush();
  assert.equal(calls.save.length, 1);
});
