const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/broadcast-bridge.ts — the fan-out from the back-end
// managers' domain events to every renderer surface (desktop window + authed
// Web UI sockets).
//
// Four properties carry the weight here:
//
//   1. THE hasMainWindow() GUARD. Pushing to a torn-down window throws, so
//      almost every handler bails early without one.
//   2. THE DELIBERATE EXCEPTIONS TO IT. ClientUpdated and DummyClientUpdated
//      still record history and fire alerts with no window — a headless server
//      must keep alerting. Only the *push* is guarded. Losing that distinction
//      silently stops alerts whenever the window is closed.
//   3. THE PASSTHROUGH ALLOWLIST. A hand-maintained [event, channel] table; the
//      classic thing to rot when a new event is added and never wired.
//   4. THE SERIALIZATION PROJECTION on script executions. Raw entries carry a
//      Client class instance and a Node timer handle that Electron IPC cannot
//      structured-clone — pushing them raw is the "Failed to serialize
//      arguments" crash.
//
// BroadcastManager is a REAL EventEmitter so RegisterBroadcastBridge's wiring is
// tested by emitting events, not by inspecting a stub.

const pushes = [];
const logs = { errors: [] };
const deployments = { trigger: [], scheduled: 0, reconciled: [] };
const history = [];

const state = {
  hasWindow: true,
  cooldownMs: 60_000,
  settings: [{ Key: 'A' }],
  settingGroups: [{ Group: 'G' }],
  clients: [null, [{ UUID: 'client-1' }]],
  groups: [null, [{ GroupID: 1 }]],
  targets: [null, [{ TargetID: 1 }]],
  dummies: [null, [{ UUID: 'dummy-1' }]],
  rules: [null, [{ AlertRuleID: 1 }]],
  tags: [{ TagID: 1 }],
  scripts: [{ ID: 'a' }],
  decorated: [{ ID: 'a', Whitelist: null }],
  fingerprint: 'fp-1',
  routes: [{ Path: '/a' }],
  isSerialCritical: [null, false],
  isNameCritical: [null, false],
  isApplicationCritical: [null, false],
  alertsReject: false,
  deployRejects: false,
  orphanResult: [null],
};

const bus = new EventEmitter();
const modeBus = new EventEmitter();

function alertHandler(name) {
  return () => {
    if (state.alertsReject) return Promise.reject(new Error(`${name} failed`));
    return Promise.resolve();
  };
}

const alertsMgr = recordingManager({
  HandleUSBDeviceConnected: alertHandler('HandleUSBDeviceConnected'),
  HandleUSBDeviceDisconnected: alertHandler('HandleUSBDeviceDisconnected'),
  HandleCriticalUSBDeviceConnected: alertHandler('HandleCriticalUSBDeviceConnected'),
  HandleCriticalUSBDeviceDisconnected: alertHandler('HandleCriticalUSBDeviceDisconnected'),
  HandleNonCriticalUSBDeviceConnected: alertHandler('HandleNonCriticalUSBDeviceConnected'),
  HandleNonCriticalUSBDeviceDisconnected: alertHandler('HandleNonCriticalUSBDeviceDisconnected'),
  HandleApplicationStarted: alertHandler('HandleApplicationStarted'),
  HandleApplicationStopped: alertHandler('HandleApplicationStopped'),
  HandleCriticalApplicationStarted: alertHandler('HandleCriticalApplicationStarted'),
  HandleCriticalApplicationStopped: alertHandler('HandleCriticalApplicationStopped'),
  HandleNonCriticalApplicationStarted: alertHandler('HandleNonCriticalApplicationStarted'),
  HandleNonCriticalApplicationStopped: alertHandler('HandleNonCriticalApplicationStopped'),
  HandleClientUpdated: alertHandler('HandleClientUpdated'),
  HandleMonitoringTargetUpdated: alertHandler('HandleMonitoringTargetUpdated'),
  HandleScriptExecutionUpdated: alertHandler('HandleScriptExecutionUpdated'),
  GetAll: () => state.rules,
});

