// Typed contract for the Electron preload bridge (`window.API`).
//
// This is the single source of truth for the renderer <-> main IPC surface.
// It is implemented by `src/bridge_main.ts` (the sandboxed preload) and consumed
// by the desktop renderer (`src/UI`) via the `Window.API` global augmentation.
//
// The set of channels here MUST stay in lock-step with:
//   - src/Modules/IPCRegistry/channels.ts (INVOKE + SUBSCRIBE arrays)
//   - the inlined allowlist Sets in src/bridge_main.ts
// (test/ipc-channel-registry.test.js guards that drift.)
//
// Return types are concrete where the shape is well-established and `unknown`
// where the payload is opaque/dynamic; the latter are tightened as the renderer
// files are migrated and their real usage is known.

import type { USBDevice } from './telemetry';
import type {
  AlertActionType,
  AlertRuleView,
  AlertTriggerType,
  AlertTriggeredEvent,
  AppConfig,
  AppUpdateStatus,
  AudioAssetData,
  AudioAssetInspection,
  AudioAssetView,
  ClientApplicationHistorySeries,
  ClientDisplayHistorySeries,
  ClientUSBHistorySeries,
  ClientView,
  DebugTrafficEntry,
  DummyClientDefaults,
  DummyClientView,
  GroupView,
  HistorySample,
  MonitoringCheckDebug,
  MonitoringMethodView,
  MonitoringTargetView,
  NetworkScanEvent,
  OSCBulkActionType,
  OSCRoute,
  ScriptCatalogEntry,
  ScriptEditable,
  ScriptExecutionView,
  ScriptManagerEntry,
  ScriptWhitelistScope,
  SettingGroupView,
  SettingView,
  ShowTrakAlert,
  UpdateDeployResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateManagerStatus,
  UpdateReleaseOption,
  WebUIAddresses,
} from './views';

/** Unsubscribe handle returned by every `subscribe`-backed API method. */
export type Unsubscribe = () => void;

/** Application mode. */
export type AppMode = 'SHOW' | 'EDIT' | string;

/** `[error, data]` tuple returned by manager-backed IPC handlers. */
export type ResultTuple<T = unknown> = [string | null, T | null];

/**
 * The preload API exposed on `window.API`.
 *
 * Grouped to mirror `src/bridge_main.ts`. `invoke`-backed methods return
 * `Promise<T>`; `subscribe`-backed methods register a callback and return an
 * {@link Unsubscribe} handle.
 */
export interface ShowTrakAPI {
  // ---- External links / meta --------------------------------------------
  OpenDiscordInviteLinkInBrowser(): Promise<unknown>;
  OpenShowTrakWebsiteInBrowser(): Promise<unknown>;
  OpenShowTrakGithubInBrowser(): Promise<unknown>;
  OpenNpmPackageInBrowser(PackageName: string): Promise<unknown>;
  GetProjectDependencies(): Promise<ResultTuple<{ dependencies?: unknown[] }>>;
  GetLicense(): Promise<ResultTuple<{ license?: string }>>;
  GetConfig(): Promise<AppConfig>;
  GetWebUIAddresses(): Promise<WebUIAddresses>;
  OnNetworkInterfacesChanged(callback: (payload: unknown) => void): Unsubscribe;
  GetSettings(): Promise<SettingView[]>;

  // ---- Adoption / updates -----------------------------------------------
  AdoptDevice(UUID: string): Promise<unknown>;
  CheckForUpdatesOnClient(UUID: string): Promise<unknown>;
  GetUpdateManagerStatus(): Promise<ResultTuple<UpdateManagerStatus>>;
  GetUpdateManagerReleases(): Promise<ResultTuple<UpdateReleaseOption[]>>;
  DownloadUpdateManagerRelease(Tag: string): Promise<ResultTuple<UpdateDownloadResult>>;
  DeployUpdateManagerRelease(Tag: string, Targets: string[]): Promise<ResultTuple<UpdateDeployResult>>;
  OnUpdateManagerDownloadProgress(callback: (payload: UpdateDownloadProgress) => void): Unsubscribe;

  // ---- Lifecycle --------------------------------------------------------
  Loaded(): Promise<unknown>;
  Shutdown(Confirmed?: boolean): Promise<unknown>;

