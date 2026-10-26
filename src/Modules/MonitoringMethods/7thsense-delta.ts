// 7thSense Delta Media Server check, over Delta's external control Telnet
// interface (TCP 23, "Multi Telnet", up to 5 simultaneous connections by
// default; set in DeltaGUI under Configure > Preferences > Communication >
// Ethernet Configuration, "TCP External Control").
//
// Protocol (7thSense "External Control of Delta Media Servers > Return Codes",
// identical in the Delta 2.6 User Guide appendix):
//   - On connect Delta speaks first:
//       ApplicationName Deltaserver.exe
//       Welcome to the 7thSense Delta Telnet interface, Help[CR] for commands
//       SERVER: <PC name>
//       READY
//     Lines end CR LF. Commands are terminated by CR.
//   - An unrecognised command answers `BAD`; a recognised one answers `OK`
//     (parameters are not validated).
//   - `STATUS` answers `KEY : value` lines, a blank line, then `OK`:
//       SERVER  : ServerNode1 (Leader)      <- (Master) / (Slave) before the rename
//       FILE   : stratosphere show1.xml
//       MODE   : Stopped                    <- Stopped / Preparing to Play / Playing
//       CURRENTFRAME: 2646
//       FRAMERATE: 30.0
//       LICENCE : Permanent                 <- or a date for a time-limited licence
//       MOVIEDRIVES: C E
//       OTHERDRIVE: C                       <- OTHERDRIVES in another example
//       GRAPHICS: 1920 X 1080 60 HZ         <- with a non-breaking space in the PDF
//       SMPTE : OFF
//       AUDIOLEVEL: 100
//       VIDEOLEVEL: 100
//     The documented examples disagree on the padding around the colon, on
//     OTHERDRIVE vs OTHERDRIVES, and on whether the blank line is present, so
//     the reply is framed on the `OK` / `BAD` line alone and every key is
//     normalised (upper case, whitespace collapsed).
//   - `EXTCTRLCOMMS enable=false` makes every command answer "External Control
//     Comms disabled" instead; that is reported as its own reason.
//
// Design:
//   - One short session per probe: wait for READY, send `STATUS\r`, read to the
//     OK / BAD line, close. Nothing else is ever sent. In particular no "quit":
//     the interface documents none, and QUIT_APP closes Delta itself, so the
//     socket is simply closed.
//   - Only 5 Telnet clients are allowed at once and show-control systems hold
//     some of them, so concurrent checks on one server share one session per
//     tick through a short snapshot cache (as hyperdeck does).
//   - Any telnet IAC negotiation is stripped and never answered. The docs never
//     mention negotiation; a plain TCP client is what they describe.
//   - A server that sends no banner gets `STATUS` anyway after a short grace,
//     so a build that skips the banner is still read; the STATUS keys then
//     fingerprint it.
//   - Bytes are framed as latin1 (one char per byte, so IAC stripping and line
//     splitting never break a multi-byte character), then each complete line
//     is decoded as UTF-8 when valid and as latin1 otherwise (Delta is a
//     Windows application and may send ANSI show names).
//   - Timeline events can push arbitrary strings to Telnet clients. Lines that
//     are not `KEY : value` are ignored, so such a string cannot break a probe.
//
// Assertions (all opt-in): playing, frame advancing, expected show, expected
// role, licence, and GPU temperature. GPU temperature comes from DeltaMonitor's
// HTTP API (GET /api/deltamonitor/server/gputemp), fetched in parallel within
// the same Timeout; DeltaMonitor does not run on R-Series / P-Series servers,
// so its absence is a Degraded reason, never Offline.
import http from 'http';
import { Manager as CacheManager } from '../CacheManager';
import { ErrorMessage, RunTcpSession, type TcpSession } from './_tcp-session';
import {
  IsRefusal,
  ResolveSnapshotTtlMs,
  ResolveTimeoutMs,
  TimeoutSetting,
} from './_blackmagic-shared';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = '7thsense-delta';
const DEFAULT_PORT = 23;
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_MAX_GPU_TEMP_C = 85;
const DEFAULT_LICENCE_WARN_DAYS = 7;
const GPU_TEMP_PATH = '/api/deltamonitor/server/gputemp';
// A STATUS reply is a dozen short lines; anything far beyond that is not Delta.
const MAX_BUFFER_CHARS = 64 * 1024;
const MAX_KEPT_LINES = 64;
const MAX_LINE_CHARS = 256;
const MAX_HTTP_BODY_BYTES = 64 * 1024;
// Two probes closer together than this cannot tell a held frame from a slow
// one (a manual run just after a tick); the older sample is kept instead.
const MIN_ADVANCE_WINDOW_MS = 1000;
// Bounded so a server probing many short-lived checks cannot grow it forever.
const MAX_REMEMBERED_CHECKS = 256;
const DAY_MS = 24 * 60 * 60 * 1000;

const CLOSED_EARLY_REASON =
  'Delta accepted the connection but closed it at once; all Telnet connections may be in use';