const clientMgr = recordingManager({
  GetAll: () => state.clients,
  ClearCache: async () => undefined,
  IsUSBDeviceCritical: () => state.isSerialCritical,
  IsUSBNameCritical: () => state.isNameCritical,
  IsApplicationCritical: () => state.isApplicationCritical,
});
const settingsMgr = recordingManager({
  GetAll: () => state.settings,
  GetGroups: () => state.settingGroups,
});
const groupMgr = recordingManager({
  GetAll: () => state.groups,
  ReconcileOrphanedGroups: () => state.orphanResult,
});
const targetMgr = recordingManager({ GetAll: () => state.targets });
const dummyMgr = recordingManager({ GetAll: () => state.dummies });
const tagMgr = recordingManager({ GetAllViews: () => state.tags });
const fogMgr = recordingManager({
  GetTasks: () => [null, [{ FogTaskRecordID: 1 }]],
  GetStatus: () => ({ Healthy: true }),
  SettingsChanged: async () => undefined,
});
const audioMgr = recordingManager({ GetAll: () => [null, []] });
const scriptMgr = recordingManager({
  GetScripts: () => state.scripts,
  GetDeploymentFingerprint: () => state.fingerprint,
});
const whitelistMgr = recordingManager({ DecorateCatalog: () => state.decorated });
const adoptionMgr = recordingManager({
  GetClientsPendingAdoption: () => [{ UUID: 'pending-1' }],
  ClearAllDevicesPendingAdoption: async () => undefined,
});
const serverMgr = recordingManager({ SendMessageByGroup: async () => undefined });

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
};

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  {
    match: matchesModule('/Modules/Config/constants'),
    get value() {
      return { ONLINE_DEPLOY_COOLDOWN_MS: state.cooldownMs };
    },
  },
  {
    match: matchesModule('./renderer-bus'),
    value: { PushToRenderers: (...args) => pushes.push(args) },
  },
  { match: matchesModule('./app-window'), value: { hasMainWindow: () => state.hasWindow } },
  {
    match: matchesModule('./deployment'),
    value: {
      TriggerScriptDeployment: async (...args) => {
        deployments.trigger.push(args);
        if (state.deployRejects) throw new Error('deployment failed');
      },
      ScheduleScriptChangeDeployment: () => {
        deployments.scheduled += 1;
      },
      ReconcileDeploymentQueueAfterExecutions: (e) => deployments.reconciled.push(e),
    },
  },
  {
    match: matchesModule('./monitoring-history'),
    value: {
      recordMonitoringHistorySample: (v) => history.push(['monitoring', v]),
      syncMonitoringHistoryStore: (v) => history.push(['sync-monitoring', v]),
      recordDummyHistorySample: (v) => history.push(['dummy', v]),
      syncDummyHistoryStore: (v) => history.push(['sync-dummy', v]),
      recordClientHistorySample: (v) => history.push(['client', v]),
      syncClientHistoryStore: (v) => history.push(['sync-client', v]),
    },
  },
  {
    match: matchesModule('/Modules/ScriptExecutionManager'),
    value: {
      // Marker projection: asserting on it proves the raw entries (which carry
      // unserializable handles) never reach the renderer.
      ToPublicScriptExecution: (e) => ({ Projected: true, Name: e && e.Script && e.Script.Name }),
    },
  },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settingsMgr } },
  { match: matchesModule('/Modules/ClientManager'), value: { Manager: clientMgr } },
  { match: matchesModule('/Modules/GroupManager'), value: { Manager: groupMgr } },
  { match: matchesModule('/Modules/MonitoringTargetManager'), value: { Manager: targetMgr } },
  { match: matchesModule('/Modules/DummyClientManager'), value: { Manager: dummyMgr } },
  { match: matchesModule('/Modules/AlertsManager'), value: { Manager: alertsMgr } },
  { match: matchesModule('/Modules/TagManager'), value: { Manager: tagMgr } },
  { match: matchesModule('/Modules/FogManager'), value: { Manager: fogMgr } },
  { match: matchesModule('/Modules/AudioAssetManager'), value: { Manager: audioMgr } },
  { match: matchesModule('/Modules/ScriptManager'), value: { Manager: scriptMgr } },
  { match: matchesModule('/Modules/ScriptWhitelistManager'), value: { Manager: whitelistMgr } },
  { match: matchesModule('/Modules/AdoptionManager'), value: { Manager: adoptionMgr } },
  { match: matchesModule('/Modules/Server'), value: { Manager: serverMgr } },
  { match: matchesModule('/Modules/ModeManager'), value: { Manager: modeBus } },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: bus } },
  { match: matchesModule('/Modules/OSC'), value: { OSC: { GetRoutes: () => state.routes } } },
]);
test.after(() => restore());

