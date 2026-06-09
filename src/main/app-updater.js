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
const { spawnSync } = require('child_process');

const { CreateLogger } = require('../Modules/Logger');
const Logger = CreateLogger('AppUpdater');

let autoUpdater = null;
let squirrelUpdaterInitialized = false;
let getMainWindow = () => null;
let checkWatchdogTimer = null;
let hasDownloadedUpdate = false;
let cachedMacDeveloperIdSigned = null;
const CHECK_TIMEOUT_MS = 20000;

function toErrorMessage(value) {
  if (!value) return 'Unknown error';
  if (value instanceof Error) return value.message || String(value);
  return String(value);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function clearCheckWatchdog() {
  if (!checkWatchdogTimer) return;
  clearTimeout(checkWatchdogTimer);
  checkWatchdogTimer = null;
}

function startCheckWatchdog(timeoutMs = CHECK_TIMEOUT_MS) {
  clearCheckWatchdog();
  Logger.log(`Update check watchdog started (${timeoutMs}ms)`);
  checkWatchdogTimer = setTimeout(() => {
    checkWatchdogTimer = null;
    Logger.error('Update check watchdog timed out');
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
    () =>
      sendAppUpdateStatus({ state: 'available', info: { version: versionLabel }, simulated: true }),
    600
  );
  let pct = 0;
  const timer = setInterval(() => {
    pct += 14;
    if (pct >= 100) {
      clearInterval(timer);
      sendAppUpdateStatus({
        state: 'downloaded',
        info: { version: versionLabel },
        simulated: true,
      });
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
  try {
    if (state) {
      Logger.log(`Updater status: ${state}`);
    }
  } catch {}
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
  const message = toErrorMessage(err);
  const isMac = process.platform === 'darwin';
  const has404 = message.includes('status 404');
  const referencesManifest = message.includes('latest-mac.yml');
  const referencesReleaseZip =
    message.includes('Cannot download') &&
    message.includes('/releases/download/') &&
    message.includes('.zip');
  const referencesShipIt = message.includes('ShipIt');
  const referencesSignatureValidation =
    message.includes('did not pass validation') &&
    message.includes('code failed to satisfy specified code requirement');

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

  if (isMac && referencesShipIt && referencesSignatureValidation) {
    return {
      state: 'error',
      error:
        'The downloaded macOS update failed signature validation. The installed app and update must be signed with the same Developer ID identity (same Team ID), and unsigned builds cannot auto-update.',
      info: {
        reason: 'mac_code_signature_requirement_mismatch',
        details: message,
      },
    };
  }

  return { state: 'error', error: message };
}

function isMacDeveloperIdSignedBuild() {
  if (process.platform !== 'darwin') return true;
  if (cachedMacDeveloperIdSigned !== null) return cachedMacDeveloperIdSigned;

  const probe = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', process.execPath], {
    encoding: 'utf8',
  });

  // codesign writes signature metadata to stderr on success for -d/-v flags.
  const details = `${String(probe.stdout || '')}\n${String(probe.stderr || '')}`;
  const hasDeveloperIdAuthority = /Authority=Developer ID Application:/i.test(details);
  const hasTeamIdentifier = /TeamIdentifier=/i.test(details);

  if (probe.error) {
    Logger.warn(
      'codesign probe failed; allowing updater eligibility check to continue:',
      probe.error
    );
    cachedMacDeveloperIdSigned = true;
    return cachedMacDeveloperIdSigned;
  }

  if (hasDeveloperIdAuthority) {
    cachedMacDeveloperIdSigned = true;
    return cachedMacDeveloperIdSigned;
  }

  if (probe.status === 0 && hasTeamIdentifier) {
    Logger.warn(
      'codesign output has TeamIdentifier but no Developer ID authority text; treating build as eligible to avoid false negatives'
    );
    cachedMacDeveloperIdSigned = true;
    return cachedMacDeveloperIdSigned;
  }

  const authorityLines = details
    .split('\n')
    .filter((line) => line.trim().startsWith('Authority='))
    .join(' | ');
  Logger.warn(
    `codesign probe indicates no Developer ID authority. status=${probe.status}; authorities=${authorityLines || 'none'}`
  );
  cachedMacDeveloperIdSigned = false;

  return cachedMacDeveloperIdSigned;
}

function ensureMacAutoUpdateEligibility() {
  if (process.platform !== 'darwin') return true;
  if (isMacDeveloperIdSignedBuild()) return true;

  sendAppUpdateStatus({
    state: 'error',
    error:
      'This macOS app build is not Developer ID signed, so automatic updates are disabled. Install an official signed release build to use in-app updates.',
    info: { reason: 'mac_unsigned_build_no_auto_update' },
  });
  return false;
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
    SquirrelUpdater.on('update-available', () =>
      sendAppUpdateStatus({ state: 'available', info: { tag: 'latest' } })
    );
    SquirrelUpdater.on('update-not-available', () => sendAppUpdateStatus({ state: 'none' }));
    SquirrelUpdater.on('update-downloaded', (_e, _notes, _name, _date, _url) => {
      sendAppUpdateStatus({ state: 'downloaded', info: { version: _name || 'pending' } });
    });
    SquirrelUpdater.on('error', (err) =>
      sendAppUpdateStatus({ state: 'error', error: String(err) })
    );
    // Note: Squirrel's autoUpdater may not emit download-progress; states will jump to downloaded
  } catch {}
}

async function handleCheck() {
  Logger.log('AppUpdate:Check invoked');

  if (app.isPackaged && !ensureMacAutoUpdateEligibility()) {
    Logger.warn('AppUpdate:Check continuing despite macOS signing eligibility warning');
  }

  sendAppUpdateStatus({ state: 'checking' });
  startCheckWatchdog();

  // Dev/unpacked: simulate
  if (!app.isPackaged) {
    try {
      Logger.log('Running simulated update check (unpackaged app)');
      runSimulatedCheck('TEST');
    } catch (e) {
      sendAppUpdateStatus({ state: 'error', error: String(e) });
    }
    return;
  }

  // Packaged on Windows via Squirrel: use Electron built-in Squirrel updater against GitHub latest
  if (isSquirrelWindows()) {
    try {
      Logger.log('Using Squirrel updater check flow');
      initSquirrelUpdater();
      const feed = 'https://github.com/ShowTrak/ShowTrakServer/releases/latest/download/';
      // Try both object and string forms for compatibility
      try {
        SquirrelUpdater.setFeedURL({ url: feed });
      } catch {
        SquirrelUpdater.setFeedURL(feed);
      }
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
      Logger.log('Initialized electron-updater in handleCheck()');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
      autoUpdater.on('update-available', (info) =>
        sendAppUpdateStatus({ state: 'available', info })
      );
      autoUpdater.on('update-not-available', (info) =>
        sendAppUpdateStatus({ state: 'none', info })
      );
      autoUpdater.on('error', (err) => sendAppUpdateStatus(normalizeUpdaterError(err)));
      autoUpdater.on('download-progress', (p) =>
        sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 })
      );
      autoUpdater.on('update-downloaded', (info) =>
        sendAppUpdateStatus({ state: 'downloaded', info })
      );
    } catch (e) {
      sendAppUpdateStatus({ state: 'error', error: 'Updater init failed: ' + String(e) });
      return;
    }
  }

  // Try to find an app-update.yml; if missing, synthesize one for GitHub public repo
  const resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : '';
  const execDir =
    typeof process !== 'undefined' && process.execPath ? path.dirname(process.execPath) : '';
  const ymlPaths = [
    resourcesPath ? path.join(resourcesPath, 'app-update.yml') : '',
    execDir ? path.join(execDir, 'app-update.yml') : '',
  ].filter(Boolean);
  const hasYml = ymlPaths.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
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
      Logger.warn(`app-update.yml not found; using temporary updater config at ${tmpYml}`);
    } catch (e) {
      sendAppUpdateStatus({
        state: 'error',
        error: 'Updater config failed: could not create app-update.yml for packaged app.',
        info: { details: String(e || 'Unknown error') },
      });
      return;
    }
  } else {
    Logger.log('Using packaged app-update.yml config for updater');
  }

  try {
    await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS, 'checkForUpdates');
    Logger.log('checkForUpdates() returned');
  } catch (e) {
    Logger.error('checkForUpdates() failed:', e);
    sendAppUpdateStatus(normalizeUpdaterError(e));
  }
}

