// Blackmagic Design Videohub router check, over the Videohub Ethernet Protocol
// (TCP 9990). Confirms the router is present and, optionally, that named
// outputs are still routed to the inputs the show depends on — the "someone
// re-patched the projector feed" failure.
//
// The protocol is entirely server-push: on connect the Videohub Server dumps
// its whole state as blocks, each an all-caps header ending in a colon, body
// lines, and a blank line:
//   PROTOCOL PREAMBLE:      Version: 2.8
//   VIDEOHUB DEVICE:        Device present: true | false | needs_update,
//                           Model name, Friendly name, Unique ID,
//                           Video inputs, Video outputs, ...
//   ALARM STATUS:           `<name>: ok` per sensor (Universal Videohub and
//                           some newer models; absent on most)
//   CONFIGURATION:          Take Mode: true | false (newer firmware)
//   INPUT LABELS / OUTPUT LABELS:   `<index> <label>`
//   VIDEO OUTPUT ROUTING:           `<output> <input>`
//   VIDEO OUTPUT LOCKS:             `<output> U | L | O`
//   ... monitoring / serial / processing-unit blocks on models that have them
//   END PRELUDE:            (newer firmware) the dump is complete
// Ports are 0-based on the wire and 1-based on the chassis and in the UI.
//
// So the probe sends NOTHING: it reads until END PRELUDE, or — on older
// firmware that never sends it — until the device and routing blocks are in
// and the stream has gone quiet, then closes. With no bytes sent it cannot
// change a route, a label or a lock. When the server has no router attached it
// sends `Device present: false` and nothing more, so the probe stops there.
//
// Assertions:
//   - Device present must be `true` (always evaluated; it is "is this the
//     device"). `false` (no router behind the server) and `needs_update`
//     (incompatible router firmware) are Degraded with the reason.
//   - CheckAlarms (default ON): any ALARM STATUS entry that is not `ok` (a
//     failed PSU or fan) is a hardware fault an operator wants to hear about,
//     and routers without the block are unaffected — so it costs nothing to
//     leave on.
//   - CheckRoutes (default OFF) + ExpectedRoutes: `Output:Input` pairs in
//     chassis (1-based) numbering. A malformed or out-of-range entry is NOT
//     dropped: it is kept in the settings and reported as a Degraded reason,
//     because a silently ignored entry is a route the operator believes is
//     watched but is not. NormalizeSettings only tidies valid entries into
//     canonical `3:7` form and splits pasted comma-separated lists.
import { Manager as CacheManager } from '../CacheManager';
import { RunTcpSession, type TcpSession } from './_tcp-session';
import {
  BmdStatePill,
  IsRefusal,
  MonoRow,
  ParseFields,
  ParseIntOrNull,
  ResolveSnapshotTtlMs,
  ResolveTimeoutMs,
  SplitBlocks,
  StripCarriageReturns,
  TimeoutSetting,
  type BmdBlock,
} from './_blackmagic-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'videohub';
const DEFAULT_PORT = 9990;
// Older firmware has no END PRELUDE, so "the dump is over" is inferred from a
// gap in the stream once the device and routing blocks have arrived. The dump
// is sent back-to-back, so a short gap is decisive.
const QUIET_MS = 300;
// A 288×288 Universal Videohub dump with long labels is ~60 KB.
const MAX_BUFFER_CHARS = 1024 * 1024;
// Bound the debug panel's full routing table.
const MAX_DEBUG_ROUTES = 300;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'CheckAlarms',
    Label: 'Check hardware alarms',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the router reports a power supply, fan or other hardware alarm. Routers that do not report alarms are unaffected.',
  },
  {
    Key: 'CheckRoutes',
    Label: 'Check routes',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a listed output is not routed to its expected input.',
  },
  {
    Key: 'ExpectedRoutes',
    Label: 'Expected routes',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckRoutes', Equals: true },
    Note: 'One Output:Input pair per entry, numbered as on the chassis (from 1), e.g. 3:7 for output 3 on input 7. Malformed entries are reported, not ignored.',
  },
  TimeoutSetting(),
];