// normalizeUSBNameKey is pure and lives beside ClientManager; keep the real one.
const { normalizeUSBNameKey } = require('../dist/Modules/ClientManager/normalizers');

const Bridge = require('../dist/main/broadcast-bridge');

// Wiring is NOT a module-load side effect — the composition root calls this once
// after the managers are initialized. Do the same here, exactly once, so the
// emit-driven tests below reach the real handlers.
Bridge.RegisterBroadcastBridge();

/** Let a handler's floating promise chain settle. */
async function flush(ticks = 6) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Emit a broadcast event and wait for its async handler to finish. */
async function emit(event, ...args) {
  bus.emit(event, ...args);
  await flush();
}

function reset() {
  state.hasWindow = true;
  state.cooldownMs = 60_000;
  state.clients = [null, [{ UUID: 'client-1' }]];
  state.groups = [null, [{ GroupID: 1 }]];
  state.targets = [null, [{ TargetID: 1 }]];
  state.dummies = [null, [{ UUID: 'dummy-1' }]];
  state.rules = [null, [{ AlertRuleID: 1 }]];
  state.scripts = [{ ID: 'a' }];
  state.decorated = [{ ID: 'a', Whitelist: null }];
  state.fingerprint = 'fp-1';
  state.isSerialCritical = [null, false];
  state.isNameCritical = [null, false];
  state.isApplicationCritical = [null, false];
  state.alertsReject = false;
  state.deployRejects = false;
  state.orphanResult = [null];
  pushes.length = 0;
  logs.errors.length = 0;
  deployments.trigger.length = 0;
  deployments.scheduled = 0;
  deployments.reconciled.length = 0;
  history.length = 0;
  for (const M of [
    alertsMgr,
    clientMgr,
    settingsMgr,
    groupMgr,
    targetMgr,
    dummyMgr,
    tagMgr,
    fogMgr,
    scriptMgr,
    whitelistMgr,
    adoptionMgr,
    serverMgr,
  ]) {
    M.__calls.length = 0;
  }
}
test.beforeEach(reset);

/** Channels pushed during the current test. */
const channels = () => pushes.map((P) => P[0]);

// --- The list-refresh exports ----------------------------------------------

test('every exported list refresh pushes its authoritative channel', async () => {
  await Bridge.UpdateSettings();
  await Bridge.UpdateFullClientList();
  await Bridge.UpdateScriptList();
  await Bridge.UpdateOSCList();
  await Bridge.UpdateMonitoringTargetList();
  await Bridge.UpdateDummyClientList();
  await Bridge.UpdateAdoptionList();
  await Bridge.UpdateAlertRuleList();

  assert.deepEqual(channels(), [
    'UpdateSettings',
    'SetFullClientList',
    'SetScriptList',
    'SetOSCList',
    'SetFullMonitoringTargetList',
    'SetFullDummyClientList',
    'SetDevicesPendingAdoption',
    'SetFullAlertRuleList',
  ]);
});

