// Shutdown / quit / update lifecycle coordinator (main process).
//
// Extracted verbatim from main.ts, which previously carried eight loose
// module-level booleans plus the window-close, before-quit, broadcast, power and
// auto-update handlers that read and wrote them. That handshake is the whole
// state machine of "may we quit yet, and what must we save/clean up first"; it
// lives here as encapsulated state with one handler method per Electron event.
// main.ts stays the composition root — it registers the events and delegates
// their bodies to these methods. Behavior is identical to the original inline
// handlers; only the ownership of the flags moved.
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { CreateLogger } from '../Modules/Logger';
import { DB_PENDING_OPERATION_TIMEOUT_MS } from '../Modules/Config/constants';
import { stopAutosave } from './autosave';
const { app } = require('electron/main');
const { dialog } = require('electron');
const {
  getMainWindow,
  hasMainWindow,
  sendShowFileUpdated,
} = require('./app-window');
const { PushToRenderers } = require('./renderer-bus');
const { Manager: ModeManager } = require('../Modules/ModeManager');
const { Manager: BackupManager } = require('../Modules/BackupManager');
const { Manager: SettingsManager } = require('../Modules/SettingsManager');
const { Manager: FileSelectorManager } = require('../Modules/FileSelectorManager');
const { Manager: MonitoringTargetManager } = require('../Modules/MonitoringTargetManager');
const { Manager: DummyClientManager } = require('../Modules/DummyClientManager');
const { Manager: NetworkInterfaces } = require('../Modules/NetworkInterfaces');
const { Manager: DBManager } = require('../Modules/DB');

const Logger = CreateLogger('Main');

// Minimal shape for the Electron lifecycle events whose only use here is
// cancelling the default action.
interface CancelableEvent {
  preventDefault(): void;
}

// --- Lifecycle handshake state ----------------------------------------------
let mainWindowCloseApproved = false;
let closePromptInFlight = false;
let quitRequested = false;
let accidentalShutdownProtectionEnabled = false;
let bypassShutdownConfirmation = false;
let shutdownCleanupInFlight = false;
let shutdownCleanupComplete = false;
let quittingForUpdate = false;

// Whether an accidental-shutdown confirmation should guard Alt+F4 / window close
// while in show mode. Read from settings at boot and stored here.
function setAccidentalShutdownProtection(enabled: boolean): void {
  accidentalShutdownProtectionEnabled = !!enabled;
}

async function promptConfirmBeforeShutdown(): Promise<boolean> {
  if (quittingForUpdate) {
    return true;
  }

  const shouldConfirmShutdown =
    accidentalShutdownProtectionEnabled &&
    ModeManager.Get() === 'SHOW' &&
    !bypassShutdownConfirmation;

  if (!shouldConfirmShutdown) {
    return true;
  }

  const parentWindow = hasMainWindow() ? getMainWindow() : null;
  const { response } = await dialog.showMessageBox(parentWindow, {
    type: 'question',
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: 'Close ShowTrak Server?',
    detail: 'You are currently in show mode, are you sure you want to close?',
  });

  return response === 0;
}

