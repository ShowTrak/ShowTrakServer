const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Exercises src/main/initial-state.ts: what a freshly (re)loaded renderer
// hydrates. (The process and window guards this file also covered are
// @showtrak/protocol's now, and covered by its specs.)

const state = { hasWindow: true, mode: 'SHOW' };

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

const bridgeCalls = [];
function bridgeStub(name) {
  return async () => bridgeCalls.push(name);
}

const pushes = [];

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: {} },
  { match: matchesModule('electron'), value: {} },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  { match: matchesModule('/Modules/ModeManager'), value: { Manager: { Get: () => state.mode } } },
  {
    match: matchesModule('./renderer-bus'),
    value: { PushToRenderers: (...args) => pushes.push(args) },
  },
  { match: matchesModule('./app-window'), value: { hasMainWindow: () => state.hasWindow } },
  {
    match: matchesModule('./broadcast-bridge'),
    value: {
      UpdateSettings: bridgeStub('UpdateSettings'),
      UpdateAdoptionList: bridgeStub('UpdateAdoptionList'),
      UpdateFullClientList: bridgeStub('UpdateFullClientList'),
      UpdateScriptList: bridgeStub('UpdateScriptList'),
      UpdateOSCList: bridgeStub('UpdateOSCList'),
      UpdateMonitoringTargetList: bridgeStub('UpdateMonitoringTargetList'),
      UpdateMonitoringActionFavouriteList: bridgeStub('UpdateMonitoringActionFavouriteList'),
      UpdateDummyClientList: bridgeStub('UpdateDummyClientList'),
      UpdateFreeKioskTerminalList: bridgeStub('UpdateFreeKioskTerminalList'),
      UpdateAlertRuleList: bridgeStub('UpdateAlertRuleList'),
      UpdateTagList: bridgeStub('UpdateTagList'),
      UpdateVariableList: bridgeStub('UpdateVariableList'),
      UpdateFogTaskList: bridgeStub('UpdateFogTaskList'),
      UpdateFogStatus: bridgeStub('UpdateFogStatus'),
    },
  },
]);
test.after(() => restore());

const { PushInitialDesktopState } = require('../dist/main/initial-state');

// --- initial-state ----------------------------------------------------------

test('a renderer reload re-hydrates every channel, then the current mode', async () => {
  // A hot reload wipes the renderer's caches; anything missing from this list
  // stays empty until the next incremental push happens to arrive.
  bridgeCalls.length = 0;
  pushes.length = 0;

  await PushInitialDesktopState();

  assert.deepEqual(bridgeCalls, [
    'UpdateSettings',
    'UpdateAdoptionList',
    'UpdateFullClientList',
    'UpdateScriptList',
    'UpdateOSCList',
    'UpdateMonitoringTargetList',
    // The right-click menu's starred check actions are built from this list, so
    // a reloaded renderer needs it before the operator right-clicks a monitor.
    'UpdateMonitoringActionFavouriteList',
    'UpdateDummyClientList',
    'UpdateFreeKioskTerminalList',
    'UpdateAlertRuleList',
    // Tile tag badges are derived from this list, so a reloaded renderer needs
    // it before its first paint or every tile renders untagged.
    'UpdateTagList',
    // The script editor's variable reference list and the client editor's
    // variable rows both read the renderer's cache, which only this push fills.
    'UpdateVariableList',
    'UpdateFogStatus',
    'UpdateFogTaskList',
  ]);
  assert.deepEqual(pushes, [['ModeUpdated', 'SHOW']]);
});

test('the mode push is skipped when the window went away mid-hydration', async () => {
  bridgeCalls.length = 0;
  pushes.length = 0;
  state.hasWindow = false;
  try {
    await PushInitialDesktopState();
  } finally {
    state.hasWindow = true;
  }
  // The Update* functions guard themselves; only the direct push is gated here.
  assert.equal(bridgeCalls.length, 14);
  assert.deepEqual(pushes, []);
});