test('every list refresh is a no-op without a main window', async () => {
  // This is the guard that stops a push into a destroyed WebContents.
  state.hasWindow = false;
  await Bridge.UpdateSettings();
  await Bridge.UpdateFullClientList();
  await Bridge.UpdateScriptList();
  await Bridge.UpdateOSCList();
  await Bridge.UpdateMonitoringTargetList();
  await Bridge.UpdateDummyClientList();
  await Bridge.UpdateAdoptionList();
  await Bridge.UpdateAlertRuleList();
  await Bridge.UpdateFogTaskList();
  await Bridge.UpdateFogStatus();

  assert.deepEqual(pushes, []);
  // And no manager was queried either — the guard is the first statement.
  assert.equal(clientMgr.__callsTo('GetAll').length, 0);
});

test('UpdateFullClientList pushes clients and groups together and syncs history', async () => {
  await Bridge.UpdateFullClientList();
  assert.deepEqual(pushes[0], ['SetFullClientList', [{ UUID: 'client-1' }], [{ GroupID: 1 }]]);
  assert.deepEqual(history, [['sync-client', [{ UUID: 'client-1' }]]]);
});

test('UpdateFullClientList logs and pushes nothing when a fetch fails', async () => {
  // A half-populated topology is worse than none: the UI would drop every group.
  state.clients = ['db exploded', null];
  await Bridge.UpdateFullClientList();
  assert.deepEqual(pushes, []);
  assert.equal(logs.errors.length, 1);

  reset();
  state.groups = ['db exploded', null];
  await Bridge.UpdateFullClientList();
  assert.deepEqual(pushes, []);
  assert.equal(logs.errors.length, 1);
});

test('UpdateScriptList decorates the catalog with per-show whitelist scopes', async () => {
  await Bridge.UpdateScriptList();
  assert.deepEqual(whitelistMgr.__callsTo('DecorateCatalog')[0].args, [[{ ID: 'a' }]]);
  assert.deepEqual(pushes[0], ['SetScriptList', [{ ID: 'a', Whitelist: null }]]);
});

test('UpdateOSCList deep-clones the routes so downstream cannot mutate them', async () => {
  await Bridge.UpdateOSCList();
  const Pushed = pushes[0][1];
  assert.deepEqual(Pushed, [{ Path: '/a' }]);
  assert.notEqual(Pushed, state.routes, 'the live route array was pushed by reference');
  assert.notEqual(Pushed[0], state.routes[0]);
});

test('the monitoring and dummy list refreshes normalize a null list to []', async () => {
  state.targets = [null, null];
  state.dummies = [null, null];
  await Bridge.UpdateMonitoringTargetList();
  await Bridge.UpdateDummyClientList();

  assert.deepEqual(pushes[0], ['SetFullMonitoringTargetList', []]);
  assert.deepEqual(pushes[1], ['SetFullDummyClientList', []]);
  assert.deepEqual(history, [
    ['sync-monitoring', []],
    ['sync-dummy', []],
  ]);
});

test('UpdateAlertRuleList logs and pushes nothing on a fetch failure', async () => {
  state.rules = ['db exploded', null];
  await Bridge.UpdateAlertRuleList();
  assert.deepEqual(pushes, []);
  assert.equal(logs.errors.length, 1);
});

// --- The deliberate exceptions to the window guard --------------------------

test('ClientUpdated still records history and alerts with no window', async () => {
  // A headless server (window closed to the tray) must keep alerting and keep
  // its history series continuous. Only the renderer push is guarded.
  state.hasWindow = false;
  await emit('ClientUpdated', { UUID: 'client-1', Online: true });

  assert.deepEqual(pushes, [], 'nothing should be pushed without a window');
  assert.deepEqual(history, [['client', { UUID: 'client-1', Online: true }]]);
  assert.equal(alertsMgr.__callsTo('HandleClientUpdated').length, 1);
  assert.equal(deployments.trigger.length, 1, 'auto-deploy must still fire headless');
});

