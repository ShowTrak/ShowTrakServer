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

import type {
  USBDevice,
  ClientDisplay,
  NetworkInterface,
  RunningApplicationItem,
  RunningApplicationsStatus,
} from './telemetry';
import type { Vitals } from './vitals';
import type { IntegratedAction } from './integrated';

/** Unsubscribe handle returned by every `subscribe`-backed API method. */
export type Unsubscribe = () => void;

/** Application mode. */
export type AppMode = 'SHOW' | 'EDIT' | string;

/**
 * A user-marked critical USB device (the persisted "expected" association).
 * Emitted in `ClientView.CriticalUSBDevices`.
 */
export interface CriticalUSBDevice {
  SerialNumber: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Timestamp: number | null;
}

/**
 * A critical USB device that is currently NOT connected.
 * Emitted in `ClientView.MissingCriticalUSBDevices`.
 */
export interface MissingCriticalUSBDevice {
  ManufacturerName: string | null;
  ProductName: string | null;
  SerialNumber: string;
  IsConnected: false;
  IsCritical: true;
  Missing: true;
}

/**
 * A user-marked critical application.
 * Emitted in `ClientView.CriticalApplications`.
 */
export interface CriticalApplication {
  Name: string;
  Key: string;
  Timestamp: number | null;
}

/**
 * A critical application that is currently NOT running.
 * Emitted in `ClientView.MissingCriticalApplications`.
 */
export interface MissingCriticalApplication {
  Name: string;
  Count: number;
  Key: string;
  IsRunning: false;
  IsCritical: true;
  Missing: true;
}

/**
 * A user-marked critical display (the persisted "expected" configuration).
 * Emitted in `ClientView.CriticalDisplays`.
 */
export interface CriticalDisplay {
  DisplayID: string;
  Label: string | null;
  Width: number | null;
  Height: number | null;
  RefreshRate: number | null;
  ScaleFactor: number | null;
  Timestamp: number | null;
}

/**
 * A critical display that is currently NOT connected.
 * Emitted in `ClientView.MissingCriticalDisplays`.
 */
export interface MissingCriticalDisplay {
  DisplayID: string;
  Label: string | null;
  Width: number | null;
  Height: number | null;
  RefreshRate: number | null;
  ScaleFactor: number | null;
  IsConnected: false;
  IsCritical: true;
  Missing: true;
  Mismatch: false;
  CurrentSignature: null;
  ExpectedSignature: string;
}

/**
 * A connected display whose current configuration differs from its critical
 * baseline. Carries the full {@link ClientDisplay} plus the diff annotations.
 * Emitted in `ClientView.MismatchedCriticalDisplays`.
 */
export interface MismatchedCriticalDisplay extends ClientDisplay {
  IsConnected: true;
  IsCritical: boolean;
  Missing: false;
  Mismatch: boolean;
  CurrentSignature: string;
  ExpectedSignature: string | null;
}

/**
 * Telemetry list elements as *serialized* to the renderer: the raw wire shapes
 * enriched in-place by the Client class's critical-marking machinery.
 */
export interface USBDeviceView extends USBDevice {
  IsCritical?: boolean;
  IsConnected?: boolean;
}

export interface ClientDisplayView extends ClientDisplay {
  IsCritical?: boolean;
}

export interface RunningApplicationViewItem extends RunningApplicationItem {
  Key?: string;
  IsCritical?: boolean;
  IsRunning?: boolean;
}

export interface RunningApplicationsView {
  SampledAt?: number;
  TotalCount?: number;
  Truncated?: boolean;
  Items: RunningApplicationViewItem[];
  Status?: RunningApplicationsStatus;
  NoChanges?: boolean;
}

