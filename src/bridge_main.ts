const { contextBridge, ipcRenderer } = require('electron');
import type {
  ClientView,
  GroupView,
  OSCBulkActionType,
  SettingGroupView,
  SettingView,
  ShowTrakAPI,
  USBDevice,
} from '@showtrak/protocol';
import type { InvokeChannel, SubscribeChannel } from './Modules/IPCRegistry/channels';

// Compile-time exhaustiveness helper: instantiating it with a non-never type
// (a registry channel missing from an inline list) fails the build.
type AssertAllChannelsListed<T extends never> = T;

// NOTE: This file is a SANDBOXED preload script. Its `require` can only resolve
// Electron built-ins, NOT local files — so the channel allowlists must be
// inlined here (they cannot be imported from src/Modules/IPCRegistry/channels
// at runtime). The registry remains the single source of truth and drift is a
// COMPILE error: the type-only imports below are erased from the emitted JS,
// `satisfies` rejects any entry not present in the registry, and the
// `_Missing*Channels` aliases reject a registry channel missing from these
// lists. test/ipc-channel-registry.test.js re-checks the same at runtime.
const INVOKE_CHANNEL_LIST = [
  'OpenDiscordInviteLinkInBrowser',
  'OpenShowTrakWebsiteInBrowser',
  'OpenShowTrakGithubInBrowser',
  'OpenNpmPackageInBrowser',
  'OpenExternalUrl',
  'GetProjectDependencies',
  'GetLicense',
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
  'GetClientHistory',
  'GetClientApplicationHistory',
  'GetClientUSBHistory',
  'GetClientDisplayHistory',
  'GetAllGroups',
  'CreateGroup',
  'RenameGroup',
  'DeleteGroup',
  'Groups:SetOrder',
  'Groups:SetFullWidth',
  'Groups:SetKeyBind',
  'Groups:SetSlug',
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
  'MarkClientUSBNameCritical',
  'RemoveClientUSBNameCritical',
  'MarkClientApplicationCritical',
  'RemoveClientApplicationCritical',
  'MarkClientDisplayCritical',
  'RemoveClientDisplayCritical',
  'AddClientMacAddress',
  'RemoveClientMacAddress',
  'IdentifyClient',
  'StopIdentifyingClient',
  'ExecuteScript',
  'TriggerIntegratedEvent',
  'Scripts:ClearSettledExecutions',
  'UnadoptClient',
  'ReplaceClient',
  'CreateUnassignedClients',
  'DeleteScripts',
  'UpdateScripts',
  'Scripts:GetManagerList',
  'Scripts:GetConfig',
  'Scripts:SaveConfig',
  'Scripts:GetWhitelist',
  'Scripts:SetWhitelist',
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
  'GetMonitoringCheckHistory',
  'GetMonitoringCheckDebug',
  'RunMonitoringCheckNow',
  'RunAllMonitoringChecksNow',
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
  'ResetDummyClientToIdle',
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
  'Tags:GetAll',
  'Tags:Create',
  'Tags:SetSlug',
  'Tags:SetColour',
  'Tags:SetIcon',
  'Tags:SetScope',
  'Tags:SetOrder',
  'Tags:Delete',
  'Fog:GetStatus',
  'Fog:TestConnection',
  'Fog:GetHosts',
  'Fog:GetHostLink',
  'Fog:SetHostLink',
  'Fog:GetTaskTypes',
  'Fog:GetTasks',
  'Fog:ScheduleTask',
  'Fog:CancelTask',
  'Fog:ClearFinishedTasks',
  'Audio:GetAll',
  'Audio:GetData',
  'Audio:Select',
  'Audio:Import',
  'Audio:Update',
  'Audio:Delete',
  'Audio:OpenFolder',
] as const satisfies readonly InvokeChannel[];
type _MissingInvokeChannels = AssertAllChannelsListed<
  Exclude<InvokeChannel, (typeof INVOKE_CHANNEL_LIST)[number]>
>;
const INVOKE_CHANNELS = new Set<string>(INVOKE_CHANNEL_LIST);

