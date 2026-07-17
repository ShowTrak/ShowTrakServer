// Avolites Titan show-loaded check. Reads the current show file name over the
// Titan WebAPI (GET /titan/get/Show/ShowName) and confirms it matches the show
// you expect to be loaded — catches a console that is online but running the
// wrong (or no) show. Shares the per-console snapshot with ./avolites via
// ./_avolites-shared.
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

const ID = 'avolites-show';

const Settings: MonitoringSettingField[] = [
  ...CommonAvolitesSettings,
  {
    Key: 'ExpectedShow',
    Label: 'Expected show name (blank = just confirm a show is loaded)',
    Type: 'string',
    Default: '',
  },
];

function ParseExpectedShow(Target: MonitoringTargetLike): string {
  return String(((Target && Target.Settings) || {}).ExpectedShow || '').trim();
}

// Normalise a show name for comparison: lower-cased, trimmed, without a trailing
// Titan show-file extension.
function NormalizeShow(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.(isf|show)$/i, '');
}

// The degraded reason for a reachable console, or null when healthy. Pure —
// exported via _internal for unit tests.
function EvaluateShow(Snapshot: TitanSnapshot, Expected: string): string | null {
  const Current = Snapshot.ShowName;
  if (!Current) return 'No show name reported';
  if (!Expected) return null; // just confirming a show is loaded
  if (NormalizeShow(Current) !== NormalizeShow(Expected)) {
    return `Show "${Current}" (expected "${Expected}")`;
  }
  return null;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunAvolitesProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reason = EvaluateShow(Snapshot, ParseExpectedShow(Target));

  return {
    Success: true,
    ...(Reason ? { Degraded: true, DegradedReason: Reason } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...AvolitesSnapshotExtras(Snapshot),
    Wanted: ParseExpectedShow(Target),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseAvolitesConfig(Target);
  const Expected = ParseExpectedShow(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(TextRow('Show', String(Result.ShowName || '—')));
    if (Expected) ExtraRows.push(TextRow('Expected', Expected));
  }

  return AvolitesDebugHead(Config, Result, AvolitesStatePill(Result, 'Show loaded'), ExtraRows);
}

export const Name = 'Show Loaded (Avolites Titan)';
export const Description =
  'Reads the current show file name from an Avolites Titan console over the WebAPI and reports Degraded when the loaded show is not the one you expect — catches a console that is online but running the wrong show.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseExpectedShow, NormalizeShow, EvaluateShow };
export { ID, Settings, Run, Debug };
