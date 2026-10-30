const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/live-settings.ts: the settings that used to need a restart
// and are now applied live.
//
// Two properties matter most:
//
//   1. THE BOOT-VS-CHANGE ASYMMETRY on log level. At boot an explicitly-set
//      value is honoured but a still-default one is NOT, so a developer's
//      env-based LOG_LEVEL/NODE_ENV default survives a fresh install. Every
//      later change is applied unconditionally. Collapsing the two would make
//      the app silently stomp on the env default at boot.
//   2. THE powerSaveBlocker LIFECYCLE. The blocker id must be tracked and
//      released when the setting is turned off; leaking it keeps a show
//      machine's display awake forever, and double-starting leaks a handle per
//      toggle.
//
// BroadcastManager is a real EventEmitter so the change subscriptions are tested
// by emitting, not by inspecting a stub.

const bus = new EventEmitter();
const logs = { errors: [] };
const blocker = { started: [], stopped: [], nextId: 1, active: new Set() };

const state = {
  logLevelSetting: { Value: 'debug', isDefault: false },
  oscEnabled: true,
  oscPort: 9000,
  monitoringIntervalMs: 5000,
  monitoringFailureThreshold: 1,
  alertAudioDedupeMs: 500,
  confirmShutdown: true,
  autoUpdate: false,
  getValueThrows: false,
};

const osc = recordingManager({ StopServer: () => undefined, RestartServer: () => undefined });
const settingsMgr = recordingManager({
  Get: () => state.logLevelSetting,
  GetValue: (key) => {
    if (state.getValueThrows) throw new Error('settings unavailable');
    if (key === 'SYSTEM_OSC_ENABLED') return state.oscEnabled;
    if (key === 'SYSTEM_OSC_PORT') return state.oscPort;
    if (key === 'MONITORING_DEFAULT_INTERVAL_MS') return state.monitoringIntervalMs;
    if (key === 'MONITORING_FAILURE_THRESHOLD') return state.monitoringFailureThreshold;
    if (key === 'ALERT_SOUND_DEDUPE_WINDOW_MS') return state.alertAudioDedupeMs;
    if (key === 'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4') return state.confirmShutdown;
    if (key === 'SYSTEM_AUTO_UPDATE_ENABLED') return state.autoUpdate;
    return null;
  },
});

const configured = [];
const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: (...args) => logs.errors.push(args),
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
  configure: (options) => configured.push(options),
};

const intervals = { monitoring: [], dummy: [] };
const failureThresholds = [];
const audioDedupeWindows = [];
const shutdownProtection = [];
const automaticUpdates = [];

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: {} },
  {
    match: matchesModule('electron'),
    value: {
      powerSaveBlocker: {
        start: (type) => {
          const Id = blocker.nextId++;
          blocker.started.push({ type, id: Id });
          blocker.active.add(Id);
          return Id;
        },
        stop: (id) => {
          blocker.stopped.push(id);
          blocker.active.delete(id);
        },
        isStarted: (id) => blocker.active.has(id),
      },
    },
  },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: bus } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settingsMgr } },
  {
    match: matchesModule('/Modules/MonitoringTargetManager/normalize'),
    value: {
      SetDefaultInterval: (v) => intervals.monitoring.push(v),
      SetDefaultFailureThreshold: (v) => failureThresholds.push(v),
    },
  },
  {
    match: matchesModule('/Modules/DummyClientManager/normalize'),
    value: { SetDefaultInterval: (v) => intervals.dummy.push(v) },
  },
  {
    match: matchesModule('/Modules/AlertActions/_audio-dedupe'),
    value: { SetAudioDedupeWindow: (v) => audioDedupeWindows.push(v) },
  },
  { match: matchesModule('/Modules/OSC'), value: { OSC: osc } },
  {
    match: matchesModule('./shutdown-coordinator'),
    value: { setAccidentalShutdownProtection: (v) => shutdownProtection.push(v) },
  },
  {
    match: matchesModule('./app-updater'),
    value: { Manager: { SetAutomaticUpdates: (v) => automaticUpdates.push(v) } },
  },
]);
test.after(() => restore());

