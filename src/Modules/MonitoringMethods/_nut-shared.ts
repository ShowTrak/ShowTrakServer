// Shared Network UPS Tools (NUT) protocol client and helpers.
//
// NUT's `upsd` daemon listens on TCP 3493 speaking a simple line-based,
// request/response text protocol. The individual NUT monitoring methods
// (status / battery charge / load / temperature / input voltage / combined
// health) all talk to the same daemon and differ only in which variables they
// read and how they judge the result — so the connection handling, the LIST UPS
// preamble, variable reads, and the common editor Settings all live here.
//
// Over a single connection ProbeNut():
//   1. (optional) authenticates: `USERNAME <user>` / `PASSWORD <pass>` -> `OK`.
//   2. `LIST UPS` -> `BEGIN LIST UPS` / `UPS <name> "<desc>"`... / `END LIST UPS`
//      so callers can confirm the configured UPS name is present.
//   3. `GET VAR <ups> <var>` for each requested variable -> `VAR <ups> <var>
//      "value"` (or an `ERR <reason>` line, captured per-variable rather than
//      thrown).
//   4. `LOGOUT` and closes cleanly.
import net from 'net';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

export const DEFAULT_NUT_PORT = 3493;

// The editor Settings every NUT method shares (connection + auth). Individual
// methods spread this and append their own threshold field(s).
export const CommonNutSettings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_NUT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  { Key: 'UPSName', Label: 'UPS name', Type: 'string', Default: '', Required: true },
  {
    Key: 'Username',
    Label: 'Username',
    Type: 'string',
    Default: '',
    Advanced: true,
    Note: 'Only needed if upsd requires a login to read. Actions always need one, from a upsd.users entry whose instcmds allow them.',
  },
  { Key: 'Password', Label: 'Password', Type: 'string', Default: '', Advanced: true },
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

// Extract the UPS names from a `LIST UPS` reply body. Each entry looks like
// `UPS <name> "<description>"`; BEGIN/END framing lines are ignored.
export function ParseListUps(Reply: unknown): string[] {
  const Names: string[] = [];
  for (const Line of String(Reply == null ? '' : Reply).split('\n')) {
    const Match = Line.trim().match(/^UPS\s+(\S+)\s+"(.*)"\s*$/);
    if (Match && Match[1]) Names.push(Match[1]);
  }
  return Names;
}

// Pull the quoted value out of a `VAR <ups> <var> "value"` reply line. Returns
// null when there is no quoted value (e.g. an ERR line).
export function ParseVarValue(Reply: unknown): string | null {
  const Match = String(Reply == null ? '' : Reply).match(/"([^"]*)"/);
  return Match ? (Match[1] ?? null) : null;
}

// Return the ERR reason token (e.g. `ACCESS-DENIED`) from a reply, or null when
// the reply is not an error.
export function ParseErr(Reply: unknown): string | null {
  const Match = String(Reply == null ? '' : Reply)
    .trim()
    .match(/^ERR\s+(\S+)/i);
  return Match && Match[1] ? Match[1].toUpperCase() : null;
}

// Parse a numeric NUT variable value (e.g. "230.0", "78", "45.5"). Returns null
// when the value is missing or not a finite number.
export function ParseNumber(Value: unknown): number | null {
  if (Value == null) return null;
  const Num = Number(String(Value).trim());
  return Number.isFinite(Num) ? Num : null;
}

// Status tokens that make a reachable UPS "not healthy", most-severe first. The
// first token present decides the DegradedReason.
export const DEGRADED_TOKENS: Array<{ Token: string; Reason: string }> = [
  { Token: 'LB', Reason: 'Low battery' },
  { Token: 'RB', Reason: 'Replace battery' },
  { Token: 'OVER', Reason: 'Overload' },
  { Token: 'ALARM', Reason: 'Alarm' },
  { Token: 'OB', Reason: 'On battery' },
  { Token: 'DISCHRG', Reason: 'Discharging' },
];

export interface StatusClassification {
  Online: boolean;
  Degraded: boolean;
  DegradedReason?: string;
  Tokens: string[];
}

// Classify a raw `ups.status` string (e.g. "OL", "OB LB", "OL CHRG"). OL with no
// alarm/battery tokens is online; any degraded token wins (severity-ordered);
// anything else reachable-but-unrecognised is reported degraded.
export function ClassifyStatus(StatusStr: unknown): StatusClassification {
  const Tokens = String(StatusStr == null ? '' : StatusStr)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  const Has = (Token: string): boolean => Tokens.includes(Token);

  for (const Entry of DEGRADED_TOKENS) {
    if (Has(Entry.Token)) {
      return { Online: false, Degraded: true, DegradedReason: Entry.Reason, Tokens };
    }
  }
  if (Has('OL')) return { Online: true, Degraded: false, Tokens };
  return { Online: false, Degraded: true, DegradedReason: 'Unknown status', Tokens };
}

