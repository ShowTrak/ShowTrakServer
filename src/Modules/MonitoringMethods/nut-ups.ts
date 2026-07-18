// NUT UPS health check. Reads the useful NUT variables in one probe and decides
// whether the UPS is running normally or something is wrong. Reachability and
// ups.status are always evaluated; the charge / load / temperature / voltage
// factors are opt-in via their toggles (all off by default), so a fresh check is
// a plain reachability + power-state probe until you enable the readings you care
// about.
//
// Factors (each gated by its toggle; unsupported variables are skipped):
//   - ups.status         : must be OL; OB / LB / RB / OVER / ALARM / DISCHRG fail.
//   - battery.charge     : must be >= MinCharge (default 50%).            [CheckCharge]
//   - ups.load           : must be <= MaxLoad (default 90%).             [CheckLoad]
//   - ups.temperature    : must be <= MaxTemperature (default 45°C).     [CheckTemperature]
//   - input.voltage      : within an explicit Min/Max band, or nominal   [CheckVoltage]
//                          +/- VoltageTolerancePercent when Min/Max are 0.
//
// Result semantics:
//   - No connection / auth failure                     -> offline  (Success: false)
//   - UPS not found                                    -> degraded ("UPS not found")
//   - any factor breached                              -> degraded (combined reason)
//   - all evaluated factors within limits              -> online   (Success: true)
import {
  CommonNutSettings,
  RunNutProbe,
  ClassifyStatus,
  ParseNumber,
  ParseNutConfig,
  StatePill,
  NutDebug,
  MonoRow,
} from './_nut-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'nut-ups';

const DEFAULTS = {
  MinCharge: 50,
  MaxLoad: 90,
  MaxTemperature: 45,
  VoltageTolerancePercent: 15,
};

const Settings: MonitoringSettingField[] = [
  ...CommonNutSettings,
  {
    Key: 'CheckCharge',
    Label: 'Check battery charge',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when battery.charge falls below the minimum, even while on mains.',
  },
  {
    Key: 'MinCharge',
    Label: 'Minimum charge (%)',
    Type: 'number',
    Default: DEFAULTS.MinCharge,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckCharge', Equals: true },
  },
  {
    Key: 'CheckLoad',
    Label: 'Check load',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when ups.load rises above the maximum percentage of rated capacity.',
  },
  {
    Key: 'MaxLoad',
    Label: 'Maximum load (%)',
    Type: 'number',
    Default: DEFAULTS.MaxLoad,
    Min: 1,
    Max: 100,
    VisibleWhen: { Key: 'CheckLoad', Equals: true },
  },
  {
    Key: 'CheckTemperature',
    Label: 'Check temperature',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded above the maximum. Skipped when the UPS does not report a temperature.',
  },
  {
    Key: 'MaxTemperature',
    Label: 'Maximum temperature (°C)',
    Type: 'number',
    Default: DEFAULTS.MaxTemperature,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckTemperature', Equals: true },
  },
  {
    Key: 'CheckVoltage',
    Label: 'Check input voltage',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when input voltage leaves the accepted band. Skipped when voltage is not reported.',
  },
  {
    Key: 'MinVoltage',
    Label: 'Minimum voltage',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 600,
    VisibleWhen: { Key: 'CheckVoltage', Equals: true },
    Note: 'Set 0 to derive the band automatically from the UPS nominal voltage and the tolerance below.',
  },
  {
    Key: 'MaxVoltage',
    Label: 'Maximum voltage',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 600,
    VisibleWhen: { Key: 'CheckVoltage', Equals: true },
    Note: 'Set 0 to derive the band automatically from the UPS nominal voltage and the tolerance below.',
  },
  {
    Key: 'VoltageTolerancePercent',
    Label: 'Voltage tolerance (% of nominal)',
    Type: 'number',
    Default: DEFAULTS.VoltageTolerancePercent,
    Min: 1,
    Max: 50,
    Advanced: true,
    VisibleWhen: { Key: 'CheckVoltage', Equals: true },
    Note: 'Used only when Minimum/Maximum voltage are 0. Degraded when input voltage differs from nominal by more than this percentage.',
  },
];

interface HealthThresholds {
  MinCharge: number;
  MaxLoad: number;
  MaxTemperature: number;
  MinVoltage: number;
  MaxVoltage: number;
  VoltageTolerancePercent: number;
  // Per-factor enable flags. Absent (undefined) counts as enabled so callers that
  // pass a bare thresholds object — and pre-toggle saved checks — keep evaluating
  // every factor.
  CheckCharge?: boolean;
  CheckLoad?: boolean;
  CheckTemperature?: boolean;
  CheckVoltage?: boolean;
}

function ThresholdsOf(Target: MonitoringTargetLike): HealthThresholds {
  const Cfg = (Target && Target.Settings) || {};
  const Pick = (Key: 'MaxLoad' | 'MaxTemperature' | 'VoltageTolerancePercent'): number => {
    const Num = Number(Cfg[Key]);
    return Number.isFinite(Num) && Num > 0 ? Num : DEFAULTS[Key];
  };
  const PositiveOrZero = (Value: unknown): number => {
    const Num = Number(Value);
    return Number.isFinite(Num) && Num > 0 ? Num : 0;
  };
  return {
    MinCharge: Number.isFinite(Number(Cfg.MinCharge))
      ? Math.max(0, Math.min(100, Number(Cfg.MinCharge)))
      : DEFAULTS.MinCharge,
    MaxLoad: Pick('MaxLoad'),
    MaxTemperature: Pick('MaxTemperature'),
    MinVoltage: PositiveOrZero(Cfg.MinVoltage),
    MaxVoltage: PositiveOrZero(Cfg.MaxVoltage),
    VoltageTolerancePercent: Pick('VoltageTolerancePercent'),
    CheckCharge: Cfg.CheckCharge !== false,
    CheckLoad: Cfg.CheckLoad !== false,
    CheckTemperature: Cfg.CheckTemperature !== false,
    CheckVoltage: Cfg.CheckVoltage !== false,
  };
}

