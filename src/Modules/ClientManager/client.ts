// Client
// In-memory representation of a connected ShowTrak client.
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateClientsRepository } from '../DB/repositories/clients';
import { Manager as BroadcastManager } from '../Broadcast';
import { CLIENT_STARTUP_GRACE_MS } from '../Config/constants';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import {
  AsRecord,
  normalizeSerialNumber,
  usbDeviceModelKey,
  normalizeUSBNameKey,
  normalizeApplicationName,
  normalizeApplicationKey,
  normalizeDisplayID,
} from './normalizers';
import type {
  USBDevice,
  ClientDisplay,
  RunningApplicationItem,
  IntegratedAction,
} from '@showtrak/protocol';

const Logger = CreateLogger('ClientManager');

const ClientsRepo = CreateClientsRepository(DB);

// One MAC a client is known by, as carried in RAM and serialized to the UI.
export interface ClientMacAddress {
  MacAddress: string;
  Source: 'Reported' | 'Manual';
  InterfaceName: string | null;
  FirstSeen: number;
  LastSeen: number;
}

// `parseInt` ToString-coerces its argument, so `String()` wrapping is
// behaviour-identical to the historical `parseInt(x, 10)` on dynamic values.
function ParseIntOrNull(Value: unknown): number | null {
  return parseInt(String(Value), 10) || null;
}
// Preserve the historical `Value ? Value : null` timestamp passthrough while
// satisfying the `number | null` field type (timestamps are always numeric).
function TimestampOrNull(Value: unknown): number | null {
  return (Value || null) as number | null;
}

// Normalize a reported interface list into the shape carried in RAM. Shared by
// the full-list setter and the delta applier so both paths store identical
// records — a delta that normalized differently would make an interface look
// changed on the next full list and flap forever.
function normalizeNetworkInterfaces(Interfaces: unknown): NormalizedNetworkInterface[] {
  const List: unknown[] = Array.isArray(Interfaces) ? Interfaces : [];
  return List.map((rawIface) => {
    const iface = AsRecord(rawIface);
    return {
      name: iface.name ? String(iface.name) : 'unknown',
      addresses: Array.isArray(iface.addresses)
        ? iface.addresses.map((rawAddr: unknown) => {
            const a = AsRecord(rawAddr);
            return {
              family: a.family,
              address: a.address,
              netmask: a.netmask,
              cidr: a.cidr || null,
              mac: a.mac,
              internal: !!a.internal,
              scopeid: typeof a.scopeid !== 'undefined' ? a.scopeid : null,
            };
          })
        : [],
    };
  });
}

// Running applications are ordered busiest-first, then alphabetically. Shared by
// the snapshot setter and the delta applier: the stored signature is derived
// from this order, so the two paths must sort identically or an applied delta
// would look like a change to the very next full snapshot.
function sortRunningApplications(Items: DedupedRunningApplication[]): DedupedRunningApplication[] {
  return Items.sort((left, right) => {
    if (right.Count !== left.Count) return right.Count - left.Count;
    return left.Name.localeCompare(right.Name);
  });
}

function runningApplicationsSignature(
  TotalCount: number,
  Truncated: boolean,
  Items: DedupedRunningApplication[]
): string {
  return `${TotalCount}|${Truncated ? '1' : '0'}|${Items.map(
    (Entry) => `${Entry.Name}:${Entry.Count}`
  ).join('|')}`;
}

// A display "signature" captures the operator-visible configuration we guard.
function buildDisplaySignature(Display: unknown): string {
  const D = AsRecord(Display);
  const Width = parseInt(String(D.Width), 10) || 0;
  const Height = parseInt(String(D.Height), 10) || 0;
  const RefreshRate =
    D.RefreshRate != null && Number.isFinite(Number(D.RefreshRate))
      ? Math.round(Number(D.RefreshRate))
      : 0;
  return `${Width}x${Height}@${RefreshRate}`;
}

// --- Local domain shapes ---------------------------------------------------
// The persisted "critical" entries we guard, as normalized by the SetCritical*
// methods and mirrored (minus UUID) by the DB rows in ../DB/rows.ts.
interface CriticalUSBEntry {
  SerialNumber: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Timestamp: number | null;
}
// Serial-less critical device: guarded by its visible name and an expected
// Quantity, since no serial number is available to track it individually.
interface CriticalUSBNameEntry {
  NameKey: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Quantity: number;
  Timestamp: number | null;
}
interface CriticalDisplayEntry {
  DisplayID: string;
  Label: string | null;
  Width: number | null;
  Height: number | null;
  RefreshRate: number | null;
  ScaleFactor: number | null;
  Timestamp: number | null;
}
interface CriticalApplicationEntry {
  Name: string;
  Key: string;
  Timestamp: number | null;
}

// The augmented per-entity view entries the _rebuild* methods emit for the
// renderer: connected devices merged with their critical/missing status. The
// index signatures carry forward the spread of the raw telemetry payload.
interface USBDeviceViewEntry {
  SerialNumber: string | null;
  ManufacturerName: string | null;
  ProductName: string | null;
  IsConnected: boolean;
  IsCritical: boolean;
  Missing: boolean;
  // Serial-less name-based guarding: set when this entry is (or matches) a
  // device marked critical by name. Quantity/ConnectedCount describe the
  // expected-vs-observed count for that name.
  IsCriticalByName?: boolean;
  NameKey?: string;
  Quantity?: number;
  ConnectedCount?: number;
  // Set on a connected/missing name-guarded entry when fewer devices of this
  // name are connected than the expected Quantity.
  Shortfall?: boolean;
  [key: string]: unknown;
}
interface DisplayViewEntry {
  DisplayID: string | null;
  Label: string | null;
  IsConnected: boolean;
  IsCritical: boolean;
  Missing: boolean;
  Mismatch: boolean;
  CurrentSignature: string | null;
  ExpectedSignature: string | null;
  [key: string]: unknown;
}
interface RunningApplicationViewEntry {
  Name: string;
  Count: number;
  Key: string | null;
  IsRunning: boolean;
  IsCritical: boolean;
  Missing: boolean;
}

// Vitals as held in RAM: the last heartbeat's payload, or empty objects before
// the first heartbeat arrives. Kept structurally loose (the renderer reads the
// concrete @showtrak/protocol Vitals fields off the serialized projection).
interface ClientVitals {
  CPU: Record<string, unknown>;
  Ram: Record<string, unknown>;
  Uptime: Record<string, unknown>;
}

// Network interfaces as normalized by SetNetworkInterfaces (a superset of the
// wire shape; the raw address fields are copied through verbatim).
interface NormalizedNetworkAddress {
  family: unknown;
  address: unknown;
  netmask: unknown;
  cidr: unknown;
  mac: unknown;
  internal: boolean;
  scopeid: unknown;
}
interface NormalizedNetworkInterface {
  name: string;
  addresses: NormalizedNetworkAddress[];
}

// Running-applications status/snapshot as normalized in RAM. Distinct from the
// wire RunningApplicationsSnapshot: Platform is always present (nullable), and
// the *view* variant carries the augmented RunningApplicationViewEntry items.
interface RunningAppStatus {
  State: string;
  Message: string | null;
  Platform: string | null;
}
interface ObservedRunningApplicationsState {
  SampledAt: number | null;
  TotalCount: number;
  Truncated: boolean;
  Items: RunningApplicationItem[];
  Status: RunningAppStatus;
}
interface RunningApplicationsView {
  SampledAt: number | null;
  TotalCount: number;
  Truncated: boolean;
  Items: RunningApplicationViewEntry[];
  Status: RunningAppStatus;
}

// Options accepted by the DB-backed setters: `markUnsaved: false` suppresses
// dirty-tracking for telemetry-driven writes (heartbeat/system-info).
interface PersistOptions {
  markUnsaved?: boolean;
}

// The de-duplicated `{ Name, Count }` pair tracked while diffing running-app
// snapshots (both the previous-by-key map and the freshly de-duped map).
interface DedupedRunningApplication {
  Name: string;
  Count: number;
}

// Seed accepted by the constructor: a persisted `ClientRow` (mirrored in
// DB/rows.ts) or the partial literal `ClientManager.Create` builds for a freshly
// adopted client, which omits the ordering/identity columns defaulted below.
interface ClientConstructorInput {
  UUID: string;
  Timestamp: number;
  Hostname: string | null;
  OperatingSystem: string | null;
  Version: string | null;
  IP: string | null;
  Nickname?: string | null;
  GroupID?: number | null;
  Weight?: number | null;
  MacAddress?: string | null;
  MacAddresses?: ClientMacAddress[];
  RunOnLaunchScriptID?: string | null;
  RunOnLaunchDelaySeconds?: number | null;
  Unassigned?: unknown;
  Slug?: string | null;
}

// Start-up window timers, held OFF the client objects on purpose.
//
// A Client instance is broadcast as-is: it crosses Electron's IPC to the
// renderer (structured clone) and is JSON-stringified into alert history. A
// Node timer handle survives neither — it is circular, so stringify throws, and
// it is not cloneable, so the IPC send fails. Keeping the handles in a WeakMap
// leaves the client itself plain data, and entries disappear with the client.
const StartupGraceTimers = new WeakMap<Client, ReturnType<typeof setTimeout>>();

