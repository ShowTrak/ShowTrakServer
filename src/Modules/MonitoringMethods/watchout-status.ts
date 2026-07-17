// Dataton WATCHOUT status monitoring. Opens a TCP connection to a WATCHOUT
// production or display computer on the control port (default 3040) and uses
// the legacy line-based ASCII control protocol to read the running show's
// status.
//
// Protocol (confirmed against the Dataton WATCHOUT 6 control protocol, which
// remains available for backward compatibility in WATCHOUT 7 as the "legacy
// protocol"; production control = TCP port 3040, display control = TCP port
// 3039/3040):
//   - Commands and replies are ASCII lines terminated by CRLF ("\r\n").
//   - `ping`                -> `Ready "<version>" ...`  (no authentication required)
//   - `authenticate 1`      -> `Ready` (level 1 is required before any command
//                              other than ping; ignored/harmless on WO7)
//   - `getStatus`           -> a `Reply` line describing the loaded show:
//       Reply "<Filename>" <Busy> <Health> <FullScreen> <ShowActive> <Online> \
//             <CurrentTime> <Playing> <TimelineRate> <Standby> [<trailing>]
//     e.g.  Reply "test" false 0 true true false 86398999 true 0 false 21921314
//     Fields (positional): Filename(show name, quoted) Busy(bool) Health(uint)
//     FullScreen(bool) ShowActive(bool) Online(bool) CurrentTime(ms uint)
//     Playing(bool) TimelineRate(float) Standby(bool). Field count varies a
//     little between versions, so parsing is positional-but-tolerant.
//   - Error responses are `Error <message>` lines.
//
// This implementation sends `authenticate 1`, then `getStatus`, then `ping`, so
// it prefers the richer `getStatus` Reply and falls back to a bare `ping`
// `Ready` if the target does not answer getStatus. The `Mode` setting is
// exposed for production vs display selection; both modes speak the same legacy
// getStatus/ping command set in this implementation, so Mode currently only
// changes the reported/labelled role (and lets us adapt later if the command
// sets diverge on a given deployment).
//
// Sources confirmed while implementing:
//   - Dataton knowledge base "Which network ports are used by WATCHOUT?" (port 3040 production, TCP/UDP)
//   - Dataton user's guide "Controlling the Production/Display Software" (ping -> Ready, authenticate 1)
//   - WATCHOUT 7 user's guide "Legacy Protocol" (ping/getStatus/authenticate still supported)
//   - TroikaTronix community thread #8637 (exact getStatus Reply field layout + example)
//
// Result semantics (consumed by MonitoringTarget.Tick):
//   - No TCP connection / no reply / unparseable   -> offline  (Success: false, Error)
//   - Replied, but wrong show (ExpectedShow set)    -> degraded ("Wrong show")
//   - Replied, but no show loaded                   -> degraded ("No show loaded")
//   - Replied, but show not ready/online            -> degraded ("Not ready")
//   - Replied via ping only (no getStatus)          -> degraded ("Status unavailable")
//   - Replied, ready/online (and show matches)      -> online   (Success: true)
import net from 'net';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'watchout-status';

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'Control Port', Type: 'number', Default: 3040, Min: 1, Max: 65535 },
  {
    Key: 'Mode',
    Label: 'Mode',
    Type: 'select',
    Default: 'display',
    Options: [
      { value: 'display', label: 'Display / cluster' },
      { value: 'production', label: 'Production' },
    ],
  },
  {
    Key: 'ExpectedShow',
    Label: 'Expected show name (optional)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 4000,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
];

// The WATCHOUT legacy control protocol frames every command and reply as a
// CRLF-terminated ASCII line.
const CRLF = '\r\n';

// Parsed view of a single WATCHOUT getStatus `Reply` line.
interface WatchoutStatus {
  ShowName: string;
  Busy: boolean | null;
  Health: number | null;
  FullScreen: boolean | null;
  ShowActive: boolean | null;
  Online: boolean | null;
  CurrentTime: number | null;
  Playing: boolean | null;
  TimelineRate: number | null;
  Standby: boolean | null;
}

// The kind of response we managed to extract from the accumulated stream.
interface WatchoutReply {
  Kind: 'reply' | 'ready' | 'error';
  Raw: string;
  Status?: WatchoutStatus;
  ErrorText?: string;
}

// Tokenise a WATCHOUT protocol line into tokens, honouring double-quoted
// strings (which may contain spaces) with backslash escaping. Returns the raw
// token values with a flag marking whether each was quoted.
function TokenizeLine(Line: string): Array<{ Quoted: boolean; Value: string }> {
  const Tokens: Array<{ Quoted: boolean; Value: string }> = [];
  let i = 0;
  const Len = Line.length;
  while (i < Len) {
    while (i < Len && /\s/.test(Line[i]!)) i++; // in range: i < Len
    if (i >= Len) break;
    if (Line[i] === '"') {
      i++;
      let Value = '';
      while (i < Len && Line[i] !== '"') {
        if (Line[i] === '\\' && i + 1 < Len) {
          Value += Line[i + 1];
          i += 2;
        } else {
          Value += Line[i];
          i++;
        }
      }
      i++; // consume closing quote
      Tokens.push({ Quoted: true, Value });
    } else {
      let Value = '';
      while (i < Len && !/\s/.test(Line[i]!)) { // in range: i < Len
        Value += Line[i];
        i++;
      }
      Tokens.push({ Quoted: false, Value });
    }
  }
  return Tokens;
}

