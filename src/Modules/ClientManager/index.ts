// ClientManager
// - Tracks connected clients in memory for fast updates
// - Persists durable fields to the database (nickname, group, IP, etc.)
// - Emits events on changes so UI and other modules remain reactive
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateClientsRepository } from '../DB/repositories/clients';
import { CreateCriticalEntitiesRepository } from '../DB/repositories/critical-entities';
import { CreateClientMacAddressesRepository } from '../DB/repositories/client-mac-addresses';
import { NormalizeMacAddress, IsExternalMacAddress } from '../MacAddress';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as UUIDManager } from '../UUID';
// Safe direction: VariableManager depends only on DB/Broadcast/Utils, never on
// ClientManager, so this import cannot close a cycle.
import { Manager as VariableManager } from '../VariableManager';
import * as SlugService from '../Slug';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import { Client } from './client';
import type { ClientMacAddress } from './client';
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
import {
  normalizeCriticalAudioEntry,
  normalizeEndpointID,
  resolveCriticalAudioEntry,
} from './audio';
import {
  normalizeCriticalUSBEntry,
  normalizeCriticalUSBNameEntry,
  resolveUSBConditions,
} from './usb';
import {
  IsWeakDisplayID,
  normalizeCriticalDisplayEntry,
  resolveCriticalDisplayEntry,
} from './display';
import {
  normalizeCriticalNetworkEntry,
  normalizeInterfaceName,
  resolveCriticalNetworkEntry,
} from './network';
import type {
  CriticalUSBDeviceRow,
  CriticalUSBDeviceNameRow,
  CriticalApplicationRow,
  CriticalDisplayRow,
  CriticalAudioDeviceRow,
  CriticalNetworkInterfaceRow,
  ClientMacAddressRow,
} from '../DB/rows';
import type {
  CriticalAudioDevice,
  CriticalDisplay,
  CriticalNetworkInterface,
  CriticalUSBConditions,
  CriticalUSBDevice,
  CriticalUSBName,
  HeartbeatPayload,
  USBDevice,
} from '@showtrak/protocol';
import type {
  CriticalUSBDevicePayloadResult,
  CriticalUSBNamePayloadResult,
  CriticalApplicationPayloadResult,
  CriticalDisplayPayloadResult,
  CriticalAudioDevicePayloadResult,
  CriticalNetworkInterfacePayloadResult,
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
const MacAddressesRepo = CreateClientMacAddressesRepository(DB);

// How stale a MAC's LastSeen must be before a client re-reporting it is worth a
// DB write. SystemInfo arrives every 20s per client; LastSeen is only ever read
// at minute granularity, so refreshing it on every report would be write
// amplification for no observable gain.
const MAC_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

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
  ApplyNetworkInterfaceDelta(UUID: string, Delta: unknown): Promise<Result<string>>;
  ApplyDisplayDelta(UUID: string, Delta: unknown): Promise<Result<string>>;
  ApplyApplicationDelta(UUID: string, Delta: unknown): Promise<Result<string>>;
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
  MarkUSBNameCritical(UUID: string, Device: CriticalUSBNamePayloadResult): Promise<Result<boolean>>;
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
  SetAudioDevices(UUID: string, Snapshot: unknown): Promise<Result<string>>;
  // Mark an endpoint critical or update its conditions; Ok(true) when newly marked.
  MarkAudioDeviceCritical(
    UUID: string,
    Device: CriticalAudioDevicePayloadResult
  ): Promise<Result<boolean>>;
  RemoveAudioDeviceCritical(UUID: string, EndpointID: unknown): Promise<Result<boolean>>;
  // Mark a network interface critical or update its conditions; Ok(true) when newly marked.
  MarkNetworkInterfaceCritical(
    UUID: string,
    Interface: CriticalNetworkInterfacePayloadResult
  ): Promise<Result<boolean>>;
  RemoveNetworkInterfaceCritical(UUID: string, Name: unknown): Promise<Result<boolean>>;
  // Per-client MAC addresses (the Wake-on-LAN target set). Add resolves to
  // Ok(true) when a new address was stored, Ok(false) when it was already on
  // file or was a reported address filtered out as non-external.
  AddMacAddress(
    UUID: string,
    MacAddress: unknown,
    Options?: {
      Source?: 'Reported' | 'Manual';
      InterfaceName?: string | null;
      markUnsaved?: boolean;
    }
  ): Promise<Result<boolean>>;
  RemoveMacAddress(UUID: string, MacAddress: unknown): Promise<Result<boolean>>;
  USBDeviceAdded(UUID: string, Device: USBDevice): Promise<Result<string>>;
  USBDeviceRemoved(UUID: string, Device: USBDevice): Promise<Result<string>>;
  Update(UUID: string, Data: unknown): Promise<Result<Client>>;
  Create(UUID: string): Promise<Result<boolean>>;
  CreateUnassigned(Name: string, Count: number): Promise<Result<Client[]>>;
  Delete(UUID: string): Promise<Result<boolean>>;
  ReplaceClient(CurrentUUID: unknown, ReplacementUUID: unknown): Promise<Result<Client>>;
  Exists(UUID: string): Promise<boolean>;
  Get(UUID: string): Promise<Result<Client>>;
  // Resolve a real client by its slug (case-insensitive), for OSC/API addressing.
  GetBySlug(Slug: string): Promise<Client | null>;
  GetAll(): Promise<Result<Client[]>>;
  // Assign generated unique slugs to any client row still missing one. Returns
  // how many were back-filled. Idempotent.
  BackfillSlugs(): Promise<number>;
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

// Apply the current per-client side-table state (USB serials, USB names, apps,
// displays, MAC addresses) onto a freshly built Client. Every hydration path
// funnels through here so the applyState calls stay in one place instead of
// being copied at each `new Client(...)` site. Returns the same instance for
// chaining.
function applyCriticalState(Entity: Client): Client {
  CriticalUSB.applyState(Entity);
  CriticalUSBNames.applyState(Entity);
  CriticalApplications.applyState(Entity);
  CriticalDisplays.applyState(Entity);
  CriticalAudio.applyState(Entity);
  CriticalNetwork.applyState(Entity);
  MacAddresses.applyState(Entity);
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
  const Cached = ClientIndex.get(UUID);
  if (!Cached) return false;
  // Stand down the start-up window timer with the client it belongs to, so a
  // deleted client cannot broadcast an update seconds after it stopped existing.
  Cached._clearStartupGraceTimer();
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
// what the matching Client.SetCritical* sink consumes.
interface ApplicationIndexEntry {
  Name: string;
  Key: string;
  Timestamp: number | null;
}
const CriticalUSB = makeCriticalIndex<CriticalUSBDeviceRow, CriticalUSBDevice>({
  loadAll: () => CriticalRepo.LoadAllUSB(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const Entry = normalizeCriticalUSBEntry(Row);
    if (!UUID || !Entry) return null;
    return { UUID, Key: Entry.SerialNumber, Entry };
  },
  apply: (client, entries) => client.SetCriticalUSBDevices(entries),
});

const CriticalUSBNames = makeCriticalIndex<CriticalUSBDeviceNameRow, CriticalUSBName>({
  loadAll: () => CriticalRepo.LoadAllUSBNames(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const Entry = normalizeCriticalUSBNameEntry(Row);
    if (!UUID || !Entry) return null;
    return { UUID, Key: Entry.NameKey, Entry };
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

// Per-client MAC addresses. Structurally identical to the critical-entity
// indexes (per-client keyed rows in a side table, projected onto the Client on
// every hydration), so it reuses the same factory. Keyed by the normalized MAC.
const MacAddresses = makeCriticalIndex<ClientMacAddressRow, ClientMacAddress>({
  loadAll: () => MacAddressesRepo.LoadAll(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const MacAddress = NormalizeMacAddress(Row && Row.MacAddress);
    if (!UUID || !MacAddress) return null;
    return {
      UUID,
      Key: MacAddress,
      Entry: {
        MacAddress,
        Source: Row.Source === 'Manual' ? 'Manual' : 'Reported',
        InterfaceName: Row.InterfaceName || null,
        FirstSeen: Row.FirstSeen || 0,
        LastSeen: Row.LastSeen || 0,
      },
    };
  },
  apply: (client, entries) => client.SetMacAddresses(entries),
});

const CriticalDisplays = makeCriticalIndex<CriticalDisplayRow, CriticalDisplay>({
  loadAll: () => CriticalRepo.LoadAllDisplays(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const Entry = normalizeCriticalDisplayEntry(Row);
    if (!UUID || !Entry) return null;
    return { UUID, Key: Entry.DisplayID, Entry };
  },
  apply: (client, entries) => client.SetCriticalDisplays(entries),
});

const CriticalAudio = makeCriticalIndex<CriticalAudioDeviceRow, CriticalAudioDevice>({
  loadAll: () => CriticalRepo.LoadAllAudio(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const Entry = normalizeCriticalAudioEntry(Row);
    if (!UUID || !Entry) return null;
    return { UUID, Key: Entry.EndpointID, Entry };
  },
  apply: (client, entries) => client.SetCriticalAudioDevices(entries),
});

const CriticalNetwork = makeCriticalIndex<CriticalNetworkInterfaceRow, CriticalNetworkInterface>({
  loadAll: () => CriticalRepo.LoadAllNetwork(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const Entry = normalizeCriticalNetworkEntry(Row);
    if (!UUID || !Entry) return null;
    return { UUID, Key: Entry.Name, Entry };
  },
  apply: (client, entries) => client.SetCriticalNetworkInterfaces(entries),
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
  // Richer than the SystemInfo MAC map: this payload carries the OS `internal`
  // flag per address, so loopback is excluded on the OS's own say-so rather than
  // inferred. The bit-level filter in AddMacAddress still runs on top, since
  // `internal` does not catch virtual adapters or randomized Wi-Fi addresses.
  await IngestReportedMacAddresses(UUID, CollectReportedMacAddresses(Target.NetworkInterfaces));
  return Ok('Network Interfaces updated successfully');
};

// --- Incremental telemetry -------------------------------------------------
// Each of these merges a client-reported change into the cached client. The
// corresponding Set* method above remains the authority and replaces the state
// outright on connect and on the periodic resync, so a delta that lands against
// a stale baseline self-corrects within one resync interval.

Manager.ApplyNetworkInterfaceDelta = async (UUID: string, Delta: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.ApplyNetworkInterfaceDelta(Delta);
  // Same reason as SetNetworkInterfaces: this payload carries the per-address
  // `internal` flag, and a newly appeared interface may be the only place a
  // usable MAC (a Wi-Fi adapter's, typically) is ever reported.
  await IngestReportedMacAddresses(UUID, CollectReportedMacAddresses(Target.NetworkInterfaces));
  return Ok('Network interface delta applied successfully');
};

Manager.ApplyDisplayDelta = async (UUID: string, Delta: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.ApplyDisplayDelta(Delta);
  return Ok('Display delta applied successfully');
};

Manager.ApplyApplicationDelta = async (UUID: string, Delta: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.ApplyApplicationDelta(Delta);
  return Ok('Application delta applied successfully');
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

// The condition columns both critical USB tables share, as sqlite stores them.
function USBConditionColumns(Entry: CriticalUSBConditions) {
  return {
    RequirePresent: Entry.RequirePresent ? 1 : 0,
    Location: Entry.Location,
    FirmwareVersion: Entry.FirmwareVersion,
    RequireNoError: Entry.RequireNoError ? 1 : 0,
  };
}

Manager.MarkUSBDeviceCritical = async (UUID: string, Device: CriticalUSBDevicePayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const SerialNumber = normalizeSerialNumber(Device && Device.SerialNumber);
  if (!SerialNumber) return Fail('Device serial number is required');

  const KnownDevice = (
    Array.isArray(Target.ConnectedUSBDeviceList) ? Target.ConnectedUSBDeviceList : []
  ).find((Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) === SerialNumber);
  const Existing = CriticalUSB.getForClient(UUID, false)?.get(SerialNumber) || null;
  const [ResolveErr, Conditions] = resolveUSBConditions(
    Device,
    KnownDevice ? [KnownDevice] : [],
    Existing
  );
  if (ResolveErr || !Conditions) return Fail(ResolveErr || 'Failed to resolve critical USB device');

  const Entry: CriticalUSBDevice = {
    SerialNumber,
    ManufacturerName:
      KnownDevice?.ManufacturerName ||
      Device.ManufacturerName ||
      Existing?.ManufacturerName ||
      null,
    ProductName: KnownDevice?.ProductName || Device.ProductName || Existing?.ProductName || null,
    ...Conditions,
    Timestamp: Existing?.Timestamp ?? Date.now(),
  };
  const [WriteErr] = await CriticalRepo.MarkUSB({
    UUID,
    SerialNumber,
    ManufacturerName: Entry.ManufacturerName,
    ProductName: Entry.ProductName,
    ...USBConditionColumns(Entry),
    Timestamp: Entry.Timestamp ?? Date.now(),
  });
  if (WriteErr) return Fail('Failed to save critical USB device');

  CriticalUSB.setForClient(UUID, SerialNumber, Entry);
  Target.MarkCriticalUSBDevice(Entry);
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

  // Name guarding only covers devices without a serial (see buildUSBView).
  const Live = (
    Array.isArray(Target.ConnectedUSBDeviceList) ? Target.ConnectedUSBDeviceList : []
  ).filter(
    (Entry) =>
      !normalizeSerialNumber(Entry && Entry.SerialNumber) &&
      normalizeUSBNameKey(Entry && Entry.ManufacturerName, Entry && Entry.ProductName) === NameKey
  );
  const Existing = CriticalUSBNames.getForClient(UUID, false)?.get(NameKey) || null;
  const [ResolveErr, Conditions] = resolveUSBConditions(Device, Live, Existing);
  if (ResolveErr || !Conditions) return Fail(ResolveErr || 'Failed to resolve critical USB device');

  // The expected quantity is captured from how many are connected when it is
  // first marked (at least one, so the guard means something). Editing its
  // conditions later keeps it: one being unplugged at the time is not a new
  // expectation.
  const Entry: CriticalUSBName = {
    NameKey,
    ManufacturerName: ManufacturerName ?? Existing?.ManufacturerName ?? null,
    ProductName: ProductName ?? Existing?.ProductName ?? null,
    Quantity: Existing?.Quantity ?? Math.max(1, Live.length),
    ...Conditions,
    Timestamp: Existing?.Timestamp ?? Date.now(),
  };
  const [WriteErr] = await CriticalRepo.MarkUSBName({
    UUID,
    NameKey,
    ManufacturerName: Entry.ManufacturerName,
    ProductName: Entry.ProductName,
    Quantity: Entry.Quantity,
    ...USBConditionColumns(Entry),
    Timestamp: Entry.Timestamp ?? Date.now(),
  });
  if (WriteErr) return Fail('Failed to save critical USB device');

  CriticalUSBNames.setForClient(UUID, NameKey, Entry);
  Target.MarkCriticalUSBName(Entry);
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

  // The id may be the critical entry's own or the live display's it matched; a
  // display that is not critical yet is found by its live id.
  const Found = Target.FindCriticalDisplay(DisplayID);
  const Existing = Found.Critical
    ? CriticalDisplays.getForClient(UUID, false)?.get(Found.Critical.DisplayID) || Found.Critical
    : null;
  const Live =
    Found.Live ||
    (Existing
      ? null
      : (Array.isArray(Target.ConnectedDisplayList) ? Target.ConnectedDisplayList : []).find(
          (Entry) => normalizeDisplayID(Entry && Entry.DisplayID) === DisplayID
        ) || null);
  const LiveID = Live ? normalizeDisplayID(Live.DisplayID) : null;

  // An entry recognised by a weak id (the display's mode, or a session handle)
  // takes the durable id its display now reports, so it no longer leans on the
  // weaker matching tiers.
  const StoredID =
    Existing && LiveID && LiveID !== Existing.DisplayID
      ? IsWeakDisplayID(Existing.DisplayID) && !IsWeakDisplayID(LiveID)
        ? LiveID
        : Existing.DisplayID
      : (Existing?.DisplayID ?? DisplayID);

  const [ResolveErr, Entry] = resolveCriticalDisplayEntry(
    StoredID,
    Display,
    Live,
    Existing,
    Date.now()
  );
  if (ResolveErr || !Entry) return Fail(ResolveErr || 'Failed to resolve critical display');

  const Rekeyed = !!Existing && Existing.DisplayID !== Entry.DisplayID;
  const [WriteErr] = await CriticalRepo.MarkDisplay({
    UUID,
    DisplayID: Entry.DisplayID,
    Label: Entry.Label,
    RequirePresent: Entry.RequirePresent ? 1 : 0,
    Width: Entry.Width,
    Height: Entry.Height,
    RefreshRate: Entry.RefreshRate,
    ScaleFactor: Entry.ScaleFactor,
    Rotation: Entry.Rotation,
    RequirePrimary: Entry.RequirePrimary ? 1 : 0,
    PositionX: Entry.PositionX,
    PositionY: Entry.PositionY,
    Timestamp: Entry.Timestamp ?? Date.now(),
  });
  if (WriteErr) return Fail('Failed to save critical display');
  if (Rekeyed) {
    const [RemoveErr] = await CriticalRepo.RemoveDisplay(UUID, Existing.DisplayID);
    if (RemoveErr) Logger.error('Failed to retire a re-keyed critical display', RemoveErr);
    CriticalDisplays.removeForClient(UUID, Existing.DisplayID);
    Target.UnmarkCriticalDisplay(Existing.DisplayID);
  }

  CriticalDisplays.setForClient(UUID, Entry.DisplayID, Entry);
  Target.MarkCriticalDisplay(Entry);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(!Existing);
};

Manager.RemoveDisplayCritical = async (UUID: string, DisplayID: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const RequestedID = normalizeDisplayID(DisplayID);
  if (!RequestedID) return Fail('Display identifier is required');
  // Accept the live id of a display matched to the entry under another id.
  const NormalizedID = Target.FindCriticalDisplay(RequestedID).Critical?.DisplayID ?? RequestedID;

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

Manager.SetAudioDevices = async (UUID: string, Snapshot: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.SetAudioDevices(Snapshot);
  return Ok('Audio devices updated successfully');
};

Manager.MarkAudioDeviceCritical = async (
  UUID: string,
  Device: CriticalAudioDevicePayloadResult
) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const EndpointID = normalizeEndpointID(Device && Device.EndpointID);
  if (!EndpointID) return Fail('Audio device identifier is required');

  const Live = Target.ObservedAudio.Endpoints.find((Entry) => Entry.EndpointID === EndpointID);
  const Existing = CriticalAudio.getForClient(UUID, false)?.get(EndpointID) || null;
  const [ResolveErr, Entry] = resolveCriticalAudioEntry(
    EndpointID,
    Device,
    Live || null,
    Existing,
    Target.ObservedAudio.Capabilities,
    Date.now()
  );
  if (ResolveErr || !Entry) return Fail(ResolveErr || 'Failed to resolve critical audio device');

  const [WriteErr] = await CriticalRepo.MarkAudio({
    UUID,
    EndpointID: Entry.EndpointID,
    Direction: Entry.Direction,
    Name: Entry.Name,
    Channels: Entry.Channels,
    SampleRate: Entry.SampleRate,
    RequireDefault: Entry.RequireDefault ? 1 : 0,
    RequireUnmuted: Entry.RequireUnmuted ? 1 : 0,
    MinVolume: Entry.MinVolume,
    MaxVolume: Entry.MaxVolume,
    Timestamp: Entry.Timestamp ?? Date.now(),
  });
  if (WriteErr) return Fail('Failed to save critical audio device');

  CriticalAudio.setForClient(UUID, EndpointID, Entry);
  Target.MarkCriticalAudioDevice(Entry);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(!Existing);
};

Manager.RemoveAudioDeviceCritical = async (UUID: string, EndpointID: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Normalized = normalizeEndpointID(EndpointID);
  if (!Normalized) return Fail('Audio device identifier is required');

  const [WriteErr] = await CriticalRepo.RemoveAudio(UUID, Normalized);
  if (WriteErr) return Fail('Failed to remove critical audio device');

  CriticalAudio.removeForClient(UUID, Normalized);
  Target.UnmarkCriticalAudioDevice(Normalized);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

Manager.MarkNetworkInterfaceCritical = async (
  UUID: string,
  Interface: CriticalNetworkInterfacePayloadResult
) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Name = normalizeInterfaceName(Interface && Interface.Name);
  if (!Name) return Fail('Network interface name is required');

  const Live = Target.NetworkInterfaces.find((Entry) => Entry.name === Name) || null;
  const Existing = CriticalNetwork.getForClient(UUID, false)?.get(Name) || null;
  const [ResolveErr, Entry] = resolveCriticalNetworkEntry(
    Name,
    Interface,
    Live,
    Existing,
    Target.NetworkStatus.Capabilities,
    Date.now()
  );
  if (ResolveErr || !Entry) {
    return Fail(ResolveErr || 'Failed to resolve critical network interface');
  }

  const [WriteErr] = await CriticalRepo.MarkNetwork({
    UUID,
    Name: Entry.Name,
    MAC: Entry.MAC,
    Family: Entry.Family,
    RequirePresent: Entry.RequirePresent ? 1 : 0,
    Address: Entry.Address,
    RangeStart: Entry.RangeStart,
    RangeEnd: Entry.RangeEnd,
    Netmask: Entry.Netmask,
    Gateway: Entry.Gateway,
    Timestamp: Entry.Timestamp ?? Date.now(),
  });
  if (WriteErr) return Fail('Failed to save critical network interface');

  CriticalNetwork.setForClient(UUID, Name, Entry);
  Target.MarkCriticalNetworkInterface(Entry);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(!Existing);
};

Manager.RemoveNetworkInterfaceCritical = async (UUID: string, Name: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Normalized = normalizeInterfaceName(Name);
  if (!Normalized) return Fail('Network interface name is required');

  const [WriteErr] = await CriticalRepo.RemoveNetwork(UUID, Normalized);
  if (WriteErr) return Fail('Failed to remove critical network interface');

  CriticalNetwork.removeForClient(UUID, Normalized);
  Target.UnmarkCriticalNetworkInterface(Normalized);
  BroadcastManager.emit('ClientUpdated', Target);
  return Ok(true);
};

// Record one MAC against a client, or refresh it if already on file.
//
// 'Reported' addresses come from the client's own NIC enumeration and are
// filtered to physical, externally-reachable interfaces — loopback, virtual
// adapters and randomized Wi-Fi addresses cannot wake a machine and would only
// bloat the table. 'Manual' addresses skip that filter: an operator typing an
// address has context we don't (a NIC we have never seen, an unusual adapter),
// so only syntactic validity is enforced.
//
// Returns Ok(false) when a reported address was legitimately filtered out, so
// ingest can tell "rejected" from "stored" without treating it as an error.
Manager.AddMacAddress = async (
  UUID: string,
  MacAddress: unknown,
  {
    Source = 'Manual',
    InterfaceName = null,
    markUnsaved = Source === 'Manual',
  }: {
    Source?: 'Reported' | 'Manual';
    InterfaceName?: string | null;
    markUnsaved?: boolean;
  } = {}
) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const Normalized = NormalizeMacAddress(MacAddress);
  if (!Normalized) return Fail('Invalid MAC address');
  if (Source === 'Reported' && !IsExternalMacAddress(Normalized)) return Ok(false);

  const Now = Date.now();
  const Existing = MacAddresses.getForClient(UUID, false)?.get(Normalized) || null;
  if (Existing) {
    // Already on file — refresh liveness only. Notably this does NOT relabel a
    // manual entry as 'Reported' once the client reports it, so the editor keeps
    // showing how the address got there.
    //
    // Throttled: SystemInfo arrives every 20s per client, and LastSeen is only
    // ever read at minute granularity, so writing on every report would be pure
    // write amplification (one UPDATE per MAC per client per 20s) for no gain.
    // The interface-name check is the exception: if the address has moved to a
    // different adapter that IS worth recording immediately.
    const InterfaceUnchanged = !InterfaceName || InterfaceName === Existing.InterfaceName;
    if (Now - (Existing.LastSeen || 0) < MAC_TOUCH_INTERVAL_MS && InterfaceUnchanged) {
      return Ok(false);
    }
    const [TouchErr] = await MacAddressesRepo.Touch(UUID, Normalized, InterfaceName, Now, {
      markUnsaved,
    });
    if (TouchErr) return Fail('Failed to update MAC address');
    MacAddresses.setForClient(UUID, Normalized, {
      ...Existing,
      InterfaceName: InterfaceName || Existing.InterfaceName,
      LastSeen: Now,
    });
    MacAddresses.applyState(Target);
    return Ok(false);
  }

  const [WriteErr] = await MacAddressesRepo.Add(
    UUID,
    Normalized,
    Source,
    InterfaceName || null,
    Now,
    { markUnsaved }
  );
  if (WriteErr) return Fail('Failed to save MAC address');

  MacAddresses.setForClient(UUID, Normalized, {
    MacAddress: Normalized,
    Source,
    InterfaceName: InterfaceName || null,
    FirstSeen: Now,
    LastSeen: Now,
  });
  MacAddresses.applyState(Target);
  BroadcastManager.emit('ClientUpdated', Target);
  Logger.log(`Client ${UUID} gained ${Source.toLowerCase()} MAC address ${Normalized}`);
  return Ok(true);
};

// Forget a MAC. A 'Reported' address the client still has comes back on its next
// NIC report — removal is for retiring addresses the machine no longer carries,
// not for permanently suppressing a live one.
Manager.RemoveMacAddress = async (UUID: string, MacAddress: unknown) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const Normalized = NormalizeMacAddress(MacAddress);
  if (!Normalized) return Fail('Invalid MAC address');

  const [WriteErr] = await MacAddressesRepo.Remove(UUID, Normalized);
  if (WriteErr) return Fail('Failed to remove MAC address');

  MacAddresses.removeForClient(UUID, Normalized);
  MacAddresses.applyState(Target);
  // Clients.MacAddress is a denormalized copy of one of these rows, so clear it
  // when it is the one that just went — otherwise the editor's summary field
  // outlives the entry it mirrors. The next report repopulates it if live.
  if (NormalizeMacAddress(Target.MacAddress) === Normalized) {
    await Target.SetMacAddress(null, { markUnsaved: false });
  }
  BroadcastManager.emit('ClientUpdated', Target);
  Logger.log(`Client ${UUID} lost MAC address ${Normalized}`);
  return Ok(true);
};

// Flatten a normalized NetworkInterfaces snapshot into (MAC, interface name)
// pairs worth storing. Addresses the OS marks `internal` — loopback, and on some
// platforms tunnel endpoints — are dropped here: they belong to no physical NIC
// and no magic packet sent to them could ever reach a sleeping machine.
function CollectReportedMacAddresses(
  Interfaces: Array<{ name?: string; addresses?: Array<{ mac?: unknown; internal?: boolean }> }>
): Array<{ MacAddress: unknown; InterfaceName: string | null }> {
  const Collected: Array<{ MacAddress: unknown; InterfaceName: string | null }> = [];
  for (const Interface of Array.isArray(Interfaces) ? Interfaces : []) {
    const Name = Interface && Interface.name ? String(Interface.name) : null;
    const Addresses = Interface && Array.isArray(Interface.addresses) ? Interface.addresses : [];
    for (const Address of Addresses) {
      if (!Address || Address.internal) continue;
      if (!Address.mac) continue;
      Collected.push({ MacAddress: Address.mac, InterfaceName: Name });
    }
  }
  return Collected;
}

// Merge a batch of client-reported addresses. Additive by design: addresses
// absent from this report are left alone rather than pruned, because a NIC that
// is merely down (undocked laptop, disabled Wi-Fi) still wakes the machine and
// its address is worth keeping. Pruning stale entries is the operator's call.
async function IngestReportedMacAddresses(
  UUID: string,
  Entries: Array<{ MacAddress: unknown; InterfaceName?: string | null }>
): Promise<void> {
  const Seen = new Set<string>();
  for (const Entry of Entries) {
    const Normalized = NormalizeMacAddress(Entry && Entry.MacAddress);
    if (!Normalized || Seen.has(Normalized)) continue;
    Seen.add(Normalized);
    // markUnsaved stays false: a client re-reporting the NICs it has always had
    // must not dirty the workspace, or every heartbeat would prompt a save.
    const [Err] = await Manager.AddMacAddress(UUID, Normalized, {
      Source: 'Reported',
      InterfaceName: (Entry && Entry.InterfaceName) || null,
      markUnsaved: false,
    });
    if (Err) Logger.error(`Failed to ingest MAC address ${Normalized} for ${UUID}`);
  }
}

// One-shot richer payload: hostname + NICs. Every reported interface is stored
// (Wake-on-LAN fans out across all of them); the interface serving the active
// socket IP additionally becomes the client's primary MacAddress, which is what
// the editor shows as the current address.
Manager.SystemInfo = async (UUID: string, Data: SystemInfoData, IP: string) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  await Target.SetHostname(Data.Hostname || null, { markUnsaved: false });
  await Target.SetOperatingSystem(Data.OperatingSystem || null, { markUnsaved: false });

  const Interfaces = Object.entries(Data.MacAddresses || {}) as Array<[string, SystemInfoMacEntry]>;
  await IngestReportedMacAddresses(
    UUID,
    Interfaces.map(([Name, Interface]) => ({
      MacAddress: Interface && Interface.mac,
      InterfaceName: Name,
    }))
  );
  for (const [, Interface] of Interfaces) {
    if (Interface && Interface.ipv4 === IP) {
      // Normalized so it compares equal to the matching ClientMacAddresses row
      // without every reader having to re-massage the format.
      await Target.SetMacAddress(NormalizeMacAddress(Interface.mac) || Interface.mac, {
        markUnsaved: false,
      });
    }
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
  // Same reasoning as launch actions: an integrated client runs no local agent
  // and executes no scripts, so it has nothing to inject variables into.
  if (Object.prototype.hasOwnProperty.call(Fields, 'Variables') && Client.Integrated === true) {
    return Fail('Variables are not supported for integrated clients');
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
  if (Object.prototype.hasOwnProperty.call(Fields, 'Slug')) {
    const [SlugErr, Slug] = await SlugService.ResolveClientSlugEdit(
      Fields.Slug,
      SlugService.ClientOwner(UUID)
    );
    if (SlugErr) return Fail(SlugErr);
    // SlugErr falsy => Slug is the resolved string (tuple union isn't narrowed).
    const [SetErr] = await Client.SetSlug(Slug as string);
    if (SetErr) return Fail(SetErr);
  }
  if (Object.prototype.hasOwnProperty.call(Fields, 'RunOnLaunchScriptID')) {
    const [SetErr] = await Client.SetRunOnLaunchScriptID(
      Fields.RunOnLaunchScriptID as string | null
    );
    if (SetErr) return Fail(SetErr);
  }
  if (Object.prototype.hasOwnProperty.call(Fields, 'RunOnLaunchDelaySeconds')) {
    const [SetErr] = await Client.SetRunOnLaunchDelaySeconds(
      Fields.RunOnLaunchDelaySeconds as number | null
    );
    if (SetErr) return Fail(SetErr);
  }
  // Variable overrides live in their own table rather than on the client row, so
  // they are delegated instead of set through a Client setter — the Client entity
  // stays plain data describing the machine, not a carrier for show config.
  if (Object.prototype.hasOwnProperty.call(Fields, 'Variables')) {
    const [SetErr] = await VariableManager.SetClientValues(
      UUID,
      Fields.Variables as Record<string, unknown> | null
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
  // Every client must have a non-null slug. A freshly adopted client has no
  // hostname/nickname yet, so seed from a generic base; the operator can rename
  // the slug later and it will never auto-change on its own.
  const NewSlug = await SlugService.GenerateUniqueClientSlug(
    Created.Hostname || Created.Nickname || 'client',
    SlugService.ClientOwner(UUID)
  );
  await Created.SetSlug(NewSlug);
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
    const SlotSlug = await SlugService.GenerateUniqueClientSlug(
      Nickname,
      SlugService.ClientOwner(UUID)
    );
    await Slot.SetSlug(SlotSlug);
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
  CriticalAudio.clearForClient(UUID);
  CriticalNetwork.clearForClient(UUID);
  MacAddresses.clearForClient(UUID);
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
  ClientList = oldClientRows.filter((Client) => Client.UUID !== OldUUID && Client.UUID !== NewUUID);
  ClientList.push(ExistingClient);
  rebuildClientIndex();

  CriticalUSB.rekeyClient(OldUUID, NewUUID);
  CriticalUSBNames.rekeyClient(OldUUID, NewUUID);
  CriticalApplications.rekeyClient(OldUUID, NewUUID);
  CriticalDisplays.rekeyClient(OldUUID, NewUUID);
  CriticalAudio.rekeyClient(OldUUID, NewUUID);
  CriticalNetwork.rekeyClient(OldUUID, NewUUID);
  // MAC addresses cannot be re-keyed in memory the way the critical indexes are:
  // ReplaceClientUUID drops the old slot's *reported* addresses (they describe
  // the machine being replaced) while carrying its manual ones across, so the
  // in-RAM set no longer mirrors a straight move. Reload it from the rows the
  // transaction actually left behind.
  await MacAddresses.load();

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

// Resolve a real client by slug (case-insensitive). Ensures the cache is warm so
// OSC lookups made before any UI has rendered still resolve.
Manager.GetBySlug = async (Slug: string): Promise<Client | null> => {
  if (!Slug) return null;
  if (!Manager.Initialized) await Manager.Init();
  const Lower = String(Slug).toLowerCase();
  return ClientList.find((C) => (C.Slug || '').toLowerCase() === Lower) || null;
};

// Assign generated unique slugs to any client row still lacking one (e.g. rows
// created before slugs existed). Idempotent; run once on boot.
Manager.BackfillSlugs = async (): Promise<number> => {
  if (!Manager.Initialized) await Manager.Init();
  let Count = 0;
  for (const Client of ClientList) {
    if (Client.Slug) continue;
    const Slug = await SlugService.GenerateUniqueClientSlug(
      Client.Hostname || Client.Nickname || 'client',
      SlugService.ClientOwner(Client.UUID)
    );
    const [Err] = await Client.SetSlug(Slug);
    if (!Err) Count++;
  }
  if (Count) Logger.log(`Back-filled slugs for ${Count} client(s)`);
  return Count;
};

Manager.Initialized = false;
// Warm the cache from DB so early UI renders have data
Manager.Init = async () => {
  await CriticalUSB.load();
  await CriticalUSBNames.load();
  await CriticalApplications.load();
  await CriticalDisplays.load();
  await CriticalAudio.load();
  await CriticalNetwork.load();
  await MacAddresses.load();
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
  for (const Cached of ClientList) Cached._clearStartupGraceTimer();
  ClientList = [];
  rebuildClientIndex();
  CriticalUSB.clear();
  CriticalUSBNames.clear();
  CriticalApplications.clear();
  CriticalDisplays.clear();
  CriticalAudio.clear();
  CriticalNetwork.clear();
  MacAddresses.clear();
  Manager.Initialized = false;
  return;
};

export { Manager };
