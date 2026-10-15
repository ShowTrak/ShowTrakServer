// The monitored system checks (CPU, memory, uptime, power, thermal) as the view
// modal presents them — one card each, styled like a monitored display: a
// toggle, the issues it raises, and an auto-saving conditions table. Decisions only — the markup lives in
// ../client-info-health and ../client-info-modal — so the wording and the
// states can be tested without a DOM.
import type {
  ClientPowerCheck,
  ClientResourceAlarm,
  ClientResourceAlarmKey,
  ClientSystemCheckKey,
  ClientThermalCheck,
  ClientUptimeCheck,
  ClientUsageCheck,
  ClientView,
  PowerStatusSnapshot,
  TemperatureSensor,
  TemperaturesSnapshot,
  ThermalState,
} from '@showtrak/protocol';
import { AudioPlatformLabel, IsVersionAtLeast } from './audio-devices';

/**
 * The first ShowTrak Client release that reports battery/mains, sleep and
 * resume, temperatures, hung applications and the foreground application.
 * MUST match MINIMUM_SYSTEM_HEALTH_VERSION in Modules/Config/constants.ts.
 */
export const MINIMUM_SYSTEM_HEALTH_VERSION = [3, 22, 0] as const;
export const MINIMUM_SYSTEM_HEALTH_VERSION_LABEL = MINIMUM_SYSTEM_HEALTH_VERSION.join('.');

// --- Uptime ---------------------------------------------------------------------

/** "3d 4h", "4h 12m", "12m 5s", "40s". Two units are plenty to read at a glance. */
export function FormatDuration(Seconds: number | null | undefined): string {
  if (Seconds === null || Seconds === undefined || !Number.isFinite(Seconds) || Seconds < 0) {
    return '';
  }
  const Whole = Math.floor(Seconds);
  const Days = Math.floor(Whole / 86400);
  const Hours = Math.floor((Whole % 86400) / 3600);
  const Minutes = Math.floor((Whole % 3600) / 60);
  const Secs = Whole % 60;
  if (Days > 0) return `${Days}d ${Hours}h`;
  if (Hours > 0) return `${Hours}h ${Minutes}m`;
  if (Minutes > 0) return `${Minutes}m ${Secs}s`;
  return `${Secs}s`;
}

/** Uptime in seconds from the vitals: `Seconds` where sent, else the `HH:mm:ss` string. */
export function UptimeSecondsOf(Client: ClientView): number | null {
  const Uptime = Client.Vitals && Client.Vitals.Uptime;
  if (!Uptime) return null;
  if (typeof Uptime.Seconds === 'number' && Number.isFinite(Uptime.Seconds)) {
    return Math.max(0, Math.floor(Uptime.Seconds));
  }
  const Match =
    typeof Uptime.Formatted === 'string'
      ? /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(Uptime.Formatted.trim())
      : null;
  if (!Match) return null;
  return Number(Match[1]) * 3600 + Number(Match[2]) * 60 + Number(Match[3]);
}

