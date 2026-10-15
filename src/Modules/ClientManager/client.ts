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
  normalizeApplicationName,
  normalizeApplicationKey,
  normalizeDisplayID,
} from './normalizers';
import type {
  USBDevice,
  ClientDisplay,
  IntegratedAction,
  AudioDevicesView,
  AudioEndpointView,
  CriticalAudioDevice,
  CriticalDisplay,
  CriticalNetworkInterface,
  CriticalUSBDevice,
  CriticalUSBName,
  USBCapabilities,
  NetworkInterfaceView,
  NetworkStatusView,
  ClientResourceAlarm,
  ClientResourceAlarmKey,
  ClientSystemCheckKey,
  ClientSystemChecks,
  ClientPowerCheck,
  ClientThermalCheck,
  ClientUptimeCheck,
  ClientUsageCheck,
  PowerStatusSnapshot,
  RunningApplicationsCapabilities,
  TemperaturesSnapshot,
} from '@showtrak/protocol';
import {
  EmptyAudioView,
  EmptyObservedAudio,
  buildAudioView,
  diffAudioEndpoints,
  normalizeAudioSnapshot,
  normalizeCriticalAudioEntry,
  normalizeEndpointID,
  type ObservedAudio,
} from './audio';
import { buildDisplayView, normalizeCriticalDisplayEntry, type DisplayViewEntry } from './display';
import {
  buildUSBView,
  normalizeCriticalUSBEntry,
  normalizeCriticalUSBNameEntry,
  type USBDeviceViewEntry,
} from './usb';
import {
  EmptyNetworkStatusView,
  buildNetworkView,
  normalizeCriticalNetworkEntry,
  normalizeInterfaceName,
} from './network';
import {
  APPLICATION_NOT_FOREGROUND_WARNING,
  APPLICATION_NOT_RESPONDING_WARNING,
  ActiveResourceAlarms,
  EmptyResourceAlarmState,
  IsReboot,
  PercentReading,
  StepResourceAlarm,
  UptimeSecondsOf,
  diffDisplays,
  diffNetworkInterfaces,
  normalizePowerStatus,
  normalizeTemperatures,
  trackUSBDevices,
  type ClientHealthEvent,
  type ResourceAlarmState,
  type USBMemory,
} from './health';
import {
  EmptySystemChecks,
  HottestSensor,
  PowerBreaches,
  RESOURCE_ALARM_KEYS,
  SYSTEM_CHECK_WARNINGS,
  SystemCheckField,
  ThermalBreaches,
  UptimeBreach,
  UsageBreach,
  type SystemCheck,
} from './system-checks';
import { TRIGGERS } from '../AlertsManager/triggers';

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
      // Absent stays absent: it means the client cannot say, which is not the
      // same as null (no router), and the critical router check depends on it.
      ...(iface.gateway !== undefined
        ? { gateway: typeof iface.gateway === 'string' && iface.gateway ? iface.gateway : null }
        : {}),
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

// Responsiveness is part of the signature so a hang (or recovery) is stored and
// judged even when the set of applications is unchanged.
function runningApplicationsSignature(
  TotalCount: number,
  Truncated: boolean,
  Items: DedupedRunningApplication[]
): string {
  return `${TotalCount}|${Truncated ? '1' : '0'}|${Items.map(
    (Entry) => `${Entry.Name}:${Entry.Count}${Entry.Responding === false ? ':hung' : ''}`
  ).join('|')}`;
}

// One application's responsiveness across its instances: hung if ANY is hung,
// unknown if any could not be read, absent when the client cannot say at all.
function mergeResponding(
  A: boolean | null | undefined,
  B: boolean | null | undefined
): boolean | null | undefined {
  if (A === false || B === false) return false;
  if (A === null || B === null) return null;
  if (A === true || B === true) return true;
  return undefined;
}

function normalizeResponding(Value: unknown): boolean | null | undefined {
  if (Value === undefined) return undefined;
  return typeof Value === 'boolean' ? Value : null;
}

// What the client says its application collector can report. Null for a client
// that predates the field, which reports neither.
function normalizeApplicationCapabilities(Value: unknown): RunningApplicationsCapabilities | null {
  if (!Value || typeof Value !== 'object') return null;
  const C = Value as Record<string, unknown>;
  return { Responding: C.Responding === true, Foreground: C.Foreground === true };
}

// --- Local domain shapes ---------------------------------------------------
// The persisted "critical" entries we guard, as normalized by the SetCritical*
// methods and mirrored (minus UUID) by the DB rows in ../DB/rows.ts.
interface CriticalApplicationEntry {
  Name: string;
  Key: string;
  Timestamp: number | null;
  // Fault when another application holds the focused window.
  RequireForeground: boolean;
  // Fault when its windows stop answering the operating system.
  RequireResponding: boolean;
}

// The augmented per-entity view entries the _rebuild* methods emit for the
// renderer: connected entities merged with their critical/missing status.
interface RunningApplicationViewEntry {
  Name: string;
  Count: number;
  Key: string | null;
  IsRunning: boolean;
  IsCritical: boolean;
  Missing: boolean;
  // Absent when the client cannot tell (see RunningApplicationItem.Responding).
  Responding?: boolean | null;
  IsForeground: boolean;
  RequireForeground: boolean;
  RequireResponding: boolean;
}

// Vitals as held in RAM: the last heartbeat's payload, or empty objects before
// the first heartbeat arrives. Kept structurally loose (the renderer reads the
// concrete @showtrak/protocol Vitals fields off the serialized projection).
interface ClientVitals {
  CPU: Record<string, unknown>;
  Ram: Record<string, unknown>;
  Uptime: Record<string, unknown>;
}

// A stored running application: the wire item, de-duplicated by name.
interface ObservedRunningApplication {
  Name: string;
  Count: number;
  Responding?: boolean | null;
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
  gateway?: string | null;
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
  Items: ObservedRunningApplication[];
  Status: RunningAppStatus;
  // Absent (undefined) when the client cannot report the foreground at all.
  Foreground?: string | null;
  Capabilities: RunningApplicationsCapabilities | null;
}
interface RunningApplicationsView {
  SampledAt: number | null;
  TotalCount: number;
  Truncated: boolean;
  Items: RunningApplicationViewEntry[];
  Status: RunningAppStatus;
  Foreground?: string | null;
  Capabilities: RunningApplicationsCapabilities | null;
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
  Responding?: boolean | null;
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
  OfflineGraceSeconds?: number | null;
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

// Threshold-alarm bookkeeping and last-seen USB devices, held off the client for
// the same reason: the client is serialized whole, and this is working state,
// not something any surface displays (ResourceAlarms is the displayed result).
const ResourceAlarmStates = new WeakMap<Client, ResourceAlarmState>();
const USBMemories = new WeakMap<Client, USBMemory>();

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
  // Seconds a dropped connection is tolerated before the client reads offline.
  // null inherits CLIENT_OFFLINE_GRACE_SECONDS — see ./offline-grace.
  OfflineGraceSeconds: number | null;
  // Monitored system checks (CPU, memory, uptime, power, thermal); a null
  // check is not monitored. Loaded from CriticalSystemChecks — see
  // ./system-checks for what each condition means.
  SystemChecks: ClientSystemChecks;
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
  // When the operating system last booted, derived from its uptime. Kept while
  // offline so the last known boot stays visible; UptimeSeconds is the latest
  // reading, used to recognise a restart (uptime only ever counts up).
  BootTime: number | null;
  UptimeSeconds: number | null;
  // Battery/mains/sleep and temperatures, as last reported. Null until the
  // client reports them (clients before 3.27.0 never do).
  PowerStatus: PowerStatusSnapshot | null;
  Temperatures: TemperaturesSnapshot | null;
  // System-check conditions currently failing (see ./health). Empty while offline.
  ResourceAlarms: ClientResourceAlarm[];
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
  // Same rule for audio: only a sample whose collector reported `ok` is evidence.
  // An `error` or `unsupported` report says nothing about whether a device is
  // there, so it holds the critical audio checks rather than failing them.
  HasAudioTelemetry: boolean;
  // Network interfaces have no sampler status: a full list reported on this
  // connection is the evidence, and nothing is judged before one arrives.
  HasNetworkTelemetry: boolean;
  NetworkSampledAt: number | null;
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
  CriticalUSBDevices: CriticalUSBDevice[];
  CriticalUSBSerials: string[];
  MissingCriticalUSBDevices: USBDeviceViewEntry[];
  // Serial-less critical devices (guarded by name + quantity) and the subset
  // whose connected count currently falls short of the expected quantity.
  CriticalUSBNames: CriticalUSBName[];
  MissingCriticalUSBNames: USBDeviceViewEntry[];
  // What the connected list says this client can report, and the faults the
  // critical devices' conditions raise.
  USBCapabilities: USBCapabilities | null;
  USBWarnings: string[];

