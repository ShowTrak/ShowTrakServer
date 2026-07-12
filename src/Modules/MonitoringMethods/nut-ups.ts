// NUT UPS combined health check. Reads the useful NUT variables in one probe and
// applies informed defaults to decide whether the UPS is running normally or
// something is wrong. This is the "just tell me if the UPS is healthy" method;
// the sibling nut-ups-status / -charge / -load / -temperature / -voltage methods
// isolate a single factor when you want to alert or threshold on just one.
//
// Factors evaluated (each configurable, unsupported variables are skipped):
//   - ups.status         : must be OL; OB / LB / RB / OVER / ALARM / DISCHRG fail.
//   - battery.charge     : must be >= MinCharge (default 50%).
//   - ups.load           : must be <= MaxLoad (default 90%).
//   - ups.temperature    : must be <= MaxTemperature (default 45°C), when reported.
//   - input.voltage      : within +/- VoltageTolerancePercent of nominal (default 15%),
//                          when both voltage and nominal are reported.
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
    Key: 'MinCharge',
    Label: 'Minimum charge (%)',
    Type: 'number',
    Default: DEFAULTS.MinCharge,
    Min: 0,
    Max: 100,
  },
  {
    Key: 'MaxLoad',
    Label: 'Maximum load (%)',
    Type: 'number',
    Default: DEFAULTS.MaxLoad,
    Min: 1,
    Max: 100,
  },
  {
    Key: 'MaxTemperature',
    Label: 'Maximum temperature (°C)',
    Type: 'number',
    Default: DEFAULTS.MaxTemperature,
    Min: 0,
    Max: 100,
    Advanced: true,
  },
  {
    Key: 'VoltageTolerancePercent',
    Label: 'Voltage tolerance (% of nominal)',
    Type: 'number',
    Default: DEFAULTS.VoltageTolerancePercent,
    Min: 1,
    Max: 50,
    Advanced: true,
  },
];

interface HealthThresholds {
  MinCharge: number;
  MaxLoad: number;
  MaxTemperature: number;
  VoltageTolerancePercent: number;
}

function ThresholdsOf(Target: MonitoringTargetLike): HealthThresholds {
  const Cfg = (Target && Target.Settings) || {};
  const Pick = (Key: keyof HealthThresholds): number => {
    const Num = Number(Cfg[Key]);
    return Number.isFinite(Num) && Num > 0 ? Num : DEFAULTS[Key];
  };
  return {
    MinCharge: Number.isFinite(Number(Cfg.MinCharge))
      ? Math.max(0, Math.min(100, Number(Cfg.MinCharge)))
      : DEFAULTS.MinCharge,
    MaxLoad: Pick('MaxLoad'),
    MaxTemperature: Pick('MaxTemperature'),
    VoltageTolerancePercent: Pick('VoltageTolerancePercent'),
  };
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

  if (Readings.Charge != null && Readings.Charge < T.MinCharge) {
    Reasons.push(`Charge ${Readings.Charge}% < ${T.MinCharge}%`);
  }
  if (Readings.Load != null && Readings.Load > T.MaxLoad) {
    Reasons.push(`Load ${Readings.Load}% > ${T.MaxLoad}%`);
  }
  if (Readings.Temperature != null && Readings.Temperature > T.MaxTemperature) {
    Reasons.push(`Temp ${Readings.Temperature}°C > ${T.MaxTemperature}°C`);
  }
  if (Readings.Voltage != null && Readings.Nominal != null && Readings.Nominal > 0) {
    const Delta = (Readings.Nominal * T.VoltageTolerancePercent) / 100;
    if (Math.abs(Readings.Voltage - Readings.Nominal) > Delta) {
      Reasons.push(`Voltage ${Readings.Voltage} V vs ${Readings.Nominal} V nominal`);
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
