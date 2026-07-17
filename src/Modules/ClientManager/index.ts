// ClientManager
// - Tracks connected clients in memory for fast updates
// - Persists durable fields to the database (nickname, group, IP, etc.)
// - Emits events on changes so UI and other modules remain reactive
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateClientsRepository } from '../DB/repositories/clients';
import { CreateCriticalEntitiesRepository } from '../DB/repositories/critical-entities';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as UUIDManager } from '../UUID';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import { Client } from './client';
import {
  AsRecord,
  normalizeSerialNumber,
  normalizeUSBNameKey,
  normalizeApplicationName,
  normalizeApplicationKey,
  normalizeDisplayID,
} from './normalizers';
import { NormalizeIntegratedActions } from './integrated-actions';
import { makeCriticalIndex } from './critical-index';
import type {
  CriticalUSBDeviceRow,
  CriticalUSBDeviceNameRow,
  CriticalApplicationRow,
  CriticalDisplayRow,
} from '../DB/rows';
import type { HeartbeatPayload, USBDevice } from '@showtrak/protocol';
import type {
  CriticalUSBDevicePayloadResult,
  CriticalUSBNamePayloadResult,
  CriticalApplicationPayloadResult,
  CriticalDisplayPayloadResult,
} from '../IPCValidation';

// One entry of the `SystemInfo` MAC-address map: the client reports each
// interface as `{ ipv4, mac }` (the wire values consumed by the MAC-for-active-IP
// derivation below).
interface SystemInfoMacEntry {
  ipv4: string;
  mac: string;
}
// The `SystemInfo` telemetry payload as consumed here (validated upstream by
// SocketValidation.SystemInfo before dispatch).
interface SystemInfoData {
  Hostname: string;
  OperatingSystem: string;
  MacAddresses: Record<string, SystemInfoMacEntry>;
}

const Logger = CreateLogger('ClientManager');

const ClientsRepo = CreateClientsRepository(DB);
const CriticalRepo = CreateCriticalEntitiesRepository(DB);

// Public surface of the ClientManager. Exported so consumers that must break an
// import cycle with a lazy `require('../ClientManager')` can type the cast as
// `{ Manager: ClientManagerType }` instead of `{ Manager: any }`. Most methods
// follow the `Result<T>` tuple convention; the few that predate it (`Exists`,
// `GetClientsInGroup`, and the void lifecycle hooks) keep their historical shape.
export interface ClientManagerType {
  Initialized: boolean;
  Init(): Promise<void>;
  ClearCache(): Promise<void>;
  Timeout(UUID: string): Promise<void>;
  Heartbeat(UUID: string, Data: HeartbeatPayload, IP: string): Promise<Result<string>>;
  SystemInfo(UUID: string, Data: SystemInfoData, IP: string): Promise<Result<string>>;
  SetUSBDeviceList(UUID: string, DeviceList: unknown): Promise<Result<string>>;
  SetIntegratedActions(UUID: string, Actions: unknown): Promise<Result<unknown[]>>;
  SetIntegratedState(UUID: string, State: unknown, Message: unknown): Promise<Result<boolean>>;
  SetIdentifying(UUID: string, Identifying: unknown): Promise<Result<boolean>>;
  SetNetworkInterfaces(UUID: string, Interfaces: unknown): Promise<Result<string>>;
  SetRunningApplications(UUID: string, Snapshot: unknown): Promise<Result<string>>;
  SetDisplayList(UUID: string, DisplayList: unknown): Promise<Result<string>>;
  MarkApplicationCritical(
    UUID: string,
    Application: CriticalApplicationPayloadResult
  ): Promise<Result<boolean>>;
  RemoveApplicationCritical(UUID: string, ApplicationName: unknown): Promise<Result<boolean>>;
  IsApplicationCritical(UUID: string, ApplicationName: unknown): Promise<Result<boolean>>;
  MarkUSBDeviceCritical(
    UUID: string,
    Device: CriticalUSBDevicePayloadResult
  ): Promise<Result<boolean>>;
  RemoveUSBDeviceCritical(UUID: string, SerialNumber: unknown): Promise<Result<boolean>>;
  IsUSBDeviceCritical(UUID: string, SerialNumber: unknown): Promise<Result<boolean>>;
  MarkUSBNameCritical(
    UUID: string,
    Device: CriticalUSBNamePayloadResult
  ): Promise<Result<boolean>>;
  RemoveUSBNameCritical(
    UUID: string,
    Device: CriticalUSBNamePayloadResult
  ): Promise<Result<boolean>>;
  IsUSBNameCritical(UUID: string, NameKey: unknown): Promise<Result<boolean>>;
  MarkDisplayCritical(
    UUID: string,
    Display: CriticalDisplayPayloadResult
  ): Promise<Result<boolean>>;
  RemoveDisplayCritical(UUID: string, DisplayID: unknown): Promise<Result<boolean>>;
  IsDisplayCritical(UUID: string, DisplayID: unknown): Promise<Result<boolean>>;
  USBDeviceAdded(UUID: string, Device: USBDevice): Promise<Result<string>>;
  USBDeviceRemoved(UUID: string, Device: USBDevice): Promise<Result<string>>;
  Update(UUID: string, Data: unknown): Promise<Result<Client>>;
  Create(UUID: string): Promise<Result<boolean>>;
  CreateUnassigned(Name: string, Count: number): Promise<Result<Client[]>>;
  Delete(UUID: string): Promise<Result<boolean>>;
  ReplaceClient(CurrentUUID: unknown, ReplacementUUID: unknown): Promise<Result<Client>>;
  Exists(UUID: string): Promise<boolean>;
  Get(UUID: string): Promise<Result<Client>>;
  GetAll(): Promise<Result<Client[]>>;
  GetClientsInGroup(GroupID: unknown): Promise<Client[]>;
  MoveGroupToNoGroup(GroupID: unknown): Promise<Result<number>>;
  ReconcileOrphanedGroups(ValidGroupIDs: unknown): Promise<Result<number>>;
  SetGroupOrder(GroupID: unknown, orderedUUIDs: unknown): Promise<Result<boolean>>;
  SetGroupOrderWithWeights(
    GroupID: unknown,
    orderedUUIDs: unknown,
    weights: unknown
  ): Promise<Result<boolean>>;
}