  // Displays: raw connected list, critical guards, and the rendered view.
  ConnectedDisplayList: ClientDisplay[];
  DisplayList: DisplayViewEntry[];
  CriticalDisplays: CriticalDisplay[];
  CriticalDisplayIDs: string[];
  MissingCriticalDisplays: DisplayViewEntry[];
  MismatchedCriticalDisplays: DisplayViewEntry[];
  DisplayWarnings: string[];

  // Audio endpoints: the last report, the critical baselines, and the rendered
  // view (observed ∪ missing-critical) produced by _rebuildAudioView.
  ObservedAudio: ObservedAudio;
  AudioDevices: AudioDevicesView;
  CriticalAudioDevices: CriticalAudioDevice[];
  MissingCriticalAudioDevices: AudioEndpointView[];
  AudioWarnings: string[];

  // Network interfaces: the critical baselines and the judged view of the
  // reported list (NetworkInterfaces) produced by _rebuildNetworkView.
  NetworkStatus: NetworkStatusView;
  CriticalNetworkInterfaces: CriticalNetworkInterface[];
  MissingCriticalNetworkInterfaces: NetworkInterfaceView[];
  NetworkWarnings: string[];

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
    this.OfflineGraceSeconds =
      typeof Data.OfflineGraceSeconds === 'number' ? Data.OfflineGraceSeconds : null;
    this.SystemChecks = EmptySystemChecks();
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
    this.BootTime = null;
    this.UptimeSeconds = null;
    this.PowerStatus = null;
    this.Temperatures = null;
    this.ResourceAlarms = [];
    this.ConnectedUSBDeviceList = [];
    this.USBDeviceList = [];
    this.CriticalUSBDevices = [];
    this.CriticalUSBSerials = [];
    this.MissingCriticalUSBDevices = [];
    this.CriticalUSBNames = [];
    this.MissingCriticalUSBNames = [];
    this.USBCapabilities = null;
    this.USBWarnings = [];
    this.CriticalApplications = [];
    this.CriticalApplicationKeys = [];
    this.MissingCriticalApplications = [];
    this.ConnectedDisplayList = [];
    this.DisplayList = [];
    this.CriticalDisplays = [];
    this.CriticalDisplayIDs = [];
    this.MissingCriticalDisplays = [];
    this.MismatchedCriticalDisplays = [];
    this.DisplayWarnings = [];
    this.Degraded = false;
    this.DegradedWarnings = [];
    this.Initialising = false;
    this.OnlineSince = null;
    this.HasUSBTelemetry = false;
    this.HasDisplayTelemetry = false;
    this.HasApplicationTelemetry = false;
    this.HasAudioTelemetry = false;
    this.ObservedAudio = EmptyObservedAudio();
    this.AudioDevices = EmptyAudioView();
    this.CriticalAudioDevices = [];
    this.MissingCriticalAudioDevices = [];
    this.AudioWarnings = [];
    this.HasNetworkTelemetry = false;
    this.NetworkSampledAt = null;
    this.NetworkStatus = EmptyNetworkStatusView();
    this.CriticalNetworkInterfaces = [];
    this.MissingCriticalNetworkInterfaces = [];
    this.NetworkWarnings = [];
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
      Capabilities: null,
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
      Capabilities: null,
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
      this._rebuildUSBDeviceView(false);
      this.HasDisplayTelemetry = false;
      this._rebuildDisplayView(false);
      this.HasApplicationTelemetry = false;
      this.HasAudioTelemetry = false;
      // Rebuild so a critical endpoint stops reading as "missing" now that the
      // evidence for it has gone; it reads as not reported until the next session.
      this._rebuildAudioView(false);
      this.HasNetworkTelemetry = false;
      this._rebuildNetworkView(false);
      // A threshold says nothing about a machine that is not reporting, so the
      // alarms stand down rather than ride out the outage. The next session
      // re-proves them — a CPU still pegged after a reconnect re-raises once it
      // has been over for the sustain window again.
      this._resetResourceAlarms();
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
    this._observeUptime(UptimeSecondsOf(this.Vitals.Uptime));
    // Judged on every heartbeat: the sustain window of the usage checks is
    // timed by the readings themselves.
    if (this._evaluateSystemChecks()) this._refreshClientHealthState();
    BroadcastManager.emit('ClientUpdated', this);
  }

  /**
   * Step every system-check alarm against the latest readings. Returns true
   * when an alarm was raised or cleared, so the caller knows to re-judge health.
   * Cheap enough to run on every report: each step is a few comparisons.
   */
  _evaluateSystemChecks(): boolean {
    const Checks = this.SystemChecks;
    const Cpu = PercentReading(this.Vitals.CPU.UsagePercentage);
    const Ram = PercentReading(this.Vitals.Ram.UsagePercentage);
    const Power = PowerBreaches(Checks.Power, this.PowerStatus);
    const Thermal = ThermalBreaches(Checks.Thermal, this.Temperatures);
    const Battery = this.PowerStatus ? this.PowerStatus.Battery : null;
    const Hottest = HottestSensor(this.Temperatures);
    const Uptime = this.UptimeSeconds;
    let Changed = 0;
    Changed |= this._stepResourceAlarm(
      'cpu',
      UsageBreach(Checks.Cpu, Cpu),
      Cpu === null ? null : Math.round(Cpu),
      Checks.Cpu ? Checks.Cpu.MaxPercent : null,
      (Checks.Cpu ? Checks.Cpu.SustainSeconds : 0) * 1000
    );
    Changed |= this._stepResourceAlarm(
      'ram',
      UsageBreach(Checks.Ram, Ram),
      Ram === null ? null : Math.round(Ram),
      Checks.Ram ? Checks.Ram.MaxPercent : null,
      (Checks.Ram ? Checks.Ram.SustainSeconds : 0) * 1000
    );
    Changed |= this._stepResourceAlarm(
      'uptime',
      UptimeBreach(Checks.Uptime, Uptime),
      Uptime === null ? null : Math.round((Uptime / 86400) * 10) / 10,
      Checks.Uptime ? Checks.Uptime.MaxDays : null,
      0,
      { BootTime: this.BootTime }
    );
    Changed |= this._stepResourceAlarm('power', Power.power, 'battery', null, 0, {
      Battery,
    });
    Changed |= this._stepResourceAlarm(
      'battery',
      Power.battery,
      Battery ? Battery.Percent : null,
      Checks.Power ? Checks.Power.MinBatteryPercent : null,
      0,
      { Battery }
    );
    Changed |= this._stepResourceAlarm(
      'charging',
      Power.charging,
      Battery ? Battery.Percent : null,
      Checks.Power ? Checks.Power.ChargingBelowPercent : null,
      0,
      { Battery }
    );
    Changed |= this._stepResourceAlarm(
      'temperature',
      Thermal.temperature,
      Hottest ? Hottest.Celsius : null,
      Checks.Thermal ? Checks.Thermal.MaxCelsius : null,
      0,
      { Sensor: Hottest ? Hottest.Name : null }
    );
    Changed |= this._stepResourceAlarm(
      'thermal',
      Thermal.thermal,
      this.Temperatures ? this.Temperatures.ThermalState : null,
      Checks.Thermal ? Checks.Thermal.MaxThermalState : null,
      0
    );
    return Changed !== 0;
  }

  /** Replace every system check (on load). */
  SetSystemChecks(Entries: Array<{ Key: ClientSystemCheckKey; Check: SystemCheck }>) {
    const Next = EmptySystemChecks();
    for (const Entry of Array.isArray(Entries) ? Entries : []) {
      if (Entry && Entry.Key && Entry.Check) {
        (Next as unknown as Record<string, SystemCheck>)[SystemCheckField(Entry.Key)] = Entry.Check;
      }
    }
    this.SystemChecks = Next;
    if (this._evaluateSystemChecks()) this._refreshClientHealthState();
  }

  /** Monitor a system check, or change its conditions. Judged at once against the last readings. */
  MarkSystemCheck(Key: ClientSystemCheckKey, Check: SystemCheck) {
    this.SystemChecks = { ...this.SystemChecks, [SystemCheckField(Key)]: Check };
    if (this._evaluateSystemChecks()) this._refreshClientHealthState();
  }

  /** Stop monitoring a system check; any alarm it held clears at once. */
  UnmarkSystemCheck(Key: ClientSystemCheckKey) {
    this.SystemChecks = { ...this.SystemChecks, [SystemCheckField(Key)]: null };
    if (this._evaluateSystemChecks()) this._refreshClientHealthState();
  }

  /** The monitored check for one key, or null. */
  GetSystemCheck(
    Key: ClientSystemCheckKey
  ): ClientUsageCheck | ClientUptimeCheck | ClientPowerCheck | ClientThermalCheck | null {
    return this.SystemChecks[SystemCheckField(Key)];
  }

  // Track boot time from uptime, and announce a restart: uptime only ever
  // counts up, so a reading well below the last one is a fresh boot. The first
  // reading this server sees is a baseline, not a reboot — and because this
  // object outlives the connection, the comparison spans the outage a reboot
  // causes, which is exactly the window it has to see across.
  _observeUptime(UptimeSeconds: number | null) {
    if (UptimeSeconds === null) return;
    const Previous = this.UptimeSeconds;
    const PreviousBoot = this.BootTime;
    this.UptimeSeconds = UptimeSeconds;
    const Boot = Date.now() - UptimeSeconds * 1000;
    // Round to the minute so a boot time derived a second apart each heartbeat
    // reads (and serializes) as the same instant.
    this.BootTime = Math.round(Boot / 60000) * 60000;
    if (!IsReboot(Previous, UptimeSeconds)) return;
    this._emitHealthEvent({
      TriggerTypes: [TRIGGERS.CLIENT_REBOOTED],
      Severity: 'warning',
      Details: {
        BootTime: this.BootTime,
        PreviousBootTime: PreviousBoot,
        PreviousUptimeSeconds: Previous,
        UptimeSeconds,
      },
    });
  }

  // Advance one threshold alarm and announce a change. Returns 1 when the
  // alarm was raised or cleared (so the caller knows to re-judge health), else 0.
  _stepResourceAlarm(
    Key: ClientResourceAlarmKey,
    Breaching: boolean | null,
    Value: number | string | null,
    Threshold: number | string | null,
    SustainMs: number,
    Extra: Record<string, unknown> = {}
  ): number {
    let State = ResourceAlarmStates.get(this);
    if (!State) {
      State = EmptyResourceAlarmState();
      ResourceAlarmStates.set(this, State);
    }
    // Judged only while connected: an offline machine has no readings.
    const Effective = this.Online ? Breaching : null;
    const Outcome = StepResourceAlarm(
      State[Key],
      Key,
      Effective,
      Value,
      Threshold,
      SustainMs,
      Date.now()
    );
    this.ResourceAlarms = ActiveResourceAlarms(State);
    if (!Outcome) return 0;
    const Trigger = {
      cpu: TRIGGERS.CPU_USAGE_HIGH,
      ram: TRIGGERS.RAM_USAGE_HIGH,
      uptime: TRIGGERS.UPTIME_HIGH,
      power: TRIGGERS.CRITICAL_POWER_ON_BATTERY,
      battery: TRIGGERS.BATTERY_LOW,
      charging: TRIGGERS.BATTERY_NOT_CHARGING,
      temperature: TRIGGERS.TEMPERATURE_HIGH,
      thermal: TRIGGERS.THERMAL_STATE_HIGH,
    }[Key];
    // Raising alerts; clearing only tells the alert manager the condition has
    // ended (CLIENT_RECOVERED speaks for the client as a whole).
    this._emitHealthEvent({
      TriggerTypes: Outcome === 'raised' ? [Trigger] : [],
      Severity: 'warning',
      Details: { Metric: Key, Value, Threshold, ...Extra },
      Condition: { Key: `resource:${Key}`, Active: Outcome === 'raised' },
    });
    return 1;
  }

  _resetResourceAlarms() {
    const State = ResourceAlarmStates.get(this);
    if (!State) return;
    for (const Key of RESOURCE_ALARM_KEYS) {
      this._stepResourceAlarm(Key, null, null, null, 0);
    }
  }

  _emitHealthEvent(Event: ClientHealthEvent) {
    BroadcastManager.emit('ClientHealthEvent', this, Event);
  }

  /**
   * Store a battery / mains / sleep report and derive what changed.
   *
   * Sleep and wake are read from the client's own timestamps rather than from
   * the moment a report lands: a machine going to sleep may not get its last
   * report out, and the one it sends on waking carries both. The first report
   * this server sees is a baseline — an old resume is not news.
   */
  SetPowerStatus(Snapshot: unknown) {
    const Previous = this.PowerStatus;
    const Next = normalizePowerStatus(Snapshot);
    this.PowerStatus = Next;

    if (Previous) {
      const Suspended =
        Next.LastSuspendAt !== null && Next.LastSuspendAt !== Previous.LastSuspendAt;
      const Resumed = Next.LastResumeAt !== null && Next.LastResumeAt !== Previous.LastResumeAt;
      // Both at once means the "going to sleep" report never made it out, so
      // the wake is the news; announcing the sleep after the fact helps no one.
      if (Suspended && !Resumed) {
        this._emitHealthEvent({
          TriggerTypes: [TRIGGERS.CLIENT_SLEEPING],
          Severity: 'warning',
          Details: { SuspendedAt: Next.LastSuspendAt },
        });
      }
      if (Resumed) {
        this._emitHealthEvent({
          TriggerTypes: [TRIGGERS.CLIENT_RESUMED],
          Severity: 'info',
          Details: {
            SuspendedAt: Next.LastSuspendAt,
            ResumedAt: Next.LastResumeAt,
            AsleepSeconds:
              Next.LastSuspendAt !== null &&
              Next.LastResumeAt !== null &&
              Next.LastResumeAt >= Next.LastSuspendAt
                ? Math.round((Next.LastResumeAt - Next.LastSuspendAt) / 1000)
                : null,
          },
        });
      }
      if (Previous.OnBattery !== null && Next.OnBattery !== null) {
        if (!Previous.OnBattery && Next.OnBattery) {
          this._emitHealthEvent({
            TriggerTypes: [TRIGGERS.POWER_ON_BATTERY],
            Severity: 'warning',
            Details: { Battery: Next.Battery },
          });
        } else if (Previous.OnBattery && !Next.OnBattery) {
          this._emitHealthEvent({
            TriggerTypes: [TRIGGERS.POWER_RESTORED],
            Severity: 'success',
            Details: { Battery: Next.Battery },
          });
        }
      }
    }

    if (this._evaluateSystemChecks()) this._refreshClientHealthState();
    BroadcastManager.emit('ClientUpdated', this);
  }

  /** Store a temperature report and judge the thermal check against it. */
  SetTemperatures(Snapshot: unknown) {
    const Next = normalizeTemperatures(Snapshot);
    this.Temperatures = Next;
    if (this._evaluateSystemChecks()) this._refreshClientHealthState();
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
    const BaselineTrusted = this.HasUSBTelemetry;
    this.ConnectedUSBDeviceList = Array.isArray(USBDeviceList) ? USBDeviceList : [];
    this.HasUSBTelemetry = true;
    this._rebuildUSBDeviceView();
    this._trackUSBDevices(BaselineTrusted);
    Logger.debug(`Client ${this.UUID} USB Device List updated`);
    BroadcastManager.emit('ClientUpdated', this);
    return;
  }
  SetCriticalUSBDevices(Devices: unknown) {
    const Normalized: CriticalUSBDevice[] = [];
    const Seen = new Set<string>();
    for (const Raw of Array.isArray(Devices) ? Devices : []) {
      const Entry = normalizeCriticalUSBEntry(Raw);
      if (!Entry || Seen.has(Entry.SerialNumber)) continue;
      Seen.add(Entry.SerialNumber);
      Normalized.push(Entry);
    }
    this.CriticalUSBDevices = Normalized;
    this._rebuildUSBDeviceView();
  }
  IsUSBDeviceCritical(SerialNumber: unknown) {
    const Normalized = normalizeSerialNumber(SerialNumber);
    if (!Normalized) return false;
    return this.CriticalUSBSerials.includes(Normalized);
  }
  /** Add or replace one serial-keyed critical entry. Returns whether it was new. */
  MarkCriticalUSBDevice(Device: unknown) {
    const Entry = normalizeCriticalUSBEntry(Device);
    if (!Entry) return false;
    const Index = this.CriticalUSBDevices.findIndex((E) => E.SerialNumber === Entry.SerialNumber);
    if (Index === -1) this.CriticalUSBDevices.push(Entry);
    else this.CriticalUSBDevices[Index] = Entry;
    this._rebuildUSBDeviceView();
    return Index === -1;
  }
  UnmarkCriticalUSBSerial(SerialNumber: unknown) {
    const Normalized = normalizeSerialNumber(SerialNumber);
    if (!Normalized) return false;
    const PrevLength = this.CriticalUSBDevices.length;
    this.CriticalUSBDevices = this.CriticalUSBDevices.filter(
      (Entry) => Entry.SerialNumber !== Normalized
    );
    if (this.CriticalUSBDevices.length === PrevLength) return false;
    this._rebuildUSBDeviceView();
    return true;
  }
  SetCriticalUSBNames(Devices: unknown) {
    const Normalized: CriticalUSBName[] = [];
    const Seen = new Set<string>();
    for (const Raw of Array.isArray(Devices) ? Devices : []) {
      const Entry = normalizeCriticalUSBNameEntry(Raw);
      if (!Entry || Seen.has(Entry.NameKey)) continue;
      Seen.add(Entry.NameKey);
      Normalized.push(Entry);
    }
    this.CriticalUSBNames = Normalized;
    this._rebuildUSBDeviceView();
  }
  IsUSBNameCritical(NameKey: unknown) {
    const Normalized = typeof NameKey === 'string' ? NameKey.trim().toLowerCase() : '';
    if (!Normalized) return false;
    return this.CriticalUSBNames.some((Entry) => Entry.NameKey === Normalized);
  }
  /** Add or replace one name-keyed critical entry. Returns whether it was new. */
  MarkCriticalUSBName(Device: unknown) {
    const Entry = normalizeCriticalUSBNameEntry(Device);
    if (!Entry) return false;
    const Index = this.CriticalUSBNames.findIndex((E) => E.NameKey === Entry.NameKey);
    if (Index === -1) this.CriticalUSBNames.push(Entry);
    else this.CriticalUSBNames[Index] = Entry;
    this._rebuildUSBDeviceView();
    return Index === -1;
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
    const Previous = this.ConnectedDisplayList;
    const PreviousView = this.DisplayList;
    const BaselineTrusted = this.HasDisplayTelemetry;
    this.ConnectedDisplayList = Array.isArray(DisplayList) ? DisplayList : [];
    this.HasDisplayTelemetry = true;
    this._rebuildDisplayView();
    if (BaselineTrusted) this._emitDisplayTransitions(Previous, PreviousView);
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
    const PreviousView = this.DisplayList;
    const BaselineTrusted = this.HasDisplayTelemetry;
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
    if (BaselineTrusted) this._emitDisplayTransitions(current, PreviousView);
    Logger.debug(
      `Client ${this.UUID} Display delta applied (${this.ConnectedDisplayList.length} displays)`
    );
    BroadcastManager.emit('ClientUpdated', this);
  }
  // Displays that appeared, went or changed between two trusted lists. Whether
  // one is critical is read from the view it was judged in: before the change
  // for one that went, after it for one that arrived or changed.
  _emitDisplayTransitions(Previous: ClientDisplay[], PreviousView: DisplayViewEntry[]) {
    const Transitions = diffDisplays(Previous, this.ConnectedDisplayList);
    const CriticalIn = (View: DisplayViewEntry[], DisplayID: unknown) => {
      const ID = normalizeDisplayID(DisplayID);
      return !!ID && View.some((Entry) => Entry.IsCritical && Entry.DisplayID === ID);
    };
    const Describe = (Display: ClientDisplay) => ({
      DisplayID: Display.DisplayID,
      Label: Display.Label ?? null,
      ScreenNumber: Display.ScreenNumber ?? null,
      Width: Display.Width,
      Height: Display.Height,
      RefreshRate: Display.RefreshRate ?? null,
      ScaleFactor: Display.ScaleFactor,
      Rotation: Display.Rotation,
      Primary: !!Display.Primary,
    });
    for (const Display of Transitions.Added) {
      const IsCritical = CriticalIn(this.DisplayList, Display.DisplayID);
      this._emitHealthEvent({
        TriggerTypes: IsCritical
          ? [TRIGGERS.DISPLAY_CONNECTED, TRIGGERS.CRITICAL_DISPLAY_CONNECTED]
          : [TRIGGERS.DISPLAY_CONNECTED],
        Severity: 'info',
        Details: { Display: Describe(Display), IsCritical },
      });
    }
    for (const Display of Transitions.Removed) {
      const IsCritical = CriticalIn(PreviousView, Display.DisplayID);
      this._emitHealthEvent({
        TriggerTypes: IsCritical
          ? [TRIGGERS.DISPLAY_DISCONNECTED, TRIGGERS.CRITICAL_DISPLAY_DISCONNECTED]
          : [TRIGGERS.DISPLAY_DISCONNECTED],
        Severity: 'warning',
        Details: { Display: Describe(Display), IsCritical },
      });
    }
    for (const Change of Transitions.Changed) {
      this._emitHealthEvent({
        TriggerTypes: [TRIGGERS.DISPLAY_CONFIGURATION_CHANGED],
        Severity: 'warning',
        Details: {
          Display: Describe(Change.Display),
          Previous: Describe(Change.Previous),
          IsCritical: CriticalIn(this.DisplayList, Change.Display.DisplayID),
        },
      });
    }
  }
  SetCriticalDisplays(Displays: unknown) {
    const Normalized: CriticalDisplay[] = [];
    const Seen = new Set<string>();
    for (const Raw of Array.isArray(Displays) ? Displays : []) {
      const Entry = normalizeCriticalDisplayEntry(Raw);
      if (!Entry || Seen.has(Entry.DisplayID)) continue;
      Seen.add(Entry.DisplayID);
      Normalized.push(Entry);
    }
    this.CriticalDisplays = Normalized;
    this._rebuildDisplayView();
  }
  IsDisplayCritical(DisplayID: unknown) {
    const Normalized = normalizeDisplayID(DisplayID);
    if (!Normalized) return false;
    return this.CriticalDisplayIDs.includes(Normalized);
  }
  /**
   * The critical entry a display id refers to, and the reported display it is
   * matched to. The id may be the entry's own or that of the display it matched
   * under another tier of identity; either finds the same pair.
   */
  FindCriticalDisplay(DisplayID: unknown): {
    Critical: CriticalDisplay | null;
    Live: ClientDisplay | null;
  } {
    const Normalized = normalizeDisplayID(DisplayID);
    if (!Normalized) return { Critical: null, Live: null };
    const Entry =
      this.DisplayList.find((View) => View.Critical?.DisplayID === Normalized) ||
      this.DisplayList.find((View) => View.IsConnected && View.DisplayID === Normalized) ||
      null;
    const Live =
      Entry && Entry.IsConnected
        ? this.ConnectedDisplayList.find(
            (Display) => normalizeDisplayID(Display && Display.DisplayID) === Entry.DisplayID
          ) || null
        : null;
    return { Critical: Entry?.Critical ?? null, Live };
  }
  /** Add or replace one critical entry. Returns whether it was new. */
  MarkCriticalDisplay(Display: unknown) {
    const Entry = normalizeCriticalDisplayEntry(Display);
    if (!Entry) return false;
    const Index = this.CriticalDisplays.findIndex((E) => E.DisplayID === Entry.DisplayID);
    if (Index === -1) this.CriticalDisplays.push(Entry);
    else this.CriticalDisplays[Index] = Entry;
    this._rebuildDisplayView();
    return Index === -1;
  }
  UnmarkCriticalDisplay(DisplayID: unknown) {
    const Normalized = normalizeDisplayID(DisplayID);
    if (!Normalized) return false;
    const PrevLength = this.CriticalDisplays.length;
    this.CriticalDisplays = this.CriticalDisplays.filter((Entry) => Entry.DisplayID !== Normalized);
    if (this.CriticalDisplays.length === PrevLength) return false;
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
        RequireForeground: Entry.RequireForeground === true,
        RequireResponding: Entry.RequireResponding !== false,
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
      for (const Condition of ['RequireForeground', 'RequireResponding'] as const) {
        if (typeof A[Condition] === 'boolean') Existing[Condition] = A[Condition] as boolean;
      }
      this._rebuildRunningApplicationsView();
      return false;
    }
    this.CriticalApplications.push({
      Name,
      Key,
      Timestamp: TimestampOrNull(A.Timestamp),
      RequireForeground: A.RequireForeground === true,
      RequireResponding: A.RequireResponding !== false,
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
  // A critical application that must hold the focused window and does not. Only
  // judged when the client can report the foreground and named one: an unknown
  // owner (null — a lock screen, an elevation prompt, or an unreadable window)
  // is not evidence that the show application lost focus.
  _isOutOfForeground(Entry: RunningApplicationViewEntry): boolean {
    if (!Entry.RequireForeground || !Entry.IsRunning) return false;
    const View = this.RunningApplications;
    if (!View.Capabilities || !View.Capabilities.Foreground) return false;
    if (typeof View.Foreground !== 'string' || !View.Foreground) return false;
    return !Entry.IsForeground;
  }

  _refreshClientHealthState() {
    // Each domain is only judged once the client has reported it on this
    // connection. Until then its "missing" list is an artefact of having no
    // data rather than a fault — see HasUSBTelemetry above.
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
    if (MissingApplicationCount > 0) Warnings.push('Monitored Application Issue');
    if (CanEvaluateCriticalApplications) {
      const CriticalRunning = (this.RunningApplications.Items || []).filter(
        (Entry) => Entry.IsCritical && Entry.IsRunning
      );
      if (CriticalRunning.some((Entry) => Entry.RequireResponding && Entry.Responding === false)) {
        Warnings.push(APPLICATION_NOT_RESPONDING_WARNING);
      }
      if (CriticalRunning.some((Entry) => this._isOutOfForeground(Entry))) {
        Warnings.push(APPLICATION_NOT_FOREGROUND_WARNING);
      }
    }
    // Threshold alarms already waited out their sustain window, and are only
    // ever raised while online, so they are published like any other fault.
    for (const Alarm of this.ResourceAlarms) Warnings.push(SYSTEM_CHECK_WARNINGS[Alarm.Key]);
    if (this.HasUSBTelemetry && Array.isArray(this.USBWarnings)) {
      Warnings.push(...this.USBWarnings);
    }
    if (this.HasDisplayTelemetry && Array.isArray(this.DisplayWarnings)) {
      Warnings.push(...this.DisplayWarnings);
    }
    if (this.HasAudioTelemetry && Array.isArray(this.AudioWarnings)) {
      Warnings.push(...this.AudioWarnings);
    }
    if (this.HasNetworkTelemetry && Array.isArray(this.NetworkWarnings)) {
      Warnings.push(...this.NetworkWarnings);
    }

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
  // Moved, re-flashed or failing devices, judged against what was last seen of
  // each (see trackUSBDevices). An untrusted pass only records the baseline.
  _trackUSBDevices(Trusted: boolean) {
    let Memory = USBMemories.get(this);
    if (!Memory) {
      Memory = new Map();
      USBMemories.set(this, Memory);
    }
    const Transitions = trackUSBDevices(Memory, this.ConnectedUSBDeviceList, Trusted);
    for (const Transition of Transitions) {
      const Device = Transition.Device;
      const IsCritical =
        this.IsUSBDeviceCritical(Device.SerialNumber) ||
        this.USBDeviceList.some(
          (Entry) =>
            Entry.IsCritical &&
            Entry.IsConnected &&
            !Entry.SerialNumber &&
            Entry.Location === Device.Location &&
            Entry.ProductName === (Device.ProductName ?? null)
        );
      const Base = { Device, IsCritical };
      if (Transition.Kind === 'moved') {
        this._emitHealthEvent({
          TriggerTypes: [TRIGGERS.USB_DEVICE_MOVED],
          Severity: 'warning',
          Details: { ...Base, PreviousLocation: Transition.Previous?.Location ?? null },
        });
      } else if (Transition.Kind === 'firmware') {
        this._emitHealthEvent({
          TriggerTypes: [TRIGGERS.USB_FIRMWARE_CHANGED],
          Severity: 'warning',
          Details: {
            ...Base,
            PreviousFirmwareVersion: Transition.Previous?.FirmwareVersion ?? null,
          },
        });
      } else {
        this._emitHealthEvent({
          TriggerTypes: [TRIGGERS.USB_DEVICE_ERROR],
          Severity: 'error',
          Details: Base,
        });
      }
    }
  }
  _rebuildUSBDeviceView(Refresh = true) {
    const Result = buildUSBView(
      Array.isArray(this.ConnectedUSBDeviceList) ? this.ConnectedUSBDeviceList : [],
      Array.isArray(this.CriticalUSBDevices) ? this.CriticalUSBDevices : [],
      Array.isArray(this.CriticalUSBNames) ? this.CriticalUSBNames : [],
      this.HasUSBTelemetry
    );
    this.CriticalUSBSerials = this.CriticalUSBDevices.map((Entry) => Entry.SerialNumber);
    this.USBDeviceList = Result.List;
    this.MissingCriticalUSBDevices = Result.MissingDevices;
    this.MissingCriticalUSBNames = Result.MissingNames;
    this.USBWarnings = Result.Warnings;
    this.USBCapabilities = Result.Capabilities;
    if (Refresh) this._refreshClientHealthState();
  }
  _rebuildDisplayView(Refresh = true) {
    const Result = buildDisplayView(
      Array.isArray(this.ConnectedDisplayList) ? this.ConnectedDisplayList : [],
      Array.isArray(this.CriticalDisplays) ? this.CriticalDisplays : [],
      this.HasDisplayTelemetry
    );
    this.CriticalDisplayIDs = this.CriticalDisplays.map((Entry) => Entry.DisplayID);
    this.DisplayList = Result.List;
    this.MissingCriticalDisplays = Result.Missing;
    this.MismatchedCriticalDisplays = Result.Mismatched;
    this.DisplayWarnings = Result.Warnings;
    if (Refresh) this._refreshClientHealthState();
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

    const ForegroundKey =
      typeof this.ObservedRunningApplications?.Foreground === 'string'
        ? normalizeApplicationKey(this.ObservedRunningApplications.Foreground)
        : null;
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
        ...(Entry.Responding !== undefined ? { Responding: Entry.Responding } : {}),
        IsForeground: !!Key && Key === ForegroundKey,
        RequireForeground: !!(CriticalEntry && CriticalEntry.RequireForeground),
        RequireResponding: !!(CriticalEntry && CriticalEntry.RequireResponding),
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
        IsForeground: false,
        RequireForeground: Entry.RequireForeground,
        RequireResponding: Entry.RequireResponding,
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
      ...(this.ObservedRunningApplications?.Foreground !== undefined
        ? { Foreground: this.ObservedRunningApplications.Foreground }
        : {}),
      Capabilities: this.ObservedRunningApplications?.Capabilities ?? null,
    };
    this.RunningApplicationsSignature = `${this.RunningApplications.TotalCount}|${
      this.RunningApplications.Truncated ? '1' : '0'
    }|${this.RunningApplications.Items.map(
      (Entry) =>
        `${Entry.Name}:${Entry.IsRunning ? '1' : '0'}:${Entry.IsCritical ? '1' : '0'}:${
          Entry.Responding === false ? 'h' : ''
        }:${Entry.IsForeground ? 'f' : ''}:${
          Entry.RequireResponding ? 'h' : ''
        }${Entry.RequireForeground ? 'g' : ''}`
    ).join('|')}`;
    this._refreshClientHealthState();
  }
  /**
   * Store an audio report and derive what changed since the last one.
   *
   * Transitions (a device appearing, going, being muted, changing format, a new
   * default) are only derived between two TRUSTED samples, for the reason the
   * application diff gives: the first report of a connection would otherwise
   * announce every device as freshly connected, and a failed sample (an empty
   * list) every device as gone.
   */
  SetAudioDevices(Snapshot: unknown) {
    const Previous = this.ObservedAudio;
    const PreviousOutOfRange = this._audioLevelsOutOfRange();
    const Next = normalizeAudioSnapshot(Snapshot);
    const BaselineTrusted = this.HasAudioTelemetry;
    const SampleTrusted = Next.Status.State === 'ok';
    this.ObservedAudio = Next;
    this.HasAudioTelemetry = SampleTrusted;
    this._rebuildAudioView();
    if (BaselineTrusted && SampleTrusted) {
      for (const Change of diffAudioEndpoints(Previous.Endpoints, Next.Endpoints)) {
        BroadcastManager.emit('AudioDeviceChanged', this, {
          ...Change,
          IsCritical: this.IsAudioDeviceCritical(Change.Endpoint.EndpointID),
        });
      }
      // A critical endpoint's level leaving (or returning to) its allowed range.
      const OutOfRange = this._audioLevelsOutOfRange();
      for (const [EndpointID, Endpoint] of OutOfRange) {
        if (PreviousOutOfRange.has(EndpointID)) continue;
        this._emitHealthEvent({
          TriggerTypes: [TRIGGERS.AUDIO_VOLUME_OUT_OF_RANGE],
          Severity: 'warning',
          Details: { AudioDevice: { ...Endpoint, IsCritical: true } },
          Condition: { Key: `audio-volume:${EndpointID}`, Active: true },
        });
      }
      for (const [EndpointID, Endpoint] of PreviousOutOfRange) {
        if (OutOfRange.has(EndpointID)) continue;
        this._emitHealthEvent({
          TriggerTypes: [],
          Severity: 'success',
          Details: { AudioDevice: { ...Endpoint, IsCritical: true } },
          Condition: { Key: `audio-volume:${EndpointID}`, Active: false },
        });
      }
    }
    BroadcastManager.emit('ClientUpdated', this);
  }

  // Critical endpoints whose level is outside the range they must keep.
  _audioLevelsOutOfRange(): Map<string, AudioEndpointView> {
    const Out = new Map<string, AudioEndpointView>();
    for (const Endpoint of this.AudioDevices.Endpoints || []) {
      const Issues = Array.isArray(Endpoint.Issues) ? Endpoint.Issues : [];
      if (Endpoint.IsCritical && Issues.some((Issue) => Issue && Issue.Kind === 'volume')) {
        Out.set(Endpoint.EndpointID, Endpoint);
      }
    }
    return Out;
  }
  SetCriticalAudioDevices(Devices: unknown) {
    const Normalized: CriticalAudioDevice[] = [];
    const Seen = new Set<string>();
    for (const Raw of Array.isArray(Devices) ? Devices : []) {
      const Entry = normalizeCriticalAudioEntry(Raw);
      if (!Entry || Seen.has(Entry.EndpointID)) continue;
      Seen.add(Entry.EndpointID);
      Normalized.push(Entry);
    }
    this.CriticalAudioDevices = Normalized;
    this._rebuildAudioView();
  }
  IsAudioDeviceCritical(EndpointID: unknown) {
    const Normalized = normalizeEndpointID(EndpointID);
    if (!Normalized) return false;
    return this.CriticalAudioDevices.some((Entry) => Entry.EndpointID === Normalized);
  }
  /** Add or replace one critical entry. Returns whether it was new. */
  MarkCriticalAudioDevice(Device: unknown) {
    const Entry = normalizeCriticalAudioEntry(Device);
    if (!Entry) return false;
    const Index = this.CriticalAudioDevices.findIndex((E) => E.EndpointID === Entry.EndpointID);
    if (Index === -1) this.CriticalAudioDevices.push(Entry);
    else this.CriticalAudioDevices[Index] = Entry;
    this._rebuildAudioView();
    return Index === -1;
  }
  UnmarkCriticalAudioDevice(EndpointID: unknown) {
    const Normalized = normalizeEndpointID(EndpointID);
    if (!Normalized) return false;
    const PrevLength = this.CriticalAudioDevices.length;
    this.CriticalAudioDevices = this.CriticalAudioDevices.filter(
      (Entry) => Entry.EndpointID !== Normalized
    );
    if (this.CriticalAudioDevices.length === PrevLength) return false;
    this._rebuildAudioView();
    return true;
  }
  _rebuildAudioView(Refresh = true) {
    const Result = buildAudioView(
      this.ObservedAudio,
      this.CriticalAudioDevices,
      this.HasAudioTelemetry
    );
    this.AudioDevices = Result.View;
    this.MissingCriticalAudioDevices = Result.Missing;
    this.AudioWarnings = Result.Warnings;
    if (Refresh) this._refreshClientHealthState();
  }
  SetCriticalNetworkInterfaces(Interfaces: unknown) {
    const Normalized: CriticalNetworkInterface[] = [];
    const Seen = new Set<string>();
    for (const Raw of Array.isArray(Interfaces) ? Interfaces : []) {
      const Entry = normalizeCriticalNetworkEntry(Raw);
      if (!Entry || Seen.has(Entry.Name)) continue;
      Seen.add(Entry.Name);
      Normalized.push(Entry);
    }
    this.CriticalNetworkInterfaces = Normalized;
    this._rebuildNetworkView();
  }
  IsNetworkInterfaceCritical(Name: unknown) {
    const Normalized = normalizeInterfaceName(Name);
    if (!Normalized) return false;
    return this.CriticalNetworkInterfaces.some((Entry) => Entry.Name === Normalized);
  }
  /** Add or replace one critical entry. Returns whether it was new. */
  MarkCriticalNetworkInterface(Interface: unknown) {
    const Entry = normalizeCriticalNetworkEntry(Interface);
    if (!Entry) return false;
    const Index = this.CriticalNetworkInterfaces.findIndex((E) => E.Name === Entry.Name);
    if (Index === -1) this.CriticalNetworkInterfaces.push(Entry);
    else this.CriticalNetworkInterfaces[Index] = Entry;
    this._rebuildNetworkView();
    return Index === -1;
  }
  UnmarkCriticalNetworkInterface(Name: unknown) {
    const Normalized = normalizeInterfaceName(Name);
    if (!Normalized) return false;
    const PrevLength = this.CriticalNetworkInterfaces.length;
    this.CriticalNetworkInterfaces = this.CriticalNetworkInterfaces.filter(
      (Entry) => Entry.Name !== Normalized
    );
    if (this.CriticalNetworkInterfaces.length === PrevLength) return false;
    this._rebuildNetworkView();
    return true;
  }
  _rebuildNetworkView(Refresh = true) {
    const Result = buildNetworkView(
      this.NetworkInterfaces,
      this.CriticalNetworkInterfaces,
      this.HasNetworkTelemetry,
      this.NetworkSampledAt
    );
    this.NetworkStatus = Result.View;
    this.MissingCriticalNetworkInterfaces = Result.Missing;
    this.NetworkWarnings = Result.Warnings;
    if (Refresh) this._refreshClientHealthState();
  }
  SetNetworkInterfaces(Interfaces: unknown) {
    try {
      const normalized = normalizeNetworkInterfaces(Interfaces);
      const Previous = this.NetworkInterfaces;
      const BaselineTrusted = this.HasNetworkTelemetry;
      this.NetworkInterfaces = normalized;
      // The full list is the authority, so it is what makes the critical checks
      // trustworthy on this connection; a delta only amends it.
      this.HasNetworkTelemetry = true;
      this.NetworkSampledAt = Date.now();
      this._rebuildNetworkView();
      if (BaselineTrusted) this._emitNetworkTransitions(Previous);
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

      const Previous = this.NetworkInterfaces;
      this.NetworkInterfaces = Array.from(byName.values());
      if (this.HasNetworkTelemetry) this.NetworkSampledAt = Date.now();
      this._rebuildNetworkView();
      if (this.HasNetworkTelemetry) this._emitNetworkTransitions(Previous);
      Logger.debug(
        `Client ${this.UUID} Network Interfaces delta applied (${this.NetworkInterfaces.length} interfaces)`
      );
      BroadcastManager.emit('ClientUpdated', this);
    } catch (e) {
      Logger.error('Failed to apply network interface delta for', this.UUID, e);
    }
  }
  // Interfaces that came up, went down, or changed address or router between
  // two trusted lists (see diffNetworkInterfaces for what counts).
  _emitNetworkTransitions(Previous: NormalizedNetworkInterface[]) {
    const Transitions = diffNetworkInterfaces(
      Previous as Parameters<typeof diffNetworkInterfaces>[0],
      this.NetworkInterfaces as Parameters<typeof diffNetworkInterfaces>[1]
    );
    const Critical = (Name: string) => this.IsNetworkInterfaceCritical(Name);
    for (const Iface of Transitions.Up) {
      this._emitHealthEvent({
        TriggerTypes: [TRIGGERS.NETWORK_INTERFACE_UP],
        Severity: 'info',
        Details: { Interface: Iface, IsCritical: Critical(Iface.Name) },
      });
    }
    for (const Iface of Transitions.Down) {
      const IsCritical = Critical(Iface.Name);
      this._emitHealthEvent({
        TriggerTypes: IsCritical
          ? [TRIGGERS.NETWORK_INTERFACE_DOWN, TRIGGERS.CRITICAL_NETWORK_INTERFACE_DOWN]
          : [TRIGGERS.NETWORK_INTERFACE_DOWN],
        Severity: 'warning',
        Details: { Interface: Iface, IsCritical },
      });
    }
    for (const Change of Transitions.AddressChanged) {
      this._emitHealthEvent({
        TriggerTypes: [TRIGGERS.NETWORK_ADDRESS_CHANGED],
        Severity: 'warning',
        Details: { Interface: Change, IsCritical: Critical(Change.Name) },
      });
    }
    for (const Change of Transitions.GatewayChanged) {
      this._emitHealthEvent({
        TriggerTypes: [TRIGGERS.NETWORK_GATEWAY_CHANGED],
        Severity: 'warning',
        Details: { Interface: Change, IsCritical: Critical(Change.Name) },
      });
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
    const PreviousByKey = this._observedApplicationsByKey();
    const PreviousFaults = this._applicationFaults();
    const PreviousForeground = this.ObservedRunningApplications?.Foreground;
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
    // Absent stays absent (the client cannot say); anything else is a name or null.
    const NextForeground =
      S.Foreground === undefined
        ? undefined
        : typeof S.Foreground === 'string' && S.Foreground.trim()
          ? S.Foreground.trim()
          : null;
    const NextCapabilities = normalizeApplicationCapabilities(S.Capabilities);
    const PreviousCapabilities = this.ObservedRunningApplications?.Capabilities ?? null;
    const FocusChanged =
      NextForeground !== PreviousForeground ||
      JSON.stringify(NextCapabilities) !== JSON.stringify(PreviousCapabilities);

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
      const Responding = normalizeResponding(Entry.Responding);
      const Existing = Deduped.get(Key);
      if (Existing) {
        Existing.Count += Count;
        const Merged = mergeResponding(Existing.Responding, Responding);
        if (Merged === undefined) delete Existing.Responding;
        else Existing.Responding = Merged;
        continue;
      }
      Deduped.set(Key, { Name, Count, ...(Responding !== undefined ? { Responding } : {}) });
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
      !StatusChanged &&
      !FocusChanged
    )
      return;

    const Focus = {
      ...(NextForeground !== undefined ? { Foreground: NextForeground } : {}),
      Capabilities: NextCapabilities,
    };
    if (!ShouldSkipItems) {
      this.ObservedRunningApplications = {
        SampledAt,
        TotalCount,
        Truncated,
        Items,
        Status: NextStatus,
        ...Focus,
      };
      this.ObservedRunningApplicationsSignature = Signature;
    } else {
      const { Foreground: _Stale, ...Kept } = this.ObservedRunningApplications;
      void _Stale;
      this.ObservedRunningApplications = {
        ...Kept,
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
        ...Focus,
      };
    }

    if (ShouldSkipItems) {
      this._rebuildRunningApplicationsView();
      if (SampleTrusted && BaselineTrusted) {
        this._emitApplicationTransitions(PreviousByKey, PreviousFaults, PreviousForeground, false);
      }
      BroadcastManager.emit('ClientUpdated', this);
      return;
    }

    this._rebuildRunningApplicationsView();
    if (SampleTrusted && BaselineTrusted) {
      this._emitApplicationTransitions(PreviousByKey, PreviousFaults, PreviousForeground, true);
    }
    BroadcastManager.emit('ClientUpdated', this);
  }

  // The stored applications keyed by their case-insensitive name.
  _observedApplicationsByKey(): Map<string, DedupedRunningApplication> {
    const ByKey = new Map<string, DedupedRunningApplication>();
    for (const Entry of Array.isArray(this.ObservedRunningApplications?.Items)
      ? this.ObservedRunningApplications.Items
      : []) {
      const Name = normalizeApplicationName(Entry && Entry.Name);
      const Key = normalizeApplicationKey(Name);
      if (!Name || !Key) continue;
      const Responding = normalizeResponding(Entry.Responding);
      ByKey.set(Key, {
        Name,
        Count: Math.max(1, parseInt(String(Entry.Count), 10) || 1),
        ...(Responding !== undefined ? { Responding } : {}),
      });
    }
    return ByKey;
  }

  // The application faults the current view shows: every hung application, and
  // the critical ones that must hold the foreground and do not.
  _applicationFaults(): {
    Hung: Map<string, RunningApplicationViewEntry>;
    Unfocused: Map<string, RunningApplicationViewEntry>;
  } {
    const Hung = new Map<string, RunningApplicationViewEntry>();
    const Unfocused = new Map<string, RunningApplicationViewEntry>();
    for (const Entry of this.RunningApplications.Items || []) {
      if (!Entry.Key || !Entry.IsRunning) continue;
      if (Entry.Responding === false) Hung.set(Entry.Key, Entry);
      if (Entry.IsCritical && this._isOutOfForeground(Entry)) Unfocused.set(Entry.Key, Entry);
    }
    return { Hung, Unfocused };
  }

  /**
   * Announce what changed between two trusted application samples: starts and
   * stops (when the item list was reported), hangs and recoveries, a critical
   * application gaining a second instance, the foreground moving, and a
   * critical application losing (or regaining) the foreground it must hold.
   */
  _emitApplicationTransitions(
    PreviousByKey: Map<string, DedupedRunningApplication>,
    PreviousFaults: ReturnType<Client['_applicationFaults']>,
    PreviousForeground: string | null | undefined,
    ItemsReported: boolean
  ) {
    const Items = this.ObservedRunningApplications.Items;
    if (ItemsReported) {
      const NextKeys = new Set(
        Items.map((Entry) => normalizeApplicationKey(Entry.Name)).filter(Boolean)
      );
      for (const Entry of Items) {
        const Key = normalizeApplicationKey(Entry.Name);
        if (!Key) continue;
        const Before = PreviousByKey.get(Key);
        if (!Before) {
          BroadcastManager.emit('ApplicationStarted', this, {
            Name: Entry.Name,
            Count: Entry.Count,
          });
          continue;
        }
        if (Before.Count <= 1 && Entry.Count > 1 && this.IsApplicationCritical(Entry.Name)) {
          this._emitHealthEvent({
            TriggerTypes: [TRIGGERS.CRITICAL_APPLICATION_MULTIPLE_INSTANCES],
            Severity: 'warning',
            Details: { Application: { Name: Entry.Name, Count: Entry.Count }, IsCritical: true },
          });
        }
      }
      for (const [Key, Entry] of PreviousByKey.entries()) {
        if (NextKeys.has(Key)) continue;
        BroadcastManager.emit('ApplicationStopped', this, {
          Name: Entry.Name,
          Count: Entry.Count,
        });
      }
    }

    const Faults = this._applicationFaults();
    for (const [Key, Entry] of Faults.Hung) {
      if (PreviousFaults.Hung.has(Key)) continue;
      this._emitHealthEvent({
        TriggerTypes:
          Entry.IsCritical && Entry.RequireResponding
            ? [TRIGGERS.APPLICATION_NOT_RESPONDING, TRIGGERS.CRITICAL_APPLICATION_NOT_RESPONDING]
            : [TRIGGERS.APPLICATION_NOT_RESPONDING],
        Severity: 'warning',
        Details: {
          Application: { Name: Entry.Name, Count: Entry.Count },
          IsCritical: Entry.IsCritical,
        },
        Condition: { Key: `app-hung:${Key}`, Active: true },
      });
    }
    for (const [Key, Entry] of PreviousFaults.Hung) {
      if (Faults.Hung.has(Key)) continue;
      // Responding again (rather than gone, or no longer readable) is news.
      const Now = (this.RunningApplications.Items || []).find(
        (Item) => Item.Key === Key && Item.IsRunning
      );
      this._emitHealthEvent({
        TriggerTypes: Now && Now.Responding === true ? [TRIGGERS.APPLICATION_RESPONDING] : [],
        Severity: 'success',
        Details: {
          Application: { Name: Entry.Name, Count: Entry.Count },
          IsCritical: Entry.IsCritical,
        },
        Condition: { Key: `app-hung:${Key}`, Active: false },
      });
    }

    const NextForeground = this.ObservedRunningApplications.Foreground;
    if (
      PreviousForeground !== undefined &&
      NextForeground !== undefined &&
      typeof NextForeground === 'string' &&
      NextForeground !== PreviousForeground
    ) {
      this._emitHealthEvent({
        TriggerTypes: [TRIGGERS.FOREGROUND_APPLICATION_CHANGED],
        Severity: 'info',
        Details: { Application: { Name: NextForeground }, PreviousForeground },
      });
    }
    for (const [Key, Entry] of Faults.Unfocused) {
      if (PreviousFaults.Unfocused.has(Key)) continue;
      this._emitHealthEvent({
        TriggerTypes: [TRIGGERS.CRITICAL_APPLICATION_LOST_FOREGROUND],
        Severity: 'warning',
        Details: {
          Application: { Name: Entry.Name, Count: Entry.Count },
          IsCritical: true,
          Foreground: NextForeground ?? null,
        },
        Condition: { Key: `app-foreground:${Key}`, Active: true },
      });
    }
    for (const [Key, Entry] of PreviousFaults.Unfocused) {
      if (Faults.Unfocused.has(Key)) continue;
      this._emitHealthEvent({
        TriggerTypes: [],
        Severity: 'success',
        Details: { Application: { Name: Entry.Name, Count: Entry.Count }, IsCritical: true },
        Condition: { Key: `app-foreground:${Key}`, Active: false },
      });
    }
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
    const PreviousByKey = this._observedApplicationsByKey();
    const PreviousFaults = this._applicationFaults();
    const PreviousForeground = this.ObservedRunningApplications?.Foreground;
    const byKey = new Map<string, DedupedRunningApplication>(
      Array.from(PreviousByKey.entries()).map(([Key, Entry]) => [Key, { ...Entry }])
    );

    for (const raw of Array.isArray(D.Stopped) ? D.Stopped : []) {
      // Stopped carries bare names; the started/changed lists carry entries.
      const Name = normalizeApplicationName(typeof raw === 'string' ? raw : AsRecord(raw).Name);
      const Key = normalizeApplicationKey(Name);
      if (!Key) continue;
      byKey.delete(Key);
    }

    for (const key of ['Started', 'Changed'] as const) {
      for (const raw of Array.isArray(D[key]) ? (D[key] as unknown[]) : []) {
        const Entry = AsRecord(raw);
        const Name = normalizeApplicationName(Entry.Name);
        const AppKey = normalizeApplicationKey(Name);
        if (!Name || !AppKey) continue;
        const Count = Math.max(1, parseInt(String(Entry.Count), 10) || 1);
        const Responding = normalizeResponding(Entry.Responding);
        // Only a genuinely new key is a start. A "Changed" entry for something
        // we had not seen still counts as one, which keeps the alert correct
        // when a delta arrives against a stale baseline.
        byKey.set(AppKey, { Name, Count, ...(Responding !== undefined ? { Responding } : {}) });
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
    const Foreground =
      D.Foreground === undefined
        ? undefined
        : typeof D.Foreground === 'string' && D.Foreground.trim()
          ? D.Foreground.trim()
          : null;
    const Capabilities =
      D.Capabilities === undefined
        ? (this.ObservedRunningApplications?.Capabilities ?? null)
        : normalizeApplicationCapabilities(D.Capabilities);

    this.ObservedRunningApplications = {
      SampledAt,
      TotalCount,
      Truncated,
      Items,
      Status,
      ...(Foreground !== undefined ? { Foreground } : {}),
      Capabilities,
    };
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

    this._rebuildRunningApplicationsView();
    if (BaselineTrusted && Status.State === 'ok') {
      this._emitApplicationTransitions(PreviousByKey, PreviousFaults, PreviousForeground, true);
    }
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
    this._trackUSBDevices(this.HasUSBTelemetry);
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
    this._trackUSBDevices(this.HasUSBTelemetry);
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
    // An update (or a rollback) the client just came back with. A first version
    // is not a change — nor is replacing the "X.X.X" a freshly adopted client is
    // created with — and neither is a client momentarily reporting none.
    if (Previous && Version && /\d+\.\d+/.test(Previous)) {
      this._emitHealthEvent({
        TriggerTypes: [TRIGGERS.CLIENT_VERSION_CHANGED],
        Severity: 'info',
        Details: { PreviousVersion: Previous, Version },
      });
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
  async SetOfflineGraceSeconds(OfflineGraceSeconds: number | null): Promise<Result<void>> {
    if (this.OfflineGraceSeconds === OfflineGraceSeconds) return Ok<void>();
    const Previous = this.OfflineGraceSeconds;
    this.OfflineGraceSeconds = OfflineGraceSeconds;
    const [Err] = await this._persistColumn('OfflineGraceSeconds', OfflineGraceSeconds);
    if (Err) {
      this.OfflineGraceSeconds = Previous;
      Logger.error('Failed to update client offline grace period');
      return Fail(Err);
    }
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} offline grace period updated to ${OfflineGraceSeconds}`);
    return Ok<void>();
  }
}

export { Client };
