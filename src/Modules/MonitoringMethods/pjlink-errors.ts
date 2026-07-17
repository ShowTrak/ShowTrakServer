// Projector error status over PJLink. Reads ERST — six fixed-position digits
// covering fan, lamp, temperature, cover, filter and "other", each 0 ok /
// 1 warning / 2 error — and reports Degraded on any error (and on warnings,
// unless disabled). Shares the per-projector status snapshot with the
// pjlink-* family.
import {
  CommonPJLinkSettings,
  ParsePJLinkConfig,
  RunPJLinkProbe,
  SnapshotExtras,
  ErstReasons,
  PJLinkStatePill,
  PJLinkDebugHead,
  type ErstStatus,
  type PJLinkSnapshot,
} from './_pjlink-shared';
import { Pill, Row } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'pjlink-errors';

const Settings: MonitoringSettingField[] = [
  ...CommonPJLinkSettings,
  {
    // Default ON here (unlike the combined health method) — surfacing ERST is
    // this method's entire purpose.
    Key: 'WarningsDegrade',
    Label: 'Treat warnings as Degraded',
    Type: 'boolean',
    Default: true,
  },
];

function ParseWarningsDegrade(Target: MonitoringTargetLike): boolean {
  const Cfg = (Target && Target.Settings) || {};
  return Cfg.WarningsDegrade === undefined ? true : !!Cfg.WarningsDegrade;
}

// Degraded reasons for a reachable projector. Pure — exported via _internal
// for unit tests.
function EvaluateErrors(Snapshot: PJLinkSnapshot, WarningsDegrade: boolean): string[] {
  if (Snapshot.ErstErr) return [`Error status unavailable (${Snapshot.ErstErr})`];
  if (!Snapshot.Erst) return ['Error status unavailable'];
  return ErstReasons(Snapshot.Erst, WarningsDegrade);
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunPJLinkProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reasons = EvaluateErrors(Snapshot, ParseWarningsDegrade(Target));

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...SnapshotExtras(Snapshot),
    Erst: Snapshot.Erst,
  };
}

const ERST_ROWS: Array<{ Key: keyof ErstStatus; Label: string }> = [
  { Key: 'Fan', Label: 'Fan' },
  { Key: 'Lamp', Label: 'Lamp' },
  { Key: 'Temperature', Label: 'Temperature' },
  { Key: 'Cover', Label: 'Cover' },
  { Key: 'Filter', Label: 'Filter' },
  { Key: 'Other', Label: 'Other' },
];

function LevelPill(Level: number): string {
  if (Level === 2) return Pill('danger', 'Error');
  if (Level === 1) return Pill('warning', 'Warning');
  return Pill('success', 'OK');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParsePJLinkConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Erst = Result.Erst && typeof Result.Erst === 'object' ? (Result.Erst as ErstStatus) : null;

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable && Erst) {
    for (const Entry of ERST_ROWS) {
      ExtraRows.push(Row(Entry.Label, LevelPill(Erst[Entry.Key])));
    }
  }

  return PJLinkDebugHead(Config, Result, PJLinkStatePill(Result, 'No errors'), ExtraRows);
}

export const Name = 'Projector Errors (PJLink)';
export const Description =
  'Reads the PJLink error status (fan, lamp, temperature, cover, filter, other) and reports Degraded on any reported error — and on warnings, unless disabled.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseWarningsDegrade, EvaluateErrors };
export { ID, Settings, Run, Debug };
