// AV Stumpfl PIXERA media server check over PIXERA's native JSON-RPC API.
//
// Protocol (AV Stumpfl "Pixera API Documentation" + the generated
// pixera_api_comments/examples_rev481.txt shipped with PIXERA, cross-checked
// against Bitfocus companion-module-avstumpfl-pixera):
//   - PIXERA is the TCP SERVER. The API access points are configured under
//     Settings → API; each has a port and a protocol. There is no factory port:
//     1400 is the value AV Stumpfl's own examples (and the Companion module) use.
//     PIXERA must be restarted for API-port changes to take effect.
//   - Two TCP framings, chosen per access point:
//       "JSON/TCP"     : every message is "pxr1" + uint32 LITTLE-endian payload
//                        length + the UTF-8 JSON payload.
//       "JSON/TCP(dl)" : no header; every message is the JSON followed by the
//                        four characters "0xPX".
//     Replies use the same framing as the access point. Sending the wrong one
//     gets no reply at all, so the framing is a setting here.
//   - JSON-RPC 2.0, matched by id: {"jsonrpc":"2.0","id":1,"method":"…",
//     "params":{…}} → {"jsonrpc":"2.0","id":1,"result":…}.
//
// Methods used (all documented getters — nothing that changes state):
//   Pixera.Utility.getApiRevision            → int (even = release, odd = beta)
//   Pixera.Session.getProjectName            → string
//   Pixera.Timelines.getTimelineNames        → string[]
//   Pixera.Compound.getTransportModeOnTimeline {timelineName} → 1 Play, 2 Pause, 3 Stop
//
// PIXERA reports no application version over the API — only the API revision —
// so that is what the identity shows.
//
// Design: one short-lived connection. The three identity reads go out together,
// then the transport of every timeline (listed ones first, capped) in a second
// burst; replies are matched by id. The configured Timeout bounds the WHOLE
// probe. A reply to getApiRevision is the fingerprint.
import { RunTcpSession, type TcpSession } from './_tcp-session';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'pixera';

export const DEFAULT_PIXERA_PORT = 1400;
const DEFAULT_TIMEOUT_MS = 4000;
// Timelines whose transport is read per probe. Listed timelines always come
// first; the rest are for the debug panel only, so a large project is capped.
const MAX_TIMELINE_READS = 64;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

const PXR1_TAG = Buffer.from('pxr1', 'latin1');
const DL_DELIMITER = Buffer.from('0xPX', 'latin1');

export type PixeraFraming = 'pxr1' | 'dl';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'API port',
    Type: 'number',
    Default: DEFAULT_PIXERA_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'The port of a JSON/TCP access point under Settings → API in PIXERA. PIXERA has no fixed default; 1400 is the conventional value.',
  },
  {
    Key: 'Framing',
    Label: 'Access point protocol',
    Type: 'select',
    Default: 'pxr1',
    Options: [
      { value: 'pxr1', label: 'JSON/TCP' },
      { value: 'dl', label: 'JSON/TCP(dl)' },
    ],
    Note: 'Must match the protocol chosen for that access point in PIXERA. A mismatch gets no reply.',
  },
  {
    Key: 'CheckProject',
    Label: 'Check project',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different project is open.',
  },
  {
    Key: 'ExpectedProject',
    Label: 'Expected project name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckProject', Equals: true },
    Note: 'Not case-sensitive.',
  },
  {
    Key: 'CheckPlayingTimelines',
    Label: 'Check timelines playing',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded unless every listed timeline is playing.',
  },
  {
    Key: 'PlayingTimelines',
    Label: 'Timeline names',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckPlayingTimelines', Equals: true },
    Note: 'Names as shown in the timeline library. Paused, stopped and missing timelines each report Degraded.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
];

// --- Config -----------------------------------------------------------------

export interface PixeraConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
  Framing: PixeraFraming;
}

function ParseConfig(Target: MonitoringTargetLike): PixeraConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: Number.isFinite(Port) && Port > 0 ? Math.floor(Port) : DEFAULT_PIXERA_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
    Framing: Cfg.Framing === 'dl' ? 'dl' : 'pxr1',
  };
}

interface HealthOptions {
  CheckProject: boolean;
  ExpectedProject: string;
  CheckPlayingTimelines: boolean;
  PlayingTimelines: string[];
}

