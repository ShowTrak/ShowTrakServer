// Web UI transport shim for `window.API`.
//
// The browser runs the SAME renderer bundle as the Electron desktop app. The
// renderer talks to the backend exclusively through `window.API` (the typed
// ShowTrakAPI surface). On the desktop that object is the Electron preload
// bridge; here we provide an equivalent implementation backed by the `/ui`
// Socket.IO namespace:
//
//   - invoke-style methods  -> `socket.emit('rpc', channel, args, ack)`
//   - subscribe-style methods -> `socket.on(channel, cb)`
//
// Channels/args mirror `src/bridge_main.ts` exactly so both surfaces stay in
// lock-step (a drift guard test asserts the channel maps match). Desktop-only
// methods (file dialogs, show-file, script management, native/app updates,
// network discovery, settings mutation, mode/alert toggles) resolve to safe
// no-ops on the web — their UI triggers are hidden by the capability layer, and
// the server denies them regardless.

import type { ShowTrakAPI } from '@showtrak/protocol';

type Ack = { result?: unknown; error?: string };

/**
 * Minimal surface of the Socket.IO client socket the shim relies on. The real
 * client is a vendored browser global (no bundled types); `(...args: never[])`
 * on the handler slots lets any concrete callback be registered.
 */
export interface WebUiSocket {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, handler: (...args: never[]) => void): void;
  off(event: string, handler: (...args: never[]) => void): void;
  connect(): void;
}

// Build the rpc caller. Denials/failures resolve to an `[Err, null]` tuple —
// the dominant renderer return shape — so callers that destructure `[Err]`
// never throw. `T` is the per-channel return shape declared by ShowTrakAPI;
// the server is trusted to emit it (the assertions below are the single
// wire->type boundary).
function makeRpc(socket: WebUiSocket) {
  return <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve) => {
      try {
        socket.emit('rpc', channel, args, (res: Ack) => {
          if (res && Object.prototype.hasOwnProperty.call(res, 'result'))
            resolve(res.result as T);
          else resolve([res && res.error ? res.error : 'forbidden', null] as unknown as T);
        });
      } catch (e) {
        resolve([e instanceof Error ? e.message : String(e), null] as unknown as T);
      }
    });
}

// Build the subscribe binder. Returns an unsubscribe handle like the preload.
function makeSub(socket: WebUiSocket) {
  return <Args extends unknown[]>(
    channel: string,
    cb: (...payload: Args) => void
  ): (() => void) => {
    const handler = (...payload: never[]) => {
      try {
        cb(...(payload as unknown as Args));
      } catch {
        // Renderer callback errors must not break the socket.
      }
    };
    socket.on(channel, handler);
    return () => socket.off(channel, handler);
  };
}

