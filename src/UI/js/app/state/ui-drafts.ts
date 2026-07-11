// Transient UI/editor/modal state: selection, in-flight editor drafts, history
// modal context, alert-rule drafts, network-discovery + update-manager progress,
// client-info modal bookkeeping, and application mode. None of this mirrors
// backend truth — it is renderer-local working state (distinct from the
// authoritative caches in ./server-caches). Each `export let` keeps its setter
// here; the 01-state barrel re-exports all of it so consumers are unchanged.
import type {
  GroupView,
  AlertRuleActionView,
  UpdateManagerStatus,
  UpdateReleaseOption,
} from '@showtrak/protocol';
import type {
  MonitoringEditorStateShape,
  MonitorHistorySeriesEntry,
  MonitorHistoryModalContextShape,
  MonitorHistoryTooltipHoverShape,
  AlertScopeModel,
} from './types';

// --- Selection ---
export let Selected: string[] = [];
export function setSelected(value: string[]): void {
  Selected = value;
}

// --- Monitoring target editor draft ---
export let MonitoringEditorTargetID: number | null = null;
export function setMonitoringEditorTargetID(value: number | null): void {
  MonitoringEditorTargetID = value;
}

// Working state for the multi-check monitoring target editor.
export let MonitoringEditorState: MonitoringEditorStateShape | null = null;
export function setMonitoringEditorState(value: MonitoringEditorStateShape | null): void {
  MonitoringEditorState = value;
}

export let DummyClientEditorUUID: string | null = null;
export function setDummyClientEditorUUID(value: string | null): void {
  DummyClientEditorUUID = value;
}

// --- History modal ---
// History timeline: always show the past hour of checks as a fixed block
// timeline (no user-selectable range). One block per minute.
export const MONITOR_HISTORY_WINDOW_MS = 60 * 60 * 1000;
export const MONITOR_HISTORY_BLOCK_COUNT = 60;

// Live-fetched per-series samples backing the currently open history modal.
export let MonitorHistorySeries: MonitorHistorySeriesEntry[] = [];
export function setMonitorHistorySeries(value: MonitorHistorySeriesEntry[]): void {
  MonitorHistorySeries = value;
}

export let MonitorHistoryModalContext: MonitorHistoryModalContextShape | null = null;
export function setMonitorHistoryModalContext(value: MonitorHistoryModalContextShape | null): void {
  MonitorHistoryModalContext = value;
}

// Last pointer position while hovering a timeline block; used to keep the
// tooltip visible across live timeline re-renders.
export let MonitorHistoryTooltipHover: MonitorHistoryTooltipHoverShape | null = null;
export function setMonitorHistoryTooltipHover(value: MonitorHistoryTooltipHoverShape | null): void {
  MonitorHistoryTooltipHover = value;
}

// --- Alert rule editor drafts ---
export let AlertRuleEditorRuleID: number | null = null;
export function setAlertRuleEditorRuleID(value: number | null): void {
  AlertRuleEditorRuleID = value;
}

export let AlertEditingActionIndex: number | null = null;
export function setAlertEditingActionIndex(value: number | null): void {
  AlertEditingActionIndex = value;
}

export let AlertRuleDraftActions: AlertRuleActionView[] = [];
export function setAlertRuleDraftActions(value: AlertRuleActionView[]): void {
  AlertRuleDraftActions = value;
}

export let AlertScopeGroups: GroupView[] = [];
export function setAlertScopeGroups(value: GroupView[]): void {
  AlertScopeGroups = value;
}

export let AlertScopeOptions: AlertScopeModel | null = null;
export function setAlertScopeOptions(value: AlertScopeModel | null): void {
  AlertScopeOptions = value;
}

export let AlertScopeSelected: string[] = [];
export function setAlertScopeSelected(value: string[]): void {
  AlertScopeSelected = value;
}