function AsList(Value: unknown): string[] {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Out: string[] = [];
  for (const Item of Raw) {
    const S = String(Item == null ? '' : Item).trim();
    if (S && !Out.some((O) => O.toLowerCase() === S.toLowerCase())) Out.push(S);
  }
  return Out;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    CheckProject: !!Cfg.CheckProject,
    ExpectedProject: String(Cfg.ExpectedProject || '').trim(),
    CheckPlayingTimelines: !!Cfg.CheckPlayingTimelines,
    PlayingTimelines: AsList(Cfg.PlayingTimelines),
  };
}

// --- Framing ------------------------------------------------------------------

function EncodeRequest(
  Id: number,
  Method: string,
  Params: Record<string, unknown> | null,
  Framing: PixeraFraming
): Buffer {
  const Body = Buffer.from(
    JSON.stringify(
      Params
        ? { jsonrpc: '2.0', id: Id, method: Method, params: Params }
        : { jsonrpc: '2.0', id: Id, method: Method }
    ),
    'utf8'
  );
  if (Framing === 'dl') return Buffer.concat([Body, DL_DELIMITER]);
  const Header = Buffer.alloc(8);
  PXR1_TAG.copy(Header, 0);
  // The length is the payload's BYTE count (not its character count — a
  // non-ASCII timeline name would otherwise desync the stream).
  Header.writeUInt32LE(Body.length, 4);
  return Buffer.concat([Header, Body]);
}

// Pull every complete message out of the accumulated stream. Each message is
// recognised by its own shape — a "pxr1" header, or JSON up to "0xPX" — so a
// reply in either framing is read whichever one was sent. Returns the payload
// strings and the unconsumed tail; Desync is set when the stream cannot be
// framed at all (junk), so the caller can stop waiting.
function DecodeStream(Stream: Buffer): { Messages: string[]; Rest: Buffer; Desync: boolean } {
  const Messages: string[] = [];
  let Pos = 0;
  while (Pos < Stream.length) {
    const Remaining = Stream.length - Pos;
    // A header that may still be arriving.
    if (Remaining < 4 && PXR1_TAG.subarray(0, Remaining).equals(Stream.subarray(Pos))) break;
    if (Remaining >= 4 && Stream.subarray(Pos, Pos + 4).equals(PXR1_TAG)) {
      if (Remaining < 8) break;
      const Size = Stream.readUInt32LE(Pos + 4);
      if (Size > MAX_BUFFER_BYTES) return { Messages, Rest: Buffer.alloc(0), Desync: true };
      if (Remaining < 8 + Size) break;
      Messages.push(Stream.toString('utf8', Pos + 8, Pos + 8 + Size));
      Pos += 8 + Size;
      continue;
    }
    // Delimited mode: JSON then "0xPX". Anything not starting like JSON is junk.
    const First = Stream[Pos];
    if (First === 0x0d || First === 0x0a || First === 0x20 || First === 0x09) {
      Pos++;
      continue;
    }
    if (First !== 0x7b /* { */) return { Messages, Rest: Buffer.alloc(0), Desync: true };
    const End = Stream.indexOf(DL_DELIMITER, Pos);
    if (End < 0) break;
    Messages.push(Stream.toString('utf8', Pos, End));
    Pos = End + DL_DELIMITER.length;
  }
  return { Messages, Rest: Stream.subarray(Pos), Desync: false };
}

interface RpcReply {
  Id: number;
  Ok: boolean;
  Result: unknown;
  Error: string | null;
}

// Device JSON is untrusted: only primitive fields are read, and nothing is
// coerced with Number()/String() — an object with a hostile toString/valueOf
// (e.g. {"id":{"toString":1}}) would otherwise throw.
function ParseReply(Text: string): RpcReply | null {
  let Parsed: unknown;
  try {
    Parsed = JSON.parse(Text);
  } catch {
    return null;
  }
  if (!Parsed || typeof Parsed !== 'object' || Array.isArray(Parsed)) return null;
  const Obj = Parsed as Record<string, unknown>;
  const RawId = Obj.id;
  const Id =
    typeof RawId === 'number'
      ? RawId
      : typeof RawId === 'string' && /^\d+$/.test(RawId)
        ? Number(RawId)
        : NaN;
  if (!Number.isInteger(Id)) return null;
  if (Obj.error != null) {
    const Err = Obj.error;
    const Inner =
      Err && typeof Err === 'object' ? (Err as Record<string, unknown>).message : undefined;
    const Message =
      typeof Inner === 'string'
        ? Inner
        : typeof Err === 'string' || typeof Err === 'number'
          ? String(Err)
          : 'JSON-RPC error';
    return { Id, Ok: false, Result: null, Error: Message };
  }
  return { Id, Ok: true, Result: Obj.result, Error: null };
}

