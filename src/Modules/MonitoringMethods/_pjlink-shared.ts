// Shared PJLink protocol client and helpers.
//
// PJLink (JBMIA) is the cross-brand projector control protocol spoken on TCP
// 4352 by Epson, NEC/Sharp, Panasonic, Christie, Sony, Barco, BenQ, Optoma and
// most other network-capable projectors. On connect the projector speaks first:
//   `PJLINK 0\r`             — no authentication, send commands directly.
//   `PJLINK 1 <seed>\r`      — authentication required; the first command must
//                              be prefixed with lowercase-hex MD5(seed+password).
// Commands are `%1XXXX ?\r` (CR-terminated), responses `%1XXXX=<value>\r`.
// Error tokens in place of a value: ERR1 (undefined/unsupported command — the
// device is fine, the feature is absent, e.g. LAMP on laser models), ERR2 (bad
// parameter), ERR3 (unavailable time / busy / standby), ERR4 (projector
// failure). A failed authentication is answered with the line `PJLINK ERRA`.
//
// Many projectors accept only ONE concurrent PJLink TCP session and drop idle
// connections after 30s, so the whole pjlink-* method family funnels through a
// single cached status snapshot per projector per tick (QueryProjectorStatus +
// PJLINK_QUERY_CACHE below): one short-lived connection reads everything, each
// method then judges its own slice.
//
// This pass sends only Class 1 (`%1`) commands, which every PJLink device must
// answer. The device class is still captured via CLSS — any future Class 2
// command (FILT, RLMP, ...) must gate on it.
import net from 'net';
import crypto from 'crypto';
import { Manager as CacheManager } from '../CacheManager';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

export const DEFAULT_PJLINK_PORT = 4352;

// The editor Settings every PJLink method shares (connection + auth). Individual
// methods spread this and append their own field(s).
export const CommonPJLinkSettings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PJLINK_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Password',
    Label: 'PJLink password',
    Type: 'string',
    Default: '',
    Note: "Enter the projector's PJLink password. Leave blank when authentication is off.",
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

export type PJLinkErr = 'ERR1' | 'ERR2' | 'ERR3' | 'ERR4';

export interface ErstStatus {
  Fan: number;
  Lamp: number;
  Temperature: number;
  Cover: number;
  Filter: number;
  Other: number;
}

export interface LampReading {
  Hours: number;
  On: boolean;
}

// Parse the greeting line the projector sends on connect. Case-insensitive and
// tolerant of extra whitespace; returns null for anything that is not a PJLink
// greeting (wrong service on the port).
export function ParseGreeting(
  Line: unknown
): { Auth: false } | { Auth: true; Seed: string } | null {
  const Str = String(Line == null ? '' : Line).trim();
  if (/^PJLINK\s+0\b/i.test(Str)) return { Auth: false };
  const Match = Str.match(/^PJLINK\s+1\s+([0-9a-fA-F]{1,32})/i);
  if (Match && Match[1]) return { Auth: true, Seed: Match[1] };
  return null;
}

// Digest for authenticated sessions: lowercase-hex MD5 of seed + password (in
// that order, no separator). Spec test vector: seed 498e4a67 with password
// JBMIAProjectorLink -> 5d8409bc1c3fa39749434aa3a5c38682.
export function BuildAuthDigest(Seed: string, Password: string): string {
  return crypto.createHash('md5').update(`${Seed}${Password}`).digest('hex').toLowerCase();
}

// Build a query line, e.g. BuildCommand('POWR') -> '%1POWR ?\r'. The auth digest
// is prefixed only on the first command of a connection.
export function BuildCommand(Body: string, Digest: string | null): Buffer {
  return Buffer.from(`${Digest || ''}%1${Body} ?\r`, 'utf8');
}

// Parse a single response line: either the auth-failure line `PJLINK ERRA` or a
// command reply `%1XXXX=<value>`. Returns null for anything unrecognised.
export function ParseResponseLine(
  Line: unknown
): { Kind: 'auth-fail' } | { Kind: 'reply'; Command: string; Value: string } | null {
  const Str = String(Line == null ? '' : Line).trim();
  if (/^PJLINK\s+ERRA\b/i.test(Str)) return { Kind: 'auth-fail' };
  const Match = Str.match(/^%[12]([A-Z0-9]{4})=(.*)$/i);
  if (Match && Match[1] != null) {
    return { Kind: 'reply', Command: Match[1].toUpperCase(), Value: Match[2] ?? '' };
  }
  return null;
}