test('DummyClientUpdated also records and alerts with no window', async () => {
  state.hasWindow = false;
  await emit('DummyClientUpdated', { UUID: 'dummy-1', Online: true });

  assert.deepEqual(pushes, []);
  assert.deepEqual(history, [['dummy', { UUID: 'dummy-1', Online: true }]]);
  // Dummies fire the same online/degraded triggers as real clients, via the
  // same handler.
  assert.equal(alertsMgr.__callsTo('HandleClientUpdated').length, 1);
});

test('ClientUpdated pushes and records when a window is present', async () => {
  await emit('ClientUpdated', { UUID: 'client-1', Online: false });
  assert.deepEqual(pushes, [['ClientUpdated', { UUID: 'client-1', Online: false }]]);
  assert.equal(history.length, 1);
});

// --- Online-transition auto-deployment --------------------------------------

test('auto-deployment fires once on an offline to online transition', async () => {
  await emit('ClientUpdated', { UUID: 'deploy-1', Online: true });
  assert.deepEqual(deployments.trigger, [[['deploy-1'], 'client-online']]);

  // Still online: no repeat.
  await emit('ClientUpdated', { UUID: 'deploy-1', Online: true });
  assert.equal(deployments.trigger.length, 1);
});

test('auto-deployment does not fire for a client that stays offline', async () => {
  await emit('ClientUpdated', { UUID: 'deploy-2', Online: false });
  await emit('ClientUpdated', { UUID: 'deploy-2', Online: false });
  assert.deepEqual(deployments.trigger, []);
});

test('auto-deployment is rate-limited across a flapping connection', async () => {
  // A client flapping on a bad switch port must not re-deploy on every bounce.
  await emit('ClientUpdated', { UUID: 'flap-1', Online: true });
  assert.equal(deployments.trigger.length, 1);

  await emit('ClientUpdated', { UUID: 'flap-1', Online: false });
  await emit('ClientUpdated', { UUID: 'flap-1', Online: true });
  assert.equal(deployments.trigger.length, 1, 'the cooldown should suppress the second deploy');
});

test('auto-deployment ignores a client with no UUID', async () => {
  await emit('ClientUpdated', { Online: true });
  assert.deepEqual(deployments.trigger, []);
});

test('a failing auto-deployment is caught and logged, not left unhandled', async () => {
  // The handler attaches a .catch to a floating promise; without it a failed
  // deployment becomes an unhandled rejection.
  state.deployRejects = true;
  await emit('ClientUpdated', { UUID: 'catch-1', Online: true });

  assert.equal(deployments.trigger.length, 1);
  assert.equal(logs.errors.length, 1);
  assert.match(String(logs.errors[0][0]), /Auto deployment on online transition failed/);
});

// --- USB criticality resolution ---------------------------------------------

test('a USB device with a guarded serial is treated as critical', async () => {
  state.isSerialCritical = [null, true];
  await emit('USBDeviceAdded', { UUID: 'client-1' }, { SerialNumber: 'SN123' });

  assert.equal(alertsMgr.__callsTo('HandleCriticalUSBDeviceConnected').length, 1);
  assert.equal(alertsMgr.__callsTo('HandleNonCriticalUSBDeviceConnected').length, 0);
  // A serial was present, so the name fallback must not be consulted.
  assert.equal(clientMgr.__callsTo('IsUSBNameCritical').length, 0);
});

test('a serial-less USB device falls back to the name+quantity guard', async () => {
  state.isSerialCritical = [null, false];
  state.isNameCritical = [null, true];
  await emit(
    'USBDeviceAdded',
    { UUID: 'client-1' },
    { ManufacturerName: 'Acme', ProductName: 'Dongle' }
  );

  assert.equal(clientMgr.__callsTo('IsUSBNameCritical').length, 1);
  assert.equal(
    clientMgr.__callsTo('IsUSBNameCritical')[0].args[1],
    normalizeUSBNameKey('Acme', 'Dongle')
  );
  assert.equal(alertsMgr.__callsTo('HandleCriticalUSBDeviceConnected').length, 1);
});