// Create the `window.API` implementation for the web surface.
function createWebApi(socket: WebUiSocket): ShowTrakAPI {
  const rpc = makeRpc(socket);
  const sub = makeSub(socket);

  // Desktop-only no-op resolvers with shapes matching what callers expect.
  // Generic so each assignment adopts the ShowTrakAPI return type it stands in
  // for (the runtime values are fixed; the assertions only widen the type).
  const nullTuple = async <T>(): Promise<T> => [null, null] as unknown as T;
  const emptyArray = async <T>(): Promise<T> => [] as unknown as T;
  const resolveNull = async <T>(): Promise<T> => null as unknown as T;
  const resolveFalse = async () => false;
  const noSub = () => () => {};

  return {
    // ---- External links / meta (desktop-only; no-op on web) ---------------
    OpenDiscordInviteLinkInBrowser: async () =>
      window.open('https://discord.gg/showtrak', '_blank'),
    OpenShowTrakWebsiteInBrowser: async () => window.open('https://showtrak.io', '_blank'),
    OpenShowTrakGithubInBrowser: async () =>
      window.open('https://github.com/ShowTrak', '_blank'),
    OpenNpmPackageInBrowser: async (PackageName) =>
      window.open(`https://www.npmjs.com/package/${PackageName}`, '_blank'),
    OpenExternalUrl: async (URL) => {
      const Raw = String(URL || '').trim();
      if (/^https?:\/\//i.test(Raw)) window.open(Raw, '_blank', 'noopener');
      return undefined;
    },
    GetProjectDependencies: nullTuple,
    GetLicense: nullTuple,
    GetConfig: async () => rpc('Config:Get'),
    GetWebUIAddresses: nullTuple,
    OnNetworkInterfacesChanged: noSub,
    GetSettings: async () => rpc('Settings:Get'),

    // ---- Adoption / updates ----------------------------------------------
    AdoptDevice: async (UUID) => rpc('AdoptDevice', UUID),
    CheckForUpdatesOnClient: nullTuple,
    GetUpdateManagerStatus: nullTuple,
    GetUpdateManagerReleases: nullTuple,
    DownloadUpdateManagerRelease: nullTuple,
    DeployUpdateManagerRelease: nullTuple,
    OnUpdateManagerDownloadProgress: noSub,

    // ---- Lifecycle (desktop-only) ----------------------------------------
    Loaded: resolveNull,
    Shutdown: resolveNull,

    // ---- Clients ----------------------------------------------------------
    GetClient: async (UUID) => rpc('GetClient', UUID),
    GetClientHistory: async (UUID) => rpc('GetClientHistory', UUID),
    GetClientApplicationHistory: async (UUID) => rpc('GetClientApplicationHistory', UUID),
    GetClientUSBHistory: async (UUID) => rpc('GetClientUSBHistory', UUID),
    GetClientDisplayHistory: async (UUID) => rpc('GetClientDisplayHistory', UUID),
    UpdateClient: async (UUID, Data) => rpc('UpdateClient', UUID, Data),
    MarkClientUSBDeviceCritical: async (UUID, Device) =>
      rpc('MarkClientUSBDeviceCritical', UUID, Device),
    RemoveClientUSBDeviceCritical: async (UUID, SerialNumber) =>
      rpc('RemoveClientUSBDeviceCritical', UUID, SerialNumber),
    MarkClientUSBNameCritical: async (UUID, Device) =>
      rpc('MarkClientUSBNameCritical', UUID, Device),
    RemoveClientUSBNameCritical: async (UUID, Device) =>
      rpc('RemoveClientUSBNameCritical', UUID, Device),
    MarkClientApplicationCritical: async (UUID, Application) =>
      rpc('MarkClientApplicationCritical', UUID, Application),
    RemoveClientApplicationCritical: async (UUID, ApplicationName) =>
      rpc('RemoveClientApplicationCritical', UUID, ApplicationName),
    MarkClientDisplayCritical: async (UUID, Display) =>
      rpc('MarkClientDisplayCritical', UUID, Display),
    RemoveClientDisplayCritical: async (UUID, DisplayID) =>
      rpc('RemoveClientDisplayCritical', UUID, DisplayID),
    IdentifyClient: async (UUID) => rpc('IdentifyClient', UUID),
    StopIdentifyingClient: async (UUID) => rpc('StopIdentifyingClient', UUID),
    UnadoptClient: async (UUID) => rpc('UnadoptClient', UUID),
    ReplaceClient: async (CurrentUUID, ReplacementUUID) =>
      rpc('ReplaceClient', CurrentUUID, ReplacementUUID),
    CreateUnassignedClients: async (Payload) => rpc('CreateUnassignedClients', Payload),
    WakeOnLan: async (Targets) => rpc('WakeOnLan', Targets),

    // ---- Groups -----------------------------------------------------------
    GetAllGroups: async () => rpc('GetAllGroups'),
    CreateGroup: async (Title) => rpc('CreateGroup', Title),
    RenameGroup: async (GroupID, Title) => rpc('RenameGroup', GroupID, Title),
    DeleteGroup: async (GroupID) => rpc('DeleteGroup', GroupID),
    SetGroupListOrder: async (OrderedGroupIDs) => rpc('Groups:SetOrder', OrderedGroupIDs),
    SetGroupFullWidth: async (GroupID, FullWidth) =>
      rpc('Groups:SetFullWidth', GroupID, FullWidth),
    SetGroupKeyBind: async (GroupID, KeyBind) =>
      rpc('Groups:SetKeyBind', GroupID, KeyBind),
    SetGroupSlug: async (GroupID, Slug) => rpc('Groups:SetSlug', GroupID, Slug),
    SetGroupOrder: async (GroupID, OrderedUUIDs) =>
      rpc('SetGroupOrder', GroupID, OrderedUUIDs),

    // ---- Show file (desktop-only) ----------------------------------------
    NewShow: nullTuple,
    SaveShow: nullTuple,
    SaveShowAs: nullTuple,
    OpenShow: nullTuple,
    GetCurrentShowFile: resolveNull,
    HasUnsavedShowData: resolveFalse,
    EnsureShowFileExists: emptyArray,
    OnShowFileUpdated: noSub,

    // ---- Folders / menu / window (desktop-only) --------------------------
    OpenLogsFolder: resolveNull,
    OpenScriptsFolder: resolveNull,
    OnAppMenuAction: noSub,
    OnWindowFullscreenChanged: noSub,

    // ---- Mode (read mirrors server; set is desktop-only) -----------------
    GetMode: async () => rpc('Mode:Get'),
    SetMode: resolveNull,
    OnModeUpdated: (cb) => sub('ModeUpdated', cb),
    OnAlertActionsUpdated: (cb) => sub('AlertActionsUpdated', cb),

    // ---- Settings (read blocked / mutation desktop-only) -----------------
    SetSetting: nullTuple,
    UpdateSettings: noSub,

    // ---- OSC / traffic / toasts ------------------------------------------
    OSCBulkAction: (cb) => sub('OSCBulkAction', cb),
    PlaySound: (cb) => sub('PlaySound', cb),
    Notify: (cb) => sub('Notify', cb),
    DebugTrafficEntry: (cb) => sub('DebugTrafficEntry', cb),
    SetOSCList: (cb) => sub('SetOSCList', cb),

    // ---- Client list / telemetry subscriptions ---------------------------
    SetDevicesPendingAdoption: (cb) => sub('SetDevicesPendingAdoption', cb),
    SetFullClientList: (cb) => sub('SetFullClientList', cb),
    SetScriptList: (cb) => sub('SetScriptList', cb),
    ClientUpdated: (cb) => sub('ClientUpdated', cb),
    UpdateScriptExecutions: (cb) => sub('UpdateScriptExecutions', cb),
    ShutdownRequested: noSub,
    USBDeviceAdded: (cb) => sub('USBDeviceAdded', cb),
    USBDeviceRemoved: (cb) => sub('USBDeviceRemoved', cb),

    // ---- Scripts: execution allowed; management desktop-only -------------
    ExecuteScript: async (Script, Targets, ResetList) =>
      rpc('ExecuteScript', Script, Targets, ResetList),
    TriggerIntegratedEvent: async (EventID, Targets) =>
      rpc('TriggerIntegratedEvent', EventID, Targets),
    DeleteScripts: nullTuple,
    UpdateScripts: nullTuple,
    GetScriptManagerList: emptyArray,
    GetScriptConfig: nullTuple,
    SaveScriptConfig: nullTuple,
    GetScriptWhitelist: nullTuple,
    SetScriptWhitelist: nullTuple,
    SetScriptOrder: nullTuple,
    DeleteScript: nullTuple,
    CreateScript: nullTuple,
    GetSampleScripts: nullTuple,
    RefreshSampleScripts: nullTuple,
    CreateScriptFromTemplate: nullTuple,
    OpenScriptFolder: nullTuple,
    OpenScriptFile: nullTuple,
    RunScriptFileLocal: nullTuple,

    // ---- App update (desktop-only) ---------------------------------------
    CheckForAppUpdates: nullTuple,
    InstallAppUpdate: nullTuple,
    OnAppUpdateStatus: noSub,

    // ---- Monitoring targets ----------------------------------------------
    GetMonitoringMethods: async () => rpc('GetMonitoringMethods'),
    GetAllMonitoringTargets: async () => rpc('GetAllMonitoringTargets'),
    GetMonitoringTarget: async (TargetID) => rpc('GetMonitoringTarget', TargetID),
    GetMonitoringCheckHistory: async (CheckID) => rpc('GetMonitoringCheckHistory', CheckID),
    GetMonitoringCheckDebug: async (CheckID) => rpc('GetMonitoringCheckDebug', CheckID),
    RunMonitoringCheckNow: async (CheckID) => rpc('RunMonitoringCheckNow', CheckID),
    RunAllMonitoringChecksNow: async (TargetID) => rpc('RunAllMonitoringChecksNow', TargetID),
    CreateMonitoringTarget: async (Payload) => rpc('CreateMonitoringTarget', Payload),
    UpdateMonitoringTarget: async (TargetID, Payload) =>
      rpc('UpdateMonitoringTarget', TargetID, Payload),
    DeleteMonitoringTarget: async (TargetID) => rpc('DeleteMonitoringTarget', TargetID),
    SetFullMonitoringTargetList: (cb) => sub('SetFullMonitoringTargetList', cb),
    MonitoringTargetUpdated: (cb) => sub('MonitoringTargetUpdated', cb),

    // ---- Dummy clients ----------------------------------------------------
    GetAllDummyClients: async () => rpc('GetAllDummyClients'),
    GetDummyClient: async (UUID) => rpc('GetDummyClient', UUID),
    GetDummyClientHistory: async (UUID) => rpc('GetDummyClientHistory', UUID),
    GenerateDummyClientDefaults: async () => rpc('GenerateDummyClientDefaults'),
    CreateDummyClient: async (Payload) => rpc('CreateDummyClient', Payload),
    UpdateDummyClient: async (UUID, Payload) => rpc('UpdateDummyClient', UUID, Payload),
    DeleteDummyClient: async (UUID) => rpc('DeleteDummyClient', UUID),
    ResetDummyClientToIdle: async (UUID) => rpc('ResetDummyClientToIdle', UUID),
    SetFullDummyClientList: (cb) => sub('SetFullDummyClientList', cb),
    DummyClientUpdated: (cb) => sub('DummyClientUpdated', cb),

    // ---- Network discovery (desktop-only) --------------------------------
    StartNetworkDeviceScan: nullTuple,
    StopNetworkDeviceScan: nullTuple,
    OnNetworkDeviceScanEvent: noSub,

    // ---- Alert rules ------------------------------------------------------
    GetAlertTriggers: async () => rpc('GetAlertTriggers'),
    GetAlertActionTypes: async () => rpc('GetAlertActionTypes'),
    GetAllAlertRules: async () => rpc('GetAllAlertRules'),
    GetAlertRule: async (RuleID) => rpc('GetAlertRule', RuleID),
    CreateAlertRule: async (Payload) => rpc('CreateAlertRule', Payload),
    UpdateAlertRule: async (RuleID, Payload) => rpc('UpdateAlertRule', RuleID, Payload),
    DeleteAlertRule: async (RuleID) => rpc('DeleteAlertRule', RuleID),
    SetAlertRuleEnabled: async (RuleID, Enabled) =>
      rpc('SetAlertRuleEnabled', RuleID, Enabled),
    GetAlertActionsEnabled: async () => rpc('AlertActionsEnabled:Get'),
    // Web sessions can never toggle alert actions off; keep the UI's optimistic
    // value by echoing the requested state without hitting the server.
    SetAlertActionsEnabled: async (Enabled) => !!Enabled,
    SetFullAlertRuleList: (cb) => sub('SetFullAlertRuleList', cb),
    AlertTriggered: (cb) => sub('AlertTriggered', cb),
    CreateShowTrakAlert: (cb) => sub('CreateShowTrakAlert', cb),

    // ---- Tags (management desktop-only; no-op on web) --------------------
    GetAllTags: emptyArray,
    CreateTag: nullTuple,
    SetTagSlug: nullTuple,
    SetTagColour: nullTuple,
    SetTagIcon: nullTuple,
    SetTagScope: nullTuple,
    SetTagOrder: nullTuple,
    DeleteTag: nullTuple,
    OnSetTagList: noSub,

    // ---- Custom audio assets (read allowed; management desktop-only) -----
    GetAudioAssets: async () => rpc('Audio:GetAll'),
    GetAudioAssetData: async (ID) => rpc('Audio:GetData', ID),
    SelectAudioAssetFiles: nullTuple,
    ImportAudioAsset: nullTuple,
    UpdateAudioAsset: nullTuple,
    DeleteAudioAsset: nullTuple,
    OpenAudioAssetsFolder: resolveNull,
    PlayCustomAudio: (cb) => sub('PlayCustomAudio', cb),
    OnAudioAssetsUpdated: (cb) => sub('AudioAssetsUpdated', cb),
  };
}

export { createWebApi };
