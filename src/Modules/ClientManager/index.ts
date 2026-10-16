// ClientManager
// - Tracks connected clients in memory for fast updates
// - Persists durable fields to the database (nickname, group, IP, etc.)
// - Emits events on changes so UI and other modules remain reactive
import type {
  ValidatedApplicationDelta,
  ValidatedHeartbeat,
  ValidatedSystemInfo,
  ValidatedAudioDevices,
  ValidatedDisplay,
  ValidatedDisplayDelta,
  ValidatedNetworkInterface,
  ValidatedNetworkInterfaceDelta,
  ValidatedPowerStatus,
  ValidatedRunningApplications,
  ValidatedTemperatures,
  ValidatedUSBDevice,
} from '../SocketValidation';
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateClientsRepository } from '../DB/repositories/clients';
import {
  CreateCriticalEntitiesRepository,
  type CriticalTable,
} from '../DB/repositories/critical-entities';
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
  normalizeDisplayID,
} from './normalizers';
import { NormalizeIntegratedActions } from './integrated-actions';
import { makeCriticalIndex, type CriticalIndex } from './critical-index';
import { ProjectCriticalRow, type CriticalKind } from './critical-kind';
import { APPLICATION_KIND, type CriticalApplicationEntry } from './applications';
import {
  normalizeSystemCheckRow,
  resolveSystemCheck,
  SystemCheckToRow,
  type SystemCheck,
} from './system-checks';
import {
  ResolveOfflineGraceSeconds,
  SchedulePendingTimeout,
  CancelPendingTimeout,
} from './offline-grace';
import { AUDIO_KIND, normalizeEndpointID, resolveCriticalAudioEntry } from './audio';
import { DescribeUSBLocation, USB_NAME_KIND, USB_SERIAL_KIND, resolveUSBConditions } from './usb';
import { DISPLAY_KIND, IsWeakDisplayID, resolveCriticalDisplayEntry } from './display';
import { NETWORK_KIND, normalizeInterfaceName, resolveCriticalNetworkEntry } from './network';
import type { ClientMacAddressRow, SystemCheckRow } from '../DB/rows';
import { RecordEdit, RecordUpdate } from '../AuditLog/edits';
import { Device, Entity, Line, Value } from '../AuditLog/message';
import { DiffFields, type FieldSpec } from '../AuditLog/diff';
import { ClientDisplayName } from '../AuditLog/status';
import { AuditBefore, AuditStep, GroupTitle, ScriptName, Seconds } from '../Shared/audit-names';
import type {
  ClientPowerCheck,
  ClientSystemCheckKey,
  ClientThermalCheck,
  ClientUptimeCheck,
  ClientUsageCheck,
  CriticalAudioDevice,
  CriticalDisplay,
  CriticalNetworkInterface,
  CriticalUSBConditions,
  CriticalUSBDevice,
  CriticalUSBName,
  USBDevice,
} from '@showtrak/protocol';
import type {
  CriticalUSBDevicePayloadResult,
  CriticalUSBNamePayloadResult,
  CriticalApplicationPayloadResult,
  CriticalDisplayPayloadResult,
  CriticalAudioDevicePayloadResult,
  CriticalNetworkInterfacePayloadResult,
  ClientSystemCheckPayloadResult,
} from '../IPCValidation';

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
  // The client's socket closed. Marks it offline once its grace period has run
  // out, unless it heartbeats again first; immediately when the grace is 0.
  Disconnected(UUID: string): Promise<void>;
  Heartbeat(UUID: string, Data: ValidatedHeartbeat, IP: string): Promise<Result<string>>;
  SystemInfo(UUID: string, Data: ValidatedSystemInfo, IP: string): Promise<Result<string>>;
  SetUSBDeviceList(UUID: string, DeviceList: ValidatedUSBDevice[]): Promise<Result<string>>;
  SetIntegratedActions(UUID: string, Actions: unknown): Promise<Result<unknown[]>>;
  SetIntegratedState(UUID: string, State: unknown, Message: unknown): Promise<Result<boolean>>;
  SetIdentifying(UUID: string, Identifying: unknown): Promise<Result<boolean>>;
  SetNetworkInterfaces(
    UUID: string,
    Interfaces: ValidatedNetworkInterface[]
  ): Promise<Result<string>>;
  SetRunningApplications(
    UUID: string,
    Snapshot: ValidatedRunningApplications
  ): Promise<Result<string>>;
  SetDisplayList(UUID: string, DisplayList: ValidatedDisplay[]): Promise<Result<string>>;
  ApplyNetworkInterfaceDelta(
    UUID: string,
    Delta: ValidatedNetworkInterfaceDelta
  ): Promise<Result<string>>;
  ApplyDisplayDelta(UUID: string, Delta: ValidatedDisplayDelta): Promise<Result<string>>;
  ApplyApplicationDelta(UUID: string, Delta: ValidatedApplicationDelta): Promise<Result<string>>;
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
  SetAudioDevices(UUID: string, Snapshot: ValidatedAudioDevices): Promise<Result<string>>;
  // Battery / mains / sleep, and temperatures (clients from 3.27.0).
  SetPowerStatus(UUID: string, Snapshot: ValidatedPowerStatus): Promise<Result<string>>;
  SetTemperatures(UUID: string, Snapshot: ValidatedTemperatures): Promise<Result<string>>;
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
  MarkSystemCheck(UUID: string, Check: ClientSystemCheckPayloadResult): Promise<Result<boolean>>;
  RemoveSystemCheck(UUID: string, Key: ClientSystemCheckKey): Promise<Result<boolean>>;
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
  for (const Index of CLIENT_SIDE_INDEXES) Index.applyState(Entity);
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

