// Avolites Titan console health over the Titan WebAPI. Reads the software
// version (GET /titan/get/System/SoftwareVersion, TCP 4430) and reports a single
// online / offline verdict. Protocol client, snapshot cache and shared semantics
// live in ./_avolites-shared. Optionally asserts the reported Titan version
// starts with an expected prefix.
import {
  CommonAvolitesSettings,
  ParseAvolitesConfig,
  RunAvolitesProbe,
  AvolitesSnapshotExtras,
  AvolitesStatePill,
  AvolitesDebugHead,
  type TitanSnapshot,
} from './_avolites-shared';
import { TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'avolites';

const Settings: MonitoringSettingField[] = [
  ...CommonAvolitesSettings,
  {
    Key: 'ExpectedVersion',
    Label: 'Expected Titan version prefix (blank = any, e.g. 17)',
    Type: 'string',
    Default: '',
    Advanced: true,
  },
];

function ParseExpectedVersion(Target: MonitoringTargetLike): string {
  return String(((Target && Target.Settings) || {}).ExpectedVersion || '').trim();
}

// The degraded reason for a reachable console, or null when healthy. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: TitanSnapshot, ExpectedVersion: string): string | null {
  if (ExpectedVersion && Snapshot.Version && !Snapshot.Version.startsWith(ExpectedVersion)) {
    return `Titan ${Snapshot.Version} (expected ${ExpectedVersion}…)`;
  }
  return null;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunAvolitesProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reason = EvaluateHealth(Snapshot, ParseExpectedVersion(Target));

  return {
    Success: true,
    ...(Reason ? { Degraded: true, DegradedReason: Reason } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...AvolitesSnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseAvolitesConfig(Target);
  const Expected = ParseExpectedVersion(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(
      TextRow('Titan', String(Result.TitanVersion || 'Unknown') + (Expected ? ` (expected ${Expected}…)` : ''))
    );
    if (Result.ShowName != null && Result.ShowName !== '') {
      ExtraRows.push(TextRow('Show', String(Result.ShowName)));
    }
  }

  return AvolitesDebugHead(Config, Result, AvolitesStatePill(Result, 'Online'), ExtraRows);
}

export const Name = 'Console Health (Avolites Titan)';
export const Description =
  'Connects to an Avolites Titan console (Sapphire, Tiger Touch, Quartz, Arena, Diamond, Titan Go) over the Titan WebAPI (HTTP, TCP 4430) and reads the software version. Online when the WebAPI answers; can flag an unexpected Titan version. Requires the WebAPI to be enabled on the console.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseExpectedVersion, EvaluateHealth };
export { ID, Settings, Run, Debug };
