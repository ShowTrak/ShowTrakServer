import type {
  AppConfig,
  ClientView,
  GroupView,
  ScriptCatalogEntry,
  MonitoringTargetView,
  MonitoringMethodView,
  DummyClientView,
  AlertRuleView,
  AlertActionType,
  AlertTriggerType,
  AlertRuleActionView,
  AudioAssetView,
  SettingView,
  SettingGroupView,
  HistorySample,
  UpdateManagerStatus,
  UpdateReleaseOption,
} from '@showtrak/protocol';

// ---- Local UI working-state shapes ---------------------------------------
// These describe transient editor/modal state that never crosses the wire, so
// they live here rather than in the shared protocol package.

/** One check row inside the monitoring-target editor draft. */
export interface MonitoringEditorCheck {
  CheckID?: number | null;
  Name: string;
  Address: string;
  Method: string;
  Settings: Record<string, unknown>;
  DegradedThresholdMs: number;
}

/** Working draft backing the multi-check monitoring-target editor modal. */
export interface MonitoringEditorStateShape {
  TargetID: number | null;
  Nickname: string;
  Interval: number;
  GroupID: number | null;
  Checks: MonitoringEditorCheck[];
  View: string;
  EditingIndex: number | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: boolean;
  pendingSave: boolean;
}

/** One series row in the history modal (checks, clients, apps, USB, displays). */
export interface MonitorHistorySeriesEntry {
  samples: HistorySample[];
  checkID?: number;
  dummy?: boolean;
  client?: boolean;
  applicationKey?: string;
  applicationName?: string;
  usbSerial?: string;
  usbName?: string;
  displayID?: string;
  displayName?: string;
}

/** Identifies which entity the history modal is currently showing. */
export interface MonitorHistoryModalContextShape {
  id: string | number;
  type: string;
}

/** Last pointer position over a timeline block, kept across re-renders. */
export interface MonitorHistoryTooltipHoverShape {
  x: number;
  y: number;
}

/** A selectable entity (client, monitor, check, dummy) in the alert scope tree. */
export interface AlertScopeEntity {
  Kind: string;
  Value: string;
  ScopedID: string;
  GroupID: number | null;
  Label: string;
  IconClass: string;
  Weight: number;
}

/** A group node in the alert scope tree, holding its child entities. */
export interface AlertScopeGroupNode {
  Kind: 'group';
  Value: string;
  GroupID: number;
  Label: string;
  Children: AlertScopeEntity[];
  ChildValues: string[];
}

/** Full model built by `buildAlertScopeModel()`, backing the scope dropdown. */
export interface AlertScopeModel {
  Workspace: { Kind: 'workspace'; Value: string; Label: string };
  Groups: AlertScopeGroupNode[];
  Ungrouped: AlertScopeEntity[];
  AllClientValues: string[];
  AllClientValueSet: Set<string>;
  LabelByValue: Map<string, string>;
}

export let Config = {} as AppConfig;

// Runtime capabilities describing which surface the shared renderer is running
// on (Electron desktop vs browser Web UI) and what it may do. The web bootstrap
// injects `window.__SHOWTRAK_CAPS__` before the shared modules load; on the
// desktop nothing is injected and we fall back to the full-capability profile.
export interface CapabilityProfile {
  isWeb: boolean;
  showNavbar: boolean;
  showCogs: boolean;
  showModeToggle: boolean;
  canToggleAlertActions: boolean;
  requiresPasscode: boolean;
  allowRemoteScripts: boolean;
  wolEnabled: boolean;
}

const DESKTOP_CAPABILITIES: CapabilityProfile = {
  isWeb: false,
  showNavbar: true,
  showCogs: true,
  showModeToggle: true,
  canToggleAlertActions: true,
  requiresPasscode: false,
  allowRemoteScripts: true,
  wolEnabled: true,
};