// --- Monitored kinds --------------------------------------------------------------
// USB devices (by serial and by name), applications, displays, audio endpoints
// and network interfaces are each a per-client list of monitored entries, kept
// in three places that must agree: the side table, the warm index below and the
// Client's own list. A ManagedCriticalKind binds a kind (./critical-kind) to its
// table and index and to the Client calls that hold its list, so the plumbing
// every request shares (persist, index, update the client, broadcast; remove;
// look up) is written once. Each Mark* below only works out what its entry
// should be, which is where the kinds genuinely differ.
interface ManagedCriticalKind<Row, Entry> extends CriticalIndex<Entry> {
  Kind: CriticalKind<Entry>;
  Table: CriticalTable<Row>;
  /** Put one entry on the Client. */
  MarkOn(Target: Client, Entry: Entry): void;
  /** Take the entry under a key off the Client. */
  UnmarkOn(Target: Client, Key: string): void;
  Audit: CriticalAudit<Entry>;
}

// How a monitored entry reads in the audit log: its name, and the conditions an
// edit to it reports, labelled as its conditions table labels them. Presence is
// locked on for every kind, so it is never reported.
interface CriticalAudit<Entry> {
  Name(Entry: Entry): string;
  Conditions: readonly FieldSpec<Entry>[];
}

function ManageCriticalKind<Row extends { UUID: string }, Entry>(Spec: {
  Kind: CriticalKind<Entry>;
  Table: CriticalTable<Row>;
  /** Replace the Client's whole list (hydration). */
  SetOn(Target: Client, Entries: Entry[]): void;
  MarkOn(Target: Client, Entry: Entry): void;
  UnmarkOn(Target: Client, Key: string): void;
  Audit: CriticalAudit<Entry>;
}): ManagedCriticalKind<Row, Entry> {
  const Index = makeCriticalIndex<Row, Entry>({
    loadAll: () => Spec.Table.LoadAll(),
    fromRow: (Row) => ProjectCriticalRow(Spec.Kind, Row),
    apply: Spec.SetOn,
  });
  return Object.assign(Index, {
    Kind: Spec.Kind,
    Table: Spec.Table,
    MarkOn: Spec.MarkOn,
    UnmarkOn: Spec.UnmarkOn,
    Audit: Spec.Audit,
  });
}

const WithUnit =
  (Suffix: string) =>
  (Value: unknown): string | null =>
    Value === null || Value === undefined || Value === '' ? null : `${Value}${Suffix}`;

const USBLocationText = (Value: unknown) =>
  typeof Value === 'string' && Value ? DescribeUSBLocation(Value) : null;

function USBConditionSpecs(PortLabel: string): FieldSpec<CriticalUSBConditions>[] {
  return [
    { Key: 'Location', Label: PortLabel, Format: USBLocationText },
    { Key: 'FirmwareVersion', Label: 'Firmware version' },
    { Key: 'RequireNoError', Label: 'No device error' },
  ];
}

const USB_SERIAL_AUDIT: CriticalAudit<CriticalUSBDevice> = {
  Name: (Entry) => Entry.ProductName || Entry.ManufacturerName || Entry.SerialNumber,
  Conditions: USBConditionSpecs('Port'),
};

const USB_NAME_AUDIT: CriticalAudit<CriticalUSBName> = {
  Name: (Entry) => Entry.ProductName || Entry.ManufacturerName || Entry.NameKey,
  Conditions: USBConditionSpecs('Ports'),
};

const APPLICATION_AUDIT: CriticalAudit<CriticalApplicationEntry> = {
  Name: (Entry) => Entry.Name,
  Conditions: [
    { Key: 'RequireResponding', Label: 'Is responding' },
    { Key: 'RequireForeground', Label: 'Is in foreground' },
  ],
};

const DISPLAY_AUDIT: CriticalAudit<CriticalDisplay> = {
  Name: (Entry) => Entry.Label || 'Display',
  Conditions: [
    {
      Key: 'Width',
      Label: 'Resolution',
      Format: (_Value, Entry) =>
        Entry.Width !== null && Entry.Height !== null ? `${Entry.Width}×${Entry.Height}` : null,
    },
    { Key: 'RefreshRate', Label: 'Refresh rate', Format: WithUnit(' Hz') },
    { Key: 'ScaleFactor', Label: 'Scaling', Format: WithUnit('×') },
    { Key: 'Rotation', Label: 'Rotation', Format: WithUnit('°') },
    { Key: 'RequirePrimary', Label: 'Is primary display' },
    {
      Key: 'PositionX',
      Label: 'Position',
      Format: (_Value, Entry) =>
        Entry.PositionX !== null && Entry.PositionY !== null
          ? `${Entry.PositionX},${Entry.PositionY}`
          : null,
    },
  ],
};

const AUDIO_AUDIT: CriticalAudit<CriticalAudioDevice> = {
  Name: (Entry) => Entry.Name || 'Audio Device',
  Conditions: [
    { Key: 'RequireDefault', Label: 'Is default device' },
    { Key: 'Channels', Label: 'Channels' },
    { Key: 'SampleRate', Label: 'Sample rate', Format: WithUnit(' Hz') },
    { Key: 'RequireUnmuted', Label: 'Is unmuted' },
    { Key: 'MinVolume', Label: 'Minimum level', Format: WithUnit('%') },
    { Key: 'MaxVolume', Label: 'Maximum level', Format: WithUnit('%') },
  ],
};

