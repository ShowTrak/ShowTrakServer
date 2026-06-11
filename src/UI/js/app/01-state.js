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
const MONITORING_HISTORY_RANGES = {
  '5m': { label: '5 Minutes', ms: 5 * 60 * 1000, bars: 75 },
  '15m': { label: '15 Minutes', ms: 15 * 60 * 1000, bars: 90 },
  '30m': { label: '30 Minutes', ms: 30 * 60 * 1000, bars: 96 },
  '1h': { label: '1 Hour', ms: 60 * 60 * 1000, bars: 90 },
  '12h': { label: '12 Hours', ms: 12 * 60 * 60 * 1000, bars: 96 },
};
let MonitorHistorySamples = [];
let MonitorHistoryModalTargetID = null;
let MonitorHistoryRangeKey = '5m';
let MonitorHistoryResizeTimer = null;
let MonitorHistoryHoverBars = [];
let AlertRuleEditorRuleID = null;
let AlertEditingActionIndex = null;
let AlertRuleDraftActions = [];
let AlertRulesCache = [];
let AlertActionTypesCache = [];
let AlertTriggerTypesCache = [];
let AlertScopeOptions = [];
let AlertScopeSelected = [];
let AlertActionEditorIsCreating = false;
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
