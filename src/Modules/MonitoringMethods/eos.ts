// ETC Eos console check over OSC. Opens one connection, pings the console
// (round-trip liveness + latency) and reads the software version, cue-list count
// and patch count in a single shared snapshot. Reachability is always checked;
// the software-version and loaded-show assertions are opt-in via their toggles
// (off by default). Protocol client, snapshot cache and shared semantics live in
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

const ID = 'eos';

const Settings: MonitoringSettingField[] = [
  ...CommonEosSettings,
  {
    Key: 'CheckVersion',
    Label: 'Check software version',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the console reports an unexpected software version.',
  },
  {
    Key: 'ExpectedVersion',
    Label: 'Expected software version prefix',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckVersion', Equals: true },
    Note: 'Matches on a prefix, e.g. 3.2.',
  },
  {
    Key: 'CheckShow',
    Label: 'Check loaded show',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the console is reachable but appears to have an empty or default show loaded.',
  },
  {
    Key: 'MinCueLists',
    Label: 'Minimum cue lists',
    Type: 'number',
    Default: 1,
    Min: 0,
    Max: 1000,
    VisibleWhen: { Key: 'CheckShow', Equals: true },
    Note: 'Degraded when the console has fewer cue lists than this. Set to 0 to disable this check.',
  },
  {
    Key: 'MinPatch',
    Label: 'Minimum patched channels',
    Type: 'number',
    Default: 1,
    Min: 0,
    Max: 100000,
    VisibleWhen: { Key: 'CheckShow', Equals: true },
    Note: 'Degraded when fewer channels than this are patched. Set to 0 to disable this check.',
  },
];

interface HealthOptions {
  CheckVersion: boolean;
  ExpectedVersion: string;
  CheckShow: boolean;
  MinCueLists: number;
  MinPatch: number;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Lists = Number(Cfg.MinCueLists);
  const Patch = Number(Cfg.MinPatch);
  return {
    CheckVersion: !!Cfg.CheckVersion,
    ExpectedVersion: String(Cfg.ExpectedVersion || '').trim(),
    CheckShow: !!Cfg.CheckShow,
    MinCueLists: Number.isFinite(Lists) ? Math.max(0, Lists | 0) : 1,
    MinPatch: Number.isFinite(Patch) ? Math.max(0, Patch | 0) : 1,
  };
}

// The reasons a reachable console is unhealthy, per the enabled toggles. Counts
// the console did not report within the probe window are treated as unknown
// (never a failure). Pure — exported via _internal for unit tests.
function EvaluateHealth(Snapshot: EosSnapshot, Options: HealthOptions): string[] {
  const Reasons: string[] = [];

  if (
    Options.CheckVersion &&
    Options.ExpectedVersion &&
    Snapshot.Version &&
    !Snapshot.Version.startsWith(Options.ExpectedVersion)
  ) {
    Reasons.push(`Version ${Snapshot.Version} (expected ${Options.ExpectedVersion}…)`);
  }

  if (Options.CheckShow) {
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
  }

  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunEosProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reasons = EvaluateHealth(Snapshot, ParseHealthOptions(Target));

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...EosSnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseEosConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(
      TextRow(
        'Software',
        String(Result.EosVersion || 'Unknown') +
          (Options.CheckVersion && Options.ExpectedVersion ? ` (expected ${Options.ExpectedVersion}…)` : '')
      )
    );
    if (Result.ShowName != null && Result.ShowName !== '') {
      ExtraRows.push(TextRow('Show', String(Result.ShowName)));
    }
    if (Result.ActiveCue != null && Result.ActiveCue !== '') {
      ExtraRows.push(TextRow('Active cue', String(Result.ActiveCue)));
    }
    if (Options.CheckShow) {
      ExtraRows.push(
        MonoRow('Cue lists', Result.CuelistCount != null ? String(Result.CuelistCount) : 'unknown')
      );
      ExtraRows.push(
        MonoRow('Patched channels', Result.PatchCount != null ? String(Result.PatchCount) : 'unknown')
      );
    }
  }

  return EosDebugHead(Config, Result, EosStatePill(Result, 'Online'), ExtraRows);
}

export const Name = 'ETC Eos';
export const Description =
  'Connects to an ETC Eos-family console (Eos Ti, Gio, Ion Xe, Element, ETCnomad) over OSC (default TCP 3032), pings it for a round-trip liveness check and reads the software version, cue-list count and patch count in one connection. Online when the console answers; optionally flags an unexpected software version or an empty/default show.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseHealthOptions, EvaluateHealth };
export { ID, Settings, Run, Debug };