test('a device with a serial that is not guarded stays non-critical', async () => {
  state.isSerialCritical = [null, false];
  state.isNameCritical = [null, true]; // would match, but must not be consulted
  await emit('USBDeviceAdded', { UUID: 'client-1' }, { SerialNumber: 'SN123' });

  assert.equal(clientMgr.__callsTo('IsUSBNameCritical').length, 0);
  assert.equal(alertsMgr.__callsTo('HandleNonCriticalUSBDeviceConnected').length, 1);
});

test('a whitespace-only serial is treated as absent', async () => {
  state.isSerialCritical = [null, false];
  state.isNameCritical = [null, true];
  await emit('USBDeviceAdded', { UUID: 'client-1' }, { SerialNumber: '   ' });
  assert.equal(clientMgr.__callsTo('IsUSBNameCritical').length, 1);
});

test('a criticality lookup failure is logged and fires no criticality alert', async () => {
  state.isSerialCritical = ['db exploded', false];
  await emit('USBDeviceAdded', { UUID: 'client-1' }, { SerialNumber: 'SN123' });

  assert.equal(logs.errors.length, 1);
  assert.equal(alertsMgr.__callsTo('HandleCriticalUSBDeviceConnected').length, 0);
  assert.equal(alertsMgr.__callsTo('HandleNonCriticalUSBDeviceConnected').length, 0);
  // The plain connected alert still fires — only the criticality branch is lost.
  assert.equal(alertsMgr.__callsTo('HandleUSBDeviceConnected').length, 1);
});

test('USB removal mirrors the same criticality resolution', async () => {
  state.isSerialCritical = [null, true];
  await emit('USBDeviceRemoved', { UUID: 'client-1' }, { SerialNumber: 'SN123' });

  assert.equal(channels().includes('USBDeviceRemoved'), true);
  assert.equal(alertsMgr.__callsTo('HandleCriticalUSBDeviceDisconnected').length, 1);
});

test('USB events are skipped entirely without a window', async () => {
  state.hasWindow = false;
  await emit('USBDeviceAdded', { UUID: 'client-1' }, { SerialNumber: 'SN123' });
  await emit('USBDeviceRemoved', { UUID: 'client-1' }, { SerialNumber: 'SN123' });
  assert.deepEqual(pushes, []);
  assert.equal(alertsMgr.__calls.length, 0);
});

// --- Application start/stop -------------------------------------------------

test('a critical application start routes to the critical alert handler', async () => {
  state.isApplicationCritical = [null, true];
  await emit('ApplicationStarted', { UUID: 'client-1' }, { Name: 'qlab' });

  assert.equal(alertsMgr.__callsTo('HandleApplicationStarted').length, 1);
  assert.equal(alertsMgr.__callsTo('HandleCriticalApplicationStarted').length, 1);
  assert.equal(alertsMgr.__callsTo('HandleNonCriticalApplicationStarted').length, 0);
});

test('a non-critical application stop routes to the non-critical handler', async () => {
  state.isApplicationCritical = [null, false];
  await emit('ApplicationStopped', { UUID: 'client-1' }, { Name: 'notepad' });

  assert.equal(alertsMgr.__callsTo('HandleApplicationStopped').length, 1);
  assert.equal(alertsMgr.__callsTo('HandleNonCriticalApplicationStopped').length, 1);
});

test('an application criticality failure is logged without a criticality alert', async () => {
  state.isApplicationCritical = ['db exploded', false];
  await emit('ApplicationStarted', { UUID: 'client-1' }, { Name: 'qlab' });

  assert.equal(logs.errors.length, 1);
  assert.equal(alertsMgr.__callsTo('HandleCriticalApplicationStarted').length, 0);
  assert.equal(alertsMgr.__callsTo('HandleNonCriticalApplicationStarted').length, 0);
});

