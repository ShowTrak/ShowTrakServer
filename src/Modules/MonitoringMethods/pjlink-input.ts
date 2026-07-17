// Projector active input over PJLink. Reads INPT (2-char code: source type +
// channel, e.g. 31 = Digital 1) and optionally checks it against an expected
// code. The input is only readable while the projector is powered on. Shares
// the per-projector status snapshot with the pjlink-* family.
import {
  CommonPJLinkSettings,
  ParsePJLinkConfig,
  RunPJLinkProbe,
  SnapshotExtras,
  PowerLabel,
  NormalizeInputCode,
  InputLabel,
  PJLinkStatePill,
  PJLinkDebugHead,
  type PJLinkSnapshot,
} from './_pjlink-shared';
import { TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'pjlink-input';

const Settings: MonitoringSettingField[] = [
  ...CommonPJLinkSettings,
  {
    Key: 'ExpectedInput',
    Label: 'Expected input code (blank = report only, e.g. 31)',
    Type: 'string',
    Default: '',
  },
];

function ParseExpectedInput(Target: MonitoringTargetLike): string {
  return NormalizeInputCode(((Target && Target.Settings) || {}).ExpectedInput);
}

// The degraded reason for a reachable projector, or null when healthy. Pure —
// exported via _internal for unit tests.
function EvaluateInput(Snapshot: PJLinkSnapshot, Expected: string): string | null {
  if (Snapshot.Power != null && Snapshot.Power !== 1) {
    return `Projector not on (${PowerLabel(Snapshot.Power)})`;
  }
  if (Snapshot.InputErr === 'ERR3') return 'Input unavailable (ERR3)';
  if (Snapshot.InputErr === 'ERR4') return 'Projector failure (ERR4)';
  if (Snapshot.InputErr) return `Input unavailable (${Snapshot.InputErr})`;
  if (!Snapshot.Input) return 'Input unavailable';
  if (!Expected) return null;
  if (Snapshot.Input !== Expected) {
    return `Input ${Snapshot.Input} (expected ${Expected})`;
  }
  return null;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunPJLinkProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reason = EvaluateInput(Snapshot, ParseExpectedInput(Target));

  return {
    Success: true,
    ...(Reason ? { Degraded: true, DegradedReason: Reason } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...SnapshotExtras(Snapshot),
    Input: Snapshot.Input,
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParsePJLinkConfig(Target);
  const Expected = ParseExpectedInput(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(TextRow('Power', String(Result.PowerLabel || 'Unknown')));
    if (Result.Input != null && Result.Input !== '') {
      ExtraRows.push(TextRow('Input', `${InputLabel(Result.Input)} (${String(Result.Input)})`));
    }
    ExtraRows.push(
      TextRow('Expected', Expected ? `${InputLabel(Expected)} (${Expected})` : 'Report only')
    );
  }

  return PJLinkDebugHead(Config, Result, PJLinkStatePill(Result, 'Input OK'), ExtraRows);
}

export const Name = 'Projector Input (PJLink)';
export const Description =
  'Reads the active input over PJLink and optionally reports Degraded when it differs from an expected input code (e.g. 31 = Digital 1, often HDMI 1).';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseExpectedInput, EvaluateInput };
export { ID, Settings, Run, Debug };
