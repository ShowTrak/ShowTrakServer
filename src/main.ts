// Electron main process entrypoint — composition root. Responsibilities:
// - Enforce single-instance behavior
// - Boot the back-end managers (their require-time side effects bind the HTTP +
//   Socket.IO server and the OSC UDP listener; explicit Init() calls follow)
// - Create and manage the Preloader and Main windows + application menu
// - Own the window / shutdown lifecycle (save prompts, cleanup, power hooks)
// - Wire the decomposed IPC registrars and the broadcast → renderer bridge
//
// The bulk of the previous 2,600-line file — the ~90 IPC handlers, the ~23
// broadcast subscribers, and the deployment orchestration — now lives under
// src/main/ (registrars/, broadcast-bridge.ts, deployment.ts, initial-state.ts).
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
const { app, BrowserWindow, Menu } = require('electron/main');
// Use Electron's shell for opening folders/URLs instead of spawning platform-specific commands
const {
  shell,
  dialog,
  powerMonitor,
  powerSaveBlocker,
  autoUpdater: nativeAutoUpdater,
} = require('electron');
if (require('electron-squirrel-startup')) app.quit();

const { Manager: AppDataManager } = require('./Modules/AppData');
AppDataManager.Initialize();
const { CreateLogger } = require('./Modules/Logger');
const Logger = CreateLogger('Main');
// Gate multiple instances. If another instance is already running, quit early.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  Logger.error('Another instance of ShowTrak Server is already running. Exiting this instance.');
  app.quit();
  process.exit(0);
} else {
  Logger.log('Single instance lock acquired');
}

const { PRELOADER_MIN_DISPLAY_MS } = require('./Modules/Config/constants');

// --- Back-end manager boot ---------------------------------------------------
// Load order is preserved from the original main.ts. `require('./Modules/Server')`
// and `require('./Modules/OSC')` bind their listeners on load, so they are loaded
// here explicitly and early rather than lazily via a registrar. The remaining
// managers are loaded during this module's evaluation via the registrar and
// broadcast-bridge requires below (each manager pulls its own dependencies).
const { Manager: ScriptManager } = require('./Modules/ScriptManager');
ScriptManager.GetScripts();
const { Manager: SampleScriptsManager } = require('./Modules/SampleScripts');
SampleScriptsManager.Initialize();
require('./Modules/Server'); // binds HTTP + Socket.IO server on load
const { Manager: BonjourManager } = require('./Modules/Bonjour');
BonjourManager.Init();
require('./Modules/OSC'); // binds the OSC UDP listener on load
const { Manager: MonitoringTargetManager } = require('./Modules/MonitoringTargetManager');
const { Manager: DummyClientManager } = require('./Modules/DummyClientManager');
const { Manager: DBManager } = require('./Modules/DB');
const { Manager: AlertsManager } = require('./Modules/AlertsManager');
const { Manager: AudioAssetManager } = require('./Modules/AudioAssetManager');
const { Manager: FileSelectorManager } = require('./Modules/FileSelectorManager');
const { Manager: BackupManager } = require('./Modules/BackupManager');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: SettingsManager } = require('./Modules/SettingsManager');
const { Manager: ModeManager } = require('./Modules/ModeManager');
const { Wait } = require('./Modules/Utils');
const path = require('path');

// --- Main-process infrastructure (no manager dependencies) -------------------
const { RPC } = require('./main/rpc');
const { RegisterRendererSink, PushToRenderers } = require('./main/renderer-bus');
const {
  getMainWindow,
  setMainWindow,
  hasMainWindow,
  sendShowFileUpdated,
} = require('./main/app-window');

// Minimal shape for the Electron lifecycle events whose only use here is
// cancelling the default action.
interface CancelableEvent {
  preventDefault(): void;
}

// The Electron desktop window is a renderer sink: forward every pushed channel
// to it (guarded against teardown). Web sockets register their own sink later.
RegisterRendererSink((channel: string, ...args: unknown[]) => {
  if (hasMainWindow()) {
    getMainWindow().webContents.send(channel, ...args);
  }
});

const BASE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
});
const WINDOW_DRAGBAR_HEIGHT_PX = 32;
const MAC_TRAFFIC_LIGHT_DIAMETER_PX = 12;
const MAC_TRAFFIC_LIGHT_LEFT_PADDING_PX = 12;
const MAC_TRAFFIC_LIGHT_TOP_PADDING_PX = Math.max(
  0,
  Math.round((WINDOW_DRAGBAR_HEIGHT_PX - MAC_TRAFFIC_LIGHT_DIAMETER_PX) / 2)
);

