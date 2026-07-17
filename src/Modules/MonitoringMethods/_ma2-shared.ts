// Shared MA Lighting grandMA2 (console + onPC) Telnet-remote client and helpers.
//
// grandMA2 exposes a raw (non-RFC-854) command-line socket on TCP 30000. On
// connect the console speaks first: an ANSI-coloured "MA²" banner, an advisory
// `Please login!`, and a command prompt of the form `[<layer>]>` (default
// `[Fixture]>`). Those three markers positively fingerprint a grandMA2 — a bare
// open port will not produce them — and reading them requires sending nothing,
// so the default health check is side-effect free.
//
// Optionally, when a user + password are supplied, the probe performs a real
// `login <user> <pass>` and reads the read-only `Version` command (software
// version + loaded show file). Login occupies a remote user session on the desk
// (MA recommends a dedicated user), so it is opt-in — leave the credentials
// blank for pure liveness. The probe only ever sends `login` and `Version`; it
// never sends a command that changes console state.
//
// Verbatim protocol strings (login success `Logged in as User`, failure
// `no login` / `Login incorrect`, disabled `Remote command…disabled`) are drawn
// from several independent open-source grandMA2 telnet clients.
import net from 'net';
import { Manager as CacheManager } from '../CacheManager';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

export const DEFAULT_MA2_PORT = 30000;

