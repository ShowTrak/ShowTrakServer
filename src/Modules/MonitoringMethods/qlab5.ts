// QLab 5+ workspace monitoring. Holds a persistent OSC/TCP connection to QLab,
// subscribes to its `/updates` feed, and asserts live state inside a workspace.
// Baseline behaviour confirms a workspace is open (a named one, or whichever is
// open when the Workspace field is blank); each further assertion — workspace name,
// Show/Edit mode, running cues, overrides — is opt-in via its own toggle. Transport,
// the persistent self-reaping connection manager, and the snapshot live in
// ./_qlab-shared.
//
// (This is the evolved qlab-workspace check: it replaced the earlier per-tick probe
// that only confirmed a workspace was open, keeping the same method ID so existing
// checks upgrade in place.)
//
// One MonitoringCheck collapses to a single Online/Degraded/Offline tri-state (the
// framework has no multi-result checks), so — like eos.ts — every enabled toggle is
// evaluated and any failure aggregates into one Degraded reason. QLab exposes no OSC
// for workspace warnings or video FPS (Workspace Status Window is GUI-only), so those
// are intentionally absent.
import {
  QLabConnectionManager,
  DEFAULT_OSC_PORT,
  OVERRIDE_KEYS,
  IsValidPort,
  type QLabSnapshot,
  type QLabCueRef,
} from './_qlab-shared';
import { Esc, Pill, Rows, TextRow, Row, Note, Card } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionResult,
  MonitoringMethodAction,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'qlab5';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'OSC Port',
    Type: 'number',
    Default: DEFAULT_OSC_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Workspace',
    Label: 'Workspace name / filename or unique ID',
    Type: 'string',
    Default: '',
    Note: 'The workspace whose live state is inspected, matched by name, filename, or unique ID. Leave blank to use whichever workspace is currently open.',
  },
  // --- Workspace name -------------------------------------------------------
  {
    Key: 'CheckWorkspaceName',
    Label: 'Check workspace name',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the open workspace’s name matches the expected value. Useful when the workspace above is left blank.',
  },
  {
    Key: 'ExpectedWorkspaceName',
    Label: 'Expected workspace name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckWorkspaceName', Equals: true },
  },
  {
    Key: 'WorkspaceNameMatch',
    Label: 'Match',
    Type: 'select',
    Default: 'exact',
    Options: [
      { value: 'exact', label: 'Exact match' },
      { value: 'contains', label: 'Contains' },
    ],
    VisibleWhen: { Key: 'CheckWorkspaceName', Equals: true },
  },
  // --- Workspace mode -------------------------------------------------------
  {
    Key: 'CheckMode',
    Label: 'Check workspace mode',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the workspace is not in the expected Show/Edit mode.',
  },
  {
    Key: 'ExpectedMode',
    Label: 'Expected mode',
    Type: 'select',
    Default: 'show',
    Options: [
      { value: 'show', label: 'Show mode' },
      { value: 'edit', label: 'Edit mode' },
    ],
    VisibleWhen: { Key: 'CheckMode', Equals: true },
  },
  // --- Running cues ---------------------------------------------------------
  {
    Key: 'CheckRunningCues',
    Label: 'Check cue(s) running',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the listed cues are currently running or paused.',
  },
  {
    Key: 'RunningCues',
    Label: 'Cue numbers / IDs',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckRunningCues', Equals: true },
    Note: 'Add each cue number or unique ID to watch. Matched against QLab’s running/paused cues.',
  },
  {
    Key: 'RunningCuesMatch',
    Label: 'Match',
    Type: 'select',
    Default: 'all',
    Options: [
      { value: 'all', label: 'All listed cues must be running' },
      { value: 'any', label: 'Any listed cue running' },
    ],
    VisibleWhen: { Key: 'CheckRunningCues', Equals: true },
  },
  // --- Overrides ------------------------------------------------------------
  {
    Key: 'CheckOverrides',
    Label: 'Check workspace overrides',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when any I/O subsystem (MIDI, MSC, timecode, DMX, network) is currently overridden (disabled) in QLab.',
  },
  {
    Key: 'Passcode',
    Label: 'OSC passcode',
    Type: 'string',
    Default: '',
    Advanced: true,
    Note: 'Sent via /connect when the workspace requires an OSC passcode.',
  },
];

// --- Options ----------------------------------------------------------------

interface HealthOptions {
  CheckWorkspaceName: boolean;
  ExpectedWorkspaceName: string;
  WorkspaceNameMatch: 'exact' | 'contains';
  CheckMode: boolean;
  ExpectedMode: 'show' | 'edit';
  CheckRunningCues: boolean;
  RunningCues: string[];
  RunningCuesMatch: 'all' | 'any';
  CheckOverrides: boolean;
}