const { initLiveSettings } = require('../dist/main/live-settings');

/** Let a RunGuarded floating promise settle. */
async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function emit(event) {
  bus.emit(event);
  await flush();
}

function resetRecorders() {
  logs.errors.length = 0;
  configured.length = 0;
  intervals.monitoring.length = 0;
  intervals.dummy.length = 0;
  failureThresholds.length = 0;
  audioDedupeWindows.length = 0;
  shutdownProtection.length = 0;
  automaticUpdates.length = 0;
  blocker.started.length = 0;
  blocker.stopped.length = 0;
  osc.__calls.length = 0;
  settingsMgr.__calls.length = 0;
  state.getValueThrows = false;
}

// initLiveSettings SUBSCRIBES as well as applying, so calling it once per test
// on a shared bus would stack duplicate listeners and every later emit would
// apply N times. Clear the bus first so each test gets exactly one subscriber
// per event.
test.beforeEach(() => {
  bus.removeAllListeners();
  resetRecorders();
});

/** Boot the module, then clear the recorders so only post-boot calls are seen. */
async function bootThenReset() {
  await initLiveSettings();
  resetRecorders();
}

// --- Boot ------------------------------------------------------------------

test('boot applies monitoring defaults, display sleep and OSC', async () => {
  state.monitoringIntervalMs = 7500;
  state.monitoringFailureThreshold = 3;
  state.oscEnabled = true;
  state.oscPort = 9001;

  await initLiveSettings();

  // The same default interval drives both monitoring targets and dummy clients.
  assert.deepEqual(intervals.monitoring, [7500]);
  assert.deepEqual(intervals.dummy, [7500]);
  assert.deepEqual(failureThresholds, [3]);
  assert.deepEqual(osc.__callsTo('RestartServer')[0].args, [9001]);
});

test('boot honours an explicitly-set log level', async () => {
  state.logLevelSetting = { Value: 'trace', isDefault: false };
  await initLiveSettings();
  assert.deepEqual(configured, [{ level: 'trace' }]);
});

test('boot leaves a still-default log level alone so the env default wins', async () => {
  // On a fresh install the stored value is the built-in default; overriding the
  // logger with it would stomp a developer's LOG_LEVEL/NODE_ENV setting.
  state.logLevelSetting = { Value: 'info', isDefault: true };
  await initLiveSettings();
  assert.deepEqual(configured, []);
});

test('boot tolerates a missing log-level setting', async () => {
  state.logLevelSetting = null;
  await initLiveSettings();
  assert.deepEqual(configured, []);
  state.logLevelSetting = { Value: 'debug', isDefault: false };
});

// --- Change events ----------------------------------------------------------

test('a log-level change is applied even when the value is still the default', async () => {
  // The boot suppression is deliberate and must NOT extend to explicit changes.
  state.logLevelSetting = { Value: 'warn', isDefault: true };
  await bootThenReset();
  await emit('LoggingSettingsChanged');
  assert.deepEqual(configured, [{ level: 'warn' }]);
});

test('a monitoring-settings change re-applies the interval to both managers', async () => {
  await bootThenReset();
  state.monitoringIntervalMs = 12000;
  state.monitoringFailureThreshold = 5;
  await emit('MonitoringSettingsChanged');
  assert.deepEqual(intervals.monitoring, [12000]);
  assert.deepEqual(intervals.dummy, [12000]);
  // The failure threshold rides the same event; it is a monitoring setting.
  assert.deepEqual(failureThresholds, [5]);
});

test('the alert sound de-duplication window is applied at boot and on change', async () => {
  state.alertAudioDedupeMs = 750;
  await initLiveSettings();
  assert.deepEqual(audioDedupeWindows, [750]);

  // Turning it off must reach the actions live: an operator silencing a smear
  // mid-show cannot be asked to restart the server.
  audioDedupeWindows.length = 0;
  state.alertAudioDedupeMs = 0;
  await emit('AlertAudioSettingsChanged');
  assert.deepEqual(audioDedupeWindows, [0]);
  state.alertAudioDedupeMs = 500;
});