export const Capabilities: CapabilityProfile = (() => {
  try {
    const injected = window.__SHOWTRAK_CAPS__;
    if (injected && typeof injected === 'object') {
      return { ...DESKTOP_CAPABILITIES, ...injected, isWeb: true };
    }
  } catch {
    // Fall through to desktop defaults.
  }
  return DESKTOP_CAPABILITIES;
})();

export let Selected: string[] = [];
export let AllClients: ClientView[] = [];
export let ScriptList: ScriptCatalogEntry[] = [];
export const GroupUUIDCache = new Map();
// Pending adoption devices (unadopted clients discovered by the server)
export let PendingAdoption: ClientView[] = [];
// Monitoring targets (server-driven probes; not installed clients)
export let MonitoringTargets: MonitoringTargetView[] = [];
export let MonitoringMethodsCache: MonitoringMethodView[] = [];
export let MonitoringEditorTargetID: number | null = null;
// Working state for the multi-check monitoring target editor.
export let MonitoringEditorState: MonitoringEditorStateShape | null = null;
// Dummy clients (virtual heartbeat-driven clients)
export let DummyClients: DummyClientView[] = [];
export let DummyClientEditorUUID: string | null = null;
// History timeline: always show the past hour of checks as a fixed block
// timeline (no user-selectable range). One block per minute.
export const MONITOR_HISTORY_WINDOW_MS = 60 * 60 * 1000;
export const MONITOR_HISTORY_BLOCK_COUNT = 60;
// Live-fetched per-series samples backing the currently open history modal.
export let MonitorHistorySeries: MonitorHistorySeriesEntry[] = [];
export let MonitorHistoryModalContext: MonitorHistoryModalContextShape | null = null;
// Last pointer position while hovering a timeline block; used to keep the
// tooltip visible across live timeline re-renders.
export let MonitorHistoryTooltipHover: MonitorHistoryTooltipHoverShape | null = null;
export let AlertRuleEditorRuleID: number | null = null;
export let AlertEditingActionIndex: number | null = null;
export let AlertRuleDraftActions: AlertRuleActionView[] = [];
export let AlertRulesCache: AlertRuleView[] = [];
export let AlertActionTypesCache: AlertActionType[] = [];
export let AlertTriggerTypesCache: AlertTriggerType[] = [];
export let AlertScopeGroups: GroupView[] = [];
export let AlertScopeOptions: AlertScopeModel | null = null;
export let AlertScopeSelected: string[] = [];
export let AlertActionEditorIsCreating = false;
// Cache of imported custom audio assets (metadata only; data URLs fetched
// on-demand for preview/playback). Keeps alert action warning icons in sync.
export let AudioAssetsCache: AudioAssetView[] = [];
export const ALERT_TRIGGER_ALLOWLIST = new Set([
  'CLIENT_ONLINE',
  'CLIENT_OFFLINE',
  'CLIENT_DEGRADED',
  'SCRIPT_EXECUTION_FAILED',
  'USB_DEVICE_CONNECTED',
  'USB_DEVICE_DISCONNECTED',
  'NON_CRITICAL_USB_DEVICE_CONNECTED',
  'NON_CRITICAL_USB_DEVICE_DISCONNECTED',
  'CRITICAL_USB_DEVICE_CONNECTED',
  'CRITICAL_USB_DEVICE_DISCONNECTED',
  'APPLICATION_STARTED',
  'APPLICATION_STOPPED',
  'CRITICAL_APPLICATION_STARTED',
  'CRITICAL_APPLICATION_STOPPED',
  'NON_CRITICAL_APPLICATION_STARTED',
  'NON_CRITICAL_APPLICATION_STOPPED',
]);
export let NetworkDiscoveryScanID: string | null = null;
export let NetworkDiscoveryScanning = false;
export let NetworkDiscoveryResults = new Map();
export let NetworkDiscoveryProgress = {
  percent: 0,
  current: 0,
  total: 0,
};
// Cache last full lists to allow partial re-render when only pending changes
export let __LastClients: ClientView[] = [];
export let __LastGroups: GroupView[] = [];
export let UpdateManagerClientProgress = new Map();
export let UpdateManagerReleaseStatus: UpdateManagerStatus | null = null;
export let UpdateManagerReleaseOptions: UpdateReleaseOption[] = [];
export let UpdateManagerSelectedReleaseTag = '';
export let UpdateManagerSelectedClients = new Set();
export let UpdateManagerRunning = false;
export let UpdateManagerDownloadInProgress = false;

