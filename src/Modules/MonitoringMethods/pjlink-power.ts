// Projector power state over PJLink. Reads POWR (0 standby, 1 on, 2 cooling,
// 3 warm-up) and checks it against the configured expected state. Shares the
// per-projector status snapshot with the rest of the pjlink-* family via
// ./_pjlink-shared.
import {
  CommonPJLinkSettings,
  ParsePJLinkConfig,
  RunPJLinkProbe,
  SnapshotExtras,
  PowerLabel,
  PJLinkStatePill,
  PJLinkDebugHead,
  type PJLinkSnapshot,
} from './_pjlink-shared';
import { TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'pjlink-power';

const Settings: MonitoringSettingField[] = [
  ...CommonPJLinkSettings,
  {
    Key: 'ExpectedPower',
    Label: 'Expected power state',
    Type: 'select',
    Default: 'on-or-warmup',
    Options: [
      { value: 'on', label: 'On' },
      { value: 'on-or-warmup', label: 'On or warming up' },
      { value: 'any', label: 'Any (just reachable)' },
    ],
  },
];

type ExpectedPower = 'on' | 'on-or-warmup' | 'any';

function ParseExpectedPower(Target: MonitoringTargetLike): ExpectedPower {
  const Value = String(((Target && Target.Settings) || {}).ExpectedPower);
  return Value === 'on' || Value === 'any' ? Value : 'on-or-warmup';
}

// The degraded reason for a reachable projector, or null when healthy. Pure —
// exported via _internal for unit tests.
function EvaluatePower(Snapshot: PJLinkSnapshot, Expected: ExpectedPower): string | null {
  if (Snapshot.PowerErr === 'ERR3') return 'Projector busy (ERR3)';
  if (Snapshot.PowerErr === 'ERR4') return 'Projector failure (ERR4)';
  if (Snapshot.Power == null) return 'Power status unavailable';
  if (Expected === 'any') return null;
  const Accepted = Expected === 'on' ? [1] : [1, 3];
  if (Accepted.includes(Snapshot.Power)) return null;
  return `Power: ${PowerLabel(Snapshot.Power)} (expected On)`;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunPJLinkProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reason = EvaluatePower(Snapshot, ParseExpectedPower(Target));

  return {
    Success: true,
    ...(Reason ? { Degraded: true, DegradedReason: Reason } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...SnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParsePJLinkConfig(Target);
  const Expected = ParseExpectedPower(Target);
  const Reachable = !!(Result && Result.Success === true);
  const ExpectedLabel =
    Expected === 'on' ? 'On' : Expected === 'on-or-warmup' ? 'On or warming up' : 'Any';

  return PJLinkDebugHead(Config, Result, PJLinkStatePill(Result, 'Power OK'), [
    Reachable ? TextRow('Power', String(Result.PowerLabel || 'Unknown')) : null,
    TextRow('Expected', ExpectedLabel),
  ]);
}

export const Name = 'Projector Power (PJLink)';
export const Description =
  'Reads the projector power state over PJLink and reports Degraded when it differs from the expected state (on / on-or-warming-up / any).';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseExpectedPower, EvaluatePower };
export { ID, Settings, Run, Debug };
