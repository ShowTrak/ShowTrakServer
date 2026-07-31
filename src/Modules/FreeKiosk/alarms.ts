// Threshold evaluation for FreeKiosk terminals.
//
// Pure and I/O-free: it takes this poll's readings, the terminal's stored alarm
// settings and the previous poll's readings, and returns one verdict per armed
// metric. The terminal's Tick() turns those verdicts into Degraded + a warning
// list; the AlertsManager turns the false->true edges into alerts.
//
// Two rules run through everything here:
//   - An operator states the ALARM condition, not the healthy one (see the note
//     on FreeKioskOperator in ./metrics).
//   - A metric with no reading NEVER breaches. A device that lacks a light
//     sensor, or a poll that failed, must not satisfy a "below" alarm — absence
//     of evidence is not evidence of a fault.
import {
  FREEKIOSK_METRICS,
  FREEKIOSK_METRICS_BY_KEY,
  AlarmFieldKeys,
  FormatMetricValue,
  IsMetricActive,
  type FreeKioskMetric,
  type FreeKioskOperator,
} from './metrics';

export type FreeKioskReading = string | number | boolean | null;

export interface FreeKioskAlarmConfig {
  Key: string;
  Enabled: boolean;
  Operator: FreeKioskOperator;
  Value: unknown;
  Value2: unknown;
}

export interface FreeKioskAlarmResult {
  Key: string;
  Label: string;
  Breach: boolean;
  Value: FreeKioskReading;
  Operator: FreeKioskOperator;
  Threshold: unknown;
  Threshold2: unknown;
  Unit: string | null;
  /** Human-readable, and the exact text shown on the tile. Null when not breaching. */
  Reason: string | null;
}

function AsBoolean(Value: unknown): boolean | null {
  if (typeof Value === 'boolean') return Value;
  if (Value == null || Value === '') return null;
  const Text = String(Value).trim().toLowerCase();
  if (Text === 'true' || Text === '1' || Text === 'yes') return true;
  if (Text === 'false' || Text === '0' || Text === 'no') return false;
  return null;
}

function AsNumber(Value: unknown): number | null {
  if (Value == null || Value === '') return null;
  const Parsed = Number(Value);
  return Number.isFinite(Parsed) ? Parsed : null;
}

/**
 * Read the flat `A_<Key>_On/_Op/_V/_V2` settings record into one config per
 * metric. Unknown keys (a metric removed in a later version) are dropped rather
 * than carried, so a stale show file cannot resurrect an alarm nothing evaluates.
 */
export function ParseAlarmSettings(Settings: unknown): Map<string, FreeKioskAlarmConfig> {
  const Source = (Settings && typeof Settings === 'object' ? Settings : {}) as Record<
    string,
    unknown
  >;
  const Configs = new Map<string, FreeKioskAlarmConfig>();

  for (const Metric of FREEKIOSK_METRICS) {
    if (!Metric.Operators.length) continue;
    const Keys = AlarmFieldKeys(Metric.Key);

    // A switched-off group force-disables every alarm inside it, and so does a
    // display mode the metric does not apply to. Doing it here, in the one
    // funnel every evaluation goes through, is what stops a threshold left over
    // from when the group was on firing against a metric nobody is watching any
    // more — the editor hides those fields, so nobody would even see where the
    // alert had come from. The mode gate matters more: a URL check left armed on
    // a terminal since switched to an external app would keep passing forever
    // against a page that is no longer on screen.
    const Enabled = AsBoolean(Source[Keys.On]) === true && IsMetricActive(Source, Metric);
    const Stored = Source[Keys.Op];
    const Requested = typeof Stored === 'string' ? (Stored as FreeKioskOperator) : null;
    // A single-operator metric renders no picker, and a stored operator the
    // metric no longer offers must not silently evaluate as something else.
    const Operator =
      Requested && Metric.Operators.includes(Requested)
        ? Requested
        : Metric.DefaultOperator || Metric.Operators[0]!;

    Configs.set(Metric.Key, {
      Key: Metric.Key,
      Enabled,
      Operator,
      Value: Source[Keys.V],
      Value2: Source[Keys.V2],
    });
  }

  return Configs;
}

