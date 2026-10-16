// Audit log status recorder (main process).
//
// Subscribes straight to the Broadcast events every status change passes
// through, rather than going via the renderer bridge or the alert manager:
// the bridge skips some events while no window is open, and the alert manager
// holds faults back for its start-up settle window. The log records what
// happened when it happened, window or no window.
//
// Each entity's last seen state lives here (see Modules/AuditLog/status for
// what is compared). It is a few small records per entity, so a deleted one is
// simply left behind rather than tracked down. Heartbeats arrive as ClientUpdated like everything else
// and fall out naturally: a heartbeat that changes nothing produces nothing.
import { CreateLogger } from '../Modules/Logger';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as AuditLog } from '../Modules/AuditLog';
import {
  DiffClientStatus,
  DiffDummyStatus,
  DiffFreeKioskStatus,
  DiffMonitorStatus,
} from '../Modules/AuditLog/status';
import type {
  ClientAuditState,
  ClientStatusLike,
  DummyStatusLike,
  FreeKioskAuditState,
  FreeKioskStatusLike,
  MonitorAuditState,
  MonitorStatusLike,
} from '../Modules/AuditLog/status';
import type { AuditRecordInput } from '../Modules/AuditLog';

const Logger = CreateLogger('AuditRecorder');

const ClientStates = new Map<string, ClientAuditState>();
const DummyStates = new Map<string, string>();
const FreeKioskStates = new Map<string, FreeKioskAuditState>();
const MonitorStates = new Map<string, MonitorAuditState>();

let Registered = false;

function Write(Entries: AuditRecordInput[]): void {
  for (const Entry of Entries) AuditLog.Record(Entry);
}

function KeyOf(Value: unknown): string {
  return Value === null || Value === undefined ? '' : String(Value);
}

function OnClientUpdated(Client: ClientStatusLike): void {
  try {
    const Key = KeyOf(Client && Client.UUID);
    if (!Key) return;
    const { State, Entries } = DiffClientStatus(ClientStates.get(Key), Client);
    ClientStates.set(Key, State);
    Write(Entries);
  } catch (Err) {
    Logger.error('Failed to record a client status change:', Err);
  }
}

function OnDummyClientUpdated(Dummy: DummyStatusLike): void {
  try {
    const Key = KeyOf(Dummy && Dummy.UUID);
    if (!Key) return;
    const { State, Entries } = DiffDummyStatus(DummyStates.get(Key), Dummy);
    DummyStates.set(Key, State);
    Write(Entries);
  } catch (Err) {
    Logger.error('Failed to record a dummy client status change:', Err);
  }
}

function OnFreeKioskTerminalUpdated(Terminal: FreeKioskStatusLike): void {
  try {
    const Key = KeyOf(Terminal && Terminal.UUID);
    if (!Key) return;
    const { State, Entries } = DiffFreeKioskStatus(FreeKioskStates.get(Key), Terminal);
    if (State) FreeKioskStates.set(Key, State);
    Write(Entries);
  } catch (Err) {
    Logger.error('Failed to record a FreeKiosk status change:', Err);
  }
}

function OnMonitoringTargetUpdated(Target: MonitorStatusLike): void {
  try {
    const Key = KeyOf(Target && Target.TargetID);
    if (!Key) return;
    const { State, Entries } = DiffMonitorStatus(MonitorStates.get(Key), Target);
    MonitorStates.set(Key, State);
    Write(Entries);
  } catch (Err) {
    Logger.error('Failed to record a monitor status change:', Err);
  }
}

export function RegisterAuditRecorder(): void {
  if (Registered) return;
  Registered = true;
  BroadcastManager.on('ClientUpdated', OnClientUpdated);
  BroadcastManager.on('DummyClientUpdated', OnDummyClientUpdated);
  BroadcastManager.on('FreeKioskTerminalUpdated', OnFreeKioskTerminalUpdated);
  BroadcastManager.on('MonitoringTargetUpdated', OnMonitoringTargetUpdated);
}

// For tests: start from nothing.
export function ResetAuditRecorder(): void {
  ClientStates.clear();
  DummyStates.clear();
  FreeKioskStates.clear();
  MonitorStates.clear();
}
