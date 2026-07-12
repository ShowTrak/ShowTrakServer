// Broadcast → renderer bridge for the main process.
//
// The back-end managers emit domain events on the shared BroadcastManager
// ("ClientUpdated", "MonitoringTargetListChanged", …). This module subscribes to
// every one of them and fans the resulting state out to the renderer surfaces
// via the RendererBus (desktop window + authed Web UI sockets). It also owns the
// authoritative list-refresh functions (`Update*List`) that both the event
// subscribers and the initial-load hydration path call.
//
// Extracted verbatim from main.ts. The only structural change is the small
// `PASSTHROUGH` table for the pure-indirection push subscribers; every function
// body — including the `hasMainWindow()` guards that gate side effects such as
// alert handling and history recording — is preserved so behavior is unchanged.

import type { USBDevice } from '@showtrak/protocol';
import { CreateLogger } from '../Modules/Logger';
import { ONLINE_DEPLOY_COOLDOWN_MS } from '../Modules/Config/constants';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as ClientManager } from '../Modules/ClientManager';
import { normalizeUSBNameKey } from '../Modules/ClientManager/normalizers';
import { Manager as GroupManager } from '../Modules/GroupManager';
import { Manager as MonitoringTargetManager } from '../Modules/MonitoringTargetManager';
import { Manager as DummyClientManager } from '../Modules/DummyClientManager';
import { Manager as AlertsManager } from '../Modules/AlertsManager';
import { Manager as AudioAssetManager } from '../Modules/AudioAssetManager';
import { Manager as ScriptManager } from '../Modules/ScriptManager';
import { Manager as ScriptWhitelistManager } from '../Modules/ScriptWhitelistManager';
import { Manager as AdoptionManager } from '../Modules/AdoptionManager';
import { Manager as ServerManager } from '../Modules/Server';
import { Manager as ModeManager } from '../Modules/ModeManager';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { OSC } from '../Modules/OSC';
import { PushToRenderers } from './renderer-bus';
import { hasMainWindow } from './app-window';
import {
  TriggerScriptDeployment,
  ScheduleScriptChangeDeployment,
  ReconcileDeploymentQueueAfterExecutions,
} from './deployment';
import {
  recordMonitoringHistorySample,
  syncMonitoringHistoryStore,
  recordDummyHistorySample,
  syncDummyHistoryStore,
  recordClientHistorySample,
  syncClientHistoryStore,
} from './monitoring-history';

const Logger = CreateLogger('Main');

// Per-UUID online-transition tracking, used to fire an auto-deployment exactly
// once when a client comes online (rate-limited by ONLINE_DEPLOY_COOLDOWN_MS).
const LastOnlineStateByUUID = new Map<string, boolean>();
const LastOnlineDeployAtByUUID = new Map<string, number>();

// Loose payload shapes for the domain events fanned out below. Broadcast events
// are delivered via EventEmitter (untyped at emit), so these describe only what
// the bridge itself reads or forwards to typed managers. `UUID` is required as a
// string where the handler feeds it to UUID-keyed ClientManager methods.
interface BroadcastClient {
  UUID: string;
  Online?: boolean;
  Degraded?: boolean;
  [key: string]: unknown;
}
interface BroadcastApplication {
  Name?: unknown;
}
interface BroadcastMonitoringTarget {
  TargetID?: number;
  Checks?: unknown;
  [key: string]: unknown;
}
interface BroadcastDummyClient {
  UUID?: string | null;
  Online?: boolean;
  Degraded?: boolean;
  [key: string]: unknown;
}
// Mirrors deployment.ts's (unexported) DeploymentExecutionInfo; structurally
// assignable so ReconcileDeploymentQueueAfterExecutions accepts it.
interface ScriptExecutionInfo {
  Script?: { Name?: unknown } | null;
  Status?: unknown;
}

// Push the entire settings payload and group metadata to the renderer.
async function UpdateSettings(): Promise<void> {
  if (!hasMainWindow()) return;
  const Settings = await SettingsManager.GetAll();
  const SettingGroups = await SettingsManager.GetGroups();
  PushToRenderers('UpdateSettings', Settings, SettingGroups);
}