// Assigned method-by-method below; the assertion lets that incremental style
// stand while every assignment is still checked against the interface member.
const Manager = {} as ClientManagerType;

// Hot cache of Client instances reflecting current state
let ClientList: Client[] = [];
const ClientIndex = new Map<string, Client>();

function rebuildClientIndex() {
  ClientIndex.clear();
  for (const Entry of ClientList) {
    if (!Entry || !Entry.UUID) continue;
    ClientIndex.set(Entry.UUID, Entry);
  }
}

// Apply the current critical-entity state (USB serials, USB names, apps,
// displays) onto a freshly built Client. Every hydration path funnels through
// here so the four applyState calls stay in one place instead of being copied
// at each `new Client(...)` site. Returns the same instance for chaining.
function applyCriticalState(Entity: Client): Client {
  CriticalUSB.applyState(Entity);
  CriticalUSBNames.applyState(Entity);
  CriticalApplications.applyState(Entity);
  CriticalDisplays.applyState(Entity);
  return Entity;
}

// Insert TargetClient into the cache, or — if an instance for its UUID already
// resides — return that resident instance and discard the newcomer. `added`
// reports whether an insert happened (drives the ClientListChanged emit);
// `client` is always the authoritative cached instance. Returning the resident
// closes the race where two concurrent hydrations of the same UUID would each
// keep their own detached copy and mutate an orphan.
function adoptIntoCache(TargetClient: Client): { client: Client; added: boolean } {
  const Existing = TargetClient && TargetClient.UUID ? ClientIndex.get(TargetClient.UUID) : null;
  if (Existing) return { client: Existing, added: false };
  if (!TargetClient || !TargetClient.UUID) return { client: TargetClient, added: false };
  ClientList.push(TargetClient);
  ClientIndex.set(TargetClient.UUID, TargetClient);
  return { client: TargetClient, added: true };
}

function addClientToCache(TargetClient: Client) {
  return adoptIntoCache(TargetClient).added;
}

function removeClientFromCache(UUID: string) {
  if (!ClientIndex.has(UUID)) return false;
  ClientIndex.delete(UUID);
  ClientList = ClientList.filter((Client) => Client.UUID !== UUID);
  return true;
}

function replaceUUIDInValue(Value: unknown, OldUUID: string, NewUUID: string): unknown {
  if (typeof Value === 'string') {
    return Value === OldUUID ? NewUUID : Value;
  }
  if (Array.isArray(Value)) {
    return Value.map((Entry) => replaceUUIDInValue(Entry, OldUUID, NewUUID));
  }
  if (Value && typeof Value === 'object') {
    const Next: Record<string, unknown> = {};
    for (const [Key, Entry] of Object.entries(Value)) {
      Next[Key] = replaceUUIDInValue(Entry, OldUUID, NewUUID);
    }
    return Next;
  }
  return Value;
}

// Per-client critical-entity indexes. The entry shape stored per kind mirrors
// what the matching Client.SetCritical* sink consumes (the USB entry carries a
// redundant UUID for parity with the historical index; the sink ignores it).
interface USBIndexEntry {
  UUID: string;
  SerialNumber: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Timestamp: number | null;
}
interface USBNameIndexEntry {
  NameKey: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Quantity: number;
  Timestamp: number | null;
}
interface ApplicationIndexEntry {
  Name: string;
  Key: string;
  Timestamp: number | null;
}
interface DisplayIndexEntry {
  DisplayID: string;
  Label: string | null;
  Width: number | null;
  Height: number | null;
  RefreshRate: number | null;
  ScaleFactor: number | null;
  Timestamp: number | null;
}

const CriticalUSB = makeCriticalIndex<CriticalUSBDeviceRow, USBIndexEntry>({
  loadAll: () => CriticalRepo.LoadAllUSB(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const SerialNumber = normalizeSerialNumber(Row && Row.SerialNumber);
    if (!UUID || !SerialNumber) return null;
    return {
      UUID,
      Key: SerialNumber,
      Entry: {
        UUID,
        SerialNumber,
        ManufacturerName: Row.ManufacturerName || null,
        ProductName: Row.ProductName || null,
        Timestamp: Row.Timestamp || null,
      },
    };
  },
  apply: (client, entries) => client.SetCriticalUSBDevices(entries),
});