test('a rejected alert handler is caught and logged rather than crashing', async () => {
  // Every AlertsManager call is fire-and-forget with a .catch; without it these
  // become unhandled rejections.
  state.alertsReject = true;
  await emit('ApplicationStarted', { UUID: 'client-1' }, { Name: 'qlab' });
  assert.ok(logs.errors.length >= 1);
});

// --- Script executions: the serialization projection ------------------------

test('script executions are projected before being pushed to the renderer', async () => {
  // Raw entries carry a Client instance and a timer handle that Electron's IPC
  // cannot structured-clone; pushing them raw crashes the renderer bridge.
  const Raw = [{ Script: { Name: 'reboot' }, Timer: setTimeout(() => {}, 1000) }];
  clearTimeout(Raw[0].Timer);
  await emit('ScriptExecutionUpdated', Raw);

  assert.deepEqual(pushes[0], ['UpdateScriptExecutions', [{ Projected: true, Name: 'reboot' }]]);
});

test('script executions still reconcile the deployment queue with the RAW entries', async () => {
  // The in-process consumer needs fields the projection drops, so it must get
  // the originals, not the serialization-safe copy.
  const Raw = [{ Script: { Name: 'reboot' }, Status: 'Completed' }];
  await emit('ScriptExecutionUpdated', Raw);

  assert.equal(deployments.reconciled.length, 1);
  assert.equal(deployments.reconciled[0], Raw);
  assert.equal(alertsMgr.__callsTo('HandleScriptExecutionUpdated').length, 1);
});

// --- Script catalog fingerprinting ------------------------------------------

test('a script change schedules a deployment only when the fingerprint moves', async () => {
  state.fingerprint = 'fp-A';
  await emit('ScriptsUpdated');
  const First = deployments.scheduled;
  assert.equal(First, 1, 'the first fingerprint seen should schedule a deployment');

  // Same fingerprint: the catalog was re-pushed (e.g. a whitelist edit) but the
  // script CONTENT is unchanged, so redeploying to every client is wasted work.
  await emit('ScriptsUpdated');
  assert.equal(deployments.scheduled, First);
  assert.equal(channels().filter((C) => C === 'SetScriptList').length, 2);

  state.fingerprint = 'fp-B';
  await emit('ScriptsUpdated');
  assert.equal(deployments.scheduled, First + 1);
});

// --- ReinitializeSystem -----------------------------------------------------

test('ReinitializeSystem reloads caches then pushes the full topology', async () => {
  await emit('ReinitializeSystem');

  assert.equal(clientMgr.__callsTo('ClearCache').length, 1);
  assert.equal(adoptionMgr.__callsTo('ClearAllDevicesPendingAdoption').length, 1);
  // The sub-refreshes run before the topology push.
  assert.deepEqual(channels(), [
    'UpdateSettings',
    'SetFullMonitoringTargetList',
    'SetFullDummyClientList',
    'SetFullAlertRuleList',
    'SetFullClientList',
  ]);
});

test('a failed orphaned-group reconcile is logged but does not abort the rehydrate', async () => {
  // Reconciling orphaned group assignments is best-effort housekeeping; losing
  // it must not cost the operator the whole re-hydration.
  state.orphanResult = ['constraint violation'];
  await emit('ReinitializeSystem');

  assert.equal(logs.errors.length, 1);
  assert.equal(channels().includes('SetFullClientList'), true);
});

test('ReinitializeSystem aborts the topology push when a fetch fails', async () => {
  state.clients = ['db exploded', null];
  await emit('ReinitializeSystem');
  assert.equal(channels().includes('SetFullClientList'), false);
  assert.equal(logs.errors.length, 1);
});

test('ReinitializeSystem is skipped entirely without a window', async () => {
  state.hasWindow = false;
  await emit('ReinitializeSystem');
  assert.deepEqual(pushes, []);
  assert.equal(clientMgr.__callsTo('ClearCache').length, 0);
});