/** Renderer-facing serialized client (superset across desktop + web surfaces). */
export interface ClientView {
  Type?: string;
  UUID: string;
  Nickname?: string | null;
  Hostname?: string | null;
  OperatingSystem?: string;
  GroupID?: number | null;
  Weight?: number;
  Version?: string | null;
  VersionLabel?: string;
  IP?: string | null;
  MacAddress?: string | null;
  Online?: boolean;
  LastSeen?: number;
  Vitals?: Vitals | null;
  USBDeviceList?: USBDeviceView[];
  CriticalUSBDevices?: CriticalUSBDevice[];
  CriticalUSBSerials?: string[];
  MissingCriticalUSBDevices?: MissingCriticalUSBDevice[];
  Degraded?: boolean;
  DegradedWarnings?: string[];
  NetworkInterfaces?: NetworkInterface[];
  Integrated?: boolean;
  IntegratedActions?: IntegratedAction[];
  Identifying?: boolean;
  RunningApplications?: RunningApplicationsView;
  CriticalApplications?: CriticalApplication[];
  MissingCriticalApplications?: MissingCriticalApplication[];
  DisplayList?: ClientDisplayView[];
  CriticalDisplays?: CriticalDisplay[];
  CriticalDisplayIDs?: string[];
  MissingCriticalDisplays?: MissingCriticalDisplay[];
  MismatchedCriticalDisplays?: MismatchedCriticalDisplay[];
}

/** Renderer-facing group. */
export interface GroupView {
  GroupID: number;
  // The group entity stores `Data.Title || null`, so a group may serialize with
  // a null title; both surfaces copy it through verbatim.
  Title: string | null;
  Weight: number;
  // Emitted by both the web serializer (ToPublicGroup) and the desktop group
  // entity as `isFullWidth`. KeyBind is emitted by the desktop entity only.
  isFullWidth?: boolean;
  KeyBind?: string | null;
}

// ---------------------------------------------------------------------------
// Domain view types (serialized shapes as they cross the IPC boundary).
// Field casing intentionally mirrors each producer: some handlers emit
// camelCase, some PascalCase — see per-type notes.
// ---------------------------------------------------------------------------

// ---- Scripts --------------------------------------------------------------

/** `GetScriptManagerList` entry (camelCase; mapped in registrars/scripts.ts). */
export interface ScriptManagerEntry {
  id: string;
  name: string;
  description: string;
  colour: number;
  icon: string;
  weight: number;
  confirm: boolean;
  timeoutMs: number;
  enabled: boolean;
  valid: boolean;
  parseError: string | null;
  platforms: Record<string, string>;
  compatiblePlatforms: string[];
  issues: string[];
}

/** `GetScriptConfig` editable form (ScriptManager `GetEditable`). */
export interface ScriptEditable {
  id: string;
  name: string;
  description: string;
  colour: number;
  icon: string;
  confirm: boolean;
  timeoutMs: number;
  enabled: boolean;
  platforms: Record<string, string>;
  arguments: Record<string, string>;
  files: string[];
  valid: boolean;
}

export interface ScriptFileEntry {
  Path: string;
  Type: 'file' | 'directory';
  Checksum?: string | null;
}

/** `SetScriptList` push catalog entry (PascalCase; serialized Script class). */
export interface ScriptCatalogEntry {
  ID: string;
  Name: string;
  Description: string;
  Colour: number;
  Icon: string;
  Weight: number;
  Confirmation: boolean;
  Timeout?: number;
  Platforms: Record<string, string>;
  Arguments: Record<string, string>;
  CompatiblePlatforms: string[];
  isEnabled: boolean;
  isValid: boolean;
  ValidationErrors: string[];
  Config: Record<string, unknown> | null;
  Files: ScriptFileEntry[];
  ParseError?: string;
  RawText?: string;
}

export interface ScriptExecutionTimer {
  Start: number;
  End: number | null;
  Duration: number | null;
}

/** `UpdateScriptExecutions` push entry. */
export interface ScriptExecutionView {
  Internal: boolean;
  RequestID: string;
  Status: 'Pending' | 'Failed' | 'Completed';
  Progress: number;
  StatusText: string;
  Timer: ScriptExecutionTimer;
  Client: ClientView;
  Script: ScriptCatalogEntry | { ID: string; Name: string };
  Error?: string | null;
}

// ---- Monitoring -----------------------------------------------------------

export interface MonitoringSettingField {
  Key: string;
  Label: string;
  Type: string;
  Default?: unknown;
  Min?: number;
  Max?: number;
  Options?: Array<string | { value: string; label?: string }>;
  Advanced?: boolean;
}