class Client {
  // Persisted identity + ordering (mirrors DB/rows.ts ClientRow).
  UUID: string;
  Nickname: string | null;
  Hostname: string | null;
  OperatingSystem: string | null;
  GroupID: number | null;
  Weight: number;
  // The MAC of the interface serving the active socket IP — the "primary"
  // address, kept for display and back-compat. Waking uses MacAddresses below,
  // which is the full set; this is only ever one of them.
  MacAddress: string | null;
  // Every MAC this client is known by, newest-last. Backed by the
  // ClientMacAddresses table and hydrated on load; see AddMacAddress /
  // RemoveMacAddress / IngestReportedMacAddresses.
  MacAddresses: ClientMacAddress[];
  Version: string | null;
  IP: string | null;
  RunOnLaunchScriptID: string | null;
  RunOnLaunchDelaySeconds: number | null;
  // Stable, human-friendly OSC/API identifier. Unique across the shared client
  // namespace (real clients + monitors + dummies). Back-filled non-null on boot.
  Slug: string | null;
  // A reserved slot with no hardware behind it yet. Such a client is offline
  // forever by definition, so the UI labels it rather than counting how long
  // it has been down, and offline alerts skip it.
  Unassigned: boolean;
  Timestamp: number;

  // Connection + health (RAM-only, not persisted).
  Online: boolean;
  LastSeen: number;
  Vitals: ClientVitals;
  Degraded: boolean;
  DegradedWarnings: string[];
  // Online, inside the start-up window, and holding at least one inferred fault
  // (see CLIENT_STARTUP_GRACE_MS). Distinct from Degraded on purpose: the tile
  // reads "Starting Up" rather than claiming either health or a fault.
  Initialising: boolean;
  // When the current connection was established, or null while offline. The
  // start-up window is measured from here rather than from server start, so a
  // machine that joins the show late gets the same allowance as the rest.
  OnlineSince: number | null;

  // Telemetry evidence gates (RAM-only).
  //
  // Every critical-hardware guard works by comparing what the client HAS
  // reported against what it is expected to have. A client reports nothing at
  // the instant it connects: its heartbeat lands first and the USB, display and
  // application reports follow one second apart (see the client's on-connect
  // sequence). Treating that gap as "the devices are gone" marked every client
  // degraded for the first few seconds of every connection — and at server
  // start, with the whole rig connecting at once, that arrived as a wave of
  // alerts for faults that never existed.
  //
  // These flags record whether each domain has actually been observed on THIS
  // connection, so an unreported domain is skipped rather than assumed faulty.
  // They are deliberately not a timer: the moment real data lands, a genuine
  // fault is evaluated and alerted on, so a device that was already missing
  // when the client connected is still caught a second later.
  //
  // They reset on disconnect, so a reconnecting client re-proves each domain
  // rather than being judged on the previous session's data.
  HasUSBTelemetry: boolean;
  HasDisplayTelemetry: boolean;
  // Applications additionally carry their own sampler status, so this tracks
  // whether the stored snapshot came from a sample that actually succeeded.
  HasApplicationTelemetry: boolean;
  Identifying: boolean;
  ScriptsFingerprint: string | null;
  NetworkInterfaces: NormalizedNetworkInterface[];

  // Integrated (SDK) client surface.
  Integrated: boolean;
  IntegratedActions: IntegratedAction[];
  IntegratedDegradedReason: string | null;

  // USB devices: raw connected list, critical guards, and the rendered view
  // (connected ∪ missing) produced by _rebuildUSBDeviceView.
  ConnectedUSBDeviceList: USBDevice[];
  USBDeviceList: USBDeviceViewEntry[];
  CriticalUSBDevices: CriticalUSBEntry[];
  CriticalUSBSerials: string[];
  MissingCriticalUSBDevices: USBDeviceViewEntry[];
  // Serial-less critical devices (guarded by name + quantity) and the subset
  // whose connected count currently falls short of the expected quantity.
  CriticalUSBNames: CriticalUSBNameEntry[];
  MissingCriticalUSBNames: USBDeviceViewEntry[];

  // Displays: raw connected list, critical guards, and the rendered view.
  ConnectedDisplayList: ClientDisplay[];
  DisplayList: DisplayViewEntry[];
  CriticalDisplays: CriticalDisplayEntry[];
  CriticalDisplayIDs: string[];
  MissingCriticalDisplays: DisplayViewEntry[];
  MismatchedCriticalDisplays: DisplayViewEntry[];

  // Running applications: critical guards, the raw observed snapshot, and the
  // augmented view (observed ∪ missing-critical) with its change signatures.
  CriticalApplications: CriticalApplicationEntry[];
  CriticalApplicationKeys: string[];
  MissingCriticalApplications: RunningApplicationViewEntry[];
  ObservedRunningApplications: ObservedRunningApplicationsState;
  RunningApplications: RunningApplicationsView;
  RunningApplicationsSignature: string | null;
  ObservedRunningApplicationsSignature: string | null;

  constructor(Data: ClientConstructorInput) {
    this.UUID = Data.UUID;
    this.Nickname = Data.Nickname ? Data.Nickname : Data.Hostname;
    this.Hostname = Data.Hostname || null;
    this.OperatingSystem = Data.OperatingSystem || null;
    this.GroupID = Data.GroupID || null;
    // Weight supports manual ordering within groups; defaults to 100 if unspecified
    this.Weight = typeof Data.Weight === 'number' ? Data.Weight : 100;
    this.MacAddress = Data.MacAddress || null;
    // Populated by the manager's MacAddresses index immediately after
    // construction (the rows live in a second table, so they cannot ride the
    // constructor input) — see applyCriticalState in ClientManager/index.ts.
    this.MacAddresses = Array.isArray(Data.MacAddresses) ? Data.MacAddresses : [];
    this.Version = Data.Version || null;
    this.IP = Data.IP || null;
    this.RunOnLaunchScriptID = Data.RunOnLaunchScriptID || null;
    this.RunOnLaunchDelaySeconds =
      typeof Data.RunOnLaunchDelaySeconds === 'number' ? Data.RunOnLaunchDelaySeconds : null;
    this.Slug = Data.Slug || null;
    // Stored as sqlite 0/1, so coerce rather than trust the raw row value.
    this.Unassigned = !!Data.Unassigned;
    this.Timestamp = Data.Timestamp;

    this.Online = false;
    this.LastSeen = Date.now();
    this.Vitals = {
      CPU: {},
      Ram: {},
      Uptime: {},
    };
    this.ConnectedUSBDeviceList = [];
    this.USBDeviceList = [];
    this.CriticalUSBDevices = [];
    this.CriticalUSBSerials = [];
    this.MissingCriticalUSBDevices = [];
    this.CriticalUSBNames = [];
    this.MissingCriticalUSBNames = [];
    this.CriticalApplications = [];
    this.CriticalApplicationKeys = [];
    this.MissingCriticalApplications = [];
    this.ConnectedDisplayList = [];
    this.DisplayList = [];
    this.CriticalDisplays = [];
    this.CriticalDisplayIDs = [];
    this.MissingCriticalDisplays = [];
    this.MismatchedCriticalDisplays = [];
    this.Degraded = false;
    this.DegradedWarnings = [];
    this.Initialising = false;
    this.OnlineSince = null;
    this.HasUSBTelemetry = false;
    this.HasDisplayTelemetry = false;
    this.HasApplicationTelemetry = false;
    this.NetworkInterfaces = [];
    this.ScriptsFingerprint = null;
    this.Identifying = false;
    this.Integrated = false;
    this.IntegratedActions = [];
    this.IntegratedDegradedReason = null;
    this.ObservedRunningApplications = {
      SampledAt: null,
      TotalCount: 0,
      Truncated: false,
      Items: [],
      Status: {
        State: 'unknown',
        Message: null,
        Platform: null,
      },
    };
    this.RunningApplications = {
      SampledAt: null,
      TotalCount: 0,
      Truncated: false,
      Items: [],
      Status: {
        State: 'unknown',
        Message: null,
        Platform: null,
      },
    };
    this.RunningApplicationsSignature = null;
    this.ObservedRunningApplicationsSignature = null;
  }