async function handleInstall() {
  Logger.log('AppUpdate:Install invoked');

  if (app.isPackaged && !ensureMacAutoUpdateEligibility()) {
    Logger.warn('AppUpdate:Install blocked by macOS signing eligibility guard');
    return;
  }

  // Dev/unpacked: simulate install
  if (!app.isPackaged) {
    try {
      Logger.log('Running simulated update install (unpackaged app)');
      runSimulatedInstall();
    } catch (e) {
      sendAppUpdateStatus({ state: 'error', error: String(e) });
    }
    return;
  }

  // Packaged on Windows via Squirrel: call built-in updater
  if (isSquirrelWindows()) {
    try {
      Logger.log('Using Squirrel updater install flow');
      sendAppUpdateStatus({ state: 'installing' });
      SquirrelUpdater.quitAndInstall();
    } catch (e) {
      sendAppUpdateStatus({ state: 'error', error: String(e) });
    }
    return;
  }

  // Only install after a successful check/download cycle in this app session.
  if (!autoUpdater || !hasDownloadedUpdate) {
    Logger.warn('Install requested without downloaded update in current session');
    sendAppUpdateStatus({
      state: 'error',
      error: 'No downloaded update is ready to install. Run check/download again before install.',
    });
    return;
  }
  try {
    Logger.log('Calling electron-updater quitAndInstall(false, true)');
    await autoUpdater.quitAndInstall(false, true);
  } catch (e) {
    Logger.error('quitAndInstall failed:', e);
    sendAppUpdateStatus({ state: 'error', error: String(e) });
  }
}

// Initialize electron-updater lazily for manual control. Mirrors the original
// eager init that ran right after the IPC handlers were registered.
function initElectronUpdater() {
  try {
    const { autoUpdater: updater } = require('electron-updater');
    autoUpdater = updater;
    Logger.log('Initialized electron-updater in initElectronUpdater()');
    autoUpdater.autoDownload = true; // download when found
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => sendAppUpdateStatus({ state: 'available', info }));
    autoUpdater.on('update-not-available', (info) => sendAppUpdateStatus({ state: 'none', info }));
    autoUpdater.on('error', (err) => sendAppUpdateStatus(normalizeUpdaterError(err)));
    autoUpdater.on('download-progress', (p) =>
      sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 })
    );
    autoUpdater.on('update-downloaded', (info) =>
      sendAppUpdateStatus({ state: 'downloaded', info })
    );
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
