// ClientManager
// - Tracks connected clients in memory for fast updates
// - Persists durable fields to the database (nickname, group, IP, etc.)
// - Emits events on changes so UI and other modules remain reactive
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateClientsRepository } from '../DB/repositories/clients';
import { CreateCriticalEntitiesRepository } from '../DB/repositories/critical-entities';
import { Manager as BroadcastManager } from '../Broadcast';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import { Client } from './client';
import { NormalizeIntegratedActions } from './integrated-actions';
import { makeCriticalIndex } from './critical-index';
import type {
  CriticalUSBDeviceRow,
  CriticalApplicationRow,
  CriticalDisplayRow,
} from '../DB/rows';
import type { HeartbeatPayload, USBDevice } from '@showtrak/protocol';
import type {
  CriticalUSBDevicePayloadResult,
  CriticalApplicationPayloadResult,
  CriticalDisplayPayloadResult,
} from '../IPCValidation';

// Narrow an unknown value to a plain-object view for defensive field reads.
// Non-objects (including null) collapse to `{}`, mirroring the historical
// `Value && Value.Field` guards.
type UnknownRecord = Record<string, unknown>;
function AsRecord(Value: unknown): UnknownRecord {
  return typeof Value === 'object' && Value !== null ? (Value as UnknownRecord) : {};
}

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