// --- Expected routes ----------------------------------------------------------

export interface ExpectedRoute {
  /** 1-based, as entered. */
  Output: number;
  Input: number;
}

/** Parse one `Output:Input` entry (1-based). Null when malformed. */
export function ParseExpectedRoute(Entry: unknown): ExpectedRoute | null {
  const Match = String(Entry == null ? '' : Entry).match(/^\s*(\d{1,5})\s*:\s*(\d{1,5})\s*$/);
  if (!Match || !Match[1] || !Match[2]) return null;
  const Output = Number(Match[1]);
  const Input = Number(Match[2]);
  if (Output < 1 || Input < 1) return null;
  return { Output, Input };
}

/** Split pasted lists and tidy valid entries; malformed entries are kept verbatim. */
function NormalizeExpectedRoutes(Value: unknown): string[] {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Out: string[] = [];
  for (const Item of Raw) {
    for (const Piece of String(Item == null ? '' : Item).split(/[,;\n]+/)) {
      const Trimmed = Piece.trim();
      if (!Trimmed) continue;
      const Parsed = ParseExpectedRoute(Trimmed);
      Out.push(Parsed ? `${Parsed.Output}:${Parsed.Input}` : Trimmed);
    }
  }
  return Out;
}

function NormalizeSettings(Input: unknown): Record<string, unknown> {
  if (!Input || typeof Input !== 'object') return {};
  const Cfg = Input as Record<string, unknown>;
  if (!('ExpectedRoutes' in Cfg)) return Cfg;
  return { ...Cfg, ExpectedRoutes: NormalizeExpectedRoutes(Cfg.ExpectedRoutes) };
}

// --- Snapshot -----------------------------------------------------------------

export interface VideohubAlarm {
  Name: string;
  Status: string;
}

export interface VideohubSnapshot {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  /** The stream opened with PROTOCOL PREAMBLE. */
  IsVideohub: boolean;
  ProtocolVersion: string | null;
  /** 'true' | 'false' | 'needs_update' as sent, or null before the device block. */
  DevicePresent: string | null;
  Model: string | null;
  FriendlyName: string | null;
  UniqueId: string | null;
  VideoInputs: number | null;
  VideoOutputs: number | null;
  MonitoringOutputs: number | null;
  SerialPorts: number | null;
  /** 0-based index -> label. */
  InputLabels: Record<string, string>;
  OutputLabels: Record<string, string>;
  /** 0-based output -> 0-based input. */
  Routing: Record<string, number>;
  /** 0-based output -> U / L / O. */
  Locks: Record<string, string>;
  /** Null when the router sent no ALARM STATUS block. */
  Alarms: VideohubAlarm[] | null;
  TakeMode: boolean | null;
  SawDevice: boolean;
  SawRouting: boolean;
  SawEndPrelude: boolean;
}

export function EmptySnapshot(): VideohubSnapshot {
  return {
    Reachable: false,
    IsVideohub: false,
    ProtocolVersion: null,
    DevicePresent: null,
    Model: null,
    FriendlyName: null,
    UniqueId: null,
    VideoInputs: null,
    VideoOutputs: null,
    MonitoringOutputs: null,
    SerialPorts: null,
    InputLabels: {},
    OutputLabels: {},
    Routing: {},
    Locks: {},
    Alarms: null,
    TakeMode: null,
    SawDevice: false,
    SawRouting: false,
    SawEndPrelude: false,
  };
}

// `<index> <rest>` body lines (labels, routing, locks). The rest may be empty
// (a blank label).
function IndexLines(Lines: string[]): Array<{ Index: number; Rest: string }> {
  const Out: Array<{ Index: number; Rest: string }> = [];
  for (const Line of Lines) {
    const Match = Line.match(/^(\d+)(?:\s+(.*))?$/);
    if (!Match || !Match[1]) continue;
    Out.push({ Index: Number(Match[1]), Rest: (Match[2] || '').trim() });
  }
  return Out;
}