// A device counts as critical for alerting if it's guarded by serial number, or
// — for serial-less devices — if its name is guarded (name + quantity path).
async function ResolveUSBDeviceCritical(
  UUID: string,
  Device: USBDevice
): Promise<[unknown, boolean]> {
  const [serialErr, isSerialCritical] = await ClientManager.IsUSBDeviceCritical(
    UUID,
    Device && Device.SerialNumber
  );
  if (serialErr) return [serialErr, false];
  if (isSerialCritical) return [null, true];
  const Serial = Device && Device.SerialNumber;
  const HasSerial = typeof Serial === 'string' && Serial.trim().length > 0;
  if (HasSerial) return [null, false];
  const NameKey = normalizeUSBNameKey(
    Device && Device.ManufacturerName,
    Device && Device.ProductName
  );
  const [nameErr, isNameCritical] = await ClientManager.IsUSBNameCritical(UUID, NameKey);
  if (nameErr) return [nameErr, false];
  return [null, !!isNameCritical];
}

async function USBDeviceAdded(Client: BroadcastClient, Device: USBDevice): Promise<void> {
  if (!hasMainWindow()) return;
  Logger.log(
    `USB Device Added to ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
  );
  PushToRenderers('USBDeviceAdded', Client, Device);
  AlertsManager.HandleUSBDeviceConnected(Client, Device).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleUSBDeviceConnected failed', Err)
  );
  const [criticalErr, isCritical] = await ResolveUSBDeviceCritical(Client.UUID, Device);
  if (criticalErr) {
    Logger.error('ClientManager.IsUSBDeviceCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalUSBDeviceConnected(Client, Device).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleCriticalUSBDeviceConnected failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalUSBDeviceConnected(Client, Device).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleNonCriticalUSBDeviceConnected failed', Err)
    );
  }
  return;
}

async function USBDeviceRemoved(Client: BroadcastClient, Device: USBDevice): Promise<void> {
  if (!hasMainWindow()) return;
  Logger.log(
    `USB Device Removed from ${Client.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
  );
  PushToRenderers('USBDeviceRemoved', Client, Device);
  AlertsManager.HandleUSBDeviceDisconnected(Client, Device).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleUSBDeviceDisconnected failed', Err)
  );
  const [criticalErr, isCritical] = await ResolveUSBDeviceCritical(Client.UUID, Device);
  if (criticalErr) {
    Logger.error('ClientManager.IsUSBDeviceCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalUSBDeviceDisconnected(Client, Device).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleCriticalUSBDeviceDisconnected failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalUSBDeviceDisconnected(Client, Device).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleNonCriticalUSBDeviceDisconnected failed', Err)
    );
  }
  return;
}

async function ApplicationStarted(
  Client: BroadcastClient,
  Application: BroadcastApplication
): Promise<void> {
  if (!hasMainWindow()) return;
  AlertsManager.HandleApplicationStarted(Client, Application).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleApplicationStarted failed', Err)
  );
  const [criticalErr, isCritical] = await ClientManager.IsApplicationCritical(
    Client.UUID,
    Application && Application.Name
  );
  if (criticalErr) {
    Logger.error('ClientManager.IsApplicationCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalApplicationStarted(Client, Application).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleCriticalApplicationStarted failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalApplicationStarted(Client, Application).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleNonCriticalApplicationStarted failed', Err)
    );
  }
}

async function ApplicationStopped(
  Client: BroadcastClient,
  Application: BroadcastApplication
): Promise<void> {
  if (!hasMainWindow()) return;
  AlertsManager.HandleApplicationStopped(Client, Application).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleApplicationStopped failed', Err)
  );
  const [criticalErr, isCritical] = await ClientManager.IsApplicationCritical(
    Client.UUID,
    Application && Application.Name
  );
  if (criticalErr) {
    Logger.error('ClientManager.IsApplicationCritical failed', criticalErr);
  } else if (isCritical) {
    AlertsManager.HandleCriticalApplicationStopped(Client, Application).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleCriticalApplicationStopped failed', Err)
    );
  } else {
    AlertsManager.HandleNonCriticalApplicationStopped(Client, Application).catch((Err: unknown) =>
      Logger.error('AlertsManager.HandleNonCriticalApplicationStopped failed', Err)
    );
  }
}

async function ReadoptDevice(UUID: string): Promise<void> {
  await ServerManager.SendMessageByGroup(UUID, 'Adopt');
}

