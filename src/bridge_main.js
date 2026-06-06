const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'OpenDiscordInviteLinkInBrowser',
  'Config:Get',
  'WebUI:GetAddresses',
  'Settings:Get',
  'AdoptDevice',
  'CheckForUpdatesOnClient',
  'Loaded',
  'Shutdown',
  'GetClient',
  'GetAllGroups',
  'CreateGroup',
  'DeleteGroup',
  'OpenLogsFolder',
  'OpenScriptsFolder',
  'BackupConfig',
  'ImportConfig',
  'SetGroupOrder',
  'Mode:Get',
  'Mode:Set',
  'SetSetting',
  'WakeOnLan',
  'UpdateClient',
  'ExecuteScript',
  'UnadoptClient',
  'DeleteScripts',
  'UpdateScripts',
  'AppUpdate:Check',
  'AppUpdate:Install',
  'GetMonitoringMethods',
  'GetAllMonitoringTargets',
  'GetMonitoringTarget',
  'CreateMonitoringTarget',
  'UpdateMonitoringTarget',
  'DeleteMonitoringTarget',
  'NetworkDiscovery:Start',
  'NetworkDiscovery:Stop',
]);

const SUBSCRIBE_CHANNELS = new Set([
  'ModeUpdated',
  'OSCBulkAction',
  'PlaySound',
  'Notify',
  'SetOSCList',
  'SetDevicesPendingAdoption',
  'SetFullClientList',
  'SetScriptList',
  'ClientUpdated',
  'UpdateScriptExecutions',
  'ShutdownRequested',
  'USBDeviceAdded',
  'USBDeviceRemoved',
  'UpdateSettings',
  'AppUpdate:Status',
  'SetFullMonitoringTargetList',
  'MonitoringTargetUpdated',
  'NetworkDeviceScanEvent',
]);

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked invoke channel: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel, callback, mapper = (...payload) => payload) {
  if (!SUBSCRIBE_CHANNELS.has(channel)) {
    throw new Error(`Blocked subscribe channel: ${channel}`);
  }
  if (typeof callback !== 'function') {
    throw new TypeError(`Callback for ${channel} must be a function`);
  }

  const handler = (_event, ...payload) => {
    callback(...mapper(...payload));
  };

  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('API', {
  OpenDiscordInviteLinkInBrowser: async () => invoke('OpenDiscordInviteLinkInBrowser'),
  GetConfig: async () => invoke('Config:Get'),
  GetWebUIAddresses: async () => invoke('WebUI:GetAddresses'),
  GetSettings: async () => invoke('Settings:Get'),
  AdoptDevice: async (UUID) => invoke('AdoptDevice', UUID),
  CheckForUpdatesOnClient: async (UUID) => invoke('CheckForUpdatesOnClient', UUID),
  Loaded: () => invoke('Loaded'),
  Shutdown: () => invoke('Shutdown'),
  GetClient: async (UUID) => invoke('GetClient', UUID),
  GetAllGroups: async () => invoke('GetAllGroups'),
  CreateGroup: async (Title) => invoke('CreateGroup', Title),
  DeleteGroup: async (GroupID) => invoke('DeleteGroup', GroupID),
  OpenLogsFolder: async () => invoke('OpenLogsFolder'),
  OpenScriptsFolder: async () => invoke('OpenScriptsFolder'),
  BackupConfig: async () => invoke('BackupConfig'),
  ImportConfig: async () => invoke('ImportConfig'),
  SetGroupOrder: async (GroupID, OrderedUUIDs) =>
    invoke('SetGroupOrder', GroupID, OrderedUUIDs),
  // Application Mode API
  GetMode: async () => invoke('Mode:Get'),
  SetMode: async (Mode) => invoke('Mode:Set', Mode),
  OnModeUpdated: (Callback) => subscribe('ModeUpdated', Callback),
  OSCBulkAction: (Callback) =>
    subscribe('OSCBulkAction', Callback, (Type, Targets, Args = null) => [Type, Targets, Args]),
  PlaySound: (Callback) =>
    subscribe('PlaySound', Callback),
  Notify: (Callback) =>
    subscribe('Notify', Callback, (Message, Type, Duration) => [Message, Type, Duration]),
  SetOSCList: (Callback) =>
    subscribe('SetOSCList', Callback),
  SetDevicesPendingAdoption: (Callback) =>
    subscribe('SetDevicesPendingAdoption', Callback),
  SetFullClientList: (Callback) =>
    subscribe('SetFullClientList', Callback, (Clients, Groups) => [Clients, Groups]),
  SetScriptList: (Callback) =>
    subscribe('SetScriptList', Callback),
  ClientUpdated: (Callback) =>
    subscribe('ClientUpdated', Callback),
  UpdateScriptExecutions: (Callback) =>
    subscribe('UpdateScriptExecutions', Callback),
  ShutdownRequested: (Callback) =>
    subscribe('ShutdownRequested', Callback, () => []),
  USBDeviceAdded: (Callback) =>
    subscribe('USBDeviceAdded', Callback, (Client, Device) => [Client, Device]),
  USBDeviceRemoved: (Callback) =>
    subscribe('USBDeviceRemoved', Callback, (Client, Device) => [Client, Device]),
  UpdateSettings: (Callback) =>
    subscribe('UpdateSettings', Callback, (Settings, SettingsGroupps) => [Settings, SettingsGroupps]),
  SetSetting: async (Key, Value) => invoke('SetSetting', Key, Value),
  WakeOnLan: async (Targets) => invoke('WakeOnLan', Targets),
  UpdateClient: async (UUID, Data) => invoke('UpdateClient', UUID, Data),
  ExecuteScript: async (Script, Targets, ResetList) =>
    invoke('ExecuteScript', Script, Targets, ResetList),
  UnadoptClient: async (UUID) => invoke('UnadoptClient', UUID),
  DeleteScripts: async (List) => invoke('DeleteScripts', List),
  UpdateScripts: async (List) => invoke('UpdateScripts', List),
  // App update APIs
  CheckForAppUpdates: async () => invoke('AppUpdate:Check'),
  InstallAppUpdate: async () => invoke('AppUpdate:Install'),
  OnAppUpdateStatus: (cb) => subscribe('AppUpdate:Status', cb),
  // Monitoring Targets
  GetMonitoringMethods: async () => invoke('GetMonitoringMethods'),
  GetAllMonitoringTargets: async () => invoke('GetAllMonitoringTargets'),
  GetMonitoringTarget: async (TargetID) => invoke('GetMonitoringTarget', TargetID),
  CreateMonitoringTarget: async (Payload) => invoke('CreateMonitoringTarget', Payload),
  UpdateMonitoringTarget: async (TargetID, Payload) =>
    invoke('UpdateMonitoringTarget', TargetID, Payload),
  DeleteMonitoringTarget: async (TargetID) => invoke('DeleteMonitoringTarget', TargetID),
  SetFullMonitoringTargetList: (Callback) => subscribe('SetFullMonitoringTargetList', Callback),
  MonitoringTargetUpdated: (Callback) => subscribe('MonitoringTargetUpdated', Callback),
  StartNetworkDeviceScan: async (Options) => invoke('NetworkDiscovery:Start', Options),
  StopNetworkDeviceScan: async (ScanID) => invoke('NetworkDiscovery:Stop', ScanID),
  OnNetworkDeviceScanEvent: (Callback) => subscribe('NetworkDeviceScanEvent', Callback),
});