// Extract the ERR1-ERR4 token from a response value, or null for a real value.
export function ParseErrToken(Value: unknown): PJLinkErr | null {
  const Match = String(Value == null ? '' : Value)
    .trim()
    .match(/^(ERR[1-4])$/i);
  return Match ? (Match[1]!.toUpperCase() as PJLinkErr) : null;
}

// ERST value: six ASCII digits in fixed positions — fan, lamp, temperature,
// cover-open, filter, other. Each digit: 0 = ok (or not detectable), 1 =
// warning, 2 = error.
export function ParseErst(Value: unknown): ErstStatus | null {
  const Match = String(Value == null ? '' : Value)
    .trim()
    .match(/^([0-2])([0-2])([0-2])([0-2])([0-2])([0-2])$/);
  if (!Match) return null;
  return {
    Fan: Number(Match[1]),
    Lamp: Number(Match[2]),
    Temperature: Number(Match[3]),
    Cover: Number(Match[4]),
    Filter: Number(Match[5]),
    Other: Number(Match[6]),
  };
}

const ERST_CATEGORIES: Array<{ Key: keyof ErstStatus; Label: string }> = [
  { Key: 'Fan', Label: 'Fan' },
  { Key: 'Lamp', Label: 'Lamp' },
  { Key: 'Temperature', Label: 'Temperature' },
  { Key: 'Cover', Label: 'Cover' },
  { Key: 'Filter', Label: 'Filter' },
  { Key: 'Other', Label: 'Other' },
];

// Human reasons for every reported ERST error (always) and warning (only when
// IncludeWarnings), e.g. ['Fan error', 'Filter warning'].
export function ErstReasons(Erst: ErstStatus, IncludeWarnings: boolean): string[] {
  const Reasons: string[] = [];
  for (const Category of ERST_CATEGORIES) {
    const Level = Erst[Category.Key];
    if (Level === 2) Reasons.push(`${Category.Label} error`);
    else if (Level === 1 && IncludeWarnings) Reasons.push(`${Category.Label} warning`);
  }
  return Reasons;
}

// LAMP value: whitespace-separated `<hours> <state>` pairs, one per lamp (hours
// 0-99999, state 1 = lit). E.g. '8262 1 13451 0' = two lamps.
export function ParseLamps(Value: unknown): LampReading[] {
  const Parts = String(Value == null ? '' : Value)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const Lamps: LampReading[] = [];
  for (let i = 0; i + 1 < Parts.length; i += 2) {
    const Hours = Number(Parts[i]);
    if (!Number.isFinite(Hours)) return [];
    Lamps.push({ Hours, On: Parts[i + 1] === '1' });
  }
  return Lamps;
}

// POWR value: 0 standby, 1 on, 2 cooling, 3 warm-up.
export function ParsePower(Value: unknown): number | null {
  const Str = String(Value == null ? '' : Value).trim();
  return /^[0-3]$/.test(Str) ? Number(Str) : null;
}

export const POWER_LABELS: Record<number, string> = {
  0: 'Standby',
  1: 'On',
  2: 'Cooling',
  3: 'Warming up',
};

export function PowerLabel(Power: number | null): string {
  return Power != null && POWER_LABELS[Power] ? POWER_LABELS[Power] : 'Unknown';
}

// Input codes are two characters: source type + channel. Class 2 channels may
// be alphabetic (11-6Z), so normalise case rather than parsing digits.
export function NormalizeInputCode(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .replace(/\s+/g, '')
    .toUpperCase();
}

const INPUT_TYPE_LABELS: Record<string, string> = {
  '1': 'RGB',
  '2': 'Video',
  '3': 'Digital',
  '4': 'Storage',
  '5': 'Network',
  '6': 'Internal',
};