const NETWORK_AUDIT: CriticalAudit<CriticalNetworkInterface> = {
  Name: (Entry) => Entry.Name,
  Conditions: [
    { Key: 'Address', Label: 'IP address' },
    {
      Key: 'RangeStart',
      Label: 'IP range',
      Format: (_Value, Entry) =>
        Entry.RangeStart && Entry.RangeEnd ? `${Entry.RangeStart} – ${Entry.RangeEnd}` : null,
    },
    { Key: 'Netmask', Label: 'Subnet mask' },
    { Key: 'Gateway', Label: 'Router' },
  ],
};

// System checks share no entry type, so their conditions are read off the
// union of every check's fields (a field a check lacks reads as unchanged).
type SystemCheckFields = Partial<
  ClientUsageCheck & ClientUptimeCheck & ClientPowerCheck & ClientThermalCheck
>;

const SYSTEM_CHECK_NAMES: Record<ClientSystemCheckKey, string> = {
  cpu: 'CPU usage',
  ram: 'Memory usage',
  uptime: 'Uptime',
  power: 'Power',
  thermal: 'Temperature',
};

const THERMAL_STATE_NAMES: Record<string, string> = {
  nominal: 'Normal',
  fair: 'Fair',
  serious: 'Serious',
};

const SYSTEM_CHECK_CONDITIONS: readonly FieldSpec<SystemCheckFields>[] = [
  { Key: 'MaxPercent', Label: 'Maximum usage', Format: WithUnit('%') },
  { Key: 'SustainSeconds', Label: 'For at least', Format: Seconds },
  { Key: 'MaxDays', Label: 'Maximum uptime', Format: WithUnit(' days') },
  { Key: 'RequireMains', Label: 'On mains power' },
  { Key: 'MinBatteryPercent', Label: 'Minimum battery', Format: WithUnit('%') },
  { Key: 'ChargingBelowPercent', Label: 'Charging when below', Format: WithUnit('%') },
  { Key: 'MaxCelsius', Label: 'Maximum temperature', Format: WithUnit('°C') },
  {
    Key: 'MaxThermalState',
    Label: 'Maximum thermal state',
    Format: (Value) => (typeof Value === 'string' ? THERMAL_STATE_NAMES[Value] || Value : null),
  },
];

function ClientAuditBase(Target: Client) {
  return {
    EntityType: 'client' as const,
    EntityID: Target.UUID,
    EntityName: ClientDisplayName(Target),
  };
}

// A mark is a new monitored item, or a change to the conditions of one already
// monitored (only what actually changed is reported).
function RecordMonitoredMark<Entry>(
  Target: Client,
  Name: string,
  Previous: Entry | null,
  Next: Entry,
  Conditions: readonly FieldSpec<Entry>[]
): Promise<void> {
  return AuditStep(() => {
    if (!Previous) {
      RecordEdit({
        ...ClientAuditBase(Target),
        Summary: Line('Started monitoring ', Device(Name)),
      });
      return;
    }
    RecordUpdate({
      ...ClientAuditBase(Target),
      Summary: Line('Changed monitored conditions for ', Device(Name)),
      Changes: DiffFields(Previous, Next, Conditions),
    });
  });
}

function RecordMonitoredRemoval(Target: Client, Name: string): Promise<void> {
  return AuditStep(() =>
    RecordEdit({ ...ClientAuditBase(Target), Summary: Line('Stopped monitoring ', Device(Name)) })
  );
}

const CriticalUSB = ManageCriticalKind({
  Kind: USB_SERIAL_KIND,
  Table: CriticalRepo.USB,
  SetOn: (Target, Entries) => Target.SetCriticalUSBDevices(Entries),
  MarkOn: (Target, Entry) => Target.MarkCriticalUSBDevice(Entry),
  UnmarkOn: (Target, Key) => Target.UnmarkCriticalUSBSerial(Key),
  Audit: USB_SERIAL_AUDIT,
});

const CriticalUSBNames = ManageCriticalKind({
  Kind: USB_NAME_KIND,
  Table: CriticalRepo.USBNames,
  SetOn: (Target, Entries) => Target.SetCriticalUSBNames(Entries),
  MarkOn: (Target, Entry) => Target.MarkCriticalUSBName(Entry),
  UnmarkOn: (Target, Key) => Target.UnmarkCriticalUSBName(Key),
  Audit: USB_NAME_AUDIT,
});

const CriticalApplications = ManageCriticalKind({
  Kind: APPLICATION_KIND,
  Table: CriticalRepo.Applications,
  SetOn: (Target, Entries) => Target.SetCriticalApplications(Entries),
  MarkOn: (Target, Entry) => Target.MarkCriticalApplication(Entry),
  UnmarkOn: (Target, Key) => Target.UnmarkCriticalApplication(Key),
  Audit: APPLICATION_AUDIT,
});

const CriticalDisplays = ManageCriticalKind({
  Kind: DISPLAY_KIND,
  Table: CriticalRepo.Displays,
  SetOn: (Target, Entries) => Target.SetCriticalDisplays(Entries),
  MarkOn: (Target, Entry) => Target.MarkCriticalDisplay(Entry),
  UnmarkOn: (Target, Key) => Target.UnmarkCriticalDisplay(Key),
  Audit: DISPLAY_AUDIT,
});

