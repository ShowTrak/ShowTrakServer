// Capability model for the server's REMOTE surfaces — the Web UI (`/ui`) and
// ShowTrak Remote (`/sdk`).
//
// Which invoke channels a remote surface may reach, and under what conditions.
// Anything not listed here is denied. Grouped by the gate that governs it.
//
// WHY THIS IS SHARED RATHER THAN COPIED PER SURFACE: two hand-maintained copies
// of a security allowlist is precisely the drift that becomes a vulnerability.
// Someone adds a channel to one surface and forgets the other; or removes a
// dangerous one from a surface and leaves it live on the other. The push list is
// already `satisfies`-checked against the IPC registry so a typo fails the build
// — that guarantee should protect both surfaces from ONE definition.
//
// What DOES differ per surface is the settings the permissions are read from,
// which is the single `Prefix` parameter threaded through everything below. The
// surfaces are otherwise deliberately identical: a phone and a browser are both
// "not the desktop", and inventing a second rule for one of them would mean
// re-explaining the difference every time someone compared the two panes.
//
// EDIT mode remains the master gate for every management category. It is
// authoritative on the desktop and every remote surface merely mirrors it; the
// per-category toggles further restrict, never widen.

import { Manager as SettingsManager } from '../SettingsManager';
import { Manager as ModeManager } from '../ModeManager';
import type { SubscribeChannel } from '../IPCRegistry/channels';

/**
 * Settings prefix identifying a remote surface. Every permission this module
 * reads is `<Prefix>_ALLOW_<CATEGORY>`, so adding a third surface is a new
 * member here plus its settings — not another copy of the allowlists.
 */
export type SurfacePrefix = 'WEBUI' | 'REMOTE';

// Always allowed for an authed session (read-only / non-mutating).
const READ_CHANNELS = new Set([
  'Config:Get',
  'GetClient',
  'GetClientHistory',
  'GetClientApplicationHistory',
  'GetClientUSBHistory',
  'GetClientDisplayHistory',
  'GetAllGroups',
  'Mode:Get',
  'GetMonitoringMethods',
  'GetAllMonitoringTargets',
  'GetMonitoringTarget',
  'GetMonitoringCheckHistory',
  'GetMonitoringCheckDebug',
  'GetDummyClientHistory',
  'GetAllDummyClients',
  'GetDummyClient',
  'GenerateDummyClientDefaults',
  'FreeKiosk:GetMetrics',
  'FreeKiosk:GetCommands',
  'GetAllFreeKioskTerminals',
  'GetFreeKioskTerminal',
  'FreeKiosk:GetHistory',
  'GenerateFreeKioskTerminalDefaults',
  'FreeKiosk:GetCameraList',
  // Reading tags is not tag management: the browser needs the list to render the
  // badges on its client tiles. Every mutation (Tags:SetScope et al) is absent
  // from every list below, so a browser can see tags but never edit them.
  'Tags:GetAll',
  'GetAlertTriggers',
  'GetAlertActionTypes',
  'GetAllAlertRules',
  'GetAlertRule',
  'AlertActionsEnabled:Get',
  'Audio:GetAll',
  'Audio:GetData',
]);

// Allowed regardless of mode: non-destructive, show-time actions (identifying
// a client just flashes an overlay on its screen — no state is mutated).
const IDENTIFY_CHANNELS = new Set(['IdentifyClient', 'StopIdentifyingClient']);

// Management mutations, split into finite capability categories so each can be
// permitted/denied independently from the Web UI Permissions settings. Every
// category ALSO requires the server to be in EDIT mode — edit-mode is
// authoritative on the desktop and the web merely mirrors it, so the per-category
// toggles further restrict (never widen) what a browser may mutate.
const CLIENT_CHANNELS = new Set([
  'UpdateClient',
  'MarkClientUSBDeviceCritical',
  'RemoveClientUSBDeviceCritical',
  'MarkClientUSBNameCritical',
  'RemoveClientUSBNameCritical',
  'MarkClientApplicationCritical',
  'RemoveClientApplicationCritical',
  'MarkClientDisplayCritical',
  'RemoveClientDisplayCritical',
  'AddClientMacAddress',
  'RemoveClientMacAddress',
  'UnadoptClient',
  'ReplaceClient',
  'AdoptDevice',
]);
const GROUP_CHANNELS = new Set([
  'CreateGroup',
  'RenameGroup',
  'DeleteGroup',
  'Groups:SetOrder',
  'Groups:SetFullWidth',
  'Groups:SetKeyBind',
  'Groups:SetSlug',
  'SetGroupOrder',
]);
const MONITORING_CHANNELS = new Set([
  'CreateMonitoringTarget',
  'UpdateMonitoringTarget',
  'DeleteMonitoringTarget',
  'RunMonitoringCheckNow',
  'RunAllMonitoringChecksNow',
  'CreateDummyClient',
  'UpdateDummyClient',
  'DeleteDummyClient',
  'ResetDummyClientToIdle',
  'CreateFreeKioskTerminal',
  'UpdateFreeKioskTerminal',
  'DeleteFreeKioskTerminal',
  'FreeKiosk:RunNow',
  // Sending a command and taking a capture both act on the device, so they sit
  // with the other mutations rather than the readers. The command name is still
  // validated against the fixed FREEKIOSK_COMMANDS allowlist in the registrar.
  'FreeKiosk:Command',
  'FreeKiosk:CaptureScreenshot',
  'FreeKiosk:CaptureCamera',
]);
const ALERT_CHANNELS = new Set([
  'CreateAlertRule',
  'UpdateAlertRule',
  'DeleteAlertRule',
  'SetAlertRuleEnabled',
]);
// Creating unassigned slots is its own category because it is additionally
// gated on the global SYSTEM_ALLOW_UNASSIGNED_CLIENTS feature flag (the main
// registrar re-checks that flag and remains the authority).
const UNASSIGNED_CHANNELS = new Set(['CreateUnassignedClients']);