export function UpsNameMatches(Names: string[], Wanted: string): boolean {
  const WantedNorm = Wanted.trim().toLowerCase();
  return Names.some((Name) => Name.trim().toLowerCase() === WantedNorm);
}

// --- Line-based NUT probe ---------------------------------------------------

export interface NutProbe {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  UpsNames?: string[];
  // Requested variable -> quoted value (null when the daemon returned an ERR
  // line for that variable, i.e. it is unsupported / not readable).
  Vars: Record<string, string | null>;
  // Requested variable -> ERR reason token, when the read failed.
  VarErrors: Record<string, string | null>;
}

// Predicate: consume a single line (through its trailing newline).
function ReadLine(Buf: string): number | null {
  const Idx = Buf.indexOf('\n');
  return Idx === -1 ? null : Idx + 1;
}

// Predicate: consume a whole `LIST UPS` / `LIST CMD` reply — up to and
// including its `END LIST ...` line, or an early `ERR` line.
function ReadListReply(Buf: string): number | null {
  let Pos = 0;
  while (true) {
    const Nl = Buf.indexOf('\n', Pos);
    if (Nl === -1) return null;
    const Line = Buf.slice(Pos, Nl).trim().toUpperCase();
    if (Line.startsWith('ERR') || Line.startsWith('END LIST')) return Nl + 1;
    Pos = Nl + 1;
  }
}

// Send one command and await its (possibly multi-line) reply.
type NutRequest = (Command: string, Predicate?: (Buf: string) => number | null) => Promise<string>;

// Thrown inside a session body to end the session with this message as its
// error, e.g. a failed login.
class NutSessionError extends Error {}

type NutSessionOutcome<T> =
  { Ok: true; Value: T; LatencyMs: number } | { Ok: false; Error: string };

