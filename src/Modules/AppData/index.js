// const { Config } = require('../Config');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const HomeDirectory = process.env.HOME || os.homedir();
const BasePath =
  process.platform === 'win32'
    ? process.env.APPDATA || path.join(HomeDirectory, 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(HomeDirectory, 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || path.join(HomeDirectory, '.local', 'share');
const appDataPath = path.join(BasePath, 'ShowTrakServer');

const Manager = {};

Manager.Initialized = false;

Manager.Initialize = async () => {
  if (Manager.Initialized) return;
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
  }

  const AppDataFolders = ['Logs', 'Scripts', 'Storage', 'SampleScripts', 'Audio'];
  AppDataFolders.forEach((folder) => {
    const folderPath = path.join(appDataPath, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
  });
  Manager.Initialized = true;
};

Manager.GetLogsDirectory = () => {
  return path.join(appDataPath, 'Logs');
};

Manager.GetScriptsDirectory = () => {
  return path.join(appDataPath, 'Scripts');
};

Manager.GetStorageDirectory = () => {
  return path.join(appDataPath, 'Storage');
};

// Persistent store for user-imported custom audio assets used as alert sounds.
// Holds the audio files plus a manifest.json describing each asset. This is
// app-global (survives show swaps) on purpose, matching how alert sounds work.
Manager.GetAudioDirectory = () => {
  return path.join(appDataPath, 'Audio');
};

// Cache directory for sample scripts fetched from the public ShowTrak
// SampleScripts repository (catalog JSON + downloaded file contents).
Manager.GetSampleScriptsDirectory = () => {
  return path.join(appDataPath, 'SampleScripts');
};

// App-level state that must survive across relaunches and is NOT part of the
// swappable show database (e.g. which .ShowTrak file is currently open).
Manager.GetStateFilePath = () => {
  return path.join(appDataPath, 'state.json');
};

Manager.OpenFolder = (FolderPath) => {
  if (!fs.existsSync(FolderPath)) {
    return false;
  }

  try {
    let command = 'xdg-open';
    const args = [FolderPath];

    if (process.platform === 'darwin') {
      command = 'open';
    } else if (process.platform === 'win32') {
      command = 'explorer';
    }

    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch (_error) {
    return false;
  }
};

module.exports = {
  Manager,
};