/**
 * Fold one block into the snapshot. Later blocks of the same kind (status
 * updates carry only what changed) merge rather than replace. Unknown blocks
 * are ignored, as the protocol asks of clients.
 */
export function ApplyBlock(Snap: VideohubSnapshot, Block: BmdBlock): void {
  switch (Block.Header.toUpperCase()) {
    case 'PROTOCOL PREAMBLE:': {
      Snap.IsVideohub = true;
      Snap.ProtocolVersion = ParseFields(Block.Lines)['version'] || null;
      return;
    }
    case 'VIDEOHUB DEVICE:': {
      const F = ParseFields(Block.Lines);
      Snap.SawDevice = true;
      Snap.DevicePresent = F['device present'] ? F['device present'].toLowerCase() : null;
      Snap.Model = F['model name'] || null;
      Snap.FriendlyName = F['friendly name'] || null;
      Snap.UniqueId = F['unique id'] || null;
      Snap.VideoInputs = ParseIntOrNull(F['video inputs']);
      Snap.VideoOutputs = ParseIntOrNull(F['video outputs']);
      Snap.MonitoringOutputs = ParseIntOrNull(F['video monitoring outputs']);
      Snap.SerialPorts = ParseIntOrNull(F['serial ports']);
      return;
    }
    case 'INPUT LABELS:':
      for (const L of IndexLines(Block.Lines)) Snap.InputLabels[L.Index] = L.Rest;
      return;
    case 'OUTPUT LABELS:':
      for (const L of IndexLines(Block.Lines)) Snap.OutputLabels[L.Index] = L.Rest;
      return;
    case 'VIDEO OUTPUT ROUTING:':
      Snap.SawRouting = true;
      for (const L of IndexLines(Block.Lines)) {
        const Input = ParseIntOrNull(L.Rest);
        if (Input != null && Input >= 0) Snap.Routing[L.Index] = Input;
      }
      return;
    case 'VIDEO OUTPUT LOCKS:':
      for (const L of IndexLines(Block.Lines)) {
        if (L.Rest) Snap.Locks[L.Index] = L.Rest.toUpperCase().slice(0, 1);
      }
      return;
    case 'ALARM STATUS:': {
      // `<name>: <status>`. Names contain spaces but never a colon, so the
      // first colon separates them.
      const Alarms = Snap.Alarms ? [...Snap.Alarms] : [];
      for (const Line of Block.Lines) {
        const Colon = Line.indexOf(':');
        if (Colon <= 0) continue;
        const Name = Line.slice(0, Colon).trim();
        const Status = Line.slice(Colon + 1).trim();
        const Existing = Alarms.findIndex((A) => A.Name === Name);
        if (Existing >= 0) Alarms[Existing] = { Name, Status };
        else Alarms.push({ Name, Status });
      }
      Snap.Alarms = Alarms;
      return;
    }
    case 'CONFIGURATION:': {
      const Take = ParseFields(Block.Lines)['take mode'];
      if (Take != null) Snap.TakeMode = Take.toLowerCase() === 'true';
      return;
    }
    case 'END PRELUDE:':
      Snap.SawEndPrelude = true;
      return;
    default:
      return;
  }
}

/** A dump that will not grow: END PRELUDE, or a server with no usable router. */
function IsFinal(Snap: VideohubSnapshot): boolean {
  if (Snap.SawEndPrelude) return true;
  return Snap.SawDevice && Snap.DevicePresent !== 'true';
}

