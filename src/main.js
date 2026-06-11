// Electron main process entrypoint. Responsibilities:
// - Enforce single-instance behavior
// - Create and manage the Preloader and Main windows
// - Bridge IPC between renderer and back-end managers
// - Fan-out broadcast events to the UI (webContents.send guards everywhere)
const { app, BrowserWindow, ipcMain: RPC, Menu } = require('electron/main');
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

const { Config } = require('./Modules/Config');
const { Manager: ScriptManager } = require('./Modules/ScriptManager');
ScriptManager.GetScripts();
const { Manager: SampleScriptsManager } = require('./Modules/SampleScripts');
SampleScriptsManager.Initialize();
const { Manager: ServerManager } = require('./Modules/Server');
const { Manager: BonjourManager } = require('./Modules/Bonjour');
BonjourManager.Init();
const { Manager: AdoptionManager } = require('./Modules/AdoptionManager');
const { Manager: ClientManager } = require('./Modules/ClientManager');
const { Manager: GroupManager } = require('./Modules/GroupManager');
const { Manager: MonitoringTargetManager } = require('./Modules/MonitoringTargetManager');
const { Manager: UpdateManager } = require('./Modules/UpdateManager');
const { Manager: DBManager } = require('./Modules/DB');
const { Manager: MonitoringMethods } = require('./Modules/MonitoringMethods');
const { Manager: AlertsManager } = require('./Modules/AlertsManager');
const { Manager: NetworkDiscoveryManager } = require('./Modules/NetworkDiscovery');
const { Manager: FileSelectorManager } = require('./Modules/FileSelectorManager');
const { Manager: BackupManager } = require('./Modules/BackupManager');
const { Manager: ScriptExecutionManager } = require('./Modules/ScriptExecutionManager');
const { Manager: WOLManager } = require('./Modules/WOLManager');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: SettingsManager } = require('./Modules/SettingsManager');
const { Manager: IPCValidation } = require('./Modules/IPCValidation');
const { OSC } = require('./Modules/OSC');
const { Manager: ModeManager } = require('./Modules/ModeManager');
const { Wait } = require('./Modules/Utils');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const {
  recordMonitoringHistorySample,
  syncMonitoringHistoryStore,
  getMonitoringHistorySamples,
} = require('./main/monitoring-history');
const { Manager: AppUpdater } = require('./main/app-updater');

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

function sendShowFileUpdated(filePath) {
  try {
    if (MainWindow && !MainWindow.isDestroyed()) {
      MainWindow.webContents.send('ShowFileUpdated', filePath || null);
    }
  } catch {
    // Window may be mid-teardown; navbar update is non-critical.
  }
}

function getWindowIconPath() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(__dirname, 'images', iconName);
}

function validationErrorTuple(error, fallback = null) {
  const message = error && error.message ? error.message : String(error || 'Invalid request');
  return [message, fallback];
}

function runCommandForOpen(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, (error) => {
      if (error) {
        resolve(error.message || String(error));
        return;
      }
      resolve(null);
    });
  });
}

function normalizeRelativePathForCompare(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function getLocalPlatformKey() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

function parseArgumentString(value) {
  const input = String(value || '').trim();
  if (!input) return [];

  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      args.push(current);
      current = '';
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  if (escaping) current += '\\';
  pushCurrent();
  return args;
}

function normalizeVersionToken(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}

function resolveLocalScriptLauncher(scriptPath) {
  const extension = path.extname(scriptPath).toLowerCase();

  if (process.platform === 'win32') {
    switch (extension) {
      case '.bat':
      case '.cmd':
        return { command: 'cmd.exe', args: ['/c', scriptPath] };
      case '.ps1':
        return {
          command: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        };
      case '.exe':
        return { command: scriptPath, args: [] };
      default:
        return { command: 'cmd.exe', args: ['/c', scriptPath] };
    }
  }

  switch (extension) {
    case '.sh':
    case '.command':
      return { command: '/bin/sh', args: [scriptPath] };
    case '.bash':
    case '.zsh':
      return { command: '/bin/bash', args: [scriptPath] };
    case '.py':
      return { command: 'python3', args: [scriptPath] };
    case '.js':
      return { command: 'node', args: [scriptPath] };
    default:
      return { command: scriptPath, args: [] };
  }
}

function runLocalScriptFile(scriptPath, extraArgs = []) {
  return new Promise((resolve) => {
    const launcher = resolveLocalScriptLauncher(scriptPath);

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(scriptPath, 0o755);
      } catch (chmodError) {
        Logger.warn(`Unable to set executable bit on ${scriptPath}: ${chmodError.message}`);
      }
    }

    execFile(
      launcher.command,
      launcher.args.concat(extraArgs),
      {
        cwd: path.dirname(scriptPath),
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || '').trim() || error.message || 'Script execution failed';
          resolve(message);
          return;
        }
        Logger.success(`Local script completed: ${scriptPath}`);
        if ((stdout || '').trim()) {
          Logger.log(`Local script output: ${(stdout || '').trim()}`);
        }
        resolve(null);
      }
    );
  });
}

async function openFileWithWorkspaceEditor(filePath) {
  const selectedEditor = await SettingsManager.GetValue('SYSTEM_WORKSPACE_DEFAULT_EDITOR');
  const editorName = String(selectedEditor || 'System Default').trim();

  if (!editorName || editorName === 'System Default') {
    return shell.openPath(filePath);
  }

  if (editorName === 'Visual Studio Code') {
    if (process.platform === 'darwin') {
      const openErr = await runCommandForOpen('open', ['-a', 'Visual Studio Code', filePath]);
      if (!openErr) return '';
      Logger.warn('Open in Visual Studio Code failed, falling back to system default:', openErr);
      return shell.openPath(filePath);
    }
    if (process.platform === 'win32') {
      const openErr = await runCommandForOpen('cmd', ['/c', 'code', '-g', filePath]);
      if (!openErr) return '';
      Logger.warn('Open in Visual Studio Code failed, falling back to system default:', openErr);
      return shell.openPath(filePath);
    }
    const openErr = await runCommandForOpen('code', ['-g', filePath]);
    if (!openErr) return '';
    Logger.warn('Open in Visual Studio Code failed, falling back to system default:', openErr);
    return shell.openPath(filePath);
  }

  return shell.openPath(filePath);
}

