// ETC Eos show-loaded check. Reads the cue-list count and patch count over OSC
// (both direct /eos/get request/response queries) and reports Degraded when the
// console is reachable but appears to be running an empty / default show — a
// quick way to catch a desk that is powered and online but has the wrong show
// (or no show) loaded. Shares the per-console snapshot with ./eos via
// ./_eos-shared.
import {
  CommonEosSettings,
  ParseEosConfig,
  RunEosProbe,
  EosSnapshotExtras,
  EosStatePill,
  EosDebugHead,
  MonoRow,
  type EosSnapshot,
} from './_eos-shared';
import { TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'eos-show';

const Settings: MonitoringSettingField[] = [
  ...CommonEosSettings,
  {
    Key: 'MinCueLists',
    Label: 'Minimum cue lists',
    Type: 'number',
    Default: 1,
    Min: 0,
    Max: 1000,
  },
  {
    Key: 'MinPatch',
    Label: 'Minimum patched channels',
    Type: 'number',
    Default: 1,
    Min: 0,
    Max: 100000,
  },
];

interface ShowOptions {
  MinCueLists: number;
  MinPatch: number;
}

function ParseShowOptions(Target: MonitoringTargetLike): ShowOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Lists = Number(Cfg.MinCueLists);
  const Patch = Number(Cfg.MinPatch);
  return {
    MinCueLists: Number.isFinite(Lists) ? Math.max(0, Lists | 0) : 1,
    MinPatch: Number.isFinite(Patch) ? Math.max(0, Patch | 0) : 1,
  };
}

// The reasons a reachable console looks like it has no real show loaded. Counts
// that the console did not report within the probe window are treated as
// unknown (never a failure). Pure — exported via _internal for unit tests.
function EvaluateShow(Snapshot: EosSnapshot, Options: ShowOptions): string[] {
  const Reasons: string[] = [];
  if (
    Options.MinCueLists > 0 &&
    Snapshot.CuelistCount != null &&
    Snapshot.CuelistCount < Options.MinCueLists
  ) {
    Reasons.push(
      Snapshot.CuelistCount === 0
        ? 'No cue lists programmed'
        : `${Snapshot.CuelistCount} cue lists (expected ≥ ${Options.MinCueLists})`
    );
  }
  if (
    Options.MinPatch > 0 &&
    Snapshot.PatchCount != null &&
    Snapshot.PatchCount < Options.MinPatch
  ) {
    Reasons.push(
      Snapshot.PatchCount === 0
        ? 'Nothing patched'
        : `${Snapshot.PatchCount} channels patched (expected ≥ ${Options.MinPatch})`
    );
  }
  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunEosProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reasons = EvaluateShow(Snapshot, ParseShowOptions(Target));

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...EosSnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseEosConfig(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    if (Result.ShowName != null && Result.ShowName !== '') {
      ExtraRows.push(TextRow('Show', String(Result.ShowName)));
    }
    ExtraRows.push(
      MonoRow('Cue lists', Result.CuelistCount != null ? String(Result.CuelistCount) : 'unknown')
    );
    ExtraRows.push(
      MonoRow('Patched channels', Result.PatchCount != null ? String(Result.PatchCount) : 'unknown')
    );
  }

  return EosDebugHead(Config, Result, EosStatePill(Result, 'Show loaded'), ExtraRows);
}

export const Name = 'Show Loaded (ETC Eos)';
export const Description =
  'Reads the cue-list and patch counts from an ETC Eos console over OSC and reports Degraded when it is reachable but appears to have an empty or default show loaded — catches a desk that is online but running the wrong (or no) show.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseShowOptions, EvaluateShow };
export { ID, Settings, Run, Debug };
