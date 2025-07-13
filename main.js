const { app, BrowserWindow, ipcMain: RPC } = require('electron/main')
if (require('electron-squirrel-startup')) app.quit();
const path = require('path')

// Load Backend
const { CreateLogger } = require('./Modules/Logger');
const Logger = CreateLogger('Main');
const { Config } = require('./Modules/Config');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: AppDataManager } = require('./Modules/AppData');
AppDataManager.Initialize();
const { Manager: ScriptManager } = require('./Modules/ScriptManager');
ScriptManager.GetScripts();
const { Manager: ServerManager } = require('./Modules/Server');
const { Manager: BonjourManager } = require('./Modules/Bonjour');
BonjourManager.Init()
const { Manager: AdoptionManager } = require('./Modules/AdoptionManager');
const { Manager: ClientManager } = require('./Modules/ClientManager');
const { Manager: GroupManager } = require('./Modules/GroupManager');

const { Manager: FileSelectorManager } = require('./Modules/FileSelectorManager');
const { Manager: BackupManager } = require('./Modules/BackupManager');

const { Wait } = require('./Modules/Utils');

var MainWindow = null;

app.whenReady().then(async () => {

  if (require('electron-squirrel-startup')) return app.quit();

  if (MainWindow) {
    MainWindow.close();
    MainWindow = null;
  }

  PreloaderWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 400,
    height: 500,
    resizable: false,
    webPreferences: { 
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, 'images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  })

  PreloaderWindow.loadFile('UI/preloader.html').then(() => {
    PreloaderWindow.show()
  })

  MainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 1515,
    height: 940,
    minWidth: 815,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, 'images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  })

  MainWindow.loadFile('UI/index.html').then(async () => {
    Logger.log('MainWindow finished loading UI');
    UpdateAdoptionList();
    await Wait(2000);
    PreloaderWindow.close();
    MainWindow.show()
  });

  RPC.handle('BackupConfig', async () => {
    let { canceled, filePath } = await FileSelectorManager.SaveDialog('Export ShowTrak Configuration');
    if (canceled || !filePath) {
      Logger.log('BackupConfig canceled');
      return ['Cancelled By User', null];
    }
    Logger.log('Backing up configuration to:', filePath);
    let [Err, Result] = await BackupManager.ExportConfig(filePath);
    if (Err) return [Err, null];
    return [null, Result];
  })

  RPC.handle('ImportConfig', async () => {
    let { canceled, filePaths } = await FileSelectorManager.SelectFile('Select ShowTrak Configuration File to Import');
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
  })

  

  RPC.handle('Config:Get', async () => {
    return Config;
  })

  RPC.handle('GetClient', async (_Event, UUID) => {
    let [Err, Client] = await ClientManager.Get(UUID);
    if (Err) return null;
    if (!Client) return null;
    return Client;
  })  

  RPC.handle('GetAllGroups', async (_Event) => {
    let [Err, Groups] = await GroupManager.GetAll();
    if (Err) return [];
    if (!Groups) return [];
    return Groups;
  })  

  RPC.handle('CreateGroup', async (_Event, Title) => {
    await GroupManager.Create(Title);
    return true;
  })

  RPC.handle('DeleteGroup', async (_Event, GroupID) => {
    await GroupManager.Delete(GroupID);
    return true;
  })

  RPC.handle('UpdateClient', async (_Event, UUID, Data) => {
    await ClientManager.Update(UUID, Data);
    return;
  })  

  RPC.handle('ExecuteScript', async (_Event, Scripts, Targets, ResetList) => {
    await ServerManager.ExecuteScripts(Scripts, Targets, ResetList);
    return;
  })  

  RPC.handle('DeleteScripts', async (_Event, List) => {
    await ServerManager.ExecuteBulkRequest('DeleteScripts', List);
    return;
  })  
  
  RPC.handle('UpdateScripts', async (_Event, List) => {
    await ServerManager.ExecuteBulkRequest('UpdateScripts', List);
    return;
  })  

  RPC.handle('Loaded', async () => {
    Logger.log('Application Page Hot Reloaded')
    UpdateAdoptionList();
    UpdateFullClientList();
    UpdateScriptList();
    return;
  })

  RPC.handle('Shutdown', async () => {
    Logger.log('Application shutdown requested');
    app.quit();
    return;
  })

  RPC.handle('AdoptDevice', async (_event, UUID) => {
    if (!UUID) return false;
    Logger.log('Adopting device:', UUID);
    await ClientManager.Create(UUID);
    await AdoptionManager.SetState(UUID, 'Adopting');
    await ServerManager.SendMessageByGroup(UUID, 'Adopt');
    return;
  })

  RPC.handle('UnadoptClient', async (_event, UUID) => {
    if (!UUID) return false;
    Logger.log('Unadopting device:', UUID);
    await ServerManager.SendMessageByGroup(UUID, 'Unadopt');
    await ClientManager.Delete(UUID);
    await UpdateFullClientList();
    return;
  })

  RPC.handle('OpenLogsFolder', async (_event) => {
    let LogsPath = AppDataManager.GetLogsDirectory();
    Logger.log('Opening logs folder:', LogsPath);
    // await shell.openPath(LogsPath);
    require('child_process').exec(`start ${LogsPath}`);
    return;
  })

  

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  // MainWindow.webContents.openDevTools();

})


async function ReadoptDevice(UUID) {
  await ServerManager.SendMessageByGroup(UUID, 'Adopt');
}
BroadcastManager.on('ReadoptDevice', ReadoptDevice)

async function ReinitializeSystem() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log('Reinitializing system...');
  await ClientManager.ClearCache();
  await AdoptionManager.ClearAllDevicesPendingAdopption();
  let [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) return Logger.error('Failed to fetch full client list:', ClientsErr);
  let [GroupsErr, Groups] = await GroupManager.GetAll();
  if (GroupsErr) return Logger.error('Failed to fetch client groups:', GroupsErr);
  MainWindow.webContents.send('SetFullClientList', Clients, Groups);
}
BroadcastManager.on('ReinitializeSystem', ReinitializeSystem)

async function ClientUpdated(Client) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('ClientUpdated', Client);
}

BroadcastManager.on('ClientUpdated', ClientUpdated)

async function UpdateScriptList() {
  // SetScriptList
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let ScriptList = await ScriptManager.GetScripts();
  MainWindow.webContents.send('SetScriptList', ScriptList);
}

async function UpdateFullClientList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) return Logger.error('Failed to fetch full client list:', ClientsErr);
  let [GroupsErr, Groups] = await GroupManager.GetAll();
  if (GroupsErr) return Logger.error('Failed to fetch client groups:', GroupsErr);
  MainWindow.webContents.send('SetFullClientList', Clients, Groups);
}


BroadcastManager.on('GroupListChanged', UpdateFullClientList)
BroadcastManager.on('ClientListChanged', UpdateFullClientList)

async function UpdateAdoptionList() {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  let DevicesPendingAdoption = AdoptionManager.GetClientsPendingAdoption();
  MainWindow.webContents.send('SetDevicesPendingAdoption', DevicesPendingAdoption);
}

BroadcastManager.on('AdoptionListUpdated', UpdateAdoptionList)

async function UpdateScriptExecutions(Executions) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  MainWindow.webContents.send('UpdateScriptExecutions', Executions);
}

BroadcastManager.on('ScriptExecutionUpdated', UpdateScriptExecutions)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})