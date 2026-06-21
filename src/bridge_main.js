const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'OpenDiscordInviteLinkInBrowser',
  'OpenShowTrakWebsiteInBrowser',
  'OpenShowTrakGithubInBrowser',
  'OpenNpmPackageInBrowser',
  'GetProjectDependencies',
  'Config:Get',
  'WebUI:GetAddresses',
  'Settings:Get',
  'AdoptDevice',
  'CheckForUpdatesOnClient',
  'UpdateManager:GetStatus',
  'UpdateManager:GetReleases',
  'UpdateManager:DownloadRelease',
  'UpdateManager:DeployRelease',
  'Loaded',
  'Shutdown',
  'GetClient',
  'GetAllGroups',
  'CreateGroup',
  'RenameGroup',
  'DeleteGroup',
  'Groups:SetOrder',
  'OpenLogsFolder',
  'OpenScriptsFolder',
  'Show:New',
  'Show:Save',
  'Show:SaveAs',
  'Show:Open',
  'Show:GetCurrentFile',
  'Show:HasUnsavedData',
  'Show:EnsureFileExists',
  'SetGroupOrder',
  'Mode:Get',
  'Mode:Set',
  'SetSetting',
  'WakeOnLan',
  'UpdateClient',
  'MarkClientUSBDeviceCritical',
  'RemoveClientUSBDeviceCritical',
  'MarkClientApplicationCritical',
  'RemoveClientApplicationCritical',
  'ExecuteScript',
  'UnadoptClient',
  'ReplaceClient',
  'DeleteScripts',
  'UpdateScripts',
  'Scripts:GetManagerList',
  'Scripts:GetConfig',
  'Scripts:SaveConfig',
  'Scripts:SetOrder',
  'Scripts:Delete',
  'Scripts:Create',
  'Scripts:GetSampleList',
  'Scripts:RefreshSamples',
  'Scripts:CreateFromTemplate',
  'Scripts:OpenFolder',
  'Scripts:OpenFile',
  'Scripts:RunLocalFile',
  'AppUpdate:Check',
  'AppUpdate:Install',
  'GetMonitoringMethods',
  'GetAllMonitoringTargets',
  'GetMonitoringTarget',
  'GetMonitoringTargetHistory',
  'GetDummyClientHistory',
  'CreateMonitoringTarget',
  'UpdateMonitoringTarget',
  'DeleteMonitoringTarget',
  'GetAllDummyClients',
  'GetDummyClient',
  'GenerateDummyClientDefaults',
  'CreateDummyClient',
  'UpdateDummyClient',
  'DeleteDummyClient',
  'NetworkDiscovery:Start',
  'NetworkDiscovery:Stop',
  'GetAlertTriggers',
  'GetAlertActionTypes',
  'GetAllAlertRules',
  'GetAlertRule',
  'CreateAlertRule',
  'UpdateAlertRule',
  'DeleteAlertRule',
  'SetAlertRuleEnabled',
  'AlertActionsEnabled:Get',
  'AlertActionsEnabled:Set',
]);

