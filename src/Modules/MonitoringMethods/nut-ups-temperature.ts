// NUT UPS temperature check. Reads `ups.temperature` (falling back to
// `battery.temperature`, whichever the UPS reports) in degrees Celsius and
// reports Degraded above a configurable maximum. High internal temperature
// shortens battery life and can indicate a cooling or environmental problem.
//
// Result semantics:
//   - No connection / UPS not found                    -> offline / degraded (shared)
//   - neither temperature variable readable             -> degraded ("Temperature unavailable")
//   - temperature > MaxTemperature                       -> degraded ("Temperature high")
//   - temperature <= MaxTemperature                      -> online
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

const ID = 'nut-ups-temperature';
const DEFAULT_MAX_TEMPERATURE = 40;

const Settings: MonitoringSettingField[] = [
  ...CommonNutSettings,
  {
    Key: 'MaxTemperature',
    Label: 'Maximum temperature (°C)',
    Type: 'number',
    Default: DEFAULT_MAX_TEMPERATURE,
    Min: 0,
    Max: 100,
  },
];

function MaxTemperatureOf(Target: MonitoringTargetLike): number {
  const Raw = Target && Target.Settings ? (Target.Settings.MaxTemperature as unknown) : undefined;
  const Num = Number(Raw);
  return Number.isFinite(Num) ? Num : DEFAULT_MAX_TEMPERATURE;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunNutProbe(Target, ['ups.temperature', 'battery.temperature']);
  if ('Result' in Probe) return Probe.Result;
  const { Probe: P } = Probe.Ctx;

  const MaxTemperature = MaxTemperatureOf(Target);
  // Prefer ups.temperature; fall back to battery.temperature.
  const Temp =
    ParseNumber(P.Vars['ups.temperature']) ?? ParseNumber(P.Vars['battery.temperature']);

  if (Temp == null) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Temperature unavailable',
      LatencyMs: P.LatencyMs,
      Temperature: null,
      MaxTemperature,
      UpsList: P.UpsNames,
    };
  }

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: P.LatencyMs,
    Temperature: Temp,
    MaxTemperature,
    UpsList: P.UpsNames,
  };
  if (Temp > MaxTemperature) {
    return {
      ...Base,
      Degraded: true,
      DegradedReason: `Temperature high (${Temp}°C > ${MaxTemperature}°C)`,
    };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseNutConfig(Target);
  const Pill = StatePill(Result, 'Normal');
  const Temp = Result && Result.Temperature != null ? `${Result.Temperature}°C` : '—';
  const Max =
    Result && Result.MaxTemperature != null
      ? `${Result.MaxTemperature}°C`
      : `${MaxTemperatureOf(Target)}°C`;
  return NutDebug(Config, Result, Pill, [
    Result && Result.Success === true ? MonoRow('Temperature', Temp) : null,
    Result && Result.Success === true ? MonoRow('Maximum', Max) : null,
  ]);
}

export const Name = 'UPS Temperature (NUT)';
export const Description =
  'Reads ups.temperature (or battery.temperature) from a NUT upsd server and reports degraded above a configurable maximum in degrees Celsius.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
