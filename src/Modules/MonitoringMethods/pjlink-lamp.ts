// Projector lamp hours over PJLink. Reads LAMP (cumulative hours + lit flag
// per lamp) and warns when any lamp reaches the configured threshold. Laser
// models answer LAMP with ERR1 (no lamp) — that is healthy, not a failure.
// Shares the per-projector status snapshot with the pjlink-* family.
import {
  CommonPJLinkSettings,
  ParsePJLinkConfig,
  RunPJLinkProbe,
  SnapshotExtras,
  PJLinkStatePill,
  PJLinkDebugHead,
  MonoRow,
  type LampReading,
  type PJLinkSnapshot,
} from './_pjlink-shared';
import { TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'pjlink-lamp';

const Settings: MonitoringSettingField[] = [
  ...CommonPJLinkSettings,
  {
    Key: 'LampWarnHours',
    Label: 'Warn at lamp hours (0 = report only)',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 100000,
  },
];

function ParseWarnHours(Target: MonitoringTargetLike): number {
  const Value = Number(((Target && Target.Settings) || {}).LampWarnHours);
  return Number.isFinite(Value) ? Math.max(0, Value | 0) : 0;
}

// Degraded reasons for a reachable projector. NoLamp is reported separately so
// Run can mark laser models. Pure — exported via _internal for unit tests.
function EvaluateLamps(
  Snapshot: PJLinkSnapshot,
  WarnHours: number
): { Reasons: string[]; NoLamp: boolean } {
  if (Snapshot.LampErr === 'ERR1') return { Reasons: [], NoLamp: true };
  if (Snapshot.LampErr === 'ERR4') return { Reasons: ['Projector failure (ERR4)'], NoLamp: false };
  if (Snapshot.LampErr) {
    return { Reasons: [`Lamp hours unavailable (${Snapshot.LampErr})`], NoLamp: false };
  }
  if (!Array.isArray(Snapshot.Lamps) || !Snapshot.Lamps.length) {
    return { Reasons: ['Lamp hours unavailable'], NoLamp: false };
  }
  const Reasons: string[] = [];
  if (WarnHours > 0) {
    Snapshot.Lamps.forEach((Lamp, Index) => {
      if (Lamp.Hours >= WarnHours) {
        Reasons.push(`Lamp ${Index + 1}: ${Lamp.Hours} h ≥ ${WarnHours} h`);
      }
    });
  }
  return { Reasons, NoLamp: false };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunPJLinkProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Verdict = EvaluateLamps(Snapshot, ParseWarnHours(Target));
  const MaxLampHours =
    Array.isArray(Snapshot.Lamps) && Snapshot.Lamps.length
      ? Math.max(...Snapshot.Lamps.map((Lamp) => Lamp.Hours))
      : null;

  return {
    Success: true,
    ...(Verdict.Reasons.length
      ? { Degraded: true, DegradedReason: Verdict.Reasons.join('; ') }
      : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...SnapshotExtras(Snapshot),
    Lamps: Snapshot.Lamps,
    MaxLampHours,
    NoLamp: Verdict.NoLamp,
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParsePJLinkConfig(Target);
  const WarnHours = ParseWarnHours(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Lamps = Array.isArray(Result.Lamps) ? (Result.Lamps as LampReading[]) : null;

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    if (Result.NoLamp) {
      ExtraRows.push(TextRow('Lamp', 'No lamp reported — laser light source?'));
    } else if (Lamps && Lamps.length) {
      Lamps.forEach((Lamp, Index) => {
        ExtraRows.push(
          MonoRow(
            Lamps.length === 1 ? 'Lamp hours' : `Lamp ${Index + 1} hours`,
            `${Lamp.Hours} h${Lamp.On ? '' : ' (off)'}`
          )
        );
      });
    }
    ExtraRows.push(
      TextRow('Warning threshold', WarnHours > 0 ? `${WarnHours} h` : 'Report only')
    );
  }

  return PJLinkDebugHead(Config, Result, PJLinkStatePill(Result, 'Lamp OK'), ExtraRows);
}

export const Name = 'Projector Lamp Hours (PJLink)';
export const Description =
  'Reads cumulative lamp usage hours over PJLink and reports Degraded when any lamp reaches the configured threshold. Laser models without lamps report Online.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseWarnHours, EvaluateLamps };
export { ID, Settings, Run, Debug };
