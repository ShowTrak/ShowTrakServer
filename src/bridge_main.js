const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('API', {
  OpenDiscordInviteLinkInBrowser: async () => ipcRenderer.invoke('OpenDiscordInviteLinkInBrowser'),
  GetConfig: async () => ipcRenderer.invoke('Config:Get'),
  GetSettings: async () => ipcRenderer.invoke('Settings:Get'),
  AdoptDevice: async (UUID) => ipcRenderer.invoke('AdoptDevice', UUID),
  CheckForUpdatesOnClient: async (UUID) => ipcRenderer.invoke('CheckForUpdatesOnClient', UUID),
  Loaded: () => ipcRenderer.invoke('Loaded'),
  Shutdown: () => ipcRenderer.invoke('Shutdown'),
  GetClient: async (UUID) => ipcRenderer.invoke('GetClient', UUID),
  GetAllGroups: async () => ipcRenderer.invoke('GetAllGroups'),
  CreateGroup: async (Title) => ipcRenderer.invoke('CreateGroup', Title),
  DeleteGroup: async (GroupID) => ipcRenderer.invoke('DeleteGroup', GroupID),
  OpenLogsFolder: async () => ipcRenderer.invoke('OpenLogsFolder'),
  OpenScriptsFolder: async () => ipcRenderer.invoke('OpenScriptsFolder'),
  BackupConfig: async () => ipcRenderer.invoke('BackupConfig'),
  ImportConfig: async () => ipcRenderer.invoke('ImportConfig'),
  SetGroupOrder: async (GroupID, OrderedUUIDs) =>
    ipcRenderer.invoke('SetGroupOrder', GroupID, OrderedUUIDs),
  // Application Mode API
  GetMode: async () => ipcRenderer.invoke('Mode:Get'),
  SetMode: async (Mode) => ipcRenderer.invoke('Mode:Set', Mode),
  OnModeUpdated: (Callback) => ipcRenderer.on('ModeUpdated', (_event, Mode) => Callback(Mode)),
  OSCBulkAction: (Callback) =>
    ipcRenderer.on('OSCBulkAction', (_event, Type, Targets, Args = null) => {
      Callback(Type, Targets, Args);
    }),
  PlaySound: (Callback) =>
    ipcRenderer.on('PlaySound', (_event, SoundName) => {
      Callback(SoundName);
    }),
  Notify: (Callback) =>
    ipcRenderer.on('Notify', (_event, Message, Type, Duration) => {
      Callback(Message, Type, Duration);
    }),
  SetOSCList: (Callback) =>
    ipcRenderer.on('SetOSCList', (_event, Routes) => {
      Callback(Routes);
    }),
  SetDevicesPendingAdoption: (Callback) =>
    ipcRenderer.on('SetDevicesPendingAdoption', (_event, Data) => {
      Callback(Data);
    }),
  SetFullClientList: (Callback) =>
    ipcRenderer.on('SetFullClientList', (_event, Clients, Groups) => {
      Callback(Clients, Groups);
    }),
  SetScriptList: (Callback) =>
    ipcRenderer.on('SetScriptList', (_event, Data) => {
      Callback(Data);
    }),
  ClientUpdated: (Callback) =>
    ipcRenderer.on('ClientUpdated', (_event, Data) => {
      Callback(Data);
    }),
  UpdateScriptExecutions: (Callback) =>
    ipcRenderer.on('UpdateScriptExecutions', (_event, Data) => {
      Callback(Data);
    }),
  ShutdownRequested: (Callback) =>
    ipcRenderer.on('ShutdownRequested', (_event) => {
      Callback();
    }),
  USBDeviceAdded: (Callback) =>
    ipcRenderer.on('USBDeviceAdded', (_event, Client, Device) => {
      Callback(Client, Device);
    }),
  USBDeviceRemoved: (Callback) =>
    ipcRenderer.on('USBDeviceRemoved', (_event, Client, Device) => {
      Callback(Client, Device);
    }),
  UpdateSettings: (Callback) =>
    ipcRenderer.on('UpdateSettings', (_event, Settings, SettingsGroupps) => {
      Callback(Settings, SettingsGroupps);
    }),
  SetSetting: async (Key, Value) => ipcRenderer.invoke('SetSetting', Key, Value),
  WakeOnLan: async (Targets) => ipcRenderer.invoke('WakeOnLan', Targets),
  UpdateClient: async (UUID, Data) => ipcRenderer.invoke('UpdateClient', UUID, Data),
  ExecuteScript: async (Script, Targets, ResetList) =>
    ipcRenderer.invoke('ExecuteScript', Script, Targets, ResetList),
  UnadoptClient: async (UUID) => ipcRenderer.invoke('UnadoptClient', UUID),
  DeleteScripts: async (List) => ipcRenderer.invoke('DeleteScripts', List),
  UpdateScripts: async (List) => ipcRenderer.invoke('UpdateScripts', List),
});
