// Authoritative server-driven caches: the entity lists and config the main
// process pushes to the renderer, plus the last-rendered snapshots used for
// partial re-render. These mirror backend truth — distinct from the transient
// UI/editor drafts in ./ui-drafts. Each `export let` keeps its setter here
// (a setter can only reassign a binding declared in its own module); the
// 01-state barrel re-exports all of it so consumers are unchanged.
import type {
  AppConfig,
  ClientView,
  ScriptCatalogEntry,
  MonitoringTargetView,
  MonitoringMethodView,
  DummyClientView,
  AlertRuleView,
  AlertActionType,
  AlertTriggerType,
  AudioAssetView,
  SettingView,
  SettingGroupView,
  GroupView,
} from '@showtrak/protocol';

export let Config = {} as AppConfig;
export function setConfig(value: AppConfig): void {
  Config = value;
}

export let AllClients: ClientView[] = [];
export function setAllClients(value: ClientView[]): void {
  AllClients = value;
}

export let ScriptList: ScriptCatalogEntry[] = [];
export function setScriptList(value: ScriptCatalogEntry[]): void {
  ScriptList = value;
}

export const GroupUUIDCache = new Map();

// Pending adoption devices (unadopted clients discovered by the server)
export let PendingAdoption: ClientView[] = [];
export function setPendingAdoption(value: ClientView[]): void {
  PendingAdoption = value;
}

// Monitoring targets (server-driven probes; not installed clients)
export let MonitoringTargets: MonitoringTargetView[] = [];
export function setMonitoringTargets(value: MonitoringTargetView[]): void {
  MonitoringTargets = value;
}

export let MonitoringMethodsCache: MonitoringMethodView[] = [];
export function setMonitoringMethodsCache(value: MonitoringMethodView[]): void {
  MonitoringMethodsCache = value;
}

// Dummy clients (virtual heartbeat-driven clients)
export let DummyClients: DummyClientView[] = [];
export function setDummyClients(value: DummyClientView[]): void {
  DummyClients = value;
}

export let AlertRulesCache: AlertRuleView[] = [];
export function setAlertRulesCache(value: AlertRuleView[]): void {
  AlertRulesCache = value;
}

export let AlertActionTypesCache: AlertActionType[] = [];
export function setAlertActionTypesCache(value: AlertActionType[]): void {
  AlertActionTypesCache = value;
}

export let AlertTriggerTypesCache: AlertTriggerType[] = [];
export function setAlertTriggerTypesCache(value: AlertTriggerType[]): void {
  AlertTriggerTypesCache = value;
}

// Cache of imported custom audio assets (metadata only; data URLs fetched
// on-demand for preview/playback). Keeps alert action warning icons in sync.
export let AudioAssetsCache: AudioAssetView[] = [];
export function setAudioAssetsCache(value: AudioAssetView[]): void {
  AudioAssetsCache = value;
}

export let SettingsGroups: SettingGroupView[] = [];
export function setSettingsGroups(value: SettingGroupView[]): void {
  SettingsGroups = value;
}

export let Settings: SettingView[] = [];
export function setSettings(value: SettingView[]): void {
  Settings = value;
}

// Cache last full lists to allow partial re-render when only pending changes.
export let __LastClients: ClientView[] = [];
export function set__LastClients(value: ClientView[]): void {
  __LastClients = value;
}

export let __LastGroups: GroupView[] = [];
export function set__LastGroups(value: GroupView[]): void {
  __LastGroups = value;
}

// Per-client online/offline snapshot used by the OSC feed bridge to detect
// transitions. Folded in from the former `window.__CLIENT_ONLINE_STATE`
// side-channel (single consumer: 09-osc-feeds) so it lives with the other
// authoritative caches instead of on `window`.
export const ClientOnlineState = new Map<string, boolean>();