function AsList(Value: unknown): string[] {
  if (Array.isArray(Value))
    return Value.map((V) => String(V == null ? '' : V).trim()).filter(Boolean);
  if (Value == null || Value === '') return [];
  return [String(Value).trim()].filter(Boolean);
}

export function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    CheckWorkspaceName: !!Cfg.CheckWorkspaceName,
    ExpectedWorkspaceName: String(Cfg.ExpectedWorkspaceName || '').trim(),
    WorkspaceNameMatch: Cfg.WorkspaceNameMatch === 'contains' ? 'contains' : 'exact',
    CheckMode: !!Cfg.CheckMode,
    ExpectedMode: Cfg.ExpectedMode === 'edit' ? 'edit' : 'show',
    CheckRunningCues: !!Cfg.CheckRunningCues,
    RunningCues: AsList(Cfg.RunningCues),
    RunningCuesMatch: Cfg.RunningCuesMatch === 'any' ? 'any' : 'all',
    CheckOverrides: !!Cfg.CheckOverrides,
  };
}

// --- Evaluation (pure; exported for tests) ----------------------------------

export interface SubCheck {
  Key: string;
  Label: string;
  // true = pass, false = fail (→ Degraded), null = unknown (never a failure).
  Ok: boolean | null;
  Detail: string;
}

function CueMatches(Cue: QLabCueRef, Wanted: string): boolean {
  const W = Wanted.trim();
  if (!W) return false;
  if (Cue.number && Cue.number.trim() === W) return true;
  if (Cue.uniqueID && Cue.uniqueID.trim().toLowerCase() === W.toLowerCase()) return true;
  return false;
}

export function EvaluateHealth(Snapshot: QLabSnapshot, Options: HealthOptions): SubCheck[] {
  const Out: SubCheck[] = [];

  if (Options.CheckWorkspaceName) {
    const Actual = Snapshot.WorkspaceName == null ? '' : String(Snapshot.WorkspaceName);
    const Expected = Options.ExpectedWorkspaceName;
    if (!Expected) {
      Out.push({ Key: 'name', Label: 'Workspace name', Ok: null, Detail: 'No expected name set' });
    } else {
      const A = Actual.trim().toLowerCase();
      const E = Expected.toLowerCase();
      const Ok = Options.WorkspaceNameMatch === 'contains' ? A.includes(E) : A === E;
      Out.push({
        Key: 'name',
        Label: 'Workspace name',
        Ok,
        Detail: Ok
          ? `“${Actual}”`
          : `“${Actual || '—'}” (expected ${Options.WorkspaceNameMatch === 'contains' ? 'to contain ' : ''}“${Expected}”)`,
      });
    }
  }

  if (Options.CheckMode) {
    if (Snapshot.ShowMode == null) {
      Out.push({ Key: 'mode', Label: 'Workspace mode', Ok: null, Detail: 'Mode unknown' });
    } else {
      const Actual = Snapshot.ShowMode ? 'show' : 'edit';
      const Ok = Actual === Options.ExpectedMode;
      Out.push({
        Key: 'mode',
        Label: 'Workspace mode',
        Ok,
        Detail: Ok ? `In ${Actual} mode` : `In ${Actual} mode (expected ${Options.ExpectedMode})`,
      });
    }
  }

  if (Options.CheckRunningCues) {
    const Wanted = Options.RunningCues;
    if (!Wanted.length) {
      Out.push({ Key: 'cues', Label: 'Cues running', Ok: null, Detail: 'No cues listed' });
    } else {
      const Running = Snapshot.RunningCues || [];
      const Matched = Wanted.filter((W) => Running.some((C) => CueMatches(C, W)));
      const Missing = Wanted.filter((W) => !Matched.includes(W));
      const Ok = Options.RunningCuesMatch === 'any' ? Matched.length > 0 : Missing.length === 0;
      Out.push({
        Key: 'cues',
        Label: 'Cues running',
        Ok,
        Detail: Ok
          ? `${Matched.length}/${Wanted.length} running`
          : Options.RunningCuesMatch === 'any'
            ? `None of ${Wanted.length} listed cues running`
            : `Not running: ${Missing.join(', ')}`,
      });
    }
  }

  if (Options.CheckOverrides) {
    const Known = OVERRIDE_KEYS.filter((K) => Snapshot.Overrides[K] != null);
    if (!Known.length) {
      Out.push({
        Key: 'overrides',
        Label: 'Overrides',
        Ok: null,
        Detail: 'Override states unknown',
      });
    } else {
      const Engaged = Known.filter((K) => Snapshot.Overrides[K] === false);
      Out.push({
        Key: 'overrides',
        Label: 'Overrides',
        Ok: Engaged.length === 0,
        Detail: Engaged.length
          ? `Overridden: ${Engaged.map(FriendlyOverride).join(', ')}`
          : 'None engaged',
      });
    }
  }

  return Out;
}