const SUBSCRIBE_CHANNEL_LIST = [
  'AppMenuAction',
  'ModeUpdated',
  'AlertActionsUpdated',
  'OSCBulkAction',
  'PlaySound',
  'PlayCustomAudio',
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
  'SetTagList',
  'AlertTriggered',
  'CreateShowTrakAlert',
  'AudioAssetsUpdated',
  'UpdateManager:DownloadProgress',
  'ShowFileUpdated',
  'MainWindowFullscreenChanged',
  'NetworkInterfacesChanged',
  'FogStatusUpdated',
  'SetFogTaskList',
] as const satisfies readonly SubscribeChannel[];
type _MissingSubscribeChannels = AssertAllChannelsListed<
  Exclude<SubscribeChannel, (typeof SUBSCRIBE_CHANNEL_LIST)[number]>
>;
const SUBSCRIBE_CHANNELS = new Set<string>(SUBSCRIBE_CHANNEL_LIST);

function invoke<T = unknown>(channel: InvokeChannel, ...args: unknown[]): Promise<T> {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked invoke channel: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe<Args extends unknown[], Payload extends unknown[] = Args>(
  channel: SubscribeChannel,
  callback: (...args: Args) => void,
  mapper: (...payload: Payload) => Args = (...payload: Payload) => payload as unknown as Args
) {
  if (!SUBSCRIBE_CHANNELS.has(channel)) {
    throw new Error(`Blocked subscribe channel: ${channel}`);
  }
  if (typeof callback !== 'function') {
    throw new TypeError(`Callback for ${channel} must be a function`);
  }

  const handler = (_event: unknown, ...payload: unknown[]) => {
    callback(...mapper(...(payload as Payload)));
  };

  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const API: ShowTrakAPI = {
  OpenDiscordInviteLinkInBrowser: async () => invoke('OpenDiscordInviteLinkInBrowser'),
  OpenShowTrakWebsiteInBrowser: async () => invoke('OpenShowTrakWebsiteInBrowser'),
  OpenShowTrakGithubInBrowser: async () => invoke('OpenShowTrakGithubInBrowser'),
  OpenNpmPackageInBrowser: async (PackageName) =>
    invoke('OpenNpmPackageInBrowser', PackageName),
  OpenExternalUrl: async (URL) => invoke('OpenExternalUrl', URL),
  GetProjectDependencies: async () => invoke('GetProjectDependencies'),
  GetLicense: async () => invoke('GetLicense'),
  GetConfig: async () => invoke('Config:Get'),
  GetWebUIAddresses: async () => invoke('WebUI:GetAddresses'),
  OnNetworkInterfacesChanged: (Callback) => subscribe('NetworkInterfacesChanged', Callback),
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
  GetClientHistory: async (UUID) => invoke('GetClientHistory', UUID),
  GetClientApplicationHistory: async (UUID) => invoke('GetClientApplicationHistory', UUID),
  GetClientUSBHistory: async (UUID) => invoke('GetClientUSBHistory', UUID),
  GetClientDisplayHistory: async (UUID) => invoke('GetClientDisplayHistory', UUID),
  GetAllGroups: async () => invoke('GetAllGroups'),
  CreateGroup: async (Title) => invoke('CreateGroup', Title),
  RenameGroup: async (GroupID, Title) => invoke('RenameGroup', GroupID, Title),
  DeleteGroup: async (GroupID) => invoke('DeleteGroup', GroupID),
  SetGroupListOrder: async (OrderedGroupIDs) => invoke('Groups:SetOrder', OrderedGroupIDs),
  SetGroupFullWidth: async (GroupID, FullWidth) =>
    invoke('Groups:SetFullWidth', GroupID, FullWidth),
  SetGroupKeyBind: async (GroupID, KeyBind) =>
    invoke('Groups:SetKeyBind', GroupID, KeyBind),
  SetGroupSlug: async (GroupID, Slug) => invoke('Groups:SetSlug', GroupID, Slug),
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
  SetGroupOrder: async (GroupID, OrderedUUIDs) =>
    invoke('SetGroupOrder', GroupID, OrderedUUIDs),
  // Application Mode API
  GetMode: async () => invoke('Mode:Get'),
  SetMode: async (Mode) => invoke('Mode:Set', Mode),
  OnModeUpdated: (Callback) => subscribe('ModeUpdated', Callback),
  OnAlertActionsUpdated: (Callback) => subscribe('AlertActionsUpdated', Callback),
  OSCBulkAction: (Callback) =>
    subscribe(
      'OSCBulkAction',
      Callback,
      (Type: OSCBulkActionType, Targets: string[], Args: string | null = null): [OSCBulkActionType, string[], string | null] => [Type, Targets, Args]
    ),
  PlaySound: (Callback) => subscribe('PlaySound', Callback),
  Notify: (Callback) =>
    subscribe(
      'Notify',
      Callback,
      (Message: string, Type: string, Duration: number): [string, string, number] => [
        Message,
        Type,
        Duration,
      ]
    ),
  DebugTrafficEntry: (Callback) => subscribe('DebugTrafficEntry', Callback),
  SetOSCList: (Callback) => subscribe('SetOSCList', Callback),
  SetDevicesPendingAdoption: (Callback) => subscribe('SetDevicesPendingAdoption', Callback),
  SetFullClientList: (Callback) =>
    subscribe(
      'SetFullClientList',
      Callback,
      (Clients: ClientView[], Groups: GroupView[]): [ClientView[], GroupView[]] => [
        Clients,
        Groups,
      ]
    ),
  SetScriptList: (Callback) => subscribe('SetScriptList', Callback),
  ClientUpdated: (Callback) => subscribe('ClientUpdated', Callback),
  UpdateScriptExecutions: (Callback) => subscribe('UpdateScriptExecutions', Callback),
  ShutdownRequested: (Callback) => subscribe('ShutdownRequested', Callback, (): [] => []),
  USBDeviceAdded: (Callback) =>
    subscribe(
      'USBDeviceAdded',
      Callback,
      (Client: ClientView, Device: USBDevice): [ClientView, USBDevice] => [Client, Device]
    ),
  USBDeviceRemoved: (Callback) =>
    subscribe(
      'USBDeviceRemoved',
      Callback,
      (Client: ClientView, Device: USBDevice): [ClientView, USBDevice] => [Client, Device]
    ),
  UpdateSettings: (Callback) =>
    subscribe(
      'UpdateSettings',
      Callback,
      (Settings: SettingView[], SettingsGroups: SettingGroupView[]): [SettingView[], SettingGroupView[]] => [Settings, SettingsGroups]
    ),
  SetSetting: async (Key, Value) => invoke('SetSetting', Key, Value),
  WakeOnLan: async (Targets) => invoke('WakeOnLan', Targets),
  IdentifyClient: async (UUID) => invoke('IdentifyClient', UUID),
  StopIdentifyingClient: async (UUID) => invoke('StopIdentifyingClient', UUID),
  UpdateClient: async (UUID, Data) => invoke('UpdateClient', UUID, Data),
  MarkClientUSBDeviceCritical: async (UUID, Device) =>
    invoke('MarkClientUSBDeviceCritical', UUID, Device),
  RemoveClientUSBDeviceCritical: async (UUID, SerialNumber) =>
    invoke('RemoveClientUSBDeviceCritical', UUID, SerialNumber),
  MarkClientUSBNameCritical: async (UUID, Device) =>
    invoke('MarkClientUSBNameCritical', UUID, Device),
  RemoveClientUSBNameCritical: async (UUID, Device) =>
    invoke('RemoveClientUSBNameCritical', UUID, Device),
  MarkClientApplicationCritical: async (UUID, Application) =>
    invoke('MarkClientApplicationCritical', UUID, Application),
  RemoveClientApplicationCritical: async (UUID, ApplicationName) =>
    invoke('RemoveClientApplicationCritical', UUID, ApplicationName),
  MarkClientDisplayCritical: async (UUID, Display) =>
    invoke('MarkClientDisplayCritical', UUID, Display),
  RemoveClientDisplayCritical: async (UUID, DisplayID) =>
    invoke('RemoveClientDisplayCritical', UUID, DisplayID),
  AddClientMacAddress: async (UUID, MacAddress) =>
    invoke('AddClientMacAddress', UUID, MacAddress),
  RemoveClientMacAddress: async (UUID, MacAddress) =>
    invoke('RemoveClientMacAddress', UUID, MacAddress),
  ExecuteScript: async (Script, Targets, ResetList) =>
    invoke('ExecuteScript', Script, Targets, ResetList),
  TriggerIntegratedEvent: async (EventID, Targets) =>
    invoke('TriggerIntegratedEvent', EventID, Targets),
  ClearSettledScriptExecutions: async () => invoke('Scripts:ClearSettledExecutions'),
  UnadoptClient: async (UUID) => invoke('UnadoptClient', UUID),
  ReplaceClient: async (CurrentUUID, ReplacementUUID) =>
    invoke('ReplaceClient', CurrentUUID, ReplacementUUID),
  CreateUnassignedClients: async (Payload) => invoke('CreateUnassignedClients', Payload),
  DeleteScripts: async (List) => invoke('DeleteScripts', List),
  UpdateScripts: async (List) => invoke('UpdateScripts', List),
  // Script Manager (config editing)
  GetScriptManagerList: async () => invoke('Scripts:GetManagerList'),
  GetScriptConfig: async (ID) => invoke('Scripts:GetConfig', ID),
  SaveScriptConfig: async (ID, Fields) => invoke('Scripts:SaveConfig', ID, Fields),
  GetScriptWhitelist: async (ID) => invoke('Scripts:GetWhitelist', ID),
  SetScriptWhitelist: async (ID, Scope) => invoke('Scripts:SetWhitelist', ID, Scope),
  SetScriptOrder: async (OrderedIDs) => invoke('Scripts:SetOrder', OrderedIDs),
  DeleteScript: async (ID) => invoke('Scripts:Delete', ID),
  CreateScript: async () => invoke('Scripts:Create'),
  GetSampleScripts: async () => invoke('Scripts:GetSampleList'),
  RefreshSampleScripts: async () => invoke('Scripts:RefreshSamples'),
  CreateScriptFromTemplate: async (SampleID, DesiredID) =>
    invoke('Scripts:CreateFromTemplate', SampleID, DesiredID),
  OpenScriptFolder: async (ID) => invoke('Scripts:OpenFolder', ID),
  OpenScriptFile: async (ID, RelativeFilePath) =>
    invoke('Scripts:OpenFile', ID, RelativeFilePath),
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
  GetMonitoringCheckHistory: async (CheckID) => invoke('GetMonitoringCheckHistory', CheckID),
  GetMonitoringCheckDebug: async (CheckID) => invoke('GetMonitoringCheckDebug', CheckID),
  RunMonitoringCheckNow: async (CheckID) => invoke('RunMonitoringCheckNow', CheckID),
  RunAllMonitoringChecksNow: async (TargetID) =>
    invoke('RunAllMonitoringChecksNow', TargetID),
  CreateMonitoringTarget: async (Payload) => invoke('CreateMonitoringTarget', Payload),
  UpdateMonitoringTarget: async (TargetID, Payload) =>
    invoke('UpdateMonitoringTarget', TargetID, Payload),
  DeleteMonitoringTarget: async (TargetID) => invoke('DeleteMonitoringTarget', TargetID),
  SetFullMonitoringTargetList: (Callback) =>
    subscribe('SetFullMonitoringTargetList', Callback),
  MonitoringTargetUpdated: (Callback) => subscribe('MonitoringTargetUpdated', Callback),
  // Dummy Clients
  GetAllDummyClients: async () => invoke('GetAllDummyClients'),
  GetDummyClient: async (UUID) => invoke('GetDummyClient', UUID),
  GetDummyClientHistory: async (UUID) => invoke('GetDummyClientHistory', UUID),
  GenerateDummyClientDefaults: async () => invoke('GenerateDummyClientDefaults'),
  CreateDummyClient: async (Payload) => invoke('CreateDummyClient', Payload),
  UpdateDummyClient: async (UUID, Payload) => invoke('UpdateDummyClient', UUID, Payload),
  DeleteDummyClient: async (UUID) => invoke('DeleteDummyClient', UUID),
  ResetDummyClientToIdle: async (UUID) => invoke('ResetDummyClientToIdle', UUID),
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
  SetAlertRuleEnabled: async (RuleID, Enabled) =>
    invoke('SetAlertRuleEnabled', RuleID, Enabled),
  GetAlertActionsEnabled: async () => invoke('AlertActionsEnabled:Get'),
  SetAlertActionsEnabled: async (Enabled) => invoke('AlertActionsEnabled:Set', Enabled),
  SetFullAlertRuleList: (Callback) => subscribe('SetFullAlertRuleList', Callback),
  AlertTriggered: (Callback) => subscribe('AlertTriggered', Callback),
  CreateShowTrakAlert: (Callback) => subscribe('CreateShowTrakAlert', Callback),
  // Tags
  GetAllTags: async () => invoke('Tags:GetAll'),
  CreateTag: async (Label) => invoke('Tags:Create', Label),
  SetTagSlug: async (TagID, Slug) => invoke('Tags:SetSlug', TagID, Slug),
  SetTagColour: async (TagID, Colour) => invoke('Tags:SetColour', TagID, Colour),
  SetTagIcon: async (TagID, Icon) => invoke('Tags:SetIcon', TagID, Icon),
  SetTagScope: async (TagID, Scope) => invoke('Tags:SetScope', TagID, Scope),
  SetTagOrder: async (OrderedTagIDs) => invoke('Tags:SetOrder', OrderedTagIDs),
  DeleteTag: async (TagID) => invoke('Tags:Delete', TagID),
  OnSetTagList: (Callback) => subscribe('SetTagList', Callback),
  // FOG Project integration
  GetFogStatus: async () => invoke('Fog:GetStatus'),
  TestFogConnection: async () => invoke('Fog:TestConnection'),
  GetFogHosts: async () => invoke('Fog:GetHosts'),
  GetFogHostLink: async (UUID) => invoke('Fog:GetHostLink', UUID),
  SetFogHostLink: async (UUID, FogHostID) => invoke('Fog:SetHostLink', UUID, FogHostID),
  GetFogTaskTypes: async () => invoke('Fog:GetTaskTypes'),
  GetFogTasks: async () => invoke('Fog:GetTasks'),
  ScheduleFogTask: async (UUID, TaskTypeID, SnapinID) =>
    invoke('Fog:ScheduleTask', UUID, TaskTypeID, SnapinID),
  CancelFogTask: async (FogTaskRecordID) => invoke('Fog:CancelTask', FogTaskRecordID),
  ClearFinishedFogTasks: async () => invoke('Fog:ClearFinishedTasks'),
  OnFogStatusUpdated: (Callback) => subscribe('FogStatusUpdated', Callback),
  OnSetFogTaskList: (Callback) => subscribe('SetFogTaskList', Callback),
  // Custom Audio Assets
  GetAudioAssets: async () => invoke('Audio:GetAll'),
  GetAudioAssetData: async (ID) => invoke('Audio:GetData', ID),
  SelectAudioAssetFiles: async () => invoke('Audio:Select'),
  ImportAudioAsset: async (Payload) => invoke('Audio:Import', Payload),
  UpdateAudioAsset: async (ID, Payload) => invoke('Audio:Update', ID, Payload),
  DeleteAudioAsset: async (ID) => invoke('Audio:Delete', ID),
  OpenAudioAssetsFolder: async () => invoke('Audio:OpenFolder'),
  PlayCustomAudio: (Callback) => subscribe('PlayCustomAudio', Callback),
  OnAudioAssetsUpdated: (Callback) => subscribe('AudioAssetsUpdated', Callback),
};

contextBridge.exposeInMainWorld('API', API);

export {};