export interface MonitoringMethodView {
  ID: string;
  Name: string;
  Description: string;
  DefaultInterval: number;
  Settings: MonitoringSettingField[];
}

export interface MonitoringCheckView {
  CheckID: number;
  TargetID: number;
  Name: string;
  Address: string;
  Method: string;
  Settings: Record<string, unknown>;
  DegradedThresholdMs: number;
  Weight: number;
  LastSuccessAt: number | null;
  Online: boolean;
  Degraded: boolean;
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastError: string | null;
}

export interface MonitoringTargetView {
  TargetID: number;
  Nickname: string;
  Interval: number;
  GroupID: number | null;
  Weight: number;
  Timestamp: number;
  Address: string;
  Method: string;
  DegradedThresholdMs: number;
  LastSuccessAt: number | null;
  Online: boolean;
  Degraded: boolean;
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastError: string | null;
  CheckCount: number;
  Type: 'monitor';
  Checks: MonitoringCheckView[];
}

/** Uniform RAM-only history sample used across every history domain. */
export interface HistorySample {
  ts: number;
  online: boolean;
  degraded: boolean;
  latencyMs: number | null;
}

export interface MonitoringCheckDebug {
  CheckID: number;
  Method: string;
  Html: string | null;
  Online: boolean;
  Degraded: boolean;
  LastError: string | null;
  LastChecked: number | null;
  LastLatencyMs: number | null;
  LastDebugAt: number | null;
}

// ---- Dummy clients --------------------------------------------------------

export interface DummyClientView {
  UUID: string;
  DummyID: string;
  Nickname: string;
  Hostname: string;
  IP: string | null;
  Version: 'Dummy';
  Interval: number;
  GroupID: number | null;
  Weight: number;
  Timestamp: number;
  State: 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  Online: boolean;
  Degraded: boolean;
  DegradedWarnings: string[];
  LastSeen: number | null;
  Type: 'dummy';
}

export interface DummyClientDefaults {
  DummyID: string;
  Nickname: string;
  Interval: number;
}

// ---- Alert rules ----------------------------------------------------------

export interface AlertRuleScope {
  Workspace: boolean;
  Groups: unknown[];
  Clients: unknown[];
}

