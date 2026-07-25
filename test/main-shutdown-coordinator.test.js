const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Covers src/main/shutdown-coordinator.ts — the "may we quit yet, and what must
// we save first" state machine.
//
// This is the highest consequence-per-line file in the main process: it owns the
// save-before-close prompt and the single clean SQLite close on exit. A bug here
// loses a show or corrupts the database, and neither failure announces itself.
//
// The module keeps its handshake state in module-level `let`s, so every test
// re-requires it from a cleared cache (see freshCoordinator) rather than sharing
// one instance.

// --- Controllable mock state ------------------------------------------------

let state;
let calls;

function resetState(overrides = {}) {
  state = {
    mode: 'EDIT',
    currentFilePath: '/shows/current.showtrak',
    hasUnsavedChanges: false,
    hasUnsavedChangesFn: true,
    autosaveEnabled: false,
    autosaveSettingThrows: false,
    saveResult: [null, true],
    messageBoxResponse: 0,
    saveDialog: { canceled: false, filePath: '/shows/chosen.showtrak' },
    hasWindow: true,
    monitoringShutdownFn: true,
    dummyShutdownFn: true,
    throwOn: {},
    ...overrides,
  };
  calls = {
    quit: 0,
    windowClose: 0,
    preventDefault: 0,
    save: [],
    showErrorBox: [],
    messageBox: [],
    saveDialog: 0,
    showFileUpdated: [],
    pushToRenderers: [],
    stopAutosave: 0,
    networkStop: 0,
    monitoringShutdown: 0,
    dummyShutdown: 0,
    dbShutdown: [],
  };
}
resetState();

/** Throw if this step is configured to fail, so cleanup resilience is testable. */
function maybeThrow(step) {
  if (state.throwOn[step]) throw new Error(`${step} exploded`);
}

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

const mainWindowStub = {
  close: () => {
    calls.windowClose++;
  },
};

const appStub = {
  quit: () => {
    calls.quit++;
  },
};

const dialogStub = {
  showMessageBox: async (parent, options) => {
    calls.messageBox.push({ parent, options });
    return { response: state.messageBoxResponse };
  },
  showErrorBox: (title, content) => {
    calls.showErrorBox.push({ title, content });
  },
};

const backupManager = {
  GetCurrentFilePath: () => state.currentFilePath,
  Save: async (path) => {
    calls.save.push(path);
    return state.saveResult;
  },
};
Object.defineProperty(backupManager, 'HasUnsavedChanges', {
  get: () => (state.hasUnsavedChangesFn ? async () => state.hasUnsavedChanges : undefined),
});

const monitoringTargetManager = {};
Object.defineProperty(monitoringTargetManager, 'Shutdown', {
  get: () =>
    state.monitoringShutdownFn
      ? async () => {
          calls.monitoringShutdown++;
          maybeThrow('monitoring');
        }
      : undefined,
});

const dummyClientManager = {};
Object.defineProperty(dummyClientManager, 'Shutdown', {
  get: () =>
    state.dummyShutdownFn
      ? async () => {
          calls.dummyShutdown++;
          maybeThrow('dummy');
        }
      : undefined,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { app: appStub } },
  { match: matchesModule('electron'), value: { app: appStub, dialog: dialogStub } },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  {
    match: matchesModule('/Modules/Config/constants'),
    value: { DB_PENDING_OPERATION_TIMEOUT_MS: 5000 },
  },
  {
    match: matchesModule('./autosave'),
    value: {
      stopAutosave: () => {
        calls.stopAutosave++;
        maybeThrow('stopAutosave');
      },
    },
  },
  {
    match: matchesModule('./app-window'),
    value: {
      getMainWindow: () => (state.hasWindow ? mainWindowStub : null),
      hasMainWindow: () => state.hasWindow,
      sendShowFileUpdated: (path) => calls.showFileUpdated.push(path),
    },
  },
  {
    match: matchesModule('./renderer-bus'),
    value: { PushToRenderers: (...args) => calls.pushToRenderers.push(args) },
  },
  { match: matchesModule('/Modules/ModeManager'), value: { Manager: { Get: () => state.mode } } },
  { match: matchesModule('/Modules/BackupManager'), value: { Manager: backupManager } },
  {
    match: matchesModule('/Modules/SettingsManager'),
    value: {
      Manager: {
        GetValue: async (key) => {
          if (key === 'SYSTEM_AUTOSAVE_ENABLED') {
            if (state.autosaveSettingThrows) throw new Error('settings unavailable');
            return state.autosaveEnabled;
          }
          return null;
        },
      },
    },
  },
  {
    match: matchesModule('/Modules/FileSelectorManager'),
    value: {
      Manager: {
        SaveDialog: async () => {
          calls.saveDialog++;
          return state.saveDialog;
        },
      },
    },
  },
  {
    match: matchesModule('/Modules/MonitoringTargetManager'),
    value: { Manager: monitoringTargetManager },
  },
  { match: matchesModule('/Modules/DummyClientManager'), value: { Manager: dummyClientManager } },
  {
    match: matchesModule('/Modules/NetworkInterfaces'),
    value: {
      Manager: {
        Stop: () => {
          calls.networkStop++;
          maybeThrow('networkStop');
        },
      },
    },
  },
  {
    match: matchesModule('/Modules/DB'),
    value: {
      Manager: {
        Shutdown: async (opts) => {
          calls.dbShutdown.push(opts);
          maybeThrow('dbShutdown');
        },
      },
    },
  },
]);
test.after(() => restore());