const CriticalAudio = ManageCriticalKind({
  Kind: AUDIO_KIND,
  Table: CriticalRepo.Audio,
  SetOn: (Target, Entries) => Target.SetCriticalAudioDevices(Entries),
  MarkOn: (Target, Entry) => Target.MarkCriticalAudioDevice(Entry),
  UnmarkOn: (Target, Key) => Target.UnmarkCriticalAudioDevice(Key),
  Audit: AUDIO_AUDIT,
});

const CriticalNetwork = ManageCriticalKind({
  Kind: NETWORK_KIND,
  Table: CriticalRepo.Network,
  SetOn: (Target, Entries) => Target.SetCriticalNetworkInterfaces(Entries),
  MarkOn: (Target, Entry) => Target.MarkCriticalNetworkInterface(Entry),
  UnmarkOn: (Target, Key) => Target.UnmarkCriticalNetworkInterface(Key),
  Audit: NETWORK_AUDIT,
});

// Index, put on the client and announce an entry that has been persisted.
// Previous is the entry it replaces, for the audit log; by default whatever the
// index holds under the same key.
function ApplyCriticalMark<Row, Entry>(
  Managed: ManagedCriticalKind<Row, Entry>,
  UUID: string,
  Target: Client,
  Entry: Entry,
  Previous: Entry | null = Managed.getForClient(UUID, false)?.get(Managed.Kind.KeyOf(Entry)) ?? null
): void {
  Managed.setForClient(UUID, Managed.Kind.KeyOf(Entry), Entry);
  Managed.MarkOn(Target, Entry);
  BroadcastManager.emit('ClientUpdated', Target);
  void RecordMonitoredMark(
    Target,
    Managed.Audit.Name(Entry),
    Previous,
    Entry,
    Managed.Audit.Conditions
  );
}

// Persist a resolved entry, then apply it. Ok(Result) once the write lands.
async function CommitCriticalMark<Row, Entry>(
  Managed: ManagedCriticalKind<Row, Entry>,
  UUID: string,
  Target: Client,
  Entry: Entry,
  Row: Row,
  Result: boolean
): Promise<Result<boolean>> {
  const [WriteErr] = await Managed.Table.Mark(Row);
  if (WriteErr) return Fail(Managed.Kind.Messages.SaveFailed);
  ApplyCriticalMark(Managed, UUID, Target, Entry);
  return Ok(Result);
}

// Stop monitoring the entry under a key. ResolveKey maps a requested key onto
// the stored one where a kind matches entries by more than their own key.
async function RemoveCritical<Row, Entry>(
  Managed: ManagedCriticalKind<Row, Entry>,
  UUID: string,
  RawKey: unknown,
  ResolveKey: (Target: Client, Key: string) => string = (_Target, Key) => Key
): Promise<Result<boolean>> {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Requested = Managed.Kind.NormalizeKey(RawKey);
  if (!Requested) return Fail(Managed.Kind.Messages.KeyRequired);
  const Key = ResolveKey(Target, Requested);
  const Previous = Managed.getForClient(UUID, false)?.get(Key) ?? null;

  const [WriteErr] = await Managed.Table.Remove(UUID, Key);
  if (WriteErr) return Fail(Managed.Kind.Messages.RemoveFailed);

  Managed.removeForClient(UUID, Key);
  Managed.UnmarkOn(Target, Key);
  BroadcastManager.emit('ClientUpdated', Target);
  if (Previous) await RecordMonitoredRemoval(Target, Managed.Audit.Name(Previous));
  return Ok(true);
}

// Whether the entry under a key is monitored: from the warm index when the
// client has one, else from the table.
async function IsCritical<Row, Entry>(
  Managed: ManagedCriticalKind<Row, Entry>,
  UUID: string,
  RawKey: unknown
): Promise<Result<boolean>> {
  const Key = Managed.Kind.NormalizeKey(RawKey);
  if (!Key) return Ok(false);
  const Cached = Managed.getForClient(UUID, false);
  if (Cached) return Ok(Cached.has(Key));
  const [Err, Row] = await Managed.Table.Is(UUID, Key);
  if (Err) return Fail(Managed.Kind.Messages.LookupFailed);
  return Ok(!!Row);
}

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

// Monitored system checks: keyed by a fixed set of check names, each holding its
// own thresholds, so they share the index but not the kind plumbing.
const CriticalSystemChecks = makeCriticalIndex<
  SystemCheckRow,
  { Key: ClientSystemCheckKey; Check: SystemCheck }
>({
  loadAll: () => CriticalRepo.SystemChecks.LoadAll(),
  fromRow: (Row) => {
    const UUID = Row && Row.UUID ? String(Row.UUID) : '';
    const Entry = normalizeSystemCheckRow(Row);
    if (!UUID || !Entry) return null;
    return { UUID, Key: Entry.Key, Entry };
  },
  apply: (client, entries) => client.SetSystemChecks(entries),
});

// The operations that touch every per-client index at once never look inside an
// entry, so the lists below hold just those (which any index satisfies).
type ClientSideIndex = Pick<
  CriticalIndex<unknown>,
  'applyState' | 'clearForClient' | 'rekeyClient' | 'load' | 'clear'
>;

// The monitored-entry indexes, which move with a client when it is replaced.
const CRITICAL_INDEXES: readonly ClientSideIndex[] = [
  CriticalUSB,
  CriticalUSBNames,
  CriticalApplications,
  CriticalDisplays,
  CriticalAudio,
  CriticalNetwork,
  CriticalSystemChecks,
];

