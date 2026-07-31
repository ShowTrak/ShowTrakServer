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

import { Manager as AppDataManager } from './Modules/AppData';
AppDataManager.Initialize();
import { CreateLogger } from './Modules/Logger';
const Logger = CreateLogger('Main');
// Install the process-wide network fault guards before any socket-binding module
// loads, so a mid-boot interface drop (mDNS/OSC/etc.) is caught rather than
// crashing the process. See ./main/process-guards.
import { installProcessGuards } from './main/process-guards';
installProcessGuards();
// Gate multiple instances. If another instance is already running, quit early.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  Logger.error('Another instance of ShowTrak Server is already running. Exiting this instance.');
  app.quit();
  process.exit(0);
} else {
  Logger.log('Single instance lock acquired');
}

import { PRELOADER_MIN_DISPLAY_MS } from './Modules/Config/constants';

// --- Back-end manager boot ---------------------------------------------------
// Load order is preserved from the original main.ts. `require('./Modules/Server')`
// and `require('./Modules/OSC')` bind their listeners on load, so they are loaded
// here explicitly and early rather than lazily via a registrar. The remaining
// managers are loaded during this module's evaluation via the registrar and
// broadcast-bridge requires below (each manager pulls its own dependencies).
import { Manager as ScriptManager } from './Modules/ScriptManager';
ScriptManager.GetScripts();
import { Manager as SampleScriptsManager } from './Modules/SampleScripts';
SampleScriptsManager.Initialize();
import './Modules/Server'; // binds HTTP + Socket.IO server on load
import { Manager as BonjourManager } from './Modules/Bonjour';
BonjourManager.Init();
import './Modules/OSC'; // binds the OSC UDP listener on load
import { Manager as MonitoringTargetManager } from './Modules/MonitoringTargetManager';
import { Manager as ClientManager } from './Modules/ClientManager';
import { Manager as GroupManager } from './Modules/GroupManager';
import { Manager as TagManager } from './Modules/TagManager';
import { Manager as FogManager } from './Modules/FogManager';
import { Manager as DummyClientManager } from './Modules/DummyClientManager';
import { Manager as FreeKioskManager } from './Modules/FreeKioskManager';
import { Manager as AlertsManager } from './Modules/AlertsManager';
import { Manager as AudioAssetManager } from './Modules/AudioAssetManager';
import { Manager as BroadcastManager } from './Modules/Broadcast';
import { Manager as NetworkInterfaces } from './Modules/NetworkInterfaces';
import { Manager as SettingsManager } from './Modules/SettingsManager';
import { Manager as ModeManager } from './Modules/ModeManager';
import { Wait } from './Modules/Utils';
const path = require('path');

// --- Main-process infrastructure (no manager dependencies) -------------------
import { RPC } from './main/rpc';
import { RegisterRendererSink, PushToRenderers } from './main/renderer-bus';
import { getMainWindow, setMainWindow, hasMainWindow } from './main/app-window';
import { configureApplicationMenu } from './main/app-menu';
import { applyWindowSecurityGuards } from './main/window-guards';
import { applyWindowZoomShortcuts } from './main/window-zoom';
import { scheduleAutosave } from './main/autosave';
import {
  setAccidentalShutdownProtection,
  handleMainWindowClose,
  handleMainWindowClosed,
  handleRpcShutdown,
  handleBroadcastShutdown,
  handleBroadcastShutdownForce,
  handleBeforeQuit,
  handlePowerMonitorShutdown,
  handleBeforeQuitForUpdate,
} from './main/shutdown-coordinator';

// The Electron desktop window is a renderer sink: forward every pushed channel
// to it (guarded against teardown). Web sockets register their own sink later.
RegisterRendererSink((channel: string, ...args: unknown[]) => {
  const Window = getMainWindow();
  if (Window) {
    Window.webContents.send(channel, ...args);
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

  const ExistingWindow = getMainWindow();
  if (ExistingWindow) {
    ExistingWindow.close();
    setMainWindow(null);
  }

  setAccidentalShutdownProtection(
    !!(await SettingsManager.GetValue('SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4'))
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
    FreeKioskManager.Init().catch((Err: unknown) =>
      Logger.error('Failed to init FreeKioskManager:', Err)
    );
    AlertsManager.Init().catch((Err: unknown) =>
      Logger.error('Failed to init AlertsManager:', Err)
    );
    // Ensure every client / monitoring target / group has a non-null slug. Rows
    // created before slugs existed are back-filled with generated unique values.
    // Run sequentially so the shared client namespace never hands out the same
    // slug to two entities in the same pass.
    (async () => {
      try {
        await ClientManager.BackfillSlugs();
        await MonitoringTargetManager.BackfillSlugs();
        await FreeKioskManager.BackfillSlugs();
        await GroupManager.BackfillSlugs();
        await TagManager.BackfillSlugs();
      } catch (Err: unknown) {
        Logger.error('Failed to back-fill slugs:', Err);
      }
    })();
    AudioAssetManager.Init()
      .then(() => ValidateAlertAudioAssets())
      .catch((Err: unknown) => Logger.error('Failed to init AudioAssetManager:', Err));
    // The FOG poller always starts; it reports "not enabled" until the setting is
    // turned on, which is what lets the toggle take effect without a restart.
    // Deliberately not awaited — a slow or unreachable FOG server must not hold up
    // the main window appearing.
    FogManager.Start().catch((Err: unknown) => Logger.error('Failed to start FogManager:', Err));
    await Wait(PRELOADER_MIN_DISPLAY_MS);
    PreloaderWindow.close();
    if (await SettingsManager.GetValue('SYSTEM_AUTO_MAXIMIZE_ON_BOOT')) {
      MainWindow.maximize();
    }
    MainWindow.show();
  });
  applyWindowSecurityGuards(MainWindow);
  applyWindowZoomShortcuts(MainWindow);
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
    await handleRpcShutdown(!!Confirmed);
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
import {
  RegisterBroadcastBridge,
  StartAlertBaselineSweep,
  ValidateAlertAudioAssets,
  UpdateAdoptionList,
} from './main/broadcast-bridge';
import { RegisterAllHandlers } from './main/registrars';
RegisterBroadcastBridge();
// Faults that were already true at start-up are held rather than announced as
// fresh outages; this slow sweep is what raises the ones that turn out to be
// real once the rig has had time to finish coming up.
StartAlertBaselineSweep();

// --- Autosave ----------------------------------------------------------------
// The autosave timer lives in ./main/autosave; reschedule it on settings change
// and once at boot. `stopAutosave` runs in the shutdown cleanup path below.
BroadcastManager.on('AutosaveSettingsChanged', scheduleAutosave);
scheduleAutosave().catch((Err: unknown) => Logger.error('Failed to schedule autosave:', Err));

// --- Live-applied settings ---------------------------------------------------
// Log level, default monitoring interval, and shutdown protection are applied
// at boot and re-applied on change (no restart required). See ./main/live-settings.
import { initLiveSettings } from './main/live-settings';
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
