const { Config } = require('../Config');
const path = require('path');
const fs = require('fs');
const appDataPath = path.join(process.env.APPDATA, 'ShowTrakServer');

const Manager = {};

Manager.Initialize = async () => {
  if (!fs.existsSync(appDataPath)) {
    Logger.log(`Creating application data directory at ${appDataPath}`);
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
      Logger.log(`Creating folder: ${folderPath}`);
      fs.mkdirSync(folderPath, { recursive: true });
    }
  });
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
    Logger.error(`Directory does not exist: ${FolderPath}`);
    return false;
  }
}

module.exports = {
    Manager,
}