// Full re-hydration: clear caches, re-fetch, and send authoritative lists.
async function ReinitializeSystem(): Promise<void> {
  if (!hasMainWindow()) return;
  Logger.log('Reinitializing system...');

  // Refresh manager caches that hold DB-backed state in memory.
  if (typeof SettingsManager.Reload === 'function') {
    await SettingsManager.Reload();
  }
  if (typeof AlertsManager.Reload === 'function') {
    await AlertsManager.Reload();
  }
  if (typeof MonitoringTargetManager.Reload === 'function') {
    await MonitoringTargetManager.Reload();
  }

  if (typeof DummyClientManager.Reload === 'function') {
    await DummyClientManager.Reload();
  }

  if (typeof GroupManager.ReconcileOrphanedGroups === 'function') {
    const [OrphanErr] = await GroupManager.ReconcileOrphanedGroups();
    if (OrphanErr) Logger.error('Failed to reconcile orphaned group assignments:', OrphanErr);
  }

  await ClientManager.ClearCache();
  await AdoptionManager.ClearAllDevicesPendingAdoption();
  const [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) return Logger.error('Failed to fetch full client list:', ClientsErr);
  const [GroupsErr, Groups] = await GroupManager.GetAll();
  if (GroupsErr) return Logger.error('Failed to fetch client groups:', GroupsErr);

  await UpdateSettings();
  await UpdateMonitoringTargetList();
  await UpdateDummyClientList();
  await UpdateAlertRuleList();

  PushToRenderers('SetFullClientList', Clients, Groups);
}

async function ClientUpdated(Client: BroadcastClient): Promise<void> {
  if (hasMainWindow()) {
    PushToRenderers('ClientUpdated', Client);
  }

  recordClientHistorySample(Client);

  const UUID = Client && Client.UUID ? Client.UUID : null;
  const IsOnline = !!(Client && Client.Online);
  if (UUID) {
    const WasOnline = LastOnlineStateByUUID.get(UUID);
    LastOnlineStateByUUID.set(UUID, IsOnline);
    if (IsOnline && WasOnline !== true) {
      const Now = Date.now();
      const LastDeployAt = LastOnlineDeployAtByUUID.get(UUID) || 0;
      if (Now - LastDeployAt >= ONLINE_DEPLOY_COOLDOWN_MS) {
        LastOnlineDeployAtByUUID.set(UUID, Now);
        TriggerScriptDeployment([UUID], 'client-online').catch((Err) =>
          Logger.error('Auto deployment on online transition failed', Err)
        );
      }
    }
  }

  AlertsManager.HandleClientUpdated(Client).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleClientUpdated failed', Err)
  );
}

// OSC routes are read-only here; clone to avoid accidental mutation downstream.
async function UpdateOSCList(): Promise<void> {
  if (!hasMainWindow()) return;
  const Routes = OSC.GetRoutes();
  PushToRenderers('SetOSCList', JSON.parse(JSON.stringify(Routes)));
}

// Scripts are filesystem-driven; this pushes the current catalog to the UI.
async function UpdateScriptList(): Promise<void> {
  if (!hasMainWindow()) return;
  const ScriptList = await ScriptManager.GetScripts();
  // Decorate with each script's per-show whitelist scope so the UI (desktop and,
  // via the web push sink, the browser) can hide a script for non-whitelisted
  // clients. Unrestricted scripts get Whitelist: null.
  const DecoratedList = await ScriptWhitelistManager.DecorateCatalog(ScriptList);
  PushToRenderers('SetScriptList', DecoratedList);
}

// Clients + Groups form the primary topology data model used by the UI.
async function UpdateFullClientList(): Promise<void> {
  if (!hasMainWindow()) return;
  const [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) return Logger.error('Failed to fetch full client list:', ClientsErr);
  const [GroupsErr, Groups] = await GroupManager.GetAll();
  if (GroupsErr) return Logger.error('Failed to fetch client groups:', GroupsErr);
  syncClientHistoryStore(Clients || []);
  PushToRenderers('SetFullClientList', Clients, Groups);
}

// Monitoring target fan-out
async function UpdateMonitoringTargetList(): Promise<void> {
  if (!hasMainWindow()) return;
  const [Err, List] = await MonitoringTargetManager.GetAll();
  if (Err) return Logger.error('Failed to fetch monitoring targets:', Err);
  const SafeList = List || [];
  syncMonitoringHistoryStore(SafeList);
  PushToRenderers('SetFullMonitoringTargetList', SafeList);
}

