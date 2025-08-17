// Electron main process entrypoint. Responsibilities:
// - Enforce single-instance behavior
// - Create and manage the Preloader and Main windows
// - Bridge IPC between renderer and back-end managers
// - Fan-out broadcast events to the UI (webContents.send guards everywhere)
const { app, BrowserWindow, ipcMain: RPC, Menu } = require('electron/main');
// Use Electron's shell for opening folders/URLs instead of spawning platform-specific commands
const { shell, autoUpdater: SquirrelUpdater } = require('electron');
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

const { Config } = require('./Modules/Config');
const { Manager: ScriptManager } = require('./Modules/ScriptManager');
ScriptManager.GetScripts();
const { Manager: ServerManager } = require('./Modules/Server');
const { Manager: BonjourManager } = require('./Modules/Bonjour');
BonjourManager.Init();
const { Manager: AdoptionManager } = require('./Modules/AdoptionManager');
const { Manager: ClientManager } = require('./Modules/ClientManager');
const { Manager: GroupManager } = require('./Modules/GroupManager');
const { Manager: FileSelectorManager } = require('./Modules/FileSelectorManager');
const { Manager: BackupManager } = require('./Modules/BackupManager');
const { Manager: ScriptExecutionManager } = require('./Modules/ScriptExecutionManager');
const { Manager: WOLManager } = require('./Modules/WOLManager');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: SettingsManager } = require('./Modules/SettingsManager');
const { OSC } = require('./Modules/OSC');
const { Manager: ModeManager } = require('./Modules/ModeManager');
const { Wait } = require('./Modules/Utils');
const path = require('path');
const fs = require('fs');
const os = require('os');
let autoUpdater = null;
let squirrelUpdaterInitialized = false;
function isSquirrelWindows() {
  try {
    if (process.platform !== 'win32') return false;
    const execDir = path.dirname(process.execPath);
    const updateExe1 = path.resolve(execDir, '..', 'Update.exe');
    const updateExe2 = path.resolve(execDir, '..', '..', 'Update.exe');
    return fs.existsSync(updateExe1) || fs.existsSync(updateExe2);
  } catch {
    return false;
  }
}
function initSquirrelUpdater() {
  if (squirrelUpdaterInitialized) return;
  squirrelUpdaterInitialized = true;
  try {
    SquirrelUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
    SquirrelUpdater.on('update-available', () => sendAppUpdateStatus({ state: 'available', info: { tag: 'latest' } }));
    SquirrelUpdater.on('update-not-available', () => sendAppUpdateStatus({ state: 'none' }));
    SquirrelUpdater.on('update-downloaded', (_e, _notes, _name, _date, _url) => {
      sendAppUpdateStatus({ state: 'downloaded', info: { version: _name || 'pending' } });
    });
    SquirrelUpdater.on('error', (err) => sendAppUpdateStatus({ state: 'error', error: String(err) }));
    // Note: Squirrel's autoUpdater may not emit download-progress; states will jump to downloaded
  } catch {}
}
function sendAppUpdateStatus(payload) {
  try {
    if (MainWindow && !MainWindow.isDestroyed()) {
      MainWindow.webContents.send('AppUpdate:Status', payload);
    }
  } catch {}
}

// Main UI window. Always check isDestroyed() before using.
var MainWindow = null;