  // RAM-only fields and notifications
  SetOnline(Online: boolean) {
    if (this.Online === Online) return;
    this.Online = Online;
    // Going offline retires the evidence: whatever the client last told us
    // about its hardware describes a session that has ended, and the next
    // connection re-reports everything. Holding it would let a client that
    // rebooted with a dongle removed read as healthy until its first report.
    if (Online) {
      this.OnlineSince = Date.now();
    } else {
      this.OnlineSince = null;
      this._clearStartupGraceTimer();
      this.HasUSBTelemetry = false;
      this.HasDisplayTelemetry = false;
      this.HasApplicationTelemetry = false;
    }
    this._refreshClientHealthState();
    Logger.debug(`Client ${this.UUID} Online updated to ${Online}`);
    BroadcastManager.emit('ClientUpdated', this);
    return;
  }
  SetLastSeen(LastSeen: number) {
    if (this.LastSeen === LastSeen) return;
    this.LastSeen = LastSeen;
    return;
  }
  SetIdentifying(Identifying: unknown) {
    const Next = !!Identifying;
    if (this.Identifying === Next) return;
    this.Identifying = Next;
    Logger.debug(`Client ${this.UUID} Identifying updated to ${Next}`);
    BroadcastManager.emit('ClientUpdated', this);
    return;
  }
  SetVitals(Vitals: unknown) {
    const Source = AsRecord(Vitals);
    this.Vitals = {
      CPU: AsRecord(Source.CPU),
      Ram: AsRecord(Source.Ram),
      Uptime: AsRecord(Source.Uptime),
    };
    BroadcastManager.emit('ClientUpdated', this);
  }
  SetIntegratedState(State: unknown, Message: unknown) {
    const Normalized = String(State || '')
      .trim()
      .toUpperCase();
    if (Normalized === 'DEGRADED') {
      const Reason = typeof Message === 'string' && Message.trim() ? Message.trim() : 'Degraded';
      this.IntegratedDegradedReason = Reason.slice(0, 120);
    } else if (Normalized === 'ONLINE') {
      this.IntegratedDegradedReason = null;
    } else {
      return false;
    }
    this._refreshClientHealthState();
    BroadcastManager.emit('ClientUpdated', this);
    return true;
  }
  SetUSBDeviceList(USBDeviceList: unknown) {
    this.ConnectedUSBDeviceList = Array.isArray(USBDeviceList) ? USBDeviceList : [];
    this.HasUSBTelemetry = true;
    this._rebuildUSBDeviceView();
    Logger.debug(`Client ${this.UUID} USB Device List updated`);
    BroadcastManager.emit('ClientUpdated', this);
    return;
  }
  SetCriticalUSBDevices(Devices: unknown) {
    const List: unknown[] = Array.isArray(Devices) ? Devices : [];
    const Normalized: CriticalUSBEntry[] = [];
    const Seen = new Set<string>();
    for (const Raw of List) {
      const Entry = AsRecord(Raw);
      const SerialNumber = normalizeSerialNumber(Entry.SerialNumber);
      if (!SerialNumber || Seen.has(SerialNumber)) continue;
      Seen.add(SerialNumber);
      Normalized.push({
        SerialNumber,
        ManufacturerName: Entry.ManufacturerName ? String(Entry.ManufacturerName) : null,
        ProductName: Entry.ProductName ? String(Entry.ProductName) : null,
        Timestamp: TimestampOrNull(Entry.Timestamp),
      });
    }
    this.CriticalUSBDevices = Normalized;
    this.CriticalUSBSerials = Normalized.map((Entry) => Entry.SerialNumber);
    this._rebuildUSBDeviceView();
    return;
  }
  IsUSBDeviceCritical(SerialNumber: unknown) {
    const Normalized = normalizeSerialNumber(SerialNumber);
    if (!Normalized) return false;
    return this.CriticalUSBSerials.includes(Normalized);
  }
  MarkCriticalUSBDevice(Device: unknown) {
    const D = AsRecord(Device);
    const Normalized = normalizeSerialNumber(D.SerialNumber);
    if (!Normalized) return false;
    const Existing = this.CriticalUSBDevices.find(
      (Entry: CriticalUSBEntry) => Entry.SerialNumber === Normalized
    );
    if (Existing) {
      if (!Existing.ManufacturerName && D.ManufacturerName) {
        Existing.ManufacturerName = String(D.ManufacturerName);
      }
      if (!Existing.ProductName && D.ProductName) {
        Existing.ProductName = String(D.ProductName);
      }
      if (!Existing.Timestamp && D.Timestamp) {
        Existing.Timestamp = TimestampOrNull(D.Timestamp);
      }
      this._rebuildUSBDeviceView();
      return false;
    }

    this.CriticalUSBDevices.push({
      SerialNumber: Normalized,
      ManufacturerName: D.ManufacturerName ? String(D.ManufacturerName) : null,
      ProductName: D.ProductName ? String(D.ProductName) : null,
      Timestamp: TimestampOrNull(D.Timestamp),
    });
    this.CriticalUSBSerials = this.CriticalUSBDevices.map(
      (Entry: CriticalUSBEntry) => Entry.SerialNumber
    );
    this._rebuildUSBDeviceView();
    return true;
  }
  UnmarkCriticalUSBSerial(SerialNumber: unknown) {
    const Normalized = normalizeSerialNumber(SerialNumber);
    if (!Normalized) return false;
    const PrevLength = this.CriticalUSBDevices.length;
    this.CriticalUSBDevices = this.CriticalUSBDevices.filter(
      (Entry: CriticalUSBEntry) => Entry.SerialNumber !== Normalized
    );
    if (this.CriticalUSBDevices.length === PrevLength) return false;
    this.CriticalUSBSerials = this.CriticalUSBDevices.map(
      (Entry: CriticalUSBEntry) => Entry.SerialNumber
    );
    this._rebuildUSBDeviceView();
    return true;
  }
  SetCriticalUSBNames(Devices: unknown) {
    const List: unknown[] = Array.isArray(Devices) ? Devices : [];
    const Normalized: CriticalUSBNameEntry[] = [];
    const Seen = new Set<string>();
    for (const Raw of List) {
      const Entry = AsRecord(Raw);
      const ManufacturerName = Entry.ManufacturerName ? String(Entry.ManufacturerName) : null;
      const ProductName = Entry.ProductName ? String(Entry.ProductName) : null;
      const NameKey = Entry.NameKey
        ? String(Entry.NameKey)
        : normalizeUSBNameKey(ManufacturerName, ProductName);
      if (!NameKey || Seen.has(NameKey)) continue;
      Seen.add(NameKey);
      Normalized.push({
        NameKey,
        ManufacturerName,
        ProductName,
        Quantity: Math.max(1, parseInt(String(Entry.Quantity), 10) || 1),
        Timestamp: TimestampOrNull(Entry.Timestamp),
      });
    }
    this.CriticalUSBNames = Normalized;
    this._rebuildUSBDeviceView();
    return;
  }
  IsUSBNameCritical(NameKey: unknown) {
    const Normalized = typeof NameKey === 'string' ? NameKey.trim().toLowerCase() : '';
    if (!Normalized) return false;
    return this.CriticalUSBNames.some((Entry) => Entry.NameKey === Normalized);
  }
  MarkCriticalUSBName(Device: unknown) {
    const D = AsRecord(Device);
    const ManufacturerName = D.ManufacturerName ? String(D.ManufacturerName) : null;
    const ProductName = D.ProductName ? String(D.ProductName) : null;
    const NameKey = D.NameKey
      ? String(D.NameKey)
      : normalizeUSBNameKey(ManufacturerName, ProductName);
    if (!NameKey) return false;
    const Quantity = Math.max(1, parseInt(String(D.Quantity), 10) || 1);
    const Existing = this.CriticalUSBNames.find((Entry) => Entry.NameKey === NameKey);
    if (Existing) {
      Existing.Quantity = Quantity;
      if (!Existing.ManufacturerName && ManufacturerName)
        Existing.ManufacturerName = ManufacturerName;
      if (!Existing.ProductName && ProductName) Existing.ProductName = ProductName;
      if (!Existing.Timestamp && D.Timestamp) Existing.Timestamp = TimestampOrNull(D.Timestamp);
      this._rebuildUSBDeviceView();
      return false;
    }
    this.CriticalUSBNames.push({
      NameKey,
      ManufacturerName,
      ProductName,
      Quantity,
      Timestamp: TimestampOrNull(D.Timestamp),
    });
    this._rebuildUSBDeviceView();
    return true;
  }
  UnmarkCriticalUSBName(NameKey: unknown) {
    const Normalized = typeof NameKey === 'string' ? NameKey.trim().toLowerCase() : '';
    if (!Normalized) return false;
    const PrevLength = this.CriticalUSBNames.length;
    this.CriticalUSBNames = this.CriticalUSBNames.filter((Entry) => Entry.NameKey !== Normalized);
    if (this.CriticalUSBNames.length === PrevLength) return false;
    this._rebuildUSBDeviceView();
    return true;
  }
  SetDisplayList(DisplayList: unknown) {
    this.ConnectedDisplayList = Array.isArray(DisplayList) ? DisplayList : [];
    this.HasDisplayTelemetry = true;
    this._rebuildDisplayView();
    Logger.debug(`Client ${this.UUID} Display List updated`);
    BroadcastManager.emit('ClientUpdated', this);
    return;
  }