// Resolve the acceptable [lower, upper] voltage band. Explicit Min/Max win;
// otherwise a tolerance band around the reported nominal. Either bound may be
// null when it cannot be determined.
function ResolveVoltageBand(
  T: HealthThresholds,
  Nominal: number | null
): { Lower: number | null; Upper: number | null } {
  let Lower: number | null = T.MinVoltage > 0 ? T.MinVoltage : null;
  let Upper: number | null = T.MaxVoltage > 0 ? T.MaxVoltage : null;
  if (Lower == null && Upper == null && Nominal != null && Nominal > 0) {
    const Delta = (Nominal * T.VoltageTolerancePercent) / 100;
    Lower = Nominal - Delta;
    Upper = Nominal + Delta;
  }
  return { Lower, Upper };
}

// Evaluate the readings against the thresholds and return the list of failing
// factors (empty when healthy). Exported for unit tests.
export function EvaluateHealth(
  Readings: {
    Status?: string | null;
    Charge?: number | null;
    Load?: number | null;
    Temperature?: number | null;
    Voltage?: number | null;
    Nominal?: number | null;
  },
  T: HealthThresholds
): string[] {
  const Reasons: string[] = [];

  const Classification = ClassifyStatus(Readings.Status);
  if (Readings.Status != null && !Classification.Online) {
    Reasons.push(Classification.DegradedReason || 'Status abnormal');
  }

  if (T.CheckCharge !== false && Readings.Charge != null && Readings.Charge < T.MinCharge) {
    Reasons.push(`Charge ${Readings.Charge}% < ${T.MinCharge}%`);
  }
  if (T.CheckLoad !== false && Readings.Load != null && Readings.Load > T.MaxLoad) {
    Reasons.push(`Load ${Readings.Load}% > ${T.MaxLoad}%`);
  }
  if (
    T.CheckTemperature !== false &&
    Readings.Temperature != null &&
    Readings.Temperature > T.MaxTemperature
  ) {
    Reasons.push(`Temp ${Readings.Temperature}°C > ${T.MaxTemperature}°C`);
  }
  if (T.CheckVoltage !== false && Readings.Voltage != null) {
    const { Lower, Upper } = ResolveVoltageBand(T, Readings.Nominal ?? null);
    if (Lower != null && Readings.Voltage < Lower) {
      Reasons.push(`Input voltage low (${Readings.Voltage} V < ${Math.round(Lower)} V)`);
    } else if (Upper != null && Readings.Voltage > Upper) {
      Reasons.push(`Input voltage high (${Readings.Voltage} V > ${Math.round(Upper)} V)`);
    }
  }
  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunNutProbe(Target, [
    'ups.status',
    'battery.charge',
    'ups.load',
    'ups.temperature',
    'battery.temperature',
    'input.voltage',
    'input.voltage.nominal',
  ]);
  if ('Result' in Probe) return Probe.Result;
  const { Probe: P } = Probe.Ctx;

  const T = ThresholdsOf(Target);
  const Readings = {
    Status: P.Vars['ups.status'],
    Charge: ParseNumber(P.Vars['battery.charge']),
    Load: ParseNumber(P.Vars['ups.load']),
    Temperature:
      ParseNumber(P.Vars['ups.temperature']) ?? ParseNumber(P.Vars['battery.temperature']),
    Voltage: ParseNumber(P.Vars['input.voltage']),
    Nominal: ParseNumber(P.Vars['input.voltage.nominal']),
  };

  const Reasons = EvaluateHealth(Readings, T);
  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: P.LatencyMs,
    Status: Readings.Status,
    Tokens: ClassifyStatus(Readings.Status).Tokens,
    BatteryCharge: Readings.Charge,
    Load: Readings.Load,
    Temperature: Readings.Temperature,
    Voltage: Readings.Voltage,
    Nominal: Readings.Nominal,
    UpsList: P.UpsNames,
  };

  if (Reasons.length) {
    return { ...Base, Degraded: true, DegradedReason: Reasons.join('; ') };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseNutConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Pill = StatePill(Result, 'Healthy');

  const Fmt = (Value: unknown, Suffix: string): string =>
    Value == null ? '—' : `${Value}${Suffix}`;

  return NutDebug(Config, Result, Pill, [
    Reachable && Result.Status != null ? MonoRow('ups.status', String(Result.Status)) : null,
    Reachable ? MonoRow('Charge', Fmt(Result.BatteryCharge, '%')) : null,
    Reachable ? MonoRow('Load', Fmt(Result.Load, '%')) : null,
    Reachable && Result.Temperature != null ? MonoRow('Temp', Fmt(Result.Temperature, '°C')) : null,
    Reachable && Result.Voltage != null ? MonoRow('Input', Fmt(Result.Voltage, ' V')) : null,
  ]);
}

export const Name = 'UPS Health (NUT)';
export const Description =
  'Reads status, battery charge, load, temperature and input voltage from a NUT upsd server and reports a single healthy / degraded verdict using informed defaults.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { EvaluateHealth, ThresholdsOf };
export { ID, Settings, Run, Debug };
