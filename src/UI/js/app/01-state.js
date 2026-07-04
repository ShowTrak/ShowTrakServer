var Config = {};

let Selected = [];
let AllClients = [];
let ScriptList = [];
const GroupUUIDCache = new Map();
// Pending adoption devices (unadopted clients discovered by the server)
let PendingAdoption = [];
// Monitoring targets (server-driven probes; not installed clients)
let MonitoringTargets = [];
let MonitoringMethodsCache = [];
let MonitoringEditorTargetID = null;
// Working state for the multi-check monitoring target editor.
let MonitoringEditorState = null;
// Dummy clients (virtual heartbeat-driven clients)
let DummyClients = [];
let DummyClientEditorUUID = null;
// History timeline: always show the past hour of checks as a fixed block
// timeline (no user-selectable range). One block per minute.
const MONITOR_HISTORY_WINDOW_MS = 60 * 60 * 1000;
const MONITOR_HISTORY_BLOCK_COUNT = 60;
// Live-fetched per-series samples backing the currently open history modal.
let MonitorHistorySeries = [];
let MonitorHistoryModalContext = null;
// Last pointer position while hovering a timeline block; used to keep the
// tooltip visible across live timeline re-renders.
let MonitorHistoryTooltipHover = null;
let AlertRuleEditorRuleID = null;
let AlertEditingActionIndex = null;
let AlertRuleDraftActions = [];
let AlertRulesCache = [];
let AlertActionTypesCache = [];
let AlertTriggerTypesCache = [];
let AlertScopeGroups = [];
let AlertScopeOptions = [];
let AlertScopeSelected = [];
let AlertActionEditorIsCreating = false;
// Cache of imported custom audio assets (metadata only; data URLs fetched
// on-demand for preview/playback). Keeps alert action warning icons in sync.
let AudioAssetsCache = [];
const ALERT_TRIGGER_ALLOWLIST = new Set([
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
let NetworkDiscoveryScanID = null;
let NetworkDiscoveryScanning = false;
let NetworkDiscoveryResults = new Map();
let NetworkDiscoveryProgress = {
  percent: 0,
  current: 0,
  total: 0,
};
// Cache last full lists to allow partial re-render when only pending changes
let __LastClients = [];
let __LastGroups = [];
let UpdateManagerClientProgress = new Map();
let UpdateManagerReleaseStatus = null;
let UpdateManagerReleaseOptions = [];
let UpdateManagerSelectedReleaseTag = '';
let UpdateManagerSelectedClients = new Set();
let UpdateManagerRunning = false;
let UpdateManagerDownloadInProgress = false;

let SettingsGroups = [];
let Settings = [];
let SettingDebounceTimers = new Map();
// Track which client is open in the Client Info modal for live updates
let ClientInfoOpenUUID = null;
let ClientInfoRefreshTimer = null;
let __clientInfoRefreshInFlight = false;

// --- Application Mode (SHOW | EDIT) ---
let AppMode = 'SHOW'; // default visual state until backend confirms
const COMPACT_MODE_STORAGE_KEY = 'showtrak.ui.compactMode';
let CompactMode = false;
let AlertActionsEnabled = true;

function IsIntegratedClientEntity(Client) {
  if (!Client) return false;
  if (Client.Integrated === true) return true;
  const OperatingSystem = String(Client.OperatingSystem || '')
    .trim()
    .toLowerCase();
  return OperatingSystem === 'integrated';
}

function FormatClientVersionLabel(Client) {
  const RawVersion = String((Client && Client.Version) || '')
    .trim()
    .replace(/^v\s*/i, '');
  const Version = RawVersion.length > 0 ? RawVersion : 'Unknown';
  return `${IsIntegratedClientEntity(Client) ? 'SDK v' : 'v'}${Version}`;
}

function FormatClientHostnameVersionLabel(Client) {
  const HasNickname = !!(
    Client &&
    typeof Client.Nickname === 'string' &&
    Client.Nickname.trim().length > 0
  );
  const Hostname = String((Client && Client.Hostname) || '').trim();
  const VersionLabel = FormatClientVersionLabel(Client);
  return HasNickname && Hostname.length > 0 ? `${Hostname} - ${VersionLabel}` : VersionLabel;
}