function addClientToCache(TargetClient: Client) {
  if (!TargetClient || !TargetClient.UUID) return false;
  if (ClientIndex.has(TargetClient.UUID)) return false;
  ClientList.push(TargetClient);
  ClientIndex.set(TargetClient.UUID, TargetClient);
  return true;
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

function normalizeSerialNumber(SerialNumber: unknown): string | null {
  if (typeof SerialNumber !== 'string') return null;
  const Value = SerialNumber.trim();
  if (!Value) return null;
  return Value.toUpperCase();
}

function normalizeDisplayID(DisplayID: unknown): string | null {
  if (DisplayID === null || DisplayID === undefined) return null;
  const Value = String(DisplayID).trim();
  if (!Value) return null;
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
      return ['Failed to fetch client', null];
    }
    if (!FetchedClient) {
      return ['Client Not Valid', null];
    } else {
      CachedClient = new Client(FetchedClient);
      CriticalUSB.applyState(CachedClient);
      CriticalApplications.applyState(CachedClient);
      CriticalDisplays.applyState(CachedClient);
      if (addClientToCache(CachedClient)) {
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

  return [null, 'Heartbeat processed successfully'];
};

Manager.SetUSBDeviceList = async (UUID: string, DeviceList: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.SetUSBDeviceList(DeviceList);
  return [null, 'USB Device List updated successfully'];
};

// Register/replace the integrated action (event) catalog declared by an
// integrated client over Socket.IO. The payload is normalized/sanitized before
// being stored on the cached Client instance.
Manager.SetIntegratedActions = async (UUID: string, Actions: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  const Normalized = NormalizeIntegratedActions(Actions);
  Target.SetIntegratedActions(Normalized);
  return [null, Normalized];
};

// Apply a manual health state (ONLINE / DEGRADED) reported by an integrated
// client over the SDK. OFFLINE is rejected (driven by the connection only).
Manager.SetIntegratedState = async (UUID: string, State: unknown, Message: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  const Applied = Target.SetIntegratedState(State, Message);
  if (!Applied) return ['Invalid integrated state', null];
  return [null, true];
};

// Toggle identify mode on a client. Ensures the client is cached so the
// runtime flag survives until the next heartbeat re-render.
Manager.SetIdentifying = async (UUID: string, Identifying: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.SetIdentifying(Identifying);
  return [null, true];
};

Manager.SetNetworkInterfaces = async (UUID: string, Interfaces: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.SetNetworkInterfaces(Interfaces);
  return [null, 'Network Interfaces updated successfully'];
};

Manager.SetRunningApplications = async (UUID: string, Snapshot: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.SetRunningApplications(Snapshot || {});
  return [null, 'Running applications updated successfully'];
};

Manager.MarkApplicationCritical = async (
  UUID: string,
  Application: CriticalApplicationPayloadResult
) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const ApplicationName =
    typeof Application?.Name === 'string' && Application.Name.trim().length > 0
      ? Application.Name.trim()
      : null;
  if (!ApplicationName) return ['Application name is required', null];

  const ApplicationKey = ApplicationName.toLowerCase();
  const Timestamp = Date.now();
  const [WriteErr] = await CriticalRepo.MarkApplication(
    UUID,
    ApplicationKey,
    ApplicationName,
    Timestamp
  );
  if (WriteErr) return Fail('Failed to save critical application');

  const PerClient = CriticalApplications.getForClient(UUID, true);
  PerClient.set(ApplicationKey, {
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
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const NormalizedName =
    typeof ApplicationName === 'string' && ApplicationName.trim().length > 0
      ? ApplicationName.trim()
      : null;
  if (!NormalizedName) return ['Application name is required', null];
  const ApplicationKey = NormalizedName.toLowerCase();

  const [WriteErr] = await CriticalRepo.RemoveApplication(UUID, ApplicationKey);
  if (WriteErr) return Fail('Failed to remove critical application');

  const PerClient = CriticalApplications.getForClient(UUID, false);
  if (PerClient) {
    PerClient.delete(ApplicationKey);
    if (PerClient.size === 0) CriticalApplications.index.delete(String(UUID || ''));
  }

  Target.UnmarkCriticalApplication(NormalizedName);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsApplicationCritical = async (UUID: string, ApplicationName: unknown) => {
  const NormalizedName =
    typeof ApplicationName === 'string' && ApplicationName.trim().length > 0
      ? ApplicationName.trim().toLowerCase()
      : null;
  if (!NormalizedName) return [null, false];

  const Cached = CriticalApplications.getForClient(UUID, false);
  if (Cached) return [null, Cached.has(NormalizedName)];

  const [Err, Row] = await CriticalRepo.IsApplicationCritical(UUID, NormalizedName);
  if (Err) return ['Failed to determine critical application status', null];
  return [null, !!Row];
};

Manager.USBDeviceAdded = async (UUID: string, Device: USBDevice) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.USBDeviceAdded(Device);
  return [null, 'Updated'];
};

Manager.USBDeviceRemoved = async (UUID: string, Device: USBDevice) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  Target.USBDeviceRemoved(Device);
  return [null, 'Updated'];
};

Manager.MarkUSBDeviceCritical = async (UUID: string, Device: CriticalUSBDevicePayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const SerialNumber = normalizeSerialNumber(Device && Device.SerialNumber);
  if (!SerialNumber) return ['Device serial number is required', null];

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

  const PerClient = CriticalUSB.getForClient(UUID, true);
  PerClient.set(SerialNumber, {
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
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const NormalizedSerial = normalizeSerialNumber(SerialNumber);
  if (!NormalizedSerial) return ['Device serial number is required', null];

  const [WriteErr] = await CriticalRepo.RemoveUSB(UUID, NormalizedSerial);
  if (WriteErr) return Fail('Failed to remove critical USB device');

  const PerClient = CriticalUSB.getForClient(UUID, false);
  if (PerClient) {
    PerClient.delete(NormalizedSerial);
    if (PerClient.size === 0) CriticalUSB.index.delete(String(UUID || ''));
  }

  Target.UnmarkCriticalUSBSerial(NormalizedSerial);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsUSBDeviceCritical = async (UUID: string, SerialNumber: unknown) => {
  const Normalized = normalizeSerialNumber(SerialNumber);
  if (!Normalized) return [null, false];

  const Cached = CriticalUSB.getForClient(UUID, false);
  if (Cached) return [null, Cached.has(Normalized)];

  const [Err, Row] = await CriticalRepo.IsUSBCritical(UUID, Normalized);
  if (Err) return ['Failed to determine critical USB status', null];
  return [null, !!Row];
};

Manager.SetDisplayList = async (UUID: string, DisplayList: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.SetDisplayList(DisplayList);
  return [null, 'Display List updated successfully'];
};

Manager.MarkDisplayCritical = async (UUID: string, Display: CriticalDisplayPayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const DisplayID = normalizeDisplayID(Display && Display.DisplayID);
  if (!DisplayID) return ['Display identifier is required', null];

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

  const PerClient = CriticalDisplays.getForClient(UUID, true);
  PerClient.set(DisplayID, {
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
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  const NormalizedID = normalizeDisplayID(DisplayID);
  if (!NormalizedID) return ['Display identifier is required', null];

  const [WriteErr] = await CriticalRepo.RemoveDisplay(UUID, NormalizedID);
  if (WriteErr) return Fail('Failed to remove critical display');

  const PerClient = CriticalDisplays.getForClient(UUID, false);
  if (PerClient) {
    PerClient.delete(NormalizedID);
    if (PerClient.size === 0) CriticalDisplays.index.delete(String(UUID || ''));
  }

  Target.UnmarkCriticalDisplay(NormalizedID);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.IsDisplayCritical = async (UUID: string, DisplayID: unknown) => {
  const Normalized = normalizeDisplayID(DisplayID);
  if (!Normalized) return [null, false];

  const Cached = CriticalDisplays.getForClient(UUID, false);
  if (Cached) return [null, Cached.has(Normalized)];

  const [Err, Row] = await CriticalRepo.IsDisplayCritical(UUID, Normalized);
  if (Err) return ['Failed to determine critical display status', null];
  return [null, !!Row];
};

// One-shot richer payload: hostname + NICs -> derive MAC for the active IP
Manager.SystemInfo = async (UUID: string, Data: SystemInfoData, IP: string) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return [Err, null];
  if (!Target) return ['Client Not Found', null];

  await Target.SetHostname(Data.Hostname || null, { markUnsaved: false });
  await Target.SetOperatingSystem(Data.OperatingSystem || null, { markUnsaved: false });
  const Macs = Object.values(Data.MacAddresses || {}) as SystemInfoMacEntry[];
  for (const Interface of Macs) {
    if (Interface.ipv4 === IP) await Target.SetMacAddress(Interface.mac, { markUnsaved: false });
  }

  return [null, 'Heartbeat processed successfully'];
};

Manager.Update = async (UUID: string, Data: unknown) => {
  const [Err, Client] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Client) return Fail('Client Not Found');
  const Fields = AsRecord(Data);
  if (Object.prototype.hasOwnProperty.call(Fields, 'Nickname')) {
    await Client.SetNickname(Fields.Nickname as string | null);
  }
  if (Object.prototype.hasOwnProperty.call(Fields, 'GroupID')) {
    await Client.SetGroupID(Fields.GroupID as number | string | null);
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
  const Created = new Client({
    UUID: UUID,
    Hostname: null,
    OperatingSystem: null,
    Version: 'X.X.X',
    IP: null,
    Timestamp: Date.now(),
  });
  CriticalUSB.applyState(Created);
  CriticalApplications.applyState(Created);
  CriticalDisplays.applyState(Created);
  if (addClientToCache(Created)) {
    BroadcastManager.emit('ClientListChanged');
  }
  return Ok(true);
};

// Unadopt or purge a client; remove from DB and cache
Manager.Delete = async (UUID: string) => {
  const [criticalErr] = await CriticalRepo.DeleteAllUSBForClient(UUID);
  if (criticalErr) return Fail('Failed to delete critical USB devices for client');
  const [criticalAppErr] = await CriticalRepo.DeleteAllApplicationsForClient(UUID);
  if (criticalAppErr) return Fail('Failed to delete critical applications for client');
  const [criticalDisplayErr] = await CriticalRepo.DeleteAllDisplaysForClient(UUID);
  if (criticalDisplayErr) return Fail('Failed to delete critical displays for client');
  // Remove from database
  const [Err, _Res] = await ClientsRepo.Delete(UUID);
  if (Err) return Fail('Failed to delete client');
  // Remove from in-memory list
  removeClientFromCache(UUID);
  CriticalUSB.index.delete(String(UUID || ''));
  CriticalApplications.index.delete(String(UUID || ''));
  CriticalDisplays.index.delete(String(UUID || ''));
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

  const oldCriticalUSB = CriticalUSB.getForClient(OldUUID, false);
  const oldCriticalApps = CriticalApplications.getForClient(OldUUID, false);
  const oldCriticalDisplays = CriticalDisplays.getForClient(OldUUID, false);
  const oldClientRows = ClientList.slice();

  const [TxErr] = await DB.WithTransaction(async (run) => {
    const [clientUpdateErr] = await run('UPDATE Clients SET UUID = ? WHERE UUID = ?', [
      NewUUID,
      OldUUID,
    ]);
    if (clientUpdateErr) throw clientUpdateErr;

    const [criticalUSBErr] = await run('UPDATE CriticalUSBDevices SET UUID = ? WHERE UUID = ?', [
      NewUUID,
      OldUUID,
    ]);
    if (criticalUSBErr) throw criticalUSBErr;

    const [criticalAppErr] = await run('UPDATE CriticalApplications SET UUID = ? WHERE UUID = ?', [
      NewUUID,
      OldUUID,
    ]);
    if (criticalAppErr) throw criticalAppErr;

    const [criticalDisplayErr] = await run('UPDATE CriticalDisplays SET UUID = ? WHERE UUID = ?', [
      NewUUID,
      OldUUID,
    ]);
    if (criticalDisplayErr) throw criticalDisplayErr;

    const [rulesErr, RuleRows] = await DB.All<{
      RuleID: number;
      Scope: string | null;
      Actions: string | null;
    }>('SELECT RuleID, Scope, Actions FROM AlertRules', []);
    if (rulesErr) throw rulesErr;

    for (const Row of RuleRows || []) {
      const RuleID = Number(Row && Row.RuleID);
      if (!Number.isFinite(RuleID)) continue;

      let ParsedScope: unknown = null;
      let ParsedActions: unknown = null;

      try {
        ParsedScope = JSON.parse(Row && Row.Scope ? Row.Scope : '{}');
      } catch {
        ParsedScope = null;
      }
      try {
        ParsedActions = JSON.parse(Row && Row.Actions ? Row.Actions : '[]');
      } catch {
        ParsedActions = null;
      }

      const NextScope = ParsedScope
        ? replaceUUIDInValue(ParsedScope, OldUUID, NewUUID)
        : ParsedScope;
      const NextActions = ParsedActions
        ? replaceUUIDInValue(ParsedActions, OldUUID, NewUUID)
        : ParsedActions;

      const ScopeChanged =
        ParsedScope != null && JSON.stringify(NextScope) !== JSON.stringify(ParsedScope);
      const ActionsChanged =
        ParsedActions != null && JSON.stringify(NextActions) !== JSON.stringify(ParsedActions);

      if (!ScopeChanged && !ActionsChanged) continue;

      const [ruleUpdateErr] = await run(
        'UPDATE AlertRules SET Scope = ?, Actions = ?, UpdatedAt = ? WHERE RuleID = ?',
        [
          ScopeChanged ? JSON.stringify(NextScope) : Row.Scope,
          ActionsChanged ? JSON.stringify(NextActions) : Row.Actions,
          Date.now(),
          RuleID,
        ]
      );
      if (ruleUpdateErr) throw ruleUpdateErr;
    }
  });

  if (TxErr) {
    Logger.error('Failed to replace client UUID', TxErr);
    return Fail('Failed to replace client');
  }

  ExistingClient.UUID = NewUUID;
  ClientList = oldClientRows.filter(
    (Client) => Client.UUID !== OldUUID && Client.UUID !== NewUUID
  );
  ClientList.push(ExistingClient);
  rebuildClientIndex();

  if (oldCriticalUSB) {
    CriticalUSB.index.set(NewUUID, oldCriticalUSB);
    CriticalUSB.index.delete(OldUUID);
  }
  if (oldCriticalApps) {
    CriticalApplications.index.set(NewUUID, oldCriticalApps);
    CriticalApplications.index.delete(OldUUID);
  }
  if (oldCriticalDisplays) {
    CriticalDisplays.index.set(NewUUID, oldCriticalDisplays);
    CriticalDisplays.index.delete(OldUUID);
  }

  CriticalUSB.applyState(ExistingClient);
  CriticalApplications.applyState(ExistingClient);
  CriticalDisplays.applyState(ExistingClient);

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
  // Check in memory first
  const CachedClient = ClientIndex.get(UUID);
  if (CachedClient) {
    return [null, CachedClient];
  }
  // If not found in memory, check in database
  const [Err, Row] = await ClientsRepo.GetByUUID(UUID);
  if (Err) return ['Failed to fetch client', null];
  if (!Row) return ['Client Not Found', null];
  const ClientRow = new Client(Row);
  CriticalUSB.applyState(ClientRow);
  CriticalApplications.applyState(ClientRow);
  CriticalDisplays.applyState(ClientRow);
  return [null, ClientRow];
};

Manager.Initialized = false;
// Warm the cache from DB so early UI renders have data
Manager.Init = async () => {
  await CriticalUSB.load();
  await CriticalApplications.load();
  await CriticalDisplays.load();
  const [Err, Clients] = await ClientsRepo.GetAll();
  if (Err || !Clients) {
    Manager.Initialized = true;
    ClientList = [];
    rebuildClientIndex();
    return;
  }
  ClientList = Clients.map((row) => {
    const ClientEntity = new Client(row);
    CriticalUSB.applyState(ClientEntity);
    CriticalApplications.applyState(ClientEntity);
    CriticalDisplays.applyState(ClientEntity);
    return ClientEntity;
  }); // Update in-memory list
  rebuildClientIndex();
  BroadcastManager.emit('ClientListChanged');
  Manager.Initialized = true;
  return;
};

// Snapshot the current list; ensures cache is initialized first
Manager.GetAll = async () => {
  if (!Manager.Initialized) await Manager.Init();
  return [null, ClientList];
};

Manager.GetClientsInGroup = async (GroupID: unknown) => {
  return ClientList.filter((c) => c.GroupID === GroupID);
};

// Move all clients from a specific group into the default no-group bucket (null).
Manager.MoveGroupToNoGroup = async (GroupID: unknown) => {
  if (!Manager.Initialized) await Manager.Init();
  const TargetGroupID = Number(GroupID);
  if (!Number.isFinite(TargetGroupID)) return ['Invalid GroupID', null];

  const [Err] = await ClientsRepo.MoveGroupToNoGroup(TargetGroupID);
  if (Err) return ['Failed to move clients to no group', null];

  let Changed = 0;
  for (const Client of ClientList) {
    if (Client.GroupID == null) continue;
    if (Number(Client.GroupID) !== TargetGroupID) continue;
    Client.GroupID = null;
    Changed += 1;
  }

  if (Changed > 0) BroadcastManager.emit('ClientListChanged');
  return [null, Changed];
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

  return [null, Changed];
};

// Persist a specific order of clients in a group and optionally move clients into that group
// orderedUUIDs: string[] in the desired order. Any client not in orderedUUIDs will retain existing weight.
Manager.SetGroupOrder = async (GroupID: unknown, orderedUUIDs: unknown) => {
  if (!Array.isArray(orderedUUIDs)) return ['Invalid orderedUUIDs', null];
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
  return [null, true];
};

// Like SetGroupOrder but accepts an explicit weight per UUID. Used when ordering
// is shared across multiple entity types (e.g. clients + monitoring targets).
Manager.SetGroupOrderWithWeights = async (
  GroupID: unknown,
  orderedUUIDs: unknown,
  weights: unknown
) => {
  if (!Array.isArray(orderedUUIDs) || !Array.isArray(weights)) return ['Invalid input', null];
  if (orderedUUIDs.length !== weights.length) return ['Length mismatch', null];
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
  return [null, true];
};

Manager.ClearCache = async () => {
  ClientList = [];
  rebuildClientIndex();
  CriticalUSB.clear();
  CriticalApplications.clear();
  CriticalDisplays.clear();
  Manager.Initialized = false;
  return;
};

export { Manager };
