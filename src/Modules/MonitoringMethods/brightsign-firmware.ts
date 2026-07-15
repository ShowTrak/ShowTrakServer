// BrightSign firmware version check. Reads FWVersion from the Local DWS
// /api/v1/info endpoint and compares it against an expected version, so
// unexpected firmware drift across a fleet surfaces as a degraded check.
//
// Leave Expected firmware blank to report the running version without alerting
// on it — useful as a passive inventory display in the debug panel.
import {
  CommonBrightSignSettings,
  RunBrightSignProbe,
  ParseBrightSignConfig,
  StatePill,
  BrightSignDebug,
  MonoRow,
  INFO_PATH,
} from './_brightsign-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'brightsign-firmware';

const Settings: MonitoringSettingField[] = [
  ...CommonBrightSignSettings,
  {
    Key: 'ExpectedFirmware',
    Label: 'Expected firmware (blank = report only)',
    Type: 'string',
    Default: '',
  },
];

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunBrightSignProbe(Target, INFO_PATH);
  if ('Result' in Probe) return Probe.Result;
  const { Payload, LatencyMs } = Probe.Ctx;

  const Info = (Payload || {}) as Record<string, unknown>;
  const Firmware = Info.FWVersion == null ? null : String(Info.FWVersion);
  const BootVersion = Info.bootVersion == null ? null : String(Info.bootVersion);
  const Expected = String(((Target && Target.Settings) || {}).ExpectedFirmware ?? '').trim();

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs,
    Firmware,
    BootVersion,
    Expected: Expected || null,
    Model: Info.model == null ? null : String(Info.model),
  };

  if (!Firmware) {
    return { ...Base, Degraded: true, DegradedReason: 'Player did not report a firmware version' };
  }
  if (Expected && Firmware !== Expected) {
    return { ...Base, Degraded: true, DegradedReason: `Firmware ${Firmware} (expected ${Expected})` };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseBrightSignConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Pill = StatePill(Result, Result && Result.Expected ? 'Match' : 'Reported');

  return BrightSignDebug(Config, Result, Pill, [
    Reachable ? MonoRow('FWVersion', Result.Firmware || '—') : null,
    Reachable && Result.BootVersion ? MonoRow('Boot version', Result.BootVersion) : null,
    Reachable && Result.Expected ? MonoRow('Expected', Result.Expected) : null,
    Reachable && Result.Model ? MonoRow('Model', Result.Model) : null,
  ]);
}

export const Name = 'Player Firmware (BrightSign)';
export const Description =
  "Reads the firmware version from a BrightSign player's Local DWS API and reports degraded when it does not match the expected version.";
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
