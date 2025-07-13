const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('API', {
  GetConfig: async () => ipcRenderer.invoke('Config:Get'),
  AdoptDevice: async (UUID) => ipcRenderer.invoke('AdoptDevice', UUID),
  Loaded: () => ipcRenderer.invoke('Loaded'),
  Shutdown: () => ipcRenderer.invoke('Shutdown'),
  GetClient: async (UUID) => ipcRenderer.invoke('GetClient', UUID),
  GetAllGroups: async () => ipcRenderer.invoke('GetAllGroups'),
  CreateGroup: async (Title) => ipcRenderer.invoke('CreateGroup', Title),
  DeleteGroup: async (GroupID) => ipcRenderer.invoke('DeleteGroup', GroupID),
  OpenLogsFolder: async () => ipcRenderer.invoke('OpenLogsFolder'),
  BackupConfig: async () => ipcRenderer.invoke('BackupConfig'),
  ImportConfig: async () => ipcRenderer.invoke('ImportConfig'),
  SetDevicesPendingAdoption: (Callback) => ipcRenderer.on('SetDevicesPendingAdoption', (_event, Data) => {
    Callback(Data)
  }),
  SetFullClientList: (Callback) => ipcRenderer.on('SetFullClientList', (_event, Clients, Groups) => {
    Callback(Clients, Groups)
  }),
  SetScriptList: (Callback) => ipcRenderer.on('SetScriptList', (_event, Data) => {
    Callback(Data)
  }),
  ClientUpdated: (Callback) => ipcRenderer.on('ClientUpdated', (_event, Data) => {
    Callback(Data)
  }),
  UpdateScriptExecutions: (Callback) => ipcRenderer.on('UpdateScriptExecutions', (_event, Data) => {
    Callback(Data)
  }),
  UpdateClient: async (UUID, Data) => ipcRenderer.invoke('UpdateClient', UUID, Data),
  ExecuteScript: async (Script, Targets, ResetList) => ipcRenderer.invoke('ExecuteScript', Script, Targets, ResetList),
  UnadoptClient: async (UUID) => ipcRenderer.invoke('UnadoptClient', UUID),
  DeleteScripts: async (List) => ipcRenderer.invoke('DeleteScripts', List),
  UpdateScripts: async (List) => ipcRenderer.invoke('UpdateScripts', List),
})