  /**
   * Merge an incremental display change into the connected list.
   *
   * Keyed by DisplayID, which is the client's most durable identifier for a
   * panel (EDID fingerprint where available, falling back through port and
   * attribute composites). A display whose resolution or refresh rate changed
   * keeps its DisplayID only when identified by EDID or port — an
   * attribute-derived id bakes the configuration in, so such a change arrives
   * as a Removed plus an Added, which merges correctly either way.
   */
  ApplyDisplayDelta(Delta: unknown) {
    const D = AsRecord(Delta);
    const current = Array.isArray(this.ConnectedDisplayList) ? this.ConnectedDisplayList : [];
    const byID = new Map<string, ClientDisplay>();
    for (const display of current) {
      const ID = normalizeDisplayID(AsRecord(display).DisplayID);
      if (ID) byID.set(ID, display);
    }

    for (const rawID of Array.isArray(D.Removed) ? D.Removed : []) {
      const ID = normalizeDisplayID(rawID);
      if (ID) byID.delete(ID);
    }
    for (const key of ['Added', 'Changed'] as const) {
      for (const raw of Array.isArray(D[key]) ? (D[key] as unknown[]) : []) {
        const display = raw as ClientDisplay;
        const ID = normalizeDisplayID(AsRecord(display).DisplayID);
        if (ID) byID.set(ID, display);
      }
    }

    this.ConnectedDisplayList = Array.from(byID.values());
    // A delta only ever follows the full list this connection opened with, so
    // by the time one lands the topology has been reported at least once.
    this.HasDisplayTelemetry = true;
    this._rebuildDisplayView();
    Logger.debug(
      `Client ${this.UUID} Display delta applied (${this.ConnectedDisplayList.length} displays)`
    );
    BroadcastManager.emit('ClientUpdated', this);
  }
  SetCriticalDisplays(Displays: unknown) {
    const List: unknown[] = Array.isArray(Displays) ? Displays : [];
    const Normalized: CriticalDisplayEntry[] = [];
    const Seen = new Set<string>();
    for (const Raw of List) {
      const Entry = AsRecord(Raw);
      const DisplayID = normalizeDisplayID(Entry.DisplayID);
      if (!DisplayID || Seen.has(DisplayID)) continue;
      Seen.add(DisplayID);
      Normalized.push({
        DisplayID,
        Label: Entry.Label ? String(Entry.Label) : null,
        Width: ParseIntOrNull(Entry.Width),
        Height: ParseIntOrNull(Entry.Height),
        RefreshRate:
          Entry.RefreshRate != null && Number.isFinite(Number(Entry.RefreshRate))
            ? Math.round(Number(Entry.RefreshRate))
            : null,
        ScaleFactor:
          Entry.ScaleFactor != null && Number.isFinite(Number(Entry.ScaleFactor))
            ? Number(Entry.ScaleFactor)
            : null,
        Timestamp: TimestampOrNull(Entry.Timestamp),
      });
    }
    this.CriticalDisplays = Normalized;
    this.CriticalDisplayIDs = Normalized.map((Entry) => Entry.DisplayID);
    this._rebuildDisplayView();
    return;
  }
  IsDisplayCritical(DisplayID: unknown) {
    const Normalized = normalizeDisplayID(DisplayID);
    if (!Normalized) return false;
    return this.CriticalDisplayIDs.includes(Normalized);
  }
  MarkCriticalDisplay(Display: unknown) {
    const D = AsRecord(Display);
    const DisplayID = normalizeDisplayID(D.DisplayID);
    if (!DisplayID) return false;
    const Existing = this.CriticalDisplays.find(
      (Entry: CriticalDisplayEntry) => Entry.DisplayID === DisplayID
    );
    if (Existing) {
      if (D.Label) Existing.Label = String(D.Label);
      if (D.Width != null) Existing.Width = ParseIntOrNull(D.Width);
      if (D.Height != null) Existing.Height = ParseIntOrNull(D.Height);
      if (D.RefreshRate != null) {
        Existing.RefreshRate = Number.isFinite(Number(D.RefreshRate))
          ? Math.round(Number(D.RefreshRate))
          : null;
      }
      if (D.ScaleFactor != null) {
        Existing.ScaleFactor = Number.isFinite(Number(D.ScaleFactor))
          ? Number(D.ScaleFactor)
          : null;
      }
      if (D.Timestamp) Existing.Timestamp = TimestampOrNull(D.Timestamp);
      this._rebuildDisplayView();
      return false;
    }
    this.CriticalDisplays.push({
      DisplayID,
      Label: D.Label ? String(D.Label) : null,
      Width: ParseIntOrNull(D.Width),
      Height: ParseIntOrNull(D.Height),
      RefreshRate:
        D.RefreshRate != null && Number.isFinite(Number(D.RefreshRate))
          ? Math.round(Number(D.RefreshRate))
          : null,
      ScaleFactor:
        D.ScaleFactor != null && Number.isFinite(Number(D.ScaleFactor))
          ? Number(D.ScaleFactor)
          : null,
      Timestamp: TimestampOrNull(D.Timestamp),
    });
    this.CriticalDisplayIDs = this.CriticalDisplays.map(
      (Entry: CriticalDisplayEntry) => Entry.DisplayID
    );
    this._rebuildDisplayView();
    return true;
  }
  UnmarkCriticalDisplay(DisplayID: unknown) {
    const Normalized = normalizeDisplayID(DisplayID);
    if (!Normalized) return false;
    const PrevLength = this.CriticalDisplays.length;
    this.CriticalDisplays = this.CriticalDisplays.filter(
      (Entry: CriticalDisplayEntry) => Entry.DisplayID !== Normalized
    );
    if (this.CriticalDisplays.length === PrevLength) return false;
    this.CriticalDisplayIDs = this.CriticalDisplays.map(
      (Entry: CriticalDisplayEntry) => Entry.DisplayID
    );
    this._rebuildDisplayView();
    return true;
  }
  SetCriticalApplications(Applications: unknown) {
    const List: unknown[] = Array.isArray(Applications) ? Applications : [];
    const Normalized: CriticalApplicationEntry[] = [];
    const Seen = new Set<string>();
    for (const Raw of List) {
      const Entry = AsRecord(Raw);
      const Name = normalizeApplicationName(Entry.Name);
      const Key = normalizeApplicationKey(Name);
      if (!Name || !Key || Seen.has(Key)) continue;
      Seen.add(Key);
      Normalized.push({
        Name,
        Key,
        Timestamp: TimestampOrNull(Entry.Timestamp),
      });
    }
    this.CriticalApplications = Normalized;
    this.CriticalApplicationKeys = Normalized.map((Entry) => Entry.Key);
    this._rebuildRunningApplicationsView();
    return;
  }
  IsApplicationCritical(Name: unknown) {
    const Key = normalizeApplicationKey(Name);
    if (!Key) return false;
    return this.CriticalApplicationKeys.includes(Key);
  }
  MarkCriticalApplication(Application: unknown) {
    const A = AsRecord(Application);
    const Name = normalizeApplicationName(A.Name);
    const Key = normalizeApplicationKey(Name);
    if (!Name || !Key) return false;
    const Existing = this.CriticalApplications.find(
      (Entry: CriticalApplicationEntry) => Entry.Key === Key
    );
    if (Existing) {
      if (!Existing.Name) Existing.Name = Name;
      if (!Existing.Timestamp && A.Timestamp) {
        Existing.Timestamp = TimestampOrNull(A.Timestamp);
      }
      this._rebuildRunningApplicationsView();
      return false;
    }
    this.CriticalApplications.push({
      Name,
      Key,
      Timestamp: TimestampOrNull(A.Timestamp),
    });
    this.CriticalApplicationKeys = this.CriticalApplications.map(
      (Entry: CriticalApplicationEntry) => Entry.Key
    );
    this._rebuildRunningApplicationsView();
    return true;
  }
  UnmarkCriticalApplication(Name: unknown) {
    const Key = normalizeApplicationKey(Name);
    if (!Key) return false;
    const PrevLength = this.CriticalApplications.length;
    this.CriticalApplications = this.CriticalApplications.filter(
      (Entry: CriticalApplicationEntry) => Entry.Key !== Key
    );
    if (this.CriticalApplications.length === PrevLength) return false;
    this.CriticalApplicationKeys = this.CriticalApplications.map(
      (Entry: CriticalApplicationEntry) => Entry.Key
    );
    this._rebuildRunningApplicationsView();
    return true;
  }
  _refreshClientHealthState() {
    // Each domain is only judged once the client has reported it on this
    // connection. Until then its "missing" list is an artefact of having no
    // data rather than a fault — see HasUSBTelemetry above.
    const MissingUSBCount = this.HasUSBTelemetry
      ? (Array.isArray(this.MissingCriticalUSBDevices)
          ? this.MissingCriticalUSBDevices.length
          : 0) +
        (Array.isArray(this.MissingCriticalUSBNames) ? this.MissingCriticalUSBNames.length : 0)
      : 0;
    const ProcessStatusState = String(
      this.RunningApplications &&
        this.RunningApplications.Status &&
        this.RunningApplications.Status.State
        ? this.RunningApplications.Status.State
        : 'unknown'
    ).toLowerCase();
    const CanEvaluateCriticalApplications = ProcessStatusState === 'ok';
    const MissingApplicationCount =
      CanEvaluateCriticalApplications && Array.isArray(this.MissingCriticalApplications)
        ? this.MissingCriticalApplications.length
        : 0;
    const Warnings: string[] = [];
    if (MissingApplicationCount > 0) Warnings.push('Critical Application Issue');
    if (MissingUSBCount > 0) Warnings.push('Missing USB Device');
    const MissingDisplayCount =
      this.HasDisplayTelemetry && Array.isArray(this.MissingCriticalDisplays)
        ? this.MissingCriticalDisplays.length
        : 0;
    const MismatchedDisplayCount =
      this.HasDisplayTelemetry && Array.isArray(this.MismatchedCriticalDisplays)
        ? this.MismatchedCriticalDisplays.length
        : 0;
    if (MissingDisplayCount > 0) Warnings.push('Missing Display');
    if (MismatchedDisplayCount > 0) Warnings.push('Display Configuration Changed');

    // Everything above is INFERRED: the client reported what it has, and we
    // concluded something expected is absent. That conclusion is sound but
    // premature on a machine that is still booting, so inside the start-up
    // window it is held rather than published (see CLIENT_STARTUP_GRACE_MS).
    //
    // The integrated reason below is not inferred — an SDK client saying "I am
    // degraded, here is why" is a statement of fact from the thing itself, so
    // it is never held and a self-reporting client stays instantly alertable.
    const HoldingStartupWarnings = Warnings.length > 0 && this._isWithinStartupGrace();
    const Published = HoldingStartupWarnings ? [] : [...Warnings];
    if (this.IntegratedDegradedReason) Published.push(this.IntegratedDegradedReason);

    this.Initialising = !!this.Online && HoldingStartupWarnings;
    this.Degraded = !!this.Online && Published.length > 0;
    this.DegradedWarnings = this.Degraded ? Published : [];
    // Arm (or stand down) the timer that publishes whatever is still missing
    // when the window closes.
    this._syncStartupGraceTimer();
  }

