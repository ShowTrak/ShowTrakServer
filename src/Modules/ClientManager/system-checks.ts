// Monitored system checks: CPU, memory, uptime, power and thermal.
//
// Each is opt-in per client, like a monitored display or network interface:
// the operator monitors a check from its card in the view modal, and ticks the
// conditions it holds the machine to. A check that is not monitored is never
// judged, and a monitored check with a condition unticked (null) does not judge
// that condition.
//
// Pure, so the rules can be tested without a socket, a DB or a timer. The
// Client entity owns WHEN they run and turns a breach into a threshold alarm
// (see ./health StepResourceAlarm), a degraded warning and an alert trigger.
import type {
  ClientPowerCheck,
  ClientResourceAlarmKey,
  ClientSystemCheckKey,
  ClientSystemChecks,
  ClientThermalCheck,
  ClientUptimeCheck,
  ClientUsageCheck,
  PowerStatusSnapshot,
  TemperaturesSnapshot,
  ThermalState,
} from '@showtrak/protocol';
import type { SystemCheckRow } from '../DB/rows';
import { AsRecord } from './normalizers';

export const SYSTEM_CHECK_KEYS: readonly ClientSystemCheckKey[] = [
  'cpu',
  'ram',
  'uptime',
  'power',
  'thermal',
];

// --- Limits ----------------------------------------------------------------------

export const MAX_SUSTAIN_SECONDS = 3600;
export const MAX_UPTIME_DAYS = 366;
export const MAX_TEMPERATURE_CELSIUS = 150;

export type MaxThermalState = Exclude<ThermalState, 'critical'>;
const THERMAL_RANK: Record<ThermalState, number> = { nominal: 0, fair: 1, serious: 2, critical: 3 };
const MAX_THERMAL_STATES: ReadonlySet<string> = new Set(['nominal', 'fair', 'serious']);

/**
 * What a first "Monitor" press ticks. Thermal and power are narrowed to what
 * the machine actually reports (see DefaultSystemCheck), so a Mac — which has a
 * thermal state and no readable sensors — is not left guarding a reading it
 * will never send.
 */
export const SYSTEM_CHECK_DEFAULTS = {
  cpu: { MaxPercent: 90, SustainSeconds: 60 } as ClientUsageCheck,
  ram: { MaxPercent: 90, SustainSeconds: 60 } as ClientUsageCheck,
  uptime: { MaxDays: 1 } as ClientUptimeCheck,
  power: {
    RequireMains: true,
    MinBatteryPercent: 20,
    ChargingBelowPercent: null,
  } as ClientPowerCheck,
  thermal: { MaxCelsius: 85, MaxThermalState: 'fair' } as ClientThermalCheck,
};

// --- Normalising -------------------------------------------------------------------

export function IsSystemCheckKey(Value: unknown): Value is ClientSystemCheckKey {
  return typeof Value === 'string' && (SYSTEM_CHECK_KEYS as readonly string[]).includes(Value);
}

/** A whole number in [Min, Max], or null for anything that is not a number. */
export function WholeInRange(Value: unknown, Min: number, Max: number): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const n = Number(Value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Max, Math.max(Min, Math.round(n)));
}

const Percent = (Value: unknown) => WholeInRange(Value, 0, 100);

function MaxThermalStateOf(Value: unknown): MaxThermalState | null {
  return typeof Value === 'string' && MAX_THERMAL_STATES.has(Value)
    ? (Value as MaxThermalState)
    : null;
}

export function EmptySystemChecks(): ClientSystemChecks {
  return { Cpu: null, Ram: null, Uptime: null, Power: null, Thermal: null };
}

const FIELD_BY_KEY: Record<ClientSystemCheckKey, keyof ClientSystemChecks> = {
  cpu: 'Cpu',
  ram: 'Ram',
  uptime: 'Uptime',
  power: 'Power',
  thermal: 'Thermal',
};

export function SystemCheckField(Key: ClientSystemCheckKey): keyof ClientSystemChecks {
  return FIELD_BY_KEY[Key];
}

export type SystemCheck =
  ClientUsageCheck | ClientUptimeCheck | ClientPowerCheck | ClientThermalCheck;