// Union of every edit-mode-gated channel. Retained for callers/tests that reason
// about "all management mutations" without caring about the category split.
const EDIT_CHANNELS = new Set([
  ...CLIENT_CHANNELS,
  ...GROUP_CHANNELS,
  ...MONITORING_CHANNELS,
  ...ALERT_CHANNELS,
  ...UNASSIGNED_CHANNELS,
]);

// Allowed when remote script execution is enabled (SHOW-time actions).
const SCRIPT_CHANNELS = new Set([
  'ExecuteScript',
  'TriggerIntegratedEvent',
  'Scripts:ClearSettledExecutions',
]);

// Allowed when the global Wake-on-LAN feature AND the Web UI WOL permission are
// both enabled.
const WOL_CHANNELS = new Set(['WakeOnLan']);

// Push channels the web surface receives. Desktop-only channels (menu actions,
// show-file, fullscreen, native/app updates, network-discovery, and settings
// that may contain secrets) are intentionally excluded.
// `satisfies` guarantees every entry is a real registry SubscribeChannel at
// compile time (a typo or a channel removed from the registry fails the build).
// The Set stays `Set<string>` so the hot-path `.has(channel: string)` lookup
// keeps its plain-string signature.
const PUSH_CHANNELS = [
  'SetFullClientList',
  'ClientUpdated',
  'SetScriptList',
  'SetOSCList',
  'SetDevicesPendingAdoption',
  'UpdateScriptExecutions',
  'USBDeviceAdded',
  'USBDeviceRemoved',
  'SetFullMonitoringTargetList',
  'MonitoringTargetUpdated',
  'SetFullDummyClientList',
  'DummyClientUpdated',
  'SetFullFreeKioskTerminalList',
  'FreeKioskTerminalUpdated',
  'SetFullAlertRuleList',
  'SetTagList',
  'AlertTriggered',
  'CreateShowTrakAlert',
  'Notify',
  'PlaySound',
  'PlayCustomAudio',
  'OSCBulkAction',
  'DebugTrafficEntry',
  'ModeUpdated',
  'AlertActionsUpdated',
  'AudioAssetsUpdated',
] as const satisfies readonly SubscribeChannel[];
const PUSH_ALLOWLIST = new Set<string>(PUSH_CHANNELS);

// OSCBulkAction is allowlisted as a whole (WOL/ExecuteScript are legitimate web
// actions), but a few of its types drive the operator's own
// desktop window rather than a shared server state — opening or closing modals on
// every logged-in browser would yank the UI out from under whoever is using it.
// These types are dropped from the web push and delivered to the desktop only.
const SUPPRESSED_BULK_ACTIONS = new Set<string>(['OpenClientModal', 'CloseModals']);

const ReadBool = async (Key: string, Default: boolean): Promise<boolean> => {
  const Value = await SettingsManager.GetValue(Key);
  return Value == null ? Default : !!Value;
};

/** The per-category permissions governing one remote surface. */
export interface SurfacePermissions {
  AllowIdentify: boolean;
  AllowRemoteScripts: boolean;
  AllowWOL: boolean;
  AllowClientManagement: boolean;
  AllowGroupManagement: boolean;
  AllowMonitoringManagement: boolean;
  AllowAlertManagement: boolean;
  AllowUnassignedClients: boolean;
  /** Global Wake-on-LAN feature flag; ANDed with the per-surface permission. */
  WOLEnabled: boolean;
  /** Global unassigned-slots feature flag; ANDed with the per-surface permission. */
  UnassignedClientsEnabled: boolean;
}

