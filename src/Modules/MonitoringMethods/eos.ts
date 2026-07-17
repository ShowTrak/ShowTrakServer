// ETC Eos console health over OSC. Opens one connection, pings the console
// (round-trip liveness + latency) and reads the software version, reporting a
// single online / offline verdict. Protocol client, snapshot cache and shared
// semantics live in ./_eos-shared. Optionally asserts the reported software
// version starts with an expected prefix.
import {
  CommonEosSettings,
  ParseEosConfig,
  RunEosProbe,
  EosSnapshotExtras,
  EosStatePill,
  EosDebugHead,
  type EosSnapshot,
} from './_eos-shared';
import { TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'eos';

const Settings: MonitoringSettingField[] = [
  ...CommonEosSettings,
  {
    Key: 'ExpectedVersion',
    Label: 'Expected software version prefix (blank = any, e.g. 3.2)',
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
function EvaluateHealth(Snapshot: EosSnapshot, ExpectedVersion: string): string | null {
  if (ExpectedVersion && Snapshot.Version && !Snapshot.Version.startsWith(ExpectedVersion)) {
    return `Version ${Snapshot.Version} (expected ${ExpectedVersion}…)`;
  }
  return null;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunEosProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reason = EvaluateHealth(Snapshot, ParseExpectedVersion(Target));

  return {
    Success: true,
    ...(Reason ? { Degraded: true, DegradedReason: Reason } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...EosSnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseEosConfig(Target);
  const Expected = ParseExpectedVersion(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(
      TextRow('Software', String(Result.EosVersion || 'Unknown') + (Expected ? ` (expected ${Expected}…)` : ''))
    );
    if (Result.ShowName != null && Result.ShowName !== '') {
      ExtraRows.push(TextRow('Show', String(Result.ShowName)));
    }
    if (Result.ActiveCue != null && Result.ActiveCue !== '') {
      ExtraRows.push(TextRow('Active cue', String(Result.ActiveCue)));
    }
  }

  return EosDebugHead(Config, Result, EosStatePill(Result, 'Online'), ExtraRows);
}

export const Name = 'Console Health (ETC Eos)';
export const Description =
  'Connects to an ETC Eos-family console (Eos Ti, Gio, Ion Xe, Element, ETCnomad) over OSC (default TCP 3032), pings it for a round-trip liveness check and reads the software version. Online when the console answers; can flag an unexpected software version.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseExpectedVersion, EvaluateHealth };
export { ID, Settings, Run, Debug };