const WINDOW_CHROME_OPTIONS =
  process.platform === 'darwin'
    ? {
        frame: true,
        titleBarStyle: 'hidden',
        trafficLightPosition: {
          x: MAC_TRAFFIC_LIGHT_LEFT_PADDING_PX,
          y: MAC_TRAFFIC_LIGHT_TOP_PADDING_PX,
        },
      }
    : {
        frame: true,
        titleBarStyle: 'hidden',
      };

function sendMainWindowFullscreenChanged(isFullscreen: boolean) {
  try {
    if (hasMainWindow()) {
      PushToRenderers('MainWindowFullscreenChanged', Boolean(isFullscreen));
    }
  } catch {
    // Non-critical UI sync; ignore transient teardown errors.
  }
}

function getWindowIconPath() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(__dirname, 'images', iconName);
}

function applyWindowSecurityGuards(windowInstance: ElectronBrowserWindow) {
  if (!windowInstance || windowInstance.isDestroyed()) return;

  windowInstance.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
    } catch (_error) {
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  windowInstance.webContents.on('will-navigate', (event, url) => {
    const currentURL = windowInstance.webContents.getURL();
    if (!currentURL || !url) return;
    if (url !== currentURL) {
      event.preventDefault();
    }
  });
}

// Main UI window is owned by ./main/app-window (get/set via accessors). These
// module-local flags track the window/shutdown lifecycle handshake.
let mainWindowCloseApproved = false;
let closePromptInFlight = false;
let quitRequested = false;
let accidentalShutdownProtectionEnabled = false;
let bypassShutdownConfirmation = false;
let shutdownCleanupInFlight = false;
let shutdownCleanupComplete = false;
let quittingForUpdate = false;

function sendAppMenuAction(actionID: string) {
  try {
    if (hasMainWindow()) {
      PushToRenderers('AppMenuAction', String(actionID || ''));
    }
  } catch {
    // Best-effort UI action dispatch; ignore teardown races.
  }
}

function buildMacAppMenuTemplate() {
  const fileSubmenu = [
    {
      label: 'New Show',
      accelerator: 'CmdOrCtrl+N',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_NEW'),
    },
    {
      label: 'Open',
      accelerator: 'CmdOrCtrl+O',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OPEN'),
    },
    {
      label: 'Save',
      accelerator: 'CmdOrCtrl+S',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SAVE'),
    },
    {
      label: 'Save As',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SAVEAS'),
    },
    { type: 'separator' },
    {
      label: 'Show Mode',
      accelerator: 'CmdOrCtrl+1',
      click: () => ModeManager.Set('SHOW'),
    },
    {
      label: 'Edit Mode',
      accelerator: 'CmdOrCtrl+2',
      click: () => ModeManager.Set('EDIT'),
    },
    { type: 'separator' },
    {
      label: 'Open Logs Directory',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_LOGSFOLDER'),
    },
    {
      label: 'Open Scripts Directory',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SCRIPTSFOLDER'),
    },
    { type: 'separator' },
    {
      label: 'LAN Discovery Wizard',
      accelerator: 'CmdOrCtrl+L',
      click: () => sendAppMenuAction('ADD_TARGET_BROWSE_ACTION'),
    },
    {
      label: 'Script Manager',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SCRIPT_MANAGER_BUTTON'),
    },
    {
      label: 'Update Manager',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_UPDATE_MANAGER_BUTTON'),
    },
    {
      label: 'OSC/API Reference',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON'),
    },
    {
      label: 'OSC/API Debug Terminal',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OSC_HTTP_DEBUG_BUTTON'),
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_CHECKUPDATES'),
    },
    { label: 'About', click: () => sendAppMenuAction('SHOWTRAK_ABOUT_BUTTON') },
    { type: 'separator' },
    {
      label: 'ShowTrak Preferences',
      accelerator: 'CmdOrCtrl+,',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_OPEN_SETTINGS'),
    },
    {
      label: 'Close ShowTrak',
      click: () => sendAppMenuAction('SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON'),
    },
  ];

  return [
    { role: 'appMenu' },
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}

function configureApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const menu = Menu.buildFromTemplate(buildMacAppMenuTemplate());
  Menu.setApplicationMenu(menu);
}