// Note: Hiding the app menu disables common shortcuts on macOS. If you ship on macOS,
// prefer to keep a minimal menu there and only remove on Windows/Linux.
// Example: if (app.isPackaged && process.platform !== 'darwin') Menu.setApplicationMenu(null);
if (app.isPackaged) Menu.setApplicationMenu(null);
let PreloaderWindow = null;
app.whenReady().then(async () => {
  if (require('electron-squirrel-startup')) return app.quit();

  if (MainWindow) {
    MainWindow.close();
    MainWindow = null;
  }

  // Optional safety: intercept Alt+F4 and request a graceful shutdown via the UI
  let SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4 = await SettingsManager.GetValue(
    'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4'
  );
  if (SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4) {
    app.on('web-contents-created', (_, contents) => {
      contents.on('before-input-event', (event, input) => {
        if (input.code == 'F4' && input.alt) {
          event.preventDefault();
          if (!MainWindow || !MainWindow.isVisible()) return Shutdown();
          Logger.warn('Prevented alt+f4 shutdown, passing request to agent');
          MainWindow.webContents.send('ShutdownRequested');
        }
      });
    });
  }

  // Lightweight splash that keeps the app responsive while heavy init finishes
  PreloaderWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 400,
    height: 500,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'bridge_preloader.js'),
      devTools: !app.isPackaged,
    },
    // macOS: prefer an .icns icon or omit to use the app bundle icon.
    icon: path.join(__dirname, './Images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  });

  PreloaderWindow.once('ready-to-show', () => {
    PreloaderWindow.show();
  });

  PreloaderWindow.loadFile(path.join(__dirname, 'UI', 'preloader.html'));

  // Primary UI window. Defer showing until UI is loaded to avoid white flash.
  MainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 1515,
    height: 940,
    minWidth: 815,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'bridge_main.js'),
      devTools: !app.isPackaged,
    },
    // macOS: prefer an .icns icon or omit to use the app bundle icon.
    icon: path.join(__dirname, './Images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  });

  MainWindow.loadFile(path.join(__dirname, 'UI', 'index.html')).then(async () => {
    Logger.log('MainWindow finished loading UI');
    // Initial payloads to hydrate renderer stores
    UpdateAdoptionList();
    await Wait(800);
    PreloaderWindow.close();
    MainWindow.show();
  });

  // Config backup/restore IPC. Returns [err, result] tuples consistently.
  RPC.handle('BackupConfig', async () => {
    let { canceled, filePath } = await FileSelectorManager.SaveDialog(
      'Export ShowTrak Configuration'
    );
    if (canceled || !filePath) {
      Logger.log('BackupConfig canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Backing up configuration to:', filePath);
    let [Err, Result] = await BackupManager.ExportConfig(filePath);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('ImportConfig', async () => {
    let { canceled, filePaths } = await FileSelectorManager.SelectFile(
      'Select ShowTrak Configuration File to Import'
    );
    if (canceled || !filePaths) {
      console.log(canceled, filePaths);
      Logger.log('ImportConfig canceled');
      return ['Cancelled By User', null];
    }
    if (filePaths.length === 0) {
      Logger.log('No files selected for import');
      return ['No files selected for import', null];
    }
    Logger.log('Importing configuration from:', filePaths[0]);
    let [Err, Result] = await BackupManager.ImportConfig(filePaths[0]);
    if (Err) return [Err, null];
    return [null, Result];
  });
  // Always register IPC handlers so renderer never hits an unhandled channel
  RPC.handle('AppUpdate:Check', async () => {
    // Dev/unpacked: simulate
    if (!app.isPackaged) {
      try {
        sendAppUpdateStatus({ state: 'checking' });
        setTimeout(() => sendAppUpdateStatus({ state: 'available', info: { version: 'TEST' } }), 600);
        let pct = 0;
        const timer = setInterval(() => {
          pct += 14;
          if (pct >= 100) {
            clearInterval(timer);
            sendAppUpdateStatus({ state: 'downloaded', info: { version: 'TEST' } });
          } else {
            sendAppUpdateStatus({ state: 'downloading', percent: pct });
          }
        }, 250);
      } catch (e) {
        sendAppUpdateStatus({ state: 'error', error: String(e) });
      }
      return;
    }

    // Packaged on Windows via Squirrel: use Electron built-in Squirrel updater against GitHub latest
    if (isSquirrelWindows()) {
      try {
        initSquirrelUpdater();
        const feed = 'https://github.com/ShowTrak/ShowTrakServer/releases/latest/download/';
        // Try both object and string forms for compatibility
        try { SquirrelUpdater.setFeedURL({ url: feed }); }
        catch { SquirrelUpdater.setFeedURL(feed); }
        SquirrelUpdater.checkForUpdates();
      } catch (e) {
        sendAppUpdateStatus({ state: 'error', error: String(e) });
      }
      return;
    }

    // Packaged (non-Squirrel): ensure electron-updater is initialized
    if (!autoUpdater) {
      try {
        const { autoUpdater: updater } = require('electron-updater');
        autoUpdater = updater;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
        autoUpdater.on('update-available', (info) => sendAppUpdateStatus({ state: 'available', info }));
        autoUpdater.on('update-not-available', (info) => sendAppUpdateStatus({ state: 'none', info }));
        autoUpdater.on('error', (err) => sendAppUpdateStatus({ state: 'error', error: String(err) }));
        autoUpdater.on('download-progress', (p) =>
          sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 })
        );
        autoUpdater.on('update-downloaded', (info) => sendAppUpdateStatus({ state: 'downloaded', info }));
      } catch (e) {
        sendAppUpdateStatus({ state: 'error', error: 'Updater init failed: ' + String(e) });
        return;
      }
    }

    // Try to find an app-update.yml; if missing, synthesize one for GitHub public repo
    const resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : '';
    const execDir = typeof process !== 'undefined' && process.execPath ? path.dirname(process.execPath) : '';
    const ymlPaths = [
      resourcesPath ? path.join(resourcesPath, 'app-update.yml') : '',
      execDir ? path.join(execDir, 'app-update.yml') : '',
    ].filter(Boolean);
    const hasYml = ymlPaths.some((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (!hasYml) {
      try {
        const tmpYml = path.join(os.tmpdir(), `showtrak-app-update-${process.pid}.yml`);
        const yml = [
          'provider: github',
          'owner: ShowTrak',
          'repo: ShowTrakServer',
          // no token for public repo; add one via env GH_TOKEN if rate-limited
        ].join('\n');
        fs.writeFileSync(tmpYml, yml, 'utf8');
        autoUpdater.updateConfigPath = tmpYml;
      } catch (e) {
        // If writing config fails, fall back to simulated flow
        try {
          sendAppUpdateStatus({ state: 'checking' });
          setTimeout(() => sendAppUpdateStatus({ state: 'available', info: { version: 'SIM' } }), 600);
          let pct = 0;
          const timer = setInterval(() => {
            pct += 14;
            if (pct >= 100) {
              clearInterval(timer);
              sendAppUpdateStatus({ state: 'downloaded', info: { version: 'SIM' } });
            } else {
              sendAppUpdateStatus({ state: 'downloading', percent: pct });
            }
          }, 250);
        } catch {}
        return;
      }
    }

    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      sendAppUpdateStatus({ state: 'error', error: String(e) });
    }
  });
  RPC.handle('AppUpdate:Install', async () => {
    // Dev/unpacked: simulate install
    if (!app.isPackaged) {
      try {
        sendAppUpdateStatus({ state: 'installing' });
        setTimeout(() => sendAppUpdateStatus({ state: 'installed' }), 600);
      } catch (e) {
        sendAppUpdateStatus({ state: 'error', error: String(e) });
      }
      return;
    }

    // Packaged on Windows via Squirrel: call built-in updater
    if (isSquirrelWindows()) {
      try {
        sendAppUpdateStatus({ state: 'installing' });
        SquirrelUpdater.quitAndInstall();
      } catch (e) {
        sendAppUpdateStatus({ state: 'error', error: String(e) });
      }
      return;
    }

    // Packaged: if updater config/path is set (real updates), perform real install; else simulate
    const hasConfig = Boolean(autoUpdater && (autoUpdater.updateConfigPath || autoUpdater.provider));
    if (!hasConfig) {
      try {
        sendAppUpdateStatus({ state: 'installing' });
        setTimeout(() => sendAppUpdateStatus({ state: 'installed' }), 600);
      } catch (e) {
        sendAppUpdateStatus({ state: 'error', error: String(e) });
      }
      return;
    }
    if (!autoUpdater) {
      sendAppUpdateStatus({ state: 'error', error: 'Updater not available' });
      return;
    }
    try {
      await autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      sendAppUpdateStatus({ state: 'error', error: String(e) });
    }
  });
  // Initialize electron-updater lazily for manual control
  try {
    const { autoUpdater: updater } = require('electron-updater');
    autoUpdater = updater;
    autoUpdater.autoDownload = true; // download when found
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => sendAppUpdateStatus({ state: 'available', info }));
    autoUpdater.on('update-not-available', (info) => sendAppUpdateStatus({ state: 'none', info }));
    autoUpdater.on('error', (err) => sendAppUpdateStatus({ state: 'error', error: String(err) }));
    autoUpdater.on('download-progress', (p) =>
      sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 })
    );
    autoUpdater.on('update-downloaded', (info) => sendAppUpdateStatus({ state: 'downloaded', info }));
  } catch (e) {
    Logger.error('electron-updater initialization failed:', e);
  }

  RPC.handle('Config:Get', async () => {
    return Config;
  });

  // Application Mode IPC
  RPC.handle('Mode:Get', async () => {
    return ModeManager.Get();
  });

  RPC.handle('Mode:Set', async (_event, NewMode) => {
    const Updated = ModeManager.Set(NewMode);
    return Updated;
  });

  RPC.handle('Settings:Get', async () => {
    let Settings = await SettingsManager.GetAll();
    return Settings;
  });

  RPC.handle('GetClient', async (_Event, UUID) => {
    let [Err, Client] = await ClientManager.Get(UUID);
    if (Err) return null;
    if (!Client) return null;
    return Client;
  });

  RPC.handle('CheckForUpdatesOnClient', async (_Event, UUID) => {
    Logger.warn('CheckForUpdatesOnClient called for UUID:', UUID);
    await ServerManager.ExecuteBulkRequest('UpdateSoftware', [UUID], 'Check For Software Updates');
    return;
  });

  RPC.handle('GetAllGroups', async (_Event) => {
    let [Err, Groups] = await GroupManager.GetAll();
    if (Err) return [];
    if (!Groups) return [];
    return Groups;
  });

  RPC.handle('CreateGroup', async (_Event, Title) => {
    await GroupManager.Create(Title);
    return true;
  });

  RPC.handle('DeleteGroup', async (_Event, GroupID) => {
    await GroupManager.Delete(GroupID);
    return true;
  });

  RPC.handle('UpdateClient', async (_Event, UUID, Data) => {
    await ClientManager.Update(UUID, Data);
    return;
  });

  RPC.handle('SetGroupOrder', async (_Event, GroupID, OrderedUUIDs) => {
    await ClientManager.SetGroupOrder(GroupID, OrderedUUIDs || []);
    return true;
  });

  RPC.handle('ExecuteScript', async (_Event, Scripts, Targets, ResetList) => {
    await ServerManager.ExecuteScripts(Scripts, Targets, ResetList);
    return;
  });

  RPC.handle('DeleteScripts', async (_Event, List) => {
    await ServerManager.ExecuteBulkRequest('DeleteScripts', List, 'Delete Scripts');
    return;
  });

  RPC.handle('UpdateScripts', async (_Event, List) => {
    await ServerManager.ExecuteBulkRequest('UpdateScripts', List, 'Update Scripts');
    return;
  });

  RPC.handle('WakeOnLan', async (_Event, List) => {
    await ScriptExecutionManager.ClearQueue();
    const tasks = List.map(async (UUID) => {
      const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, 'Wake On LAN');
      const [ClientErr, Client] = await ClientManager.Get(UUID);
      if (ClientErr) {
        await ScriptExecutionManager.Complete(RequestID, ClientErr);
        return;
      }
      if (!Client) {
        await ScriptExecutionManager.Complete(RequestID, 'Client not found');
        return;
      }
      if (!Client.MacAddress) {
        await ScriptExecutionManager.Complete(
          RequestID,
          'Client does not have a valid MAC address in internal database.'
        );
        return;
      }
      if (Client.Online) {
        await ScriptExecutionManager.Complete(RequestID, 'Client is already online');
        return;
      }
      const [WOLErr, _Result] = await WOLManager.Wake(Client.MacAddress);
      await ScriptExecutionManager.Complete(RequestID, WOLErr);
    });
    await Promise.allSettled(tasks);
  });

  // Renderer signaled it (re)loaded: push the current authoritative state.
  RPC.handle('Loaded', async () => {
    Logger.log('Application Page Hot Reloaded');
    await UpdateSettings();
    await UpdateAdoptionList();
    await UpdateFullClientList();
    await UpdateScriptList();
    await UpdateOSCList();
    // Push current application mode to renderer on initial load
    if (MainWindow && !MainWindow.isDestroyed()) {
      MainWindow.webContents.send('ModeUpdated', ModeManager.Get());
    }
    return;
  });

  async function Shutdown() {
    Logger.log('Application shutdown requested');
    app.quit();
    process.exit(0);
    return;
  }

  RPC.handle('Shutdown', async () => {
    Shutdown();
  });

  RPC.handle('AdoptDevice', async (_event, UUID) => {
    if (!UUID) return false;
    Logger.log('Adopting device:', UUID);
    await ClientManager.Create(UUID);
    await AdoptionManager.SetState(UUID, 'Adopting');
    await ServerManager.SendMessageByGroup(UUID, 'Adopt');
    return;
  });

  RPC.handle('UnadoptClient', async (_event, UUID) => {
    if (!UUID) return false;
    Logger.log('Unadopting device:', UUID);
    await ServerManager.SendMessageByGroup(UUID, 'Unadopt');
    await ClientManager.Delete(UUID);
    await UpdateFullClientList();
    return;
  });

  RPC.handle('OpenLogsFolder', async (_event) => {
    let LogsPath = AppDataManager.GetLogsDirectory();
    Logger.log('Opening logs folder:', LogsPath);
    // Cross-platform and properly quoted
    await shell.openPath(LogsPath);
    return;
  });

  RPC.handle('OpenScriptsFolder', async (_event) => {
    let LogsPath = AppDataManager.GetScriptsDirectory();
    Logger.log('Opening scrippts folder:', LogsPath);
    // Cross-platform and properly quoted
    await shell.openPath(LogsPath);
    return;
  });

  RPC.handle('OpenDiscordInviteLinkInBrowser', async (_event, _URL) => {
    const url = 'https://discord.gg/DACmwsbSGW';
    await shell.openExternal(url);
    return;
  });

  RPC.handle('SetSetting', async (_event, Key, Value) => {
    let [Err, Setting] = await SettingsManager.Set(Key, Value);
    if (Err) return [Err, null];
    return [null, Setting];
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS: consider re-creating or showing a window when the dock icon is clicked.
    }
  });

  // MainWindow.webContents.openDevTools();
});