// --- Probe ------------------------------------------------------------------

export type PixeraTransport = 'play' | 'pause' | 'stop';

export interface PixeraTimelineState {
  Name: string;
  Transport: PixeraTransport | null;
}

export interface PixeraSnapshot {
  LatencyMs: number;
  // getApiRevision answered with a number.
  IsPixera: boolean;
  ApiRevision: number | null;
  ProjectName: string | null;
  // Null when the timeline list could not be read.
  TimelineNames: string[] | null;
  Timelines: PixeraTimelineState[];
  TimelinesTruncated: boolean;
}

export type PixeraProbeOutcome =
  | { Reachable: true; Snapshot: PixeraSnapshot }
  | { Reachable: false; Error: string; Refused: boolean };

const ID_REVISION = 1;
const ID_PROJECT = 2;
const ID_TIMELINES = 3;
const ID_TRANSPORT_BASE = 100;

function TransportOf(Value: unknown): PixeraTransport | null {
  if (Value === 1) return 'play';
  if (Value === 2) return 'pause';
  if (Value === 3) return 'stop';
  return null;
}

// Which timelines to read: the listed ones that exist (in list order), then the
// rest for the debug panel, up to the cap.
function PlanTimelineReads(
  Names: string[],
  Wanted: string[]
): { Reads: string[]; Truncated: boolean } {
  const Reads: string[] = [];
  for (const W of Wanted) {
    const Hit = Names.find((N) => N.toLowerCase() === W.toLowerCase());
    if (Hit != null && !Reads.includes(Hit)) Reads.push(Hit);
  }
  for (const N of Names) {
    if (Reads.length >= MAX_TIMELINE_READS) break;
    if (!Reads.includes(N)) Reads.push(N);
  }
  const Unique = new Set(Names);
  return { Reads, Truncated: Unique.size > Reads.length };
}