export const CommonMa2Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Telnet remote port',
    Type: 'number',
    Default: DEFAULT_MA2_PORT,
    Min: 1,
    Max: 65535,
  },
  {
    Key: 'User',
    Label: 'Login user (blank = liveness only, no login)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'Password',
    Label: 'Login password',
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

// --- Pure protocol helpers --------------------------------------------------

// Strip ANSI/VT100 escape sequences (SGR colour + cursor codes) that grandMA2
// interleaves through its banner and prompts.
export function StripAnsi(Str: unknown): string {
  // eslint-disable-next-line no-control-regex -- ESC (0x1b) is the ANSI/VT100 introducer we're stripping
  return String(Str == null ? '' : Str).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

const PROMPT_RE = /\[[^\]\r\n]*\]>/;

// Does this (ANSI-stripped) text look like a grandMA2 telnet banner/stream?
export function IsGrandMa2Banner(Clean: unknown): boolean {
  const Text = String(Clean == null ? '' : Clean);
  return (
    /please login/i.test(Text) ||
    PROMPT_RE.test(Text) ||
    /grandma/i.test(Text) ||
    /remote command/i.test(Text)
  );
}

export type Ma2LoginState =
  | 'not-attempted'
  | 'ok'
  | 'bad-credentials'
  | 'disabled'
  | 'timeout'
  | 'error';

// Classify the console's response to a `login` command. Returns null while the
// response is still incomplete (keep reading).
export function ClassifyLogin(Segment: string): Ma2LoginState | null {
  if (/logged in as user/i.test(Segment)) return 'ok';
  if (/no login|login incorrect/i.test(Segment)) return 'bad-credentials';
  if (/remote command(?:line)? disabled|command\s*line disabled/i.test(Segment)) return 'disabled';
  return null;
}

// Best-effort parse of the read-only `Version` command feedback. The exact
// column layout is not published, so both fields are matched loosely and may be
// null on an unrecognised layout.
export function ParseVersionReply(Segment: string): { Version: string | null; ShowFile: string | null } {
  const VersionMatch = Segment.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  const ShowMatch =
    Segment.match(/show\s*file\s*[:=]?\s*([^\r\n]+)/i) ||
    Segment.match(/showfile\s*[:=]?\s*([^\r\n]+)/i);
  const CleanShow = ShowMatch && ShowMatch[1] ? ShowMatch[1].replace(PROMPT_RE, '').trim() : null;
  return {
    Version: VersionMatch && VersionMatch[1] ? VersionMatch[1] : null,
    ShowFile: CleanShow && CleanShow.length ? CleanShow : null,
  };
}

// --- One-connection status snapshot -----------------------------------------

export interface Ma2Snapshot {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  IsGrandMa2: boolean;
  LoginState: Ma2LoginState;
  Version: string | null;
  ShowFile: string | null;
  Banner: string | null;
}

export async function QueryMa2Status(
  Address: string,
  Port: number,
  User: string,
  Password: string,
  TimeoutMs: number
): Promise<Ma2Snapshot> {
  const WantLogin = !!(User && Password);
  return new Promise<Ma2Snapshot>((resolve) => {
    const Started = Date.now();
    const BudgetMs = Math.max(500, TimeoutMs | 0);
    const Socket = new net.Socket();
    let Raw = '';
    let Settled = false;
    let Phase: 'banner' | 'login' | 'version' = 'banner';
    let MarkLen = 0; // index into Clean at the current phase's start
    let IsGrandMa2 = false;
    let Banner: string | null = null;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const Clean = () => StripAnsi(Raw);

    const Finish = (Result: Ma2Snapshot) => {
      if (Settled) return;
      Settled = true;
      if (DeadlineTimer) {
        clearTimeout(DeadlineTimer);
        DeadlineTimer = null;
      }
      try {
        Socket.destroy();
      } catch {
        // ignore
      }
      resolve(Result);
    };

    const FinishReachable = (LoginState: Ma2LoginState, Extra?: { Version?: string | null; ShowFile?: string | null }) =>
      Finish({
        Reachable: true,
        LatencyMs: Date.now() - Started,
        IsGrandMa2,
        LoginState,
        Version: (Extra && Extra.Version) || null,
        ShowFile: (Extra && Extra.ShowFile) || null,
        Banner,
      });

    const Fail = (Error0: string) =>
      Finish({
        Reachable: false,
        Error: Error0,
        IsGrandMa2,
        LoginState: 'not-attempted',
        Version: null,
        ShowFile: null,
        Banner,
      });

    Socket.setNoDelay(true);
    Socket.setTimeout(BudgetMs);

    DeadlineTimer = setTimeout(() => {
      // A banner was seen but the login/version exchange didn't finish in time.
      if (Banner != null) FinishReachable(Phase === 'banner' ? 'not-attempted' : 'timeout');
      else Fail(`No banner from grandMA2 after ${BudgetMs}ms`);
    }, BudgetMs);

    Socket.on('data', (Chunk: Buffer) => {
      Raw += Chunk.toString('utf8');
      if (Raw.length > 1_000_000) {
        Fail('Reply too large');
        return;
      }
      const C = Clean();

      if (Phase === 'banner') {
        if (!(/please login/i.test(C) || PROMPT_RE.test(C))) return; // banner still arriving
        IsGrandMa2 = IsGrandMa2Banner(C);
        Banner = C.trim().slice(0, 500);
        if (!WantLogin) {
          FinishReachable('not-attempted');
          return;
        }
        try {
          Socket.write(`login ${User} ${Password}\r\n`);
        } catch (Err) {
          FinishReachable('error');
          void Err;
          return;
        }
        Phase = 'login';
        MarkLen = Clean().length;
        return;
      }

      if (Phase === 'login') {
        const Seg = Clean().slice(MarkLen);
        const State = ClassifyLogin(Seg);
        if (State === 'ok') {
          try {
            Socket.write('Version\r\n');
          } catch {
            FinishReachable('ok');
            return;
          }
          Phase = 'version';
          MarkLen = Clean().length;
          return;
        }
        if (State) {
          FinishReachable(State);
        }
        return;
      }

      // version phase — wait for the response to be prompt-terminated.
      const Seg = Clean().slice(MarkLen);
      if (PROMPT_RE.test(Seg)) {
        const Parsed = ParseVersionReply(Seg);
        FinishReachable('ok', Parsed);
      }
    });

    Socket.once('timeout', () => {
      if (Banner != null) FinishReachable(Phase === 'banner' ? 'not-attempted' : 'timeout');
      else Fail(`No banner from grandMA2 after ${BudgetMs}ms`);
    });

    Socket.once('error', (Err: Error) => {
      Fail(Err && Err.message ? Err.message : String(Err));
    });

    Socket.once('close', () => {
      if (Settled) return;
      if (Banner != null) FinishReachable(Phase === 'banner' ? 'not-attempted' : 'timeout');
      else Fail('Connection closed before any banner');
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Fail(Err instanceof Error ? Err.message : String(Err));
    }
  });
}

// --- Shared per-family snapshot cache ----------------------------------------

const MA2_QUERY_CACHE = CacheManager.GetBucket('MonitoringMethods:Ma2Status', {
  defaultTtlMs: 1000,
  maxEntries: 1000,
});

export function BuildMa2QueryCacheKey(
  Address: unknown,
  Port: number,
  User: string,
  Password: string,
  TimeoutMs: number
): string {
  return `${String(Address || '')
    .trim()
    .toLowerCase()}|${Port}|${User}|${Password}|${TimeoutMs}`;
}

export function ResolveMa2QueryCacheTtlMs(TimeoutMs: number): number {
  const Base = Number.isFinite(TimeoutMs) ? TimeoutMs : 4000;
  return Math.max(300, Math.min(1500, (Base / 2) | 0));
}

// --- Shared Run/Debug scaffolding -------------------------------------------

export interface Ma2Config {
  Address: string;
  Port: number;
  User: string;
  Password: string;
  TimeoutMs: number;
}

export function ParseMa2Config(Target: MonitoringTargetLike): Ma2Config {
  const Cfg = (Target && Target.Settings) || {};
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Cfg.Port as number) ? (Cfg.Port as number) | 0 : DEFAULT_MA2_PORT,
    User: Cfg.User == null ? '' : String(Cfg.User),
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    TimeoutMs: Number.isFinite(Cfg.Timeout as number) ? (Cfg.Timeout as number) : 4000,
  };
}

