// const { Config } = require('../Config');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const HomeDirectory = process.env.HOME || os.homedir();
let BasePath =
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

  let AppDataFolders = ['Logs', 'Scripts', 'Storage'];
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
    let args = [FolderPath];

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