export function QueryPixera(Config: PixeraConfig, Wanted: string[]): Promise<PixeraProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  let Stream = Buffer.alloc(0);
  let AnyBytes = false;
  let RevisionAt: number | null = null;
  const Replies = new Map<number, RpcReply>();
  let TransportIds: Array<{ Id: number; Name: string }> | null = null;
  const Snap: PixeraSnapshot = {
    LatencyMs: 0,
    IsPixera: false,
    ApiRevision: null,
    ProjectName: null,
    TimelineNames: null,
    Timelines: [],
    TimelinesTruncated: false,
  };

  const Reached = (Session: TcpSession<PixeraProbeOutcome>): PixeraProbeOutcome => {
    Snap.LatencyMs = (RevisionAt ?? Date.now()) - Session.StartedAt;
    if (TransportIds) {
      Snap.Timelines = TransportIds.map(({ Id, Name }) => {
        const R = Replies.get(Id);
        return { Name, Transport: R && R.Ok ? TransportOf(R.Result) : null };
      });
    }
    return { Reachable: true, Snapshot: Snap };
  };

  const Send = (Session: TcpSession<PixeraProbeOutcome>, Frames: Buffer[]): void => {
    try {
      Session.Socket.write(Buffer.concat(Frames));
    } catch {
      // A failed write surfaces through the socket's error event.
    }
  };

  const Step = (Session: TcpSession<PixeraProbeOutcome>): void => {
    const Revision = Replies.get(ID_REVISION);
    if (Revision && RevisionAt == null) {
      RevisionAt = Date.now();
      if (Revision.Ok && typeof Revision.Result === 'number') {
        Snap.IsPixera = true;
        Snap.ApiRevision = Revision.Result;
      }
    }
    if (!Replies.has(ID_REVISION) || !Replies.has(ID_PROJECT) || !Replies.has(ID_TIMELINES)) return;

    if (TransportIds == null) {
      const Project = Replies.get(ID_PROJECT);
      if (Project && Project.Ok && typeof Project.Result === 'string') {
        Snap.ProjectName = Project.Result;
      }
      const List = Replies.get(ID_TIMELINES);
      if (List && List.Ok && Array.isArray(List.Result)) {
        Snap.TimelineNames = List.Result.filter((N): N is string => typeof N === 'string');
      }
      if (!Snap.IsPixera) {
        Session.Finish(Reached(Session));
        return;
      }
      const Plan = PlanTimelineReads(Snap.TimelineNames || [], Wanted);
      Snap.TimelinesTruncated = Plan.Truncated;
      TransportIds = Plan.Reads.map((Name, Index) => ({ Id: ID_TRANSPORT_BASE + Index, Name }));
      if (TransportIds.length) {
        Send(
          Session,
          TransportIds.map(({ Id, Name }) =>
            EncodeRequest(
              Id,
              'Pixera.Compound.getTransportModeOnTimeline',
              { timelineName: Name },
              Config.Framing
            )
          )
        );
      }
    }
    if (TransportIds.every(({ Id }) => Replies.has(Id))) Session.Finish(Reached(Session));
  };

  return RunTcpSession<PixeraProbeOutcome>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnConnect: (Session) => {
      Send(Session, [
        EncodeRequest(ID_REVISION, 'Pixera.Utility.getApiRevision', null, Config.Framing),
        EncodeRequest(ID_PROJECT, 'Pixera.Session.getProjectName', null, Config.Framing),
        EncodeRequest(ID_TIMELINES, 'Pixera.Timelines.getTimelineNames', null, Config.Framing),
      ]);
    },
    OnData: (Chunk, Session) => {
      AnyBytes = true;
      Stream = Stream.length ? Buffer.concat([Stream, Chunk]) : Chunk;
      if (Stream.length > MAX_BUFFER_BYTES) {
        Session.Finish(Reached(Session));
        return;
      }
      const Decoded = DecodeStream(Stream);
      Stream = Decoded.Rest;
      for (const Text of Decoded.Messages) {
        const Reply = ParseReply(Text);
        if (Reply && !Replies.has(Reply.Id)) Replies.set(Reply.Id, Reply);
      }
      if (Decoded.Desync && RevisionAt == null) {
        // Not PIXERA's framing at all — no point waiting out the deadline.
        Session.Finish(Reached(Session));
        return;
      }
      Step(Session);
    },
    OnTimeout: (Session) => {
      // Whatever arrived is reported; with no byte at all the access point is
      // probably set to the other framing (or is not an API port).
      if (RevisionAt != null || AnyBytes) return Reached(Session);
      return {
        Reachable: false,
        Error: `No reply within ${BudgetMs}ms — check the access point protocol matches`,
        Refused: false,
      };
    },
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => {
      if (RevisionAt != null || AnyBytes) return Reached(Session);
      return { Reachable: false, Error: 'Connection closed before PIXERA replied', Refused: false };
    },
  });
}

// --- Evaluation -------------------------------------------------------------

// Normalise a project name for comparison: trimmed, lower-cased, without a
// trailing .pxr in case one side was typed as a file name.
function NormalizeProject(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.pxr$/i, '');
}

const TRANSPORT_LABELS: Record<PixeraTransport, string> = {
  play: 'playing',
  pause: 'paused',
  stop: 'stopped',
};

// The reasons a reachable PIXERA is unhealthy, per the enabled toggles. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: PixeraSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsPixera) return ['Responded, but does not look like the PIXERA JSON API'];
  const Reasons: string[] = [];

  if (Options.CheckProject && Options.ExpectedProject) {
    if (Snapshot.ProjectName == null) {
      Reasons.push('Failed to read the project name');
    } else if (
      NormalizeProject(Snapshot.ProjectName) !== NormalizeProject(Options.ExpectedProject)
    ) {
      Reasons.push(`Project "${Snapshot.ProjectName}" (expected "${Options.ExpectedProject}")`);
    }
  }

  if (Options.CheckPlayingTimelines && Options.PlayingTimelines.length) {
    if (Snapshot.TimelineNames == null) {
      Reasons.push('Failed to read the timeline list');
    } else {
      for (const Wanted of Options.PlayingTimelines) {
        const Name = Snapshot.TimelineNames.find((N) => N.toLowerCase() === Wanted.toLowerCase());
        if (Name == null) {
          Reasons.push(`Timeline "${Wanted}": not found`);
          continue;
        }
        const State = Snapshot.Timelines.find((T) => T.Name === Name);
        const Transport = State ? State.Transport : null;
        if (Transport == null) Reasons.push(`Timeline "${Name}": failed to read transport`);
        else if (Transport !== 'play')
          Reasons.push(`Timeline "${Name}": ${TRANSPORT_LABELS[Transport]}`);
      }
    }
  }

  return Reasons;
}