  // ---- Clients ----------------------------------------------------------
  // Returns the client object directly (or null); NOT a Result tuple.
  GetClient(UUID: string): Promise<ClientView | null>;
  GetClientHistory(UUID: string): Promise<HistorySample[]>;
  GetClientApplicationHistory(UUID: string): Promise<ClientApplicationHistorySeries[]>;
  GetClientUSBHistory(UUID: string): Promise<ClientUSBHistorySeries[]>;
  GetClientDisplayHistory(UUID: string): Promise<ClientDisplayHistorySeries[]>;
  UpdateClient(UUID: string, Data: Record<string, unknown>): Promise<ResultTuple<unknown>>;
  MarkClientUSBDeviceCritical(UUID: string, Device: unknown): Promise<ResultTuple<unknown>>;
  RemoveClientUSBDeviceCritical(UUID: string, SerialNumber: string): Promise<ResultTuple<unknown>>;
  MarkClientUSBNameCritical(UUID: string, Device: unknown): Promise<ResultTuple<unknown>>;
  RemoveClientUSBNameCritical(UUID: string, Device: unknown): Promise<ResultTuple<unknown>>;
  MarkClientApplicationCritical(UUID: string, Application: unknown): Promise<ResultTuple<unknown>>;
  RemoveClientApplicationCritical(UUID: string, ApplicationName: string): Promise<ResultTuple<unknown>>;
  MarkClientDisplayCritical(UUID: string, Display: unknown): Promise<ResultTuple<unknown>>;
  RemoveClientDisplayCritical(UUID: string, DisplayID: string): Promise<ResultTuple<unknown>>;
  IdentifyClient(UUID: string): Promise<unknown>;
  StopIdentifyingClient(UUID: string): Promise<unknown>;
  UnadoptClient(UUID: string): Promise<unknown>;
  ReplaceClient(CurrentUUID: string, ReplacementUUID: string): Promise<ResultTuple<unknown>>;
  CreateUnassignedClients(Payload: {
    Name: string;
    Count: number;
  }): Promise<ResultTuple<number>>;
  WakeOnLan(Targets: string[]): Promise<unknown>;

  // ---- Groups -----------------------------------------------------------
  GetAllGroups(): Promise<GroupView[]>;
  CreateGroup(Title: string): Promise<unknown>;
  RenameGroup(GroupID: number, Title: string): Promise<ResultTuple<unknown>>;
  DeleteGroup(GroupID: number): Promise<unknown>;
  SetGroupListOrder(OrderedGroupIDs: number[]): Promise<ResultTuple<unknown>>;
  SetGroupFullWidth(GroupID: number, FullWidth: boolean): Promise<ResultTuple<unknown>>;
  SetGroupKeyBind(GroupID: number, KeyBind: string | null): Promise<ResultTuple<unknown>>;
  SetGroupOrder(GroupID: number, OrderedUUIDs: string[]): Promise<unknown>;

  // ---- Show file --------------------------------------------------------
  NewShow(): Promise<ResultTuple<unknown>>;
  SaveShow(): Promise<ResultTuple<unknown>>;
  SaveShowAs(): Promise<ResultTuple<unknown>>;
  OpenShow(): Promise<ResultTuple<unknown>>;
  GetCurrentShowFile(): Promise<unknown>;
  HasUnsavedShowData(): Promise<unknown>;
  EnsureShowFileExists(): Promise<ResultTuple<{ Missing?: boolean }>>;
  OnShowFileUpdated(callback: (payload: unknown) => void): Unsubscribe;

  // ---- Folders ----------------------------------------------------------
  OpenLogsFolder(): Promise<unknown>;
  OpenScriptsFolder(): Promise<unknown>;

  // ---- Menu / window ----------------------------------------------------
  OnAppMenuAction(callback: (action: unknown) => void): Unsubscribe;
  OnWindowFullscreenChanged(callback: (isFullscreen: boolean) => void): Unsubscribe;

  // ---- Mode -------------------------------------------------------------
  GetMode(): Promise<AppMode>;
  SetMode(Mode: AppMode): Promise<AppMode>;
  OnModeUpdated(callback: (mode: AppMode) => void): Unsubscribe;