// Every per-client side table, for hydration, delete, start-up load and reset.
const CLIENT_SIDE_INDEXES: readonly ClientSideIndex[] = [...CRITICAL_INDEXES, MacAddresses];

Manager.Timeout = async (UUID: string) => {
  const Exists = await Manager.Exists(UUID);
  if (!Exists) return;
  const [Err, TimedOutClient] = await Manager.Get(UUID);
  if (Err) return Logger.error('Failed to get client for timeout:', Err);
  if (!TimedOutClient) return Logger.warn(`Client ${UUID} not found for timeout.`);
  TimedOutClient.SetOnline(false);
  return;
};

Manager.Disconnected = async (UUID: string) => {
  const Cached = ClientIndex.get(UUID);
  const Seconds = ResolveOfflineGraceSeconds(Cached ? Cached.OfflineGraceSeconds : null);
  if (Seconds <= 0) return Manager.Timeout(UUID);
  Logger.log(`Client ${UUID} disconnected; marking offline in ${Seconds}s unless it reconnects`);
  SchedulePendingTimeout(UUID, Seconds, () => {
    Manager.Timeout(UUID).catch((err) =>
      Logger.error('Failed to time out client after its grace period:', err)
    );
  });
};

// Fast path for frequent telemetry: update cached client or hydrate from DB
Manager.Heartbeat = async (UUID: string, Data: ValidatedHeartbeat, IP: string) => {
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

  // Back inside its grace period: the disconnect was a blip, not an outage.
  if (CancelPendingTimeout(UUID)) {
    Logger.log(`Client ${UUID} reconnected within its grace period`);
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

Manager.SetUSBDeviceList = async (UUID: string, DeviceList: ValidatedUSBDevice[]) => {
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

Manager.SetNetworkInterfaces = async (UUID: string, Interfaces: ValidatedNetworkInterface[]) => {
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

Manager.ApplyNetworkInterfaceDelta = async (
  UUID: string,
  Delta: ValidatedNetworkInterfaceDelta
) => {
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

Manager.ApplyDisplayDelta = async (UUID: string, Delta: ValidatedDisplayDelta) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.ApplyDisplayDelta(Delta);
  return Ok('Display delta applied successfully');
};

Manager.ApplyApplicationDelta = async (UUID: string, Delta: ValidatedApplicationDelta) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  if (addClientToCache(Target)) {
    BroadcastManager.emit('ClientListChanged');
  }
  Target.ApplyApplicationDelta(Delta);
  return Ok('Application delta applied successfully');
};

Manager.SetRunningApplications = async (UUID: string, Snapshot: ValidatedRunningApplications) => {
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
  if (!ApplicationName) return Fail(APPLICATION_KIND.Messages.KeyRequired);

  const ApplicationKey = ApplicationName.toLowerCase();
  // Re-marking an application that is already monitored updates its
  // conditions; a condition the payload does not mention keeps what it had. A
  // monitored application must always run; a first mark also requires it to
  // respond, and leaves the foreground. It keeps the name it was first marked
  // under.
  const Existing = Target.CriticalApplications.find((Entry) => Entry.Key === ApplicationKey);
  const Pick = (Key: 'RequireForeground' | 'RequireResponding', First: boolean) =>
    typeof Application?.[Key] === 'boolean'
      ? (Application[Key] as boolean)
      : Existing
        ? Existing[Key]
        : First;
  const Entry: CriticalApplicationEntry = {
    Name: Existing ? Existing.Name : ApplicationName,
    Key: ApplicationKey,
    Timestamp: Existing && Existing.Timestamp ? Existing.Timestamp : Date.now(),
    RequireForeground: Pick('RequireForeground', false),
    RequireResponding: Pick('RequireResponding', true),
  };
  return CommitCriticalMark(
    CriticalApplications,
    UUID,
    Target,
    Entry,
    {
      UUID,
      ApplicationKey,
      ApplicationName: Entry.Name,
      Timestamp: Entry.Timestamp ?? Date.now(),
      RequireForeground: Entry.RequireForeground ? 1 : 0,
      RequireResponding: Entry.RequireResponding ? 1 : 0,
    },
    true
  );
};

Manager.RemoveApplicationCritical = (UUID: string, ApplicationName: unknown) =>
  RemoveCritical(CriticalApplications, UUID, ApplicationName);

Manager.IsApplicationCritical = (UUID: string, ApplicationName: unknown) =>
  IsCritical(CriticalApplications, UUID, ApplicationName);

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
  if (!SerialNumber) return Fail(USB_SERIAL_KIND.Messages.KeyRequired);

  const KnownDevice = (
    Array.isArray(Target.ConnectedUSBDeviceList) ? Target.ConnectedUSBDeviceList : []
  ).find((Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) === SerialNumber);
  const Existing = CriticalUSB.getForClient(UUID, false)?.get(SerialNumber) || null;
  const [ResolveErr, Conditions] = resolveUSBConditions(
    Device,
    KnownDevice ? [KnownDevice] : [],
    Existing
  );
  if (ResolveErr || !Conditions)
    return Fail(ResolveErr || 'Failed to resolve monitored USB device');

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
  return CommitCriticalMark(
    CriticalUSB,
    UUID,
    Target,
    Entry,
    {
      UUID,
      SerialNumber,
      ManufacturerName: Entry.ManufacturerName,
      ProductName: Entry.ProductName,
      ...USBConditionColumns(Entry),
      Timestamp: Entry.Timestamp ?? Date.now(),
    },
    true
  );
};

Manager.RemoveUSBDeviceCritical = (UUID: string, SerialNumber: unknown) =>
  RemoveCritical(CriticalUSB, UUID, SerialNumber);

Manager.IsUSBDeviceCritical = (UUID: string, SerialNumber: unknown) =>
  IsCritical(CriticalUSB, UUID, SerialNumber);

Manager.MarkUSBNameCritical = async (UUID: string, Device: CriticalUSBNamePayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const ManufacturerName = (Device && Device.ManufacturerName) || null;
  const ProductName = (Device && Device.ProductName) || null;
  const NameKey = normalizeUSBNameKey(ManufacturerName, ProductName);
  if (!NameKey) return Fail(USB_NAME_KIND.Messages.KeyRequired);

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
  if (ResolveErr || !Conditions)
    return Fail(ResolveErr || 'Failed to resolve monitored USB device');

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
  return CommitCriticalMark(
    CriticalUSBNames,
    UUID,
    Target,
    Entry,
    {
      UUID,
      NameKey,
      ManufacturerName: Entry.ManufacturerName,
      ProductName: Entry.ProductName,
      Quantity: Entry.Quantity,
      ...USBConditionColumns(Entry),
      Timestamp: Entry.Timestamp ?? Date.now(),
    },
    true
  );
};

// A serial-less device is removed by its make and model, which name its key.
Manager.RemoveUSBNameCritical = (UUID: string, Device: CriticalUSBNamePayloadResult) =>
  RemoveCritical(
    CriticalUSBNames,
    UUID,
    normalizeUSBNameKey(Device && Device.ManufacturerName, Device && Device.ProductName)
  );

Manager.IsUSBNameCritical = (UUID: string, NameKey: unknown) =>
  IsCritical(CriticalUSBNames, UUID, NameKey);

Manager.SetDisplayList = async (UUID: string, DisplayList: ValidatedDisplay[]) => {
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
  if (!DisplayID) return Fail(DISPLAY_KIND.Messages.KeyRequired);

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
  if (ResolveErr || !Entry) return Fail(ResolveErr || 'Failed to resolve monitored display');

  const Rekeyed = !!Existing && Existing.DisplayID !== Entry.DisplayID;
  const [WriteErr] = await CriticalDisplays.Table.Mark({
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
  if (WriteErr) return Fail(DISPLAY_KIND.Messages.SaveFailed);
  if (Rekeyed) {
    const [RemoveErr] = await CriticalDisplays.Table.Remove(UUID, Existing.DisplayID);
    if (RemoveErr) Logger.error('Failed to retire a re-keyed monitored display', RemoveErr);
    CriticalDisplays.removeForClient(UUID, Existing.DisplayID);
    Target.UnmarkCriticalDisplay(Existing.DisplayID);
  }

  ApplyCriticalMark(CriticalDisplays, UUID, Target, Entry, Existing);
  return Ok(!Existing);
};

// Accepts the live id of a display matched to the entry under another id.
Manager.RemoveDisplayCritical = (UUID: string, DisplayID: unknown) =>
  RemoveCritical(
    CriticalDisplays,
    UUID,
    DisplayID,
    (Target, Requested) => Target.FindCriticalDisplay(Requested).Critical?.DisplayID ?? Requested
  );

Manager.IsDisplayCritical = (UUID: string, DisplayID: unknown) =>
  IsCritical(CriticalDisplays, UUID, DisplayID);

Manager.SetAudioDevices = async (UUID: string, Snapshot: ValidatedAudioDevices) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.SetAudioDevices(Snapshot);
  return Ok('Audio devices updated successfully');
};

Manager.SetPowerStatus = async (UUID: string, Snapshot: ValidatedPowerStatus) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.SetPowerStatus(Snapshot);
  return Ok('Power status updated successfully');
};

Manager.SetTemperatures = async (UUID: string, Snapshot: ValidatedTemperatures) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  Target.SetTemperatures(Snapshot);
  return Ok('Temperatures updated successfully');
};

Manager.MarkAudioDeviceCritical = async (
  UUID: string,
  Device: CriticalAudioDevicePayloadResult
) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const EndpointID = normalizeEndpointID(Device && Device.EndpointID);
  if (!EndpointID) return Fail(AUDIO_KIND.Messages.KeyRequired);

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
  if (ResolveErr || !Entry) return Fail(ResolveErr || 'Failed to resolve monitored audio device');

  return CommitCriticalMark(
    CriticalAudio,
    UUID,
    Target,
    Entry,
    {
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
    },
    !Existing
  );
};

