// MA Lighting grandMA2 show-loaded check. Logs in over the Telnet remote and
// reads the read-only `Version` command (which reports the loaded show file),
// confirming the console is running the show you expect — catches a desk that is
// online but has the wrong (or no) show loaded. Requires login credentials, and
// shares the per-console snapshot with ./ma2 via ./_ma2-shared.
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

const ID = 'ma2-show';

const Settings: MonitoringSettingField[] = [
  ...CommonMa2Settings,
  {
    Key: 'ExpectedShow',
    Label: 'Expected show file name (blank = just confirm a show is loaded)',
    Type: 'string',
    Default: '',
  },
];

function ParseExpectedShow(Target: MonitoringTargetLike): string {
  return String(((Target && Target.Settings) || {}).ExpectedShow || '').trim();
}

function NormalizeShow(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.show$/i, '');
}

// The degraded reason for a reachable console, or null when the expected show is
// confirmed loaded. Pure — exported via _internal for unit tests.
function EvaluateShow(Snapshot: Ma2Snapshot, Expected: string): string | null {
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
    case 'not-attempted':
      return 'Login credentials are required for this check';
    default:
      break;
  }
  // Logged in — judge the show file.
  if (!Snapshot.ShowFile) return 'Could not read the loaded show file';
  if (Expected && NormalizeShow(Snapshot.ShowFile) !== NormalizeShow(Expected)) {
    return `Show "${Snapshot.ShowFile}" (expected "${Expected}")`;
  }
  return null;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunMa2Probe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reason = EvaluateShow(Snapshot, ParseExpectedShow(Target));

  return {
    Success: true,
    ...(Reason ? { Degraded: true, DegradedReason: Reason } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...Ma2SnapshotExtras(Snapshot),
    Wanted: ParseExpectedShow(Target),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseMa2Config(Target);
  const Expected = ParseExpectedShow(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    const LoginState = String(Result.LoginState || 'not-attempted') as keyof typeof LOGIN_STATE_LABELS;
    ExtraRows.push(TextRow('Remote login', LOGIN_STATE_LABELS[LoginState] || String(LoginState)));
    ExtraRows.push(TextRow('Show file', String(Result.ShowFile || '—')));
    if (Expected) ExtraRows.push(TextRow('Expected', Expected));
  }

  return Ma2DebugHead(Config, Result, Ma2StatePill(Result, 'Show loaded'), ExtraRows);
}

export const Name = 'Show Loaded (grandMA2)';
export const Description =
  'Logs in to a grandMA2 console over the Telnet remote and reads the loaded show file (via the read-only Version command), reporting Degraded when the loaded show is not the one you expect. Requires login credentials; the login occupies a remote user session, so a dedicated telnet user is recommended.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseExpectedShow, NormalizeShow, EvaluateShow };
export { ID, Settings, Run, Debug };
