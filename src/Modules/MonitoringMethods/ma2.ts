// MA Lighting grandMA2 telnet-remote health. Opens the command-line socket
// (TCP 30000), fingerprints the grandMA2 banner (a bare open port won't produce
// it) and reports a single online / offline verdict — sending nothing, so it is
// safe against a live console. When a user + password are supplied it also
// verifies that a real remote login succeeds and reads the software version and
// loaded show file. Protocol client and shared semantics live in ./_ma2-shared.
import {
  CommonMa2Settings,
  ParseMa2Config,
  RunMa2Probe,
  Ma2SnapshotExtras,
  Ma2StatePill,
  Ma2DebugHead,
  LOGIN_STATE_LABELS,
  type Ma2Snapshot,
} from './_ma2-shared';
import { TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'ma2';

const Settings: MonitoringSettingField[] = [...CommonMa2Settings];

// The degraded reason for a reachable console, or null when healthy. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: Ma2Snapshot): string | null {
  if (!Snapshot.IsGrandMa2) return 'Responded, but does not look like a grandMA2 telnet remote';
  switch (Snapshot.LoginState) {
    case 'bad-credentials':
      return 'Remote login rejected (check user / password)';
    case 'disabled':
      return 'Telnet login is disabled on the console';
    case 'timeout':
      return 'Remote login did not complete in time';
    case 'error':
      return 'Remote login failed';
    default:
      return null;
  }
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunMa2Probe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reason = EvaluateHealth(Snapshot);

  return {
    Success: true,
    ...(Reason ? { Degraded: true, DegradedReason: Reason } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...Ma2SnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseMa2Config(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    const LoginState = String(Result.LoginState || 'not-attempted') as keyof typeof LOGIN_STATE_LABELS;
    if (LoginState !== 'not-attempted') {
      ExtraRows.push(TextRow('Remote login', LOGIN_STATE_LABELS[LoginState] || String(LoginState)));
    }
    if (Result.ShowFile != null && Result.ShowFile !== '') {
      ExtraRows.push(TextRow('Show file', String(Result.ShowFile)));
    }
  }

  return Ma2DebugHead(Config, Result, Ma2StatePill(Result, 'Online'), ExtraRows);
}

export const Name = 'Telnet Remote Health (grandMA2)';
export const Description =
  'Connects to a grandMA2 console (or onPC) on its Telnet remote (TCP 30000) and confirms it responds as a grandMA2 — sending no commands, so it is safe against a live desk. Supply a login user + password (optional) to also verify remote login works and read the software version and loaded show file. Enable the Telnet remote in Setup → Console → Global Settings.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { EvaluateHealth };
export { ID, Settings, Run, Debug };