const GPU_MISSING =
  "GPU temperature not available (DeltaMonitor not running: R-Series / P-Series servers don't have it)";

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'TCP External Control port, set in DeltaGUI under Configure > Preferences > Communication. Delta allows 5 Telnet connections at once by default.',
  },
  {
    Key: 'CheckPlaying',
    Label: 'Check playing',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the mode is Playing. Preparing to Play counts as not playing, so a server stuck cueing is flagged; a normal cue lasts only a moment.',
  },
  {
    Key: 'CheckAdvancing',
    Label: 'Check frame advancing',
    Type: 'boolean',
    Default: false,
    Note: 'While playing, Degraded when the current frame has not changed since the previous check. A timeline held on a frame on purpose (a hold or pause marker) also trips it.',
  },
  {
    Key: 'CheckShow',
    Label: 'Check show',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the expected show file is loaded.',
  },
  {
    Key: 'ExpectedShow',
    Label: 'Expected show',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckShow', Equals: true },
    Note: 'Show file name as Delta reports it, e.g. Main Show.xml. Case and the .xml extension are ignored.',
  },
  {
    Key: 'CheckRole',
    Label: 'Check role',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded unless the server has the expected role in its group, e.g. a leader that has become a follower.',
  },
  {
    Key: 'ExpectedRole',
    Label: 'Expected role',
    Type: 'select',
    Default: 'leader',
    Options: [
      { value: 'leader', label: 'Leader' },
      { value: 'follower', label: 'Follower' },
    ],
    VisibleWhen: { Key: 'CheckRole', Equals: true },
    Note: 'Older Delta versions report Master and Slave; they are read as Leader and Follower.',
  },
  {
    Key: 'CheckLicence',
    Label: 'Check licence',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the licence is a date that has passed or falls within the warning period, or is neither Permanent nor a date.',
  },
  {
    Key: 'LicenceWarnDays',
    Label: 'Licence warning (days)',
    Type: 'number',
    Default: DEFAULT_LICENCE_WARN_DAYS,
    Min: 0,
    Max: 365,
    VisibleWhen: { Key: 'CheckLicence', Equals: true },
    Note: 'Days before a time-limited licence date to start warning. 0 warns on the day itself.',
  },
  {
    Key: 'CheckGpuTemp',
    Label: 'Check GPU temperature',
    Type: 'boolean',
    Default: false,
    Note: "Reads GPU temperatures from DeltaMonitor's web API. Not available on R-Series and P-Series servers, which do not run DeltaMonitor.",
  },
  {
    Key: 'MaxGpuTempC',
    Label: 'Maximum GPU temperature (°C)',
    Type: 'number',
    Default: DEFAULT_MAX_GPU_TEMP_C,
    Min: 30,
    Max: 120,
    VisibleWhen: { Key: 'CheckGpuTemp', Equals: true },
  },
  {
    Key: 'HttpPort',
    Label: 'DeltaMonitor HTTP port',
    Type: 'number',
    Default: DEFAULT_HTTP_PORT,
    Min: 1,
    Max: 65535,
    Advanced: true,
    VisibleWhen: { Key: 'CheckGpuTemp', Equals: true },
    Note: "7thSense documents the API at http://<server>/api/deltamonitor/. The ports list gives DeltaMonitor's own port as 7790; try it if port 80 does not answer.",
  },
  TimeoutSetting(),
];

// --- Telnet byte filter -------------------------------------------------------

const IAC = 0xff;
const SB = 0xfa;
const SE = 0xf0;
const WILL = 0xfb;
const DONT = 0xfe;

/**
 * Strips telnet IAC sequences from a byte stream. Stateful, so a sequence split
 * across TCP chunks is still removed whole. IAC IAC is a literal 0xFF byte.
 */
export class TelnetFilter {
  private State: 'data' | 'iac' | 'option' | 'sb' | 'sb-iac' = 'data';

  Feed(Chunk: Buffer): Buffer {
    const Out: number[] = [];
    for (const Byte of Chunk) {
      switch (this.State) {
        case 'data':
          if (Byte === IAC) this.State = 'iac';
          else Out.push(Byte);
          break;
        case 'iac':
          if (Byte === IAC) {
            Out.push(IAC);
            this.State = 'data';
          } else if (Byte >= WILL && Byte <= DONT) this.State = 'option';
          else if (Byte === SB) this.State = 'sb';
          else this.State = 'data'; // a two-byte command (NOP, GA, etc.)
          break;
        case 'option':
          this.State = 'data';
          break;
        case 'sb':
          if (Byte === IAC) this.State = 'sb-iac';
          break;
        case 'sb-iac':
          this.State = Byte === SE ? 'data' : 'sb';
          break;
      }
    }
    return Buffer.from(Out);
  }
}

// --- Line framing -------------------------------------------------------------

/**
 * Splits latin1-framed text into lines. CR LF, LF and a bare CR all end a line:
 * every CR becomes a line break, and the empty line a CR LF pair then leaves is
 * ignored by the reader (nothing in this protocol depends on blank lines).
 */
export class LineReader {
  private Pending = '';

  /** Complete lines (still latin1-framed), or null once the buffer overflows. */
  Feed(Text: string): string[] | null {
    this.Pending += Text.replace(/\r/g, '\n');
    const Parts = this.Pending.split('\n');
    this.Pending = Parts.pop() ?? '';
    if (this.Pending.length > MAX_BUFFER_CHARS) return null;
    return Parts;
  }
}

const Utf8 = new TextDecoder('utf-8', { fatal: true });

/** One latin1-framed line as display text: UTF-8 when valid, else latin1. */
export function DecodeLine(Framed: string): string {
  const Bytes = Buffer.from(Framed, 'latin1');
  let Text: string;
  try {
    Text = Utf8.decode(Bytes);
  } catch {
    Text = Framed;
  }
  return (
    Text.replace(/\u00a0/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_LINE_CHARS)
  );
}

// --- STATUS parsing -----------------------------------------------------------

export type DeltaRole = 'Leader' | 'Follower';

export interface DeltaStatus {
  /** Every `KEY : value` line, keyed by the normalised (upper-case) key. */
  Fields: Record<string, string>;
  /** At least two of the documented keys were present. */
  Recognised: boolean;
  ServerName: string | null;
  /** Leader / Follower, or the raw bracketed text when it is neither. */
  Role: string | null;
  ShowFile: string | null;
  Mode: string | null;
  CurrentFrame: number | null;
  FrameRate: number | null;
  Licence: string | null;
  Graphics: string | null;
  Smpte: string | null;
  MovieDrives: string | null;
  OtherDrives: string | null;
  AudioLevel: string | null;
  VideoLevel: string | null;
}

const KNOWN_KEYS = ['SERVER', 'FILE', 'MODE', 'CURRENTFRAME', 'FRAMERATE', 'LICENCE'];