async function PromptConfirmBeforeShutdown() {
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

async function PromptSaveBeforeClose() {
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

let PreloaderWindow!: ElectronBrowserWindow;

app.whenReady().then(async () => {
  if (require('electron-squirrel-startup')) return app.quit();

  configureApplicationMenu();

  if (getMainWindow()) {
    getMainWindow().close();
    setMainWindow(null);
  }

  accidentalShutdownProtectionEnabled = await SettingsManager.GetValue(
    'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4'
  );

  // Lightweight splash that keeps the app responsive while heavy init finishes
  PreloaderWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 400,
    height: 500,
    resizable: false,
    webPreferences: {
      ...BASE_WEB_PREFERENCES,
      preload: path.join(__dirname, 'bridge_preloader.js'),
      devTools: !app.isPackaged,
    },
    icon: getWindowIconPath(),
    ...WINDOW_CHROME_OPTIONS,
  });

  PreloaderWindow.once('ready-to-show', () => {
    PreloaderWindow.show();
  });

  PreloaderWindow.loadFile(path.join(__dirname, 'UI', 'preloader.html'));
  applyWindowSecurityGuards(PreloaderWindow);

  // Primary UI window. Defer showing until UI is loaded to avoid white flash.
  const MainWindow: ElectronBrowserWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 1600,
    height: 940,
    minWidth: 1108,
    minHeight: 600,
    webPreferences: {
      ...BASE_WEB_PREFERENCES,
      preload: path.join(__dirname, 'bridge_main.js'),
      devTools: !app.isPackaged,
    },
    icon: getWindowIconPath(),
    ...WINDOW_CHROME_OPTIONS,
  });
  setMainWindow(MainWindow);

  MainWindow.loadFile(path.join(__dirname, 'UI', 'index.html')).then(async () => {
    Logger.log('MainWindow finished loading UI');
    sendMainWindowFullscreenChanged(MainWindow.isFullScreen());
    // Initial payloads to hydrate renderer stores
    UpdateAdoptionList();
    // Boot monitoring loops once the DB schema is ready
    MonitoringTargetManager.Init().catch((Err: unknown) =>
      Logger.error('Failed to init MonitoringTargetManager:', Err)
    );
    DummyClientManager.Init().catch((Err: unknown) =>
      Logger.error('Failed to init DummyClientManager:', Err)
    );
    AlertsManager.Init().catch((Err: unknown) => Logger.error('Failed to init AlertsManager:', Err));
    AudioAssetManager.Init()
      .then(() => ValidateAlertAudioAssets())
      .catch((Err: unknown) => Logger.error('Failed to init AudioAssetManager:', Err));
    await Wait(PRELOADER_MIN_DISPLAY_MS);
    PreloaderWindow.close();
    MainWindow.show();
  });
  applyWindowSecurityGuards(MainWindow);
  MainWindow.on('close', async (event) => {
    if (mainWindowCloseApproved || quittingForUpdate) return;
    event.preventDefault();
    if (closePromptInFlight) return;

    closePromptInFlight = true;
    try {
      const shouldProceedWithShutdown = await PromptConfirmBeforeShutdown();
      if (!shouldProceedWithShutdown) {
        quitRequested = false;
        return;
      }

      const shouldClose = await PromptSaveBeforeClose();
      if (!shouldClose) {
        quitRequested = false;
        return;
      }

      mainWindowCloseApproved = true;
      if (quitRequested) {
        app.quit();
        return;
      }
      MainWindow.close();
    } catch (Err) {
      Logger.error('Unexpected error while prompting to save before close:', Err);
    } finally {
      closePromptInFlight = false;
    }
  });
  MainWindow.on('closed', () => {
    mainWindowCloseApproved = false;
    bypassShutdownConfirmation = false;
    setMainWindow(null);
  });
  MainWindow.on('enter-full-screen', () => sendMainWindowFullscreenChanged(true));
  MainWindow.on('leave-full-screen', () => sendMainWindowFullscreenChanged(false));

  // Register every IPC handler (grouped by domain under ./main/registrars).
  RegisterAllHandlers();

  // Renderer signaled it (re)loaded: push the current authoritative state.
  // Kept here (rather than in a registrar) because the shutdown handler below
  // shares this module's lifecycle flags.
  async function Shutdown({ bypassAccidentalConfirmation = true } = {}) {
    Logger.log('Application shutdown requested');
    bypassShutdownConfirmation = bypassAccidentalConfirmation;
    quitRequested = true;
    app.quit();
    return;
  }

  RPC.handle('Shutdown', async (_event: unknown, Confirmed = false) => {
    const shouldRequestRendererConfirmation =
      !Confirmed &&
      accidentalShutdownProtectionEnabled &&
      ModeManager.Get() === 'SHOW' &&
      hasMainWindow();

    if (shouldRequestRendererConfirmation) {
      PushToRenderers('ShutdownRequested');
      return;
    }

    Shutdown({ bypassAccidentalConfirmation: true });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS: consider re-creating or showing a window when the dock icon is clicked.
    }
  });

  // MainWindow.webContents.openDevTools();
});