const SUBSCRIBE_CHANNELS = new Set([
  'AppMenuAction',
  'ModeUpdated',
  'OSCBulkAction',
  'PlaySound',
  'Notify',
  'DebugTrafficEntry',
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
  'SetFullDummyClientList',
  'DummyClientUpdated',
  'NetworkDeviceScanEvent',
  'SetFullAlertRuleList',
  'AlertTriggered',
  'CreateShowTrakAlert',
  'UpdateManager:DownloadProgress',
  'ShowFileUpdated',
  'MainWindowFullscreenChanged',
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
  OpenShowTrakWebsiteInBrowser: async () => invoke('OpenShowTrakWebsiteInBrowser'),
  OpenShowTrakGithubInBrowser: async () => invoke('OpenShowTrakGithubInBrowser'),
  OpenNpmPackageInBrowser: async (PackageName) => invoke('OpenNpmPackageInBrowser', PackageName),
  GetProjectDependencies: async () => invoke('GetProjectDependencies'),
  GetConfig: async () => invoke('Config:Get'),
  GetWebUIAddresses: async () => invoke('WebUI:GetAddresses'),
  GetSettings: async () => invoke('Settings:Get'),
  AdoptDevice: async (UUID) => invoke('AdoptDevice', UUID),
  CheckForUpdatesOnClient: async (UUID) => invoke('CheckForUpdatesOnClient', UUID),
  GetUpdateManagerStatus: async () => invoke('UpdateManager:GetStatus'),
  GetUpdateManagerReleases: async () => invoke('UpdateManager:GetReleases'),
  DownloadUpdateManagerRelease: async (Tag) => invoke('UpdateManager:DownloadRelease', Tag),
  DeployUpdateManagerRelease: async (Tag, Targets) =>
    invoke('UpdateManager:DeployRelease', Tag, Targets),
  OnUpdateManagerDownloadProgress: (Callback) =>
    subscribe('UpdateManager:DownloadProgress', Callback),
  Loaded: () => invoke('Loaded'),
  Shutdown: async (Confirmed = false) => invoke('Shutdown', Confirmed),
  GetClient: async (UUID) => invoke('GetClient', UUID),
  GetAllGroups: async () => invoke('GetAllGroups'),
  CreateGroup: async (Title) => invoke('CreateGroup', Title),
  RenameGroup: async (GroupID, Title) => invoke('RenameGroup', GroupID, Title),
  DeleteGroup: async (GroupID) => invoke('DeleteGroup', GroupID),
  SetGroupListOrder: async (OrderedGroupIDs) => invoke('Groups:SetOrder', OrderedGroupIDs),
  OpenLogsFolder: async () => invoke('OpenLogsFolder'),
  OpenScriptsFolder: async () => invoke('OpenScriptsFolder'),
  NewShow: async () => invoke('Show:New'),
  SaveShow: async () => invoke('Show:Save'),
  SaveShowAs: async () => invoke('Show:SaveAs'),
  OpenShow: async () => invoke('Show:Open'),
  GetCurrentShowFile: async () => invoke('Show:GetCurrentFile'),
  HasUnsavedShowData: async () => invoke('Show:HasUnsavedData'),
  EnsureShowFileExists: async () => invoke('Show:EnsureFileExists'),
  OnShowFileUpdated: (Callback) => subscribe('ShowFileUpdated', Callback),
  OnAppMenuAction: (Callback) => subscribe('AppMenuAction', Callback),
  OnWindowFullscreenChanged: (Callback) => subscribe('MainWindowFullscreenChanged', Callback),
  SetGroupOrder: async (GroupID, OrderedUUIDs) => invoke('SetGroupOrder', GroupID, OrderedUUIDs),
  // Application Mode API
  GetMode: async () => invoke('Mode:Get'),
  SetMode: async (Mode) => invoke('Mode:Set', Mode),
  OnModeUpdated: (Callback) => subscribe('ModeUpdated', Callback),
  OSCBulkAction: (Callback) =>
    subscribe('OSCBulkAction', Callback, (Type, Targets, Args = null) => [Type, Targets, Args]),
  PlaySound: (Callback) => subscribe('PlaySound', Callback),
  Notify: (Callback) =>
    subscribe('Notify', Callback, (Message, Type, Duration) => [Message, Type, Duration]),
  DebugTrafficEntry: (Callback) => subscribe('DebugTrafficEntry', Callback),
  SetOSCList: (Callback) => subscribe('SetOSCList', Callback),
  SetDevicesPendingAdoption: (Callback) => subscribe('SetDevicesPendingAdoption', Callback),
  SetFullClientList: (Callback) =>
    subscribe('SetFullClientList', Callback, (Clients, Groups) => [Clients, Groups]),
  SetScriptList: (Callback) => subscribe('SetScriptList', Callback),
  ClientUpdated: (Callback) => subscribe('ClientUpdated', Callback),
  UpdateScriptExecutions: (Callback) => subscribe('UpdateScriptExecutions', Callback),
  ShutdownRequested: (Callback) => subscribe('ShutdownRequested', Callback, () => []),
  USBDeviceAdded: (Callback) =>
    subscribe('USBDeviceAdded', Callback, (Client, Device) => [Client, Device]),
  USBDeviceRemoved: (Callback) =>
    subscribe('USBDeviceRemoved', Callback, (Client, Device) => [Client, Device]),
  UpdateSettings: (Callback) =>
    subscribe('UpdateSettings', Callback, (Settings, SettingsGroupps) => [
      Settings,
      SettingsGroupps,
    ]),
  SetSetting: async (Key, Value) => invoke('SetSetting', Key, Value),
  WakeOnLan: async (Targets) => invoke('WakeOnLan', Targets),
  UpdateClient: async (UUID, Data) => invoke('UpdateClient', UUID, Data),
  MarkClientUSBDeviceCritical: async (UUID, Device) =>
    invoke('MarkClientUSBDeviceCritical', UUID, Device),
  RemoveClientUSBDeviceCritical: async (UUID, SerialNumber) =>
    invoke('RemoveClientUSBDeviceCritical', UUID, SerialNumber),
  MarkClientApplicationCritical: async (UUID, Application) =>
    invoke('MarkClientApplicationCritical', UUID, Application),
  RemoveClientApplicationCritical: async (UUID, ApplicationName) =>
    invoke('RemoveClientApplicationCritical', UUID, ApplicationName),
  ExecuteScript: async (Script, Targets, ResetList) =>
    invoke('ExecuteScript', Script, Targets, ResetList),
  UnadoptClient: async (UUID) => invoke('UnadoptClient', UUID),
  ReplaceClient: async (CurrentUUID, ReplacementUUID) =>
    invoke('ReplaceClient', CurrentUUID, ReplacementUUID),
  DeleteScripts: async (List) => invoke('DeleteScripts', List),
  UpdateScripts: async (List) => invoke('UpdateScripts', List),
  // Script Manager (config editing)
  GetScriptManagerList: async () => invoke('Scripts:GetManagerList'),
  GetScriptConfig: async (ID) => invoke('Scripts:GetConfig', ID),
  SaveScriptConfig: async (ID, Fields) => invoke('Scripts:SaveConfig', ID, Fields),
  SetScriptOrder: async (OrderedIDs) => invoke('Scripts:SetOrder', OrderedIDs),
  DeleteScript: async (ID) => invoke('Scripts:Delete', ID),
  CreateScript: async () => invoke('Scripts:Create'),
  GetSampleScripts: async () => invoke('Scripts:GetSampleList'),
  RefreshSampleScripts: async () => invoke('Scripts:RefreshSamples'),
  CreateScriptFromTemplate: async (SampleID, DesiredID) =>
    invoke('Scripts:CreateFromTemplate', SampleID, DesiredID),
  OpenScriptFolder: async (ID) => invoke('Scripts:OpenFolder', ID),
  OpenScriptFile: async (ID, RelativeFilePath) => invoke('Scripts:OpenFile', ID, RelativeFilePath),
  RunScriptFileLocal: async (ID, RelativeFilePath) =>
    invoke('Scripts:RunLocalFile', ID, RelativeFilePath),
  // App update APIs
  CheckForAppUpdates: async () => invoke('AppUpdate:Check'),
  InstallAppUpdate: async () => invoke('AppUpdate:Install'),
  OnAppUpdateStatus: (cb) => subscribe('AppUpdate:Status', cb),
  // Monitoring Targets
  GetMonitoringMethods: async () => invoke('GetMonitoringMethods'),
  GetAllMonitoringTargets: async () => invoke('GetAllMonitoringTargets'),
  GetMonitoringTarget: async (TargetID) => invoke('GetMonitoringTarget', TargetID),
  GetMonitoringTargetHistory: async (TargetID) => invoke('GetMonitoringTargetHistory', TargetID),
  CreateMonitoringTarget: async (Payload) => invoke('CreateMonitoringTarget', Payload),
  UpdateMonitoringTarget: async (TargetID, Payload) =>
    invoke('UpdateMonitoringTarget', TargetID, Payload),
  DeleteMonitoringTarget: async (TargetID) => invoke('DeleteMonitoringTarget', TargetID),
  SetFullMonitoringTargetList: (Callback) => subscribe('SetFullMonitoringTargetList', Callback),
  MonitoringTargetUpdated: (Callback) => subscribe('MonitoringTargetUpdated', Callback),
  // Dummy Clients
  GetAllDummyClients: async () => invoke('GetAllDummyClients'),
  GetDummyClient: async (UUID) => invoke('GetDummyClient', UUID),
  GetDummyClientHistory: async (UUID) => invoke('GetDummyClientHistory', UUID),
  GenerateDummyClientDefaults: async () => invoke('GenerateDummyClientDefaults'),
  CreateDummyClient: async (Payload) => invoke('CreateDummyClient', Payload),
  UpdateDummyClient: async (UUID, Payload) => invoke('UpdateDummyClient', UUID, Payload),
  DeleteDummyClient: async (UUID) => invoke('DeleteDummyClient', UUID),
  SetFullDummyClientList: (Callback) => subscribe('SetFullDummyClientList', Callback),
  DummyClientUpdated: (Callback) => subscribe('DummyClientUpdated', Callback),
  StartNetworkDeviceScan: async (Options) => invoke('NetworkDiscovery:Start', Options),
  StopNetworkDeviceScan: async (ScanID) => invoke('NetworkDiscovery:Stop', ScanID),
  OnNetworkDeviceScanEvent: (Callback) => subscribe('NetworkDeviceScanEvent', Callback),
  // Alert Rules
  GetAlertTriggers: async () => invoke('GetAlertTriggers'),
  GetAlertActionTypes: async () => invoke('GetAlertActionTypes'),
  GetAllAlertRules: async () => invoke('GetAllAlertRules'),
  GetAlertRule: async (RuleID) => invoke('GetAlertRule', RuleID),
  CreateAlertRule: async (Payload) => invoke('CreateAlertRule', Payload),
  UpdateAlertRule: async (RuleID, Payload) => invoke('UpdateAlertRule', RuleID, Payload),
  DeleteAlertRule: async (RuleID) => invoke('DeleteAlertRule', RuleID),
  SetAlertRuleEnabled: async (RuleID, Enabled) => invoke('SetAlertRuleEnabled', RuleID, Enabled),
  GetAlertActionsEnabled: async () => invoke('AlertActionsEnabled:Get'),
  SetAlertActionsEnabled: async (Enabled) => invoke('AlertActionsEnabled:Set', Enabled),
  SetFullAlertRuleList: (Callback) => subscribe('SetFullAlertRuleList', Callback),
  AlertTriggered: (Callback) => subscribe('AlertTriggered', Callback),
  CreateShowTrakAlert: (Callback) => subscribe('CreateShowTrakAlert', Callback),
});