export async function QueryVideohub(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<VideohubSnapshot> {
  const BudgetMs = Math.max(500, TimeoutMs | 0);
  const QuietMs = Math.min(QUIET_MS, Math.max(50, (BudgetMs / 4) | 0));
  const Snap = EmptySnapshot();
  let Buffered = '';
  let ReceivedAny = false;
  let FirstDataAt: number | null = null;
  let Quiet: ReturnType<typeof setTimeout> | null = null;

  const Reached = (Session: TcpSession<VideohubSnapshot>): VideohubSnapshot => ({
    ...Snap,
    Reachable: true,
    LatencyMs: (FirstDataAt ?? Date.now()) - Session.StartedAt,
  });
  const Failed = (Message: string): VideohubSnapshot => ({
    ...EmptySnapshot(),
    Reachable: false,
    Error: Message,
  });
  // Bytes that are not a Videohub stream read as a reachable wrong device;
  // silence reads as offline.
  const Ended = (Session: TcpSession<VideohubSnapshot>, SilentError: string): VideohubSnapshot =>
    Snap.IsVideohub || ReceivedAny ? Reached(Session) : Failed(SilentError);

  return RunTcpSession<VideohubSnapshot>({
    Address,
    Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    OnData: (Chunk, Session) => {
      if (!ReceivedAny) {
        ReceivedAny = true;
        FirstDataAt = Date.now();
      }
      Buffered += StripCarriageReturns(Chunk.toString('utf8'));
      if (Buffered.length > MAX_BUFFER_CHARS) {
        Session.Finish(Reached(Session));
        return;
      }

      // Fingerprint on the very first line: the protocol guarantees the
      // preamble comes first, so anything else is some other service.
      if (!Snap.IsVideohub) {
        const FirstLineEnd = Buffered.replace(/^\n+/, '').indexOf('\n');
        if (FirstLineEnd !== -1) {
          const FirstLine = Buffered.replace(/^\n+/, '').slice(0, FirstLineEnd).trim();
          if (FirstLine.toUpperCase() !== 'PROTOCOL PREAMBLE:') {
            Session.Finish(Reached(Session));
            return;
          }
        }
      }

      const { Blocks, Rest } = SplitBlocks(Buffered, false);
      Buffered = Rest;
      for (const Block of Blocks) ApplyBlock(Snap, Block);

      if (IsFinal(Snap)) {
        Session.Finish(Reached(Session));
        return;
      }
      // Older firmware: settle once the essentials are in and the stream pauses.
      if (Snap.SawDevice && Snap.SawRouting) {
        if (Quiet) clearTimeout(Quiet);
        Quiet = setTimeout(() => Session.Finish(Reached(Session)), QuietMs);
      }
    },
    OnSettle: () => {
      if (Quiet) clearTimeout(Quiet);
      Quiet = null;
    },
    OnTimeout: (Session) => Ended(Session, `No reply from Videohub after ${BudgetMs}ms`),
    OnError: (Message) => Failed(Message),
    OnClose: (Session) => Ended(Session, 'Connection closed before the Videohub preamble'),
  });
}

// --- Snapshot cache -------------------------------------------------------------

const SNAPSHOT_CACHE = CacheManager.GetBucket('MonitoringMethods:Videohub', {
  defaultTtlMs: 1000,
  maxEntries: 500,
});

// --- Settings / evaluation ------------------------------------------------------

export interface VideohubConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): VideohubConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    TimeoutMs: ResolveTimeoutMs(Cfg.Timeout),
  };
}

export interface VideohubOptions {
  CheckAlarms: boolean;
  CheckRoutes: boolean;
  ExpectedRoutes: string[];
}

function ParseHealthOptions(Target: MonitoringTargetLike): VideohubOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    // Default ON: an absent key still checks alarms.
    CheckAlarms: Cfg.CheckAlarms !== false,
    CheckRoutes: Cfg.CheckRoutes === true,
    ExpectedRoutes: NormalizeExpectedRoutes(Cfg.ExpectedRoutes),
  };
}

/** `Output 3 (Proj L)`; the label is omitted when blank or just the default name. */
export function DescribePort(
  Kind: 'Input' | 'Output',
  Index0: number,
  Labels: Record<string, string>
): string {
  const Number1 = Index0 + 1;
  const Label = (Labels[Index0] || '').trim();
  const IsDefault = !Label || Label.toLowerCase() === `${Kind} ${Number1}`.toLowerCase();
  return IsDefault ? `${Kind} ${Number1}` : `${Kind} ${Number1} (${Label})`;
}