/**
 * Read one surface's permissions.
 *
 * Defaults match the historical Web UI behaviour — management categories ON
 * (they were "allowed while in Edit mode" long before the toggles existed),
 * script execution OFF. ShowTrak Remote adopts the same defaults deliberately:
 * one rule for both remote surfaces is easier to hold in your head than two, and
 * the controls that actually carry the weight for a lost phone are the PIN at
 * pairing, the EDIT-mode gate and revocation — not a conservative default.
 */
export async function ReadSurfacePermissions(Prefix: SurfacePrefix): Promise<SurfacePermissions> {
  let Permissions: SurfacePermissions = {
    AllowIdentify: true,
    AllowRemoteScripts: false,
    AllowWOL: true,
    AllowClientManagement: true,
    AllowGroupManagement: true,
    AllowMonitoringManagement: true,
    AllowAlertManagement: true,
    AllowUnassignedClients: true,
    WOLEnabled: false,
    UnassignedClientsEnabled: false,
  };
  try {
    Permissions = {
      AllowIdentify: await ReadBool(`${Prefix}_ALLOW_IDENTIFY`, true),
      AllowRemoteScripts: await ReadBool(`${Prefix}_ALLOW_REMOTE_SCRIPT_EXECUTION`, false),
      AllowWOL: await ReadBool(`${Prefix}_ALLOW_WOL`, true),
      AllowClientManagement: await ReadBool(`${Prefix}_ALLOW_CLIENT_MANAGEMENT`, true),
      AllowGroupManagement: await ReadBool(`${Prefix}_ALLOW_GROUP_MANAGEMENT`, true),
      AllowMonitoringManagement: await ReadBool(`${Prefix}_ALLOW_MONITORING_MANAGEMENT`, true),
      AllowAlertManagement: await ReadBool(`${Prefix}_ALLOW_ALERT_MANAGEMENT`, true),
      AllowUnassignedClients: await ReadBool(`${Prefix}_ALLOW_UNASSIGNED_CLIENTS`, true),
      WOLEnabled: !!(await SettingsManager.GetValue('SYSTEM_ALLOW_WOL')),
      UnassignedClientsEnabled: !!(await SettingsManager.GetValue(
        'SYSTEM_ALLOW_UNASSIGNED_CLIENTS'
      )),
    };
  } catch {
    /* intentional: fall back to the safe defaults set above if settings can't be read */
  }
  return Permissions;
}

/** Why a channel was refused. Distinguishable because the two mean very different
 * things to whoever is holding the phone: one they can fix themselves. */
export type DenyReason = 'edit_mode_required' | 'forbidden';

export interface ChannelDecision {
  allowed: boolean;
  reason: DenyReason | null;
}

/**
 * Decide whether an authed session on `Prefix` may invoke `channel`. Deny by
 * default; only explicitly allowlisted channels pass, subject to the governing
 * capability gate.
 */
export async function AuthorizeChannel(
  Prefix: SurfacePrefix,
  channel: string
): Promise<ChannelDecision> {
  if (READ_CHANNELS.has(channel)) return { allowed: true, reason: null };
  const Cfg = await ReadSurfacePermissions(Prefix);
  if (IDENTIFY_CHANNELS.has(channel)) {
    if (!Cfg.AllowIdentify) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  // Management categories: EDIT mode is the master gate, then the per-category
  // permission. Report the mode requirement first so the UX message is accurate.
  const Category = CLIENT_CHANNELS.has(channel)
    ? Cfg.AllowClientManagement
    : GROUP_CHANNELS.has(channel)
      ? Cfg.AllowGroupManagement
      : MONITORING_CHANNELS.has(channel)
        ? Cfg.AllowMonitoringManagement
        : ALERT_CHANNELS.has(channel)
          ? Cfg.AllowAlertManagement
          : UNASSIGNED_CHANNELS.has(channel)
            ? Cfg.UnassignedClientsEnabled && Cfg.AllowUnassignedClients
            : null;
  if (Category !== null) {
    if (ModeManager.Get() !== 'EDIT') return { allowed: false, reason: 'edit_mode_required' };
    if (!Category) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  if (SCRIPT_CHANNELS.has(channel)) {
    if (!Cfg.AllowRemoteScripts) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  if (WOL_CHANNELS.has(channel)) {
    if (!Cfg.WOLEnabled || !Cfg.AllowWOL) return { allowed: false, reason: 'forbidden' };
    return { allowed: true, reason: null };
  }
  return { allowed: false, reason: 'forbidden' };
}

export {
  READ_CHANNELS,
  IDENTIFY_CHANNELS,
  CLIENT_CHANNELS,
  GROUP_CHANNELS,
  MONITORING_CHANNELS,
  ALERT_CHANNELS,
  UNASSIGNED_CHANNELS,
  EDIT_CHANNELS,
  SCRIPT_CHANNELS,
  WOL_CHANNELS,
  PUSH_CHANNELS,
  PUSH_ALLOWLIST,
  SUPPRESSED_BULK_ACTIONS,
};
