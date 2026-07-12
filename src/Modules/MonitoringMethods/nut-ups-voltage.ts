// NUT UPS input-voltage check. Reads `input.voltage` (volts) and reports Degraded
// when the incoming mains voltage falls outside an acceptable band — catching
// brownouts and surges before the UPS is forced onto battery.
//
// The band is region-agnostic by default: it is derived from the UPS's own
// reported `input.voltage.nominal` +/- a tolerance percentage, so the same check
// works on 120 V and 230 V supplies. Explicit Min/Max volts override the nominal
// band when set (non-zero).
//
// Result semantics:
//   - No connection / UPS not found                    -> offline / degraded (shared)
//   - input.voltage not readable                        -> degraded ("Voltage unavailable")
//   - no band determinable (no nominal, no Min/Max)     -> online (reachable; cannot judge)
//   - voltage outside band                              -> degraded ("Input voltage low/high")
//   - voltage within band                               -> online
import {
  CommonNutSettings,
  RunNutProbe,
  ParseNumber,
  ParseNutConfig,
  StatePill,
  NutDebug,
  MonoRow,
} from './_nut-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'nut-ups-voltage';
const DEFAULT_TOLERANCE_PCT = 10;

const Settings: MonitoringSettingField[] = [
  ...CommonNutSettings,
  { Key: 'MinVoltage', Label: 'Minimum voltage (0 = auto)', Type: 'number', Default: 0, Min: 0, Max: 600 },
  { Key: 'MaxVoltage', Label: 'Maximum voltage (0 = auto)', Type: 'number', Default: 0, Min: 0, Max: 600 },
  {
    Key: 'TolerancePercent',
    Label: 'Auto tolerance (% of nominal)',
    Type: 'number',
    Default: DEFAULT_TOLERANCE_PCT,
    Min: 1,
    Max: 50,
    Advanced: true,
  },
];

interface VoltageConfig {
  MinVoltage: number;
  MaxVoltage: number;
  TolerancePercent: number;
}

function VoltageConfigOf(Target: MonitoringTargetLike): VoltageConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Min = Number(Cfg.MinVoltage);
  const Max = Number(Cfg.MaxVoltage);
  const Tol = Number(Cfg.TolerancePercent);
  return {
    MinVoltage: Number.isFinite(Min) && Min > 0 ? Min : 0,
    MaxVoltage: Number.isFinite(Max) && Max > 0 ? Max : 0,
    TolerancePercent: Number.isFinite(Tol) && Tol > 0 ? Tol : DEFAULT_TOLERANCE_PCT,
  };
}

// Resolve the acceptable [lower, upper] band. Explicit Min/Max win; otherwise a
// tolerance band around the reported nominal. Either bound may be null when it
// cannot be determined.
export function ResolveBand(
  Cfg: VoltageConfig,
  Nominal: number | null
): { Lower: number | null; Upper: number | null } {
  let Lower: number | null = Cfg.MinVoltage > 0 ? Cfg.MinVoltage : null;
  let Upper: number | null = Cfg.MaxVoltage > 0 ? Cfg.MaxVoltage : null;
  if (Lower == null && Upper == null && Nominal != null && Nominal > 0) {
    const Delta = (Nominal * Cfg.TolerancePercent) / 100;
    Lower = Nominal - Delta;
    Upper = Nominal + Delta;
  }
  return { Lower, Upper };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunNutProbe(Target, ['input.voltage', 'input.voltage.nominal']);
  if ('Result' in Probe) return Probe.Result;
  const { Probe: P } = Probe.Ctx;

  const Cfg = VoltageConfigOf(Target);
  const Voltage = ParseNumber(P.Vars['input.voltage']);
  const Nominal = ParseNumber(P.Vars['input.voltage.nominal']);

  if (Voltage == null) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Voltage unavailable',
      LatencyMs: P.LatencyMs,
      Voltage: null,
      Nominal,
      UpsList: P.UpsNames,
    };
  }

  const { Lower, Upper } = ResolveBand(Cfg, Nominal);
  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: P.LatencyMs,
    Voltage,
    Nominal,
    Lower,
    Upper,
    UpsList: P.UpsNames,
  };

  if (Lower != null && Voltage < Lower) {
    return {
      ...Base,
      Degraded: true,
      DegradedReason: `Input voltage low (${Voltage} V < ${Math.round(Lower)} V)`,
    };
  }
  if (Upper != null && Voltage > Upper) {
    return {
      ...Base,
      Degraded: true,
      DegradedReason: `Input voltage high (${Voltage} V > ${Math.round(Upper)} V)`,
    };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseNutConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Pill = StatePill(Result, 'In range');
  const Voltage = Result && Result.Voltage != null ? `${Result.Voltage} V` : '—';
  const Lower = Result && Result.Lower != null ? Math.round(Result.Lower as number) : null;
  const Upper = Result && Result.Upper != null ? Math.round(Result.Upper as number) : null;
  const Band = Lower != null || Upper != null ? `${Lower ?? '—'} – ${Upper ?? '—'} V` : 'no reference';
  return NutDebug(Config, Result, Pill, [
    Reachable ? MonoRow('input.voltage', Voltage) : null,
    Reachable ? MonoRow('Accepted band', Band) : null,
  ]);
}

export const Name = 'UPS Input Voltage (NUT)';
export const Description =
  'Reads input.voltage from a NUT upsd server and reports degraded when incoming mains voltage falls outside a band derived from the reported nominal (or explicit min/max).';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ResolveBand };
export { ID, Settings, Run, Debug };