/** One check's conditions from a stored row or a request-shaped object. */
export function normalizeSystemCheck(Key: ClientSystemCheckKey, Source: unknown): SystemCheck {
  const S = AsRecord(Source);
  switch (Key) {
    case 'cpu':
    case 'ram':
      return {
        MaxPercent: Percent(S.MaxPercent),
        SustainSeconds:
          WholeInRange(S.SustainSeconds, 0, MAX_SUSTAIN_SECONDS) ??
          SYSTEM_CHECK_DEFAULTS[Key].SustainSeconds,
      };
    case 'uptime':
      return { MaxDays: WholeInRange(S.MaxDays, 1, MAX_UPTIME_DAYS) };
    case 'power':
      return {
        RequireMains: S.RequireMains === true || Number(S.RequireMains) === 1,
        MinBatteryPercent: Percent(S.MinBatteryPercent),
        ChargingBelowPercent: Percent(S.ChargingBelowPercent),
      };
    case 'thermal':
    default:
      return {
        MaxCelsius: WholeInRange(S.MaxCelsius, 0, MAX_TEMPERATURE_CELSIUS),
        MaxThermalState: MaxThermalStateOf(S.MaxThermalState),
      };
  }
}

/** A stored row as the check it describes, or null for a row that names no check. */
export function normalizeSystemCheckRow(
  Row: unknown
): { Key: ClientSystemCheckKey; Check: SystemCheck } | null {
  const R = AsRecord(Row);
  if (!IsSystemCheckKey(R.CheckKey)) return null;
  return { Key: R.CheckKey, Check: normalizeSystemCheck(R.CheckKey, R) };
}

/** The row that stores one check. */
export function SystemCheckToRow(
  UUID: string,
  Key: ClientSystemCheckKey,
  Check: SystemCheck,
  Timestamp: number
): SystemCheckRow {
  const C = Check as Partial<
    ClientUsageCheck & ClientUptimeCheck & ClientPowerCheck & ClientThermalCheck
  >;
  return {
    UUID,
    CheckKey: Key,
    MaxPercent: C.MaxPercent ?? null,
    SustainSeconds: C.SustainSeconds ?? null,
    MaxDays: C.MaxDays ?? null,
    RequireMains: C.RequireMains ? 1 : 0,
    MinBatteryPercent: C.MinBatteryPercent ?? null,
    ChargingBelowPercent: C.ChargingBelowPercent ?? null,
    MaxCelsius: C.MaxCelsius ?? null,
    MaxThermalState: C.MaxThermalState ?? null,
    Timestamp,
  };
}

/**
 * What a first "Monitor" press guards, given what the client reports. With no
 * report yet everything is ticked, so nothing is lost by monitoring early.
 */
export function DefaultSystemCheck(
  Key: ClientSystemCheckKey,
  Power: PowerStatusSnapshot | null,
  Temperatures: TemperaturesSnapshot | null
): SystemCheck {
  if (Key === 'power') {
    const Defaults = { ...SYSTEM_CHECK_DEFAULTS.power };
    if (Power && Power.Status.State === 'ok' && !Power.Battery) Defaults.MinBatteryPercent = null;
    return Defaults;
  }
  if (Key === 'thermal') {
    const Defaults = { ...SYSTEM_CHECK_DEFAULTS.thermal };
    if (Temperatures && Temperatures.Status.State === 'ok') {
      const HasSensors = Temperatures.Sensors.length > 0;
      const HasState = Temperatures.ThermalState !== null;
      if (HasSensors || HasState) {
        if (!HasSensors) Defaults.MaxCelsius = null;
        if (!HasState) Defaults.MaxThermalState = null;
      }
    }
    return Defaults;
  }
  return { ...SYSTEM_CHECK_DEFAULTS[Key] };
}

/**
 * The check an edit leaves behind: the existing one (or the defaults, on a first
 * monitor) with every field the request carries applied. A field the request
 * omits keeps its value; null stops guarding it.
 */
export function resolveSystemCheck(
  Key: ClientSystemCheckKey,
  Request: Record<string, unknown>,
  Existing: SystemCheck | null,
  Power: PowerStatusSnapshot | null,
  Temperatures: TemperaturesSnapshot | null
): SystemCheck {
  const Base = Existing ?? DefaultSystemCheck(Key, Power, Temperatures);
  const Merged: Record<string, unknown> = { ...Base };
  for (const [Field, Value] of Object.entries(Request)) {
    if (Field === 'Key' || Value === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(Base, Field)) Merged[Field] = Value;
  }
  return normalizeSystemCheck(Key, Merged);
}

