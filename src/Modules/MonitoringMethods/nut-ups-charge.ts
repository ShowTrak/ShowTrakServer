// NUT UPS battery-charge check. Reads the `battery.charge` variable (percent) and
// reports Degraded when it drops below a configurable minimum. Useful to catch a
// UPS that is charged too low to ride through an outage even while on mains.
//
// Result semantics:
//   - No connection / UPS not found                    -> offline / degraded (shared)
//   - battery.charge not readable                       -> degraded ("Charge unavailable")
//   - charge < MinCharge                                -> degraded ("Battery charge low")
//   - charge >= MinCharge                               -> online
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

const ID = 'nut-ups-charge';
const DEFAULT_MIN_CHARGE = 50;

// Inline threshold fields render before the advanced (auth/timeout) fields
// regardless of array position, so appending to CommonNutSettings is fine.
const Settings: MonitoringSettingField[] = [
  ...CommonNutSettings,
  {
    Key: 'MinCharge',
    Label: 'Minimum charge (%)',
    Type: 'number',
    Default: DEFAULT_MIN_CHARGE,
    Min: 0,
    Max: 100,
  },
];

function MinChargeOf(Target: MonitoringTargetLike): number {
  const Raw = Target && Target.Settings ? (Target.Settings.MinCharge as unknown) : undefined;
  const Num = Number(Raw);
  return Number.isFinite(Num) ? Math.max(0, Math.min(100, Num)) : DEFAULT_MIN_CHARGE;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunNutProbe(Target, ['battery.charge']);
  if ('Result' in Probe) return Probe.Result;
  const { Probe: P } = Probe.Ctx;

  const MinCharge = MinChargeOf(Target);
  const Charge = ParseNumber(P.Vars['battery.charge']);

  if (Charge == null) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Charge unavailable',
      LatencyMs: P.LatencyMs,
      BatteryCharge: null,
      MinCharge,
      UpsList: P.UpsNames,
    };
  }

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: P.LatencyMs,
    BatteryCharge: Charge,
    MinCharge,
    UpsList: P.UpsNames,
  };
  if (Charge < MinCharge) {
    return {
      ...Base,
      Degraded: true,
      DegradedReason: `Battery charge low (${Charge}% < ${MinCharge}%)`,
    };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseNutConfig(Target);
  const Pill = StatePill(Result, 'Charged');
  const Charge = Result && Result.BatteryCharge != null ? `${Result.BatteryCharge}%` : '—';
  const Min = Result && Result.MinCharge != null ? `${Result.MinCharge}%` : `${MinChargeOf(Target)}%`;
  return NutDebug(Config, Result, Pill, [
    Result && Result.Success === true ? MonoRow('battery.charge', Charge) : null,
    Result && Result.Success === true ? MonoRow('Minimum', Min) : null,
  ]);
}

export const Name = 'UPS Battery Charge (NUT)';
export const Description =
  'Reads battery.charge from a NUT upsd server and reports degraded when the battery charge falls below a configurable minimum percentage.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
