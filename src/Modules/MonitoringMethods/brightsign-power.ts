// BrightSign power source check. Reads the `power` block from the Local DWS
// /api/v1/info endpoint and reports degraded when the player is running on (or
// discharging) a battery, or when the power source is not the one you expect.
//
// The DWS reports the power SOURCE and battery state only — there are no
// voltage or current readings anywhere in the API.
//
// Note the power block can independently fail while the endpoint still returns
// HTTP 200, in which case the player reports an error string instead of a
// reading; that is surfaced as degraded rather than offline, since the player
// itself is plainly answering.
import {
  CommonBrightSignSettings,
  RunBrightSignProbe,
  ParseBrightSignConfig,
  ReadPower,
  ClassifyPower,
  StatePill,
  BrightSignDebug,
  MonoRow,
  INFO_PATH,
} from './_brightsign-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'brightsign-power';

const Settings: MonitoringSettingField[] = [
  ...CommonBrightSignSettings,
  {
    Key: 'ExpectedSource',
    Label: 'Expected power source (e.g. AC, blank = any)',
    Type: 'string',
    Default: '',
  },
];

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunBrightSignProbe(Target, INFO_PATH);
  if ('Result' in Probe) return Probe.Result;
  const { Payload, LatencyMs } = Probe.Ctx;

  const Power = ReadPower(Payload);
  const Expected = String(((Target && Target.Settings) || {}).ExpectedSource ?? '').trim();

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs,
    PowerSource: Power.Source,
    Battery: Power.Battery,
    SwitchMode: Power.SwitchMode,
    Expected: Expected || null,
  };

  if (Power.Error) {
    return { ...Base, Degraded: true, DegradedReason: `Power not reported: ${Power.Error}` };
  }

  const Reasons: string[] = [];
  const Classification = ClassifyPower(Power.Source, Power.Battery);
  if (Classification.Degraded && Classification.Reason) Reasons.push(Classification.Reason);

  if (Expected && Power.Source && Power.Source.toLowerCase() !== Expected.toLowerCase()) {
    Reasons.push(`Source ${Power.Source} (expected ${Expected})`);
  }

  if (Reasons.length) {
    return { ...Base, Degraded: true, DegradedReason: Reasons.join('; ') };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseBrightSignConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Pill = StatePill(Result, 'Normal');

  return BrightSignDebug(Config, Result, Pill, [
    Reachable ? MonoRow('Source', Result.PowerSource || '—') : null,
    Reachable ? MonoRow('Battery', Result.Battery || '—') : null,
    Reachable && Result.SwitchMode ? MonoRow('Switch mode', Result.SwitchMode) : null,
    Reachable && Result.Expected ? MonoRow('Expected source', Result.Expected) : null,
  ]);
}

export const Name = 'Player Power Source (BrightSign)';
export const Description =
  "Reads the power source and battery state from a BrightSign player's Local DWS API and reports degraded when it is running on battery or not on the expected source.";
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