// Human label for a 2-char input code, e.g. '31' -> 'Digital 1'.
export function InputLabel(Code: unknown): string {
  const Normalized = NormalizeInputCode(Code);
  if (Normalized.length !== 2) return Normalized || 'Unknown';
  const Type = INPUT_TYPE_LABELS[Normalized[0]!];
  return Type ? `${Type} ${Normalized[1]}` : Normalized;
}

// --- One-connection status snapshot ------------------------------------------

export interface PJLinkSnapshot {
  Reachable: boolean;
  Error?: string;
  // Authentication failed (or a password is required but none is configured) —
  // still Reachable:false, but callers surface a password-specific error.
  AuthFailed?: boolean;
  LatencyMs?: number;
  Class: string | null;
  Power: number | null;
  PowerErr: PJLinkErr | null;
  Erst: ErstStatus | null;
  ErstErr: PJLinkErr | null;
  Lamps: LampReading[] | null;
  LampErr: PJLinkErr | null;
  Input: string | null;
  InputErr: PJLinkErr | null;
  Mute: string | null;
  Name: string | null;
  Manufacturer: string | null;
  Model: string | null;
}

const EMPTY_SNAPSHOT: Omit<PJLinkSnapshot, 'Reachable' | 'Error' | 'AuthFailed'> = {
  Class: null,
  Power: null,
  PowerErr: null,
  Erst: null,
  ErstErr: null,
  Lamps: null,
  LampErr: null,
  Input: null,
  InputErr: null,
  Mute: null,
  Name: null,
  Manufacturer: null,
  Model: null,
};

// Everything the family needs, fetched over ONE connection. All commands are
// Class 1 and sent sequentially (PJLink allows one outstanding command at a
// time); ERR tokens are recorded per command, never fatal.
const SNAPSHOT_COMMANDS = ['POWR', 'ERST', 'LAMP', 'INPT', 'AVMT', 'CLSS', 'NAME', 'INF1', 'INF2'];

// Predicate: consume a single CR (or LF) terminated line.
function ReadLine(Buf: string): number | null {
  const Idx = Buf.search(/[\r\n]/);
  if (Idx === -1) return null;
  let End = Idx + 1;
  // Swallow a trailing \n of a \r\n pair so it doesn't yield an empty line.
  if (Buf[Idx] === '\r' && Buf[End] === '\n') End++;
  return End;
}

