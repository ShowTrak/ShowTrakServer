// Avolites Titan console check over the Titan WebAPI (HTTP, TCP 4430). Reads the
// software version and current show name in one shared snapshot and reports
// online / offline. Reachability is always checked; the software-version and
// loaded-show assertions are opt-in via their toggles (off by default). Protocol
// client, snapshot cache and shared semantics live in ./_avolites-shared.
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
    Key: 'CheckVersion',
    Label: 'Check software version',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the console reports an unexpected Titan version.',
  },
  {
    Key: 'ExpectedVersion',
    Label: 'Expected Titan version prefix',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckVersion', Equals: true },
    Note: 'Matches on a prefix, e.g. 17.',
  },
  {
    Key: 'CheckShow',
    Label: 'Check loaded show',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the loaded show is not the expected one.',
  },
  {
    Key: 'ExpectedShow',
    Label: 'Expected show name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckShow', Equals: true },
    Note: 'Leave blank to confirm only that a show is loaded.',
  },
];

interface HealthOptions {
  CheckVersion: boolean;
  ExpectedVersion: string;
  CheckShow: boolean;
  ExpectedShow: string;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    CheckVersion: !!Cfg.CheckVersion,
    ExpectedVersion: String(Cfg.ExpectedVersion || '').trim(),
    CheckShow: !!Cfg.CheckShow,
    ExpectedShow: String(Cfg.ExpectedShow || '').trim(),
  };
}

// Normalise a show name for comparison: lower-cased, trimmed, without a trailing
// Titan show-file extension.
function NormalizeShow(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.(isf|show)$/i, '');
}

// The reasons a reachable console is unhealthy, per the enabled toggles. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: TitanSnapshot, Options: HealthOptions): string[] {
  const Reasons: string[] = [];

  if (
    Options.CheckVersion &&
    Options.ExpectedVersion &&
    Snapshot.Version &&
    !Snapshot.Version.startsWith(Options.ExpectedVersion)
  ) {
    Reasons.push(`Titan ${Snapshot.Version} (expected ${Options.ExpectedVersion}…)`);
  }

  if (Options.CheckShow) {
    const Current = Snapshot.ShowName;
    if (!Current) {
      Reasons.push('No show name reported');
    } else if (
      Options.ExpectedShow &&
      NormalizeShow(Current) !== NormalizeShow(Options.ExpectedShow)
    ) {
      Reasons.push(`Show "${Current}" (expected "${Options.ExpectedShow}")`);
    }
  }

  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunAvolitesProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reasons = EvaluateHealth(Snapshot, ParseHealthOptions(Target));

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...AvolitesSnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseAvolitesConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(
      TextRow(
        'Titan',
        String(Result.TitanVersion || 'Unknown') +
          (Options.CheckVersion && Options.ExpectedVersion ? ` (expected ${Options.ExpectedVersion}…)` : '')
      )
    );
    if (Result.ShowName != null && Result.ShowName !== '') {
      ExtraRows.push(
        TextRow(
          'Show',
          String(Result.ShowName) +
            (Options.CheckShow && Options.ExpectedShow ? ` (expected "${Options.ExpectedShow}")` : '')
        )
      );
    }
  }

  return AvolitesDebugHead(Config, Result, AvolitesStatePill(Result, 'Online'), ExtraRows);
}

export const Name = 'Avolites Titan';
export const Description =
  'Connects to an Avolites Titan console (Sapphire, Tiger Touch, Quartz, Arena, Diamond, Titan Go) over the Titan WebAPI (HTTP, TCP 4430) and reads the software version and current show name. Online when the WebAPI answers; optionally flags an unexpected Titan version or a wrong loaded show. Requires the WebAPI to be enabled on the console.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseHealthOptions, NormalizeShow, EvaluateHealth };
export { ID, Settings, Run, Debug };
