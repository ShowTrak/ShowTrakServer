// BrightSign Power over Ethernet check. Reads the `poe` block from the Local
// DWS /api/v1/info endpoint and reports the PoE status.
//
// Only "not_supported" is documented; the rest of the vocabulary is not. So
// rather than matching against a guessed list of healthy values, this check
// treats "not_supported" as degraded — if you have added a PoE check to a
// player, hardware that cannot do PoE is a configuration mistake worth
// surfacing — and otherwise reports whatever the player says, optionally
// asserting it equals an expected status you configure.
import {
  CommonBrightSignSettings,
  RunBrightSignProbe,
  ParseBrightSignConfig,
  SubResult,
  StatePill,
  BrightSignDebug,
  MonoRow,
  INFO_PATH,
} from './_brightsign-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'brightsign-poe';

const Settings: MonitoringSettingField[] = [
  ...CommonBrightSignSettings,
  {
    Key: 'ExpectedStatus',
    Label: 'Expected PoE status (blank = any supported)',
    Type: 'string',
    Default: '',
  },
];

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunBrightSignProbe(Target, INFO_PATH);
  if ('Result' in Probe) return Probe.Result;
  const { Payload, LatencyMs } = Probe.Ctx;

  const Poe = SubResult(Payload, 'poe');
  const Value = (Poe.Value || {}) as Record<string, unknown>;
  const Status = Value.status == null ? null : String(Value.status);
  const Expected = String(((Target && Target.Settings) || {}).ExpectedStatus ?? '').trim();

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs,
    PoeStatus: Status,
    Expected: Expected || null,
  };

  if (Poe.Error) {
    return { ...Base, Degraded: true, DegradedReason: `PoE not reported: ${Poe.Error}` };
  }
  if (!Status) {
    return { ...Base, Degraded: true, DegradedReason: 'Player did not report a PoE status' };
  }
  if (Status.toLowerCase() === 'not_supported') {
    return { ...Base, Degraded: true, DegradedReason: 'PoE not supported on this player' };
  }
  if (Expected && Status.toLowerCase() !== Expected.toLowerCase()) {
    return { ...Base, Degraded: true, DegradedReason: `PoE ${Status} (expected ${Expected})` };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseBrightSignConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Pill = StatePill(Result, 'Powered');

  return BrightSignDebug(Config, Result, Pill, [
    Reachable ? MonoRow('PoE status', Result.PoeStatus || '—') : null,
    Reachable && Result.Expected ? MonoRow('Expected', Result.Expected) : null,
  ]);
}

export const Name = 'Player PoE Status (BrightSign)';
export const Description =
  "Reads the Power over Ethernet status from a BrightSign player's Local DWS API. Reports degraded when the player hardware does not support PoE or the status is not the expected one.";
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