// Push the entire settings payload and group metadata to the renderer.
async function UpdateSettings() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let Settings = await SettingsManager.GetAll();
  let SettingGroups = await SettingsManager.GetGroups();
  MainWindow.webContents.send('UpdateSettings', Settings, SettingGroups);
}

BroadcastManager.on('SettingsUpdated', UpdateSettings);

// USB add/remove fan-out: provide contextual client + device to the UI.
async function USBDeviceAdded(Client, Device) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log(
    `USB Device Added to ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
  );
  MainWindow.webContents.send('USBDeviceAdded', Client, Device);
  return;
}

BroadcastManager.on('USBDeviceAdded', USBDeviceAdded);

async function USBDeviceRemoved(Client, Device) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log(
    `USB Device Removed from ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
  );
  MainWindow.webContents.send('USBDeviceRemoved', Client, Device);
  return;
}

BroadcastManager.on('USBDeviceRemoved', USBDeviceRemoved);

async function ReadoptDevice(UUID) {
  await ServerManager.SendMessageByGroup(UUID, 'Adopt');
}
BroadcastManager.on('ReadoptDevice', ReadoptDevice);

// Full re-hydration: clear caches, re-fetch, and send authoritative lists.
async function ReinitializeSystem() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log('Reinitializing system...');
  await ClientManager.ClearCache();
  await AdoptionManager.ClearAllDevicesPendingAdoption();
  let [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) return Logger.error('Failed to fetch full client list:', ClientsErr);
  let [GroupsErr, Groups] = await GroupManager.GetAll();
  if (GroupsErr) return Logger.error('Failed to fetch client groups:', GroupsErr);
  MainWindow.webContents.send('SetFullClientList', Clients, Groups);
}
BroadcastManager.on('ReinitializeSystem', ReinitializeSystem);