function FormatTimestamp(Ms: number): string {
  try {
    return new Date(Ms).toLocaleString([], {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * The Info tab's uptime line. Live while online; once offline the last reading
 * would freeze and mislead, so only the last known boot is shown.
 */
export function UptimeText(Client: ClientView): string {
  const Boot =
    typeof Client.BootTime === 'number' && Client.BootTime > 0
      ? `booted ${FormatTimestamp(Client.BootTime)}`
      : '';
  if (!Client.Online) return Boot ? `Offline — last ${Boot}` : 'Unknown (offline)';
  const Seconds = UptimeSecondsOf(Client);
  if (Seconds === null) return 'Waiting for the client';
  return Boot ? `${FormatDuration(Seconds)} (${Boot})` : FormatDuration(Seconds);
}

// --- Alarms ------------------------------------------------------------------------

const ALARM_LABELS: Record<ClientResourceAlarmKey, string> = {
  cpu: 'High CPU usage',
  ram: 'High memory usage',
  uptime: 'Restart overdue',
  power: 'Running on battery',
  battery: 'Battery low',
  charging: 'Battery not charging',
  temperature: 'High temperature',
  thermal: 'Throttling to cool down',
};

/** The check each alarm belongs to (mirrors ALARM_CHECK in ClientManager/system-checks). */
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

function AlarmValue(Key: ClientResourceAlarmKey, Value: number | string | null): string {
  if (Value === null || Value === undefined) return 'unknown';
  if (Key === 'thermal') return ThermalStateLabel(String(Value));
  if (Key === 'uptime') return FormatDuration(Number(Value) * 86400);
  return `${Value}${Key === 'temperature' ? '°C' : '%'}`;
}

function AlarmLimit(Key: ClientResourceAlarmKey, Threshold: number | string | null): string {
  if (Threshold === null || Threshold === undefined) return '';
  switch (Key) {
    case 'uptime':
      return `limit ${Threshold} ${Number(Threshold) === 1 ? 'day' : 'days'}`;
    case 'thermal':
      return `allowed up to ${ThermalStateLabel(String(Threshold)).toLowerCase()}`;
    case 'battery':
      return `minimum ${Threshold}%`;
    case 'charging':
      return `must charge below ${Threshold}%`;
    case 'temperature':
      return `limit ${Threshold}°C`;
    default:
      return `limit ${Threshold}%`;
  }
}

/** "High CPU usage — 97% (limit 90%) for 4m 10s". */
export function ResourceAlarmText(Alarm: ClientResourceAlarm, Now: number = Date.now()): string {
  const Label = ALARM_LABELS[Alarm.Key] || 'Alarm';
  const Limit = AlarmLimit(Alarm.Key, Alarm.Threshold);
  const Since = Number.isFinite(Alarm.Since) ? FormatDuration((Now - Alarm.Since) / 1000) : '';
  const Value = Alarm.Key === 'power' ? '' : ` — ${AlarmValue(Alarm.Key, Alarm.Value)}`;
  return `${Label}${Value}${Limit ? ` (${Limit})` : ''}${Since ? ` for ${Since}` : ''}`;
}

/** Whether one alarm is standing, for colouring its chart. */
export function IsAlarmActive(Client: ClientView, Key: ClientResourceAlarmKey): boolean {
  return Client.Online === true && (Client.ResourceAlarms || []).some((A) => A.Key === Key);
}

// --- Power and temperatures --------------------------------------------------------

/**
 * Which overall message a power or temperature section shows, on the audio
 * section's rules: `outdated` (client predates it), `waiting`, `offline`,
 * `unsupported` / `error` (the client tried and its platform said no), `ok`.
 */
export type HealthSectionState =
  'outdated' | 'waiting' | 'offline' | 'unsupported' | 'error' | 'ok';

function SectionState(
  Client: ClientView,
  Snapshot: PowerStatusSnapshot | TemperaturesSnapshot | null | undefined
): HealthSectionState {
  if (!IsVersionAtLeast(Client.Version, MINIMUM_SYSTEM_HEALTH_VERSION)) return 'outdated';
  if (!Client.Online) return 'offline';
  if (!Snapshot) return 'waiting';
  if (Snapshot.Status.State === 'unsupported') return 'unsupported';
  if (Snapshot.Status.State === 'error') return 'error';
  if (Snapshot.Status.State === 'ok') return 'ok';
  return 'waiting';
}

export function GetPowerSectionState(Client: ClientView): HealthSectionState {
  return SectionState(Client, Client.PowerStatus);
}

export function GetTemperatureSectionState(Client: ClientView): HealthSectionState {
  return SectionState(Client, Client.Temperatures);
}

export function HealthSectionMessage(
  State: Exclude<HealthSectionState, 'ok'>,
  Client: ClientView,
  Domain: 'power' | 'temperature'
): { Title: string; Body: string } {
  const Snapshot = Domain === 'power' ? Client.PowerStatus : Client.Temperatures;
  const Platform = AudioPlatformLabel(Snapshot?.Status?.Platform, Client.OperatingSystem);
  const Noun = Domain === 'power' ? 'Power' : 'Temperatures';
  const What = Domain === 'power' ? 'battery, mains power and sleep' : 'temperatures';
  switch (State) {
    case 'outdated':
      return {
        Title: `${Noun} Unsupported`,
        Body: `Monitoring ${What} needs ShowTrak Client ${MINIMUM_SYSTEM_HEALTH_VERSION_LABEL} or later${
          Client.Version ? ` — this client runs ${Client.Version}` : ''
        }. Update the client to monitor it.`,
      };
    case 'waiting':
      return {
        Title: `Waiting for ${Noun}`,
        Body: `This client has not reported its ${What} yet.`,
      };
    case 'offline':
      return {
        Title: 'Client Offline',
        Body: `${Noun} are reported while the client is connected.`,
      };
    case 'unsupported':
      return {
        Title: `${Noun} Not Available`,
        Body: Snapshot?.Status?.Message || `Monitoring ${What} is not available on ${Platform}.`,
      };
    case 'error':
    default:
      return {
        Title: `${Noun} Warning`,
        Body: Snapshot?.Status?.Message || `The client could not read its ${What}.`,
      };
  }
}

export interface HealthRow {
  Label: string;
  Value: string;
  // 'bad' draws the row as a fault; 'good' as healthy; '' plain.
  Tone: 'bad' | 'good' | '';
}

/**
 * The power card's readings beyond what its conditions show: time remaining on
 * battery, and when the machine last slept and woke.
 */
export function PowerDetailRows(Power: PowerStatusSnapshot, Now: number = Date.now()): HealthRow[] {
  const Rows: HealthRow[] = [];
  if (Power.Battery && Power.Battery.TimeRemainingMinutes !== null && Power.OnBattery) {
    Rows.push({
      Label: 'Time Remaining',
      Value: FormatDuration(Power.Battery.TimeRemainingMinutes * 60),
      Tone: '',
    });
  }
  const Ago = (At: number) => `${FormatTimestamp(At)} (${FormatDuration((Now - At) / 1000)} ago)`;
  Rows.push({
    Label: 'Last Sleep',
    Value: Power.LastSuspendAt ? Ago(Power.LastSuspendAt) : 'Not since the client started',
    Tone: '',
  });
  Rows.push({
    Label: 'Last Wake',
    Value: Power.LastResumeAt ? Ago(Power.LastResumeAt) : 'Not since the client started',
    Tone: '',
  });
  return Rows;
}

const THERMAL_STATE_LABELS: Record<ThermalState, string> = {
  nominal: 'Normal',
  fair: 'Fair',
  serious: 'Serious — throttling',
  critical: 'Critical — throttling hard',
};

/** What the operating system's thermal state means, in an operator's words. */
export function ThermalStateLabel(State: string | null | undefined): string {
  return (State && THERMAL_STATE_LABELS[State as ThermalState]) || 'Unknown';
}

const SENSOR_KIND_ORDER: Record<TemperatureSensor['Kind'], number> = {
  cpu: 0,
  gpu: 1,
  system: 2,
  storage: 3,
  battery: 4,
  other: 5,
};

/** Each sensor, CPU first and hottest of a kind first; over the limit reads as a fault. */
export function TemperatureRows(
  Snapshot: TemperaturesSnapshot,
  Threshold: number | null | undefined
): HealthRow[] {
  const Rows: HealthRow[] = [];
  const Sensors = Snapshot.Sensors.slice().sort(
    (A, B) => SENSOR_KIND_ORDER[A.Kind] - SENSOR_KIND_ORDER[B.Kind] || B.Celsius - A.Celsius
  );
  for (const Sensor of Sensors) {
    const Hot = typeof Threshold === 'number' && Sensor.Celsius > Threshold;
    Rows.push({
      Label: Sensor.Name,
      Value: `${Sensor.Celsius.toFixed(Number.isInteger(Sensor.Celsius) ? 0 : 1)}°C`,
      Tone: Hot ? 'bad' : '',
    });
  }
  return Rows;
}

// --- System check cards ---------------------------------------------------------------
//
// One card per check, in the shape every monitored-hardware card has: a title
// and live summary, a Monitor toggle, the issues it is raising, and — once
// monitored — a conditions table whose rows save as they change. A tick guards
// a condition; unticking stops guarding it (null on the wire).

export type SystemConditionField =
  | 'MaxPercent'
  | 'SustainSeconds'
  | 'MaxDays'
  | 'RequireMains'
  | 'MinBatteryPercent'
  | 'ChargingBelowPercent'
  | 'MaxCelsius'
  | 'MaxThermalState';

export interface SystemConditionInput {
  Kind: 'number' | 'select';
  /** The stored limit, or '' while the condition is unticked. */
  Value: string;
  /** What ticking an empty row fills in. */
  Default: string;
  Unit: string;
  Min?: number;
  Max?: number;
  Options?: Array<{ Value: string; Label: string }>;
}

export interface SystemConditionRow {
  Field: SystemConditionField;
  Label: string;
  /** The reading now, for rows without an input. */
  Value: string;
  Input: SystemConditionInput | null;
  /** Whether this machine can be held to it. A condition already set always is, so it can be cleared. */
  Supported: boolean;
  /** False for a setting that always applies (the sustain time), which has no tick. */
  Tickable: boolean;
  Checked: boolean;
  /** The alarm this condition is raising, when it is not met. */
  Failing: string | null;
}

export interface SystemCheckBadge {
  State: 'plain' | 'healthy' | 'issue';
  Label: string;
  Icon: string;
  Title: string;
}

export interface SystemCheckCard {
  Key: ClientSystemCheckKey;
  Title: string;
  /** The live reading, one line. */
  Summary: string;
  Monitored: boolean;
  /** Whether the toggle is offered: never to a client that cannot report the check, unless it is already monitored (so it can be stopped). */
  CanMonitor: boolean;
  Badge: SystemCheckBadge;
  Issues: string[];
  Rows: SystemConditionRow[];
  /** Why there is nothing to read: an old client, a machine without the hardware, offline. */
  Note: { Title: string; Body: string; Tone: 'ghost' | 'danger' } | null;
}

/** The limits a first tick fills in (mirrors SYSTEM_CHECK_DEFAULTS on the server). */
export const SYSTEM_CONDITION_DEFAULTS: Record<SystemConditionField, string> = {
  MaxPercent: '90',
  SustainSeconds: '60',
  MaxDays: '1',
  RequireMains: '',
  MinBatteryPercent: '20',
  ChargingBelowPercent: '95',
  MaxCelsius: '85',
  MaxThermalState: 'fair',
};

const LIMITS: Partial<Record<SystemConditionField, { Min: number; Max: number; Unit: string }>> = {
  MaxPercent: { Min: 1, Max: 100, Unit: '%' },
  SustainSeconds: { Min: 0, Max: 3600, Unit: 's' },
  MaxDays: { Min: 1, Max: 366, Unit: 'days' },
  MinBatteryPercent: { Min: 1, Max: 100, Unit: '%' },
  ChargingBelowPercent: { Min: 1, Max: 100, Unit: '%' },
  MaxCelsius: { Min: 1, Max: 150, Unit: '°C' },
};

const FIELD_ALARM: Partial<Record<SystemConditionField, ClientResourceAlarmKey>> = {
  MaxDays: 'uptime',
  RequireMains: 'power',
  MinBatteryPercent: 'battery',
  ChargingBelowPercent: 'charging',
  MaxCelsius: 'temperature',
  MaxThermalState: 'thermal',
};

export const THERMAL_STATE_OPTIONS: Array<{ Value: string; Label: string }> = [
  { Value: 'nominal', Label: 'Normal' },
  { Value: 'fair', Label: 'Fair' },
  { Value: 'serious', Label: 'Serious' },
];

const CHECK_TITLES: Record<ClientSystemCheckKey, string> = {
  cpu: 'CPU',
  ram: 'Memory',
  uptime: 'Uptime',
  power: 'Power',
  thermal: 'Thermal',
};

const CHECK_NOUNS: Record<ClientSystemCheckKey, string> = {
  cpu: 'CPU usage',
  ram: 'memory usage',
  uptime: 'uptime',
  power: 'power',
  thermal: 'temperature',
};

/** A usage percentage from the vitals (CPU sends a number, memory a string). */
export function UsageReading(Client: ClientView, Key: 'cpu' | 'ram'): number | null {
  if (!Client.Online || !Client.Vitals) return null;
  const Raw =
    Key === 'cpu' ? Client.Vitals.CPU?.UsagePercentage : Client.Vitals.Ram?.UsagePercentage;
  if (Raw === null || Raw === undefined || Raw === '') return null;
  const n = typeof Raw === 'number' ? Raw : parseFloat(String(Raw));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

/** "3.2 GB". Kept here rather than borrowed from ../utils so this module stays DOM-free. */
export function FormatMemory(Bytes: unknown): string {
  const n = Number(Bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const Units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let Value = n;
  let Unit = 0;
  while (Value >= 1024 && Unit < Units.length - 1) {
    Value /= 1024;
    Unit += 1;
  }
  return `${Value.toFixed(Value >= 10 || Unit === 0 ? 0 : 1)} ${Units[Unit]}`;
}

function UsageSummary(Client: ClientView, Key: 'cpu' | 'ram'): string {
  if (!Client.Online) return 'Offline';
  const Reading = UsageReading(Client, Key);
  if (Reading === null) return 'Waiting for the client';
  const Used = `${Reading.toFixed(0)}% used`;
  if (Key === 'cpu') return Used;
  const Ram = Client.Vitals?.Ram;
  const UsedBytes = FormatMemory(Ram?.Used);
  const Total = FormatMemory(Ram?.Total);
  return UsedBytes && Total ? `${Used} · ${UsedBytes} of ${Total}` : Used;
}

/** "Mains · Battery 54%, charging". */
export function PowerSummary(Power: PowerStatusSnapshot): string {
  const Parts: string[] = [];
  if (Power.OnBattery !== null) Parts.push(Power.OnBattery ? 'On battery' : 'Mains');
  if (Power.Battery) {
    const Level = Power.Battery.Percent === null ? 'unknown' : `${Power.Battery.Percent}%`;
    const State =
      Power.Battery.Charging === true
        ? ', charging'
        : Power.Battery.Charging === false
          ? ', not charging'
          : '';
    Parts.push(`Battery ${Level}${State}`);
  } else {
    Parts.push('No battery');
  }
  return Parts.join(' · ');
}

function Hottest(Snapshot: TemperaturesSnapshot): TemperatureSensor | null {
  let Top: TemperatureSensor | null = null;
  for (const Sensor of Snapshot.Sensors) if (!Top || Sensor.Celsius > Top.Celsius) Top = Sensor;
  return Top;
}

function FormatCelsius(Value: number): string {
  return `${Value.toFixed(Number.isInteger(Value) ? 0 : 1)}°C`;
}

/** "Hottest 62°C (CPU Package) · Thermal state Normal". */
export function ThermalSummary(Snapshot: TemperaturesSnapshot): string {
  const Parts: string[] = [];
  const Top = Hottest(Snapshot);
  if (Top) Parts.push(`Hottest ${FormatCelsius(Top.Celsius)} (${Top.Name})`);
  if (Snapshot.ThermalState)
    Parts.push(`Thermal state ${ThermalStateLabel(Snapshot.ThermalState)}`);
  return Parts.length ? Parts.join(' · ') : 'No readable sensors';
}

function AlarmsFor(Client: ClientView, Key: ClientSystemCheckKey): ClientResourceAlarm[] {
  if (!Client.Online) return [];
  return (Client.ResourceAlarms || []).filter((Alarm) => ALARM_CHECK[Alarm.Key] === Key);
}

function Badge(Key: ClientSystemCheckKey, Monitored: boolean, HasIssue: boolean): SystemCheckBadge {
  if (!Monitored) {
    return {
      State: 'plain',
      Label: 'Monitor',
      Icon: 'bi-check-circle',
      Title: `Monitor ${CHECK_NOUNS[Key]}`,
    };
  }
  if (HasIssue) {
    return {
      State: 'issue',
      Label: 'Alarm',
      Icon: 'bi-exclamation-triangle-fill',
      Title: 'Stop monitoring (conditions not met)',
    };
  }
  return {
    State: 'healthy',
    Label: 'Monitored',
    Icon: 'bi-check-circle-fill',
    Title: 'Stop monitoring',
  };
}

function NumberInput(
  Field: SystemConditionField,
  Value: number | null | undefined
): SystemConditionInput {
  const Limit = LIMITS[Field]!;
  return {
    Kind: 'number',
    Value: typeof Value === 'number' ? String(Value) : '',
    Default: SYSTEM_CONDITION_DEFAULTS[Field],
    Unit: Limit.Unit,
    Min: Limit.Min,
    Max: Limit.Max,
  };
}

function Row(
  Field: SystemConditionField,
  Label: string,
  Options: {
    Value?: string;
    Input?: SystemConditionInput | null;
    Capable: boolean;
    Checked: boolean;
    Tickable?: boolean;
    Alarms: ClientResourceAlarm[];
    AlarmKey?: ClientResourceAlarmKey;
  }
): SystemConditionRow {
  const Supported = Options.Capable || Options.Checked;
  const AlarmKey = Options.AlarmKey ?? FIELD_ALARM[Field];
  const Alarm = AlarmKey ? Options.Alarms.find((Candidate) => Candidate.Key === AlarmKey) : null;
  return {
    Field,
    Label,
    Value: Supported ? (Options.Value ?? '') : 'Unsupported',
    Input: Supported ? (Options.Input ?? null) : null,
    Supported,
    Tickable: Options.Tickable !== false,
    Checked: Options.Checked,
    Failing: Alarm ? ResourceAlarmText(Alarm) : null,
  };
}

function UsageCard(Client: ClientView, Key: 'cpu' | 'ram'): SystemCheckCard {
  const Check: ClientUsageCheck | null =
    (Key === 'cpu' ? Client.SystemChecks?.Cpu : Client.SystemChecks?.Ram) ?? null;
  const Alarms = AlarmsFor(Client, Key);
  return {
    Key,
    Title: CHECK_TITLES[Key],
    Summary: UsageSummary(Client, Key),
    Monitored: !!Check,
    CanMonitor: true,
    Badge: Badge(Key, !!Check, Alarms.length > 0),
    Issues: Alarms.map((Alarm) => ResourceAlarmText(Alarm)),
    Rows: Check
      ? [
          Row('MaxPercent', 'Maximum usage', {
            Input: NumberInput('MaxPercent', Check.MaxPercent),
            Capable: true,
            Checked: Check.MaxPercent !== null,
            Alarms,
            AlarmKey: Key,
          }),
          Row('SustainSeconds', 'For at least', {
            Input: NumberInput('SustainSeconds', Check.SustainSeconds),
            Capable: true,
            Checked: true,
            Tickable: false,
            Alarms: [],
          }),
        ]
      : [],
    Note: null,
  };
}

function UptimeCard(Client: ClientView): SystemCheckCard {
  const Check: ClientUptimeCheck | null = Client.SystemChecks?.Uptime ?? null;
  const Alarms = AlarmsFor(Client, 'uptime');
  return {
    Key: 'uptime',
    Title: CHECK_TITLES.uptime,
    Summary: UptimeText(Client),
    Monitored: !!Check,
    CanMonitor: true,
    Badge: Badge('uptime', !!Check, Alarms.length > 0),
    Issues: Alarms.map((Alarm) => ResourceAlarmText(Alarm)),
    Rows: Check
      ? [
          Row('MaxDays', 'Maximum uptime', {
            Input: NumberInput('MaxDays', Check.MaxDays),
            Capable: true,
            Checked: Check.MaxDays !== null,
            Alarms,
          }),
        ]
      : [],
    Note: null,
  };
}

// The note a power or thermal card shows instead of readings, if any.
function DomainNote(
  Client: ClientView,
  State: HealthSectionState,
  Domain: 'power' | 'temperature'
): SystemCheckCard['Note'] {
  if (State === 'ok') return null;
  const Message = HealthSectionMessage(State, Client, Domain);
  return { ...Message, Tone: State === 'error' ? 'danger' : 'ghost' };
}

function PowerCard(Client: ClientView): SystemCheckCard {
  const Check: ClientPowerCheck | null = Client.SystemChecks?.Power ?? null;
  const State = GetPowerSectionState(Client);
  const Power = State === 'ok' ? (Client.PowerStatus ?? null) : null;
  const Alarms = AlarmsFor(Client, 'power');
  // Until a report says otherwise, every condition is assumed reportable.
  const Known = !!Power;
  const Battery = Power ? Power.Battery : null;
  return {
    Key: 'power',
    Title: CHECK_TITLES.power,
    Summary: Power ? PowerSummary(Power) : '',
    Monitored: !!Check,
    CanMonitor: !!Check || (State !== 'outdated' && State !== 'unsupported'),
    Badge: Badge('power', !!Check, Alarms.length > 0),
    Issues: Alarms.map((Alarm) => ResourceAlarmText(Alarm)),
    Rows: Check
      ? [
          Row('RequireMains', 'On mains power', {
            Value: Power && Power.OnBattery !== null ? (Power.OnBattery ? 'No' : 'Yes') : '—',
            Capable: !Known || Power!.OnBattery !== null,
            Checked: Check.RequireMains,
            Alarms,
          }),
          Row('MinBatteryPercent', 'Minimum battery', {
            Input: NumberInput('MinBatteryPercent', Check.MinBatteryPercent),
            Capable: !Known || !!(Battery && Battery.Percent !== null),
            Checked: Check.MinBatteryPercent !== null,
            Alarms,
          }),
          Row('ChargingBelowPercent', 'Charging when below', {
            Input: NumberInput('ChargingBelowPercent', Check.ChargingBelowPercent),
            Capable: !Known || !!(Battery && Battery.Charging !== null),
            Checked: Check.ChargingBelowPercent !== null,
            Alarms,
          }),
        ]
      : [],
    Note: DomainNote(Client, State, 'power'),
  };
}

function ThermalCard(Client: ClientView): SystemCheckCard {
  const Check: ClientThermalCheck | null = Client.SystemChecks?.Thermal ?? null;
  const State = GetTemperatureSectionState(Client);
  const Snapshot = State === 'ok' ? (Client.Temperatures ?? null) : null;
  const Alarms = AlarmsFor(Client, 'thermal');
  const Known = !!Snapshot;
  return {
    Key: 'thermal',
    Title: CHECK_TITLES.thermal,
    Summary: Snapshot ? ThermalSummary(Snapshot) : '',
    Monitored: !!Check,
    CanMonitor: !!Check || (State !== 'outdated' && State !== 'unsupported'),
    Badge: Badge('thermal', !!Check, Alarms.length > 0),
    Issues: Alarms.map((Alarm) => ResourceAlarmText(Alarm)),
    Rows: Check
      ? [
          Row('MaxCelsius', 'Maximum temperature', {
            Input: NumberInput('MaxCelsius', Check.MaxCelsius),
            Capable: !Known || Snapshot!.Sensors.length > 0,
            Checked: Check.MaxCelsius !== null,
            Alarms,
          }),
          Row('MaxThermalState', 'Maximum thermal state', {
            Input: {
              Kind: 'select',
              Value: Check.MaxThermalState ?? '',
              Default: SYSTEM_CONDITION_DEFAULTS.MaxThermalState,
              Unit: '',
              Options: THERMAL_STATE_OPTIONS,
            },
            Capable: !Known || Snapshot!.ThermalState !== null,
            Checked: Check.MaxThermalState !== null,
            Alarms,
          }),
        ]
      : [],
    Note: DomainNote(Client, State, 'temperature'),
  };
}

/** Every card for one check key. */
export function SystemCheckCardFor(Client: ClientView, Key: ClientSystemCheckKey): SystemCheckCard {
  switch (Key) {
    case 'cpu':
    case 'ram':
      return UsageCard(Client, Key);
    case 'uptime':
      return UptimeCard(Client);
    case 'power':
      return PowerCard(Client);
    case 'thermal':
    default:
      return ThermalCard(Client);
  }
}

/** The fields each check's request carries, in table order. */
export const SYSTEM_CHECK_FIELDS: Record<ClientSystemCheckKey, SystemConditionField[]> = {
  cpu: ['MaxPercent', 'SustainSeconds'],
  ram: ['MaxPercent', 'SustainSeconds'],
  uptime: ['MaxDays'],
  power: ['RequireMains', 'MinBatteryPercent', 'ChargingBelowPercent'],
  thermal: ['MaxCelsius', 'MaxThermalState'],
};

const FIELD_LABELS: Record<SystemConditionField, string> = {
  MaxPercent: 'Maximum usage',
  SustainSeconds: 'Sustain time',
  MaxDays: 'Maximum uptime',
  RequireMains: 'Mains power',
  MinBatteryPercent: 'Minimum battery',
  ChargingBelowPercent: 'Charging level',
  MaxCelsius: 'Maximum temperature',
  MaxThermalState: 'Maximum thermal state',
};

/**
 * Read a conditions table back into a request. Each value is what the row
 * shows: a tick (RequireMains), a limit typed into a ticked row, '' for an
 * unticked row (stop guarding it). Fields a card did not render are omitted,
 * which leaves them as they are.
 */
export function ParseSystemCheckFields(
  Key: ClientSystemCheckKey,
  Fields: Partial<Record<SystemConditionField, string | boolean>>
): { Payload: Record<string, unknown> } | { Error: string } {
  const Payload: Record<string, unknown> = { Key };
  for (const Field of SYSTEM_CHECK_FIELDS[Key]) {
    const Raw = Fields[Field];
    if (Raw === undefined) continue;
    if (Field === 'RequireMains') {
      Payload.RequireMains = Raw === true;
      continue;
    }
    const Text = String(Raw).trim();
    if (Field === 'MaxThermalState') {
      if (Text && !THERMAL_STATE_OPTIONS.some((Option) => Option.Value === Text)) {
        return { Error: 'Choose a thermal state' };
      }
      Payload.MaxThermalState = Text || null;
      continue;
    }
    const Limit = LIMITS[Field]!;
    if (!Text) {
      // The sustain time always applies; an emptied field keeps what is saved.
      if (Field !== 'SustainSeconds') Payload[Field] = null;
      continue;
    }
    const n = Number(Text);
    if (!Number.isInteger(n) || n < Limit.Min || n > Limit.Max) {
      return {
        Error: `${FIELD_LABELS[Field]} must be a whole number from ${Limit.Min} to ${Limit.Max}${Limit.Unit === '%' ? '%' : ` ${Limit.Unit}`}`,
      };
    }
    Payload[Field] = n;
  }
  return { Payload };
}

/** Status-tab order: the machine first, then what it runs on. */
export const SYSTEM_CHECK_ORDER: ClientSystemCheckKey[] = [
  'cpu',
  'ram',
  'uptime',
  'power',
  'thermal',
];

/**
 * A monitored check's live line on the Status tab, in the timeline palette:
 * IDLE while there is nothing to judge, DEGRADED with the first issue while a
 * condition fails, ONLINE with the reading otherwise.
 */
export function SystemCheckLiveState(
  Client: ClientView,
  Card: SystemCheckCard
): { State: 'IDLE' | 'ONLINE' | 'DEGRADED'; Label: string } {
  if (!Client.Online) return { State: 'IDLE', Label: 'Offline' };
  if (Card.Note) return { State: 'IDLE', Label: Card.Note.Title };
  // The issue and its reading only: the limit and the duration are on the card,
  // and the status line has room for one short phrase.
  if (Card.Issues.length) {
    const Short = Card.Issues[0]!.replace(/ \([^)]*\)/, '').replace(/ for [^—]*$/, '');
    return { State: 'DEGRADED', Label: Short };
  }
  return { State: 'ONLINE', Label: Card.Summary || 'Healthy' };
}