export interface Ma2Context {
  Config: Ma2Config;
  Snapshot: Ma2Snapshot;
}

export async function RunMa2Probe(
  Target: MonitoringTargetLike
): Promise<{ Result: MonitoringResult } | { Ctx: Ma2Context }> {
  const Config = ParseMa2Config(Target);
  if (!Config.Address) return { Result: { Success: false, Error: 'No address configured' } };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Result: { Success: false, Error: `Invalid port: ${Config.Port}` } };
  }

  const Snapshot = (await MA2_QUERY_CACHE.GetOrCreate(
    BuildMa2QueryCacheKey(Config.Address, Config.Port, Config.User, Config.Password, Config.TimeoutMs),
    () => QueryMa2Status(Config.Address, Config.Port, Config.User, Config.Password, Config.TimeoutMs),
    { ttlMs: ResolveMa2QueryCacheTtlMs(Config.TimeoutMs) }
  )) as Ma2Snapshot;

  if (!Snapshot.Reachable) {
    const ErrMsg = Snapshot.Error || 'No reply from grandMA2';
    const Refused = ErrMsg.includes('ECONNREFUSED') || ErrMsg.includes('ECONNRESET');
    return {
      Result: { Success: false, ...(Refused ? { Degraded: true } : {}), Error: ErrMsg },
    };
  }

  return { Ctx: { Config, Snapshot } };
}

export function Ma2SnapshotExtras(Snapshot: Ma2Snapshot): Record<string, unknown> {
  return {
    IsGrandMa2: Snapshot.IsGrandMa2,
    LoginState: Snapshot.LoginState,
    Ma2Version: Snapshot.Version,
    ShowFile: Snapshot.ShowFile,
  };
}

export const LOGIN_STATE_LABELS: Record<Ma2LoginState, string> = {
  'not-attempted': 'Not attempted',
  ok: 'Logged in',
  'bad-credentials': 'Bad credentials',
  disabled: 'Login disabled',
  timeout: 'Login timed out',
  error: 'Login error',
};

export function Ma2StatePill(Result: MonitoringResult, OnlineText: string): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', OnlineText || 'Online');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

export function Ma2DebugHead(
  Config: Ma2Config,
  Result: MonitoringResult,
  StatusPill: string,
  ExtraRows: Array<string | false | null | undefined>
): string {
  const Reachable = !!(Result && Result.Success === true);
  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Result && Result.Ma2Version ? TextRow('Software', String(Result.Ma2Version)) : null,
    Row('Status', StatusPill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Could not reach the console'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach the grandMA2 telnet remote (TCP 30000)') + '</div>';
  }
  return Head;
}

export function Ma2MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

export const _internal = {
  StripAnsi,
  IsGrandMa2Banner,
  ClassifyLogin,
  ParseVersionReply,
  QueryMa2Status,
  ParseMa2Config,
  BuildMa2QueryCacheKey,
  ResolveMa2QueryCacheTtlMs,
  RunMa2Probe,
};