export async function QueryProjectorStatus(
  Address: string,
  Port: number,
  Password: string,
  TimeoutMs: number
): Promise<PJLinkSnapshot> {
  return new Promise<PJLinkSnapshot>((resolve) => {
    const Started = Date.now();
    // Whole-probe budget. Socket.setTimeout below is only an IDLE timeout — it
    // resets on every data event, so across the sequential round trips a
    // slow-but-trickling device could keep the probe alive far beyond
    // TimeoutMs. This absolute deadline caps the total.
    const BudgetMs = Math.max(500, TimeoutMs | 0);
    const Socket = new net.Socket();
    let Buffer0 = '';
    let Settled = false;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let Waiter: {
      Resolve: (Line: string) => void;
      Reject: (Err: Error) => void;
    } | null = null;

    const Finish = (Result: PJLinkSnapshot) => {
      if (Settled) return;
      Settled = true;
      if (DeadlineTimer) {
        clearTimeout(DeadlineTimer);
        DeadlineTimer = null;
      }
      // Prompt close matters: many projectors accept a single PJLink session.
      try {
        Socket.destroy();
      } catch {
        // ignore
      }
      resolve(Result);
    };

    const Fail = (Error0: string, AuthFailed?: boolean) =>
      Finish({
        Reachable: false,
        Error: Error0,
        ...(AuthFailed ? { AuthFailed: true } : {}),
        ...EMPTY_SNAPSHOT,
      });

    const Pump = () => {
      while (Waiter) {
        const Consumed = ReadLine(Buffer0);
        if (Consumed == null) return;
        const Line = Buffer0.slice(0, Consumed).replace(/[\r\n]+$/, '');
        Buffer0 = Buffer0.slice(Consumed);
        if (!Line.trim()) continue; // ignore blank lines between replies
        const Current = Waiter;
        Waiter = null;
        Current.Resolve(Line);
      }
    };

    const FailWaiter = (Err: Error) => {
      if (!Waiter) return;
      const Current = Waiter;
      Waiter = null;
      Current.Reject(Err);
    };

    // Await the next non-empty line, optionally sending a command first.
    const NextLine = (Payload: Buffer | null): Promise<string> =>
      new Promise<string>((Res, Rej) => {
        Waiter = { Resolve: Res, Reject: Rej };
        if (Payload) {
          try {
            Socket.write(Payload);
          } catch (Err) {
            Waiter = null;
            Rej(Err instanceof Error ? Err : new Error(String(Err)));
            return;
          }
        }
        Pump();
      });

    Socket.setNoDelay(true);
    Socket.setTimeout(BudgetMs);

    DeadlineTimer = setTimeout(() => {
      FailWaiter(new Error('timeout'));
      Fail(`PJLink probe exceeded ${BudgetMs}ms`);
    }, BudgetMs);

    Socket.on('data', (Chunk: Buffer) => {
      Buffer0 += Chunk.toString('utf8');
      if (Buffer0.length > 1_000_000) {
        Fail('Reply too large');
        return;
      }
      Pump();
    });

    Socket.once('timeout', () => {
      FailWaiter(new Error('timeout'));
      Fail(`No reply from projector after ${TimeoutMs}ms`);
    });

    Socket.once('error', (Err: Error) => {
      const Msg = Err && Err.message ? Err.message : String(Err);
      FailWaiter(Err instanceof Error ? Err : new Error(Msg));
      Fail(Msg);
    });

    Socket.once('close', () => {
      FailWaiter(new Error('connection closed'));
      if (!Settled) Fail('Connection closed before reply');
    });

    Socket.once('connect', () => {
      void (async () => {
        try {
          // The projector speaks first.
          const Greeting = ParseGreeting(await NextLine(null));
          if (!Greeting) {
            Fail('Not a PJLink service (unexpected greeting)');
            return;
          }

          let Digest: string | null = null;
          if (Greeting.Auth) {
            if (!Password) {
              // Bail without sending anything — a wrong digest can trip
              // auth-lockout timers on some brands.
              Fail('Projector requires a PJLink password', true);
              return;
            }
            Digest = BuildAuthDigest(Greeting.Seed, Password);
          }

          const Values: Record<string, string> = {};
          const Errors: Record<string, PJLinkErr | null> = {};
          for (const Command of SNAPSHOT_COMMANDS) {
            const Line = await NextLine(BuildCommand(Command, Digest));
            Digest = null; // first command only
            const Parsed = ParseResponseLine(Line);
            if (Parsed && Parsed.Kind === 'auth-fail') {
              Fail('Authentication failed (ERRA) — check the PJLink password', true);
              return;
            }
            // Tolerate replies for a different command (out-of-spec devices) by
            // recording them under their own echoed command name.
            if (Parsed && Parsed.Kind === 'reply') {
              const Err = ParseErrToken(Parsed.Value);
              if (Err) Errors[Parsed.Command] = Err;
              else Values[Parsed.Command] = Parsed.Value;
            }
          }

          Finish({
            Reachable: true,
            LatencyMs: Date.now() - Started,
            Class: Values.CLSS != null ? Values.CLSS.trim() : null,
            Power: Values.POWR != null ? ParsePower(Values.POWR) : null,
            PowerErr: Errors.POWR || null,
            Erst: Values.ERST != null ? ParseErst(Values.ERST) : null,
            ErstErr: Errors.ERST || null,
            Lamps: Values.LAMP != null ? ParseLamps(Values.LAMP) : null,
            LampErr: Errors.LAMP || null,
            Input: Values.INPT != null ? NormalizeInputCode(Values.INPT) : null,
            InputErr: Errors.INPT || null,
            Mute: Values.AVMT != null ? Values.AVMT.trim() : null,
            Name: Values.NAME != null ? Values.NAME : null,
            Manufacturer: Values.INF1 != null ? Values.INF1 : null,
            Model: Values.INF2 != null ? Values.INF2 : null,
          });
        } catch (Err) {
          Fail(Err instanceof Error ? Err.message : String(Err));
        }
      })();
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Fail(Err instanceof Error ? Err.message : String(Err));
    }
  });
}

// --- Shared per-family snapshot cache ----------------------------------------

// One snapshot per projector per tick, shared by every pjlink-* check against
// the same address — essential because many projectors accept only a single
// concurrent PJLink connection.
const PJLINK_QUERY_CACHE = CacheManager.GetBucket('MonitoringMethods:PJLinkStatus', {
  defaultTtlMs: 1000,
  maxEntries: 1000,
});

export function BuildQueryCacheKey(
  Address: unknown,
  Port: number,
  Password: string,
  TimeoutMs: number
): string {
  return `${String(Address || '')
    .trim()
    .toLowerCase()}|${Port}|${Password}|${TimeoutMs}`;
}

// Short-lived: enough to dedupe a family of checks in the same tick without
// masking real state changes for long. Same shape as the QLab query cache.
export function ResolveQueryCacheTtlMs(TimeoutMs: number): number {
  const Base = Number.isFinite(TimeoutMs) ? TimeoutMs : 4000;
  return Math.max(300, Math.min(1500, (Base / 2) | 0));
}

// --- Shared Run/Debug scaffolding -------------------------------------------

export interface PJLinkConfig {
  Address: string;
  Port: number;
  Password: string;
  TimeoutMs: number;
}

// Parse the common connection settings off a target, defaulting anything left
// unset. Never throws — used by both Run and the Debug renderers.
export function ParsePJLinkConfig(Target: MonitoringTargetLike): PJLinkConfig {
  const Cfg = (Target && Target.Settings) || {};
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Cfg.Port as number) ? (Cfg.Port as number) | 0 : DEFAULT_PJLINK_PORT,
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    TimeoutMs: Number.isFinite(Cfg.Timeout as number) ? (Cfg.Timeout as number) : 4000,
  };
}