export interface AlertRuleActionView {
  Type: string;
  Settings: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AlertRuleView {
  RuleID: number;
  Title: string;
  Scope: AlertRuleScope;
  TriggerType: string;
  TriggerConfig: Record<string, unknown>;
  Actions: AlertRuleActionView[];
  Enabled: boolean;
  Timestamp: number;
  UpdatedAt: number;
}

export interface AlertTriggerType {
  ID: string;
  Name: string;
}

export interface AlertActionSettingField {
  Key: string;
  Label: string;
  Type: string;
  Default?: unknown;
  Min?: number;
  Max?: number;
  Options?: unknown[];
  Source?: string;
  Preview?: string;
  Hidden?: boolean;
}

export interface AlertActionType {
  ID: string;
  Name: string;
  Description: string;
  Settings: AlertActionSettingField[];
}

export interface AlertTriggeredEvent {
  RuleID: number;
  RuleTitle: string;
  TriggerType: string;
  Context: Record<string, unknown>;
  Results: Array<{ Type: string; Success: boolean; Error: string | null }>;
  Timestamp: number;
}

export interface ShowTrakAlert {
  Title: string;
  Message: string;
  Severity: string;
  TriggerType: string | null;
  UUID: string | null;
}

// ---- Audio assets ---------------------------------------------------------

export interface AudioAssetView {
  ID: string;
  Label: string;
  OriginalName: string;
  Extension: string;
  Volume: number;
  Size: number;
  Duration: number | null;
  Timestamp: number;
  Missing: boolean;
}

export interface AudioAssetData {
  ID: string;
  Label: string;
  Volume: number;
  DataURL: string;
}

export interface AudioAssetInspection {
  Path: unknown;
  OriginalName: string;
  BaseLabel: string;
  Extension: string;
  Size: number;
  DataURL: string | null;
  Error: string | null;
}

// ---- Settings / config ----------------------------------------------------

export interface SettingView {
  Group: string;
  Key: string;
  Title: string;
  Description: string;
  Type: 'BOOLEAN' | 'INTEGER' | 'STRING' | 'OPTION';
  Value: boolean | number | string;
  isDefault: boolean;
  DefaultValue: boolean | number | string;
  OnUpdateEvent: string | null;
  Options: string[] | null;
  Min: number | null;
  Max: number | null;
}

export interface SettingGroupView {
  Name: string;
  Title: string;
}

export interface AppConfig {
  Application: { Version: string; Name: string; Port: number };
  Shared: { Version: string };
}

export interface WebUIAddresses {
  port: number;
  hostname: string;
  urls: Array<{ host: string; url: string }>;
}

// ---- Update manager -------------------------------------------------------

export interface UpdateManagerStatus {
  Ready: boolean;
  ReleaseVersion: string | null;
  ReleasedAt: string | null;
  DownloadedAt: string | null;
  Assets: Array<{ name: string; size: number; url: string }>;
  FeedPath: string;
}

export interface UpdateReleaseOption {
  tag: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
}

export interface UpdateDownloadProgress {
  percent: number;
  phase: string;
  message: string;
}

export interface UpdateDownloadResult {
  ReleaseVersion: string;
  FeedPath: string;
  AssetCount: number;
}

export interface UpdateDeployResult {
  ReleaseVersion: string;
  TargetCount: number;
  SelectedCount: number;
  TotalClientCount: number;
  FeedPath: string;
}

/** Application self-update lifecycle status (`OnAppUpdateStatus`). */
export interface AppUpdateStatus {
  state?: string;
  info?: { version?: string; tag?: string; notes?: string; [key: string]: unknown } | null;
  percent?: number;
  simulated?: boolean;
  error?: string;
}

// ---- Network discovery ----------------------------------------------------

export interface NetworkScanResult {
  Key?: string;
  Name: string;
  Hostname?: string | null;
  Address: string;
  Source: 'bonjour' | 'probe';
  ServiceType?: string;
  Port: number | null;
  TXT?: Record<string, unknown> | null;
  MethodHint: 'http' | 'ping';
}

export type NetworkScanEvent =
  | {
      ScanID: string;
      Type: 'status';
      Status: 'starting' | 'scanning' | 'error';
      Message?: string;
      Progress?: { Current: number; Total: number; Percent: number };
    }
  | { ScanID: string; Type: 'result'; Result: NetworkScanResult }
  | { ScanID: string; Type: 'done'; Status: 'completed' | 'cancelled'; Count: number };

// ---- OSC ------------------------------------------------------------------

export interface OSCRoute {
  Title: string;
  Path: string;
}

export type OSCBulkActionType =
  | 'Select'
  | 'Deselect'
  | 'WOL'
  | 'ExecuteScript'
  | 'InternalScript';

export interface DebugTrafficEntry {
  protocol: 'osc';
  timestamp: number;
  valid: boolean;
  summary: string;
  detail: string;
  source?: string | null;
}

// ---- Client history -------------------------------------------------------

export interface ClientApplicationHistorySeries {
  Key: string;
  Name: string;
  samples: HistorySample[];
}

export interface ClientUSBHistorySeries {
  Serial: string;
  Name: string;
  samples: HistorySample[];
}

export interface ClientDisplayHistorySeries {
  DisplayID: string;
  Name: string;
  samples: HistorySample[];
}

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
  GetConfig(): Promise<AppConfig>;
  GetWebUIAddresses(): Promise<WebUIAddresses>;
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
  MarkClientApplicationCritical(UUID: string, Application: unknown): Promise<ResultTuple<unknown>>;
  RemoveClientApplicationCritical(UUID: string, ApplicationName: string): Promise<ResultTuple<unknown>>;
  MarkClientDisplayCritical(UUID: string, Display: unknown): Promise<ResultTuple<unknown>>;
  RemoveClientDisplayCritical(UUID: string, DisplayID: string): Promise<ResultTuple<unknown>>;
  IdentifyClient(UUID: string): Promise<unknown>;
  StopIdentifyingClient(UUID: string): Promise<unknown>;
  UnadoptClient(UUID: string): Promise<unknown>;
  ReplaceClient(CurrentUUID: string, ReplacementUUID: string): Promise<ResultTuple<unknown>>;
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