test('an OSC settings change rebinds the listener on the new port', async () => {
  await bootThenReset();
  state.oscEnabled = true;
  state.oscPort = 9100;
  await emit('OscSettingsChanged');
  assert.deepEqual(osc.__callsTo('RestartServer')[0].args, [9100]);
  assert.equal(osc.__callsTo('StopServer').length, 0);
});

test('disabling OSC stops the listener instead of rebinding it', async () => {
  await bootThenReset();
  state.oscEnabled = false;
  await emit('OscSettingsChanged');
  assert.equal(osc.__callsTo('StopServer').length, 1);
  assert.equal(osc.__callsTo('RestartServer').length, 0);
  // The port is not even read when disabled.
  assert.equal(
    settingsMgr.__callsTo('GetValue').filter((C) => C.args[0] === 'SYSTEM_OSC_PORT').length,
    0
  );
});

test('a shutdown-protection change is forwarded as a real boolean', async () => {
  await bootThenReset();
  state.confirmShutdown = 1;
  await emit('ShutdownProtectionChanged');
  assert.deepEqual(shutdownProtection, [true]);

  shutdownProtection.length = 0;
  state.confirmShutdown = 0;
  await emit('ShutdownProtectionChanged');
  assert.deepEqual(shutdownProtection, [false]);
  state.confirmShutdown = true;
});

test('automatic updates stay off at boot by default and follow later changes', async () => {
  state.autoUpdate = false;
  await initLiveSettings();
  assert.deepEqual(automaticUpdates, [false]);

  automaticUpdates.length = 0;
  state.autoUpdate = 1;
  await emit('AutoUpdateSettingsChanged');
  assert.deepEqual(automaticUpdates, [true], 'forwarded as a real boolean');

  automaticUpdates.length = 0;
  state.autoUpdate = false;
  await emit('AutoUpdateSettingsChanged');
  assert.deepEqual(automaticUpdates, [false]);
});

// --- powerSaveBlocker lifecycle --------------------------------------------

test('the server and display are always kept awake with a single blocker', async () => {
  // App Nap (macOS) and system sleep would slow or stop the main-process timers
  // that run monitoring and offline detection, and a show machine's screen is
  // meant to stay on. Not a preference.
  blocker.started.length = 0;
  blocker.stopped.length = 0;
  blocker.active.clear();
  await initLiveSettings();
  assert.deepEqual(
    blocker.started.map((B) => B.type),
    ['prevent-display-sleep']
  );

  // A second init (not expected, but must not leak a handle) reuses it.
  await initLiveSettings();
  assert.equal(blocker.started.length, 1);
  assert.deepEqual(blocker.stopped, []);
});

test('a blocker that died underneath us is restarted rather than assumed live', async () => {
  blocker.started.length = 0;
  blocker.active.clear();
  await initLiveSettings();
  blocker.active.delete(blocker.started[0].id);
  await initLiveSettings();
  assert.equal(blocker.started.length, 2, 'isStarted is re-checked, not cached');
});

// --- Error containment ------------------------------------------------------

test('a failing apply is logged and never becomes an unhandled rejection', async () => {
  // RunGuarded wraps each subscriber; without it a settings read failure during
  // a live show would surface as an unhandled rejection.
  await bootThenReset();
  state.getValueThrows = true;

  await emit('MonitoringSettingsChanged');
  await emit('OscSettingsChanged');
  await emit('ShutdownProtectionChanged');

  assert.equal(logs.errors.length, 3);
  for (const Entry of logs.errors) {
    assert.match(String(Entry[0]), /^Failed to apply /);
  }
});

test('one failing subscriber does not stop the others from applying later', async () => {
  await bootThenReset();
  state.getValueThrows = true;
  await emit('MonitoringSettingsChanged');
  assert.equal(logs.errors.length, 1);

  state.getValueThrows = false;
  state.monitoringIntervalMs = 3000;
  await emit('MonitoringSettingsChanged');
  assert.deepEqual(intervals.monitoring, [3000]);
});