export interface RouteCheck {
  Entry: string;
  /** 1-based, when the entry parsed. */
  Output: number | null;
  Input: number | null;
  /** 1-based input currently on the output, when known. */
  ActualInput: number | null;
  /** Display names with labels (`Output 3 (Proj L)`), for the debug panel. */
  OutputName: string | null;
  ExpectedName: string | null;
  ActualName: string | null;
  /** true match, false mismatch, null not evaluable (Problem says why). */
  Match: boolean | null;
  /** The degraded reason for this entry; null when it matches. */
  Problem: string | null;
}

export function CheckRoutes(Snap: VideohubSnapshot, Entries: string[]): RouteCheck[] {
  return Entries.map((Entry): RouteCheck => {
    const Parsed = ParseExpectedRoute(Entry);
    if (!Parsed) {
      return {
        Entry,
        Output: null,
        Input: null,
        ActualInput: null,
        OutputName: null,
        ExpectedName: null,
        ActualName: null,
        Match: null,
        Problem: `Expected route "${Entry}" is not in Output:Input form`,
      };
    }
    const Out0 = Parsed.Output - 1;
    const Want0 = Parsed.Input - 1;
    const OutputName = DescribePort('Output', Out0, Snap.OutputLabels);
    const ExpectedName = DescribePort('Input', Want0, Snap.InputLabels);
    const Base = {
      Entry,
      Output: Parsed.Output,
      Input: Parsed.Input,
      ActualInput: null,
      OutputName,
      ExpectedName,
      ActualName: null,
    };
    if (Snap.VideoOutputs != null && Parsed.Output > Snap.VideoOutputs) {
      return {
        ...Base,
        Match: null,
        Problem: `Expected route ${Entry}: the router has ${Snap.VideoOutputs} outputs`,
      };
    }
    if (Snap.VideoInputs != null && Parsed.Input > Snap.VideoInputs) {
      return {
        ...Base,
        Match: null,
        Problem: `Expected route ${Entry}: the router has ${Snap.VideoInputs} inputs`,
      };
    }
    const Actual0 = Snap.Routing[Out0];
    if (Actual0 == null) {
      return { ...Base, Match: null, Problem: `${OutputName}: route not reported` };
    }
    const Actual = {
      ActualInput: Actual0 + 1,
      ActualName: DescribePort('Input', Actual0, Snap.InputLabels),
    };
    if (Actual0 === Want0) return { ...Base, ...Actual, Match: true, Problem: null };
    return {
      ...Base,
      ...Actual,
      Match: false,
      Problem: `${OutputName} is on ${Actual.ActualName}, expected ${ExpectedName}`,
    };
  });
}

// The reasons a reachable server is unhealthy, per the enabled assertions.
// Pure — exported via _internal for unit tests.
function EvaluateHealth(Snap: VideohubSnapshot, Options: VideohubOptions): string[] {
  if (!Snap.IsVideohub) return ['Responded, but does not look like a Videohub'];
  if (!Snap.SawDevice) return ['Timed out before the router described itself'];
  if (Snap.DevicePresent === 'false') return ['No router connected to the Videohub Server'];
  if (Snap.DevicePresent === 'needs_update') {
    return ['Router firmware needs updating (Device present: needs_update)'];
  }
  if (Snap.DevicePresent !== 'true') {
    return [`Unexpected device state "${Snap.DevicePresent || 'missing'}"`];
  }

  const Reasons: string[] = [];
  if (Options.CheckAlarms && Snap.Alarms) {
    for (const Alarm of Snap.Alarms) {
      if (Alarm.Status.toLowerCase() !== 'ok') Reasons.push(`${Alarm.Name} alarm: ${Alarm.Status}`);
    }
  }
  if (Options.CheckRoutes) {
    if (!Snap.SawRouting) {
      Reasons.push('Routing table not received');
    } else {
      for (const Check of CheckRoutes(Snap, Options.ExpectedRoutes)) {
        if (Check.Problem) Reasons.push(Check.Problem);
      }
    }
  }
  return Reasons;
}