// --- Broadcast → renderer bridge ---------------------------------------------
// Registering the subscribers here (during module evaluation, before whenReady
// fires) matches the original registration timing.
const {
  RegisterBroadcastBridge,
  ValidateAlertAudioAssets,
  UpdateAdoptionList,
} = require('./main/broadcast-bridge');
const { RegisterAllHandlers } = require('./main/registrars');
RegisterBroadcastBridge();

// --- Autosave ----------------------------------------------------------------
// Periodically snapshot the open ShowTrak file back to its path. The timer is
// rescheduled whenever the relevant settings change. A tick is a no-op when
// autosave is disabled or no file is currently open.
let AutosaveTimer: ReturnType<typeof setInterval> | null = null;

async function RunAutosaveTick() {
  try {
    const Enabled = await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED');
    if (!Enabled) return;
    const CurrentPath = BackupManager.GetCurrentFilePath();
    if (!CurrentPath) return;
    const [Err] = await BackupManager.Save(CurrentPath);
    if (Err) {
      Logger.error('Autosave failed:', Err);
      return;
    }
    Logger.log('Autosave completed to:', CurrentPath);
  } catch (Err) {
    Logger.error('Autosave tick error:', Err);
  }
}

async function ScheduleAutosave() {
  if (AutosaveTimer) {
    clearInterval(AutosaveTimer);
    AutosaveTimer = null;
  }
  const Enabled = await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED');
  if (!Enabled) return;
  let Minutes = await SettingsManager.GetValue('SYSTEM_AUTOSAVE_INTERVAL_MINUTES');
  Minutes = Number(Minutes);
  if (!Number.isFinite(Minutes) || Minutes < 1) Minutes = 1;
  AutosaveTimer = setInterval(RunAutosaveTick, Minutes * 60 * 1000);
  Logger.log(`Autosave scheduled every ${Minutes} minute(s)`);
}

BroadcastManager.on('AutosaveSettingsChanged', ScheduleAutosave);
ScheduleAutosave().catch((Err: unknown) => Logger.error('Failed to schedule autosave:', Err));

// --- Remote/OS shutdown hooks ------------------------------------------------
BroadcastManager.on('Shutdown', async () => {
  Logger.log('Application shutdown requested (broadcast)');
  bypassShutdownConfirmation = true;
  quitRequested = true;
  app.quit();
});

BroadcastManager.on('ShutdownForce', async () => {
  Logger.warn('Application force shutdown requested (broadcast)');
  // Bypass close prompts so remote forced shutdowns can proceed immediately.
  bypassShutdownConfirmation = true;
  mainWindowCloseApproved = true;
  quitRequested = true;
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

async function runShutdownCleanup() {
  try {
    if (AutosaveTimer) {
      clearInterval(AutosaveTimer);
      AutosaveTimer = null;
    }
  } catch {
    /* intentional: clearing the autosave timer during shutdown is best-effort */
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
    await DBManager.Shutdown({ TimeoutMs: 15000 });
  } catch (Err) {
    Logger.error('DB shutdown cleanup failed:', Err);
  }
}

app.on('before-quit', (event: CancelableEvent) => {
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
});

// Feature toggles controlled by Settings: power-save blocker and auto-update.
async function StartOptionalFeatures() {
  const SYSTEM_PREVENT_DISPLAY_SLEEP = await SettingsManager.GetValue(
    'SYSTEM_PREVENT_DISPLAY_SLEEP'
  );
  if (SYSTEM_PREVENT_DISPLAY_SLEEP) {
    Logger.log('Prevent Display Sleep is enabled, starting powerSaveBlocker.');
    powerSaveBlocker.start('prevent-display-sleep');
  } else {
    Logger.log('Prevent Display Sleep is disabled in settings, not starting powerSaveBlocker.');
  }
}
StartOptionalFeatures();

powerMonitor.on('shutdown', (event: CancelableEvent) => {
  Logger.warn('System shutdown detected, routing through graceful app shutdown');
  event.preventDefault();
  bypassShutdownConfirmation = true;
  quitRequested = true;
  app.quit();
});

nativeAutoUpdater.on('before-quit-for-update', () => {
  Logger.log('Update install requested, bypassing shutdown guards');
  quittingForUpdate = true;
  bypassShutdownConfirmation = true;
  quitRequested = true;
});

// Final shutdown hook: place for flushing buffers/closing resources if needed.
app.on('will-quit', (_event: unknown) => {
  Logger.log('App is closing, performing cleanup...');
});