  // Whether this connection is still inside its start-up allowance.
  _isWithinStartupGrace(): boolean {
    if (!this.Online || this.OnlineSince == null) return false;
    return Date.now() - this.OnlineSince < CLIENT_STARTUP_GRACE_MS;
  }

  _clearStartupGraceTimer() {
    const Timer = StartupGraceTimers.get(this);
    if (!Timer) return;
    clearTimeout(Timer);
    StartupGraceTimers.delete(this);
  }

  // Keep exactly one timer alive while warnings are being held, firing when the
  // window closes. Re-running the health state then either publishes the fault
  // (and broadcasts it, so the tile and the alert rules both see it) or finds it
  // resolved itself, which is the whole point of waiting.
  _syncStartupGraceTimer() {
    if (!this.Initialising) {
      this._clearStartupGraceTimer();
      return;
    }
    if (StartupGraceTimers.has(this)) return;
    const Remaining = Math.max(
      0,
      CLIENT_STARTUP_GRACE_MS - (Date.now() - (this.OnlineSince ?? Date.now()))
    );
    const Timer = setTimeout(() => {
      StartupGraceTimers.delete(this);
      const WasDegraded = this.Degraded;
      const WasInitialising = this.Initialising;
      this._refreshClientHealthState();
      // Only speak up if the verdict actually moved: this timer can outlive a
      // client dropped from the cache, and a redundant broadcast would re-render
      // every tile for nothing.
      if (this.Degraded !== WasDegraded || this.Initialising !== WasInitialising) {
        BroadcastManager.emit('ClientUpdated', this);
      }
    }, Remaining);
    if (typeof Timer.unref === 'function') Timer.unref();
    StartupGraceTimers.set(this, Timer);
  }
  _rebuildUSBDeviceView() {
    const CriticalBySerial = new Map<string, CriticalUSBEntry>(
      (Array.isArray(this.CriticalUSBDevices) ? this.CriticalUSBDevices : [])
        .map((Entry: CriticalUSBEntry) => {
          const SerialNumber = normalizeSerialNumber(Entry && Entry.SerialNumber);
          if (!SerialNumber) return null;
          return [SerialNumber, Entry];
        })
        .filter((Entry): Entry is [string, CriticalUSBEntry] => !!Entry)
    );

    const CriticalByName = new Map<string, CriticalUSBNameEntry>(
      (Array.isArray(this.CriticalUSBNames) ? this.CriticalUSBNames : [])
        .map((Entry: CriticalUSBNameEntry): [string, CriticalUSBNameEntry] | null => {
          if (!Entry || !Entry.NameKey) return null;
          return [Entry.NameKey, Entry];
        })
        .filter((Entry): Entry is [string, CriticalUSBNameEntry] => !!Entry)
    );

    // Count connected devices per name key (serial-less guarding matches by
    // name, so every connected device of a name contributes to its count).
    const ConnectedCountByName = new Map<string, number>();
    for (const Device of Array.isArray(this.ConnectedUSBDeviceList)
      ? this.ConnectedUSBDeviceList
      : []) {
      const NameKey = normalizeUSBNameKey(
        Device && Device.ManufacturerName,
        Device && Device.ProductName
      );
      ConnectedCountByName.set(NameKey, (ConnectedCountByName.get(NameKey) || 0) + 1);
    }

    const Connected: USBDeviceViewEntry[] = (
      Array.isArray(this.ConnectedUSBDeviceList) ? this.ConnectedUSBDeviceList : []
    ).map((Device) => {
      const SerialNumber = normalizeSerialNumber(Device && Device.SerialNumber);
      const CriticalEntry = SerialNumber ? CriticalBySerial.get(SerialNumber) : null;
      const NameKey = normalizeUSBNameKey(
        Device && Device.ManufacturerName,
        Device && Device.ProductName
      );
      // Name-based guarding only applies to devices without a serial (those are
      // the ones the serial-based path cannot track).
      const NameCriticalEntry = !SerialNumber ? CriticalByName.get(NameKey) || null : null;
      const NameConnectedCount = NameCriticalEntry
        ? ConnectedCountByName.get(NameKey) || 0
        : undefined;
      return {
        ...(Device || {}),
        SerialNumber: Device && Device.SerialNumber ? String(Device.SerialNumber) : null,
        IsConnected: true,
        IsCritical: !!CriticalEntry || !!NameCriticalEntry,
        IsCriticalByName: !!NameCriticalEntry,
        NameKey,
        Quantity: NameCriticalEntry ? NameCriticalEntry.Quantity : undefined,
        ConnectedCount: NameConnectedCount,
        Shortfall: NameCriticalEntry
          ? (NameConnectedCount as number) < NameCriticalEntry.Quantity
          : undefined,
        Missing: false,
        ManufacturerName:
          (Device && Device.ManufacturerName) ||
          (CriticalEntry && CriticalEntry.ManufacturerName) ||
          null,
        ProductName:
          (Device && Device.ProductName) || (CriticalEntry && CriticalEntry.ProductName) || null,
      };
    });

    const ConnectedSerials = new Set(
      Connected.map((Device) => normalizeSerialNumber(Device && Device.SerialNumber)).filter(
        Boolean
      )
    );

    const Missing: USBDeviceViewEntry[] = [];
    for (const Entry of this.CriticalUSBDevices) {
      if (!Entry || !Entry.SerialNumber) continue;
      if (ConnectedSerials.has(Entry.SerialNumber)) continue;
      Missing.push({
        ManufacturerName: Entry.ManufacturerName,
        ProductName: Entry.ProductName,
        SerialNumber: Entry.SerialNumber,
        IsConnected: false,
        IsCritical: true,
        Missing: true,
      });
    }

    // Name-based shortfalls: a serial-less critical device is degraded when
    // fewer than its expected Quantity are connected. `MissingNames` records
    // every shortfall (drives the degraded state); `MissingNameCards` are only
    // the fully-absent ones (0 connected) that need their own list card —
    // partially-connected names are already represented by their connected
    // cards, which carry the Shortfall flag.
    const MissingNames: USBDeviceViewEntry[] = [];
    const MissingNameCards: USBDeviceViewEntry[] = [];
    for (const Entry of Array.isArray(this.CriticalUSBNames) ? this.CriticalUSBNames : []) {
      if (!Entry || !Entry.NameKey) continue;
      const ConnectedCount = ConnectedCountByName.get(Entry.NameKey) || 0;
      if (ConnectedCount >= Entry.Quantity) continue;
      const Record: USBDeviceViewEntry = {
        ManufacturerName: Entry.ManufacturerName,
        ProductName: Entry.ProductName,
        SerialNumber: null,
        NameKey: Entry.NameKey,
        Quantity: Entry.Quantity,
        ConnectedCount,
        IsConnected: false,
        IsCritical: true,
        IsCriticalByName: true,
        Shortfall: true,
        Missing: true,
      };
      MissingNames.push(Record);
      if (ConnectedCount === 0) MissingNameCards.push(Record);
    }

    this.MissingCriticalUSBDevices = Missing;
    this.MissingCriticalUSBNames = MissingNames;
    this.USBDeviceList = Connected.concat(Missing).concat(MissingNameCards);
    this._refreshClientHealthState();
  }
  _rebuildDisplayView() {
    const CriticalByID = new Map<string, CriticalDisplayEntry>(
      (Array.isArray(this.CriticalDisplays) ? this.CriticalDisplays : [])
        .map((Entry: CriticalDisplayEntry) => {
          const DisplayID = normalizeDisplayID(Entry && Entry.DisplayID);
          if (!DisplayID) return null;
          return [DisplayID, Entry];
        })
        .filter((Entry): Entry is [string, CriticalDisplayEntry] => !!Entry)
    );

    const Connected: DisplayViewEntry[] = (
      Array.isArray(this.ConnectedDisplayList) ? this.ConnectedDisplayList : []
    ).map((Display) => {
      const DisplayID = normalizeDisplayID(Display && Display.DisplayID);
      const CriticalEntry = DisplayID ? CriticalByID.get(DisplayID) : null;
      const CurrentSignature = buildDisplaySignature(Display);
      const ExpectedSignature = CriticalEntry ? buildDisplaySignature(CriticalEntry) : null;
      const Mismatch = !!CriticalEntry && ExpectedSignature !== CurrentSignature;
      return {
        ...(Display || {}),
        DisplayID,
        IsConnected: true,
        IsCritical: !!CriticalEntry,
        Missing: false,
        Mismatch,
        CurrentSignature,
        ExpectedSignature,
        Label: (Display && Display.Label) || (CriticalEntry && CriticalEntry.Label) || null,
      };
    });

    const ConnectedIDs = new Set(
      Connected.map((Display) => normalizeDisplayID(Display && Display.DisplayID)).filter(Boolean)
    );

    const Missing: DisplayViewEntry[] = [];
    for (const Entry of this.CriticalDisplays) {
      if (!Entry || !Entry.DisplayID) continue;
      if (ConnectedIDs.has(normalizeDisplayID(Entry.DisplayID))) continue;
      Missing.push({
        DisplayID: Entry.DisplayID,
        Label: Entry.Label || null,
        Width: Entry.Width || null,
        Height: Entry.Height || null,
        RefreshRate: Entry.RefreshRate || null,
        ScaleFactor: Entry.ScaleFactor || null,
        IsConnected: false,
        IsCritical: true,
        Missing: true,
        Mismatch: false,
        CurrentSignature: null,
        ExpectedSignature: buildDisplaySignature(Entry),
      });
    }

    this.MissingCriticalDisplays = Missing;
    this.MismatchedCriticalDisplays = Connected.filter((Display) => Display.Mismatch);
    this.DisplayList = Connected.concat(Missing);
    this._refreshClientHealthState();
  }
  _rebuildRunningApplicationsView() {
    const Observed = Array.isArray(this.ObservedRunningApplications?.Items)
      ? this.ObservedRunningApplications.Items
      : [];
    const CriticalByKey = new Map<string, CriticalApplicationEntry>(
      (Array.isArray(this.CriticalApplications) ? this.CriticalApplications : [])
        .map((Entry: CriticalApplicationEntry) => {
          if (!Entry || !Entry.Key) return null;
          return [Entry.Key, Entry] as [string, CriticalApplicationEntry];
        })
        .filter((Entry): Entry is [string, CriticalApplicationEntry] => !!Entry)
    );

    const Running: RunningApplicationViewEntry[] = Observed.map((Entry) => {
      const Name = normalizeApplicationName(Entry && Entry.Name) || 'Unknown Application';
      const Key = normalizeApplicationKey(Name);
      const CriticalEntry = Key ? CriticalByKey.get(Key) : null;
      return {
        Name,
        Count: Math.max(1, parseInt(String(Entry.Count), 10) || 1),
        Key,
        IsRunning: true,
        IsCritical: !!CriticalEntry,
        Missing: false,
      };
    });

    const RunningKeys = new Set(Running.map((Entry) => Entry.Key).filter(Boolean));
    const Missing: RunningApplicationViewEntry[] = [];
    for (const Entry of this.CriticalApplications) {
      if (!Entry || !Entry.Key) continue;
      if (RunningKeys.has(Entry.Key)) continue;
      Missing.push({
        Name: Entry.Name,
        Count: 0,
        Key: Entry.Key,
        IsRunning: false,
        IsCritical: true,
        Missing: true,
      });
    }

    this.MissingCriticalApplications = Missing;
    this.RunningApplications = {
      SampledAt: this.ObservedRunningApplications?.SampledAt || null,
      TotalCount: this.ObservedRunningApplications?.TotalCount || Running.length,
      Truncated: !!this.ObservedRunningApplications?.Truncated,
      Items: Running.concat(Missing),
      Status: this.ObservedRunningApplications?.Status || {
        State: 'unknown',
        Message: null,
        Platform: null,
      },
    };
    this.RunningApplicationsSignature = `${this.RunningApplications.TotalCount}|${
      this.RunningApplications.Truncated ? '1' : '0'
    }|${this.RunningApplications.Items.map(
      (Entry) => `${Entry.Name}:${Entry.IsRunning ? '1' : '0'}:${Entry.IsCritical ? '1' : '0'}`
    ).join('|')}`;
    this._refreshClientHealthState();
  }
  SetNetworkInterfaces(Interfaces: unknown) {
    try {
      const normalized = normalizeNetworkInterfaces(Interfaces);
      this.NetworkInterfaces = normalized;
      Logger.debug(`Client ${this.UUID} Network Interfaces updated (${normalized.length})`);
      BroadcastManager.emit('ClientUpdated', this);
    } catch (e) {
      Logger.error('Failed to set network interfaces for', this.UUID, e);
    }
  }

