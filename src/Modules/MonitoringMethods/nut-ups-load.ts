// NUT UPS load check. Reads the `ups.load` variable (percent of rated capacity)
// and reports Degraded when it rises above a configurable maximum — an early
// warning that the UPS is close to overload and its runtime is shrinking.
//
// Result semantics:
//   - No connection / UPS not found                    -> offline / degraded (shared)
//   - ups.load not readable                             -> degraded ("Load unavailable")
//   - load > MaxLoad                                    -> degraded ("Load high")
//   - load <= MaxLoad                                   -> online
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

const ID = 'nut-ups-load';
const DEFAULT_MAX_LOAD = 80;

const Settings: MonitoringSettingField[] = [
  ...CommonNutSettings,
  {
    Key: 'MaxLoad',
    Label: 'Maximum load (%)',
    Type: 'number',
    Default: DEFAULT_MAX_LOAD,
    Min: 1,
    Max: 100,
  },
];

function MaxLoadOf(Target: MonitoringTargetLike): number {
  const Raw = Target && Target.Settings ? (Target.Settings.MaxLoad as unknown) : undefined;
  const Num = Number(Raw);
  return Number.isFinite(Num) && Num > 0 ? Math.min(100, Num) : DEFAULT_MAX_LOAD;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunNutProbe(Target, ['ups.load']);
  if ('Result' in Probe) return Probe.Result;
  const { Probe: P } = Probe.Ctx;

  const MaxLoad = MaxLoadOf(Target);
  const Load = ParseNumber(P.Vars['ups.load']);

  if (Load == null) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Load unavailable',
      LatencyMs: P.LatencyMs,
      Load: null,
      MaxLoad,
      UpsList: P.UpsNames,
    };
  }

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: P.LatencyMs,
    Load,
    MaxLoad,
    UpsList: P.UpsNames,
  };
  if (Load > MaxLoad) {
    return { ...Base, Degraded: true, DegradedReason: `Load high (${Load}% > ${MaxLoad}%)` };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseNutConfig(Target);
  const Pill = StatePill(Result, 'Nominal');
  const Load = Result && Result.Load != null ? `${Result.Load}%` : '—';
  const Max = Result && Result.MaxLoad != null ? `${Result.MaxLoad}%` : `${MaxLoadOf(Target)}%`;
  return NutDebug(Config, Result, Pill, [
    Result && Result.Success === true ? MonoRow('ups.load', Load) : null,
    Result && Result.Success === true ? MonoRow('Maximum', Max) : null,
  ]);
}

export const Name = 'UPS Load (NUT)';
export const Description =
  'Reads ups.load from a NUT upsd server and reports degraded when the UPS load rises above a configurable maximum percentage.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