  // ---- Settings ---------------------------------------------------------
  SetSetting(Key: string, Value: unknown): Promise<ResultTuple<unknown>>;
  UpdateSettings(
    callback: (Settings: SettingView[], SettingsGroups: SettingGroupView[]) => void
  ): Unsubscribe;

  // ---- OSC / traffic / toasts -------------------------------------------
  OSCBulkAction(
    callback: (Type: OSCBulkActionType, Targets: string[], Args: string | null) => void
  ): Unsubscribe;
  PlaySound(callback: (SoundName: string) => void): Unsubscribe;
  Notify(callback: (Message: string, Type: string, Duration: number) => void): Unsubscribe;
  DebugTrafficEntry(callback: (entry: DebugTrafficEntry) => void): Unsubscribe;
  SetOSCList(callback: (list: OSCRoute[]) => void): Unsubscribe;

  // ---- Client list / telemetry subscriptions ----------------------------
  SetDevicesPendingAdoption(callback: (devices: ClientView[]) => void): Unsubscribe;
  SetFullClientList(callback: (Clients: ClientView[], Groups: GroupView[]) => void): Unsubscribe;
  SetScriptList(callback: (scripts: ScriptCatalogEntry[]) => void): Unsubscribe;
  ClientUpdated(callback: (client: ClientView) => void): Unsubscribe;
  UpdateScriptExecutions(callback: (executions: ScriptExecutionView[]) => void): Unsubscribe;
  ShutdownRequested(callback: () => void): Unsubscribe;
  USBDeviceAdded(callback: (Client: ClientView, Device: USBDevice) => void): Unsubscribe;
  USBDeviceRemoved(callback: (Client: ClientView, Device: USBDevice) => void): Unsubscribe;

  // ---- Scripts (execution + management) ---------------------------------
  ExecuteScript(Script: unknown, Targets: string[], ResetList?: unknown): Promise<unknown>;
  TriggerIntegratedEvent(EventID: string, Targets: string[]): Promise<unknown>;
  DeleteScripts(List: unknown): Promise<unknown>;
  UpdateScripts(List: unknown): Promise<unknown>;
  GetScriptManagerList(): Promise<ScriptManagerEntry[]>;
  GetScriptConfig(ID: string): Promise<ResultTuple<ScriptEditable>>;
  SaveScriptConfig(
    ID: string,
    Fields: unknown
  ): Promise<ResultTuple<{ id?: string; errors?: string[] }>>;
  GetScriptWhitelist(ID: string): Promise<ResultTuple<ScriptWhitelistScope | null>>;
  SetScriptWhitelist(ID: string, Scope: ScriptWhitelistScope): Promise<ResultTuple<boolean>>;
  SetScriptOrder(OrderedIDs: string[]): Promise<ResultTuple<unknown>>;
  DeleteScript(ID: string): Promise<ResultTuple<unknown>>;
  CreateScript(): Promise<ResultTuple<{ id: string }>>;
  GetSampleScripts(): Promise<ResultTuple<unknown[]>>;
  RefreshSampleScripts(): Promise<ResultTuple<unknown[]>>;
  CreateScriptFromTemplate(
    SampleID: string,
    DesiredID: string
  ): Promise<ResultTuple<{ id?: string; conflict?: boolean; ok?: boolean; errors?: string[] }>>;
  OpenScriptFolder(ID: string): Promise<unknown>;
  OpenScriptFile(ID: string, RelativeFilePath: string): Promise<ResultTuple<unknown>>;
  RunScriptFileLocal(ID: string, RelativeFilePath: string): Promise<ResultTuple<unknown>>;

  // ---- App update -------------------------------------------------------
  CheckForAppUpdates(): Promise<unknown>;
  InstallAppUpdate(): Promise<unknown>;
  OnAppUpdateStatus(callback: (status: AppUpdateStatus) => void): Unsubscribe;