Manager.RemoveAudioDeviceCritical = (UUID: string, EndpointID: unknown) =>
  RemoveCritical(CriticalAudio, UUID, EndpointID);

Manager.MarkNetworkInterfaceCritical = async (
  UUID: string,
  Interface: CriticalNetworkInterfacePayloadResult
) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Name = normalizeInterfaceName(Interface && Interface.Name);
  if (!Name) return Fail(NETWORK_KIND.Messages.KeyRequired);

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
    return Fail(ResolveErr || 'Failed to resolve monitored network interface');
  }

  return CommitCriticalMark(
    CriticalNetwork,
    UUID,
    Target,
    Entry,
    {
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
    },
    !Existing
  );
};

Manager.RemoveNetworkInterfaceCritical = (UUID: string, Name: unknown) =>
  RemoveCritical(CriticalNetwork, UUID, Name);

Manager.MarkSystemCheck = async (UUID: string, Check: ClientSystemCheckPayloadResult) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');
  const Key = Check.Key;
  const Existing = CriticalSystemChecks.getForClient(UUID, false)?.get(Key) || null;
  const Next = resolveSystemCheck(
    Key,
    Check as unknown as Record<string, unknown>,
    Existing ? Existing.Check : null,
    Target.PowerStatus,
    Target.Temperatures
  );
  const Timestamp = Date.now();
  const [WriteErr] = await CriticalRepo.SystemChecks.Mark(
    SystemCheckToRow(UUID, Key, Next, Timestamp)
  );
  if (WriteErr) return Fail('Failed to save monitored system check');

  CriticalSystemChecks.setForClient(UUID, Key, { Key, Check: Next });
  Target.MarkSystemCheck(Key, Next);
  BroadcastManager.emit('ClientUpdated', Target);
  await RecordMonitoredMark<SystemCheckFields>(
    Target,
    SYSTEM_CHECK_NAMES[Key] || Key,
    Existing ? Existing.Check : null,
    Next,
    SYSTEM_CHECK_CONDITIONS
  );
  return Ok(!Existing);
};