// --- Run ------------------------------------------------------------------------

export interface RouteRow {
  /** 1-based. */
  Output: number;
  OutputLabel: string;
  Input: number;
  InputLabel: string;
  /** U unlocked, L locked by another client, O locked from ShowTrak's own IP. */
  Lock: string | null;
}

function RoutingTable(Snap: VideohubSnapshot): RouteRow[] {
  return Object.keys(Snap.Routing)
    .map(Number)
    .sort((A, B) => A - B)
    .map((Out0) => {
      const In0 = Snap.Routing[Out0] ?? 0;
      return {
        Output: Out0 + 1,
        OutputLabel: Snap.OutputLabels[Out0] || '',
        Input: In0 + 1,
        InputLabel: Snap.InputLabels[In0] || '',
        Lock: Snap.Locks[Out0] || null,
      };
    });
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Snap = (await SNAPSHOT_CACHE.GetOrCreate(
    `${Config.Address.toLowerCase()}|${Config.Port}|${Config.TimeoutMs}`,
    () => QueryVideohub(Config.Address, Config.Port, Config.TimeoutMs),
    { ttlMs: ResolveSnapshotTtlMs(Config.TimeoutMs) }
  )) as VideohubSnapshot;

  if (!Snap.Reachable) {
    const Message = Snap.Error || 'No reply from Videohub';
    return { Success: false, ...(IsRefusal(Message) ? { Degraded: true } : {}), Error: Message };
  }

  const Options = ParseHealthOptions(Target);
  const Reasons = EvaluateHealth(Snap, Options);

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs ?? null,
    IsVideohub: Snap.IsVideohub,
    ProtocolVersion: Snap.ProtocolVersion,
    DevicePresent: Snap.DevicePresent,
    Model: Snap.Model,
    FriendlyName: Snap.FriendlyName,
    UniqueId: Snap.UniqueId,
    VideoInputs: Snap.VideoInputs,
    VideoOutputs: Snap.VideoOutputs,
    MonitoringOutputs: Snap.MonitoringOutputs,
    SerialPorts: Snap.SerialPorts,
    Alarms: Snap.Alarms,
    TakeMode: Snap.TakeMode,
    EndPrelude: Snap.SawEndPrelude,
    Routes: RoutingTable(Snap),
    RouteChecks: Options.CheckRoutes ? CheckRoutes(Snap, Options.ExpectedRoutes) : [],
  };
}

// --- Debug ----------------------------------------------------------------------

function RouteCheckPill(Check: RouteCheck): string {
  if (Check.Match === true) return Pill('success', 'Match');
  if (Check.Match === false) return Pill('warning', 'Mismatch');
  return Pill('muted', Check.Output == null ? 'Invalid' : 'Unknown');
}