export function NormaliseKey(Key: string): string {
  return Key.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** `KEY : value` lines into a map. Split on the first colon only. */
export function ParseStatusFields(Lines: string[]): Record<string, string> {
  const Out: Record<string, string> = {};
  for (const Line of Lines) {
    const Colon = Line.indexOf(':');
    if (Colon <= 0) continue;
    const Key = NormaliseKey(Line.slice(0, Colon));
    if (!Key || Key.length > 40) continue;
    Out[Key] = Line.slice(Colon + 1)
      .replace(/\s+/g, ' ')
      .trim();
  }
  return Out;
}

/** Role names, including the pre-rename Master / Slave. */
export function NormaliseRole(Raw: string): string {
  const Lower = Raw.trim().toLowerCase();
  if (Lower === 'leader' || Lower === 'master') return 'Leader';
  if (Lower === 'follower' || Lower === 'slave') return 'Follower';
  return Raw.trim();
}

/** `ServerNode1 (Leader)` -> name + role. A value without brackets is all name. */
export function ParseServerValue(Value: string): { Name: string | null; Role: string | null } {
  const Match = Value.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (!Match) return { Name: Value.trim() || null, Role: null };
  const Name = (Match[1] || '').trim();
  const Role = (Match[2] || '').trim();
  return { Name: Name || null, Role: Role ? NormaliseRole(Role) : null };
}

/** Playing / Stopped / Preparing to Play, normalised; anything else as sent. */
export function NormaliseMode(Raw: string): string {
  const Lower = Raw.trim().toLowerCase();
  if (Lower === 'playing') return 'Playing';
  if (Lower === 'stopped') return 'Stopped';
  if (Lower.startsWith('preparing')) return 'Preparing to Play';
  return Raw.trim();
}

function StringOrNull(Value: string | undefined): string | null {
  if (Value == null) return null;
  const Trimmed = Value.trim();
  return Trimmed ? Trimmed : null;
}

function IntOrNull(Value: string | undefined): number | null {
  if (Value == null || !/^-?\d+$/.test(Value.trim())) return null;
  const N = Number(Value.trim());
  return Number.isSafeInteger(N) ? N : null;
}

function FloatOrNull(Value: string | undefined): number | null {
  if (Value == null || !/^-?\d+(\.\d+)?$/.test(Value.trim())) return null;
  const N = Number(Value.trim());
  return Number.isFinite(N) ? N : null;
}

export function ParseStatus(Lines: string[]): DeltaStatus {
  const Fields = ParseStatusFields(Lines);
  const Server = Fields['SERVER'] != null ? ParseServerValue(Fields['SERVER']) : null;
  const Mode = StringOrNull(Fields['MODE']);
  return {
    Fields,
    Recognised: KNOWN_KEYS.filter((Key) => Fields[Key] != null).length >= 2,
    ServerName: Server ? Server.Name : null,
    Role: Server ? Server.Role : null,
    ShowFile: StringOrNull(Fields['FILE']),
    Mode: Mode ? NormaliseMode(Mode) : null,
    CurrentFrame: IntOrNull(Fields['CURRENTFRAME']),
    FrameRate: FloatOrNull(Fields['FRAMERATE']),
    Licence: StringOrNull(Fields['LICENCE']),
    Graphics: StringOrNull(Fields['GRAPHICS']),
    Smpte: StringOrNull(Fields['SMPTE']),
    MovieDrives: StringOrNull(Fields['MOVIEDRIVES']),
    OtherDrives: StringOrNull(Fields['OTHERDRIVES'] ?? Fields['OTHERDRIVE']),
    AudioLevel: StringOrNull(Fields['AUDIOLEVEL']),
    VideoLevel: StringOrNull(Fields['VIDEOLEVEL']),
  };
}

// --- One-connection status snapshot -------------------------------------------

export interface DeltaSnapshot {
  Reachable: boolean;
  Error?: string;
  /** The server accepted and then closed without a byte (all connections in use?). */
  ClosedEarly?: boolean;
  LatencyMs?: number;
  /** Clock() when the probe began; tells a fresh snapshot from a cached one. */
  TakenAt: number;
  IsDelta: boolean;
  SawReady: boolean;
  /** Lines received before STATUS was sent (the welcome banner). */
  BannerLines: string[];
  /** ok / bad / disabled (EXTCTRLCOMMS off), or null when no terminator arrived. */
  StatusReply: 'ok' | 'bad' | 'disabled' | null;
  StatusLines: string[];
  Status: DeltaStatus;
  /** Which step the budget ran out in, when it did. */
  Incomplete: string | null;
}

const MENTIONS_DELTA = /7th\s*sense|\bdelta/i;

// Swappable clock so tests can step the frame-advance window without waiting.
let Clock: () => number = () => Date.now();
function SetClock(Fn: (() => number) | null): void {
  Clock = Fn || (() => Date.now());
}

export async function QueryDelta(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<DeltaSnapshot> {
  const BudgetMs = Math.max(500, TimeoutMs | 0);
  // A silent server still gets STATUS after this long; Delta's real banner
  // arrives immediately, so this only matters for a build without one.
  const BannerGraceMs = Math.min(1500, Math.floor(BudgetMs / 3));
  const Filter = new TelnetFilter();
  const Reader = new LineReader();
  const TakenAt = Clock();

  let Phase: 'banner' | 'status' = 'banner';
  let ReceivedAny = false;
  let FirstByteAt: number | null = null;
  let ReadyAt: number | null = null;
  let SawReady = false;
  let MentionsDelta = false;
  let StatusReply: DeltaSnapshot['StatusReply'] = null;
  let Grace: ReturnType<typeof setTimeout> | null = null;
  const BannerLines: string[] = [];
  const StatusLines: string[] = [];

  const Build = (Session: TcpSession<DeltaSnapshot>, Incomplete: string | null): DeltaSnapshot => {
    const Status = ParseStatus(StatusLines);
    return {
      Reachable: true,
      LatencyMs: (ReadyAt ?? FirstByteAt ?? Date.now()) - Session.StartedAt,
      TakenAt,
      IsDelta: MentionsDelta || SawReady || Status.Recognised,
      SawReady,
      BannerLines,
      StatusReply,
      StatusLines,
      Status,
      Incomplete,
    };
  };
  const Failed = (Message: string, ClosedEarly = false): DeltaSnapshot => ({
    Reachable: false,
    Error: Message,
    ...(ClosedEarly ? { ClosedEarly: true } : {}),
    TakenAt,
    IsDelta: false,
    SawReady: false,
    BannerLines,
    StatusReply: null,
    StatusLines,
    Status: ParseStatus([]),
    Incomplete: null,
  });
  const Unfinished = (Session: TcpSession<DeltaSnapshot>, SilentError: string): DeltaSnapshot => {
    if (!ReceivedAny) return Failed(SilentError);
    return Build(Session, Phase === 'banner' ? 'welcome banner' : 'status');
  };

  const SendStatus = (Session: TcpSession<DeltaSnapshot>): void => {
    if (Phase !== 'banner' || Session.Settled) return;
    Phase = 'status';
    if (Grace) {
      clearTimeout(Grace);
      Grace = null;
    }
    Session.Socket.write('STATUS\r');
  };

  const OnLine = (Line: string, Session: TcpSession<DeltaSnapshot>): void => {
    if (!Line) return;
    const IsKeyValue = Line.indexOf(':') > 0;
    if (!IsKeyValue && MENTIONS_DELTA.test(Line)) MentionsDelta = true;
    if (Phase === 'banner') {
      if (BannerLines.length < MAX_KEPT_LINES) BannerLines.push(Line);
      if (/^READY$/i.test(Line)) {
        SawReady = true;
        ReadyAt = Date.now();
        SendStatus(Session);
      }
      return;
    }
    if (/^OK$/i.test(Line)) StatusReply = 'ok';
    else if (/^BAD$/i.test(Line)) StatusReply = 'bad';
    else if (/external control comms disabled/i.test(Line)) StatusReply = 'disabled';
    if (StatusReply) {
      Session.Finish(Build(Session, null));
      return;
    }
    // A late READY (the grace fired first) or an echoed command is not status.
    if (/^READY$/i.test(Line)) {
      SawReady = true;
      return;
    }
    if (/^STATUS$/i.test(Line)) return;
    if (StatusLines.length < MAX_KEPT_LINES) StatusLines.push(Line);
  };

  return RunTcpSession<DeltaSnapshot>({
    Address,
    Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnConnect: (Session) => {
      Grace = setTimeout(() => SendStatus(Session), BannerGraceMs);
    },
    OnData: (Chunk, Session) => {
      if (!ReceivedAny) FirstByteAt = Date.now();
      ReceivedAny = true;
      const Lines = Reader.Feed(Filter.Feed(Chunk).toString('latin1'));
      if (!Lines) {
        Session.Finish(Build(Session, Phase === 'banner' ? 'welcome banner' : 'status'));
        return;
      }
      for (const Line of Lines) {
        if (Session.Settled) return;
        OnLine(DecodeLine(Line), Session);
      }
    },
    OnSettle: () => {
      if (Grace) {
        clearTimeout(Grace);
        Grace = null;
      }
    },
    OnTimeout: (Session) =>
      Unfinished(Session, `No reply from the Delta server after ${BudgetMs}ms`),
    OnError: (Message) => Failed(Message),
    OnClose: (Session) =>
      ReceivedAny
        ? Build(Session, Phase === 'banner' ? 'welcome banner' : 'status')
        : Failed(
            'Connection closed by the server before the welcome banner (all Telnet connections may be in use)',
            true
          ),
  });
}

// --- DeltaMonitor GPU temperatures ---------------------------------------------

export interface GpuReading {
  Id: string;
  TemperatureC: number | null;
}

export interface GpuSnapshot {
  Ok: boolean;
  Gpus: GpuReading[];
  /** Why the temperatures are unavailable; null when Ok. */
  Error: string | null;
}

function FindKey(Obj: Record<string, unknown>, ...Names: string[]): unknown {
  const Wanted = Names.map((N) => N.toLowerCase());
  for (const [Key, Value] of Object.entries(Obj)) {
    if (Wanted.includes(Key.toLowerCase())) return Value;
  }
  return undefined;
}

function IsObject(Value: unknown): Value is Record<string, unknown> {
  return !!Value && typeof Value === 'object' && !Array.isArray(Value);
}

/**
 * `{ "GPUS": [{ "GPU_Id": 0, "Temperature": 50 }, ...] }`, also accepted under a
 * `data` wrapper (the other DeltaMonitor endpoints use one) and with any key
 * case. Null when no GPU list is present.
 */
export function ParseGpuTemps(Body: unknown): GpuReading[] | null {
  if (!IsObject(Body)) return null;
  let List = FindKey(Body, 'GPUS');
  if (List === undefined) {
    const Data = FindKey(Body, 'data');
    if (IsObject(Data)) List = FindKey(Data, 'GPUS');
  }
  if (!Array.isArray(List)) return null;
  return List.filter(IsObject).map((Item, Index) => {
    const RawId = FindKey(Item, 'GPU_Id', 'GpuId', 'Id');
    const RawTemp = FindKey(Item, 'Temperature', 'Temp');
    const Temp =
      typeof RawTemp === 'number'
        ? RawTemp
        : typeof RawTemp === 'string' && RawTemp.trim() !== ''
          ? Number(RawTemp)
          : NaN;
    return {
      Id: RawId == null || RawId === '' ? String(Index) : String(RawId).slice(0, 40),
      TemperatureC: Number.isFinite(Temp) ? Temp : null,
    };
  });
}

/** GET the DeltaMonitor GPU endpoint. Never rejects; failures become a reason. */
export function FetchGpuTemps(
  Address: string,
  HttpPort: number,
  TimeoutMs: number
): Promise<GpuSnapshot> {
  const BudgetMs = Math.max(500, TimeoutMs | 0);
  return new Promise<GpuSnapshot>((Resolve) => {
    let Settled = false;
    let Timer: ReturnType<typeof setTimeout> | null = null;
    let Req: http.ClientRequest | null = null;
    const Finish = (Result: GpuSnapshot): void => {
      if (Settled) return;
      Settled = true;
      if (Timer) clearTimeout(Timer);
      try {
        Req?.destroy();
      } catch {
        // ignore
      }
      Resolve(Result);
    };
    const Fail = (Error: string): void => Finish({ Ok: false, Gpus: [], Error });
    const TimedOut = (): void =>
      Fail(`GPU temperature not available (no reply from DeltaMonitor on port ${HttpPort})`);

    Timer = setTimeout(TimedOut, BudgetMs);
    try {
      Req = http.request({
        host: Address,
        port: HttpPort,
        path: GPU_TEMP_PATH,
        method: 'GET',
        agent: false,
        headers: { Accept: 'application/json' },
      });
    } catch (Err) {
      Fail(`GPU temperature not available (${ErrorMessage(Err)})`);
      return;
    }
    Req.setTimeout(BudgetMs, TimedOut);
    Req.on('error', (Err) => {
      const Message = ErrorMessage(Err);
      Fail(IsRefusal(Message) ? GPU_MISSING : `GPU temperature not available (${Message})`);
    });
    Req.on('response', (Res) => {
      const Code = Res.statusCode || 0;
      if (Code === 404) {
        Res.resume();
        Fail(GPU_MISSING);
        return;
      }
      if (Code !== 200) {
        Res.resume();
        Fail(`GPU temperature not available (DeltaMonitor answered HTTP ${Code})`);
        return;
      }
      const Chunks: Buffer[] = [];
      let Size = 0;
      Res.on('data', (Chunk: Buffer) => {
        Size += Chunk.length;
        if (Size > MAX_HTTP_BODY_BYTES) {
          Fail(GPU_MISSING);
          return;
        }
        Chunks.push(Chunk);
      });
      Res.on('error', (Err) => Fail(`GPU temperature not available (${ErrorMessage(Err)})`));
      Res.on('end', () => {
        let Parsed: unknown;
        try {
          Parsed = JSON.parse(Buffer.concat(Chunks).toString('utf8'));
        } catch {
          Fail(GPU_MISSING);
          return;
        }
        const Gpus = ParseGpuTemps(Parsed);
        if (!Gpus) Fail(GPU_MISSING);
        else Finish({ Ok: true, Gpus, Error: null });
      });
    });
    Req.end();
  });
}

// --- Caches -------------------------------------------------------------------
//
// Delta allows 5 Telnet clients at once and show control holds some of them,
// so every check on one server shares one session per tick.

const SNAPSHOT_CACHE = CacheManager.GetBucket('MonitoringMethods:7thSenseDelta', {
  defaultTtlMs: 1000,
  maxEntries: 500,
});
const GPU_CACHE = CacheManager.GetBucket('MonitoringMethods:7thSenseDeltaGpu', {
  defaultTtlMs: 1000,
  maxEntries: 500,
});

// --- Settings ---------------------------------------------------------------------

export interface DeltaConfig {
  Address: string;
  Port: number;
  HttpPort: number;
  TimeoutMs: number;
}

function PortOr(Value: unknown, Fallback: number): number {
  const N = Number(Value);
  return Number.isFinite(N) && N > 0 ? N | 0 : Fallback;
}

function ParseConfig(Target: MonitoringTargetLike): DeltaConfig {
  const Cfg = (Target && Target.Settings) || {};
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: PortOr(Cfg.Port, DEFAULT_PORT),
    HttpPort: PortOr(Cfg.HttpPort, DEFAULT_HTTP_PORT),
    TimeoutMs: ResolveTimeoutMs(Cfg.Timeout),
  };
}

export interface DeltaOptions {
  CheckPlaying: boolean;
  CheckAdvancing: boolean;
  CheckShow: boolean;
  ExpectedShow: string;
  CheckRole: boolean;
  ExpectedRole: DeltaRole;
  CheckLicence: boolean;
  LicenceWarnDays: number;
  CheckGpuTemp: boolean;
  MaxGpuTempC: number;
}

function ParseHealthOptions(Target: MonitoringTargetLike): DeltaOptions {
  const Cfg = (Target && Target.Settings) || {};
  const WarnDays = Number(Cfg.LicenceWarnDays);
  const MaxTemp = Number(Cfg.MaxGpuTempC);
  return {
    CheckPlaying: Cfg.CheckPlaying === true,
    CheckAdvancing: Cfg.CheckAdvancing === true,
    CheckShow: Cfg.CheckShow === true,
    ExpectedShow: typeof Cfg.ExpectedShow === 'string' ? Cfg.ExpectedShow.trim() : '',
    CheckRole: Cfg.CheckRole === true,
    ExpectedRole: String(Cfg.ExpectedRole).toLowerCase() === 'follower' ? 'Follower' : 'Leader',
    CheckLicence: Cfg.CheckLicence === true,
    LicenceWarnDays:
      Number.isFinite(WarnDays) && WarnDays >= 0
        ? Math.min(365, Math.floor(WarnDays))
        : DEFAULT_LICENCE_WARN_DAYS,
    CheckGpuTemp: Cfg.CheckGpuTemp === true,
    MaxGpuTempC: Number.isFinite(MaxTemp) && MaxTemp > 0 ? MaxTemp : DEFAULT_MAX_GPU_TEMP_C,
  };
}

// --- Show / licence helpers ---------------------------------------------------------

/** Lower case, no `.xml`, and only the file name if Delta reports a path. */
export function NormaliseShowName(Name: string): string {
  const Base = Name.trim().split(/[\\/]/).pop() || '';
  return Base.replace(/\.xml$/i, '')
    .trim()
    .toLowerCase();
}

export function ShowMatches(Loaded: string, Expected: string): boolean {
  return NormaliseShowName(Loaded) === NormaliseShowName(Expected);
}

/**
 * The calendar date in a LICENCE value, or null. The documented example is
 * `30.12.2006` (day.month.year). ISO `2026-12-30` is read as year-month-day; a
 * slash or dash date is day-first unless only month-first makes it valid.
 */
export function ParseLicenceDate(
  Value: string
): { Year: number; Month: number; Day: number } | null {
  let Year: number;
  let Month: number;
  let Day: number;
  const Iso = Value.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  const Dotted = Value.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  const Other = Value.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (Iso) {
    Year = Number(Iso[1]);
    Month = Number(Iso[2]);
    Day = Number(Iso[3]);
  } else if (Dotted) {
    Day = Number(Dotted[1]);
    Month = Number(Dotted[2]);
    Year = Number(Dotted[3]);
  } else if (Other) {
    const A = Number(Other[1]);
    const B = Number(Other[2]);
    Year = Number(Other[3]);
    if (B > 12 && A <= 12) {
      Month = A;
      Day = B;
    } else {
      Day = A;
      Month = B;
    }
  } else {
    return null;
  }
  const Check = new Date(Year, Month - 1, Day);
  if (Check.getFullYear() !== Year || Check.getMonth() !== Month - 1 || Check.getDate() !== Day) {
    return null;
  }
  return { Year, Month, Day };
}

/** The licence fault, if any, given today's date (Now) and the warning window. */
export function AssessLicence(
  Licence: string | null,
  Now: number,
  WarnDays: number
): string | null {
  if (!Licence) return 'Failed to read the licence';
  if (/^permanent$/i.test(Licence.trim())) return null;
  const Parsed = ParseLicenceDate(Licence);
  if (!Parsed) return `Licence: ${Licence} (neither Permanent nor a date)`;
  const Today = new Date(Now);
  const TodayMidnight = new Date(Today.getFullYear(), Today.getMonth(), Today.getDate()).getTime();
  const Expiry = new Date(Parsed.Year, Parsed.Month - 1, Parsed.Day).getTime();
  const DaysLeft = Math.round((Expiry - TodayMidnight) / DAY_MS);
  if (DaysLeft < 0) return `Licence expired ${Licence}`;
  if (DaysLeft === 0) return `Licence expires today (${Licence})`;
  if (DaysLeft <= WarnDays) {
    return `Licence expires ${Licence} (in ${DaysLeft} day${DaysLeft === 1 ? '' : 's'})`;
  }
  return null;
}

// --- Frame advance (per check) --------------------------------------------------------
//
// Keyed per CHECK (the check instance passed to Run carries its CheckID), so
// two checks on the same server never compare against each other's sample. A
// probe with no check id (the editor's test run) falls back to address:port.

export interface FrameSample {
  ShowFile: string | null;
  Frame: number;
  Playing: boolean;
  At: number;
}

export type AdvanceVerdict = 'advancing' | 'stalled' | null;

const Samples = new Map<string, FrameSample>();

/**
 * One step of the advance check. No verdict on the first sample, across a show
 * change, unless BOTH samples are Playing, or within MIN_ADVANCE_WINDOW_MS (the
 * older sample is then kept, so a cached snapshot replayed to the same check
 * is never compared with itself). A frame going backwards is a loop: advancing.
 */
export function AdvanceFrame(
  Prev: FrameSample | null,
  Cur: { ShowFile: string | null; Frame: number | null; Playing: boolean; At: number }
): { Verdict: AdvanceVerdict; Next: FrameSample | null } {
  if (Cur.Frame == null) return { Verdict: null, Next: null };
  const Fresh: FrameSample = {
    ShowFile: Cur.ShowFile,
    Frame: Cur.Frame,
    Playing: Cur.Playing,
    At: Cur.At,
  };
  if (!Prev) return { Verdict: null, Next: Fresh };
  if (Cur.At - Prev.At < MIN_ADVANCE_WINDOW_MS) return { Verdict: null, Next: Prev };
  const SameShow = (Prev.ShowFile || '').toLowerCase() === (Cur.ShowFile || '').toLowerCase();
  if (!SameShow || !Prev.Playing || !Cur.Playing) return { Verdict: null, Next: Fresh };
  return { Verdict: Cur.Frame === Prev.Frame ? 'stalled' : 'advancing', Next: Fresh };
}

function CheckIdOf(Target: MonitoringTargetLike): number | null {
  const Raw = Target ? (Target as { CheckID?: unknown }).CheckID : null;
  return typeof Raw === 'number' && Number.isInteger(Raw) && Raw > 0 ? Raw : null;
}

function SampleKey(Target: MonitoringTargetLike, Config: DeltaConfig): string {
  const CheckID = CheckIdOf(Target);
  return CheckID != null
    ? `check:${CheckID}`
    : `addr:${Config.Address.toLowerCase()}:${Config.Port}`;
}

function RememberSample(Key: string, Sample: FrameSample | null): void {
  Samples.delete(Key); // re-insert so the Map's order is least-recent first
  if (!Sample) return;
  Samples.set(Key, Sample);
  while (Samples.size > MAX_REMEMBERED_CHECKS) {
    const Oldest = Samples.keys().next();
    if (Oldest.done) break;
    Samples.delete(Oldest.value);
  }
}

// The registry caches a probe result by Address + Settings. Run's result also
// depends on this check's previous sample, so the check id joins the key and
// two identical checks each keep their own.
function GetRunCacheKeyExtra(Target: MonitoringTargetLike): unknown {
  return CheckIdOf(Target);
}

function ClearCaches(): void {
  SNAPSHOT_CACHE.Clear();
  GPU_CACHE.Clear();
}

function ResetState(): void {
  Samples.clear();
  ClearCaches();
}

// --- Evaluation ---------------------------------------------------------------------

/**
 * The reasons a reachable server is unhealthy, per the enabled assertions.
 * Pure; exported via _internal for unit tests.
 */
function EvaluateHealth(
  Snap: DeltaSnapshot,
  Gpu: GpuSnapshot | null,
  Advance: AdvanceVerdict,
  Options: DeltaOptions,
  Now: number
): string[] {
  if (!Snap.IsDelta) return ['Responded, but does not look like a 7thSense Delta server'];
  const Reasons: string[] = [];
  const Status = Snap.Status;

  if (Snap.StatusReply === 'disabled') {
    Reasons.push('External control is disabled on the server (EXTCTRLCOMMS)');
  } else if (Snap.StatusReply === 'bad') {
    Reasons.push('Delta did not recognise STATUS (BAD)');
  } else if (Snap.Incomplete) {
    Reasons.push(`Timed out reading the ${Snap.Incomplete}`);
  } else if (!Status.Recognised) {
    Reasons.push('Unrecognised STATUS reply');
  } else {
    if (Options.CheckPlaying) {
      if (!Status.Mode) Reasons.push('Failed to read the play mode');
      else if (Status.Mode === 'Preparing to Play') Reasons.push('Preparing to play, not playing');
      else if (Status.Mode !== 'Playing') Reasons.push(`Not playing (${Status.Mode})`);
    }
    if (Options.CheckAdvancing && Advance === 'stalled') {
      Reasons.push(
        `Playing, but the frame has not advanced since the previous check (frame ${Status.CurrentFrame})`
      );
    }
    if (Options.CheckShow) {
      if (!Options.ExpectedShow) Reasons.push('No expected show set');
      else if (!Status.ShowFile) Reasons.push('No show loaded');
      else if (!ShowMatches(Status.ShowFile, Options.ExpectedShow)) {
        Reasons.push(`Show "${Status.ShowFile}" loaded, expected "${Options.ExpectedShow}"`);
      }
    }
    if (Options.CheckRole) {
      if (!Status.Role) Reasons.push('Failed to read the server role');
      else if (Status.Role !== Options.ExpectedRole) {
        Reasons.push(`Server is ${Status.Role}, expected ${Options.ExpectedRole}`);
      }
    }
    if (Options.CheckLicence) {
      const Fault = AssessLicence(Status.Licence, Now, Options.LicenceWarnDays);
      if (Fault) Reasons.push(Fault);
    }
  }

  if (Options.CheckGpuTemp) {
    if (!Gpu || !Gpu.Ok) {
      Reasons.push((Gpu && Gpu.Error) || GPU_MISSING);
    } else if (!Gpu.Gpus.length) {
      Reasons.push('GPU temperature not available (no GPUs reported)');
    } else {
      for (const Reading of Gpu.Gpus) {
        if (Reading.TemperatureC != null && Reading.TemperatureC > Options.MaxGpuTempC) {
          Reasons.push(
            `GPU ${Reading.Id}: ${Reading.TemperatureC} °C (limit ${Options.MaxGpuTempC} °C)`
          );
        }
      }
    }
  }
  return Reasons;
}

// --- Run --------------------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Options = ParseHealthOptions(Target);
  const HttpPortValid = Config.HttpPort >= 1 && Config.HttpPort <= 65535;
  const Address = Config.Address.toLowerCase();

  const [Snap, Gpu] = await Promise.all([
    SNAPSHOT_CACHE.GetOrCreate(
      `${Address}|${Config.Port}|${Config.TimeoutMs}`,
      () => QueryDelta(Config.Address, Config.Port, Config.TimeoutMs),
      { ttlMs: ResolveSnapshotTtlMs(Config.TimeoutMs) }
    ) as Promise<DeltaSnapshot>,
    !Options.CheckGpuTemp
      ? Promise.resolve(null)
      : !HttpPortValid
        ? Promise.resolve<GpuSnapshot>({
            Ok: false,
            Gpus: [],
            Error: `GPU temperature not available (invalid HTTP port ${Config.HttpPort})`,
          })
        : (GPU_CACHE.GetOrCreate(
            `${Address}|${Config.HttpPort}|${Config.TimeoutMs}`,
            () => FetchGpuTemps(Config.Address, Config.HttpPort, Config.TimeoutMs),
            { ttlMs: ResolveSnapshotTtlMs(Config.TimeoutMs) }
          ) as Promise<GpuSnapshot>),
  ]);

  // Accepted and then closed without a byte: the server completed the TCP
  // handshake, so it is up. The usual cause is Delta's Telnet connection limit
  // (5 by default) being held by show control, which is a fault worth seeing
  // but not an outage: Offline would hide a healthy, playing server.
  if (Snap.ClosedEarly) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: CLOSED_EARLY_REASON,
      LatencyMs: null,
      ConnectionClosedEarly: true,
    };
  }
  if (!Snap.Reachable) {
    const Message = Snap.Error || 'No reply from the Delta server';
    return { Success: false, ...(IsRefusal(Message) ? { Degraded: true } : {}), Error: Message };
  }

  const Status = Snap.Status;
  let Advance: AdvanceVerdict = null;
  const Key = SampleKey(Target, Config);
  if (Options.CheckAdvancing && Snap.IsDelta && Status.Recognised) {
    const Step = AdvanceFrame(Samples.get(Key) || null, {
      ShowFile: Status.ShowFile,
      Frame: Status.CurrentFrame,
      Playing: Status.Mode === 'Playing',
      At: Snap.TakenAt,
    });
    RememberSample(Key, Step.Next);
    Advance = Step.Verdict;
  } else {
    Samples.delete(Key);
  }

  const Reasons = EvaluateHealth(Snap, Gpu, Advance, Options, Clock());

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs ?? null,
    IsDelta: Snap.IsDelta,
    StatusReply: Snap.StatusReply,
    Incomplete: Snap.Incomplete,
    ServerName: Status.ServerName,
    Role: Status.Role,
    ShowFile: Status.ShowFile,
    Mode: Status.Mode,
    CurrentFrame: Status.CurrentFrame,
    FrameRate: Status.FrameRate,
    Licence: Status.Licence,
    Graphics: Status.Graphics,
    Smpte: Status.Smpte,
    MovieDrives: Status.MovieDrives,
    OtherDrives: Status.OtherDrives,
    AudioLevel: Status.AudioLevel,
    VideoLevel: Status.VideoLevel,
    FrameAdvancing: Advance == null ? null : Advance === 'advancing',
    StatusFields: Status.Fields,
    StatusLines: Snap.StatusLines,
    BannerLines: Snap.BannerLines,
    Gpus: Gpu && Gpu.Ok ? Gpu.Gpus : null,
    GpuError: Gpu && !Gpu.Ok ? Gpu.Error : null,
  };
}