// One upsd conversation: connect, optionally log in, run Body's requests, then
// LOGOUT and close. The socket handling, timeouts and authentication are shared
// by the health probe and the instant-command path so both fail the same way.
function RunNutSession<T>(
  Address: string,
  Port: number,
  TimeoutMs: number,
  Username: string,
  Password: string,
  Label: string,
  Body: (Request: NutRequest) => Promise<T>
): Promise<NutSessionOutcome<T>> {
  return new Promise<NutSessionOutcome<T>>((resolve) => {
    const Started = Date.now();
    // Whole-session budget. Socket.setTimeout below is only an IDLE timeout — it
    // resets on every data event, so across the sequential round trips (auth,
    // LIST UPS, one GET VAR per variable) a slow-but-trickling daemon could keep
    // the session alive far beyond TimeoutMs. This absolute deadline caps the total.
    const BudgetMs = Math.max(500, TimeoutMs | 0);
    const Socket = new net.Socket();
    let Buffer0 = '';
    let Settled = false;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let Waiter: {
      Predicate: (Buf: string) => number | null;
      Resolve: (Reply: string) => void;
      Reject: (Err: Error) => void;
    } | null = null;

    const Finish = (Result: NutSessionOutcome<T>) => {
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
    const Fail = (Error: string) => Finish({ Ok: false, Error });

    const Pump = () => {
      if (!Waiter) return;
      const Consumed = Waiter.Predicate(Buffer0);
      if (Consumed == null) return;
      const Reply = Buffer0.slice(0, Consumed);
      Buffer0 = Buffer0.slice(Consumed);
      const Current = Waiter;
      Waiter = null;
      Current.Resolve(Reply);
    };

    const FailWaiter = (Err: Error) => {
      if (!Waiter) return;
      const Current = Waiter;
      Waiter = null;
      Current.Reject(Err);
    };

    const Request: NutRequest = (Command, Predicate = ReadLine) =>
      new Promise<string>((Res, Rej) => {
        Waiter = { Predicate, Resolve: Res, Reject: Rej };
        try {
          Socket.write(Command);
        } catch (Err) {
          Waiter = null;
          Rej(Err instanceof Error ? Err : new Error(String(Err)));
          return;
        }
        Pump();
      });

    Socket.setTimeout(BudgetMs);

    // Absolute cap on the whole session, independent of the (resettable) idle
    // timeout above.
    DeadlineTimer = setTimeout(() => {
      FailWaiter(new Error('timeout'));
      Fail(`${Label} exceeded ${BudgetMs}ms`);
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
      Fail(`No reply from upsd after ${TimeoutMs}ms`);
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
          // Optional authentication.
          if (Username) {
            const UserErr = ParseErr(await Request(`USERNAME ${Username}\n`));
            if (UserErr) throw new NutSessionError(`Authentication failed (${UserErr})`);
            const PassErr = ParseErr(await Request(`PASSWORD ${Password}\n`));
            if (PassErr) throw new NutSessionError(`Authentication failed (${PassErr})`);
          }

          const Value = await Body(Request);

          try {
            Socket.write('LOGOUT\n');
          } catch {
            // ignore
          }
          Finish({ Ok: true, Value, LatencyMs: Date.now() - Started });
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

export async function ProbeNut(
  Address: string,
  Port: number,
  TimeoutMs: number,
  UpsName: string,
  Username: string,
  Password: string,
  Vars: string[]
): Promise<NutProbe> {
  const Outcome = await RunNutSession(
    Address,
    Port,
    TimeoutMs,
    Username,
    Password,
    'NUT probe',
    async (Request) => {
      // List UPS devices.
      const ListReply = await Request('LIST UPS\n', ReadListReply);
      const ListErr = ParseErr(ListReply);
      if (ListErr) throw new NutSessionError(`LIST UPS failed (${ListErr})`);
      const UpsNames = ParseListUps(ListReply);

      // Read each requested variable (best effort — an ERR is captured, not
      // fatal, so one unsupported variable doesn't sink the whole probe).
      const VarValues: Record<string, string | null> = {};
      const VarErrors: Record<string, string | null> = {};
      for (const VarName of Vars) {
        const Reply = await Request(`GET VAR ${UpsName} ${VarName}\n`);
        const Err = ParseErr(Reply);
        if (Err) {
          VarValues[VarName] = null;
          VarErrors[VarName] = Err;
        } else {
          VarValues[VarName] = ParseVarValue(Reply);
          VarErrors[VarName] = null;
        }
      }
      return { UpsNames, Vars: VarValues, VarErrors };
    }
  );

  if (!Outcome.Ok) return { Reachable: false, Error: Outcome.Error, Vars: {}, VarErrors: {} };
  return { Reachable: true, LatencyMs: Outcome.LatencyMs, ...Outcome.Value };
}

// --- Instant commands -------------------------------------------------------
//
// NUT calls a UPS action an "instant command": `INSTCMD <ups> <cmd>`, answered
// `OK` (or `OK TRACKING <id>` when the server tracks command results) or an ERR
// line. Sending one needs a login whose upsd.users entry grants that command
// under `instcmds`; listing them (`LIST CMD <ups>`) needs no login at all.

// Extract the command names from a `LIST CMD` reply. Each entry looks like
// `CMD <ups> <cmdname>`; BEGIN/END framing lines are ignored.
export function ParseListCmd(Reply: unknown): string[] {
  const Out: string[] = [];
  for (const Line of String(Reply == null ? '' : Reply).split('\n')) {
    const Match = Line.trim().match(/^CMD\s+\S+\s+(\S+)$/);
    if (Match) Out.push(Match[1]!);
  }
  return Out;
}

// What an instant-command ERR token means for the operator, naming what fixes it.
export function DescribeInstCmdError(Token: string, UpsName: string): string {
  switch (Token.toUpperCase()) {
    case 'ACCESS-DENIED':
      return 'upsd refused the command — this NUT user is not allowed to send it (add it to the user’s instcmds in upsd.users)';
    case 'USERNAME-REQUIRED':
    case 'PASSWORD-REQUIRED':
      return 'upsd requires a NUT username and password to send commands';
    case 'CMD-NOT-SUPPORTED':
      return 'This UPS does not support that command';
    case 'UNKNOWN-UPS':
      return `upsd has no UPS named "${UpsName}"`;
    case 'DRIVER-NOT-CONNECTED':
    case 'DATA-STALE':
      return 'upsd has lost contact with the UPS driver';
    default:
      return `upsd refused the command (${Token})`;
  }
}

export interface NutCommandResult {
  Success: boolean;
  Error?: string;
  /** The command actually sent — the first of the candidates the UPS lists. */
  Command?: string;
}

/**
 * Send the first of `Candidates` that this UPS lists as supported. Drivers name
 * the same action differently, so callers pass every name it goes by in order
 * of preference. A UPS that lists none of them is refused here rather than sent
 * a command it would reject.
 */
export async function SendNutInstCmd(
  Config: NutConfig,
  Candidates: string[]
): Promise<NutCommandResult> {
  const Outcome = await RunNutSession(
    Config.Address,
    Config.Port,
    Config.TimeoutMs,
    Config.Username,
    Config.Password,
    'NUT command',
    async (Request): Promise<NutCommandResult> => {
      const ListReply = await Request(`LIST CMD ${Config.UpsName}\n`, ReadListReply);
      const ListErr = ParseErr(ListReply);
      if (ListErr && ListErr.toUpperCase() === 'UNKNOWN-UPS') {
        return { Success: false, Error: DescribeInstCmdError(ListErr, Config.UpsName) };
      }
      // A server that will not list its commands still gets the preferred one
      // sent, and answers CMD-NOT-SUPPORTED itself if it has to.
      const Supported = ListErr ? null : ParseListCmd(ListReply);
      const Command = Supported
        ? Candidates.find((Name) => Supported.includes(Name))
        : Candidates[0];
      if (!Command) return { Success: false, Error: 'This UPS does not support that command' };

      const Reply = await Request(`INSTCMD ${Config.UpsName} ${Command}\n`);
      const Err = ParseErr(Reply);
      if (Err) return { Success: false, Error: DescribeInstCmdError(Err, Config.UpsName), Command };
      return { Success: true, Command };
    }
  );
  if (!Outcome.Ok) return { Success: false, Error: Outcome.Error };
  return Outcome.Value;
}

// --- Shared Run/Debug scaffolding -------------------------------------------

export interface NutConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
  UpsName: string;
  Username: string;
  Password: string;
}

// Parse the common connection settings off a target, defaulting anything the
// caller left unset. Never throws — used by both Run (via ReadNutConfig) and the
// Debug renderer.
export function ParseNutConfig(Target: MonitoringTargetLike): NutConfig {
  const Cfg = (Target && Target.Settings) || {};
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Cfg.Port as number) ? (Cfg.Port as number) | 0 : DEFAULT_NUT_PORT,
    TimeoutMs: Number.isFinite(Cfg.Timeout as number) ? (Cfg.Timeout as number) : 4000,
    UpsName: Cfg.UPSName == null ? '' : String(Cfg.UPSName).trim(),
    Username: Cfg.Username == null ? '' : String(Cfg.Username).trim(),
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
  };
}

export interface NutContext {
  Config: NutConfig;
  Probe: NutProbe;
}

// Validate config, probe the daemon for the given variables, and apply the
// checks that every NUT method shares (bad config / unreachable / UPS missing).
// Returns an early { Result } for those cases, or { Ctx } with the live probe so
// the calling method can judge its specific variable(s).
export async function RunNutProbe(
  Target: MonitoringTargetLike,
  Vars: string[]
): Promise<{ Result: MonitoringResult } | { Ctx: NutContext }> {
  const Config = ParseNutConfig(Target);
  if (!Config.Address) return { Result: { Success: false, Error: 'No address configured' } };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Result: { Success: false, Error: `Invalid port: ${Config.Port}` } };
  }
  if (!Config.UpsName) return { Result: { Success: false, Error: 'No UPS name configured' } };

  const Probe = await ProbeNut(
    Config.Address,
    Config.Port,
    Config.TimeoutMs,
    Config.UpsName,
    Config.Username,
    Config.Password,
    Vars
  );

  if (!Probe.Reachable) {
    return { Result: { Success: false, Error: Probe.Error || 'No reply from upsd' } };
  }

  const UpsNames = Probe.UpsNames || [];
  if (!UpsNameMatches(UpsNames, Config.UpsName)) {
    // upsd answered, so it is reachable — but this UPS is misconfigured.
    return {
      Result: {
        Success: true,
        Degraded: true,
        DegradedReason: 'UPS not found',
        LatencyMs: Probe.LatencyMs,
        UpsList: UpsNames,
      },
    };
  }

  return { Ctx: { Config, Probe } };
}

// A status pill coloured from a result: green (online), amber (degraded,
// showing the reason), or red (offline).
export function StatePill(Result: MonitoringResult, OnlineText: string): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', OnlineText || 'Online');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

// Render the debug panel head (Host / UPS / Status / reply time or error) shared
// by every NUT method, with method-specific rows appended.
export function NutDebug(
  Config: NutConfig,
  Result: MonitoringResult,
  StatusPill: string,
  ExtraRows: Array<string | false | null | undefined>
): string {
  const Reachable = !!(Result && Result.Success === true);
  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    TextRow('UPS', Config.UpsName || '—'),
    Row('Status', StatusPill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach upsd'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Failed to reach NUT (upsd)') + '</div>';
  }
  return Head;
}

// Convenience for a monospace value row (e.g. "78%", "230.0 V").
export function MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

export const _internal = {
  ParseListUps,
  ParseVarValue,
  ParseErr,
  ParseNumber,
  ClassifyStatus,
  UpsNameMatches,
  ProbeNut,
  ParseNutConfig,
  RunNutProbe,
  ParseListCmd,
  SendNutInstCmd,
};