Manager.RemoveSystemCheck = async (UUID: string, Key: ClientSystemCheckKey) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  const WasMonitored = !!CriticalSystemChecks.getForClient(UUID, false)?.get(Key);
  const [WriteErr] = await CriticalRepo.SystemChecks.Remove(UUID, Key);
  if (WriteErr) return Fail('Failed to stop monitoring system check');

  CriticalSystemChecks.removeForClient(UUID, Key);
  Target.UnmarkSystemCheck(Key);
  BroadcastManager.emit('ClientUpdated', Target);
  if (WasMonitored) await RecordMonitoredRemoval(Target, SYSTEM_CHECK_NAMES[Key] || Key);
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
  // A reported address is telemetry, not an edit.
  if (Source === 'Manual') {
    await AuditStep(() =>
      RecordEdit({
        ...ClientAuditBase(Target),
        Summary: Line('Added MAC address ', Value(Normalized)),
      })
    );
  }
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
  const WasOnFile = !!MacAddresses.getForClient(UUID, false)?.get(Normalized);

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
  if (WasOnFile) {
    await AuditStep(() =>
      RecordEdit({
        ...ClientAuditBase(Target),
        Summary: Line('Removed MAC address ', Value(Normalized)),
      })
    );
  }
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
Manager.SystemInfo = async (UUID: string, Data: ValidatedSystemInfo, IP: string) => {
  const [Err, Target] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Target) return Fail('Client Not Found');

  await Target.SetHostname(Data.Hostname || null, { markUnsaved: false });
  await Target.SetOperatingSystem(Data.OperatingSystem || null, { markUnsaved: false });

  const Interfaces = Object.entries(Data.MacAddresses || {});
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

// The editor fields an update reports, as the editor names them.
interface ClientAuditFields {
  Nickname: string | null;
  Group: string;
  Slug: string | null;
  RunOnLaunch: string | null;
  LaunchDelay: string | null;
  OfflineGrace: string | null;
}

const CLIENT_AUDIT_FIELDS: readonly FieldSpec<ClientAuditFields>[] = [
  { Key: 'Nickname', Label: 'Nickname' },
  { Key: 'Group', Label: 'Group' },
  { Key: 'Slug', Label: 'Slug' },
  { Key: 'RunOnLaunch', Label: 'Run on Launch' },
  { Key: 'LaunchDelay', Label: 'Launch Delay' },
  { Key: 'OfflineGrace', Label: 'Disconnect Grace Period' },
];

async function ClientAuditFieldsOf(Target: Client): Promise<ClientAuditFields> {
  return {
    Nickname: Target.Nickname,
    Group: await GroupTitle(Target.GroupID),
    Slug: Target.Slug,
    RunOnLaunch: await ScriptName(Target.RunOnLaunchScriptID),
    LaunchDelay: Seconds(Target.RunOnLaunchDelaySeconds),
    // Null inherits the Preferences value.
    OfflineGrace:
      Target.OfflineGraceSeconds === null ? 'Default' : Seconds(Target.OfflineGraceSeconds),
  };
}

Manager.Update = async (UUID: string, Data: unknown) => {
  const [Err, Client] = await Manager.Get(UUID);
  if (Err) return Fail(Err);
  if (!Client) return Fail('Client Not Found');
  // Recorded however the update ends: the setters that ran before a failure
  // have still landed. Variables are recorded by VariableManager.
  const Before = await AuditBefore(() => ClientAuditFieldsOf(Client));
  const Result = await ApplyClientUpdate(UUID, Client, Data);
  if (Before) {
    await AuditStep(async () =>
      RecordUpdate({
        ...ClientAuditBase(Client),
        Summary: Line('Edited ', Entity(ClientDisplayName(Client))),
        Changes: DiffFields(Before, await ClientAuditFieldsOf(Client), CLIENT_AUDIT_FIELDS),
      })
    );
  }
  return Result;
};