const CriticalUSBNames = makeCriticalIndex<CriticalUSBDeviceNameRow, USBNameIndexEntry>({
  loadAll: () => CriticalRepo.LoadAllUSBNames(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const NameKey = Row && Row.NameKey ? String(Row.NameKey).trim().toLowerCase() : '';
    if (!UUID || !NameKey) return null;
    return {
      UUID,
      Key: NameKey,
      Entry: {
        NameKey,
        ManufacturerName: Row.ManufacturerName || null,
        ProductName: Row.ProductName || null,
        Quantity: Math.max(1, parseInt(String(Row.Quantity), 10) || 1),
        Timestamp: Row.Timestamp || null,
      },
    };
  },
  apply: (client, entries) => client.SetCriticalUSBNames(entries),
});

const CriticalApplications = makeCriticalIndex<CriticalApplicationRow, ApplicationIndexEntry>({
  loadAll: () => CriticalRepo.LoadAllApplications(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const ApplicationKey = Row && Row.ApplicationKey ? String(Row.ApplicationKey).trim() : '';
    const ApplicationName = Row && Row.ApplicationName ? String(Row.ApplicationName).trim() : '';
    if (!UUID || !ApplicationKey || !ApplicationName) return null;
    return {
      UUID,
      Key: ApplicationKey,
      Entry: { Name: ApplicationName, Key: ApplicationKey, Timestamp: Row.Timestamp || null },
    };
  },
  apply: (client, entries) => client.SetCriticalApplications(entries),
});

const CriticalDisplays = makeCriticalIndex<CriticalDisplayRow, DisplayIndexEntry>({
  loadAll: () => CriticalRepo.LoadAllDisplays(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const DisplayID = normalizeDisplayID(Row && Row.DisplayID);
    if (!UUID || !DisplayID) return null;
    return {
      UUID,
      Key: DisplayID,
      Entry: {
        DisplayID,
        Label: Row.Label || null,
        Width: Row.Width != null ? parseInt(String(Row.Width), 10) || null : null,
        Height: Row.Height != null ? parseInt(String(Row.Height), 10) || null : null,
        RefreshRate:
          Row.RefreshRate != null ? parseInt(String(Row.RefreshRate), 10) || null : null,
        ScaleFactor:
          Row.ScaleFactor != null && Number.isFinite(Number(Row.ScaleFactor))
            ? Number(Row.ScaleFactor)
            : null,
        Timestamp: Row.Timestamp || null,
      },
    };
  },
  apply: (client, entries) => client.SetCriticalDisplays(entries),
});

Manager.Timeout = async (UUID: string) => {
  const Exists = await Manager.Exists(UUID);
  if (!Exists) return;
  const [Err, TimedOutClient] = await Manager.Get(UUID);
  if (Err) return Logger.error('Failed to get client for timeout:', Err);
  if (!TimedOutClient) return Logger.warn(`Client ${UUID} not found for timeout.`);
  TimedOutClient.SetOnline(false);
  return;
};

// Fast path for frequent telemetry: update cached client or hydrate from DB
Manager.Heartbeat = async (UUID: string, Data: HeartbeatPayload, IP: string) => {
  let CachedClient = ClientIndex.get(UUID) || null;
  if (!CachedClient) {
    Logger.warn(`Client ${UUID} not found in memory, fetching from database.`);
    const [Err, FetchedClient] = await ClientsRepo.GetByUUID(UUID);
    if (Err) {
      Logger.error('Failed to fetch client from database:', Err);
      return Fail('Failed to fetch client');
    }
    if (!FetchedClient) {
      return Fail('Client Not Valid');
    } else {
      const { client, added } = adoptIntoCache(applyCriticalState(new Client(FetchedClient)));
      CachedClient = client;
      if (added) {
        BroadcastManager.emit('ClientListChanged');
      }
    }
  }

  await CachedClient.SetVersion(Data.Version || null, { markUnsaved: false });
  await CachedClient.SetIP(IP || null, { markUnsaved: false });
  CachedClient.SetScriptsFingerprint(
    Data && Data.ScriptsFingerprint ? Data.ScriptsFingerprint : null
  );
  CachedClient.SetOnline(true);
  CachedClient.SetLastSeen(Date.now());
  CachedClient.SetVitals(Data.Vitals);

  return Ok('Heartbeat processed successfully');
};

Manager.SetUSBDeviceList = async (UUID: string, DeviceList: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.SetUSBDeviceList(DeviceList);
  return Ok('USB Device List updated successfully');
};

// Register/replace the integrated action (event) catalog declared by an
// integrated client over Socket.IO. The payload is normalized/sanitized before
// being stored on the cached Client instance.
Manager.SetIntegratedActions = async (UUID: string, Actions: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Normalized = NormalizeIntegratedActions(Actions);
  Target.SetIntegratedActions(Normalized);
  return Ok(Normalized);
};