function AsBool(Token: { Value: string } | undefined): boolean | null {
  if (!Token) return null;
  const V = Token.Value.trim().toLowerCase();
  if (V === 'true') return true;
  if (V === 'false') return false;
  return null;
}

function AsNumber(Token: { Value: string } | undefined): number | null {
  if (!Token) return null;
  const N = Number(Token.Value);
  return Number.isFinite(N) ? N : null;
}

// Parse a single `Reply ...` line into a WatchoutStatus. Fields are positional
// per the WATCHOUT getStatus reply layout; missing trailing fields stay null.
function ParseStatusLine(Line: string): WatchoutStatus {
  const Tokens = TokenizeLine(Line);
  // Tokens[0] is the "Reply" keyword; the show filename follows (quoted).
  const ShowToken = Tokens[1];
  const ShowName = ShowToken && ShowToken.Quoted ? ShowToken.Value : ShowToken ? ShowToken.Value : '';
  return {
    ShowName,
    Busy: AsBool(Tokens[2]),
    Health: AsNumber(Tokens[3]),
    FullScreen: AsBool(Tokens[4]),
    ShowActive: AsBool(Tokens[5]),
    Online: AsBool(Tokens[6]),
    CurrentTime: AsNumber(Tokens[7]),
    Playing: AsBool(Tokens[8]),
    TimelineRate: AsNumber(Tokens[9]),
    Standby: AsBool(Tokens[10]),
  };
}

// Inspect an accumulated buffer of CRLF-delimited protocol lines and extract
// the most useful reply available. A getStatus `Reply` is preferred over a
// bare `Ready` (ping/authenticate) acknowledgement. Returns null when nothing
// definitive has arrived yet. `Only` restricts the search to `Reply` lines so
// the socket keeps waiting for the richer response before falling back.
function ParseWatchoutReply(Text: string, Only?: 'reply'): WatchoutReply | null {
  const Lines = String(Text || '')
    .split(/\r\n|\r|\n/)
    .map((L) => L.trim())
    .filter(Boolean);

  let Ready: WatchoutReply | null = null;
  let ErrorReply: WatchoutReply | null = null;

  for (const Line of Lines) {
    if (/^Reply\b/i.test(Line)) {
      return { Kind: 'reply', Raw: Line, Status: ParseStatusLine(Line) };
    }
    if (!Ready && /^Ready\b/i.test(Line)) {
      Ready = { Kind: 'ready', Raw: Line };
    }
    if (!ErrorReply && /^Error\b/i.test(Line)) {
      ErrorReply = { Kind: 'error', Raw: Line, ErrorText: Line.replace(/^Error\s*/i, '').trim() };
    }
  }

  if (Only === 'reply') return null;
  return Ready || ErrorReply || null;
}

// Normalise a show name for comparison: trim, lowercase, drop a directory
// prefix and a trailing WATCHOUT `.watch` extension so "C:\Shows\Gala.watch"
// matches an expected "gala".
function NormalizeShow(Value: unknown): string {
  let S = String(Value == null ? '' : Value).trim();
  const Slash = Math.max(S.lastIndexOf('/'), S.lastIndexOf('\\'));
  if (Slash !== -1) S = S.slice(Slash + 1);
  return S.toLowerCase().replace(/\.watch$/, '');
}

function ShowMatches(ShowName: unknown, Expected: unknown): boolean {
  const Want = NormalizeShow(Expected);
  if (!Want) return true; // no expectation configured
  return NormalizeShow(ShowName) === Want;
}

// A WATCHOUT computer is "ready" once a show is active or reported online.
function IsReady(Status: WatchoutStatus): boolean {
  return Status.ShowActive === true || Status.Online === true;
}