/** Re-require the coordinator so its module-level handshake flags start clean. */
function freshCoordinator(overrides = {}) {
  resetState(overrides);
  const Resolved = require.resolve('../dist/main/shutdown-coordinator');
  delete require.cache[Resolved];
  return require(Resolved);
}

/** A cancelable Electron event stub. */
function cancelableEvent() {
  return {
    preventDefault: () => {
      calls.preventDefault++;
    },
  };
}

/** Let the fire-and-forget cleanup promise chain settle. */
async function flush(ticks = 8) {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
}

// --- promptConfirmBeforeShutdown (via handleMainWindowClose) ----------------

test('window close does not confirm when accidental-shutdown protection is off', async () => {
  const C = freshCoordinator({ mode: 'SHOW' });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 0);
  assert.equal(calls.windowClose, 1);
});

test('window close does not confirm outside show mode', async () => {
  const C = freshCoordinator({ mode: 'EDIT' });
  C.setAccidentalShutdownProtection(true);
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 0);
  assert.equal(calls.windowClose, 1);
});

test('window close confirms in show mode and aborts when the user cancels', async () => {
  const C = freshCoordinator({ mode: 'SHOW', messageBoxResponse: 1 });
  C.setAccidentalShutdownProtection(true);
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());

  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.messageBox.length, 1);
  assert.match(calls.messageBox[0].options.message, /Close ShowTrak Server\?/);
  // Cancel is both the default and the cancel button, so an accidental Enter or
  // Escape keeps the show running.
  assert.equal(calls.messageBox[0].options.defaultId, 1);
  assert.equal(calls.messageBox[0].options.cancelId, 1);
  assert.equal(calls.windowClose, 0);
  assert.equal(calls.quit, 0);
});

test('window close proceeds when the show-mode confirmation is accepted', async () => {
  const C = freshCoordinator({ mode: 'SHOW', messageBoxResponse: 0 });
  C.setAccidentalShutdownProtection(true);
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.windowClose, 1);
});

test('a broadcast force-shutdown bypasses the show-mode confirmation', async () => {
  const C = freshCoordinator({ mode: 'SHOW' });
  C.setAccidentalShutdownProtection(true);
  C.handleBroadcastShutdownForce();
  assert.equal(calls.quit, 1);

  // Force also pre-approves the close, so a subsequent window close is a no-op
  // and no prompt appears.
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 0);
  assert.equal(calls.preventDefault, 0);
});

// --- promptSaveBeforeClose: autosave enabled -------------------------------

test('with autosave on and no file ever saved, close proceeds without saving', async () => {
  const C = freshCoordinator({ autosaveEnabled: true, currentFilePath: null });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.deepEqual(calls.save, []);
  assert.equal(calls.windowClose, 1);
});

test('with autosave on and no unsaved changes, close proceeds without saving', async () => {
  const C = freshCoordinator({ autosaveEnabled: true, hasUnsavedChanges: false });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.deepEqual(calls.save, []);
  assert.equal(calls.windowClose, 1);
});

test('with autosave on and unsaved changes, the show is saved once before closing', async () => {
  const C = freshCoordinator({ autosaveEnabled: true, hasUnsavedChanges: true });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  // Saved silently to the known path — no prompt.
  assert.deepEqual(calls.save, ['/shows/current.showtrak']);
  assert.equal(calls.messageBox.length, 0);
  assert.deepEqual(calls.showFileUpdated, ['/shows/current.showtrak']);
  assert.equal(calls.windowClose, 1);
});

