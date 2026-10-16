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
  TRANSPORT_ACTIONS,
  MODE_ACTIONS,
  BuildQLabCommand,
  DescribeQLabAction,
  type OverrideKey,
  type QLabSnapshot,
  type QLabCueRef,
} from './_qlab-shared';
import { Esc, Pill, Rows, TextRow, Row, Note, Card } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
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
    Sensitive: true,
    Label: 'OSC passcode',
    Type: 'string',
    Default: '',
    Advanced: true,
    Note: 'Sent via /connect when the workspace requires an OSC passcode. Actions need a passcode with control access unless QLab grants that without one.',
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
    .replace(/^dmx/i, 'DMX')
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

// --- Actions ----------------------------------------------------------------
//
// Sent over the same persistent connection the check already holds, so a press
// costs one message and its acknowledgement — no connect, no workspace lookup.
// The Mode and Overrides groups are the remedies for the two states this check
// can flag as Degraded: wrong Show/Edit mode, and an I/O override left engaged.
//
// QLab's override flags read "enabled": `/overrides/midiInputEnabled false` is
// what the Overrides window shows as MIDI input switched off. The action labels
// follow the window rather than the wire.

const OVERRIDE_PARAM: MonitoringSettingField = {
  Key: 'Override',
  Label: 'Input / output',
  Type: 'select',
  Default: OVERRIDE_KEYS[0],
  Required: true,
  Options: OVERRIDE_KEYS.map((Key) => ({ value: Key, label: FriendlyOverride(Key) })),
};

const Actions: MonitoringActionDef[] = [
  ...TRANSPORT_ACTIONS,
  ...MODE_ACTIONS,
  {
    ID: 'overrides.restore',
    Label: 'Enable All I/O',
    Icon: 'toggles',
    Group: 'Overrides',
    Note: 'Switches back on every input and output currently switched off in the Overrides window.',
  },
  {
    ID: 'override.enable',
    Label: 'Enable I/O',
    Icon: 'toggle-on',
    Group: 'Overrides',
    Params: [OVERRIDE_PARAM],
  },
  {
    ID: 'override.disable',
    Label: 'Disable I/O',
    Icon: 'toggle-off',
    Group: 'Overrides',
    Params: [OVERRIDE_PARAM],
    Destructive: true,
    Note: 'Switches an input or output off in the Overrides window — cues still run but send or receive nothing on it.',
  },
];

function IsOverrideKey(Value: unknown): Value is OverrideKey {
  return (OVERRIDE_KEYS as readonly string[]).includes(String(Value));
}

async function SetOverrides(
  P: ReturnType<typeof ResolveConnectionParams>,
  Keys: OverrideKey[],
  Enabled: boolean
): Promise<MonitoringActionResult> {
  const Failed: string[] = [];
  let FirstError = '';
  for (const Key of Keys) {
    const Outcome = await QLabConnectionManager.Command(
      P,
      `/overrides/${Key}`,
      [Enabled],
      'application'
    );
    if (!Outcome.Success) {
      Failed.push(FriendlyOverride(Key));
      FirstError = FirstError || Outcome.Error || 'QLab did not accept the change';
    }
  }
  if (Failed.length === Keys.length) return { Success: false, Error: FirstError };
  const Names = Keys.map(FriendlyOverride).filter((Name) => !Failed.includes(Name));
  const Done = `${Names.join(', ')} ${Enabled ? 'enabled' : 'disabled'}`;
  if (Failed.length) {
    return { Success: false, Error: `${Done}, but not ${Failed.join(', ')}: ${FirstError}` };
  }
  return { Success: true, Detail: Done };
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const P = ResolveConnectionParams(Target);
  if (P.Error) return { Success: false, Error: P.Error };

  let Outcome: MonitoringActionResult;
  if (ActionID === 'overrides.restore') {
    const Snapshot = QLabConnectionManager.Snapshot(QLabConnectionManager.Observe(P));
    // Only the ones QLab reported as off: a key it never answered may not exist
    // in this QLab version, and setting it would come back as an error.
    const Engaged = OVERRIDE_KEYS.filter((Key) => Snapshot.Overrides[Key] === false);
    if (!Engaged.length) {
      const Known = OVERRIDE_KEYS.some((Key) => Snapshot.Overrides[Key] != null);
      return Known
        ? { Success: true, Detail: 'Every input and output is already enabled' }
        : { Success: false, Error: 'QLab has not reported its override states yet' };
    }
    Outcome = await SetOverrides(P, Engaged, true);
  } else if (ActionID === 'override.enable' || ActionID === 'override.disable') {
    if (!IsOverrideKey(Params.Override)) {
      return { Success: false, Error: 'Choose which input or output to change' };
    }
    Outcome = await SetOverrides(P, [Params.Override], ActionID === 'override.enable');
  } else {
    const Command = BuildQLabCommand(ActionID, Params, 5);
    if ('Error' in Command) return { Success: false, Error: Command.Error };
    const Sent = await QLabConnectionManager.Command(P, Command.Address, Command.Args, 'workspace');
    Outcome = Sent.Success
      ? { Success: true, Detail: Command.Detail }
      : { Success: false, Error: Sent.Error || 'QLab did not accept the command' };
  }

  // Re-read mode, running cues and overrides before returning, so the re-probe
  // the caller fires next shows what the press did rather than what it changed.
  if (Outcome.Success) await QLabConnectionManager.Refresh(P);
  return Outcome;
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (
    (ActionID === 'override.enable' || ActionID === 'override.disable') &&
    IsOverrideKey(Params.Override)
  ) {
    return `${ActionID === 'override.enable' ? 'Enable' : 'Disable'} ${FriendlyOverride(Params.Override)}`;
  }
  return DescribeQLabAction(ActionID, Params);
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
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