function Probe(Address: string, Port: number, Mode: string, TimeoutMs: number): Promise<WatchoutReply | null> {
  return new Promise<WatchoutReply | null>((resolve) => {
    let Settled = false;
    let Text = '';
    const Socket = new net.Socket();

    const Finish = (Reply: WatchoutReply | null) => {
      if (Settled) return;
      Settled = true;
      try {
        Socket.destroy();
      } catch (_e) {
        // ignore
      }
      resolve(Reply);
    };

    Socket.setTimeout(Math.max(500, TimeoutMs | 0));

    Socket.once('connect', () => {
      try {
        // authenticate (level 1) then request status; append a ping so a target
        // that does not implement getStatus still answers with a Ready line.
        Socket.write(`authenticate 1${CRLF}getStatus${CRLF}ping${CRLF}`);
      } catch (_e) {
        Finish(null);
      }
    });

    Socket.on('data', (Chunk: Buffer) => {
      Text += Chunk.toString('utf8');
      if (Text.length > 1_000_000) {
        Finish(ParseWatchoutReply(Text));
        return;
      }
      // Resolve early only once the richer getStatus Reply is in hand.
      const Reply = ParseWatchoutReply(Text, 'reply');
      if (Reply) Finish(Reply);
    });

    Socket.once('timeout', () => {
      Finish(ParseWatchoutReply(Text));
    });

    Socket.once('error', () => {
      Finish(null);
    });

    Socket.once('close', () => {
      Finish(ParseWatchoutReply(Text));
    });

    try {
      Socket.connect(Port, Address);
    } catch (_e) {
      Finish(null);
    }
  });
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 3040;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 4000;
  const Mode = Cfg.Mode === 'production' ? 'production' : 'display';
  const Expected = Cfg.ExpectedShow == null ? '' : String(Cfg.ExpectedShow).trim();
  if (Port < 1 || Port > 65535) return { Success: false, Error: `Invalid port: ${Port}` };

  const Started = Date.now();
  const Reply = await Probe(Address, Port, Mode, Math.max(500, TimeoutMs | 0));
  const LatencyMs = Date.now() - Started;

  if (!Reply || Reply.Kind === 'error') {
    return {
      Success: false,
      Error:
        Reply && Reply.ErrorText
          ? `WATCHOUT error: ${Reply.ErrorText}`
          : `No status reply from WATCHOUT after ${TimeoutMs}ms`,
    };
  }

  // Ping/authenticate answered but getStatus did not: reachable but we cannot
  // confirm the loaded show or ready state, so treat as degraded.
  if (Reply.Kind === 'ready' || !Reply.Status) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Status unavailable',
      LatencyMs,
      Mode,
      Expected,
      Replied: true,
    };
  }

  const Status = Reply.Status;
  const ShowName = String(Status.ShowName || '').trim();
  const Ready = IsReady(Status);
  const Running = Status.Playing === true;
  const Matched = ShowMatches(ShowName, Expected);

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs,
    Mode,
    Expected,
    ShowName,
    Ready,
    Running,
    Online: Status.Online === true,
    ShowActive: Status.ShowActive === true,
    Standby: Status.Standby === true,
    Replied: true,
    Raw: Reply.Raw,
  };

  if (Expected && !Matched) {
    return { ...Base, Degraded: true, DegradedReason: 'Wrong show' };
  }
  if (!ShowName) {
    return { ...Base, Degraded: true, DegradedReason: 'No show loaded' };
  }
  if (!Ready) {
    return { ...Base, Degraded: true, DegradedReason: 'Not ready' };
  }

  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 3040;
  const Mode = (Result && Result.Mode) || (Cfg.Mode === 'production' ? 'production' : 'display');
  const Expected =
    (Result && (Result.Expected as string)) ||
    (Cfg.ExpectedShow == null ? '' : String(Cfg.ExpectedShow).trim());

  const Online = !!(Result && Result.Success && !Result.Degraded);
  const Degraded = !!(Result && Result.Degraded);
  const Replied = !!(Result && (Result.Success || Result.Degraded));

  let StatusPill: string;
  if (Online) {
    StatusPill = Pill('success', 'Online');
  } else if (Degraded) {
    StatusPill = Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  } else {
    StatusPill = Pill('danger', 'Offline');
  }

  const ShowName = Result && Result.ShowName != null ? String(Result.ShowName) : '';
  const Ready = !!(Result && Result.Ready);
  const Running = !!(Result && Result.Running);

  const Head = Rows([
    TextRow('Host', `${Address || '—'}:${Port}`),
    TextRow('Mode', String(Mode)),
    Row('Status', StatusPill),
    Replied ? TextRow('Show', ShowName || '(none)') : null,
    Replied
      ? Row(
          'State',
          Pill(Ready ? 'success' : 'muted', Ready ? 'Ready' : 'Not ready') +
            ' ' +
            Pill(Running ? 'success' : 'muted', Running ? 'Running' : 'Stopped')
        )
      : null,
    Expected
      ? Row(
          'Expected show',
          `${Esc(Expected)} ` +
            (Replied
              ? Pill(ShowMatches(ShowName, Expected) ? 'success' : 'warning', ShowMatches(ShowName, Expected) ? 'Match' : 'Mismatch')
              : Pill('muted', '—'))
        )
      : null,
    Replied
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'No reply from WATCHOUT'),
  ]);

  if (Degraded && Result && Result.DegradedReason) {
    return Head + `<div class="mt-2">${Note(`Degraded: ${Result.DegradedReason}`)}</div>`;
  }
  if (!Replied) {
    return Head + `<div class="mt-2">${Note('Could not reach WATCHOUT')}</div>`;
  }
  return Head;
}

export const Name = 'Dataton WATCHOUT';
export const Description =
  'Connects to a Dataton WATCHOUT production/display computer over TCP and confirms the expected show is loaded and ready.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
// Exported for unit tests.
export const _internal = {
  ParseWatchoutReply,
  ParseStatusLine,
  TokenizeLine,
  NormalizeShow,
  ShowMatches,
  IsReady,
  Probe,
};
export { ID, Settings, Run, Debug };