test('a failed autosave during shutdown reports the error and keeps the app open', async () => {
  // The whole point of the prompt: never close over the top of unsaved work.
  const C = freshCoordinator({
    autosaveEnabled: true,
    hasUnsavedChanges: true,
    saveResult: ['disk full', null],
  });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());

  assert.equal(calls.showErrorBox.length, 1);
  assert.equal(calls.showErrorBox[0].title, 'Unable to Save Show');
  assert.match(calls.showErrorBox[0].content, /disk full/);
  assert.equal(calls.windowClose, 0);
  assert.equal(calls.quit, 0);
});

test('an unreadable autosave setting falls back to prompting rather than closing', async () => {
  // Failing closed: if we cannot tell whether autosave is on, ask the user.
  const C = freshCoordinator({
    autosaveSettingThrows: true,
    hasUnsavedChanges: true,
    messageBoxResponse: 2,
  });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 1);
  assert.equal(calls.windowClose, 0);
});

// --- promptSaveBeforeClose: autosave disabled ------------------------------

test('with a saved file and no changes, close proceeds without a prompt', async () => {
  const C = freshCoordinator({ hasUnsavedChanges: false });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 0);
  assert.equal(calls.windowClose, 1);
});

test('an unsaved-changes prompt offers Save / Do not Save / Cancel', async () => {
  const C = freshCoordinator({ hasUnsavedChanges: true, messageBoxResponse: 2 });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());

  const { options } = calls.messageBox[0];
  assert.deepEqual(options.buttons, ['Save', "Don't Save", 'Cancel']);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 2);
  // Cancel aborts the close entirely.
  assert.equal(calls.windowClose, 0);
  assert.deepEqual(calls.save, []);
});

test('choosing Do not Save closes without writing anything', async () => {
  const C = freshCoordinator({ hasUnsavedChanges: true, messageBoxResponse: 1 });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.deepEqual(calls.save, []);
  assert.equal(calls.windowClose, 1);
});

test('choosing Save writes to the existing path and closes', async () => {
  const C = freshCoordinator({ hasUnsavedChanges: true, messageBoxResponse: 0 });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.deepEqual(calls.save, ['/shows/current.showtrak']);
  assert.equal(calls.saveDialog, 0);
  assert.equal(calls.windowClose, 1);
});

test('a never-saved show prompts for a path before saving', async () => {
  const C = freshCoordinator({
    currentFilePath: null,
    hasUnsavedChanges: true,
    messageBoxResponse: 0,
  });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.saveDialog, 1);
  assert.deepEqual(calls.save, ['/shows/chosen.showtrak']);
  assert.equal(calls.windowClose, 1);
});

test('cancelling the Save As dialog aborts the close', async () => {
  const C = freshCoordinator({
    currentFilePath: null,
    hasUnsavedChanges: true,
    messageBoxResponse: 0,
    saveDialog: { canceled: true, filePath: null },
  });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.deepEqual(calls.save, []);
  assert.equal(calls.windowClose, 0);
});

test('a Save As dialog that returns no path never calls Save with null', async () => {
  // The null-path guard: Save(null) would write to an undefined location.
  const C = freshCoordinator({
    currentFilePath: null,
    hasUnsavedChanges: true,
    messageBoxResponse: 0,
    saveDialog: { canceled: false, filePath: '' },
  });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.deepEqual(calls.save, []);
  assert.equal(calls.windowClose, 0);
});

test('a failed explicit save reports the error and keeps the app open', async () => {
  const C = freshCoordinator({
    hasUnsavedChanges: true,
    messageBoxResponse: 0,
    saveResult: ['permission denied', null],
  });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.showErrorBox.length, 1);
  assert.equal(calls.windowClose, 0);
});

test('a BackupManager without HasUnsavedChanges is treated as clean', async () => {
  const C = freshCoordinator({ hasUnsavedChangesFn: false });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 0);
  assert.equal(calls.windowClose, 1);
});

// --- handleMainWindowClose: handshake --------------------------------------

test('window close prevents the default and closes only after approval', async () => {
  const C = freshCoordinator();
  const Event = cancelableEvent();
  await C.handleMainWindowClose(mainWindowStub, Event);
  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.windowClose, 1);

  // Second close is now pre-approved: it must NOT preventDefault again, or the
  // window could never actually close.
  await C.handleMainWindowClose(mainWindowStub, Event);
  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.windowClose, 1);
});