async function ApplyClientUpdate(
  UUID: string,
  Client: Client,
  Data: unknown
): Promise<Result<Client>> {
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
  if (Object.prototype.hasOwnProperty.call(Fields, 'OfflineGraceSeconds')) {
    const [SetErr] = await Client.SetOfflineGraceSeconds(
      Fields.OfflineGraceSeconds as number | null
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
}

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
  // The row has no hostname until the client reports in; the pending tile it
  // was adopted from already knows it.
  await AuditStep(() => {
    const Hostname = PendingHostname(UUID);
    RecordEdit({
      ...ClientAuditBase(Created),
      EntityName: Hostname || ClientDisplayName(Created),
      Summary: Line('Adopted ', Entity(Hostname || ClientDisplayName(Created))),
      Severity: 'success',
    });
  });
  return Ok(true);
};

function PendingHostname(UUID: string): string | null {
  // Lazy: AdoptionManager imports this module.
  const { Manager: AdoptionManager } =
    require('../AdoptionManager') as typeof import('../AdoptionManager');
  const Pending = AdoptionManager.GetClientsPendingAdoption().find(
    (Device) => Device.UUID === UUID
  );
  return Pending && Pending.Hostname !== 'No Hostname Found' ? Pending.Hostname : null;
}

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
  await AuditStep(() => {
    for (const Slot of Created) {
      RecordEdit({
        ...ClientAuditBase(Slot),
        Summary: Line('Created unassigned client ', Entity(ClientDisplayName(Slot))),
      });
    }
  });
  return Ok(Created);
};

// Unadopt or purge a client; remove from DB and cache
Manager.Delete = async (UUID: string) => {
  // Named before it goes, for the audit log.
  const Name = await AuditBefore(async () => {
    const Cached = ClientIndex.get(UUID);
    if (Cached) return ClientDisplayName(Cached);
    const [, Row] = await ClientsRepo.GetByUUID(UUID);
    return Row ? ClientDisplayName(Row) : null;
  });
  // One transaction across all five tables so a mid-sequence failure can never
  // leave the client row and its critical rows half-deleted.
  const [Err] = await ClientsRepo.DeleteClientCascade(UUID);
  if (Err) return Fail('Failed to delete client');
  // Remove from in-memory list
  removeClientFromCache(UUID);
  CancelPendingTimeout(UUID);
  for (const Index of CLIENT_SIDE_INDEXES) Index.clearForClient(UUID);
  Logger.success(`Client ${UUID} deleted successfully`);
  if (Name) {
    await AuditStep(() =>
      RecordEdit({
        EntityType: 'client',
        EntityID: UUID,
        EntityName: Name,
        Summary: Line('Deleted ', Entity(Name)),
        Severity: 'warning',
      })
    );
  }
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

  for (const Index of CRITICAL_INDEXES) Index.rekeyClient(OldUUID, NewUUID);
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
  // The transaction also rewrote tag scopes, script whitelists and the FOG host
  // link. None of their managers cache those rows server-side (each read goes
  // to the DB), so refreshing means re-pushing what the UIs hold: the tag list,
  // the whitelist-decorated script catalog (from cache, fingerprint unchanged,
  // so no redeploy) and the FOG task panel.
  BroadcastManager.emit('TagListChanged');
  BroadcastManager.emit('ScriptsUpdated');
  BroadcastManager.emit('FogTasksUpdated');
  await AuditStep(() => {
    const Hostname = PendingHostname(NewUUID);
    RecordEdit({
      ...ClientAuditBase(ExistingClient),
      Summary: Line(
        'Replaced ',
        Entity(ClientDisplayName(ExistingClient)),
        Hostname ? ' with ' : ' with a new device',
        Hostname ? Device(Hostname) : null
      ),
      Details: [`Previous client ID ${OldUUID}`],
    });
  });
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
  for (const Index of CLIENT_SIDE_INDEXES) await Index.load();
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
  const Moved: Client[] = [];
  let weight = 10;
  for (const uuid of orderedUUIDs) {
    const [err, client] = await Manager.Get(uuid);
    if (err) continue;
    if (!client) continue;
    // move to target group if needed
    if (client.GroupID !== TargetGroupID) {
      const [MoveErr] = await client.SetGroupID(TargetGroupID);
      if (!MoveErr) Moved.push(client);
    }
    await client.SetWeight(weight);
    weight += 10;
  }
  // Emit a single list changed after batch
  BroadcastManager.emit('ClientListChanged');
  await RecordGroupMoves(Moved, TargetGroupID);
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
  const Moved: Client[] = [];
  for (let i = 0; i < orderedUUIDs.length; i++) {
    const uuid = orderedUUIDs[i];
    const w = Number(weights[i]) || 0;
    const [err, client] = await Manager.Get(uuid);
    if (err || !client) continue;
    if (client.GroupID !== TargetGroupID) {
      const [MoveErr] = await client.SetGroupID(TargetGroupID);
      if (!MoveErr) Moved.push(client);
    }
    await client.SetWeight(w);
  }
  BroadcastManager.emit('ClientListChanged');
  await RecordGroupMoves(Moved, TargetGroupID);
  return Ok(true);
};

// A drag between groups. Reordering within a group is not an edit worth a line.
async function RecordGroupMoves(Moved: Client[], GroupID: unknown): Promise<void> {
  if (!Moved.length) return;
  await AuditStep(async () => {
    const Title = await GroupTitle(GroupID);
    for (const Moving of Moved) {
      RecordEdit({ ...ClientAuditBase(Moving), Summary: Line('Moved to ', Value(Title)) });
    }
  });
}

Manager.ClearCache = async () => {
  for (const Cached of ClientList) Cached._clearStartupGraceTimer();
  ClientList = [];
  rebuildClientIndex();
  for (const Index of CLIENT_SIDE_INDEXES) Index.clear();
  Manager.Initialized = false;
  return;
};

export { Manager };
