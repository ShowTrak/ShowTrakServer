// Client health: threshold alarms, power, temperatures, and the per-domain
// transitions behind the finer-grained alert triggers. What a monitored system
// check holds a machine to lives in ./system-checks.
//
// Everything here is pure (or keeps its state in objects the Client hands in),
// so the rules can be tested without a socket, a DB or a timer. The Client
// entity owns WHEN these run (only against telemetry it trusts, on the same
// evidence gates as the critical-hardware checks) and turns what they return
// into degraded warnings and `ClientHealthEvent` broadcasts.
import type {
  ClientResourceAlarm,
  ClientResourceAlarmKey,
  CollectorState,
  PowerStatusSnapshot,
  TemperatureSensor,
  TemperatureSensorKind,
  TemperaturesSnapshot,
  ThermalState,
  USBDevice,
} from '@showtrak/protocol';
import type { ValidatedDisplay } from '../SocketValidation';
import { AsRecord, normalizeSerialNumber } from './normalizers';
import { RESOURCE_ALARM_KEYS } from './system-checks';

// --- Health events -------------------------------------------------------------

export type ClientHealthSeverity = 'info' | 'warning' | 'error' | 'success';

/**
 * One thing that happened to a client, as handed to the alert manager.
 *
 * `TriggerTypes` lists every trigger it satisfies (a critical display going
 * away is both DISPLAY_DISCONNECTED and CRITICAL_DISPLAY_DISCONNECTED), so a
 * rule fires once per matching trigger exactly as the USB and audio sets do.
 *
 * `Condition` marks something that stays true for a while (CPU over its
 * threshold) rather than a moment (a reboot). The alert manager holds a
 * condition that was already true at server start instead of announcing it,
 * and needs to hear when it ends; see AlertsManager.HandleClientHealthEvent.
 */
export interface ClientHealthEvent {
  TriggerTypes: string[];
  Severity: ClientHealthSeverity;
  Details: Record<string, unknown>;
  Condition?: { Key: string; Active: boolean };
}

// --- Degraded warnings ---------------------------------------------------------

export const APPLICATION_NOT_RESPONDING_WARNING = 'Application Not Responding';
export const APPLICATION_NOT_FOREGROUND_WARNING = 'Application Not In Foreground';

// --- Threshold alarms ------------------------------------------------------------

// The life of one threshold on one client.
interface AlarmTrack {
  // When the reading first crossed into breach on the current run, or null.
  BreachingSince: number | null;
  // When the reading first came back inside the threshold while the alarm
  // stood, or null.
  ClearingSince: number | null;
  Active: ClientResourceAlarm | null;
}

export type ResourceAlarmState = Record<ClientResourceAlarmKey, AlarmTrack>;

export function EmptyResourceAlarmState(): ResourceAlarmState {
  const State = {} as ResourceAlarmState;
  for (const Key of RESOURCE_ALARM_KEYS) {
    State[Key] = { BreachingSince: null, ClearingSince: null, Active: null };
  }
  return State;
}

/**
 * Advance one alarm by one reading. Returns what changed, if anything.
 *
 * A breach must last `SustainMs` before the alarm is raised, and the reading
 * must stay back inside the threshold as long again before it clears: the
 * same window both ways, so a machine hovering at its limit does not flap.
 * `Breaching` is null when there is nothing to judge (no telemetry, or the
 * condition is not monitored): any standing alarm clears at once and nothing
 * is armed.
 */
export function StepResourceAlarm(
  Track: AlarmTrack,
  Key: ClientResourceAlarmKey,
  Breaching: boolean | null,
  Value: number | string | null,
  Threshold: number | string | null,
  SustainMs: number,
  Now: number
): 'raised' | 'cleared' | null {
  if (Breaching === null) {
    Track.BreachingSince = null;
    Track.ClearingSince = null;
    if (!Track.Active) return null;
    Track.Active = null;
    return 'cleared';
  }
  if (Breaching) {
    Track.ClearingSince = null;
    if (Track.Active) {
      Track.Active.Value = Value;
      Track.Active.Threshold = Threshold;
      return null;
    }
    if (Track.BreachingSince === null) Track.BreachingSince = Now;
    if (Now - Track.BreachingSince < SustainMs) return null;
    Track.Active = { Key, Value, Threshold, Since: Now };
    return 'raised';
  }
  Track.BreachingSince = null;
  if (!Track.Active) return null;
  if (Track.ClearingSince === null) Track.ClearingSince = Now;
  if (Now - Track.ClearingSince < SustainMs) return null;
  Track.ClearingSince = null;
  Track.Active = null;
  return 'cleared';
}

export function ActiveResourceAlarms(State: ResourceAlarmState): ClientResourceAlarm[] {
  return RESOURCE_ALARM_KEYS.map((Key) => State[Key].Active).filter(
    (Alarm): Alarm is ClientResourceAlarm => !!Alarm
  );
}