  /**
   * Merge an incremental interface change into the stored list.
   *
   * The full list stays the authority — it arrives on connect and on the
   * periodic resync and REPLACES this state — so a delta only has to describe
   * the step between two samples. Anything it gets wrong is corrected within a
   * resync interval rather than persisting.
   */
  ApplyNetworkInterfaceDelta(Delta: unknown) {
    try {
      const D = AsRecord(Delta);
      const byName = new Map<string, NormalizedNetworkInterface>(
        (Array.isArray(this.NetworkInterfaces) ? this.NetworkInterfaces : []).map((iface) => [
          iface.name,
          iface,
        ])
      );

      for (const name of Array.isArray(D.Removed) ? D.Removed : []) {
        if (typeof name === 'string') byName.delete(name);
      }
      // Added and Changed are applied identically: both mean "this is the
      // current state of this interface". Distinguishing them would only matter
      // if we rejected an add for something already present, and re-announcing
      // an interface is not an error worth dropping telemetry over.
      for (const key of ['Added', 'Changed'] as const) {
        for (const iface of normalizeNetworkInterfaces(D[key])) {
          byName.set(iface.name, iface);
        }
      }

      this.NetworkInterfaces = Array.from(byName.values());
      Logger.debug(
        `Client ${this.UUID} Network Interfaces delta applied (${this.NetworkInterfaces.length} interfaces)`
      );
      BroadcastManager.emit('ClientUpdated', this);
    } catch (e) {
      Logger.error('Failed to apply network interface delta for', this.UUID, e);
    }
  }
  SetScriptsFingerprint(ScriptsFingerprint: unknown) {
    const NextValue =
      typeof ScriptsFingerprint === 'string' && ScriptsFingerprint.trim().length > 0
        ? ScriptsFingerprint.trim()
        : null;
    if (this.ScriptsFingerprint === NextValue) return;
    this.ScriptsFingerprint = NextValue;
    BroadcastManager.emit('ClientUpdated', this);
  }
  SetIntegratedActions(Actions: unknown) {
    this.Integrated = true;
    this.IntegratedActions = Array.isArray(Actions) ? Actions : [];
    BroadcastManager.emit('ClientUpdated', this);
  }
  SetRunningApplications(Snapshot: unknown) {
    const S = AsRecord(Snapshot);
    const PreviousItems = Array.isArray(this.ObservedRunningApplications?.Items)
      ? this.ObservedRunningApplications.Items
      : [];
    const PreviousByKey = new Map<string, DedupedRunningApplication>(
      PreviousItems.map((Entry): [string, DedupedRunningApplication] | null => {
        const Name = normalizeApplicationName(Entry && Entry.Name);
        const Key = normalizeApplicationKey(Name);
        if (!Name || !Key) return null;
        return [Key, { Name, Count: Math.max(1, parseInt(String(Entry.Count), 10) || 1) }];
      }).filter((Pair): Pair is [string, DedupedRunningApplication] => Pair !== null)
    );
    const RawItems: unknown[] = Array.isArray(S.Items) ? S.Items : [];
    const RawStatus = AsRecord(S.Status);
    const NextStatus = {
      State:
        typeof RawStatus.State === 'string' && RawStatus.State.trim().length > 0
          ? RawStatus.State.trim().toLowerCase()
          : 'ok',
      Message:
        typeof RawStatus.Message === 'string' && RawStatus.Message.trim().length > 0
          ? RawStatus.Message.trim()
          : null,
      Platform:
        typeof RawStatus.Platform === 'string' && RawStatus.Platform.trim().length > 0
          ? RawStatus.Platform.trim()
          : null,
    };
    const PreviousStatus = this.ObservedRunningApplications?.Status || {
      State: 'unknown',
      Message: null,
      Platform: null,
    };
    const StatusChanged =
      PreviousStatus.State !== NextStatus.State ||
      PreviousStatus.Message !== NextStatus.Message ||
      PreviousStatus.Platform !== NextStatus.Platform;

    // Started/stopped are DIFFS, and a diff is only meaningful against a
    // snapshot we trust. Two cases produce a baseline we do not:
    //
    //   - the first snapshot of a connection, where the stored list is empty
    //     because this server process has never seen the client. Diffing
    //     against it announces every application on the machine as freshly
    //     started, so restarting the server used to fire a start alert for
    //     every application on every client at once;
    //   - a snapshot whose sampler failed. The client reports an EMPTY list
    //     with a non-ok status in that case (macOS automation permission being
    //     the common one at client start-up), and diffing against it announces
    //     every application as stopped when nothing stopped at all.
    //
    // Either way the snapshot is still stored — the UI shows the sampler
    // status, and the critical-application health check already ignores a
    // non-ok state — but no transition is derived from it. The next trusted
    // sample diffs against a trusted baseline and reports real changes.
    const SampleTrusted = NextStatus.State === 'ok';
    const BaselineTrusted = this.HasApplicationTelemetry;
    this.HasApplicationTelemetry = SampleTrusted;

    const Deduped = new Map<string, DedupedRunningApplication>();

    for (const Raw of RawItems) {
      const Entry = AsRecord(Raw);
      const Name = normalizeApplicationName(Entry.Name);
      const Key = normalizeApplicationKey(Name);
      if (!Name || !Key) continue;
      const Count = Math.max(1, parseInt(String(Entry.Count), 10) || 1);
      const Existing = Deduped.get(Key);
      if (Existing) {
        Existing.Count += Count;
        continue;
      }
      Deduped.set(Key, { Name, Count });
    }

    const Items = sortRunningApplications(Array.from(Deduped.values()));
    const TotalCount = Math.max(0, parseInt(String(S.TotalCount), 10) || Items.length);
    const Truncated = !!S.Truncated;
    const SampledAt = Number.isFinite(Number(S.SampledAt)) ? Number(S.SampledAt) : Date.now();
    const Signature = runningApplicationsSignature(TotalCount, Truncated, Items);

    const ShouldSkipItems = !!S.NoChanges;
    if (
      !ShouldSkipItems &&
      this.ObservedRunningApplicationsSignature === Signature &&
      !StatusChanged
    )
      return;

    if (!ShouldSkipItems) {
      this.ObservedRunningApplications = {
        SampledAt,
        TotalCount,
        Truncated,
        Items,
        Status: NextStatus,
      };
      this.ObservedRunningApplicationsSignature = Signature;
    } else {
      this.ObservedRunningApplications = {
        ...this.ObservedRunningApplications,
        SampledAt,
        TotalCount: Math.max(
          0,
          parseInt(String(S.TotalCount), 10) || this.ObservedRunningApplications.TotalCount || 0
        ),
        Truncated:
          typeof S.Truncated === 'boolean'
            ? S.Truncated
            : !!this.ObservedRunningApplications.Truncated,
        Status: NextStatus,
      };
    }

    if (ShouldSkipItems) {
      this._rebuildRunningApplicationsView();
      BroadcastManager.emit('ClientUpdated', this);
      return;
    }

    if (SampleTrusted && BaselineTrusted) {
      const NextKeys = new Set(
        Items.map((Entry) => normalizeApplicationKey(Entry.Name)).filter(Boolean)
      );
      for (const Entry of Items) {
        const Key = normalizeApplicationKey(Entry.Name);
        if (!Key || PreviousByKey.has(Key)) continue;
        BroadcastManager.emit('ApplicationStarted', this, {
          Name: Entry.Name,
          Count: Entry.Count,
        });
      }
      for (const [Key, Entry] of PreviousByKey.entries()) {
        if (NextKeys.has(Key)) continue;
        BroadcastManager.emit('ApplicationStopped', this, {
          Name: Entry.Name,
          Count: Entry.Count,
        });
      }
    }

    this._rebuildRunningApplicationsView();
    BroadcastManager.emit('ClientUpdated', this);
  }
  /**
   * Merge an incremental running-application change into the observed snapshot.
   *
   * The `ApplicationStarted` / `ApplicationStopped` broadcasts this emits are the
   * same ones SetRunningApplications derives by diffing consecutive snapshots,
   * and they drive the alert rules. There is no double-firing risk: once a delta
   * has been applied, the next full snapshot matches the stored state and its
   * own diff finds nothing to report.
   */
  ApplyApplicationDelta(Delta: unknown) {
    const D = AsRecord(Delta);
    const byKey = new Map<string, DedupedRunningApplication>();
    for (const Entry of Array.isArray(this.ObservedRunningApplications?.Items)
      ? this.ObservedRunningApplications.Items
      : []) {
      const Name = normalizeApplicationName(Entry && Entry.Name);
      const Key = normalizeApplicationKey(Name);
      if (!Name || !Key) continue;
      byKey.set(Key, { Name, Count: Math.max(1, parseInt(String(Entry.Count), 10) || 1) });
    }

    const Started: DedupedRunningApplication[] = [];
    const Stopped: DedupedRunningApplication[] = [];

    for (const raw of Array.isArray(D.Stopped) ? D.Stopped : []) {
      // Stopped carries bare names; the started/changed lists carry entries.
      const Name = normalizeApplicationName(typeof raw === 'string' ? raw : AsRecord(raw).Name);
      const Key = normalizeApplicationKey(Name);
      if (!Key) continue;
      const Existing = byKey.get(Key);
      if (!Existing) continue;
      byKey.delete(Key);
      Stopped.push(Existing);
    }

    for (const key of ['Started', 'Changed'] as const) {
      for (const raw of Array.isArray(D[key]) ? (D[key] as unknown[]) : []) {
        const Entry = AsRecord(raw);
        const Name = normalizeApplicationName(Entry.Name);
        const AppKey = normalizeApplicationKey(Name);
        if (!Name || !AppKey) continue;
        const Count = Math.max(1, parseInt(String(Entry.Count), 10) || 1);
        // Only a genuinely new key is a start. A "Changed" entry for something
        // we had not seen still counts as one, which keeps the alert correct
        // when a delta arrives against a stale baseline.
        if (!byKey.has(AppKey)) Started.push({ Name, Count });
        byKey.set(AppKey, { Name, Count });
      }
    }

    const Items = sortRunningApplications(Array.from(byKey.values()));
    const TotalCount = Number.isFinite(Number(D.TotalCount))
      ? Math.max(0, Number(D.TotalCount))
      : Items.length;
    const Truncated = !!D.Truncated;
    const SampledAt = Number.isFinite(Number(D.SampledAt)) ? Number(D.SampledAt) : Date.now();
    const RawStatus = AsRecord(D.Status);
    const Status = {
      State:
        typeof RawStatus.State === 'string' && RawStatus.State.trim().length > 0
          ? RawStatus.State.trim().toLowerCase()
          : this.ObservedRunningApplications?.Status?.State || 'ok',
      Message:
        typeof RawStatus.Message === 'string' && RawStatus.Message.trim().length > 0
          ? RawStatus.Message.trim()
          : null,
      Platform:
        typeof RawStatus.Platform === 'string' && RawStatus.Platform.trim().length > 0
          ? RawStatus.Platform.trim()
          : this.ObservedRunningApplications?.Status?.Platform || null,
    };

    this.ObservedRunningApplications = { SampledAt, TotalCount, Truncated, Items, Status };
    this.ObservedRunningApplicationsSignature = runningApplicationsSignature(
      TotalCount,
      Truncated,
      Items
    );

    // Same rule as the full snapshot: a delta describes a step away from the
    // stored list, so it only carries meaning when that list came from a
    // sample we trust. A client always sends a full snapshot before its first
    // delta, so this only ever suppresses a delta racing a reconnect.
    const BaselineTrusted = this.HasApplicationTelemetry;
    this.HasApplicationTelemetry = Status.State === 'ok';

    if (BaselineTrusted && Status.State === 'ok') {
      for (const Entry of Started) {
        BroadcastManager.emit('ApplicationStarted', this, { Name: Entry.Name, Count: Entry.Count });
      }
      for (const Entry of Stopped) {
        BroadcastManager.emit('ApplicationStopped', this, { Name: Entry.Name, Count: Entry.Count });
      }
    }

    this._rebuildRunningApplicationsView();
    BroadcastManager.emit('ClientUpdated', this);
  }

