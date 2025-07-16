// const { Config } = require('../Config');
const path = require('path');
const fs = require('fs');

let BasePath = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + "/.local/share")
const appDataPath = path.join(BasePath, 'ShowTrakServer');

const Manager = {};

Manager.Initialized = false;

Manager.Initialize = async () => {
  if (Manager.Initialized) return;
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
  }

  let AppDataFolders = [
    'Logs',
    'Scripts',
    'Storage',
  ]
  AppDataFolders.forEach(folder => {
    const folderPath = path.join(appDataPath, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
  });
  Manager.Initialized = true;
}

Manager.GetLogsDirectory = () => {
  return path.join(appDataPath, 'Logs');
}

Manager.GetScriptsDirectory = () => {
  return path.join(appDataPath, 'Scripts');
}

Manager.GetStorageDirectory = () => {
  return path.join(appDataPath, 'Storage');
}

Manager.OpenFolder = (FolderPath) => {
  if (fs.existsSync(FolderPath)) {
    require('child_process').exec(`start "" "${FolderPath}"`);
    return true;
  } else {
    return false;
  }
}

module.exports = {
    Manager,
}