async function MonitoringTargetUpdated(Target: BroadcastMonitoringTarget): Promise<void> {
  if (!hasMainWindow()) return;
  recordMonitoringHistorySample(Target);
  PushToRenderers('MonitoringTargetUpdated', Target);
  AlertsManager.HandleMonitoringTargetUpdated(Target).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleMonitoringTargetUpdated failed', Err)
  );
}

// Dummy client fan-out
async function UpdateDummyClientList(): Promise<void> {
  if (!hasMainWindow()) return;
  const [Err, List] = await DummyClientManager.GetAll();
  if (Err) return Logger.error('Failed to fetch dummy clients:', Err);
  const SafeList = List || [];
  syncDummyHistoryStore(SafeList);
  PushToRenderers('SetFullDummyClientList', SafeList);
}

async function DummyClientUpdated(Dummy: BroadcastDummyClient): Promise<void> {
  recordDummyHistorySample(Dummy);
  if (hasMainWindow()) {
    PushToRenderers('DummyClientUpdated', Dummy);
  }
  // Dummy clients fire the same online/degraded/offline alert triggers as real
  // clients. Their snapshot is shaped client-like, so reuse the client handler.
  AlertsManager.HandleClientUpdated(Dummy).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleClientUpdated (dummy) failed', Err)
  );
}

// Pending adoption list is ephemeral; pull from manager and push to UI.
async function UpdateAdoptionList(): Promise<void> {
  if (!hasMainWindow()) return;
  const DevicesPendingAdoption = AdoptionManager.GetClientsPendingAdoption();
  PushToRenderers('SetDevicesPendingAdoption', DevicesPendingAdoption);
}

// Execution queue status updates (progress, completion, errors).
async function UpdateScriptExecutions(Executions: ScriptExecutionInfo[]): Promise<void> {
  if (!hasMainWindow()) return;
  PushToRenderers('UpdateScriptExecutions', Executions);

  ReconcileDeploymentQueueAfterExecutions(Executions);

  AlertsManager.HandleScriptExecutionUpdated(Executions).catch((Err: unknown) =>
    Logger.error('AlertsManager.HandleScriptExecutionUpdated failed', Err)
  );
}

async function UpdateAlertRuleList(): Promise<void> {
  if (!hasMainWindow()) return;
  const [Err, Rules] = await AlertsManager.GetAll();
  if (Err) return Logger.error('Failed to fetch alert rules:', Err);
  PushToRenderers('SetFullAlertRuleList', Rules || []);
}

// Thin wrapper to surface system notifications in the renderer.
async function Notify(Message: unknown, Type = 'info', Duration = 5000): Promise<void> {
  if (!hasMainWindow()) return;
  PushToRenderers('Notify', Message, Type, Duration);
}

// On show load/boot, verify every alert action that references a custom audio
// asset still resolves to a file on disk. Missing assets are surfaced as a
// renderer notification so the operator knows an alert sound was deleted; the
// alert UI separately renders a warning icon on the affected actions.
async function ValidateAlertAudioAssets(): Promise<void> {
  try {
    const [Err, Rules] = await AlertsManager.GetAll();
    if (Err || !Array.isArray(Rules)) return;

    const ReferencedIDs = [];
    for (const Rule of Rules) {
      const Actions = Array.isArray(Rule.Actions) ? Rule.Actions : [];
      for (const Action of Actions) {
        if (Action && Action.Type === 'play-custom-audio') {
          const AssetID = Action.Settings && Action.Settings.AssetID ? Action.Settings.AssetID : '';
          if (AssetID) ReferencedIDs.push(String(AssetID));
        }
      }
    }

    const Missing = AudioAssetManager.FindMissing(ReferencedIDs);
    if (!Missing.length) return;

    Logger.warn(`Missing custom audio assets referenced by alerts: ${Missing.join(', ')}`);
    const Count = Missing.length;
    Notify(
      `${Count} alert audio asset${Count === 1 ? ' is' : 's are'} missing and will fall back to a built-in sound.`,
      'error',
      10000
    );
  } catch (Err) {
    Logger.error('Failed to validate alert audio assets', Err);
  }
}