export interface PJLinkContext {
  Config: PJLinkConfig;
  Snapshot: PJLinkSnapshot;
}

// Validate config, fetch (or reuse) the cached status snapshot, and apply the
// checks every PJLink method shares (bad config / unreachable / auth failure).
// Returns an early { Result } for those cases, or { Ctx } with the live
// snapshot so the calling method can judge its specific slice.
export async function RunPJLinkProbe(
  Target: MonitoringTargetLike
): Promise<{ Result: MonitoringResult } | { Ctx: PJLinkContext }> {
  const Config = ParsePJLinkConfig(Target);
  if (!Config.Address) return { Result: { Success: false, Error: 'No address configured' } };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Result: { Success: false, Error: `Invalid port: ${Config.Port}` } };
  }

  const Snapshot = (await PJLINK_QUERY_CACHE.GetOrCreate(
    BuildQueryCacheKey(Config.Address, Config.Port, Config.Password, Config.TimeoutMs),
    () => QueryProjectorStatus(Config.Address, Config.Port, Config.Password, Config.TimeoutMs),
    { ttlMs: ResolveQueryCacheTtlMs(Config.TimeoutMs) }
  )) as PJLinkSnapshot;

  if (!Snapshot.Reachable) {
    const ErrMsg = Snapshot.Error || 'No reply from projector';
    // tcp-port convention: an actively refused/reset port means something
    // answered — degraded rather than plain offline.
    const IsResponseError =
      !Snapshot.AuthFailed && (ErrMsg.includes('ECONNREFUSED') || ErrMsg.includes('ECONNRESET'));
    return {
      Result: {
        Success: false,
        ...(IsResponseError ? { Degraded: true } : {}),
        Error: ErrMsg,
      },
    };
  }

  return { Ctx: { Config, Snapshot } };
}

// Extras every method attaches to a reachable result, so tiles/history/debug
// have the identity and headline state available.
export function SnapshotExtras(Snapshot: PJLinkSnapshot): Record<string, unknown> {
  return {
    Class: Snapshot.Class,
    Power: Snapshot.Power,
    PowerLabel: Snapshot.Power != null ? PowerLabel(Snapshot.Power) : null,
    ProjectorName: Snapshot.Name,
    Manufacturer: Snapshot.Manufacturer,
    Model: Snapshot.Model,
  };
}

