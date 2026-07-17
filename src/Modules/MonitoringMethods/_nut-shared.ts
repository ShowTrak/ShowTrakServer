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
  { Key: 'Port', Label: 'Port', Type: 'number', Default: DEFAULT_NUT_PORT, Min: 1, Max: 65535 },
  { Key: 'UPSName', Label: 'UPS name', Type: 'string', Default: '' },
  { Key: 'Username', Label: 'Username', Type: 'string', Default: '', Advanced: true },
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
    if (Match) Names.push(Match[1]);
  }
  return Names;
}

// Pull the quoted value out of a `VAR <ups> <var> "value"` reply line. Returns
// null when there is no quoted value (e.g. an ERR line).
export function ParseVarValue(Reply: unknown): string | null {
  const Match = String(Reply == null ? '' : Reply).match(/"([^"]*)"/);
  return Match ? Match[1] : null;
}

// Return the ERR reason token (e.g. `ACCESS-DENIED`) from a reply, or null when
// the reply is not an error.
export function ParseErr(Reply: unknown): string | null {
  const Match = String(Reply == null ? '' : Reply)
    .trim()
    .match(/^ERR\s+(\S+)/i);
  return Match ? Match[1].toUpperCase() : null;
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

// Predicate: consume a whole `LIST UPS` reply — up to and including the
// `END LIST UPS` line, or an early `ERR` line.
function ReadListReply(Buf: string): number | null {
  let Pos = 0;
  while (true) {
    const Nl = Buf.indexOf('\n', Pos);
    if (Nl === -1) return null;
    const Line = Buf.slice(Pos, Nl).trim().toUpperCase();
    if (Line.startsWith('ERR') || Line === 'END LIST UPS') return Nl + 1;
    Pos = Nl + 1;
  }
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
  return new Promise<NutProbe>((resolve) => {
    const Started = Date.now();
    // Whole-probe budget. Socket.setTimeout below is only an IDLE timeout — it
    // resets on every data event, so across the sequential round trips (auth,
    // LIST UPS, one GET VAR per variable) a slow-but-trickling daemon could keep
    // the probe alive far beyond TimeoutMs. This absolute deadline caps the total.
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

    const Finish = (Result: NutProbe) => {
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

    // Send a command and await its (possibly multi-line) reply.
    const Request = (Command: string, Predicate: (Buf: string) => number | null): Promise<string> =>
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

    // Absolute cap on the whole probe, independent of the (resettable) idle
    // timeout above.
    DeadlineTimer = setTimeout(() => {
      FailWaiter(new Error('timeout'));
      Finish({
        Reachable: false,
        Error: `NUT probe exceeded ${BudgetMs}ms`,
        Vars: {},
        VarErrors: {},
      });
    }, BudgetMs);

    Socket.on('data', (Chunk: Buffer) => {
      Buffer0 += Chunk.toString('utf8');
      if (Buffer0.length > 1_000_000) {
        Finish({ Reachable: false, Error: 'Reply too large', Vars: {}, VarErrors: {} });
        return;
      }
      Pump();
    });

    Socket.once('timeout', () => {
      FailWaiter(new Error('timeout'));
      Finish({
        Reachable: false,
        Error: `No reply from upsd after ${TimeoutMs}ms`,
        Vars: {},
        VarErrors: {},
      });
    });

    Socket.once('error', (Err: Error) => {
      const Msg = Err && Err.message ? Err.message : String(Err);
      FailWaiter(Err instanceof Error ? Err : new Error(Msg));
      Finish({ Reachable: false, Error: Msg, Vars: {}, VarErrors: {} });
    });

    Socket.once('close', () => {
      FailWaiter(new Error('connection closed'));
      if (!Settled) {
        Finish({
          Reachable: false,
          Error: 'Connection closed before reply',
          Vars: {},
          VarErrors: {},
        });
      }
    });

    Socket.once('connect', () => {
      void (async () => {
        try {
          // Optional authentication.
          if (Username) {
            const UserReply = await Request(`USERNAME ${Username}\n`, ReadLine);
            const UserErr = ParseErr(UserReply);
            if (UserErr) {
              Finish({
                Reachable: false,
                Error: `Authentication failed (${UserErr})`,
                Vars: {},
                VarErrors: {},
              });
              return;
            }
            const PassReply = await Request(`PASSWORD ${Password}\n`, ReadLine);
            const PassErr = ParseErr(PassReply);
            if (PassErr) {
              Finish({
                Reachable: false,
                Error: `Authentication failed (${PassErr})`,
                Vars: {},
                VarErrors: {},
              });
              return;
            }
          }

          // List UPS devices.
          const ListReply = await Request('LIST UPS\n', ReadListReply);
          const ListErr = ParseErr(ListReply);
          if (ListErr) {
            Finish({
              Reachable: false,
              Error: `LIST UPS failed (${ListErr})`,
              Vars: {},
              VarErrors: {},
            });
            return;
          }
          const UpsNames = ParseListUps(ListReply);

          // Read each requested variable (best effort — an ERR is captured, not
          // fatal, so one unsupported variable doesn't sink the whole probe).
          const VarValues: Record<string, string | null> = {};
          const VarErrors: Record<string, string | null> = {};
          for (const VarName of Vars) {
            const Reply = await Request(`GET VAR ${UpsName} ${VarName}\n`, ReadLine);
            const Err = ParseErr(Reply);
            if (Err) {
              VarValues[VarName] = null;
              VarErrors[VarName] = Err;
            } else {
              VarValues[VarName] = ParseVarValue(Reply);
              VarErrors[VarName] = null;
            }
          }

          try {
            Socket.write('LOGOUT\n');
          } catch {
            // ignore
          }

          Finish({
            Reachable: true,
            LatencyMs: Date.now() - Started,
            UpsNames,
            Vars: VarValues,
            VarErrors,
          });
        } catch (Err) {
          const Msg = Err instanceof Error ? Err.message : String(Err);
          Finish({ Reachable: false, Error: Msg, Vars: {}, VarErrors: {} });
        }
      })();
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Finish({
        Reachable: false,
        Error: Err instanceof Error ? Err.message : String(Err),
        Vars: {},
        VarErrors: {},
      });
    }
  });
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
      : TextRow('Error', (Result && Result.Error) || 'Could not reach upsd'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach NUT (upsd)') + '</div>';
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
};