// UI-triggered audio feedback (short, non-blocking). Note: intentionally has no
// window guard — matches the original main.ts behavior.
async function PlaySound(SoundName: unknown): Promise<void> {
  PushToRenderers('PlaySound', SoundName);
}

// Batch an OSC-triggered action and let the renderer decide the UX.
async function HandleOSCBulkAction(
  Type: unknown,
  Targets: unknown,
  Args: unknown = null
): Promise<void> {
  if (!hasMainWindow()) return;
  PushToRenderers('OSCBulkAction', Type, Targets, Args);
}

// Re-push the script catalog whenever it is reloaded from disk (e.g. after the
// Script Manager saves an edited Script.json), then auto-deploy updates. Only
// trigger deployment when the fingerprint has actually changed to avoid reacting
// to filesystem noise (Spotlight, Time Machine, etc.) that fires the directory
// watcher without any script content changing.
let LastScriptDeploymentFingerprint: string | null = null;
async function OnScriptsUpdated(): Promise<void> {
  await UpdateScriptList();
  const CurrentFingerprint = await ScriptManager.GetDeploymentFingerprint();
  if (CurrentFingerprint !== LastScriptDeploymentFingerprint) {
    LastScriptDeploymentFingerprint = CurrentFingerprint;
    ScheduleScriptChangeDeployment();
  }
}

// Pure-indirection push subscribers: guard against window teardown, then forward
// the emitted payload verbatim to the renderers. `[event, channel]` pairs.
const PASSTHROUGH: Array<[string, string]> = [
  ['AlertTriggered', 'AlertTriggered'],
  ['CreateShowTrakAlert', 'CreateShowTrakAlert'],
  ['PlayCustomAudio', 'PlayCustomAudio'],
  ['DebugTrafficEntry', 'DebugTrafficEntry'],
];

// Wire every BroadcastManager subscriber and the ModeManager relay. Called once
// from the main-process composition root after the managers are initialized.
function RegisterBroadcastBridge(): void {
  BroadcastManager.on('SettingsUpdated', UpdateSettings);
  BroadcastManager.on('USBDeviceAdded', USBDeviceAdded);
  BroadcastManager.on('USBDeviceRemoved', USBDeviceRemoved);
  BroadcastManager.on('ApplicationStarted', ApplicationStarted);
  BroadcastManager.on('ApplicationStopped', ApplicationStopped);
  BroadcastManager.on('ReadoptDevice', ReadoptDevice);
  BroadcastManager.on('ReinitializeSystem', ReinitializeSystem);
  BroadcastManager.on('ClientUpdated', ClientUpdated);
  BroadcastManager.on('ScriptsUpdated', OnScriptsUpdated);
  BroadcastManager.on('GroupListChanged', UpdateFullClientList);
  BroadcastManager.on('ClientListChanged', UpdateFullClientList);
  BroadcastManager.on('MonitoringTargetListChanged', UpdateMonitoringTargetList);
  BroadcastManager.on('MonitoringTargetUpdated', MonitoringTargetUpdated);
  BroadcastManager.on('DummyClientListChanged', UpdateDummyClientList);
  BroadcastManager.on('DummyClientUpdated', DummyClientUpdated);
  BroadcastManager.on('AdoptionListUpdated', UpdateAdoptionList);
  BroadcastManager.on('ScriptExecutionUpdated', UpdateScriptExecutions);
  BroadcastManager.on('AlertRuleListChanged', UpdateAlertRuleList);
  BroadcastManager.on('Notify', Notify);
  BroadcastManager.on('PlaySound', PlaySound);
  BroadcastManager.on('OSCBulkAction', HandleOSCBulkAction);

  for (const [event, channel] of PASSTHROUGH) {
    BroadcastManager.on(event, (...args: unknown[]) => {
      if (!hasMainWindow()) return;
      PushToRenderers(channel, ...args);
    });
  }

  // Relay application mode changes to renderer windows.
  ModeManager.on('ModeUpdated', (Mode: unknown) => {
    if (!hasMainWindow()) return;
    PushToRenderers('ModeUpdated', Mode);
  });
}

export {
  RegisterBroadcastBridge,
  UpdateSettings,
  UpdateAdoptionList,
  UpdateFullClientList,
  UpdateScriptList,
  UpdateOSCList,
  UpdateMonitoringTargetList,
  UpdateDummyClientList,
  UpdateAlertRuleList,
  ValidateAlertAudioAssets,
};