export let SettingsGroups: SettingGroupView[] = [];
export let Settings: SettingView[] = [];
export const SettingDebounceTimers = new Map();
// Track which client is open in the Client Info modal for live updates
export let ClientInfoOpenUUID: string | null = null;
export let ClientInfoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export let __clientInfoRefreshInFlight = false;

// --- Application Mode (SHOW | EDIT) ---
export let AppMode = 'SHOW'; // default visual state until backend confirms
export const COMPACT_MODE_STORAGE_KEY = 'showtrak.ui.compactMode';
export let CompactMode = false;
export let AlertActionsEnabled = true;

/** Minimal structural view of the client-like objects these label helpers accept. */
type ClientLike =
  | {
      Integrated?: boolean;
      OperatingSystem?: string | null;
      Version?: string | null;
      Nickname?: string | null;
      Hostname?: string | null;
    }
  | null
  | undefined;

export function IsIntegratedClientEntity(Client: ClientLike) {
  if (!Client) return false;
  if (Client.Integrated === true) return true;
  const OperatingSystem = String(Client.OperatingSystem || '')
    .trim()
    .toLowerCase();
  return OperatingSystem === 'integrated';
}

export function FormatClientVersionLabel(Client: ClientLike) {
  const RawVersion = String((Client && Client.Version) || '')
    .trim()
    .replace(/^v\s*/i, '');
  const Version = RawVersion.length > 0 ? RawVersion : 'Unknown';
  return `${IsIntegratedClientEntity(Client) ? 'SDK v' : 'v'}${Version}`;
}

export function FormatClientHostnameVersionLabel(Client: ClientLike) {
  const HasNickname = !!(
    Client &&
    typeof Client.Nickname === 'string' &&
    Client.Nickname.trim().length > 0
  );
  const Hostname = String((Client && Client.Hostname) || '').trim();
  const VersionLabel = FormatClientVersionLabel(Client);
  return HasNickname && Hostname.length > 0 ? `${Hostname} - ${VersionLabel}` : VersionLabel;
}