// --- Readings --------------------------------------------------------------------

/** A usage percentage from a vitals field (CPU sends a number, RAM a string). */
export function PercentReading(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const n = typeof Value === 'number' ? Value : parseFloat(String(Value));
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * Operating-system uptime in seconds from a heartbeat's Uptime vitals.
 * Clients from 3.27.0 send `Seconds`; older ones only the `HH:mm:ss` string,
 * which is parsed so reboot detection and the uptime readout work for them too.
 */
export function UptimeSecondsOf(Uptime: unknown): number | null {
  const U = AsRecord(Uptime);
  const Raw = Number(U.Seconds);
  if (U.Seconds !== undefined && U.Seconds !== null && Number.isFinite(Raw) && Raw >= 0) {
    return Math.floor(Raw);
  }
  const Match =
    typeof U.Formatted === 'string' ? /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(U.Formatted.trim()) : null;
  if (!Match) return null;
  return Number(Match[1]) * 3600 + Number(Match[2]) * 60 + Number(Match[3]);
}

// A machine's uptime only ever counts up. Allowing it to read this much lower
// than last time absorbs a clock that steps backwards between two heartbeats;
// anything more is a fresh boot.
export const REBOOT_UPTIME_SLACK_SECONDS = 60;

/** Whether a fall in reported uptime means the machine restarted. */
export function IsReboot(PreviousUptime: number | null, NextUptime: number | null): boolean {
  if (PreviousUptime === null || NextUptime === null) return false;
  return NextUptime + REBOOT_UPTIME_SLACK_SECONDS < PreviousUptime;
}

// --- Power -------------------------------------------------------------------------

const COLLECTOR_STATES: ReadonlySet<string> = new Set(['unknown', 'ok', 'error', 'unsupported']);

export function CollectorStatusOf(Value: unknown): PowerStatusSnapshot['Status'] {
  const S = AsRecord(Value);
  const State = typeof S.State === 'string' ? S.State.toLowerCase() : 'unknown';
  return {
    State: (COLLECTOR_STATES.has(State) ? State : 'unknown') as CollectorState,
    Message: typeof S.Message === 'string' && S.Message.trim() ? S.Message.trim() : null,
    Platform: typeof S.Platform === 'string' ? S.Platform : '',
    Backend: typeof S.Backend === 'string' && S.Backend.trim() ? S.Backend.trim() : null,
  };
}

function FiniteOrNull(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const n = Number(Value);
  return Number.isFinite(n) ? n : null;
}

function TimestampOf(Value: unknown): number | null {
  const n = FiniteOrNull(Value);
  return n !== null && n > 0 ? n : null;
}

function BooleanOrNull(Value: unknown): boolean | null {
  return typeof Value === 'boolean' ? Value : null;
}

export function normalizePowerStatus(Snapshot: unknown): PowerStatusSnapshot {
  const S = AsRecord(Snapshot);
  const RawBattery = S.Battery && typeof S.Battery === 'object' ? AsRecord(S.Battery) : null;
  const Percent = FiniteOrNull(RawBattery?.Percent);
  const Remaining = FiniteOrNull(RawBattery?.TimeRemainingMinutes);
  return {
    SampledAt: TimestampOf(S.SampledAt) ?? Date.now(),
    Status: CollectorStatusOf(S.Status),
    Battery: RawBattery
      ? {
          Percent: Percent === null ? null : Math.min(100, Math.max(0, Math.round(Percent))),
          Charging: BooleanOrNull(RawBattery.Charging),
          TimeRemainingMinutes: Remaining === null || Remaining < 0 ? null : Math.round(Remaining),
        }
      : null,
    OnBattery: BooleanOrNull(S.OnBattery),
    LastSuspendAt: TimestampOf(S.LastSuspendAt),
    LastResumeAt: TimestampOf(S.LastResumeAt),
  };
}

// --- Temperatures ------------------------------------------------------------------

const SENSOR_KINDS: ReadonlySet<string> = new Set([
  'cpu',
  'gpu',
  'system',
  'storage',
  'battery',
  'other',
]);
const THERMAL_STATES: ReadonlySet<string> = new Set(['nominal', 'fair', 'serious', 'critical']);
const MAX_TEMPERATURE_SENSORS = 64;

export function normalizeTemperatures(Snapshot: unknown): TemperaturesSnapshot {
  const S = AsRecord(Snapshot);
  const Sensors: TemperatureSensor[] = [];
  const Seen = new Set<string>();
  for (const Raw of Array.isArray(S.Sensors) ? S.Sensors : []) {
    const Entry = AsRecord(Raw);
    const Name = typeof Entry.Name === 'string' ? Entry.Name.trim().slice(0, 128) : '';
    const Celsius = FiniteOrNull(Entry.Celsius);
    if (!Name || Celsius === null || Seen.has(Name)) continue;
    Seen.add(Name);
    const Kind =
      typeof Entry.Kind === 'string' && SENSOR_KINDS.has(Entry.Kind) ? Entry.Kind : 'other';
    Sensors.push({
      Name,
      Kind: Kind as TemperatureSensorKind,
      Celsius: Math.round(Celsius * 10) / 10,
    });
    if (Sensors.length >= MAX_TEMPERATURE_SENSORS) break;
  }
  const Thermal = typeof S.ThermalState === 'string' ? S.ThermalState.toLowerCase() : '';
  return {
    SampledAt: TimestampOf(S.SampledAt) ?? Date.now(),
    Status: CollectorStatusOf(S.Status),
    Sensors,
    ThermalState: THERMAL_STATES.has(Thermal) ? (Thermal as ThermalState) : null,
  };
}

// --- Displays ----------------------------------------------------------------------

export interface DisplayTransitions {
  Added: ValidatedDisplay[];
  Removed: ValidatedDisplay[];
  Changed: Array<{ Previous: ValidatedDisplay; Display: ValidatedDisplay }>;
}

function DisplayKey(Display: unknown): string | null {
  const ID = AsRecord(Display).DisplayID;
  return typeof ID === 'string' && ID.trim() ? ID.trim() : null;
}

// What an operator would call "the display changed": its mode, orientation,
// role or place on the desktop. Labels and identity tiers are not configuration.
function DisplayConfiguration(Display: ValidatedDisplay): string {
  const D = AsRecord(Display);
  const Bounds = AsRecord(D.Bounds);
  return [
    D.Width,
    D.Height,
    D.RefreshRate == null ? '' : Math.round(Number(D.RefreshRate)),
    D.ScaleFactor,
    D.Rotation,
    D.Primary ? 1 : 0,
    Bounds.x,
    Bounds.y,
  ].join('|');
}

/** Displays that appeared, went, or changed configuration between two trusted lists. */
export function diffDisplays(
  Previous: ValidatedDisplay[],
  Next: ValidatedDisplay[]
): DisplayTransitions {
  const Before = new Map<string, ValidatedDisplay>();
  for (const Display of Previous) {
    const Key = DisplayKey(Display);
    if (Key) Before.set(Key, Display);
  }
  const Result: DisplayTransitions = { Added: [], Removed: [], Changed: [] };
  const Seen = new Set<string>();
  for (const Display of Next) {
    const Key = DisplayKey(Display);
    if (!Key || Seen.has(Key)) continue;
    Seen.add(Key);
    const Old = Before.get(Key);
    if (!Old) Result.Added.push(Display);
    else if (DisplayConfiguration(Old) !== DisplayConfiguration(Display)) {
      Result.Changed.push({ Previous: Old, Display });
    }
  }
  for (const [Key, Display] of Before) {
    if (!Seen.has(Key)) Result.Removed.push(Display);
  }
  return Result;
}

// --- Network interfaces --------------------------------------------------------------

interface InterfaceLike {
  name: string;
  addresses: Array<{ family?: unknown; address?: unknown; internal?: unknown }>;
  gateway?: string | null;
}

export interface NetworkTransitions {
  Up: Array<{ Name: string; Addresses: string[] }>;
  Down: Array<{ Name: string; Addresses: string[] }>;
  AddressChanged: Array<{ Name: string; Previous: string[]; Addresses: string[] }>;
  GatewayChanged: Array<{ Name: string; Previous: string | null; Gateway: string | null }>;
}

function IsIPv4Family(Family: unknown): boolean {
  return Family === 4 || String(Family).toLowerCase() === 'ipv4';
}

// The external IPv4 addresses on an interface, sorted. An interface with none
// is not on the show network in any sense an operator means, which is what
// keeps the constant churn of IPv6-only adapters (macOS awdl/llw/utun,
// Windows Teredo) out of the up/down alerts.
function ExternalIPv4(Iface: InterfaceLike): string[] {
  return (Array.isArray(Iface.addresses) ? Iface.addresses : [])
    .filter((A) => A && !A.internal && IsIPv4Family(A.family) && typeof A.address === 'string')
    .map((A) => String(A.address))
    .sort();
}

/** Interfaces that came up, went down, or changed address or router between two trusted lists. */
export function diffNetworkInterfaces(
  Previous: InterfaceLike[],
  Next: InterfaceLike[]
): NetworkTransitions {
  const Before = new Map<string, InterfaceLike>();
  for (const Iface of Previous) if (Iface && Iface.name) Before.set(Iface.name, Iface);
  const After = new Map<string, InterfaceLike>();
  for (const Iface of Next) if (Iface && Iface.name) After.set(Iface.name, Iface);

  const Result: NetworkTransitions = { Up: [], Down: [], AddressChanged: [], GatewayChanged: [] };
  for (const [Name, Iface] of After) {
    const Addresses = ExternalIPv4(Iface);
    const Old = Before.get(Name);
    const OldAddresses = Old ? ExternalIPv4(Old) : [];
    if (!OldAddresses.length) {
      if (Addresses.length) Result.Up.push({ Name, Addresses });
      continue;
    }
    if (!Addresses.length) {
      Result.Down.push({ Name, Addresses: OldAddresses });
      continue;
    }
    if (OldAddresses.join(',') !== Addresses.join(',')) {
      Result.AddressChanged.push({ Name, Previous: OldAddresses, Addresses });
    }
    // Absent means the client cannot tell, which is never a change.
    if (Old && Old.gateway !== undefined && Iface.gateway !== undefined) {
      const Was = Old.gateway || null;
      const Now = Iface.gateway || null;
      if (Was !== Now) Result.GatewayChanged.push({ Name, Previous: Was, Gateway: Now });
    }
  }
  for (const [Name, Old] of Before) {
    if (After.has(Name)) continue;
    const OldAddresses = ExternalIPv4(Old);
    if (OldAddresses.length) Result.Down.push({ Name, Addresses: OldAddresses });
  }
  return Result;
}

// --- USB devices -----------------------------------------------------------------------

// What was last seen of one device. Kept after the device is unplugged, so the
// same serial reappearing on another port reads as moved; unplug and replug
// elsewhere is exactly how a device gets moved.
export interface USBDeviceMemory {
  Location: string | null;
  FirmwareVersion: string | null;
  ErrorCode: number;
  Connected: boolean;
}

export type USBMemory = Map<string, USBDeviceMemory>;

export interface USBTransition {
  Kind: 'moved' | 'firmware' | 'error';
  Device: USBDevice;
  Previous: USBDeviceMemory | null;
}

function TextOrNull(Value: unknown): string | null {
  return typeof Value === 'string' && Value.trim() ? Value.trim() : null;
}

function ErrorCodeOf(Device: USBDevice): number {
  const State = Device && Device.DeviceState;
  const Code = State && typeof State === 'object' ? Number(State.ErrorCode) : 0;
  return Number.isFinite(Code) ? Code : 0;
}

// A serial identifies one physical device wherever it is plugged in. Without
// one, the port is the only thing that tells two identical devices apart, so a
// serial-less device can raise an error but never "move".
function USBMemoryKey(Device: USBDevice): string | null {
  const Serial = normalizeSerialNumber(Device && Device.SerialNumber);
  if (Serial) return `serial:${Serial}`;
  const Location = TextOrNull(Device && Device.Location);
  if (!Location) return null;
  return `port:${Location}:${Device.VendorID ?? ''}:${Device.ProductID ?? ''}`;
}

/**
 * Compare the connected list against what was last seen, and remember it.
 *
 * `Trusted` false records the list as the baseline without reporting anything:
 * the first list of a connection describes how the machine already was.
 */
export function trackUSBDevices(
  Memory: USBMemory,
  Connected: USBDevice[],
  Trusted: boolean
): USBTransition[] {
  const Transitions: USBTransition[] = [];
  const Present = new Set<string>();
  for (const Device of Connected) {
    const Key = USBMemoryKey(Device);
    if (!Key || Present.has(Key)) continue;
    Present.add(Key);
    const Next: USBDeviceMemory = {
      Location: TextOrNull(Device.Location),
      FirmwareVersion: TextOrNull(Device.FirmwareVersion),
      ErrorCode: ErrorCodeOf(Device),
      Connected: true,
    };
    const Previous = Memory.get(Key) || null;
    if (Trusted) {
      // A key the client cannot report (absent on an older client) is never a change.
      if (Previous && Key.startsWith('serial:') && Previous.Location && Next.Location) {
        if (Previous.Location !== Next.Location)
          Transitions.push({ Kind: 'moved', Device, Previous });
      }
      if (Previous && Previous.FirmwareVersion && Next.FirmwareVersion) {
        if (Previous.FirmwareVersion !== Next.FirmwareVersion) {
          Transitions.push({ Kind: 'firmware', Device, Previous });
        }
      }
      // A device that starts failing, or turns up already failing.
      const WasFailing = Previous ? Previous.Connected && Previous.ErrorCode !== 0 : false;
      if (Next.ErrorCode !== 0 && !WasFailing)
        Transitions.push({ Kind: 'error', Device, Previous });
    }
    Memory.set(Key, Next);
  }
  for (const [Key, Entry] of Memory) {
    if (Present.has(Key)) continue;
    if (Key.startsWith('serial:')) Entry.Connected = false;
    else Memory.delete(Key);
  }
  return Transitions;
}