// --- RegisterBroadcastBridge: the wiring ------------------------------------

test('RegisterBroadcastBridge subscribes every domain event', () => {
  // Registration ran once at setup; assert each event has a listener so a
  // dropped BroadcastManager.on line is caught.
  for (const Event of [
    'SettingsUpdated',
    'USBDeviceAdded',
    'USBDeviceRemoved',
    'ApplicationStarted',
    'ApplicationStopped',
    'ReadoptDevice',
    'ReinitializeSystem',
    'ClientUpdated',
    'ScriptsUpdated',
    'GroupListChanged',
    'ClientListChanged',
    'MonitoringTargetListChanged',
    'MonitoringTargetUpdated',
    'DummyClientListChanged',
    'DummyClientUpdated',
    'AdoptionListUpdated',
    'ScriptExecutionUpdated',
    'AlertRuleListChanged',
    'TagListChanged',
    'FogTasksUpdated',
    'FogStatusChanged',
    'FogSettingsChanged',
    'Notify',
    'PlaySound',
    'OSCBulkAction',
  ]) {
    assert.ok(bus.listenerCount(Event) > 0, `no listener registered for ${Event}`);
  }
});

test('every PASSTHROUGH event forwards its payload verbatim on its own channel', async () => {
  // This table is hand-maintained and is exactly the kind of list that rots
  // when a new event is added upstream.
  for (const [Event, Channel] of [
    ['AlertTriggered', 'AlertTriggered'],
    ['CreateShowTrakAlert', 'CreateShowTrakAlert'],
    ['PlayCustomAudio', 'PlayCustomAudio'],
    ['DebugTrafficEntry', 'DebugTrafficEntry'],
    ['AlertActionsUpdated', 'AlertActionsUpdated'],
  ]) {
    pushes.length = 0;
    await emit(Event, { a: 1 }, 'second');
    assert.deepEqual(pushes, [[Channel, { a: 1 }, 'second']], `${Event} did not pass through`);
  }
});

test('PASSTHROUGH events are dropped without a window', async () => {
  state.hasWindow = false;
  await emit('AlertTriggered', { a: 1 });
  assert.deepEqual(pushes, []);
});

test('a FOG status change pushes both the status and the task list', async () => {
  // The panel renders both, so status alone would leave stale tasks on screen.
  await emit('FogStatusChanged');
  assert.deepEqual(channels().sort(), ['FogStatusUpdated', 'SetFogTaskList'].sort());
});

test('a FOG settings change re-probes immediately instead of waiting for the poll', async () => {
  await emit('FogSettingsChanged');
  assert.equal(fogMgr.__callsTo('SettingsChanged').length, 1);
});

test('ReadoptDevice asks the server to re-adopt, with or without a window', async () => {
  state.hasWindow = false;
  await emit('ReadoptDevice', 'client-1');
  assert.deepEqual(serverMgr.__callsTo('SendMessageByGroup')[0].args, ['client-1', 'Adopt']);
});

test('a mode change is relayed to the renderers', async () => {
  modeBus.emit('ModeUpdated', 'SHOW');
  await flush();
  assert.deepEqual(pushes, [['ModeUpdated', 'SHOW']]);

  pushes.length = 0;
  state.hasWindow = false;
  modeBus.emit('ModeUpdated', 'EDIT');
  await flush();
  assert.deepEqual(pushes, []);
});

test('Notify and PlaySound forward to the renderers with their defaults', async () => {
  await emit('Notify', 'Saved');
  assert.deepEqual(pushes[0], ['Notify', 'Saved', 'info', 5000]);

  pushes.length = 0;
  await emit('Notify', 'Broke', 'danger', 10000);
  assert.deepEqual(pushes[0], ['Notify', 'Broke', 'danger', 10000]);

  pushes.length = 0;
  await emit('PlaySound', 'alert');
  assert.deepEqual(pushes[0], ['PlaySound', 'alert']);
});