test('window close quits the app instead of closing when a quit is pending', async () => {
  const C = freshCoordinator();
  C.handleBeforeQuit(cancelableEvent()); // sets quitRequested, routes via close
  const QuitsBefore = calls.quit;

  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.quit, QuitsBefore + 1);
  assert.equal(calls.windowClose, 1, 'the window close came from before-quit, not from approval');
});

test('a cancelled close clears the pending quit so the app stays running', async () => {
  const C = freshCoordinator({ hasUnsavedChanges: true, messageBoxResponse: 2 });
  C.handleBeforeQuit(cancelableEvent());
  calls.quit = 0;

  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.quit, 0);

  // quitRequested was reset, so a later approved close closes the window rather
  // than quitting outright.
  state.hasUnsavedChanges = false;
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.quit, 0);
  assert.equal(calls.windowClose, 2);
});

test('concurrent close requests only prompt once', async () => {
  const C = freshCoordinator({ hasUnsavedChanges: true, messageBoxResponse: 1 });
  const First = C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  const Second = C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  await Promise.all([First, Second]);
  assert.equal(calls.messageBox.length, 1, 'a second dialog would stack on top of the first');
  assert.equal(calls.preventDefault, 2);
});

test('a dialog failure is contained and does not wedge the close handshake', async () => {
  // If the in-flight flag were not reset in a `finally`, one failed dialog would
  // make the window permanently unclosable for the rest of the session.
  const C = freshCoordinator({ mode: 'SHOW' });
  C.setAccidentalShutdownProtection(true);
  const OriginalShowMessageBox = dialogStub.showMessageBox;
  dialogStub.showMessageBox = async () => {
    throw new Error('no display available');
  };
  try {
    await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  } finally {
    dialogStub.showMessageBox = OriginalShowMessageBox;
  }
  assert.equal(calls.windowClose, 0);

  // The next attempt still prompts, proving the in-flight flag was cleared.
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 1);
  assert.equal(calls.windowClose, 1);
});

test('handleMainWindowClosed resets the per-window handshake flags', async () => {
  const C = freshCoordinator();
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.preventDefault, 1);

  // After the window is gone a new one starts unapproved again, so the next
  // close prompts rather than sailing through.
  C.handleMainWindowClosed();
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.preventDefault, 2);
});

// --- handleRpcShutdown / broadcasts ----------------------------------------

test('an unconfirmed shutdown in show mode asks the renderer to confirm first', async () => {
  const C = freshCoordinator({ mode: 'SHOW' });
  C.setAccidentalShutdownProtection(true);
  await C.handleRpcShutdown(false);
  assert.deepEqual(calls.pushToRenderers, [['ShutdownRequested']]);
  assert.equal(calls.quit, 0);
});

test('a confirmed shutdown quits even in show mode', async () => {
  const C = freshCoordinator({ mode: 'SHOW' });
  C.setAccidentalShutdownProtection(true);
  await C.handleRpcShutdown(true);
  assert.deepEqual(calls.pushToRenderers, []);
  assert.equal(calls.quit, 1);
});

test('a shutdown with no main window quits rather than asking an absent renderer', async () => {
  const C = freshCoordinator({ mode: 'SHOW', hasWindow: false });
  C.setAccidentalShutdownProtection(true);
  await C.handleRpcShutdown(false);
  assert.equal(calls.quit, 1);
});

test('a shutdown with protection disabled quits immediately', async () => {
  const C = freshCoordinator({ mode: 'SHOW' });
  await C.handleRpcShutdown(false);
  assert.equal(calls.quit, 1);
});

test('a broadcast shutdown quits and bypasses the show-mode confirmation', async () => {
  const C = freshCoordinator({ mode: 'SHOW' });
  C.setAccidentalShutdownProtection(true);
  C.handleBroadcastShutdown();
  assert.equal(calls.quit, 1);

  // Bypass is set, so the follow-up close does not re-prompt.
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 0);
});

test('a system power-down is intercepted and routed through the graceful path', async () => {
  const C = freshCoordinator({ mode: 'SHOW' });
  C.setAccidentalShutdownProtection(true);
  const Event = cancelableEvent();
  C.handlePowerMonitorShutdown(Event);
  // The OS event is cancelled so our own cleanup can run first.
  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.quit, 1);
});