function LockText(Lock: string | null): string {
  if (Lock === 'L') return ' · locked';
  if (Lock === 'O') return ' · locked from this host';
  return '';
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Alarms: VideohubAlarm[] = Array.isArray(Result && Result.Alarms)
    ? (Result.Alarms as VideohubAlarm[])
    : [];
  const BadAlarms = Alarms.filter((A) => String(A.Status).toLowerCase() !== 'ok');

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Reachable && Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Reachable && Result.FriendlyName ? TextRow('Name', String(Result.FriendlyName)) : null,
    Reachable && Result.ProtocolVersion
      ? TextRow('Protocol', String(Result.ProtocolVersion))
      : null,
    Row('Status', BmdStatePill(Result, 'Healthy')),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the Videohub'),
    Reachable && Result.VideoInputs != null && Result.VideoOutputs != null
      ? MonoRow('Size', `${String(Result.VideoInputs)} in × ${String(Result.VideoOutputs)} out`)
      : null,
    Reachable && Alarms.length
      ? Row(
          'Alarms',
          BadAlarms.length
            ? BadAlarms.map((A) => Pill('warning', `${A.Name}: ${A.Status}`)).join(' ')
            : Pill('success', `${Alarms.length} ok`)
        )
      : null,
  ]);

  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the Videohub Ethernet Protocol (TCP ${Config.Port}). Check the address and that Videohub Server is running.`
      ) +
      '</div>'
    );
  }
  if (Result.IsVideohub === false || Result.DevicePresent !== 'true') return Head;

  const Routes: RouteRow[] = Array.isArray(Result.Routes) ? (Result.Routes as RouteRow[]) : [];
  const Checks: RouteCheck[] = Array.isArray(Result.RouteChecks)
    ? (Result.RouteChecks as RouteCheck[])
    : [];
  // Compact table cell: `Out 3 · Proj L`, without the label when it is blank
  // or just the router's default name for the port.
  const Cell = (Short: string, Kind: string, N: number, Label: string): string => {
    const Trimmed = (Label || '').trim();
    const IsDefault = !Trimmed || Trimmed.toLowerCase() === `${Kind} ${N}`.toLowerCase();
    return IsDefault ? `${Short} ${N}` : `${Short} ${N} · ${Trimmed}`;
  };

  let Html = Head;

  if (Options.CheckRoutes) {
    const Cards = Checks.map((C) => {
      const Title =
        C.OutputName && C.ExpectedName ? `${C.OutputName} → ${C.ExpectedName}` : `"${C.Entry}"`;
      const Body =
        C.Match === false && C.ActualName
          ? `Currently ${C.ActualName}`
          : C.Match !== true && C.Problem
            ? C.Problem
            : '';
      return Card({
        Title,
        Badge: RouteCheckPill(C),
        Highlight: C.Match === true,
        BodyHtml: Body ? `<div class="text-muted small text-break">${Esc(Body)}</div>` : '',
      });
    }).join('');
    Html +=
      `<div class="text-muted small mt-2 mb-1">Expected routes (${Checks.length})</div>` +
      (Checks.length
        ? `<div class="d-grid gap-1">${Cards}</div>`
        : Note('No expected routes listed'));
  }

  if (!Routes.length) return Html + '<div class="mt-2">' + Note('No routing reported') + '</div>';

  const Shown = Routes.slice(0, MAX_DEBUG_ROUTES);
  const Lines = Shown.map(
    (R) =>
      '<div class="d-flex justify-content-between gap-3 small font-monospace monitoring-debug-row">' +
      `<span class="text-light text-break">${Esc(Cell('Out', 'Output', R.Output, R.OutputLabel))}</span>` +
      `<span class="text-muted text-end text-break">${Esc(Cell('In', 'Input', R.Input, R.InputLabel) + LockText(R.Lock))}</span>` +
      '</div>'
  ).join('');
  return (
    Html +
    `<div class="text-muted small mt-2 mb-1">Routing (${Routes.length} outputs)</div>` +
    `<div class="d-grid gap-0">${Lines}</div>` +
    (Routes.length > Shown.length ? Note(`…and ${Routes.length - Shown.length} more outputs`) : '')
  );
}

export const Name = 'Blackmagic Videohub';
export const Description =
  'Connects to a Blackmagic Videohub router (or Videohub Server) on the Videohub Ethernet Protocol (TCP 9990) and reads the state dump it sends on connect — sending nothing, so it cannot change a route. Degraded when no router is attached, the router needs a firmware update, or a hardware alarm is raised; optionally also when a listed output is not routed to its expected input.';
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseExpectedRoute,
  NormalizeExpectedRoutes,
  ApplyBlock,
  EmptySnapshot,
  CheckRoutes,
  DescribePort,
  ParseHealthOptions,
  ParseConfig,
  EvaluateHealth,
  RoutingTable,
  QueryVideohub,
};
export { ID, Settings, NormalizeSettings, Run, Debug };
