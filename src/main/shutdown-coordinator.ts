// Shutdown / quit / update lifecycle coordinator (main process).
//
// Extracted verbatim from main.ts, which previously carried eight loose
// module-level booleans plus the window-close, before-quit, broadcast, power and
// auto-update handlers that read and wrote them. That handshake is the whole
// state machine of "may we quit yet, and what must we save/clean up first"; it
// lives here as encapsulated state with one handler method per Electron event.
// main.ts stays the composition root; it registers the events and delegates
// their bodies to these methods. Behavior is identical to the original inline
// handlers; only the ownership of the flags moved.
import type {
  BaseWindow,
  BrowserWindow as ElectronBrowserWindow,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron';
import { CreateLogger, flushLogWrites } from '../Modules/Logger';
import { DB_PENDING_OPERATION_TIMEOUT_MS } from '../Modules/Config/constants';
import { stopAutosave } from './autosave';
import { app } from 'electron/main';
import { dialog as ElectronDialog } from 'electron';
import { getMainWindow, hasMainWindow, sendShowFileUpdated } from './app-window';
import { PushToRenderers } from './renderer-bus';
import { Manager as ModeManager } from '../Modules/ModeManager';
import { Manager as BackupManager } from '../Modules/BackupManager';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as FileSelectorManager } from '../Modules/FileSelectorManager';
import { Manager as MonitoringTargetManager } from '../Modules/MonitoringTargetManager';
import { Manager as DummyClientManager } from '../Modules/DummyClientManager';
import { Manager as FreeKioskManager } from '../Modules/FreeKioskManager';
import { Manager as NetworkInterfaces } from '../Modules/NetworkInterfaces';
import { Manager as DBManager } from '../Modules/DB';
import { Manager as AuditLog } from '../Modules/AuditLog';

const Logger = CreateLogger('Main');

// Electron's dialog, typed for how these prompts call it: with the main window
// as the parent, or null once that window is gone. Electron takes null for "no
// parent" (it always has), though its types declare only the overload without
// a window for that case.
const dialog: {
  showMessageBox(
    window: BaseWindow | null,
    options: MessageBoxOptions
  ): Promise<MessageBoxReturnValue>;
  showErrorBox(title: string, content: string): void;
} = ElectronDialog;

// Minimal shape for the Electron lifecycle events whose only use here is
// cancelling the default action.
interface CancelableEvent {
  preventDefault(): void;
}

// How long the quit cleanup may take before the app exits anyway. A cleanup step
// that hangs (a monitoring connection that never answers, a stuck disk) would
// otherwise leave a windowless process holding the single-instance lock and the
// ports, and every relaunch would quietly do nothing. Longer than the database's
// own shutdown timeout, which it must never cut short.
export const SHUTDOWN_CLEANUP_DEADLINE_MS = 30_000;
let shutdownCleanupDeadlineMs = SHUTDOWN_CLEANUP_DEADLINE_MS;

/** Change the cleanup deadline (tests). */
function setShutdownCleanupDeadline(ms: number): void {
  shutdownCleanupDeadlineMs = ms;
}

// --- Lifecycle handshake state ----------------------------------------------
let mainWindowCloseApproved = false;
let closePromptInFlight = false;
let quitRequested = false;
let accidentalShutdownProtectionEnabled = false;
let bypassShutdownConfirmation = false;
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
      dialog.showErrorBox('Failed to Save Show', String(Err));
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
  if (!SavePath) return false;

  const [Err] = await BackupManager.Save(SavePath);
  if (Err) {
    Logger.error('Failed to save show during shutdown:', Err);
    dialog.showErrorBox('Failed to Save Show', String(Err));
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
    if (typeof FreeKioskManager.Shutdown === 'function') {
      await FreeKioskManager.Shutdown();
    }
  } catch (Err) {
    Logger.error('FreeKiosk terminal shutdown cleanup failed:', Err);
  }

  try {
    await AuditLog.Shutdown();
  } catch (Err) {
    Logger.error('Audit log shutdown cleanup failed:', Err);
  }

  try {
    await DBManager.Shutdown({ TimeoutMs: DB_PENDING_OPERATION_TIMEOUT_MS });
  } catch (Err) {
    Logger.error('DB shutdown cleanup failed:', Err);
  }

  // Log lines are appended in batches; give the last of them a moment to reach
  // the file, but never hold the quit up on a stuck disk.
  if (typeof flushLogWrites === 'function') {
    await Promise.race([
      flushLogWrites().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1000).unref?.()),
    ]);
  }
}

// Runs the quit cleanup once, however many quit paths ask for it, and resolves
// when it has finished or its deadline has passed.
let shutdownCleanupRun: Promise<'done' | 'timeout'> | null = null;
let quitAfterCleanupScheduled = false;

function runShutdownCleanupOnce(): Promise<'done' | 'timeout'> {
  if (shutdownCleanupRun) return shutdownCleanupRun;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<'timeout'>((resolve) => {
    deadlineTimer = setTimeout(() => resolve('timeout'), shutdownCleanupDeadlineMs);
  });
  shutdownCleanupRun = Promise.race([
    runShutdownCleanup().then(
      () => 'done' as const,
      (Err: unknown) => {
        Logger.error('Unexpected error during shutdown cleanup:', Err);
        return 'done' as const;
      }
    ),
    deadline,
  ]).then((outcome) => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    shutdownCleanupComplete = true;
    return outcome;
  });
  return shutdownCleanupRun;
}

// app 'before-quit': route through window close first (so save prompts fire),
// then run cleanup exactly once before allowing the real quit. A quit for an
// update skips the window close and its prompts, but not the cleanup: exiting
// with a database write still in flight aborts the process.
function handleBeforeQuit(event: CancelableEvent): void {
  quitRequested = true;

  const Window = getMainWindow();
  if (!quittingForUpdate && !mainWindowCloseApproved && Window) {
    event.preventDefault();
    Window.close();
    return;
  }

  if (shutdownCleanupComplete) return;
  event.preventDefault();
  if (quitAfterCleanupScheduled) return;

  quitAfterCleanupScheduled = true;
  void runShutdownCleanupOnce().then((outcome) => {
    if (outcome === 'timeout') {
      // exit, not quit: a quit would wait on whatever the cleanup is stuck on.
      Logger.error('Shutdown cleanup did not finish in time; exiting without it');
      app.exit(0);
      return;
    }
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

// An update is about to quit the app: skip the confirmation and save prompts,
// and start the cleanup now. The Windows install waits for the returned promise
// before it hands over, because Squirrel starts the new version straight away;
// on macOS, before-quit holds the quit until the cleanup is done (the installer
// waits for the app to exit).
function handleBeforeQuitForUpdate(): Promise<void> {
  Logger.log('Update install requested, bypassing shutdown guards');
  quittingForUpdate = true;
  bypassShutdownConfirmation = true;
  quitRequested = true;
  return runShutdownCleanupOnce().then(() => undefined);
}

export {
  setShutdownCleanupDeadline,
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