function FormatThreshold(Metric: FreeKioskMetric, Value: unknown): string {
  if (Metric.Type === 'number') {
    const Parsed = AsNumber(Value);
    return Parsed == null ? '?' : FormatMetricValue(Metric, Parsed);
  }
  if (Metric.Type === 'boolean') {
    const Parsed = AsBoolean(Value);
    return Parsed == null ? '?' : Parsed ? 'Yes' : 'No';
  }
  const Text = String(Value ?? '').trim();
  return Text === '' ? '?' : Text;
}

function BuildReason(
  Metric: FreeKioskMetric,
  Operator: FreeKioskOperator,
  Value: FreeKioskReading,
  Previous: FreeKioskReading,
  Threshold: unknown,
  Threshold2: unknown
): string {
  const Shown = FormatMetricValue(Metric, Value);
  const Want = FormatThreshold(Metric, Threshold);
  const Want2 = FormatThreshold(Metric, Threshold2);

  switch (Operator) {
    case 'below':
      return `${Metric.Label} ${Shown} is below ${Want}`;
    case 'above':
      return `${Metric.Label} ${Shown} is above ${Want}`;
    case 'outside':
      return `${Metric.Label} ${Shown} is outside ${Want}–${Want2}`;
    case 'inside':
      return `${Metric.Label} ${Shown} is within ${Want}–${Want2}`;
    case 'is':
      // "Displaying Content: No", "Power Source: none" — terse on purpose, since
      // this is the text that has to fit on a tile.
      return `${Metric.Label}: ${Shown}`;
    case 'isNot':
      return `${Metric.Label} is ${Shown} (expected ${Want})`;
    case 'contains':
      return `${Metric.Label} contains "${Want}"`;
    case 'notContains':
      return `${Metric.Label} does not contain "${Want}"`;
    case 'changes':
      return `${Metric.Label} changed (${FormatMetricValue(Metric, Previous)} → ${Shown})`;
    case 'decreases':
      return Metric.Key === 'device_uptime'
        ? `${Metric.Label} went backwards (${Shown}) — the device restarted`
        : `${Metric.Label} went backwards (${FormatMetricValue(Metric, Previous)} → ${Shown})`;
    default:
      return `${Metric.Label} ${Shown}`;
  }
}

function NotBreaching(
  Metric: FreeKioskMetric,
  Config: FreeKioskAlarmConfig,
  Value: FreeKioskReading
): FreeKioskAlarmResult {
  return {
    Key: Metric.Key,
    Label: Metric.Label,
    Breach: false,
    Value,
    Operator: Config.Operator,
    Threshold: Config.Value,
    Threshold2: Config.Value2,
    Unit: Metric.Unit ?? null,
    Reason: null,
  };
}

/**
 * Judge one metric. `Previous` is the same metric's reading from the last poll
 * and is only consulted by the edge operators; pass null on the first poll,
 * which correctly makes `changes` and `decreases` no-ops until there is
 * something to compare against.
 */