// --- Judging --------------------------------------------------------------------------

/**
 * One condition's verdict: true breaching, false healthy, null when there is
 * nothing to judge (not monitored, unticked, or no reading).
 */
export type Breach = boolean | null;

export function UsageBreach(Check: ClientUsageCheck | null, Reading: number | null): Breach {
  if (!Check || Check.MaxPercent === null || Reading === null) return null;
  return Reading > Check.MaxPercent;
}

export function UptimeBreach(
  Check: ClientUptimeCheck | null,
  UptimeSeconds: number | null
): Breach {
  if (!Check || Check.MaxDays === null || UptimeSeconds === null) return null;
  return UptimeSeconds > Check.MaxDays * 86400;
}

/**
 * Mains, battery level and charging. The battery-level alarm only stands while
 * the battery is not charging: on mains a low charge is recovering, not a fault.
 * Charging is only judged on mains — unplugged, the power-source condition is
 * the one that speaks, and every battery "is not charging".
 */
export function PowerBreaches(
  Check: ClientPowerCheck | null,
  Power: PowerStatusSnapshot | null
): { power: Breach; battery: Breach; charging: Breach } {
  const None = { power: null, battery: null, charging: null };
  if (!Check || !Power || Power.Status.State !== 'ok') return None;
  const Battery = Power.Battery;
  const Level = Battery ? Battery.Percent : null;
  const Charging = Battery ? Battery.Charging : null;
  return {
    power: Check.RequireMains && Power.OnBattery !== null ? Power.OnBattery : null,
    battery:
      Check.MinBatteryPercent !== null && Level !== null
        ? Level < Check.MinBatteryPercent && Charging !== true
        : null,
    charging:
      Check.ChargingBelowPercent !== null && Level !== null && Charging !== null
        ? Power.OnBattery === true
          ? false
          : !Charging && Level < Check.ChargingBelowPercent
        : null,
  };
}

/** The hottest sensor, or null when none is readable. */
export function HottestSensor(
  Temperatures: TemperaturesSnapshot | null
): { Name: string; Celsius: number } | null {
  if (!Temperatures) return null;
  let Hottest: { Name: string; Celsius: number } | null = null;
  for (const Sensor of Temperatures.Sensors) {
    if (!Hottest || Sensor.Celsius > Hottest.Celsius) Hottest = Sensor;
  }
  return Hottest;
}

export function ThermalBreaches(
  Check: ClientThermalCheck | null,
  Temperatures: TemperaturesSnapshot | null
): { temperature: Breach; thermal: Breach } {
  if (!Check || !Temperatures || Temperatures.Status.State !== 'ok') {
    return { temperature: null, thermal: null };
  }
  const Hottest = HottestSensor(Temperatures);
  const State = Temperatures.ThermalState;
  return {
    temperature: Check.MaxCelsius !== null && Hottest ? Hottest.Celsius > Check.MaxCelsius : null,
    thermal:
      Check.MaxThermalState !== null && State !== null
        ? THERMAL_RANK[State] > THERMAL_RANK[Check.MaxThermalState]
        : null,
  };
}

// --- Presentation ----------------------------------------------------------------------

/** The degraded warning each failing condition publishes. */
export const SYSTEM_CHECK_WARNINGS: Record<ClientResourceAlarmKey, string> = {
  cpu: 'High CPU Usage',
  ram: 'High Memory Usage',
  uptime: 'Restart Overdue',
  power: 'Running On Battery',
  battery: 'Battery Low',
  charging: 'Battery Not Charging',
  temperature: 'High Temperature',
  thermal: 'Thermal Throttling',
};

/** The check each alarm belongs to. */
export const ALARM_CHECK: Record<ClientResourceAlarmKey, ClientSystemCheckKey> = {
  cpu: 'cpu',
  ram: 'ram',
  uptime: 'uptime',
  power: 'power',
  battery: 'power',
  charging: 'power',
  temperature: 'thermal',
  thermal: 'thermal',
};

export const RESOURCE_ALARM_KEYS: readonly ClientResourceAlarmKey[] = [
  'cpu',
  'ram',
  'uptime',
  'power',
  'battery',
  'charging',
  'temperature',
  'thermal',
];