async function ClientUpdated(Client) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('ClientUpdated', Client);
}

BroadcastManager.on('ClientUpdated', ClientUpdated);

// OSC routes are read-only here; clone to avoid accidental mutation downstream.
async function UpdateOSCList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let Routes = OSC.GetRoutes();
  MainWindow.webContents.send('SetOSCList', JSON.parse(JSON.stringify(Routes)));
}

// Scripts are filesystem-driven; this pushes the current catalog to the UI.
async function UpdateScriptList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let ScriptList = await ScriptManager.GetScripts();
  MainWindow.webContents.send('SetScriptList', ScriptList);
}

// Clients + Groups form the primary topology data model used by the UI.
async function UpdateFullClientList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) return Logger.error('Failed to fetch full client list:', ClientsErr);
  let [GroupsErr, Groups] = await GroupManager.GetAll();
  if (GroupsErr) return Logger.error('Failed to fetch client groups:', GroupsErr);
  MainWindow.webContents.send('SetFullClientList', Clients, Groups);
}

BroadcastManager.on('GroupListChanged', UpdateFullClientList);
BroadcastManager.on('ClientListChanged', UpdateFullClientList);

// Pending adoption list is ephemeral; pull from manager and push to UI.
async function UpdateAdoptionList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let DevicesPendingAdoption = AdoptionManager.GetClientsPendingAdoption();
  MainWindow.webContents.send('SetDevicesPendingAdoption', DevicesPendingAdoption);
}