// --- handleBeforeQuit and shutdown cleanup ---------------------------------

test('before-quit routes through the window so save prompts still fire', () => {
  const C = freshCoordinator();
  const Event = cancelableEvent();
  C.handleBeforeQuit(Event);
  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.windowClose, 1);
  // Cleanup has NOT run yet — the window close has to be approved first.
  assert.deepEqual(calls.dbShutdown, []);
});

test('before-quit runs the full cleanup once the close is approved, then quits', async () => {
  const C = freshCoordinator();
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent()); // approves
  calls.quit = 0;

  C.handleBeforeQuit(cancelableEvent());
  await flush();

  assert.equal(calls.stopAutosave, 1);
  assert.equal(calls.networkStop, 1);
  assert.equal(calls.monitoringShutdown, 1);
  assert.equal(calls.dummyShutdown, 1);
  assert.deepEqual(calls.dbShutdown, [{ TimeoutMs: 5000 }]);
  assert.equal(calls.quit, 1, 'the real quit only happens after cleanup completes');
});

test('before-quit closes the database exactly once across repeated quit attempts', async () => {
  // Electron can emit before-quit more than once; a second SQLite close would
  // race the first and can corrupt the file.
  const C = freshCoordinator();
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());

  C.handleBeforeQuit(cancelableEvent());
  C.handleBeforeQuit(cancelableEvent()); // arrives while cleanup is in flight
  await flush();
  C.handleBeforeQuit(cancelableEvent()); // arrives after cleanup completed
  await flush();

  assert.equal(calls.dbShutdown.length, 1);
  assert.equal(calls.stopAutosave, 1);
});

test('before-quit stops preventing the default once cleanup has completed', async () => {
  const C = freshCoordinator();
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  C.handleBeforeQuit(cancelableEvent());
  await flush();

  const Before = calls.preventDefault;
  C.handleBeforeQuit(cancelableEvent());
  assert.equal(calls.preventDefault, Before, 'a blocked quit here would hang the app on exit');
});

test('cleanup still closes the database when earlier steps throw', async () => {
  // Every step is independently guarded so one failing subsystem cannot strand
  // the database open — that is what would actually corrupt a show file.
  const C = freshCoordinator({
    throwOn: { stopAutosave: true, networkStop: true, monitoring: true, dummy: true },
  });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  calls.quit = 0;

  C.handleBeforeQuit(cancelableEvent());
  await flush();

  assert.equal(calls.dbShutdown.length, 1);
  assert.equal(calls.quit, 1);
});

test('a failing database shutdown still lets the app quit', async () => {
  const C = freshCoordinator({ throwOn: { dbShutdown: true } });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  calls.quit = 0;

  C.handleBeforeQuit(cancelableEvent());
  await flush();

  // Hanging here would leave a zombie process the user has to kill by hand.
  assert.equal(calls.quit, 1);
});

test('cleanup skips optional Shutdown methods that are not implemented', async () => {
  const C = freshCoordinator({ monitoringShutdownFn: false, dummyShutdownFn: false });
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());

  C.handleBeforeQuit(cancelableEvent());
  await flush();

  assert.equal(calls.monitoringShutdown, 0);
  assert.equal(calls.dummyShutdown, 0);
  assert.equal(calls.dbShutdown.length, 1);
});

test('before-quit with no main window goes straight to cleanup', async () => {
  const C = freshCoordinator({ hasWindow: false });
  C.handleBeforeQuit(cancelableEvent());
  await flush();
  assert.equal(calls.dbShutdown.length, 1);
});

// --- Update install path ----------------------------------------------------

test('quitting to install an update bypasses every shutdown guard', async () => {
  const C = freshCoordinator({ mode: 'SHOW', hasUnsavedChanges: true });
  C.setAccidentalShutdownProtection(true);
  C.handleBeforeQuitForUpdate();

  // No confirmation, no save prompt, no preventDefault: the updater has already
  // taken responsibility for the restart.
  await C.handleMainWindowClose(mainWindowStub, cancelableEvent());
  assert.equal(calls.messageBox.length, 0);
  assert.equal(calls.preventDefault, 0);

  C.handleBeforeQuit(cancelableEvent());
  await flush();
  assert.equal(calls.preventDefault, 0, 'blocking here would abort the update install');
  assert.deepEqual(calls.dbShutdown, []);
});
