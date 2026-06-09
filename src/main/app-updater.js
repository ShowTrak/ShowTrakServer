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

function sendAppUpdateStatus(payload) {
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
    sendAppUpdateStatus(normalizeUpdaterError(e));
  }
}

async function handleInstall() {
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