  async USBDeviceAdded(Device: USBDevice) {
    const AddedSerial = normalizeSerialNumber(Device && Device.SerialNumber);
    const Current = Array.isArray(this.ConnectedUSBDeviceList) ? this.ConnectedUSBDeviceList : [];
    // A serial number identifies one physical device, so re-announcing it
    // replaces the existing entry rather than duplicating it. Without one there
    // is nothing to match on: matching by serial anyway meant every OTHER
    // serial-less device (null === null) was filtered out, so plugging in one
    // unserialised device erased the rest from the list. Nothing distinguishes
    // two identical serial-less devices, so an add is simply an add.
    this.ConnectedUSBDeviceList = AddedSerial
      ? Current.filter(
          (Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) !== AddedSerial
        )
      : Current.slice();
    this.ConnectedUSBDeviceList.push(Device || {});
    this._rebuildUSBDeviceView();
    BroadcastManager.emit('ClientUpdated', this);
    BroadcastManager.emit('USBDeviceAdded', this, Device);
    return;
  }
  async USBDeviceRemoved(Device: USBDevice) {
    const RemovedSerial = normalizeSerialNumber(Device && Device.SerialNumber);
    const Current = Array.isArray(this.ConnectedUSBDeviceList) ? this.ConnectedUSBDeviceList : [];
    if (RemovedSerial) {
      this.ConnectedUSBDeviceList = Current.filter(
        (Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) !== RemovedSerial
      );
    } else {
      // Unplugging one serial-less device used to remove every serial-less
      // device. Drop a single entry matching this device's make/model instead,
      // leaving any identical siblings connected.
      const Index = Current.findIndex(
        (Entry) =>
          !normalizeSerialNumber(Entry && Entry.SerialNumber) &&
          usbDeviceModelKey(Entry) === usbDeviceModelKey(Device)
      );
      this.ConnectedUSBDeviceList =
        Index === -1 ? Current.slice() : Current.slice(0, Index).concat(Current.slice(Index + 1));
    }
    this._rebuildUSBDeviceView();
    BroadcastManager.emit('ClientUpdated', this);
    BroadcastManager.emit('USBDeviceRemoved', this, Device);
    return;
  }