async function promptSaveBeforeClose(): Promise<boolean> {
  const currentFilePath = BackupManager.GetCurrentFilePath();
  const hasNeverBeenSaved = !currentFilePath;
  const hasUnsavedChanges =
    typeof BackupManager.HasUnsavedChanges === 'function'
      ? await BackupManager.HasUnsavedChanges()
      : false;

  let autoSaveEnabled = false;
  try {
    autoSaveEnabled = !!(await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED'));
  } catch (Err) {
    Logger.error('Failed to read autosave setting during shutdown:', Err);
  }

  // If autosave is enabled, skip the save confirmation prompt and close directly.
  // When a show file path exists and there are pending changes, save once before exit.
  if (autoSaveEnabled) {
    if (hasNeverBeenSaved || !hasUnsavedChanges) {
      return true;
    }

    const [Err] = await BackupManager.Save(currentFilePath);
    if (Err) {
      Logger.error('Failed to autosave show during shutdown:', Err);
      dialog.showErrorBox('Unable to Save Show', String(Err));
      return false;
    }

    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    return true;
  }

  if (!hasNeverBeenSaved && !hasUnsavedChanges) {
    return true;
  }

  const { response } = await dialog.showMessageBox(getMainWindow(), {
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: 'You have unsaved show changes.',
    detail: 'Save changes before closing ShowTrak?',
  });

  if (response === 2) return false;
  if (response === 1) return true;

  let SavePath = currentFilePath;
  if (!SavePath) {
    const { canceled, filePath } = await FileSelectorManager.SaveDialog('Save ShowTrak File As');
    if (canceled || !filePath) return false;
    SavePath = filePath;
  }

  const [Err] = await BackupManager.Save(SavePath);
  if (Err) {
    Logger.error('Failed to save show during shutdown:', Err);
    dialog.showErrorBox('Unable to Save Show', String(Err));
    return false;
  }

  sendShowFileUpdated(BackupManager.GetCurrentFilePath());
  return true;
}

// Main window 'close': confirm (show mode) then save-prompt before letting the
// window close or quitting the app. main.ts passes its MainWindow reference.
async function handleMainWindowClose(
  mainWindow: ElectronBrowserWindow,
  event: CancelableEvent
): Promise<void> {
  if (mainWindowCloseApproved || quittingForUpdate) return;
  event.preventDefault();
  if (closePromptInFlight) return;

  closePromptInFlight = true;
  try {
    const shouldProceedWithShutdown = await promptConfirmBeforeShutdown();
    if (!shouldProceedWithShutdown) {
      quitRequested = false;
      return;
    }

    const shouldClose = await promptSaveBeforeClose();
    if (!shouldClose) {
      quitRequested = false;
      return;
    }

    mainWindowCloseApproved = true;
    if (quitRequested) {
      app.quit();
      return;
    }
    mainWindow.close();
  } catch (Err) {
    Logger.error('Unexpected error while prompting to save before close:', Err);
  } finally {
    closePromptInFlight = false;
  }
}

// Main window 'closed': reset the per-window handshake flags. main.ts still owns
// clearing the window reference itself.
function handleMainWindowClosed(): void {
  mainWindowCloseApproved = false;
  bypassShutdownConfirmation = false;
}

// Renderer-invoked Shutdown RPC. Returns true when it kicked off a quit, false
// when it instead asked the renderer to confirm (show mode) first.
async function handleRpcShutdown(confirmed: boolean): Promise<void> {
  const shouldRequestRendererConfirmation =
    !confirmed &&
    accidentalShutdownProtectionEnabled &&
    ModeManager.Get() === 'SHOW' &&
    hasMainWindow();

  if (shouldRequestRendererConfirmation) {
    PushToRenderers('ShutdownRequested');
    return;
  }

  Logger.log('Application shutdown requested');
  bypassShutdownConfirmation = true;
  quitRequested = true;
  app.quit();
}

function handleBroadcastShutdown(): void {
  Logger.log('Application shutdown requested (broadcast)');
  bypassShutdownConfirmation = true;
  quitRequested = true;
  app.quit();
}

function handleBroadcastShutdownForce(): void {
  Logger.warn('Application force shutdown requested (broadcast)');
  // Bypass close prompts so remote forced shutdowns can proceed immediately.
  bypassShutdownConfirmation = true;
  mainWindowCloseApproved = true;
  quitRequested = true;
  app.quit();
}

async function runShutdownCleanup(): Promise<void> {
  try {
    stopAutosave();
  } catch {
    /* intentional: clearing the autosave timer during shutdown is best-effort */
  }

  try {
    NetworkInterfaces.Stop();
  } catch {
    /* intentional: stopping the interface poll timer during shutdown is best-effort */
  }

  try {
    if (typeof MonitoringTargetManager.Shutdown === 'function') {
      await MonitoringTargetManager.Shutdown();
    }
  } catch (Err) {
    Logger.error('Monitoring target shutdown cleanup failed:', Err);
  }

  try {
    if (typeof DummyClientManager.Shutdown === 'function') {
      await DummyClientManager.Shutdown();
    }
  } catch (Err) {
    Logger.error('Dummy client shutdown cleanup failed:', Err);
  }

  try {
    await DBManager.Shutdown({ TimeoutMs: DB_PENDING_OPERATION_TIMEOUT_MS });
  } catch (Err) {
    Logger.error('DB shutdown cleanup failed:', Err);
  }
}

// app 'before-quit': route through window close first (so save prompts fire),
// then run cleanup exactly once before allowing the real quit.
function handleBeforeQuit(event: CancelableEvent): void {
  quitRequested = true;

  if (quittingForUpdate) {
    return;
  }

  if (!mainWindowCloseApproved && hasMainWindow()) {
    event.preventDefault();
    getMainWindow().close();
    return;
  }

  if (shutdownCleanupComplete) return;
  event.preventDefault();
  if (shutdownCleanupInFlight) return;

  shutdownCleanupInFlight = true;
  runShutdownCleanup()
    .catch((Err) => {
      Logger.error('Unexpected error during shutdown cleanup:', Err);
    })
    .finally(() => {
      shutdownCleanupComplete = true;
      shutdownCleanupInFlight = false;
      app.quit();
    });
}

function handlePowerMonitorShutdown(event: CancelableEvent): void {
  Logger.warn('System shutdown detected, routing through graceful app shutdown');
  event.preventDefault();
  bypassShutdownConfirmation = true;
  quitRequested = true;
  app.quit();
}

function handleBeforeQuitForUpdate(): void {
  Logger.log('Update install requested, bypassing shutdown guards');
  quittingForUpdate = true;
  bypassShutdownConfirmation = true;
  quitRequested = true;
}

export {
  setAccidentalShutdownProtection,
  handleMainWindowClose,
  handleMainWindowClosed,
  handleRpcShutdown,
  handleBroadcastShutdown,
  handleBroadcastShutdownForce,
  handleBeforeQuit,
  handlePowerMonitorShutdown,
  handleBeforeQuitForUpdate,
};