// --- Generated cross-module state setters ---
export function setAlertActionEditorIsCreating(value: boolean): void {
  AlertActionEditorIsCreating = value;
}
export function setAlertActionTypesCache(value: AlertActionType[]): void {
  AlertActionTypesCache = value;
}
export function setAlertActionsEnabled(value: boolean): void {
  AlertActionsEnabled = value;
}
export function setAlertEditingActionIndex(value: number | null): void {
  AlertEditingActionIndex = value;
}
export function setAlertRuleDraftActions(value: AlertRuleActionView[]): void {
  AlertRuleDraftActions = value;
}
export function setAlertRuleEditorRuleID(value: number | null): void {
  AlertRuleEditorRuleID = value;
}
export function setAlertRulesCache(value: AlertRuleView[]): void {
  AlertRulesCache = value;
}
export function setAlertScopeGroups(value: GroupView[]): void {
  AlertScopeGroups = value;
}
export function setAlertScopeOptions(value: AlertScopeModel | null): void {
  AlertScopeOptions = value;
}
export function setAlertScopeSelected(value: string[]): void {
  AlertScopeSelected = value;
}
export function setAlertTriggerTypesCache(value: AlertTriggerType[]): void {
  AlertTriggerTypesCache = value;
}
export function setAllClients(value: ClientView[]): void {
  AllClients = value;
}
export function setAppMode(value: string): void {
  AppMode = value;
}
export function setAudioAssetsCache(value: AudioAssetView[]): void {
  AudioAssetsCache = value;
}
export function setClientInfoOpenUUID(value: string | null): void {
  ClientInfoOpenUUID = value;
}
export function setClientInfoRefreshTimer(value: ReturnType<typeof setTimeout> | null): void {
  ClientInfoRefreshTimer = value;
}
export function setCompactMode(value: boolean): void {
  CompactMode = value;
}
export function setConfig(value: AppConfig): void {
  Config = value;
}
export function setDummyClientEditorUUID(value: string | null): void {
  DummyClientEditorUUID = value;
}
export function setDummyClients(value: DummyClientView[]): void {
  DummyClients = value;
}
export function setMonitorHistoryModalContext(value: MonitorHistoryModalContextShape | null): void {
  MonitorHistoryModalContext = value;
}
export function setMonitorHistorySeries(value: MonitorHistorySeriesEntry[]): void {
  MonitorHistorySeries = value;
}
export function setMonitorHistoryTooltipHover(value: MonitorHistoryTooltipHoverShape | null): void {
  MonitorHistoryTooltipHover = value;
}
export function setMonitoringEditorState(value: MonitoringEditorStateShape | null): void {
  MonitoringEditorState = value;
}
export function setMonitoringEditorTargetID(value: number | null): void {
  MonitoringEditorTargetID = value;
}
export function setMonitoringMethodsCache(value: MonitoringMethodView[]): void {
  MonitoringMethodsCache = value;
}
export function setMonitoringTargets(value: MonitoringTargetView[]): void {
  MonitoringTargets = value;
}
export function setNetworkDiscoveryProgress(value: typeof NetworkDiscoveryProgress): void {
  NetworkDiscoveryProgress = value;
}
export function setNetworkDiscoveryResults(value: typeof NetworkDiscoveryResults): void {
  NetworkDiscoveryResults = value;
}
export function setNetworkDiscoveryScanID(value: string | null): void {
  NetworkDiscoveryScanID = value;
}
export function setNetworkDiscoveryScanning(value: boolean): void {
  NetworkDiscoveryScanning = value;
}
export function setPendingAdoption(value: ClientView[]): void {
  PendingAdoption = value;
}
export function setScriptList(value: ScriptCatalogEntry[]): void {
  ScriptList = value;
}
export function setSelected(value: string[]): void {
  Selected = value;
}
export function setSettings(value: SettingView[]): void {
  Settings = value;
}
export function setSettingsGroups(value: SettingGroupView[]): void {
  SettingsGroups = value;
}
export function setUpdateManagerClientProgress(value: typeof UpdateManagerClientProgress): void {
  UpdateManagerClientProgress = value;
}
export function setUpdateManagerDownloadInProgress(value: boolean): void {
  UpdateManagerDownloadInProgress = value;
}
export function setUpdateManagerReleaseOptions(value: UpdateReleaseOption[]): void {
  UpdateManagerReleaseOptions = value;
}
export function setUpdateManagerReleaseStatus(value: UpdateManagerStatus | null): void {
  UpdateManagerReleaseStatus = value;
}
export function setUpdateManagerRunning(value: boolean): void {
  UpdateManagerRunning = value;
}
export function setUpdateManagerSelectedClients(value: typeof UpdateManagerSelectedClients): void {
  UpdateManagerSelectedClients = value;
}
export function setUpdateManagerSelectedReleaseTag(value: string): void {
  UpdateManagerSelectedReleaseTag = value;
}
export function set__LastClients(value: ClientView[]): void {
  __LastClients = value;
}
export function set__LastGroups(value: GroupView[]): void {
  __LastGroups = value;
}
export function set__clientInfoRefreshInFlight(value: boolean): void {
  __clientInfoRefreshInFlight = value;
}