  // Persist one column, translating the DB tuple to a manager Result. A failed
  // write returns Fail so the calling setter can roll back its RAM mutation and
  // surface the failure instead of silently diverging from the row.
  async _persistColumn(
    Column: string,
    Value: unknown,
    Options: PersistOptions = {}
  ): Promise<Result<void>> {
    const [Err] = await ClientsRepo.UpdateColumn(this.UUID, Column, Value, {
      markUnsaved: Options.markUnsaved,
    });
    if (Err) return Fail(String(Err) || `Failed to persist client column ${Column}`);
    return Ok<void>();
  }

  // Persistent fields (DB-backed). Each setter mutates RAM, persists, and on a
  // failed write restores the previous RAM value before returning Fail — so the
  // in-memory entity can never claim a change the row did not accept. A no-op
  // (value unchanged) is reported as success.
  async SetNickname(Nickname: string | null): Promise<Result<void>> {
    if (this.Nickname === Nickname) return Ok<void>();
    const Previous = this.Nickname;
    this.Nickname = Nickname;
    const [Err] = await this._persistColumn('Nickname', Nickname);
    if (Err) {
      this.Nickname = Previous;
      Logger.error('Failed to update client nickname');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} nickname updated to ${Nickname}`);
    return Ok<void>();
  }
  async SetGroupID(GroupID: number | string | null): Promise<Result<void>> {
    if (GroupID === 'null') GroupID = null;
    if (this.GroupID === GroupID) return Ok<void>();
    const Previous = this.GroupID;
    this.GroupID = GroupID as number | null;
    const [Err] = await this._persistColumn('GroupID', GroupID);
    if (Err) {
      this.GroupID = Previous;
      Logger.error('Failed to update client GroupID');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientListChanged');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} GroupID updated to ${GroupID}`);
    return Ok<void>();
  }
  // Set the client's slug. The caller (ClientManager.Update) is responsible for
  // validating/de-colliding the value against the shared client namespace first;
  // this setter only persists the already-resolved slug.
  async SetSlug(Slug: string): Promise<Result<void>> {
    if (this.Slug === Slug) return Ok<void>();
    const Previous = this.Slug;
    this.Slug = Slug;
    const [Err] = await this._persistColumn('Slug', Slug);
    if (Err) {
      this.Slug = Previous;
      Logger.error('Failed to update client slug');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} slug updated to ${Slug}`);
    return Ok<void>();
  }
  async SetHostname(Hostname: string | null, Options: PersistOptions = {}): Promise<Result<void>> {
    if (this.Hostname === Hostname) return Ok<void>();
    const Previous = this.Hostname;
    this.Hostname = Hostname;
    const [Err] = await this._persistColumn('Hostname', Hostname, Options);
    if (Err) {
      this.Hostname = Previous;
      Logger.error('Failed to update client hostname');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} hostname updated to ${Hostname}`);
    return Ok<void>();
  }
  async SetOperatingSystem(
    OperatingSystem: string | null,
    Options: PersistOptions = {}
  ): Promise<Result<void>> {
    if (this.OperatingSystem === OperatingSystem) return Ok<void>();
    const Previous = this.OperatingSystem;
    this.OperatingSystem = OperatingSystem;
    const [Err] = await this._persistColumn('OperatingSystem', OperatingSystem, Options);
    if (Err) {
      this.OperatingSystem = Previous;
      Logger.error('Failed to update client operating system');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} operating system updated to ${OperatingSystem}`);
    return Ok<void>();
  }
  async SetMacAddress(
    MacAddress: string | null,
    Options: PersistOptions = {}
  ): Promise<Result<void>> {
    if (this.MacAddress === MacAddress) return Ok<void>();
    const Previous = this.MacAddress;
    this.MacAddress = MacAddress;
    const [Err] = await this._persistColumn('MacAddress', MacAddress, Options);
    if (Err) {
      this.MacAddress = Previous;
      Logger.error('Failed to update client mac address');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} mac address updated to ${MacAddress}`);
    return Ok<void>();
  }
  /** Project the client's MAC set onto the instance. Called by the manager's
   *  MacAddresses index (see applyCriticalState); performs no writes — every
   *  mutation goes through Manager.AddClientMacAddress / RemoveClientMacAddress,
   *  which keep the index and the DB in step. */
  SetMacAddresses(MacAddresses: ClientMacAddress[]) {
    this.MacAddresses = (Array.isArray(MacAddresses) ? MacAddresses : [])
      .slice()
      .sort((A, B) => A.FirstSeen - B.FirstSeen || A.MacAddress.localeCompare(B.MacAddress));
  }

  /** Every stored MAC — the full target list for Wake-on-LAN. */
  GetWakeableMacAddresses(): string[] {
    return this.MacAddresses.map((Entry) => Entry.MacAddress).filter(Boolean);
  }

  async SetVersion(Version: string | null, Options: PersistOptions = {}): Promise<Result<void>> {
    if (this.Version === Version) return Ok<void>();
    const Previous = this.Version;
    this.Version = Version;
    const [Err] = await this._persistColumn('Version', Version, Options);
    if (Err) {
      this.Version = Previous;
      Logger.error('Failed to update client version');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} version updated to ${Version}`);
    return Ok<void>();
  }
  // In-memory counterpart to the flag ReplaceClientUUID clears in SQL. Replace
  // persists the change itself, so this only realigns the cached entity.
  SetUnassigned(Unassigned: boolean) {
    this.Unassigned = !!Unassigned;
  }
  async SetWeight(Weight: number): Promise<Result<void>> {
    if (this.Weight === Weight) return Ok<void>();
    const Previous = this.Weight;
    this.Weight = Weight;
    const [Err] = await this._persistColumn('Weight', Weight);
    if (Err) {
      this.Weight = Previous;
      Logger.error('Failed to update client weight');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} weight updated to ${Weight}`);
    return Ok<void>();
  }
  async SetIP(IP: string | null, Options: PersistOptions = {}): Promise<Result<void>> {
    if (this.IP === IP) return Ok<void>();
    const Previous = this.IP;
    this.IP = IP;
    const [Err] = await this._persistColumn('IP', IP, Options);
    if (Err) {
      this.IP = Previous;
      Logger.error('Failed to update client IP');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} IP updated to ${IP}`);
    return Ok<void>();
  }
  async SetRunOnLaunchScriptID(RunOnLaunchScriptID: string | null): Promise<Result<void>> {
    if (RunOnLaunchScriptID === '') RunOnLaunchScriptID = null;
    if (this.RunOnLaunchScriptID === RunOnLaunchScriptID) return Ok<void>();
    const Previous = this.RunOnLaunchScriptID;
    this.RunOnLaunchScriptID = RunOnLaunchScriptID;
    const [Err] = await this._persistColumn('RunOnLaunchScriptID', RunOnLaunchScriptID);
    if (Err) {
      this.RunOnLaunchScriptID = Previous;
      Logger.error('Failed to update client run-on-launch script');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} run-on-launch script updated to ${RunOnLaunchScriptID}`);
    return Ok<void>();
  }
  async SetRunOnLaunchDelaySeconds(RunOnLaunchDelaySeconds: number | null): Promise<Result<void>> {
    if (this.RunOnLaunchDelaySeconds === RunOnLaunchDelaySeconds) return Ok<void>();
    const Previous = this.RunOnLaunchDelaySeconds;
    this.RunOnLaunchDelaySeconds = RunOnLaunchDelaySeconds;
    const [Err] = await this._persistColumn('RunOnLaunchDelaySeconds', RunOnLaunchDelaySeconds);
    if (Err) {
      this.RunOnLaunchDelaySeconds = Previous;
      Logger.error('Failed to update client run-on-launch delay');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} run-on-launch delay updated to ${RunOnLaunchDelaySeconds}`);
    return Ok<void>();
  }
}

export { Client };