  // ---- Monitoring targets -----------------------------------------------
  GetMonitoringMethods(): Promise<MonitoringMethodView[]>;
  GetAllMonitoringTargets(): Promise<MonitoringTargetView[]>;
  GetMonitoringTarget(TargetID: string): Promise<MonitoringTargetView | null>;
  GetMonitoringCheckHistory(CheckID: number): Promise<HistorySample[]>;
  GetMonitoringCheckDebug(CheckID: number): Promise<MonitoringCheckDebug | null>;
  RunMonitoringCheckNow(CheckID: number): Promise<MonitoringCheckDebug | null>;
  RunAllMonitoringChecksNow(TargetID: string): Promise<unknown>;
  CreateMonitoringTarget(Payload: unknown): Promise<ResultTuple<MonitoringTargetView>>;
  UpdateMonitoringTarget(TargetID: number, Payload: unknown): Promise<ResultTuple<MonitoringTargetView>>;
  DeleteMonitoringTarget(TargetID: number): Promise<ResultTuple<unknown>>;
  SetFullMonitoringTargetList(callback: (targets: MonitoringTargetView[]) => void): Unsubscribe;
  MonitoringTargetUpdated(callback: (target: MonitoringTargetView) => void): Unsubscribe;

  // ---- Dummy clients ----------------------------------------------------
  GetAllDummyClients(): Promise<DummyClientView[]>;
  GetDummyClient(UUID: string): Promise<DummyClientView | null>;
  GetDummyClientHistory(UUID: string): Promise<HistorySample[]>;
  GenerateDummyClientDefaults(): Promise<DummyClientDefaults>;
  CreateDummyClient(Payload: unknown): Promise<ResultTuple<DummyClientView>>;
  UpdateDummyClient(UUID: string, Payload: unknown): Promise<ResultTuple<DummyClientView>>;
  DeleteDummyClient(UUID: string): Promise<ResultTuple<unknown>>;
  ResetDummyClientToIdle(UUID: string): Promise<unknown>;
  SetFullDummyClientList(callback: (dummies: DummyClientView[]) => void): Unsubscribe;
  DummyClientUpdated(callback: (dummy: DummyClientView) => void): Unsubscribe;

  // ---- Network discovery ------------------------------------------------
  StartNetworkDeviceScan(Options: unknown): Promise<ResultTuple<{ ScanID: string }>>;
  StopNetworkDeviceScan(ScanID: string): Promise<unknown>;
  OnNetworkDeviceScanEvent(callback: (event: NetworkScanEvent) => void): Unsubscribe;

  // ---- Alert rules ------------------------------------------------------
  GetAlertTriggers(): Promise<AlertTriggerType[]>;
  GetAlertActionTypes(): Promise<AlertActionType[]>;
  GetAllAlertRules(): Promise<AlertRuleView[]>;
  GetAlertRule(RuleID: string): Promise<AlertRuleView | null>;
  CreateAlertRule(Payload: unknown): Promise<ResultTuple<AlertRuleView>>;
  UpdateAlertRule(RuleID: string, Payload: unknown): Promise<ResultTuple<AlertRuleView>>;
  DeleteAlertRule(RuleID: string): Promise<ResultTuple<unknown>>;
  SetAlertRuleEnabled(RuleID: string, Enabled: boolean): Promise<unknown>;
  GetAlertActionsEnabled(): Promise<boolean>;
  SetAlertActionsEnabled(Enabled: boolean): Promise<boolean>;
  SetFullAlertRuleList(callback: (rules: AlertRuleView[]) => void): Unsubscribe;
  AlertTriggered(callback: (alert: AlertTriggeredEvent) => void): Unsubscribe;
  CreateShowTrakAlert(callback: (alert: ShowTrakAlert) => void): Unsubscribe;

  // ---- Custom audio assets ----------------------------------------------
  GetAudioAssets(): Promise<AudioAssetView[]>;
  GetAudioAssetData(ID: string): Promise<ResultTuple<AudioAssetData>>;
  SelectAudioAssetFiles(): Promise<ResultTuple<AudioAssetInspection[]>>;
  ImportAudioAsset(Payload: unknown): Promise<ResultTuple<unknown>>;
  UpdateAudioAsset(ID: string, Payload: unknown): Promise<ResultTuple<AudioAssetView>>;
  DeleteAudioAsset(ID: string): Promise<ResultTuple<unknown>>;
  OpenAudioAssetsFolder(): Promise<unknown>;
  PlayCustomAudio(callback: (payload: AudioAssetData) => void): Unsubscribe;
  OnAudioAssetsUpdated(callback: (assets?: unknown) => void): Unsubscribe;
}