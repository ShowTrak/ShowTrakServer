// IPC channel registry — single source of truth for renderer-facing IPC.
//
// Every channel the renderer is allowed to `invoke()` (request/response) or
// `subscribe()` (main -> renderer push) is declared here ONCE. The preload
// bridge (src/bridge_main.js) imports these to build its allowlists, and the
// main process registrars register handlers for the INVOKE channels.
//
// A guard test (test/ipc-channel-registry.test.js) asserts that the set of
// `RPC.handle('...')` registrations across the main process exactly matches
// INVOKE_CHANNELS, so adding a handler without allowlisting it (or leaving a
// dead allowlist entry) fails CI instead of silently breaking the renderer.
//
// Grouping below is purely organisational; ordering is not significant.

// Renderer -> main request/response channels (ipcRenderer.invoke).
const INVOKE_CHANNELS = [
  // External links / about
  'OpenDiscordInviteLinkInBrowser',
  'OpenShowTrakWebsiteInBrowser',
  'OpenShowTrakGithubInBrowser',
  'OpenNpmPackageInBrowser',
  'GetProjectDependencies',

  // Core / lifecycle
  'Config:Get',
  'WebUI:GetAddresses',
  'Settings:Get',
  'SetSetting',
  'Loaded',
  'Shutdown',
  'Mode:Get',
  'Mode:Set',
  'OpenLogsFolder',
  'OpenScriptsFolder',

  // Clients
  'GetClient',
  'AdoptDevice',
  'UpdateClient',
  'UnadoptClient',
  'ReplaceClient',
  'WakeOnLan',
  'MarkClientUSBDeviceCritical',
  'RemoveClientUSBDeviceCritical',
  'MarkClientApplicationCritical',
  'RemoveClientApplicationCritical',

  // Client self-update
  'CheckForUpdatesOnClient',
  'UpdateManager:GetStatus',
  'UpdateManager:GetReleases',
  'UpdateManager:DownloadRelease',
  'UpdateManager:DeployRelease',

  // Groups
  'GetAllGroups',
  'CreateGroup',
  'RenameGroup',
  'DeleteGroup',
  'Groups:SetOrder',
  'SetGroupOrder',

  // Show files
  'Show:New',
  'Show:Save',
  'Show:SaveAs',
  'Show:Open',
  'Show:GetCurrentFile',
  'Show:HasUnsavedData',
  'Show:EnsureFileExists',

  // Scripts / execution
  'ExecuteScript',
  'TriggerIntegratedEvent',
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

  // Application self-update
  'AppUpdate:Check',
  'AppUpdate:Install',

  // Monitoring targets
  'GetMonitoringMethods',
  'GetAllMonitoringTargets',
  'GetMonitoringTarget',
  'GetMonitoringTargetHistory',
  'CreateMonitoringTarget',
  'UpdateMonitoringTarget',
  'DeleteMonitoringTarget',

  // Dummy clients
  'GetAllDummyClients',
  'GetDummyClient',
  'GetDummyClientHistory',
  'GenerateDummyClientDefaults',
  'CreateDummyClient',
  'UpdateDummyClient',
  'DeleteDummyClient',

  // Network discovery
  'NetworkDiscovery:Start',
  'NetworkDiscovery:Stop',

  // Alerts
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

  // Audio assets
  'Audio:GetAll',
  'Audio:GetData',
  'Audio:Select',
  'Audio:Import',
  'Audio:Update',
  'Audio:Delete',
  'Audio:OpenFolder',
];

// Main -> renderer push channels (webContents.send / ipcRenderer.on).
const SUBSCRIBE_CHANNELS = [
  'AppMenuAction',
  'ModeUpdated',
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
  'AlertTriggered',
  'CreateShowTrakAlert',
  'AudioAssetsUpdated',
  'UpdateManager:DownloadProgress',
  'ShowFileUpdated',
  'MainWindowFullscreenChanged',
];

module.exports = { INVOKE_CHANNELS, SUBSCRIBE_CHANNELS };
