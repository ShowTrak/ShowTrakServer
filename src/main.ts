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
const { app, BrowserWindow } = require('electron/main');
const { powerMonitor, autoUpdater: nativeAutoUpdater } = require('electron');
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
const { Manager: AlertsManager } = require('./Modules/AlertsManager');
const { Manager: AudioAssetManager } = require('./Modules/AudioAssetManager');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: NetworkInterfaces } = require('./Modules/NetworkInterfaces');
const { Manager: SettingsManager } = require('./Modules/SettingsManager');
const { Manager: ModeManager } = require('./Modules/ModeManager');
const { Wait } = require('./Modules/Utils');
const path = require('path');

// --- Main-process infrastructure (no manager dependencies) -------------------
const { RPC } = require('./main/rpc');
const { RegisterRendererSink, PushToRenderers } = require('./main/renderer-bus');
const { getMainWindow, setMainWindow, hasMainWindow } = require('./main/app-window');
const { configureApplicationMenu } = require('./main/app-menu');
const { applyWindowSecurityGuards } = require('./main/window-guards');
const { scheduleAutosave } = require('./main/autosave');
const {
  setAccidentalShutdownProtection,
  handleMainWindowClose,
  handleMainWindowClosed,
  handleRpcShutdown,
  handleBroadcastShutdown,
  handleBroadcastShutdownForce,
  handleBeforeQuit,
  handlePowerMonitorShutdown,
  handleBeforeQuitForUpdate,
} = require('./main/shutdown-coordinator');

// The Electron desktop window is a renderer sink: forward every pushed channel
// to it (guarded against teardown). Web sockets register their own sink later.
RegisterRendererSink((channel: string, ...args: unknown[]) => {
  if (hasMainWindow()) {
    getMainWindow().webContents.send(channel, ...args);
  }
});

// Start watching network interfaces for the whole app (multicast checks, the
// discovery scanner and the Web UI address list all read from this authority).
// Push the live external-IPv4 list to renderers whenever the set changes so any
// open UI (e.g. the Remote Access panel) stays current without a manual refresh.
NetworkInterfaces.Init();
NetworkInterfaces.OnChange((Change: { Current: unknown }) => {
  try {
    PushToRenderers('NetworkInterfacesChanged', Change.Current);
  } catch (Err) {
    Logger.error('Failed to push NetworkInterfacesChanged:', Err);
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

// Main UI window is owned by ./main/app-window (get/set via accessors). The
// window/shutdown lifecycle handshake (flags, prompts, cleanup) lives in
// ./main/shutdown-coordinator; the Electron events below delegate to it.
function sendAppMenuAction(actionID: string) {
  try {
    if (hasMainWindow()) {
      PushToRenderers('AppMenuAction', String(actionID || ''));
    }
  } catch {
    // Best-effort UI action dispatch; ignore teardown races.
  }
}

let PreloaderWindow!: ElectronBrowserWindow;

app.whenReady().then(async () => {
  if (require('electron-squirrel-startup')) return app.quit();

  configureApplicationMenu({
    sendAppMenuAction,
    setMode: (mode: string) => ModeManager.Set(mode),
  });

  if (getMainWindow()) {
    getMainWindow().close();
    setMainWindow(null);
  }

  setAccidentalShutdownProtection(
    await SettingsManager.GetValue('SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4')
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
  MainWindow.on('close', (event) => handleMainWindowClose(MainWindow, event));
  MainWindow.on('closed', () => {
    handleMainWindowClosed();
    setMainWindow(null);
  });
  MainWindow.on('enter-full-screen', () => sendMainWindowFullscreenChanged(true));
  MainWindow.on('leave-full-screen', () => sendMainWindowFullscreenChanged(false));

  // Register every IPC handler (grouped by domain under ./main/registrars).
  RegisterAllHandlers();

  // Renderer-invoked shutdown. The coordinator decides whether to quit now or
  // ask the renderer to confirm first (show mode).
  RPC.handle('Shutdown', async (_event: unknown, Confirmed = false) => {
    await handleRpcShutdown(Confirmed);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS: consider re-creating or showing a window when the dock icon is clicked.
    }
  });
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
// The autosave timer lives in ./main/autosave; reschedule it on settings change
// and once at boot. `stopAutosave` runs in the shutdown cleanup path below.
BroadcastManager.on('AutosaveSettingsChanged', scheduleAutosave);
scheduleAutosave().catch((Err: unknown) => Logger.error('Failed to schedule autosave:', Err));

// --- Live-applied settings ---------------------------------------------------
// Log level, default monitoring interval, and shutdown protection are applied
// at boot and re-applied on change (no restart required). See ./main/live-settings.
const { initLiveSettings } = require('./main/live-settings');
initLiveSettings().catch((Err: unknown) => Logger.error('Failed to init live settings:', Err));

// --- Remote/OS shutdown hooks ------------------------------------------------
BroadcastManager.on('Shutdown', handleBroadcastShutdown);
BroadcastManager.on('ShutdownForce', handleBroadcastShutdownForce);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', handleBeforeQuit);

// The power-save blocker (Prevent Display Sleep) is applied — and kept in sync
// on change — by ./main/live-settings (initLiveSettings, wired above).

powerMonitor.on('shutdown', handlePowerMonitorShutdown);

nativeAutoUpdater.on('before-quit-for-update', handleBeforeQuitForUpdate);

// Final shutdown hook: place for flushing buffers/closing resources if needed.
app.on('will-quit', (_event: unknown) => {
  Logger.log('App is closing, performing cleanup...');
});
