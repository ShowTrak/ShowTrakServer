// MA Lighting grandMA2 telnet-remote check. Opens the command-line socket
// (TCP 30000), fingerprints the grandMA2 banner (a bare open port won't produce
// it) and reports online / offline — sending nothing, so it is safe against a
// live console. Reachability and login success are always evaluated; the
// software-version and loaded-show assertions are opt-in via their toggles (off
// by default) and require login credentials, since both are read over a real
// remote login. Protocol client and shared semantics live in ./_ma2-shared.
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

const Settings: MonitoringSettingField[] = [
  ...CommonMa2Settings,
  {
    Key: 'CheckVersion',
    Label: 'Check software version',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded on an unexpected software version. Requires login credentials.',
  },
  {
    Key: 'ExpectedVersion',
    Label: 'Expected software version prefix',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckVersion', Equals: true },
    Note: 'Matches on a prefix, e.g. 3.9.',
  },
  {
    Key: 'CheckShow',
    Label: 'Check loaded show',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the loaded show is not the expected one. Requires login credentials.',
  },
  {
    Key: 'ExpectedShow',
    Label: 'Expected show file name',
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
// .show extension.
function NormalizeShow(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.show$/i, '');
}

// The reasons a reachable console is unhealthy, per the enabled toggles. Login
// state is always judged (a supplied credential that is rejected is a fault);
// version/show assertions additionally require a completed login. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: Ma2Snapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsGrandMa2) return ['Responded, but does not look like a grandMA2 telnet remote'];

  switch (Snapshot.LoginState) {
    case 'bad-credentials':
      return ['Remote login rejected (check user / password)'];
    case 'disabled':
      return ['Telnet login is disabled on the console'];
    case 'timeout':
      return ['Remote login did not complete in time'];
    case 'error':
      return ['Remote login failed'];
    default:
      break;
  }

  const NeedsLogin = Options.CheckVersion || Options.CheckShow;
  if (NeedsLogin && Snapshot.LoginState === 'not-attempted') {
    return ['Login credentials are required to check the version / show'];
  }

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
    if (!Snapshot.ShowFile) {
      Reasons.push('Could not read the loaded show file');
    } else if (
      Options.ExpectedShow &&
      NormalizeShow(Snapshot.ShowFile) !== NormalizeShow(Options.ExpectedShow)
    ) {
      Reasons.push(`Show "${Snapshot.ShowFile}" (expected "${Options.ExpectedShow}")`);
    }
  }
  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunMa2Probe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reasons = EvaluateHealth(Snapshot, ParseHealthOptions(Target));

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...Ma2SnapshotExtras(Snapshot),
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseMa2Config(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    const LoginState = String(
      Result.LoginState || 'not-attempted'
    ) as keyof typeof LOGIN_STATE_LABELS;
    if (LoginState !== 'not-attempted') {
      ExtraRows.push(TextRow('Remote login', LOGIN_STATE_LABELS[LoginState] || String(LoginState)));
    }
    if (Result.Ma2Version != null && Result.Ma2Version !== '') {
      ExtraRows.push(
        TextRow(
          'Software',
          String(Result.Ma2Version) +
            (Options.CheckVersion && Options.ExpectedVersion
              ? ` (expected ${Options.ExpectedVersion}…)`
              : '')
        )
      );
    }
    if (Result.ShowFile != null && Result.ShowFile !== '') {
      ExtraRows.push(
        TextRow(
          'Show file',
          String(Result.ShowFile) +
            (Options.CheckShow && Options.ExpectedShow
              ? ` (expected "${Options.ExpectedShow}")`
              : '')
        )
      );
    }
  }

  return Ma2DebugHead(Config, Result, Ma2StatePill(Result, 'Online'), ExtraRows);
}

export const Name = 'grandMA2';
export const Description =
  'Connects to a grandMA2 console (or onPC) on its Telnet remote (TCP 30000) and confirms it responds as a grandMA2 — sending no commands, so it is safe against a live desk. Supply a login user + password to enable the optional software-version and loaded-show checks, which log in over the remote to read those values. Enable the Telnet remote in Setup → Console → Global Settings.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseHealthOptions, NormalizeShow, EvaluateHealth };
export { ID, Settings, Run, Debug };