// Apply a manual health state (ONLINE / DEGRADED) reported by an integrated
// client over the SDK. OFFLINE is rejected (driven by the connection only).
Manager.SetIntegratedState = async (UUID: string, State: unknown, Message: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Applied = Target.SetIntegratedState(State, Message);
  if (!Applied) return Fail('Invalid integrated state');
  return Ok(true);
};

// Toggle identify mode on a client. Ensures the client is cached so the
// runtime flag survives until the next heartbeat re-render.
Manager.SetIdentifying = async (UUID: string, Identifying: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.SetIdentifying(Identifying);
  return Ok(true);
};

Manager.SetNetworkInterfaces = async (UUID: string, Interfaces: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.SetNetworkInterfaces(Interfaces);
  return Ok('Network Interfaces updated successfully');
};

Manager.SetRunningApplications = async (UUID: string, Snapshot: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.SetRunningApplications(Snapshot || {});
  return Ok('Running applications updated successfully');
};

Manager.MarkApplicationCritical = async (
  UUID: string,
  Application: CriticalApplicationPayloadResult
) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const ApplicationName = normalizeApplicationName(Application?.Name);
  if (!ApplicationName) return Fail('Application name is required');

  const ApplicationKey = ApplicationName.toLowerCase();
  const Timestamp = Date.now();
  const [WriteErr] = await CriticalRepo.MarkApplication(
    UUID,
    ApplicationKey,
    ApplicationName,
    Timestamp
  );
  if (WriteErr) return Fail('Failed to save critical application');

  CriticalApplications.setForClient(UUID, ApplicationKey, {
    Name: ApplicationName,
    Key: ApplicationKey,
    Timestamp,
  });
  Target.MarkCriticalApplication({ Name: ApplicationName, Timestamp });
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.RemoveApplicationCritical = async (UUID: string, ApplicationName: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const NormalizedName = normalizeApplicationName(ApplicationName);
  if (!NormalizedName) return Fail('Application name is required');
  const ApplicationKey = NormalizedName.toLowerCase();

  const [WriteErr] = await CriticalRepo.RemoveApplication(UUID, ApplicationKey);
  if (WriteErr) return Fail('Failed to remove critical application');

  CriticalApplications.removeForClient(UUID, ApplicationKey);

  Target.UnmarkCriticalApplication(NormalizedName);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsApplicationCritical = async (UUID: string, ApplicationName: unknown) => {
  const NormalizedName = normalizeApplicationKey(ApplicationName);
  if (!NormalizedName) return Ok(false);

  const Cached = CriticalApplications.getForClient(UUID, false);
  if (Cached) return Ok(Cached.has(NormalizedName));

  const [Err, Row] = await CriticalRepo.IsApplicationCritical(UUID, NormalizedName);
  if (Err) return Fail('Failed to determine critical application status');
  return Ok(!!Row);
};

Manager.USBDeviceAdded = async (UUID: string, Device: USBDevice) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.USBDeviceAdded(Device);
  return Ok('Updated');
};

Manager.USBDeviceRemoved = async (UUID: string, Device: USBDevice) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.USBDeviceRemoved(Device);
  return Ok('Updated');
};