// --- Debug --------------------------------------------------------------------------------

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Healthy');
  if (Reachable) return Pill('warning', 'Degraded');
  return Pill('danger', 'Offline');
}

function ModePill(Mode: unknown): string {
  const Text = typeof Mode === 'string' && Mode ? Mode : '';
  if (!Text) return Pill('muted', 'Unknown');
  if (Text === 'Playing') return Pill('success', Text);
  if (Text === 'Preparing to Play') return Pill('warning', Text);
  return Pill('muted', Text);
}

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(String(Value))}</span>`;
}

function StringList(Value: unknown): string[] {
  return Array.isArray(Value) ? Value.map((Item) => String(Item)) : [];
}

function RawLines(Title: string, Lines: string[]): string {
  if (!Lines.length) return '';
  return (
    `<div class="text-muted small mt-2 mb-1">${Esc(Title)}</div>` +
    '<div class="font-monospace small text-muted text-break">' +
    Lines.map((Line) => Esc(Line)).join('<br>') +
    '</div>'
  );
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const Head = Rows([
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Row('Status', StatePill(Result)),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the Delta server'),
  ]);

  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `Failed to reach Delta's external control port (TCP ${Config.Port}). Check the address, the TCP External Control port in DeltaGUI, and that fewer than 5 Telnet clients are connected.`
      ) +
      '</div>'
    );
  }
  if (Result.ConnectionClosedEarly === true) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Delta allows 5 Telnet connections at once by default. Close a control client that holds one open and is not needed.'
      ) +
      '</div>'
    );
  }
  if (Result.IsDelta === false) {
    return (
      Head +
      RawLines(
        'First lines received',
        [...StringList(Result.BannerLines), ...StringList(Result.StatusLines)].slice(0, 8)
      )
    );
  }

  const Frame =
    Result.CurrentFrame != null
      ? String(Result.CurrentFrame) +
        (Result.FrameAdvancing === true
          ? ' (advancing)'
          : Result.FrameAdvancing === false
            ? ' (not advancing)'
            : '')
      : null;

  const Identity = Rows([
    Result.ServerName ? TextRow('Server', String(Result.ServerName)) : null,
    Result.Role ? TextRow('Role', String(Result.Role)) : null,
    TextRow('Show', Result.ShowFile ? String(Result.ShowFile) : 'None'),
    Row('Mode', ModePill(Result.Mode)),
    Frame != null ? Row('Frame', Mono(Frame)) : null,
    Result.FrameRate != null ? Row('Frame rate', Mono(`${Result.FrameRate} fps`)) : null,
    Result.Graphics ? Row('Graphics', Mono(Result.Graphics)) : null,
    Result.Licence ? TextRow('Licence', String(Result.Licence)) : null,
    Result.Smpte ? TextRow('SMPTE', String(Result.Smpte)) : null,
  ]);

  let GpuHtml = '';
  if (Options.CheckGpuTemp) {
    const Gpus: GpuReading[] = Array.isArray(Result.Gpus) ? (Result.Gpus as GpuReading[]) : [];
    if (Result.GpuError) {
      GpuHtml = '<div class="mt-2">' + Note(String(Result.GpuError)) + '</div>';
    } else if (Gpus.length) {
      GpuHtml =
        `<div class="text-muted small mt-2 mb-1">GPUs (${Gpus.length})</div>` +
        '<div class="d-grid gap-1">' +
        Gpus.map((Gpu) => {
          const Temp = Gpu.TemperatureC;
          const Over = Temp != null && Temp > Options.MaxGpuTempC;
          return Card({
            Title: `GPU ${Gpu.Id}`,
            Badge:
              Temp == null
                ? Pill('muted', 'No reading')
                : Pill(Over ? 'warning' : 'success', `${Temp} °C`),
          });
        }).join('') +
        '</div>';
    }
  }

  return (
    Head +
    `<div class="mt-2">${Identity}</div>` +
    GpuHtml +
    RawLines('STATUS reply', StringList(Result.StatusLines))
  );
}

export const Name = '7thSense Delta';
export const Description =
  "Connects to a 7thSense Delta Media Server's external control Telnet port (TCP 23) and reads STATUS in one short session, sending nothing else: server name, leader / follower role, show file, play mode, current frame, frame rate, graphics mode and licence. Optionally flags a server that is not playing, a frame that has stopped advancing, the wrong show or role, an expiring licence, and GPU temperatures over a limit (from DeltaMonitor).";
export const Group = 'Video';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  TelnetFilter,
  LineReader,
  DecodeLine,
  NormaliseKey,
  ParseStatusFields,
  ParseServerValue,
  NormaliseRole,
  NormaliseMode,
  ParseStatus,
  ParseGpuTemps,
  NormaliseShowName,
  ShowMatches,
  ParseLicenceDate,
  AssessLicence,
  AdvanceFrame,
  ParseConfig,
  ParseHealthOptions,
  EvaluateHealth,
  QueryDelta,
  FetchGpuTemps,
  SampleKey,
  ClearCaches,
  ResetState,
  SetClock,
  Samples,
  MIN_ADVANCE_WINDOW_MS,
  GPU_MISSING,
  CLOSED_EARLY_REASON,
};
export { ID, Settings, Run, Debug, GetRunCacheKeyExtra };