BroadcastManager.on('AdoptionListUpdated', UpdateAdoptionList);

// Execution queue status updates (progress, completion, errors).
async function UpdateScriptExecutions(Executions) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('UpdateScriptExecutions', Executions);
}

BroadcastManager.on('ScriptExecutionUpdated', UpdateScriptExecutions);

// Thin wrapper to surface system notifications in the renderer.
async function Notify(Message, Type = 'info', Duration = 5000) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('Notify', Message, Type, Duration);
}

BroadcastManager.on('Notify', Notify);

// UI-triggered audio feedback (short, non-blocking).
async function PlaySound(SoundName) {
  MainWindow.webContents.send('PlaySound', SoundName);
}
BroadcastManager.on('PlaySound', PlaySound);

// Batch an OSC-triggered action and let the renderer decide the UX.
async function HandleOSCBulkAction(Type, Targets, Args = null) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('OSCBulkAction', Type, Targets, Args);
}

BroadcastManager.on('OSCBulkAction', HandleOSCBulkAction);

BroadcastManager.on('Shutdown', async () => {
  app.quit();
});

// Relay application mode changes to renderer windows
ModeManager.on('ModeUpdated', (Mode) => {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('ModeUpdated', Mode);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

const { powerSaveBlocker } = require('electron');
// Feature toggles controlled by Settings: power-save blocker and auto-update.
async function StartOptionalFeatures() {
  let SYSTEM_PREVENT_DISPLAY_SLEEP = await SettingsManager.GetValue('SYSTEM_PREVENT_DISPLAY_SLEEP');
  if (SYSTEM_PREVENT_DISPLAY_SLEEP) {
    Logger.log('Prevent Display Sleep is enabled, starting powerSaveBlocker.');
    powerSaveBlocker.start('prevent-display-sleep');
  } else {
    Logger.log('Prevent Display Sleep is disabled in settings, not starting powerSaveBlocker.');
  }
}
StartOptionalFeatures();

// Final shutdown hook: place for flushing buffers/closing resources if needed.
app.on('will-quit', (_event) => {
  Logger.log('App is closing, performing cleanup...');
});