// A status pill coloured from a result: green (online), amber (degraded,
// showing the reason), or red (offline).
export function PJLinkStatePill(Result: MonitoringResult, OnlineText: string): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', OnlineText || 'Online');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

// Render the debug panel head (Host / Projector identity / Status / reply time
// or error) shared by every PJLink method, with method-specific rows appended.
export function PJLinkDebugHead(
  Config: PJLinkConfig,
  Result: MonitoringResult,
  StatusPill: string,
  ExtraRows: Array<string | false | null | undefined>
): string {
  const Reachable = !!(Result && Result.Success === true);
  const Identity = [Result && Result.ProjectorName, Result && Result.Model]
    .filter((Part) => Part != null && String(Part).trim() !== '')
    .join(' · ');
  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Identity ? TextRow('Projector', Identity) : null,
    Row('Status', StatusPill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Could not reach the projector'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return (
      Head + '<div class="mt-2">' + Note('Could not reach the projector over PJLink') + '</div>'
    );
  }
  return Head;
}

// Convenience for a monospace value row (e.g. '8262 h', 'Digital 1').
export function MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

// --- Discovery enrichment -----------------------------------------------------

// Best-effort identity fetch used by LAN discovery: read NAME and INF2 from an
// unauthenticated projector. Auth-protected projectors return null immediately
// (we never guess a password — wrong digests can trip auth-lockout timers).
export async function FetchProjectorIdentity(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<{ Name: string | null; Model: string | null } | null> {
  return new Promise((resolve) => {
    const BudgetMs = Math.max(500, TimeoutMs | 0);
    const Socket = new net.Socket();
    let Buffer0 = '';
    let Settled = false;
    // PJLink allows one outstanding command at a time, so NAME and INF2 are
    // sent strictly sequentially: greeting -> NAME -> reply -> INF2 -> reply.
    const Pending = ['NAME', 'INF2'];
    let AwaitingGreeting = true;
    const Replies: Record<string, string> = {};

    const Finish = (Result: { Name: string | null; Model: string | null } | null) => {
      if (Settled) return;
      Settled = true;
      try {
        Socket.destroy();
      } catch {
        // ignore
      }
      resolve(Result);
    };

    Socket.setTimeout(BudgetMs);
    Socket.once('timeout', () => Finish(null));
    Socket.once('error', () => Finish(null));
    Socket.once('close', () => Finish(null));

    Socket.on('data', (Chunk: Buffer) => {
      Buffer0 += Chunk.toString('utf8');
      if (Buffer0.length > 65536) {
        Finish(null);
        return;
      }
      let Consumed = ReadLine(Buffer0);
      while (Consumed != null) {
        const Line = Buffer0.slice(0, Consumed).replace(/[\r\n]+$/, '');
        Buffer0 = Buffer0.slice(Consumed);
        Consumed = ReadLine(Buffer0);
        if (!Line.trim()) continue;

        if (AwaitingGreeting) {
          const Greeting = ParseGreeting(Line);
          if (!Greeting || Greeting.Auth) {
            Finish(null);
            return;
          }
          AwaitingGreeting = false;
        } else {
          const Parsed = ParseResponseLine(Line);
          if (Parsed && Parsed.Kind === 'reply' && !ParseErrToken(Parsed.Value)) {
            Replies[Parsed.Command] = Parsed.Value;
          }
        }

        const Next = Pending.shift();
        if (!Next) {
          Finish({ Name: Replies.NAME || null, Model: Replies.INF2 || null });
          return;
        }
        try {
          Socket.write(BuildCommand(Next, null));
        } catch {
          Finish(null);
          return;
        }
      }
    });

    try {
      Socket.connect(Port, Address);
    } catch {
      Finish(null);
    }
  });
}

export const _internal = {
  ParseGreeting,
  BuildAuthDigest,
  BuildCommand,
  ParseResponseLine,
  ParseErrToken,
  ParseErst,
  ErstReasons,
  ParseLamps,
  ParsePower,
  NormalizeInputCode,
  InputLabel,
  QueryProjectorStatus,
  ParsePJLinkConfig,
  BuildQueryCacheKey,
  ResolveQueryCacheTtlMs,
  RunPJLinkProbe,
  FetchProjectorIdentity,
};
