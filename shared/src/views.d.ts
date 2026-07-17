// @showtrak/protocol — serialized entity / "view" shapes as they cross the
// renderer <-> main IPC boundary.
//
// Extracted from preload.d.ts so that file can be just the `window.API`
// contract. Field casing intentionally mirrors each producer (some handlers
// emit camelCase, some PascalCase — see per-type notes). Re-exported through
// the package barrel (index.d.ts), so consumers still `import type { ClientView }
// from '@showtrak/protocol'` unchanged.

import type {
  USBDevice,
  ClientDisplay,
  NetworkInterface,
  RunningApplicationItem,
  RunningApplicationsStatus,
} from './telemetry';
import type { Vitals } from './vitals';
import type { IntegratedAction } from './integrated';

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
 * A user-marked serial-less critical USB device, guarded by its visible name
 * (Manufacturer + Product) and an expected Quantity rather than a serial number.
 * Emitted in `ClientView.CriticalUSBNames`.
 */
export interface CriticalUSBName {
  NameKey: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Quantity: number;
  Timestamp: number | null;
}

/**
 * A serial-less critical USB device whose connected count currently falls short
 * of its expected Quantity. Emitted in `ClientView.MissingCriticalUSBNames`.
 */
export interface MissingCriticalUSBName {
  ManufacturerName: string | null;
  ProductName: string | null;
  SerialNumber: null;
  NameKey: string;
  Quantity: number;
  ConnectedCount: number;
  IsConnected: false;
  IsCritical: true;
  IsCriticalByName: true;
  Shortfall: true;
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
  // Serial-less name-based guarding annotations (see CriticalUSBName).
  IsCriticalByName?: boolean;
  NameKey?: string;
  Quantity?: number;
  ConnectedCount?: number;
  Shortfall?: boolean;
  Missing?: boolean;
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
  RunOnLaunchScriptID?: string | null;
  RunOnLaunchDelaySeconds?: number | null;
  Online?: boolean;
  LastSeen?: number;
  Vitals?: Vitals | null;
  USBDeviceList?: USBDeviceView[];
  CriticalUSBDevices?: CriticalUSBDevice[];
  CriticalUSBSerials?: string[];
  MissingCriticalUSBDevices?: MissingCriticalUSBDevice[];
  CriticalUSBNames?: CriticalUSBName[];
  MissingCriticalUSBNames?: MissingCriticalUSBName[];
  Degraded?: boolean;
  DegradedWarnings?: string[];
  NetworkInterfaces?: NetworkInterface[];
  Integrated?: boolean;
  IntegratedActions?: IntegratedAction[];
  Identifying?: boolean;
  // Reserved slot with no hardware behind it yet; permanently offline until a
  // real device replaces it.
  Unassigned?: boolean;
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

/**
 * Per-script client/group whitelist scope (same shape as AlertRuleScope).
 * `Workspace: true` OR a null/absent scope both mean "all clients" (the
 * unrestricted default). `Workspace: false` restricts to the listed groups
 * (by GroupID) and clients (by UUID); an empty list therefore means "no
 * clients may run this script".
 */
export interface ScriptWhitelistScope {
  Workspace: boolean;
  Groups: number[];
  Clients: string[];
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
  /**
   * Per-show whitelist scope. `null`/absent means unrestricted (all clients) —
   * the default. Attached to the catalog push from the ScriptWhitelistManager;
   * consumed by the context menu to hide the script for non-whitelisted clients.
   */
  Whitelist?: ScriptWhitelistScope | null;
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

export interface MonitoringMethodInfo {
  Summary: string;
  Setup?: string[];
  Docs?: Array<{ Label: string; Url: string }>;
}

export interface MonitoringMethodView {
  ID: string;
  Name: string;
  Description: string;
  Info?: MonitoringMethodInfo | null;
  // Grouping label for the editor's method picker (e.g. "Power (UPS)").
  Group: string;
  DefaultInterval: number;
  // True when the method uses the per-check Address field. When false, the editor
  // hides the Address input and does not require one. Defaults to true.
  UsesAddress: boolean;
  // True when the latency-based Degraded Threshold applies. When false, the editor
  // hides that Advanced field. Defaults to true.
  SupportsLatencyThreshold: boolean;
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
  /** One or more stimuli that fire this rule; the rule runs when ANY of them matches. */
  TriggerTypes: string[];
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
  Type: 'BOOLEAN' | 'INTEGER' | 'STRING' | 'OPTION' | 'SLIDER';
  Value: boolean | number | string;
  isDefault: boolean;
  DefaultValue: boolean | number | string;
  OnUpdateEvent: string | null;
  Options: string[] | null;
  Min: number | null;
  Max: number | null;
  Unit: string | null;
}

export interface SettingGroupView {
  Name: string;
  Title: string;
}

export interface AppConfig {
  Application: { Version: string; Name: string; Port: number; IsPackaged: boolean };
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
  Source: 'bonjour' | 'probe' | 'pjlink';
  ServiceType?: string;
  Port: number | null;
  TXT?: Record<string, unknown> | null;
  MethodHint: 'http' | 'ping' | 'pjlink';
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