Manager.MarkUSBDeviceCritical = async (UUID: string, Device: CriticalUSBDevicePayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const SerialNumber = normalizeSerialNumber(Device && Device.SerialNumber);
  if (!SerialNumber) return Fail('Device serial number is required');

  const KnownDevice = (
    Array.isArray(Target.ConnectedUSBDeviceList) ? Target.ConnectedUSBDeviceList : []
  ).find((Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) === SerialNumber);
  const ManufacturerName =
    (KnownDevice && KnownDevice.ManufacturerName) || (Device && Device.ManufacturerName) || null;
  const ProductName =
    (KnownDevice && KnownDevice.ProductName) || (Device && Device.ProductName) || null;

  const [WriteErr] = await CriticalRepo.MarkUSB(
    UUID,
    SerialNumber,
    ManufacturerName,
    ProductName,
    Date.now()
  );
  if (WriteErr) return Fail('Failed to save critical USB device');

  CriticalUSB.setForClient(UUID, SerialNumber, {
    UUID,
    SerialNumber,
    ManufacturerName,
    ProductName,
    Timestamp: Date.now(),
  });
  Target.MarkCriticalUSBDevice({
    SerialNumber,
    ManufacturerName,
    ProductName,
    Timestamp: Date.now(),
  });
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.RemoveUSBDeviceCritical = async (UUID: string, SerialNumber: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const NormalizedSerial = normalizeSerialNumber(SerialNumber);
  if (!NormalizedSerial) return Fail('Device serial number is required');

  const [WriteErr] = await CriticalRepo.RemoveUSB(UUID, NormalizedSerial);
  if (WriteErr) return Fail('Failed to remove critical USB device');

  CriticalUSB.removeForClient(UUID, NormalizedSerial);

  Target.UnmarkCriticalUSBSerial(NormalizedSerial);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsUSBDeviceCritical = async (UUID: string, SerialNumber: unknown) => {
  const Normalized = normalizeSerialNumber(SerialNumber);
  if (!Normalized) return Ok(false);

  const Cached = CriticalUSB.getForClient(UUID, false);
  if (Cached) return Ok(Cached.has(Normalized));

  const [Err, Row] = await CriticalRepo.IsUSBCritical(UUID, Normalized);
  if (Err) return Fail('Failed to determine critical USB status');
  return Ok(!!Row);
};

Manager.MarkUSBNameCritical = async (UUID: string, Device: CriticalUSBNamePayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const ManufacturerName = (Device && Device.ManufacturerName) || null;
  const ProductName = (Device && Device.ProductName) || null;
  const NameKey = normalizeUSBNameKey(ManufacturerName, ProductName);
  if (!NameKey) return Fail('Device name is required');

  // Auto-capture the expected quantity from how many devices of this name are
  // currently connected (at least one, so the guard is meaningful).
  const ConnectedCount = (
    Array.isArray(Target.ConnectedUSBDeviceList) ? Target.ConnectedUSBDeviceList : []
  ).filter(
    (Entry) => normalizeUSBNameKey(Entry && Entry.ManufacturerName, Entry && Entry.ProductName) === NameKey
  ).length;
  const Quantity = Math.max(1, ConnectedCount);

  const [WriteErr] = await CriticalRepo.MarkUSBName(
    UUID,
    NameKey,
    ManufacturerName,
    ProductName,
    Quantity,
    Date.now()
  );
  if (WriteErr) return Fail('Failed to save critical USB device');

  CriticalUSBNames.setForClient(UUID, NameKey, {
    NameKey,
    ManufacturerName,
    ProductName,
    Quantity,
    Timestamp: Date.now(),
  });
  Target.MarkCriticalUSBName({
    NameKey,
    ManufacturerName,
    ProductName,
    Quantity,
    Timestamp: Date.now(),
  });
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.RemoveUSBNameCritical = async (UUID: string, Device: CriticalUSBNamePayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const NameKey = normalizeUSBNameKey(
    Device && Device.ManufacturerName,
    Device && Device.ProductName
  );
  if (!NameKey) return Fail('Device name is required');

  const [WriteErr] = await CriticalRepo.RemoveUSBName(UUID, NameKey);
  if (WriteErr) return Fail('Failed to remove critical USB device');

  CriticalUSBNames.removeForClient(UUID, NameKey);
  Target.UnmarkCriticalUSBName(NameKey);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsUSBNameCritical = async (UUID: string, NameKey: unknown) => {
  const Normalized = typeof NameKey === 'string' ? NameKey.trim().toLowerCase() : '';
  if (!Normalized) return Ok(false);

  const Cached = CriticalUSBNames.getForClient(UUID, false);
  if (Cached) return Ok(Cached.has(Normalized));

  const [Err, Row] = await CriticalRepo.IsUSBNameCritical(UUID, Normalized);
  if (Err) return Fail('Failed to determine critical USB status');
  return Ok(!!Row);
};

Manager.SetDisplayList = async (UUID: string, DisplayList: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.SetDisplayList(DisplayList);
  return Ok('Display List updated successfully');
};

Manager.MarkDisplayCritical = async (UUID: string, Display: CriticalDisplayPayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const DisplayID = normalizeDisplayID(Display && Display.DisplayID);
  if (!DisplayID) return Fail('Display identifier is required');

  // Prefer the live values reported by the client so the captured baseline
  // (resolution + refresh rate) reflects the current, known-good state.
  const KnownDisplay = (
    Array.isArray(Target.ConnectedDisplayList) ? Target.ConnectedDisplayList : []
  ).find((Entry) => normalizeDisplayID(Entry && Entry.DisplayID) === DisplayID);
  const Source = AsRecord(KnownDisplay || Display);

  const Label = (Source.Label as string | null) || Display.Label || null;
  const Width = parseInt(String(Source.Width), 10) || null;
  const Height = parseInt(String(Source.Height), 10) || null;
  const RefreshRate =
    Source.RefreshRate != null && Number.isFinite(Number(Source.RefreshRate))
      ? Math.round(Number(Source.RefreshRate))
      : null;
  const ScaleFactor =
    Source.ScaleFactor != null && Number.isFinite(Number(Source.ScaleFactor))
      ? Number(Source.ScaleFactor)
      : null;
  const Timestamp = Date.now();

  const [WriteErr] = await CriticalRepo.MarkDisplay(
    UUID,
    DisplayID,
    Label,
    Width,
    Height,
    RefreshRate,
    ScaleFactor,
    Timestamp
  );
  if (WriteErr) return Fail('Failed to save critical display');

  CriticalDisplays.setForClient(UUID, DisplayID, {
    DisplayID,
    Label,
    Width,
    Height,
    RefreshRate,
    ScaleFactor,
    Timestamp,
  });
  Target.MarkCriticalDisplay({
    DisplayID,
    Label,
    Width,
    Height,
    RefreshRate,
    ScaleFactor,
    Timestamp,
  });
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.RemoveDisplayCritical = async (UUID: string, DisplayID: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const NormalizedID = normalizeDisplayID(DisplayID);
  if (!NormalizedID) return Fail('Display identifier is required');

  const [WriteErr] = await CriticalRepo.RemoveDisplay(UUID, NormalizedID);
  if (WriteErr) return Fail('Failed to remove critical display');

  CriticalDisplays.removeForClient(UUID, NormalizedID);

  Target.UnmarkCriticalDisplay(NormalizedID);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsDisplayCritical = async (UUID: string, DisplayID: unknown) => {
  const Normalized = normalizeDisplayID(DisplayID);
  if (!Normalized) return Ok(false);

  const Cached = CriticalDisplays.getForClient(UUID, false);
  if (Cached) return Ok(Cached.has(Normalized));

  const [Err, Row] = await CriticalRepo.IsDisplayCritical(UUID, Normalized);
  if (Err) return Fail('Failed to determine critical display status');
  return Ok(!!Row);
};

// One-shot richer payload: hostname + NICs -> derive MAC for the active IP
Manager.SystemInfo = async (UUID: string, Data: SystemInfoData, IP: string) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  await Target.SetHostname(Data.Hostname || null, { markUnsaved: false });
  await Target.SetOperatingSystem(Data.OperatingSystem || null, { markUnsaved: false });
  const Macs = Object.values(Data.MacAddresses || {}) as SystemInfoMacEntry[];
  for (const Interface of Macs) {
    if (Interface.ipv4 === IP) await Target.SetMacAddress(Interface.mac, { markUnsaved: false });
  }

  return Ok('Heartbeat processed successfully');
};

Manager.Update = async (UUID: string, Data: unknown) => {
  const [Err, Client] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Client) return Fail('Client Not Found');
  const Fields = AsRecord(Data);
  const TouchesLaunch =
    Object.prototype.hasOwnProperty.call(Fields, 'RunOnLaunchScriptID') ||
    Object.prototype.hasOwnProperty.call(Fields, 'RunOnLaunchDelaySeconds');
  if (TouchesLaunch && Client.Integrated === true) {
    return Fail('Launch actions are not supported for integrated clients');
  }
  // Surface the first failed persist rather than reporting Ok unconditionally —
  // the setters roll their own RAM back on failure, so returning Fail here keeps
  // the UI's view aligned with what actually landed in the row.
  if (Object.prototype.hasOwnProperty.call(Fields, 'Nickname')) {
    const [SetErr] = await Client.SetNickname(Fields.Nickname as string | null);
    if (SetErr) return Fail(SetErr);
  }
  if (Object.prototype.hasOwnProperty.call(Fields, 'GroupID')) {
    const [SetErr] = await Client.SetGroupID(Fields.GroupID as number | string | null);
    if (SetErr) return Fail(SetErr);
  }
  if (Object.prototype.hasOwnProperty.call(Fields, 'RunOnLaunchScriptID')) {
    const [SetErr] = await Client.SetRunOnLaunchScriptID(Fields.RunOnLaunchScriptID as string | null);
    if (SetErr) return Fail(SetErr);
  }
  if (Object.prototype.hasOwnProperty.call(Fields, 'RunOnLaunchDelaySeconds')) {
    const [SetErr] = await Client.SetRunOnLaunchDelaySeconds(
      Fields.RunOnLaunchDelaySeconds as number | null
    );
    if (SetErr) return Fail(SetErr);
  }
  return Ok(Client);
};

// Adopt a client by creating a durable DB row and adding to the cache
Manager.Create = async (UUID: string) => {
  // Verify if the client already exists
  const [Err, ExistingClient] = await ClientsRepo.GetByUUID(UUID);
  if (Err) return Fail('Failed to fetch existing client');
  if (ExistingClient) return Fail('Client already exists');
  // Insert new client into the database
  const [InsertErr, _Res] = await ClientsRepo.Insert(UUID, Date.now());
  if (InsertErr) return Fail('Failed to insert new client');
  const Created = applyCriticalState(
    new Client({
      UUID: UUID,
      Hostname: null,
      OperatingSystem: null,
      Version: 'X.X.X',
      IP: null,
      Timestamp: Date.now(),
    })
  );
  if (addClientToCache(Created)) {
    BroadcastManager.emit('ClientListChanged');
  }
  return Ok(true);
};

// Operating system every reserved slot starts as. Matches the canonical value
// the first-party client reports, so platform-gated scripts resolve the same
// way they will once real hardware fills the slot.
const UNASSIGNED_DEFAULT_OS = 'Windows';

// Create one or more reserved slots — client rows with no hardware behind them,
// standing in for machines that have not arrived yet. Their UUIDs are random
// (nothing will ever connect with them) and every descriptive field is filler;
// the operator later points a real device at the slot via ReplaceClient, which
// clears the Unassigned flag and turns it into an ordinary client.
Manager.CreateUnassigned = async (Name: string, Count: number) => {
  if (!Name) return Fail('A name is required');
  if (!Number.isInteger(Count) || Count < 1) return Fail('Count must be a positive integer');

  const Created: Client[] = [];
  for (let Index = 0; Index < Count; Index++) {
    // A single slot keeps the bare name; a batch is numbered so the operator can
    // tell the slots apart before they are renamed.
    const Nickname = Count === 1 ? Name : `${Name} ${Index + 1}`;
    const UUID = UUIDManager.Generate();
    const Timestamp = Date.now();

    const [InsertErr] = await ClientsRepo.InsertUnassigned(
      UUID,
      Nickname,
      UNASSIGNED_DEFAULT_OS,
      Timestamp
    );
    if (InsertErr) {
      Logger.error('Failed to insert unassigned client', InsertErr);
      // Slots already inserted stay — they are independently valid, and the
      // caller is told how many landed rather than losing the whole batch.
      break;
    }

    const Slot = applyCriticalState(
      new Client({
        UUID,
        Nickname,
        Hostname: Nickname,
        OperatingSystem: UNASSIGNED_DEFAULT_OS,
        Version: 'X.X.X',
        IP: null,
        Unassigned: true,
        Timestamp,
      })
    );
    if (addClientToCache(Slot)) Created.push(Slot);
  }

  if (!Created.length) return Fail('Failed to create unassigned clients');
  BroadcastManager.emit('ClientListChanged');
  Logger.success(`Created ${Created.length} unassigned client(s)`);
  return Ok(Created);
};

// Unadopt or purge a client; remove from DB and cache
Manager.Delete = async (UUID: string) => {
  // One transaction across all five tables so a mid-sequence failure can never
  // leave the client row and its critical rows half-deleted.
  const [Err] = await ClientsRepo.DeleteClientCascade(UUID);
  if (Err) return Fail('Failed to delete client');
  // Remove from in-memory list
  removeClientFromCache(UUID);
  CriticalUSB.clearForClient(UUID);
  CriticalUSBNames.clearForClient(UUID);
  CriticalApplications.clearForClient(UUID);
  CriticalDisplays.clearForClient(UUID);
  Logger.success(`Client ${UUID} deleted successfully`);
  return Ok(true);
};

Manager.ReplaceClient = async (CurrentUUID: unknown, ReplacementUUID: unknown) => {
  const OldUUID = String(CurrentUUID || '').trim();
  const NewUUID = String(ReplacementUUID || '').trim();
  if (!OldUUID || !NewUUID) return Fail('Client UUID is required');
  if (OldUUID === NewUUID) return Fail('Replacement client must be different');

  const [OldErr, ExistingClient] = await Manager.Get(OldUUID);
  if (OldErr || !ExistingClient) return Fail('Current client not found');
  if (ExistingClient.Online) return Fail('Current client must be offline before replacement');

  const NewExists = await Manager.Exists(NewUUID);
  if (NewExists) return Fail('Replacement client is already adopted');

  const oldClientRows = ClientList.slice();

  const [TxErr] = await ClientsRepo.ReplaceClientUUID(OldUUID, NewUUID, (Value) =>
    replaceUUIDInValue(Value, OldUUID, NewUUID)
  );

  if (TxErr) {
    Logger.error('Failed to replace client UUID', TxErr);
    return Fail('Failed to replace client');
  }

  ExistingClient.UUID = NewUUID;
  // The transaction above already cleared the column; mirror it in the cached
  // entity so the slot stops rendering as unassigned without waiting for a
  // restart to re-hydrate from the row.
  ExistingClient.SetUnassigned(false);
  ClientList = oldClientRows.filter(
    (Client) => Client.UUID !== OldUUID && Client.UUID !== NewUUID
  );
  ClientList.push(ExistingClient);
  rebuildClientIndex();

  CriticalUSB.rekeyClient(OldUUID, NewUUID);
  CriticalUSBNames.rekeyClient(OldUUID, NewUUID);
  CriticalApplications.rekeyClient(OldUUID, NewUUID);
  CriticalDisplays.rekeyClient(OldUUID, NewUUID);

  applyCriticalState(ExistingClient);

  BroadcastManager.emit('ClientListChanged');
  BroadcastManager.emit('ClientUpdated', ExistingClient);
  BroadcastManager.emit('AlertRuleListChanged');
  return Ok(ExistingClient);
};

// Truthy existence check: prefer cache, fallback to DB
Manager.Exists = async (UUID: string) => {
  // Check in memory first
  const CachedClient = ClientIndex.get(UUID);
  if (CachedClient) return true;
  // If not found in memory, check in database
  const [Err, Client] = await ClientsRepo.GetByUUID(UUID);
  if (Err) return false;
  if (!Client) return false;
  return true;
};

// Fetch a Client object (cached or hydrated); callers should not mutate DB-only fields directly
Manager.Get = async (UUID: string) => {
  // No Init() warm-up here on purpose: unlike GetAll (which must return the
  // whole list), a single Get is fully served by the cache-then-DB path below,
  // and Init() rebuilds ClientList from DB rows — which would discard any live
  // cached instance (and its runtime-only online/vitals state) mid-session.
  // Check in memory first
  const CachedClient = ClientIndex.get(UUID);
  if (CachedClient) {
    return Ok(CachedClient);
  }
  // If not found in memory, hydrate from the database and adopt the instance
  // into the cache so callers mutate the resident copy, not a detached orphan.
  const [Err, Row] = await ClientsRepo.GetByUUID(UUID);
  if (Err) return Fail('Failed to fetch client');
  if (!Row) return Fail('Client Not Found');
  const { client } = adoptIntoCache(applyCriticalState(new Client(Row)));
  return Ok(client);
};

Manager.Initialized = false;
// Warm the cache from DB so early UI renders have data
Manager.Init = async () => {
  await CriticalUSB.load();
  await CriticalUSBNames.load();
  await CriticalApplications.load();
  await CriticalDisplays.load();
  const [Err, Clients] = await ClientsRepo.GetAll();
  if (Err || !Clients) {
    Manager.Initialized = true;
    ClientList = [];
    rebuildClientIndex();
    return;
  }
  ClientList = Clients.map((row) => applyCriticalState(new Client(row))); // Update in-memory list
  rebuildClientIndex();
  BroadcastManager.emit('ClientListChanged');
  Manager.Initialized = true;
  return;
};

// Snapshot the current list; ensures cache is initialized first.
// Return a shallow copy so callers can sort/splice/filter the result without
// corrupting the internal ClientList array (the elements are still the live
// resident client instances, which is intentional).
Manager.GetAll = async () => {
  if (!Manager.Initialized) await Manager.Init();
  return Ok([...ClientList]);
};

Manager.GetClientsInGroup = async (GroupID: unknown) => {
  return ClientList.filter((c) => c.GroupID === GroupID);
};

// Move all clients from a specific group into the default no-group bucket (null).
Manager.MoveGroupToNoGroup = async (GroupID: unknown) => {
  if (!Manager.Initialized) await Manager.Init();
  const TargetGroupID = Number(GroupID);
  if (!Number.isFinite(TargetGroupID)) return Fail('Invalid GroupID');

  const [Err] = await ClientsRepo.MoveGroupToNoGroup(TargetGroupID);
  if (Err) return Fail('Failed to move clients to no group');

  let Changed = 0;
  for (const Client of ClientList) {
    if (Client.GroupID == null) continue;
    if (Number(Client.GroupID) !== TargetGroupID) continue;
    Client.GroupID = null;
    Changed += 1;
  }

  if (Changed > 0) BroadcastManager.emit('ClientListChanged');
  return Ok(Changed);
};

// Ensure all clients reference an existing group; unknown groups are reassigned to null.
Manager.ReconcileOrphanedGroups = async (ValidGroupIDs: unknown) => {
  if (!Manager.Initialized) await Manager.Init();
  const Valid = new Set(
    (Array.isArray(ValidGroupIDs) ? ValidGroupIDs : [])
      .map((ID: unknown) => Number(ID))
      .filter((ID: number) => Number.isFinite(ID))
  );

  let Changed = 0;
  for (const Client of ClientList) {
    if (Client.GroupID == null) continue;
    const ClientGroupID = Number(Client.GroupID);
    if (Valid.has(ClientGroupID)) continue;
    await Client.SetGroupID(null);
    Changed += 1;
  }

  return Ok(Changed);
};

// Persist a specific order of clients in a group and optionally move clients into that group
// orderedUUIDs: string[] in the desired order. Any client not in orderedUUIDs will retain existing weight.
Manager.SetGroupOrder = async (GroupID: unknown, orderedUUIDs: unknown) => {
  if (!Array.isArray(orderedUUIDs)) return Fail('Invalid orderedUUIDs');
  // normalize GroupID null
  const TargetGroupID = (GroupID === undefined ? null : GroupID) as number | string | null;
  let weight = 10;
  for (const uuid of orderedUUIDs) {
    const [err, client] = await Manager.Get(uuid);
    if (err) continue;
    if (!client) continue;
    // move to target group if needed
    if (client.GroupID !== TargetGroupID) {
      await client.SetGroupID(TargetGroupID);
    }
    await client.SetWeight(weight);
    weight += 10;
  }
  // Emit a single list changed after batch
  BroadcastManager.emit('ClientListChanged');
  return Ok(true);
};

// Like SetGroupOrder but accepts an explicit weight per UUID. Used when ordering
// is shared across multiple entity types (e.g. clients + monitoring targets).
Manager.SetGroupOrderWithWeights = async (
  GroupID: unknown,
  orderedUUIDs: unknown,
  weights: unknown
) => {
  if (!Array.isArray(orderedUUIDs) || !Array.isArray(weights)) return Fail('Invalid input');
  if (orderedUUIDs.length !== weights.length) return Fail('Length mismatch');
  const TargetGroupID = (GroupID === undefined ? null : GroupID) as number | string | null;
  for (let i = 0; i < orderedUUIDs.length; i++) {
    const uuid = orderedUUIDs[i];
    const w = Number(weights[i]) || 0;
    const [err, client] = await Manager.Get(uuid);
    if (err || !client) continue;
    if (client.GroupID !== TargetGroupID) await client.SetGroupID(TargetGroupID);
    await client.SetWeight(w);
  }
  BroadcastManager.emit('ClientListChanged');
  return Ok(true);
};

Manager.ClearCache = async () => {
  ClientList = [];
  rebuildClientIndex();
  CriticalUSB.clear();
  CriticalUSBNames.clear();
  CriticalApplications.clear();
  CriticalDisplays.clear();
  Manager.Initialized = false;
  return;
};

export { Manager };