function applyWindowSecurityGuards(windowInstance) {
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

// Main UI window. Always check isDestroyed() before using.
var MainWindow = null;
let mainWindowCloseApproved = false;
let closePromptInFlight = false;
let quitRequested = false;
let accidentalShutdownProtectionEnabled = false;
let bypassShutdownConfirmation = false;
let shutdownCleanupInFlight = false;
let shutdownCleanupComplete = false;
let quittingForUpdate = false;

function hasMainWindow() {
  return MainWindow && !MainWindow.isDestroyed();
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

  const parentWindow = hasMainWindow() ? MainWindow : null;
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

  if (!hasNeverBeenSaved && !hasUnsavedChanges) {
    return true;
  }

  const { response } = await dialog.showMessageBox(MainWindow, {
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

// Note: Hiding the app menu disables common shortcuts on macOS. If you ship on macOS,
// prefer to keep a minimal menu there and only remove on Windows/Linux.
// Example: if (app.isPackaged && process.platform !== 'darwin') Menu.setApplicationMenu(null);
if (app.isPackaged && process.platform !== 'darwin') Menu.setApplicationMenu(null);
let PreloaderWindow = null;
const ONLINE_DEPLOY_COOLDOWN_MS = 10000;
const LastOnlineStateByUUID = new Map();
const LastOnlineDeployAtByUUID = new Map();
let ScriptChangeDeployTimer = null;
const ActiveScriptDeployment = {
  inFlight: false,
  serverFingerprint: '',
  targets: new Set(),
  queuedServerFingerprint: '',
  queuedTargets: new Set(),
};

function normalizeDeploymentTargets(TargetUUIDs) {
  if (!Array.isArray(TargetUUIDs)) return [];
  return [...new Set(TargetUUIDs.filter((UUID) => typeof UUID === 'string' && UUID.trim()))];
}

async function GetAllAdoptedClientUUIDs() {
  const [Err, Clients] = await ClientManager.GetAll();
  if (Err || !Array.isArray(Clients)) return [];
  return normalizeDeploymentTargets(Clients.map((Client) => Client.UUID));
}

async function MarkDeploymentFailedForTargets(Targets, ErrorMessage) {
  await ScriptExecutionManager.ClearQueue();
  for (const UUID of Targets) {
    const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, 'Deploying Scripts');
    if (!RequestID) continue;
    await ScriptExecutionManager.Complete(RequestID, ErrorMessage);
  }
}

async function ResolveOutOfDateDeploymentTargets(TargetUUIDs) {
  const ServerFingerprint = await ScriptManager.GetDeploymentFingerprint();
  const OnlineOutOfDateTargets = [];
  const OfflineOutOfDateTargets = [];
  const UpToDateTargets = [];

  for (const UUID of TargetUUIDs) {
    const [ClientErr, Client] = await ClientManager.Get(UUID);
    if (ClientErr || !Client) continue;

    const ClientFingerprint =
      typeof Client.ScriptsFingerprint === 'string' ? Client.ScriptsFingerprint.trim() : '';
    const IsOutOfDate = !ClientFingerprint || ClientFingerprint !== ServerFingerprint;

    if (!IsOutOfDate) {
      UpToDateTargets.push(UUID);
      continue;
    }

    if (!Client.Online) {
      OfflineOutOfDateTargets.push(UUID);
      continue;
    }

    OnlineOutOfDateTargets.push(UUID);
  }

  return {
    serverFingerprint: ServerFingerprint,
    onlineOutOfDateTargets: OnlineOutOfDateTargets,
    offlineOutOfDateTargets: OfflineOutOfDateTargets,
    upToDateTargets: UpToDateTargets,
  };
}

async function TriggerScriptDeployment(TargetUUIDs, Reason = 'manual') {
  const Targets = normalizeDeploymentTargets(TargetUUIDs);
  if (Targets.length === 0) return;

  const DeploymentTargetInfo = await ResolveOutOfDateDeploymentTargets(Targets);
  const DeployTargets = DeploymentTargetInfo.onlineOutOfDateTargets;
  if (DeployTargets.length === 0) {
    Logger.log('Skipping script deployment; no out-of-date online clients', {
      reason: Reason,
      requestedTargets: Targets.length,
      upToDateTargets: DeploymentTargetInfo.upToDateTargets.length,
      offlineOutOfDateTargets: DeploymentTargetInfo.offlineOutOfDateTargets.length,
    });
    return;
  }

  const Scripts = (await ScriptManager.GetScripts()) || [];
  const InvalidScripts = Scripts.filter((Script) => !Script || Script.isValid === false);

  if (InvalidScripts.length > 0) {
    const InvalidIDs = InvalidScripts.map((Script) => {
      const ID = Script && Script.ID ? Script.ID : 'Unknown Script';
      const ParseError = Script && Script.ParseError ? String(Script.ParseError) : '';
      return ParseError ? `${ID} (${ParseError})` : ID;
    });
    const ReasonMessage = `Invalid command JSON (Script.json): ${InvalidIDs.join(', ')}`;
    Logger.warn('Skipping script deployment due to invalid Script.json', {
      reason: Reason,
      targets: DeployTargets.length,
      invalidScripts: InvalidIDs,
    });
    await MarkDeploymentFailedForTargets(DeployTargets, ReasonMessage);
    return;
  }

  Logger.log('Triggering script deployment', {
    reason: Reason,
    targets: DeployTargets.length,
    requestedTargets: Targets.length,
    upToDateTargets: DeploymentTargetInfo.upToDateTargets.length,
    offlineOutOfDateTargets: DeploymentTargetInfo.offlineOutOfDateTargets.length,
    serverFingerprint: DeploymentTargetInfo.serverFingerprint,
  });

  const IsSameDeploymentSession =
    ActiveScriptDeployment.inFlight &&
    ActiveScriptDeployment.serverFingerprint === DeploymentTargetInfo.serverFingerprint;

  if (IsSameDeploymentSession) {
    const AdditionalTargets = DeployTargets.filter((UUID) => !ActiveScriptDeployment.targets.has(UUID));
    if (AdditionalTargets.length === 0) {
      Logger.log('Skipping duplicate in-flight deployment dispatch', {
        reason: Reason,
        targets: DeployTargets.length,
        serverFingerprint: DeploymentTargetInfo.serverFingerprint,
      });
      return;
    }
    await ServerManager.ExecuteBulkRequest('UpdateScripts', AdditionalTargets, 'Deploying Scripts', {
      resetQueue: false,
    });
    AdditionalTargets.forEach((UUID) => ActiveScriptDeployment.targets.add(UUID));
    return;
  }

  if (ActiveScriptDeployment.inFlight) {
    DeployTargets.forEach((UUID) => ActiveScriptDeployment.queuedTargets.add(UUID));
    ActiveScriptDeployment.queuedServerFingerprint = DeploymentTargetInfo.serverFingerprint;
    Logger.log('Queued deployment while another deployment is active', {
      reason: Reason,
      queuedTargets: ActiveScriptDeployment.queuedTargets.size,
      queuedServerFingerprint: ActiveScriptDeployment.queuedServerFingerprint,
      activeServerFingerprint: ActiveScriptDeployment.serverFingerprint,
    });
    return;
  }

  ActiveScriptDeployment.inFlight = true;
  ActiveScriptDeployment.serverFingerprint = DeploymentTargetInfo.serverFingerprint;
  ActiveScriptDeployment.targets = new Set(DeployTargets);

  await ServerManager.ExecuteBulkRequest('UpdateScripts', DeployTargets, 'Deploying Scripts', {
    resetQueue: true,
  });
}

function ScheduleScriptChangeDeployment() {
  if (ScriptChangeDeployTimer) clearTimeout(ScriptChangeDeployTimer);
  ScriptChangeDeployTimer = setTimeout(async () => {
    ScriptChangeDeployTimer = null;
    const Targets = await GetAllAdoptedClientUUIDs();
    await TriggerScriptDeployment(Targets, 'scripts-changed');
  }, 450);
}
app.whenReady().then(async () => {
  if (require('electron-squirrel-startup')) return app.quit();

  if (MainWindow) {
    MainWindow.close();
    MainWindow = null;
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
  MainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 1515,
    height: 940,
    minWidth: 815,
    minHeight: 600,
    webPreferences: {
      ...BASE_WEB_PREFERENCES,
      preload: path.join(__dirname, 'bridge_main.js'),
      devTools: !app.isPackaged,
    },
    icon: getWindowIconPath(),
    ...WINDOW_CHROME_OPTIONS,
  });

  MainWindow.loadFile(path.join(__dirname, 'UI', 'index.html')).then(async () => {
    Logger.log('MainWindow finished loading UI');
    // Initial payloads to hydrate renderer stores
    UpdateAdoptionList();
    // Boot monitoring loops once the DB schema is ready
    MonitoringTargetManager.Init().catch((Err) =>
      Logger.error('Failed to init MonitoringTargetManager:', Err)
    );
    AlertsManager.Init().catch((Err) => Logger.error('Failed to init AlertsManager:', Err));
    await Wait(800);
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
    MainWindow = null;
  });

  // ShowTrak file save/open IPC. Returns [err, result] tuples consistently.
  RPC.handle('Show:Save', async () => {
    let CurrentPath = BackupManager.GetCurrentFilePath();
    if (!CurrentPath) {
      // No file opened or saved yet this session — fall back to Save As.
      let { canceled, filePath } = await FileSelectorManager.SaveDialog('Save ShowTrak File As');
      if (canceled || !filePath) {
        Logger.log('Show:Save canceled');
        return ['Cancelled By User', null];
      }
      CurrentPath = filePath;
    }
    Logger.log('Saving ShowTrak file to:', CurrentPath);
    let [Err, Result] = await BackupManager.Save(CurrentPath);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    return [null, Result];
  });

  RPC.handle('Show:SaveAs', async () => {
    let { canceled, filePath } = await FileSelectorManager.SaveDialog('Save ShowTrak File As');
    if (canceled || !filePath) {
      Logger.log('Show:SaveAs canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Saving ShowTrak file to:', filePath);
    let [Err, Result] = await BackupManager.Save(filePath);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    return [null, Result];
  });

  RPC.handle('Show:Open', async () => {
    let { canceled, filePaths } = await FileSelectorManager.OpenDialog('Open ShowTrak File');
    if (canceled || !filePaths || filePaths.length === 0) {
      Logger.log('Show:Open canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Opening ShowTrak file from:', filePaths[0]);
    let [Err, Result] = await BackupManager.Open(filePaths[0]);
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    return [null, Result];
  });

  RPC.handle('Show:GetCurrentFile', async () => {
    return BackupManager.GetCurrentFilePath();
  });

  RPC.handle('Show:HasUnsavedData', async () => {
    return await BackupManager.HasUnsavedWorkingData();
  });

  RPC.handle('Show:EnsureFileExists', async () => {
    let [Err, Result] = await BackupManager.EnsureCurrentFileExists();
    if (Err) return [Err, null];
    if (Result && Result.Missing) sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    return [null, Result];
  });

  RPC.handle('Show:New', async () => {
    Logger.log('Creating new ShowTrak show');
    let [Err, Result] = await BackupManager.New();
    if (Err) return [Err, null];
    sendShowFileUpdated(BackupManager.GetCurrentFilePath());
    return [null, Result];
  });
  // App self-update flows (dev simulation, Squirrel, electron-updater) are
  // encapsulated in the AppUpdater module. It registers the AppUpdate:* IPC
  // handlers and performs the eager electron-updater init.
  AppUpdater.Register(RPC, { getMainWindow: () => MainWindow });

  RPC.handle('Config:Get', async () => {
    return Config;
  });

  // Provide a list of Web UI addresses on the local network with port
  RPC.handle('WebUI:GetAddresses', async () => {
    try {
      const port =
        Config && Config.Application && Config.Application.Port ? Config.Application.Port : 3000;
      const hostname = os.hostname();
      const net = os.networkInterfaces() || {};
      const hosts = new Set();
      const push = (h) => {
        if (!h) return;
        try {
          h = String(h).trim();
        } catch {}
        if (!h) return;
        hosts.add(h);
      };
      push('localhost');
      push('127.0.0.1');
      push(hostname);
      for (const key of Object.keys(net)) {
        const list = net[key] || [];
        for (const addr of list) {
          if (!addr) continue;
          const family =
            addr.family || (addr.address && addr.address.includes(':')) ? 'IPv6' : 'IPv4';
          if (family !== 'IPv4') continue;
          if (addr.internal) continue;
          push(addr.address);
        }
      }
      const urls = Array.from(hosts).map((host) => ({ host, url: `http://${host}:${port}/` }));
      return { port, hostname, urls };
    } catch (e) {
      return {
        port: 3000,
        hostname: os.hostname(),
        urls: [{ host: 'localhost', url: 'http://localhost:3000/' }],
      };
    }
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
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch {
      return null;
    }
    let [Err, Client] = await ClientManager.Get(UUID);
    if (Err) return null;
    if (!Client) return null;
    return Client;
  });

  RPC.handle('CheckForUpdatesOnClient', async (_Event, UUID) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    Logger.warn('CheckForUpdatesOnClient called for UUID:', UUID);
    await ServerManager.ExecuteBulkRequest('UpdateSoftware', [UUID], 'Check For Software Updates');
    return [null, true];
  });

  RPC.handle('UpdateManager:GetStatus', async () => {
    try {
      const Status = await UpdateManager.GetStatus();
      return [null, Status];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });

  RPC.handle('UpdateManager:GetReleases', async () => {
    try {
      const Releases = await UpdateManager.ListReleases();
      return [null, Releases];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });

  RPC.handle('UpdateManager:DownloadRelease', async (_Event, Tag) => {
    try {
      const Release = await UpdateManager.DownloadRelease(Tag, {
        onProgress: (Progress) => {
          try {
            if (MainWindow && !MainWindow.isDestroyed()) {
              MainWindow.webContents.send('UpdateManager:DownloadProgress', Progress);
            }
          } catch {}
        },
      });

      return [null, Release];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });

  RPC.handle('UpdateManager:DeployRelease', async (_Event, Tag, Targets) => {
    try {
      const Status = await UpdateManager.GetStatus();
      if (!Status || !Status.Ready || !Status.ReleaseVersion) {
        return ['Download a release build before deploying', null];
      }

      const SelectedTag = String(Tag || '').trim();
      if (!SelectedTag) {
        return ['Select a release to deploy', null];
      }
      if (Status.ReleaseVersion !== SelectedTag) {
        return ['Selected release is not downloaded yet', null];
      }

      const RawTargets = Array.isArray(Targets) ? Targets : [];
      if (RawTargets.length === 0) {
        return ['Select at least one client for deployment', null];
      }

      let SelectedTargets = [];
      try {
        SelectedTargets = IPCValidation.UUIDList(RawTargets, 'Deployment targets');
      } catch (error) {
        return validationErrorTuple(error);
      }

      const [ClientsErr, Clients] = await ClientManager.GetAll();
      if (ClientsErr) return [ClientsErr, null];

      const AllClients = (Clients || []).filter((Client) => Client && Client.UUID);
      const SelectedSet = new Set(SelectedTargets);
      const SelectedClients = AllClients.filter((Client) => SelectedSet.has(Client.UUID));
      const SelectedVersionToken = normalizeVersionToken(SelectedTag);

      const EligibleClients = SelectedClients.filter((Client) => {
        if (!Client.Online) return false;
        const ClientVersionToken = normalizeVersionToken(Client.Version);
        return ClientVersionToken !== SelectedVersionToken;
      });

      const DeployTargets = EligibleClients.map((Client) => Client.UUID);
      if (DeployTargets.length === 0) {
        return ['No selected clients are eligible for deployment', null];
      }

      await ServerManager.ExecuteBulkRequest(
        'UpdateSoftwareFromLAN',
        DeployTargets,
        'Updating Client Software',
        {
          resetQueue: false,
          payload: {
            FeedPath: Status.FeedPath,
            ReleaseVersion: SelectedTag,
          },
        }
      );

      return [
        null,
        {
          ReleaseVersion: SelectedTag,
          TargetCount: DeployTargets.length,
          SelectedCount: SelectedTargets.length,
          TotalClientCount: AllClients.length,
          FeedPath: Status.FeedPath,
        },
      ];
    } catch (error) {
      return validationErrorTuple(error);
    }
  });

  RPC.handle('GetAllGroups', async (_Event) => {
    let [Err, Groups] = await GroupManager.GetAll();
    if (Err) return [];
    if (!Groups) return [];
    return Groups;
  });

  RPC.handle('CreateGroup', async (_Event, Title) => {
    try {
      Title = IPCValidation.GroupTitle(Title);
    } catch (error) {
      return validationErrorTuple(error);
    }
    let [Err, Result] = await GroupManager.Create(Title);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('DeleteGroup', async (_Event, GroupID) => {
    try {
      GroupID = IPCValidation.GroupID(GroupID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    let [Err, Result] = await GroupManager.Delete(GroupID);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('UpdateClient', async (_Event, UUID, Data) => {
    try {
      UUID = IPCValidation.UUID(UUID);
      Data = IPCValidation.ClientUpdatePayload(Data);
    } catch (error) {
      return validationErrorTuple(error);
    }
    let [Err, Result] = await ClientManager.Update(UUID, Data);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('MarkClientUSBDeviceCritical', async (_Event, UUID, Device) => {
    try {
      UUID = IPCValidation.UUID(UUID);
      Device = IPCValidation.CriticalUSBDevicePayload(Device);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await ClientManager.MarkUSBDeviceCritical(UUID, Device);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('RemoveClientUSBDeviceCritical', async (_Event, UUID, SerialNumber) => {
    try {
      UUID = IPCValidation.UUID(UUID);
      SerialNumber = IPCValidation.USBSerialNumber(SerialNumber);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await ClientManager.RemoveUSBDeviceCritical(UUID, SerialNumber);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('MarkClientApplicationCritical', async (_Event, UUID, Application) => {
    try {
      UUID = IPCValidation.UUID(UUID);
      Application = IPCValidation.CriticalApplicationPayload(Application);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await ClientManager.MarkApplicationCritical(UUID, Application);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('RemoveClientApplicationCritical', async (_Event, UUID, ApplicationName) => {
    try {
      UUID = IPCValidation.UUID(UUID);
      ApplicationName = IPCValidation.CriticalApplicationPayload({ Name: ApplicationName }).Name;
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await ClientManager.RemoveApplicationCritical(UUID, ApplicationName);
    if (Err) return [Err, null];
    return [null, Result];
  });

  // ---- Monitoring Targets ----
  RPC.handle('GetMonitoringMethods', async () => {
    return MonitoringMethods.GetAll();
  });

  RPC.handle('GetAllMonitoringTargets', async () => {
    const [Err, List] = await MonitoringTargetManager.GetAll();
    if (Err) return [];
    return List || [];
  });

  RPC.handle('GetMonitoringTarget', async (_Event, TargetID) => {
    try {
      TargetID = IPCValidation.MonitoringTargetID(TargetID);
    } catch {
      return null;
    }
    const [Err, Target] = await MonitoringTargetManager.Get(TargetID);
    if (Err) return null;
    return Target;
  });

  RPC.handle('GetMonitoringTargetHistory', async (_Event, TargetID) => {
    try {
      TargetID = IPCValidation.MonitoringTargetID(TargetID);
    } catch {
      return [];
    }
    return getMonitoringHistorySamples(TargetID);
  });

  RPC.handle('CreateMonitoringTarget', async (_Event, Payload) => {
    try {
      Payload = IPCValidation.MonitoringTargetCreatePayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await MonitoringTargetManager.Create(Payload);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('UpdateMonitoringTarget', async (_Event, TargetID, Payload) => {
    try {
      TargetID = IPCValidation.MonitoringTargetID(TargetID);
      Payload = IPCValidation.MonitoringTargetUpdatePayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await MonitoringTargetManager.Update(TargetID, Payload);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('DeleteMonitoringTarget', async (_Event, TargetID) => {
    try {
      TargetID = IPCValidation.MonitoringTargetID(TargetID);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = await MonitoringTargetManager.Delete(TargetID);
    if (Err) return [Err, null];
    return [null, Result];
  });

  // ---- Alert Rules ----
  RPC.handle('GetAlertTriggers', async () => {
    return AlertsManager.GetTriggers();
  });

  RPC.handle('GetAlertActionTypes', async () => {
    return AlertsManager.GetActionTypes();
  });

  RPC.handle('GetAllAlertRules', async () => {
    const [Err, Rules] = await AlertsManager.GetAll();
    if (Err) return [];
    return Rules || [];
  });

  RPC.handle('GetAlertRule', async (_Event, RuleID) => {
    try {
      RuleID = IPCValidation.AlertRuleID(RuleID);
    } catch {
      return null;
    }
    const [Err, Rule] = await AlertsManager.Get(RuleID);
    if (Err) return null;
    return Rule;
  });

  RPC.handle('CreateAlertRule', async (_Event, Payload) => {
    try {
      Payload = IPCValidation.AlertRuleCreatePayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Rule] = await AlertsManager.Create(Payload);
    if (Err) return [Err, null];
    return [null, Rule];
  });

  RPC.handle('UpdateAlertRule', async (_Event, RuleID, Payload) => {
    try {
      RuleID = IPCValidation.AlertRuleID(RuleID);
      Payload = IPCValidation.AlertRuleUpdatePayload(Payload);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Rule] = await AlertsManager.Update(RuleID, Payload);
    if (Err) return [Err, null];
    return [null, Rule];
  });

  RPC.handle('DeleteAlertRule', async (_Event, RuleID) => {
    try {
      RuleID = IPCValidation.AlertRuleID(RuleID);
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    const [Err, Result] = await AlertsManager.Delete(RuleID);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('SetAlertRuleEnabled', async (_Event, RuleID, Enabled) => {
    try {
      RuleID = IPCValidation.AlertRuleID(RuleID);
      Enabled = !!Enabled;
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Rule] = await AlertsManager.SetEnabled(RuleID, Enabled);
    if (Err) return [Err, null];
    return [null, Rule];
  });

  RPC.handle('AlertActionsEnabled:Get', async () => {
    return AlertsManager.GetActionsEnabled();
  });

  RPC.handle('AlertActionsEnabled:Set', async (_Event, Enabled) => {
    return AlertsManager.SetActionsEnabled(!!Enabled);
  });

  RPC.handle('NetworkDiscovery:Start', async (_Event, Options) => {
    try {
      Options = IPCValidation.NetworkDiscoveryScanOptions(Options);
    } catch (error) {
      return validationErrorTuple(error);
    }
    const [Err, Result] = NetworkDiscoveryManager.Start(Options, (Payload) => {
      if (!MainWindow || MainWindow.isDestroyed()) return;
      MainWindow.webContents.send('NetworkDeviceScanEvent', Payload);
    });
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('NetworkDiscovery:Stop', async (_Event, ScanID) => {
    try {
      ScanID = IPCValidation.NetworkDiscoveryScanID(ScanID);
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    const [Err, Result] = NetworkDiscoveryManager.Stop(ScanID);
    if (Err) return [Err, null];
    return [null, Result];
  });

  RPC.handle('SetGroupOrder', async (_Event, GroupID, OrderedUUIDs) => {
    try {
      GroupID = IPCValidation.GroupID(GroupID);
      OrderedUUIDs = IPCValidation.UUIDList(OrderedUUIDs || [], 'Ordered UUIDs');
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    // Mixed list: client UUIDs and "monitor:<TargetID>" entries.
    // Walk in order assigning a single shared weight counter so visual order
    // is preserved across both entity types when rendered together.
    let Weight = 10;
    const ClientOrder = [];
    const MonitorAssignments = [];
    for (const ID of OrderedUUIDs) {
      if (typeof ID === 'string' && ID.startsWith('monitor:')) {
        const TargetID = parseInt(ID.slice('monitor:'.length), 10);
        if (Number.isFinite(TargetID)) {
          MonitorAssignments.push({ TargetID, Weight });
        }
      } else {
        ClientOrder.push({ UUID: ID, Weight });
      }
      Weight += 10;
    }
    // Apply monitor moves first (they don't emit per-change broadcasts here).
    for (const { TargetID, Weight: W } of MonitorAssignments) {
      await MonitoringTargetManager.SetGroupAndWeight(TargetID, GroupID, W);
    }
    // Apply client ordering. ClientManager.SetGroupOrder reassigns weights
    // sequentially starting at 10, so feed it just the UUIDs in order — but
    // we want the shared weight scale, so apply directly per-client instead.
    if (ClientOrder.length) {
      await ClientManager.SetGroupOrderWithWeights(
        GroupID,
        ClientOrder.map((c) => c.UUID),
        ClientOrder.map((c) => c.Weight)
      );
    }
    if (MonitorAssignments.length) {
      // Single coalesced refresh for monitors after batch.
      BroadcastManager.emit('MonitoringTargetListChanged');
    }
    return true;
  });

  RPC.handle('ExecuteScript', async (_Event, Scripts, Targets, ResetList) => {
    try {
      Scripts = IPCValidation.ScriptID(Scripts);
      Targets = IPCValidation.UUIDList(Targets || [], 'Targets');
      ResetList = IPCValidation.Boolean(ResetList, 'ResetList');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await ServerManager.ExecuteScripts(Scripts, Targets, ResetList);
    return [null, true];
  });

  RPC.handle('DeleteScripts', async (_Event, List) => {
    await ServerManager.ExecuteBulkRequest('DeleteScripts', List, 'Delete Scripts');
    return;
  });

  RPC.handle('UpdateScripts', async (_Event, List) => {
    try {
      List = IPCValidation.UUIDList(List || [], 'Targets');
    } catch (error) {
      return validationErrorTuple(error);
    }
    await TriggerScriptDeployment(List, 'manual-request');
    return [null, true];
  });

  // Script Manager: return the catalog (including invalid scripts) for editing.
  RPC.handle('Scripts:GetManagerList', async () => {
    const Scripts = (await ScriptManager.GetScripts()) || [];
    return Scripts.map((s) => ({
      id: s.ID,
      name: s.Name,
      description: s.Description || '',
      colour: typeof s.Colour === 'number' ? s.Colour : 6,
      weight: s.Weight || 0,
      confirm: !!s.Confirmation,
      enabled: !!s.isEnabled,
      valid: !!s.isValid,
      parseError: s.ParseError || null,
      platforms: s.Platforms || {},
      compatiblePlatforms: s.CompatiblePlatforms || [],
      issues: s.ValidationErrors || [],
    }));
  });

  // Script Manager: read the editable fields + folder file list for one script.
  RPC.handle('Scripts:GetConfig', async (_Event, ID) => {
    const [data, err] = await ScriptManager.GetEditable(ID);
    if (err) return [err, null];
    return [null, data];
  });

  // Script Manager: validate, normalize and persist structured field edits
  // (optionally renaming the script folder/ID).
  RPC.handle('Scripts:SaveConfig', async (_Event, ID, Fields) => {
    if (!Fields || typeof Fields !== 'object') return ['Invalid script fields', null];
    const Result = await ScriptManager.SaveFields(ID, Fields);
    if (!Result.ok) {
      return [Result.errors && Result.errors[0] ? Result.errors[0] : 'Invalid', Result];
    }
    return [null, Result];
  });

  // Script Manager: persist a new display order (drag-and-drop reordering).
  RPC.handle('Scripts:SetOrder', async (_Event, OrderedIDs) => {
    if (!Array.isArray(OrderedIDs)) return ['Invalid order', null];
    const Result = await ScriptManager.SetOrder(OrderedIDs);
    if (!Result.ok) {
      return [Result.errors && Result.errors[0] ? Result.errors[0] : 'Invalid', Result];
    }
    return [null, Result];
  });

  // Script Manager: delete a script folder from disk.
  RPC.handle('Scripts:Delete', async (_Event, ID) => {
    if (typeof ID !== 'string') return ['Invalid script ID', null];
    const Result = await ScriptManager.Delete(ID);
    if (!Result.ok) return [Result.error || 'Failed to delete script', null];
    return [null, true];
  });

  // Script Manager: create a new blank script (placeholder config + empty
  // per-platform script files, not yet runnable). Returns the new script ID.
  RPC.handle('Scripts:Create', async () => {
    const Result = await ScriptManager.CreateBlank();
    if (!Result.ok) return [Result.error || 'Failed to create script', null];
    return [null, { id: Result.id }];
  });

  // Script Manager: list the available sample scripts (templates) fetched from
  // the public ShowTrak SampleScripts repository.
  RPC.handle('Scripts:GetSampleList', async () => {
    try {
      const List = await SampleScriptsManager.GetSampleList();
      return [null, List];
    } catch (err) {
      Logger.error('Failed to list sample scripts:', err);
      return ['Failed to load sample scripts', null];
    }
  });

  // Script Manager: force a refresh of the sample scripts catalog.
  RPC.handle('Scripts:RefreshSamples', async () => {
    const Result = await SampleScriptsManager.Refresh();
    if (!Result.ok) return [Result.error || 'Failed to refresh sample scripts', null];
    const List = await SampleScriptsManager.GetSampleList();
    return [null, List];
  });

  // Script Manager: create a new script from a sample template. Requires a
  // DesiredID that does not collide with an existing script.
  RPC.handle('Scripts:CreateFromTemplate', async (_Event, SampleID, DesiredID) => {
    if (typeof SampleID !== 'string' || !SampleID.trim()) return ['Invalid template', null];
    const Sample = await SampleScriptsManager.GetSample(SampleID);
    if (!Sample) return ['Template not found', null];
    const Result = await ScriptManager.CreateFromTemplate(Sample, DesiredID);
    if (!Result.ok) {
      const Message = Result.errors && Result.errors[0] ? Result.errors[0] : 'Failed to create script';
      return [Message, Result];
    }
    return [null, Result];
  });

  RPC.handle('WakeOnLan', async (_Event, List) => {
    try {
      List = IPCValidation.UUIDList(List || [], 'WakeOnLan targets');
    } catch (error) {
      return validationErrorTuple(error);
    }
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
    return [null, true];
  });

  // Renderer signaled it (re)loaded: push the current authoritative state.
  RPC.handle('Loaded', async () => {
    Logger.log('Application Page Hot Reloaded');
    await UpdateSettings();
    await UpdateAdoptionList();
    await UpdateFullClientList();
    await UpdateScriptList();
    await UpdateOSCList();
    await UpdateMonitoringTargetList();
    await UpdateAlertRuleList();
    // Push current application mode to renderer on initial load
    if (MainWindow && !MainWindow.isDestroyed()) {
      MainWindow.webContents.send('ModeUpdated', ModeManager.Get());
    }
    return;
  });

  async function Shutdown({ bypassAccidentalConfirmation = true } = {}) {
    Logger.log('Application shutdown requested');
    bypassShutdownConfirmation = bypassAccidentalConfirmation;
    quitRequested = true;
    app.quit();
    return;
  }

  RPC.handle('Shutdown', async (_event, Confirmed = false) => {
    const shouldRequestRendererConfirmation =
      !Confirmed &&
      accidentalShutdownProtectionEnabled &&
      ModeManager.Get() === 'SHOW' &&
      hasMainWindow();

    if (shouldRequestRendererConfirmation) {
      MainWindow.webContents.send('ShutdownRequested');
      return;
    }

    Shutdown({ bypassAccidentalConfirmation: true });
  });

  RPC.handle('AdoptDevice', async (_event, UUID) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    Logger.log('Adopting device:', UUID);
    let [CreateErr, _CreateResult] = await ClientManager.Create(UUID);
    if (CreateErr && CreateErr !== 'Client already exists') return [CreateErr, null];
    await AdoptionManager.SetState(UUID, 'Adopting');
    await ServerManager.SendMessageByGroup(UUID, 'Adopt');
    await TriggerScriptDeployment([UUID], 'client-adopted');
    return [null, true];
  });

  RPC.handle('UnadoptClient', async (_event, UUID) => {
    try {
      UUID = IPCValidation.UUID(UUID);
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    Logger.log('Unadopting device:', UUID);
    await ServerManager.SendMessageByGroup(UUID, 'Unadopt');
    let [DeleteErr, _DeleteResult] = await ClientManager.Delete(UUID);
    if (DeleteErr) return [DeleteErr, null];
    await UpdateFullClientList();
    return [null, true];
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

  RPC.handle('Scripts:OpenFolder', async (_event, ID) => {
    if (typeof ID !== 'string' || !ID.trim()) return;
    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
    const ScriptFolderPath = require('path').join(ScriptsDirectory, ID);
    Logger.log('Opening script folder:', ScriptFolderPath);
    await shell.openPath(ScriptFolderPath);
  });

  RPC.handle('Scripts:OpenFile', async (_event, ID, RelativeFilePath) => {
    if (typeof ID !== 'string' || !ID.trim()) return ['Invalid script ID', null];
    if (typeof RelativeFilePath !== 'string' || !RelativeFilePath.trim()) {
      return ['Invalid file path', null];
    }
    if (ID.includes('..') || ID.includes('/') || ID.includes('\\')) {
      return ['Invalid script ID', null];
    }
    if (path.isAbsolute(RelativeFilePath)) return ['Invalid file path', null];

    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
    const ScriptFolderPath = path.resolve(ScriptsDirectory, ID);
    const TargetFilePath = path.resolve(ScriptFolderPath, RelativeFilePath);
    const ScriptFolderPrefix = ScriptFolderPath.endsWith(path.sep)
      ? ScriptFolderPath
      : `${ScriptFolderPath}${path.sep}`;
    if (TargetFilePath !== ScriptFolderPath && !TargetFilePath.startsWith(ScriptFolderPrefix)) {
      return ['Invalid file path', null];
    }

    if (!fs.existsSync(TargetFilePath)) return ['File not found', null];
    const stat = fs.statSync(TargetFilePath);
    if (!stat.isFile()) return ['Path is not a file', null];

    Logger.log('Opening script file:', TargetFilePath);
    const OpenErr = await openFileWithWorkspaceEditor(TargetFilePath);
    if (OpenErr) return [OpenErr, null];
    return [null, true];
  });

  RPC.handle('Scripts:RunLocalFile', async (_event, ID, RelativeFilePath) => {
    if (typeof ID !== 'string' || !ID.trim()) return ['Invalid script ID', null];
    if (typeof RelativeFilePath !== 'string' || !RelativeFilePath.trim()) {
      return ['Invalid file path', null];
    }
    if (ID.includes('..') || ID.includes('/') || ID.includes('\\')) {
      return ['Invalid script ID', null];
    }
    if (path.isAbsolute(RelativeFilePath)) return ['Invalid file path', null];

    const Script = await ScriptManager.Get(ID);
    if (!Script || !Script.Platforms) return ['Script not found', null];

    const PlatformKey = getLocalPlatformKey();
    const MappedFile = normalizeRelativePathForCompare(Script.Platforms[PlatformKey]);
    const PlatformArgumentString =
      Script && Script.Arguments && typeof Script.Arguments[PlatformKey] === 'string'
        ? Script.Arguments[PlatformKey]
        : '';
    const PlatformArgs = parseArgumentString(PlatformArgumentString);
    const RequestedFile = normalizeRelativePathForCompare(RelativeFilePath);
    if (!MappedFile) {
      return [`No ${PlatformKey} executable is configured for this script`, null];
    }
    if (RequestedFile !== MappedFile) {
      return [`Only the mapped ${PlatformKey} executable can be run locally`, null];
    }

    const ScriptsDirectory = AppDataManager.GetScriptsDirectory();
    const ScriptFolderPath = path.resolve(ScriptsDirectory, ID);
    const TargetFilePath = path.resolve(ScriptFolderPath, RelativeFilePath);
    const ScriptFolderPrefix = ScriptFolderPath.endsWith(path.sep)
      ? ScriptFolderPath
      : `${ScriptFolderPath}${path.sep}`;
    if (TargetFilePath !== ScriptFolderPath && !TargetFilePath.startsWith(ScriptFolderPrefix)) {
      return ['Invalid file path', null];
    }

    if (!fs.existsSync(TargetFilePath)) return ['File not found', null];
    const stat = fs.statSync(TargetFilePath);
    if (!stat.isFile()) return ['Path is not a file', null];

    Logger.log(`Running local script (${PlatformKey}):`, TargetFilePath);
    const RunErr = await runLocalScriptFile(TargetFilePath, PlatformArgs);
    if (RunErr) return [RunErr, null];
    return [null, true];
  });

  RPC.handle('OpenDiscordInviteLinkInBrowser', async (_event, _URL) => {
    const url = 'https://discord.gg/DACmwsbSGW';
    await shell.openExternal(url);
    return;
  });

  RPC.handle('OpenShowTrakWebsiteInBrowser', async (_event) => {
    const url = 'https://showtrak.co.uk';
    await shell.openExternal(url);
    return;
  });

  RPC.handle('OpenShowTrakGithubInBrowser', async (_event) => {
    const url = 'https://github.com/ShowTrak/ShowTrakServer';
    await shell.openExternal(url);
    return;
  });

  RPC.handle('OpenNpmPackageInBrowser', async (_event, PackageName) => {
    const Name = String(PackageName || '').trim();
    if (!Name) return;
    const url = `https://www.npmjs.com/package/${encodeURIComponent(Name)}`;
    await shell.openExternal(url);
    return;
  });

  RPC.handle('GetProjectDependencies', async (_event) => {
    try {
      const CandidatePaths = [
        path.join(app.getAppPath(), 'package.json'),
        path.resolve(app.getAppPath(), '..', 'package.json'),
      ];

      let PackageJsonPath = null;
      for (const CandidatePath of CandidatePaths) {
        if (fs.existsSync(CandidatePath)) {
          PackageJsonPath = CandidatePath;
          break;
        }
      }

      if (!PackageJsonPath) {
        return ['Could not locate package.json', null];
      }

      const PackageJsonRaw = fs.readFileSync(PackageJsonPath, 'utf8');
      const PackageJson = JSON.parse(PackageJsonRaw);

      const DefaultRuntimeDependencies = new Set(['electron-squirrel-startup']);

      const Dependencies = Object.entries(PackageJson.dependencies || {})
        .filter(([name]) => !DefaultRuntimeDependencies.has(name))
        .map(([name, version]) => ({ name, version }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return [
        null,
        {
          dependencies: Dependencies,
        },
      ];
    } catch (error) {
      Logger.error('GetProjectDependencies failed', error);
      return [String(error), null];
    }
  });

  RPC.handle('SetSetting', async (_event, Key, Value) => {
    try {
      [Key, Value] = IPCValidation.SettingUpdatePayload(Key, Value);
    } catch (error) {
      return validationErrorTuple(error);
    }
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

// Autosave: periodically snapshot the open ShowTrak file back to its path. The
// timer is rescheduled whenever the relevant settings change. A tick is a no-op
// when autosave is disabled or no file is currently open.
let AutosaveTimer = null;

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
ScheduleAutosave().catch((Err) => Logger.error('Failed to schedule autosave:', Err));

async function USBDeviceAdded(Client, Device) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log(
    `USB Device Added to ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
  );
  MainWindow.webContents.send('USBDeviceAdded', Client, Device);
  AlertsManager.HandleUSBDeviceConnected(Client, Device).catch((Err) =>
    Logger.error('AlertsManager.HandleUSBDeviceConnected failed', Err)
  );
  const [criticalErr, isCritical] = await ClientManager.IsUSBDeviceCritical(
    Client.UUID,
    Device && Device.SerialNumber
  );
  if (criticalErr) {
    Logger.error('ClientManager.IsUSBDeviceCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalUSBDeviceConnected(Client, Device).catch((Err) =>
      Logger.error('AlertsManager.HandleCriticalUSBDeviceConnected failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalUSBDeviceConnected(Client, Device).catch((Err) =>
      Logger.error('AlertsManager.HandleNonCriticalUSBDeviceConnected failed', Err)
    );
  }
  return;
}

BroadcastManager.on('USBDeviceAdded', USBDeviceAdded);

async function USBDeviceRemoved(Client, Device) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log(
    `USB Device Removed from ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
  );
  MainWindow.webContents.send('USBDeviceRemoved', Client, Device);
  AlertsManager.HandleUSBDeviceDisconnected(Client, Device).catch((Err) =>
    Logger.error('AlertsManager.HandleUSBDeviceDisconnected failed', Err)
  );
  const [criticalErr, isCritical] = await ClientManager.IsUSBDeviceCritical(
    Client.UUID,
    Device && Device.SerialNumber
  );
  if (criticalErr) {
    Logger.error('ClientManager.IsUSBDeviceCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalUSBDeviceDisconnected(Client, Device).catch((Err) =>
      Logger.error('AlertsManager.HandleCriticalUSBDeviceDisconnected failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalUSBDeviceDisconnected(Client, Device).catch((Err) =>
      Logger.error('AlertsManager.HandleNonCriticalUSBDeviceDisconnected failed', Err)
    );
  }
  return;
}

BroadcastManager.on('USBDeviceRemoved', USBDeviceRemoved);

async function ApplicationStarted(Client, Application) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  AlertsManager.HandleApplicationStarted(Client, Application).catch((Err) =>
    Logger.error('AlertsManager.HandleApplicationStarted failed', Err)
  );
  const [criticalErr, isCritical] = await ClientManager.IsApplicationCritical(
    Client.UUID,
    Application && Application.Name
  );
  if (criticalErr) {
    Logger.error('ClientManager.IsApplicationCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalApplicationStarted(Client, Application).catch((Err) =>
      Logger.error('AlertsManager.HandleCriticalApplicationStarted failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalApplicationStarted(Client, Application).catch((Err) =>
      Logger.error('AlertsManager.HandleNonCriticalApplicationStarted failed', Err)
    );
  }
}

BroadcastManager.on('ApplicationStarted', ApplicationStarted);

async function ApplicationStopped(Client, Application) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  AlertsManager.HandleApplicationStopped(Client, Application).catch((Err) =>
    Logger.error('AlertsManager.HandleApplicationStopped failed', Err)
  );
  const [criticalErr, isCritical] = await ClientManager.IsApplicationCritical(
    Client.UUID,
    Application && Application.Name
  );
  if (criticalErr) {
    Logger.error('ClientManager.IsApplicationCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalApplicationStopped(Client, Application).catch((Err) =>
      Logger.error('AlertsManager.HandleCriticalApplicationStopped failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalApplicationStopped(Client, Application).catch((Err) =>
      Logger.error('AlertsManager.HandleNonCriticalApplicationStopped failed', Err)
    );
  }
}

BroadcastManager.on('ApplicationStopped', ApplicationStopped);

async function ReadoptDevice(UUID) {
  await ServerManager.SendMessageByGroup(UUID, 'Adopt');
}
BroadcastManager.on('ReadoptDevice', ReadoptDevice);

// Full re-hydration: clear caches, re-fetch, and send authoritative lists.
async function ReinitializeSystem() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log('Reinitializing system...');

  // Refresh manager caches that hold DB-backed state in memory.
  if (typeof SettingsManager.Reload === 'function') {
    await SettingsManager.Reload();
  }
  if (typeof AlertsManager.Reload === 'function') {
    await AlertsManager.Reload();
  }
  if (typeof MonitoringTargetManager.Reload === 'function') {
    await MonitoringTargetManager.Reload();
  }

  if (typeof GroupManager.ReconcileOrphanedGroups === 'function') {
    const [OrphanErr] = await GroupManager.ReconcileOrphanedGroups();
    if (OrphanErr) Logger.error('Failed to reconcile orphaned group assignments:', OrphanErr);
  }

  await ClientManager.ClearCache();
  await AdoptionManager.ClearAllDevicesPendingAdoption();
  let [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) return Logger.error('Failed to fetch full client list:', ClientsErr);
  let [GroupsErr, Groups] = await GroupManager.GetAll();
  if (GroupsErr) return Logger.error('Failed to fetch client groups:', GroupsErr);

  await UpdateSettings();
  await UpdateMonitoringTargetList();
  await UpdateAlertRuleList();

  MainWindow.webContents.send('SetFullClientList', Clients, Groups);
}
BroadcastManager.on('ReinitializeSystem', ReinitializeSystem);

async function ClientUpdated(Client) {
  if (MainWindow && !MainWindow.isDestroyed()) {
    MainWindow.webContents.send('ClientUpdated', Client);
  }

  const UUID = Client && Client.UUID ? Client.UUID : null;
  const IsOnline = !!(Client && Client.Online);
  if (UUID) {
    const WasOnline = LastOnlineStateByUUID.get(UUID);
    LastOnlineStateByUUID.set(UUID, IsOnline);
    if (IsOnline && WasOnline !== true) {
      const Now = Date.now();
      const LastDeployAt = LastOnlineDeployAtByUUID.get(UUID) || 0;
      if (Now - LastDeployAt >= ONLINE_DEPLOY_COOLDOWN_MS) {
        LastOnlineDeployAtByUUID.set(UUID, Now);
        TriggerScriptDeployment([UUID], 'client-online').catch((Err) =>
          Logger.error('Auto deployment on online transition failed', Err)
        );
      }
    }
  }

  AlertsManager.HandleClientUpdated(Client).catch((Err) =>
    Logger.error('AlertsManager.HandleClientUpdated failed', Err)
  );
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

// Re-push the script catalog whenever it is reloaded from disk (e.g. after the
// Script Manager saves an edited Script.json), then auto-deploy updates.
BroadcastManager.on('ScriptsUpdated', async () => {
  await UpdateScriptList();
  ScheduleScriptChangeDeployment();
});

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

// Monitoring target fan-out
async function UpdateMonitoringTargetList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  const [Err, List] = await MonitoringTargetManager.GetAll();
  if (Err) return Logger.error('Failed to fetch monitoring targets:', Err);
  const SafeList = List || [];
  syncMonitoringHistoryStore(SafeList);
  MainWindow.webContents.send('SetFullMonitoringTargetList', SafeList);
}
BroadcastManager.on('MonitoringTargetListChanged', UpdateMonitoringTargetList);

async function MonitoringTargetUpdated(Target) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  recordMonitoringHistorySample(Target);
  MainWindow.webContents.send('MonitoringTargetUpdated', Target);
  AlertsManager.HandleMonitoringTargetUpdated(Target).catch((Err) =>
    Logger.error('AlertsManager.HandleMonitoringTargetUpdated failed', Err)
  );
}
BroadcastManager.on('MonitoringTargetUpdated', MonitoringTargetUpdated);

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

  const PendingScriptDeployments = (Executions || []).filter((Execution) => {
    return (
      Execution &&
      Execution.Script &&
      Execution.Script.Name === 'Deploying Scripts' &&
      Execution.Status === 'Pending'
    );
  });

  if (PendingScriptDeployments.length === 0) {
    const QueuedTargets = [...ActiveScriptDeployment.queuedTargets];
    ActiveScriptDeployment.inFlight = false;
    ActiveScriptDeployment.serverFingerprint = '';
    ActiveScriptDeployment.targets.clear();

    ActiveScriptDeployment.queuedTargets.clear();
    ActiveScriptDeployment.queuedServerFingerprint = '';

    if (QueuedTargets.length > 0) {
      TriggerScriptDeployment(QueuedTargets, 'queued-after-inflight').catch((Err) =>
        Logger.error('Queued deployment trigger failed', Err)
      );
    }
  }

  AlertsManager.HandleScriptExecutionUpdated(Executions).catch((Err) =>
    Logger.error('AlertsManager.HandleScriptExecutionUpdated failed', Err)
  );
}

BroadcastManager.on('ScriptExecutionUpdated', UpdateScriptExecutions);

async function UpdateAlertRuleList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  const [Err, Rules] = await AlertsManager.GetAll();
  if (Err) return Logger.error('Failed to fetch alert rules:', Err);
  MainWindow.webContents.send('SetFullAlertRuleList', Rules || []);
}
BroadcastManager.on('AlertRuleListChanged', UpdateAlertRuleList);

async function AlertTriggered(Payload) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('AlertTriggered', Payload);
}
BroadcastManager.on('AlertTriggered', AlertTriggered);

// Raises an alert in the renderer alerts tray (driven by the ShowTrak Alert action).
async function CreateShowTrakAlert(Payload) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('CreateShowTrakAlert', Payload);
}
BroadcastManager.on('CreateShowTrakAlert', CreateShowTrakAlert);

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
  Logger.log('Application shutdown requested (broadcast)');
  bypassShutdownConfirmation = true;
  quitRequested = true;
  app.quit();
});

// Relay application mode changes to renderer windows
ModeManager.on('ModeUpdated', (Mode) => {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('ModeUpdated', Mode);
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
  } catch {}

  try {
    if (typeof MonitoringTargetManager.Shutdown === 'function') {
      await MonitoringTargetManager.Shutdown();
    }
  } catch (Err) {
    Logger.error('Monitoring target shutdown cleanup failed:', Err);
  }

  try {
    await DBManager.Shutdown({ TimeoutMs: 15000 });
  } catch (Err) {
    Logger.error('DB shutdown cleanup failed:', Err);
  }
}

app.on('before-quit', (event) => {
  quitRequested = true;

  if (quittingForUpdate) {
    return;
  }

  if (!mainWindowCloseApproved && hasMainWindow()) {
    event.preventDefault();
    MainWindow.close();
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
  let SYSTEM_PREVENT_DISPLAY_SLEEP = await SettingsManager.GetValue('SYSTEM_PREVENT_DISPLAY_SLEEP');
  if (SYSTEM_PREVENT_DISPLAY_SLEEP) {
    Logger.log('Prevent Display Sleep is enabled, starting powerSaveBlocker.');
    powerSaveBlocker.start('prevent-display-sleep');
  } else {
    Logger.log('Prevent Display Sleep is disabled in settings, not starting powerSaveBlocker.');
  }
}
StartOptionalFeatures();

powerMonitor.on('shutdown', (event) => {
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
app.on('will-quit', (_event) => {
  Logger.log('App is closing, performing cleanup...');
});