// --- Run / Debug ------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Options = ParseHealthOptions(Target);

  const Outcome = await QueryPixera(
    Config,
    Options.CheckPlayingTimelines ? Options.PlayingTimelines : []
  );
  if (!Outcome.Reachable) {
    return { Success: false, ...(Outcome.Refused ? { Degraded: true } : {}), Error: Outcome.Error };
  }

  const Snap = Outcome.Snapshot;
  const Reasons = EvaluateHealth(Snap, Options);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    IsPixera: Snap.IsPixera,
    ApiRevision: Snap.ApiRevision,
    ApiBeta: Snap.ApiRevision == null ? null : Snap.ApiRevision % 2 === 1,
    ProjectName: Snap.ProjectName,
    TimelineCount: Snap.TimelineNames ? Snap.TimelineNames.length : null,
    Timelines: Snap.Timelines,
    TimelinesTruncated: Snap.TimelinesTruncated,
  };
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function TransportPill(Transport: unknown): string {
  if (Transport === 'play') return Pill('success', 'Playing');
  if (Transport === 'pause') return Pill('warning', 'Paused');
  if (Transport === 'stop') return Pill('muted', 'Stopped');
  return Pill('muted', 'Unknown');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const Head = Rows([
    TextRow(
      'Host',
      `${Config.Address || '—'}:${Config.Port} (${Config.Framing === 'dl' ? 'JSON/TCP(dl)' : 'JSON/TCP'})`
    ),
    Reachable && Result.ApiRevision != null
      ? TextRow('API revision', `${Result.ApiRevision}${Result.ApiBeta ? ' (beta)' : ''}`)
      : null,
    Reachable && Result.ProjectName != null
      ? TextRow(
          'Project',
          String(Result.ProjectName) +
            (Options.CheckProject && Options.ExpectedProject
              ? ` (expected "${Options.ExpectedProject}")`
              : '')
        )
      : null,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach PIXERA'),
    Reachable && Result.TimelineCount != null
      ? TextRow('Timelines', String(Result.TimelineCount))
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note('Failed to reach the PIXERA API. Check the access point under Settings → API.') +
      '</div>'
    );
  }

  const Timelines = Array.isArray(Result.Timelines)
    ? (Result.Timelines as PixeraTimelineState[])
    : [];
  if (!Timelines.length) return Head;
  const Wanted = Options.CheckPlayingTimelines
    ? Options.PlayingTimelines.map((W) => W.toLowerCase())
    : [];
  const Cards = Timelines.map((T) =>
    Card({
      Title: T.Name,
      Badge: TransportPill(T.Transport),
      Highlight: Wanted.includes(String(T.Name).toLowerCase()) && T.Transport === 'play',
    })
  ).join('');
  return (
    Head +
    `<div class="d-grid gap-1 mt-2">${Cards}</div>` +
    (Result.TimelinesTruncated
      ? `<div class="mt-1">${Note(`Showing the first ${Timelines.length} timelines.`)}</div>`
      : '')
  );
}

export const Name = 'PIXERA';
export const Description =
  'Connects to an AV Stumpfl PIXERA media server on its JSON/TCP API access point (conventionally TCP 1400), reads the API revision, open project and timeline transport states. Optionally flags a different project or timelines that are not playing. Read-only: it only calls getters.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  EncodeRequest,
  DecodeStream,
  ParseReply,
  TransportOf,
  PlanTimelineReads,
  NormalizeProject,
  EvaluateHealth,
  QueryPixera,
  MAX_TIMELINE_READS,
};
export { ID, Settings, Run, Debug };