export let AlertActionEditorIsCreating = false;
export function setAlertActionEditorIsCreating(value: boolean): void {
  AlertActionEditorIsCreating = value;
}

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

// --- Network discovery ---
export let NetworkDiscoveryScanID: string | null = null;
export function setNetworkDiscoveryScanID(value: string | null): void {
  NetworkDiscoveryScanID = value;
}

export let NetworkDiscoveryScanning = false;
export function setNetworkDiscoveryScanning(value: boolean): void {
  NetworkDiscoveryScanning = value;
}

export let NetworkDiscoveryResults = new Map();
export function setNetworkDiscoveryResults(value: typeof NetworkDiscoveryResults): void {
  NetworkDiscoveryResults = value;
}

export let NetworkDiscoveryProgress = {
  percent: 0,
  current: 0,
  total: 0,
};
export function setNetworkDiscoveryProgress(value: typeof NetworkDiscoveryProgress): void {
  NetworkDiscoveryProgress = value;
}

// --- Update manager ---
export let UpdateManagerClientProgress = new Map();
export function setUpdateManagerClientProgress(value: typeof UpdateManagerClientProgress): void {
  UpdateManagerClientProgress = value;
}

export let UpdateManagerReleaseStatus: UpdateManagerStatus | null = null;
export function setUpdateManagerReleaseStatus(value: UpdateManagerStatus | null): void {
  UpdateManagerReleaseStatus = value;
}

export let UpdateManagerReleaseOptions: UpdateReleaseOption[] = [];
export function setUpdateManagerReleaseOptions(value: UpdateReleaseOption[]): void {
  UpdateManagerReleaseOptions = value;
}

export let UpdateManagerSelectedReleaseTag = '';
export function setUpdateManagerSelectedReleaseTag(value: string): void {
  UpdateManagerSelectedReleaseTag = value;
}

export let UpdateManagerSelectedClients = new Set();
export function setUpdateManagerSelectedClients(value: typeof UpdateManagerSelectedClients): void {
  UpdateManagerSelectedClients = value;
}

export let UpdateManagerRunning = false;
export function setUpdateManagerRunning(value: boolean): void {
  UpdateManagerRunning = value;
}

export let UpdateManagerDownloadInProgress = false;
export function setUpdateManagerDownloadInProgress(value: boolean): void {
  UpdateManagerDownloadInProgress = value;
}

// --- Settings + client-info modal bookkeeping ---
export const SettingDebounceTimers = new Map();

// Track which client is open in the Client Info modal for live updates.
export let ClientInfoOpenUUID: string | null = null;
export function setClientInfoOpenUUID(value: string | null): void {
  ClientInfoOpenUUID = value;
}

export let ClientInfoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function setClientInfoRefreshTimer(value: ReturnType<typeof setTimeout> | null): void {
  ClientInfoRefreshTimer = value;
}

export let __clientInfoRefreshInFlight = false;
export function set__clientInfoRefreshInFlight(value: boolean): void {
  __clientInfoRefreshInFlight = value;
}

// --- Application Mode (SHOW | EDIT) ---
export let AppMode = 'SHOW'; // default visual state until backend confirms
export function setAppMode(value: string): void {
  AppMode = value;
}

export const COMPACT_MODE_STORAGE_KEY = 'showtrak.ui.compactMode';
export let CompactMode = false;
export function setCompactMode(value: boolean): void {
  CompactMode = value;
}

export let AlertActionsEnabled = true;
export function setAlertActionsEnabled(value: boolean): void {
  AlertActionsEnabled = value;
}

// Whether the modal confirmation dialog is currently on screen. Folded in from
// the former `window.__SHOWTRAK_CONFIRM_ACTIVE` side-channel: set by the toasts
// module when the dialog opens/closes, read by 05-keyboard to suppress global
// keybinds while a confirm is pending.
export let ConfirmDialogActive = false;
export function setConfirmDialogActive(value: boolean): void {
  ConfirmDialogActive = value;
}