function FriendlyOverride(Key: string): string {
  return Key.replace(/Enabled$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^msc/i, 'MSC')
    .replace(/^midi/i, 'MIDI')
    .replace(/^sysex/i, 'SysEx')
    .replace(/^./, (C) => C.toUpperCase());
}

// --- Run --------------------------------------------------------------------

function ResolveConnectionParams(Target: MonitoringTargetLike): {
  Address: string;
  Port: number;
  Workspace: string;
  Passcode: string;
  Error?: string;
} {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_OSC_PORT;
  const Workspace = Cfg.Workspace == null ? '' : String(Cfg.Workspace).trim();
  const Passcode = Cfg.Passcode == null ? '' : String(Cfg.Passcode);
  if (!Address) return { Address, Port, Workspace, Passcode, Error: 'No address configured' };
  if (!IsValidPort(Port))
    return { Address, Port, Workspace, Passcode, Error: `Invalid port: ${Port}` };
  // Workspace is optional: blank means "use whichever workspace is open".
  return { Address, Port, Workspace, Passcode };
}

function SnapshotExtras(Snapshot: QLabSnapshot, Sub: SubCheck[]): Record<string, unknown> {
  return {
    WorkspaceName: Snapshot.WorkspaceName,
    WorkspaceID: Snapshot.WorkspaceID,
    ShowMode: Snapshot.ShowMode,
    RunningCues: Snapshot.RunningCues,
    Overrides: Snapshot.Overrides,
    SubChecks: Sub,
  };
}

function Run(Target: MonitoringTargetLike): MonitoringResult {
  const P = ResolveConnectionParams(Target);
  if (P.Error) return { Success: false, Error: P.Error };

  const Key = QLabConnectionManager.Observe({
    Address: P.Address,
    Port: P.Port,
    Workspace: P.Workspace,
    Passcode: P.Passcode,
  });
  const Snapshot = QLabConnectionManager.Snapshot(Key);

  // Not yet usable: still connecting, unreachable, or the workspace isn't open.
  if (!Snapshot.WorkspaceID) {
    const Error =
      Snapshot.Error || (Snapshot.Connected ? 'Workspace not open in QLab' : 'Connecting to QLab…');
    return { Success: false, Error, ...SnapshotExtras(Snapshot, []) };
  }
  if (Snapshot.Stale) {
    return {
      Success: false,
      Error: 'No recent response from QLab',
      ...SnapshotExtras(Snapshot, []),
    };
  }

  const Sub = EvaluateHealth(Snapshot, ParseHealthOptions(Target));
  const Failing = Sub.filter((S) => S.Ok === false);

  return {
    Success: true,
    ...(Failing.length
      ? { Degraded: true, DegradedReason: Failing.map((S) => S.Detail).join('; ') }
      : {}),
    ...SnapshotExtras(Snapshot, Sub),
  };
}

// --- Debug ------------------------------------------------------------------

