// AppUpdater (main process)
// Encapsulates all application self-update flows:
// - Dev/unpacked: a simulated check/install sequence for UI testing.
// - Packaged Windows (Squirrel): Electron's built-in autoUpdater against GitHub.
// - Packaged elsewhere: electron-updater against the public GitHub repo.
// Status is pushed to the renderer via the 'AppUpdate:Status' channel using the
// injected window provider. Behavior is identical to the original inline impl;
// it has simply been grouped here.
const { app } = require('electron/main');
const { autoUpdater: SquirrelUpdater } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { CreateLogger } = require('../Modules/Logger');
const Logger = CreateLogger('AppUpdater');

let autoUpdater = null;
let squirrelUpdaterInitialized = false;
let getMainWindow = () => null;
let checkWatchdogTimer = null;
let hasDownloadedUpdate = false;

function clearCheckWatchdog() {
  if (!checkWatchdogTimer) return;
  clearTimeout(checkWatchdogTimer);
  checkWatchdogTimer = null;
}

function startCheckWatchdog(timeoutMs = 20000) {
  clearCheckWatchdog();
  checkWatchdogTimer = setTimeout(() => {
    checkWatchdogTimer = null;
    sendAppUpdateStatus({
      state: 'error',
      error: 'Update check timed out. Please try again in a moment.',
      info: { reason: 'check_timeout' },
    });
  }, timeoutMs);
}

function runSimulatedCheck(versionLabel) {
  sendAppUpdateStatus({ state: 'checking', simulated: true });
  setTimeout(
    () => sendAppUpdateStatus({ state: 'available', info: { version: versionLabel }, simulated: true }),
    600
  );
  let pct = 0;
  const timer = setInterval(() => {
    pct += 14;
    if (pct >= 100) {
      clearInterval(timer);
      sendAppUpdateStatus({ state: 'downloaded', info: { version: versionLabel }, simulated: true });
    } else {
      sendAppUpdateStatus({ state: 'downloading', percent: pct, simulated: true });
    }
  }, 250);
}

function runSimulatedInstall() {
  sendAppUpdateStatus({ state: 'installing', simulated: true });
  setTimeout(() => sendAppUpdateStatus({ state: 'installed', simulated: true }), 600);
}

function sendAppUpdateStatus(payload) {
  const state = payload && payload.state;
  if (state === 'downloaded') {
    hasDownloadedUpdate = true;
  } else if (
    state === 'checking' ||
    state === 'available' ||
    state === 'downloading' ||
    state === 'none' ||
    state === 'error' ||
    state === 'installed'
  ) {
    hasDownloadedUpdate = false;
  }
  if (state === 'available' || state === 'none' || state === 'error' || state === 'downloaded') {
    clearCheckWatchdog();
  }
  try {
    const MainWindow = getMainWindow();
    if (MainWindow && !MainWindow.isDestroyed()) {
      MainWindow.webContents.send('AppUpdate:Status', payload);
    }
  } catch {}
}

function normalizeUpdaterError(err) {
  const message = String(err || 'Unknown updater error');
  const isMac = process.platform === 'darwin';
  const has404 = message.includes('status 404');
  const referencesManifest = message.includes('latest-mac.yml');
  const referencesReleaseZip =
    message.includes('Cannot download') &&
    message.includes('/releases/download/') &&
    message.includes('.zip');

  if (isMac && has404 && referencesManifest) {
    return {
      state: 'none',
      info: { reason: 'latest-mac.yml is missing from release assets' },
    };
  }

  if (isMac && has404 && referencesReleaseZip) {
    return {
      state: 'error',
      error:
        'macOS update package is missing from this GitHub release (asset filename mismatch). Regenerate latest-mac.yml and upload a matching macOS zip asset.',
      info: {
        reason: 'mac_release_asset_name_mismatch',
        details: message,
      },
    };
  }

  return { state: 'error', error: message };
}

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

async function handleCheck() {
  startCheckWatchdog();

  // Dev/unpacked: simulate
  if (!app.isPackaged) {
    try {
      runSimulatedCheck('TEST');
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
      autoUpdater.on('error', (err) => sendAppUpdateStatus(normalizeUpdaterError(err)));
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
      sendAppUpdateStatus({
        state: 'error',
        error: 'Updater config failed: could not create app-update.yml for packaged app.',
        info: { details: String(e || 'Unknown error') },
      });
      return;
    }
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    sendAppUpdateStatus(normalizeUpdaterError(e));
  }
}

async function handleInstall() {
  // Dev/unpacked: simulate install
  if (!app.isPackaged) {
    try {
      runSimulatedInstall();
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

  // Only install after a successful check/download cycle in this app session.
  if (!autoUpdater || !hasDownloadedUpdate) {
    sendAppUpdateStatus({
      state: 'error',
      error: 'No downloaded update is ready to install. Run check/download again before install.',
    });
    return;
  }
  try {
    await autoUpdater.quitAndInstall(false, true);
  } catch (e) {
    sendAppUpdateStatus({ state: 'error', error: String(e) });
  }
}

// Initialize electron-updater lazily for manual control. Mirrors the original
// eager init that ran right after the IPC handlers were registered.
function initElectronUpdater() {
  try {
    const { autoUpdater: updater } = require('electron-updater');
    autoUpdater = updater;
    autoUpdater.autoDownload = true; // download when found
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => sendAppUpdateStatus({ state: 'available', info }));
    autoUpdater.on('update-not-available', (info) => sendAppUpdateStatus({ state: 'none', info }));
    autoUpdater.on('error', (err) => sendAppUpdateStatus(normalizeUpdaterError(err)));
    autoUpdater.on('download-progress', (p) =>
      sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 })
    );
    autoUpdater.on('update-downloaded', (info) => sendAppUpdateStatus({ state: 'downloaded', info }));
  } catch (e) {
    Logger.error('electron-updater initialization failed:', e);
  }
}

// Wire the IPC handlers and perform the eager electron-updater init. Pass a
// provider returning the current main BrowserWindow (it is created lazily).
function Register(RPC, options = {}) {
  if (typeof options.getMainWindow === 'function') {
    getMainWindow = options.getMainWindow;
  }
  RPC.handle('AppUpdate:Check', handleCheck);
  RPC.handle('AppUpdate:Install', handleInstall);
  initElectronUpdater();
}

module.exports = {
  Manager: {
    Register,
    sendAppUpdateStatus,
    isSquirrelWindows,
  },
};
