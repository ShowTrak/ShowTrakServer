const { app, BrowserWindow, ipcMain: RPC, Menu, globalShortcut } = require('electron/main')
if (require('electron-squirrel-startup')) app.quit();

const { Manager: AppDataManager } = require('./Modules/AppData');
AppDataManager.Initialize();
const { CreateLogger } = require('./Modules/Logger');
const Logger = CreateLogger('Main');
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  Logger.error('Another instance of ShowTrak Client is already running. Exiting this instance.');
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
BonjourManager.Init()
const { Manager: AdoptionManager } = require('./Modules/AdoptionManager');
const { Manager: ClientManager } = require('./Modules/ClientManager');
const { Manager: GroupManager } = require('./Modules/GroupManager');
const { Manager: FileSelectorManager } = require('./Modules/FileSelectorManager');
const { Manager: BackupManager } = require('./Modules/BackupManager');
const { Manager: ScriptExecutionManager } = require('./Modules/ScriptExecutionManager');
const { Manager: WOLManager } = require('./Modules/WOLManager');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Wait } = require('./Modules/Utils');
const path = require('path')

var MainWindow = null;

Menu.setApplicationMenu(null)
app.whenReady().then(async () => {

  if (require('electron-squirrel-startup')) return app.quit();

  if (MainWindow) {
    MainWindow.close();
    MainWindow = null;
  }

  app.on("web-contents-created", (_, contents) => {
    contents.on("before-input-event", (event, input) => {
      if (input.code == "F4" && input.alt) {
        event.preventDefault();
        if (!MainWindow || !MainWindow.isVisible()) return Shutdown();
        Logger.warn("Prevented alt+f4 shutdown, passing request to agent",);
        MainWindow.webContents.send('ShutdownRequested');
      }
    });
  });

  globalShortcut.register('CommandOrControl+A', () => {
    MainWindow.webContents.send('ShortcutTriggered', 'SelectAll');
  })

  globalShortcut.register('CommandOrControl+D', () => {
    MainWindow.webContents.send('ShortcutTriggered', 'ClearSelection');
  })

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
      preload: path.join(__dirname, 'bridge_main.js'),
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
    await ServerManager.ExecuteBulkRequest('DeleteScripts', List, 'Delete Scripts');
    return;
  })  
  
  RPC.handle('UpdateScripts', async (_Event, List) => {
    await ServerManager.ExecuteBulkRequest('UpdateScripts', List, 'Update Scripts');
    return;
  })  

  RPC.handle('WakeOnLan', async (_Event, List) => {
    await ScriptExecutionManager.ClearQueue();
    for (const UUID of List) {
      const RequestID = await ScriptExecutionManager.AddInternalTaskToQueue(UUID, 'Wake On LAN');
      const [ClientErr, Client] = await ClientManager.Get(UUID);
      if (ClientErr) {
        await ScriptExecutionManager.Complete(RequestID, ClientErr);
        continue;
      }
      if (!Client) {
        await ScriptExecutionManager.Complete(RequestID, 'Client not found');
        continue;
      }
      if (!Client.MacAddress) {
        await ScriptExecutionManager.Complete(RequestID, 'Client does not have a valid MAC address in internal database.');
        continue;
      }
      if (Client.Online) {
        await ScriptExecutionManager.Complete(RequestID, 'Client is already online');
        continue;
      }
      let [WOLErr, Result] = await WOLManager.Wake(Client.MacAddress, 3, 100);
      await ScriptExecutionManager.Complete(RequestID, WOLErr);
    }

  })  

  RPC.handle('Loaded', async () => {
    Logger.log('Application Page Hot Reloaded')
    UpdateAdoptionList();
    UpdateFullClientList();
    UpdateScriptList();
    return;
  })

  async function Shutdown() {
    Logger.log('Application shutdown requested');
    app.quit();
    process.exit(0);
    return;
  }

  RPC.handle('Shutdown', async () => {
    Shutdown()
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
    require('child_process').exec(`start ${LogsPath}`);
    return;
  })

  RPC.handle('OpenScriptsFolder', async (_event) => {
    let LogsPath = AppDataManager.GetScriptsDirectory();
    Logger.log('Opening scrippts folder:', LogsPath);
    require('child_process').exec(`start ${LogsPath}`);
    return;
  })

  RPC.handle('OpenDiscordInviteLinkInBrowser', async (_event, URL) => {
    var url = 'https://discord.gg/DACmwsbSGW';
    var start = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
    require('child_process').exec(start + ' ' + url);
    return;
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })


  // MainWindow.webContents.openDevTools();

})

async function USBDeviceAdded(Client, Device) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log(`USB Device Added to ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`);
  MainWindow.webContents.send('USBDeviceAdded', Client, Device);
  return;
}

BroadcastManager.on('USBDeviceAdded', USBDeviceAdded);

async function USBDeviceRemoved(Client, Device) {
  if (!MainWindow || MainWindow.isDestroyed()) return;
  Logger.log(`USB Device Removed from ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`);
  MainWindow.webContents.send('USBDeviceRemoved', Client, Device);
  return;
}

BroadcastManager.on('USBDeviceRemoved', USBDeviceRemoved);


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

const { updateElectronApp } = require('update-electron-app')
updateElectronApp({
  notifyUser: true,
})