export function EvaluateMetricAlarm(
  Metric: FreeKioskMetric,
  Config: FreeKioskAlarmConfig,
  Value: FreeKioskReading,
  Previous: FreeKioskReading = null
): FreeKioskAlarmResult {
  const Idle = NotBreaching(Metric, Config, Value);
  if (!Config.Enabled) return Idle;
  if (Value == null) return Idle;

  const Operator = Config.Operator;
  let Breach = false;

  if (Operator === 'changes') {
    Breach = Previous != null && Previous !== Value;
  } else if (Operator === 'decreases') {
    const Now = AsNumber(Value);
    const Before = AsNumber(Previous);
    Breach = Now != null && Before != null && Now < Before;
  } else if (Metric.Type === 'number') {
    const Now = AsNumber(Value);
    const Limit = AsNumber(Config.Value);
    if (Now == null || Limit == null) return Idle;
    if (Operator === 'below') Breach = Now < Limit;
    else if (Operator === 'above') Breach = Now > Limit;
    // Equality on a number is not just for the Wi-Fi channel: rotation interval,
    // API level and the auto-brightness bounds all declare `is` too, and every
    // one of them used to fall through to the range branch, find no upper bound
    // and return "not breaching" for ever.
    else if (Operator === 'is') Breach = Now === Limit;
    else if (Operator === 'isNot') Breach = Now !== Limit;
    else {
      const Upper = AsNumber(Config.Value2);
      if (Upper == null) return Idle;
      // Tolerate the bounds being entered the wrong way round rather than
      // silently never firing.
      const Low = Math.min(Limit, Upper);
      const High = Math.max(Limit, Upper);
      if (Operator === 'outside') Breach = Now < Low || Now > High;
      else if (Operator === 'inside') Breach = Now >= Low && Now <= High;
    }
  } else if (Metric.Type === 'boolean') {
    const Now = AsBoolean(Value);
    const Want = AsBoolean(Config.Value);
    if (Now == null || Want == null) return Idle;
    if (Operator === 'is') Breach = Now === Want;
    else if (Operator === 'isNot') Breach = Now !== Want;
  } else {
    const Now = String(Value);
    const Want = String(Config.Value ?? '').trim();
    // An equality or substring alarm with nothing to compare against is not
    // configured yet; firing on the empty string would alarm every terminal.
    if (Want === '') return Idle;
    const NowLower = Now.toLowerCase();
    const WantLower = Want.toLowerCase();
    if (Operator === 'is') Breach = NowLower === WantLower;
    else if (Operator === 'isNot') Breach = NowLower !== WantLower;
    else if (Operator === 'contains') Breach = NowLower.includes(WantLower);
    else if (Operator === 'notContains') Breach = !NowLower.includes(WantLower);
  }

  if (!Breach) return Idle;

  return {
    ...Idle,
    Breach: true,
    Reason: BuildReason(Metric, Operator, Value, Previous, Config.Value, Config.Value2),
  };
}

/** Judge every armed metric. Returns results for armed metrics only. */
export function EvaluateAllAlarms(
  Values: Record<string, FreeKioskReading>,
  Settings: unknown,
  PreviousValues: Record<string, FreeKioskReading> | null = null
): FreeKioskAlarmResult[] {
  const Configs = ParseAlarmSettings(Settings);
  const Results: FreeKioskAlarmResult[] = [];

  for (const [Key, Config] of Configs) {
    if (!Config.Enabled) continue;
    const Metric = FREEKIOSK_METRICS_BY_KEY.get(Key);
    if (!Metric) continue;
    Results.push(
      EvaluateMetricAlarm(
        Metric,
        Config,
        Values[Key] ?? null,
        PreviousValues ? (PreviousValues[Key] ?? null) : null
      )
    );
  }

  return Results;
}

const REASON_SUMMARY_LIMIT = 3;

/**
 * Collapse breaches into the one line the tile and the status card show. Three
 * reasons then "+N more" — the same treatment a monitoring target gives a
 * multi-fault verdict, so a terminal with a dozen alarms still reads.
 */
export function BuildDegradedReason(Results: readonly FreeKioskAlarmResult[]): string {
  const Reasons = Results.filter((Result) => Result.Breach && Result.Reason).map(
    (Result) => Result.Reason as string
  );
  if (!Reasons.length) return '';
  if (Reasons.length <= REASON_SUMMARY_LIMIT) return Reasons.join(' · ');
  const Head = Reasons.slice(0, REASON_SUMMARY_LIMIT).join(' · ');
  return `${Head} · +${Reasons.length - REASON_SUMMARY_LIMIT} more`;
}