function SubPill(Ok: boolean | null): string {
  if (Ok === true) return Pill('success', 'Pass');
  if (Ok === false) return Pill('warning', 'Fail');
  return Pill('muted', 'Unknown');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_OSC_PORT;
  const Online = !!(Result && Result.Success);
  const Degraded = !!(Result && Result.Degraded);

  let StatusPill: string;
  if (!Online) StatusPill = Pill('danger', 'Offline');
  else if (Degraded) StatusPill = Pill('warning', 'Degraded');
  else StatusPill = Pill('success', 'Healthy');

  const WorkspaceName = Result && Result.WorkspaceName != null ? String(Result.WorkspaceName) : '';

  const Head = Rows([
    TextRow('Host', `${Address || '—'}:${Port}`),
    Row('Status', StatusPill),
    WorkspaceName ? TextRow('Workspace', WorkspaceName) : null,
    !Online && Result && Result.Error ? TextRow('Detail', Result.Error as string) : null,
  ]);

  const Sub: SubCheck[] = Array.isArray(Result && Result.SubChecks)
    ? (Result.SubChecks as SubCheck[])
    : [];
  if (!Sub.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        Online
          ? 'No workspace assertions enabled — reporting reachability only'
          : 'Not connected to the workspace yet'
      ) +
      '</div>'
    );
  }

  // Fail is conveyed by the badge colour (SubPill), not a coloured/bordered card.
  const List = Sub.map((S) =>
    Card({
      Title: S.Label,
      Badge: SubPill(S.Ok),
      BodyHtml: `<div class="text-muted small text-break">${Esc(S.Detail)}</div>`,
    })
  ).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Workspace checks (${Sub.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>`
  );
}

export const Name = 'QLab 5';
export const Description =
  'Holds a persistent OSC connection to QLab 5+ and subscribes to its live updates to assert state inside a workspace (a named one, or whichever is open): its name, Show/Edit mode, whether given cues are running, and whether any I/O override (MIDI, MSC, timecode, DMX, network) is engaged. Online when connected and a workspace is open; Degraded when an enabled assertion fails.';
export const Group = 'Sound';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
// Passive listener: Run() only reads a cached snapshot, so there is no per-tick
// round-trip latency to threshold on. Keep the run cache tiny so the snapshot is
// re-read each tick.
export const SupportsLatencyThreshold = false;
export const RunCacheTtlMs = 0;
export const _internal = { ParseHealthOptions, EvaluateHealth, CueMatches, FriendlyOverride };
// --- Control actions ---------------------------------------------------------

// A cue number becomes an OSC address component, so anything that would change
// the address structure has to be refused. An unescaped '/' turns
// /cue/12/start into an entirely different address, and OSC treats ? * [ ] { }
// as pattern-matching wildcards — a cue number of '*' would address EVERY cue.
const UNSAFE_CUE_NUMBER = /[\s/#*,?[\]{}]/;

const CUE_NUMBER_PARAM: MonitoringSettingField[] = [
  {
    Key: 'Number',
    Label: 'Cue number',
    Type: 'string',
    Default: '',
    Required: true,
    Note: 'The cue number as shown in QLab, e.g. 5 or 12.3.',
  },
];

// Resolve the same connection this method's probe uses, so an action rides the
// warm session rather than opening its own. Observe() is idempotent and also
// refreshes the interest TTL.
function SendCue(
  Target: MonitoringTargetLike,
  Suffix: string,
  Label: string
): MonitoringActionResult {
  const P = ResolveConnectionParams(Target);
  if (P.Error) return { Success: false, Error: P.Error };

  const Key = QLabConnectionManager.Observe({
    Address: P.Address,
    Port: P.Port,
    Workspace: P.Workspace,
    Passcode: P.Passcode,
  });

  if (!QLabConnectionManager.SendToWorkspace(Key, Suffix)) {
    const Snapshot = QLabConnectionManager.Snapshot(Key);
    return {
      Success: false,
      Error: Snapshot.Connected
        ? 'QLab is connected but no workspace has been resolved yet'
        : 'Not connected to QLab',
    };
  }

  return { Success: true, Detail: `${Label} sent to QLab` };
}

function WithCueNumber(
  Target: MonitoringTargetLike,
  Params: Record<string, unknown>,
  Suffix: (Number0: string) => string,
  Label: (Number0: string) => string
): MonitoringActionResult {
  const Number0 = String(Params.Number ?? '').trim();
  if (!Number0) return { Success: false, Error: 'No cue number given' };
  if (UNSAFE_CUE_NUMBER.test(Number0)) {
    return { Success: false, Error: `"${Number0}" is not a usable cue number` };
  }
  return SendCue(Target, Suffix(Number0), Label(Number0));
}

// Every QLab action is fire-and-forget: the connection sends /alwaysReply, but
// nothing here correlates the reply yet, so a success means "written to a live
// socket" and the result must not claim more. Reply correlation via
// ParseQLabReply is the natural next step if confirmation is ever needed.
const Actions: MonitoringMethodAction[] = [
  {
    ID: 'workspace.go',
    Label: 'Go',
    Icon: 'play-fill',
    Group: 'Playback',
    FireAndForget: true,
    Run: (Target) => SendCue(Target, '/go', 'Go'),
  },
  {
    ID: 'workspace.stop',
    Label: 'Stop',
    Icon: 'stop-fill',
    Group: 'Playback',
    FireAndForget: true,
    Run: (Target) => SendCue(Target, '/stop', 'Stop'),
  },
  {
    ID: 'workspace.panic',
    Label: 'Panic (fade everything out)',
    Icon: 'exclamation-octagon',
    Group: 'Playback',
    Destructive: true,
    FireAndForget: true,
    Run: (Target) => SendCue(Target, '/panic', 'Panic'),
  },
  {
    ID: 'cue.start',
    Label: 'Start Cue',
    Icon: 'play-circle',
    Group: 'Playback',
    Params: CUE_NUMBER_PARAM,
    FireAndForget: true,
    Run: (Target, Params) =>
      WithCueNumber(
        Target,
        Params,
        (N) => `/cue/${N}/start`,
        (N) => `Start cue ${N}`
      ),
  },
  {
    ID: 'cue.stop',
    Label: 'Stop Cue',
    Icon: 'stop-circle',
    Group: 'Playback',
    Params: CUE_NUMBER_PARAM,
    FireAndForget: true,
    Run: (Target, Params) =>
      WithCueNumber(
        Target,
        Params,
        (N) => `/cue/${N}/stop`,
        (N) => `Stop cue ${N}`
      ),
  },
];

export { ID, Settings, Actions, Run, Debug };
