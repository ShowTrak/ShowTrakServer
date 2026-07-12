// Network UPS Tools (NUT) monitoring. NUT's `upsd` daemon listens on TCP 3493
// speaking a simple line-based, request/response text protocol. Over a single
// connection this check:
//   1. (optional) authenticates: `USERNAME <user>` / `PASSWORD <pass>` -> `OK`.
//   2. `LIST UPS` -> `BEGIN LIST UPS` / `UPS <name> "<desc>"`... / `END LIST UPS`
//      and confirms the configured UPS name is present.
//   3. `GET VAR <ups> ups.status` -> `VAR <ups> ups.status "OL"` and reads the
//      status tokens (OL online, OB on battery, LB low battery, RB replace
//      battery, OVER overload, ALARM, CHRG charging, DISCHRG discharging).
//   4. `GET VAR <ups> battery.charge` (best effort, for the debug panel).
//   5. `LOGOUT` and closes cleanly.
// `ERR <reason>` replies (UNKNOWN-UPS, ACCESS-DENIED, VAR-NOT-SUPPORTED, ...) are
// handled gracefully rather than thrown.
//
// Result semantics (consumed by MonitoringTarget.Tick):
//   - No TCP connection / no reply / ERR ACCESS-DENIED  -> offline  (Success: false)
//   - upsd answered but the named UPS is not listed     -> degraded ("UPS not found")
//   - Status indicates OB / LB / RB / OVER / ALARM / DISCHRG -> degraded (reason)
//   - Status contains OL and none of the above          -> online   (Success: true)
import net from 'net';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'nut-ups';

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 3493, Min: 1, Max: 65535 },
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

// --- Pure protocol helpers (exported on _internal for unit tests) -----------

// Extract the UPS names from a `LIST UPS` reply body. Each entry looks like
// `UPS <name> "<description>"`; BEGIN/END framing lines are ignored.
function ParseListUps(Reply: unknown): string[] {
  const Names: string[] = [];
  for (const Line of String(Reply == null ? '' : Reply).split('\n')) {
    const Match = Line.trim().match(/^UPS\s+(\S+)\s+"(.*)"\s*$/);
    if (Match) Names.push(Match[1]);
  }
  return Names;
}

// Pull the quoted value out of a `VAR <ups> <var> "value"` reply line. Returns
// null when there is no quoted value (e.g. an ERR line).
function ParseVarValue(Reply: unknown): string | null {
  const Match = String(Reply == null ? '' : Reply).match(/"([^"]*)"/);
  return Match ? Match[1] : null;
}

// Return the ERR reason token (e.g. `ACCESS-DENIED`) from a reply, or null when
// the reply is not an error.
function ParseErr(Reply: unknown): string | null {
  const Match = String(Reply == null ? '' : Reply)
    .trim()
    .match(/^ERR\s+(\S+)/i);
  return Match ? Match[1].toUpperCase() : null;
}

// Status tokens that make a reachable UPS "not healthy", most-severe first. The
// first token present decides the DegradedReason.
const DEGRADED_TOKENS: Array<{ Token: string; Reason: string }> = [
  { Token: 'LB', Reason: 'Low battery' },
  { Token: 'RB', Reason: 'Replace battery' },
  { Token: 'OVER', Reason: 'Overload' },
  { Token: 'ALARM', Reason: 'Alarm' },
  { Token: 'OB', Reason: 'On battery' },
  { Token: 'DISCHRG', Reason: 'Discharging' },
];

interface StatusClassification {
  Online: boolean;
  Degraded: boolean;
  DegradedReason?: string;
  Tokens: string[];
}

// Classify a raw `ups.status` string (e.g. "OL", "OB LB", "OL CHRG"). OL with no
// alarm/battery tokens is online; any degraded token wins (severity-ordered);
// anything else reachable-but-unrecognised is reported degraded.
function ClassifyStatus(StatusStr: unknown): StatusClassification {
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

// --- Line-based NUT probe ---------------------------------------------------

interface NutProbe {
  Reachable: boolean;
  Error?: string;
  LatencyMs?: number;
  UpsNames?: string[];
  Status?: string | null;
  StatusErr?: string | null;
  BatteryCharge?: string | null;
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

async function ProbeNut(
  Address: string,
  Port: number,
  TimeoutMs: number,
  UpsName: string,
  Username: string,
  Password: string
): Promise<NutProbe> {
  return new Promise<NutProbe>((resolve) => {
    const Started = Date.now();
    const Socket = new net.Socket();
    let Buffer0 = '';
    let Settled = false;
    let Waiter: {
      Predicate: (Buf: string) => number | null;
      Resolve: (Reply: string) => void;
      Reject: (Err: Error) => void;
    } | null = null;

    const Finish = (Result: NutProbe) => {
      if (Settled) return;
      Settled = true;
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

    Socket.setTimeout(Math.max(500, TimeoutMs | 0));

    Socket.on('data', (Chunk: Buffer) => {
      Buffer0 += Chunk.toString('utf8');
      if (Buffer0.length > 1_000_000) {
        Finish({ Reachable: false, Error: 'Reply too large' });
        return;
      }
      Pump();
    });

    Socket.once('timeout', () => {
      FailWaiter(new Error('timeout'));
      Finish({ Reachable: false, Error: `No reply from upsd after ${TimeoutMs}ms` });
    });

    Socket.once('error', (Err: Error) => {
      const Msg = Err && Err.message ? Err.message : String(Err);
      FailWaiter(Err instanceof Error ? Err : new Error(Msg));
      Finish({ Reachable: false, Error: Msg });
    });

    Socket.once('close', () => {
      FailWaiter(new Error('connection closed'));
      if (!Settled) Finish({ Reachable: false, Error: 'Connection closed before reply' });
    });

    Socket.once('connect', () => {
      void (async () => {
        try {
          // Optional authentication.
          if (Username) {
            const UserReply = await Request(`USERNAME ${Username}\n`, ReadLine);
            const UserErr = ParseErr(UserReply);
            if (UserErr) {
              Finish({ Reachable: false, Error: `Authentication failed (${UserErr})` });
              return;
            }
            const PassReply = await Request(`PASSWORD ${Password}\n`, ReadLine);
            const PassErr = ParseErr(PassReply);
            if (PassErr) {
              Finish({ Reachable: false, Error: `Authentication failed (${PassErr})` });
              return;
            }
          }

          // List UPS devices.
          const ListReply = await Request('LIST UPS\n', ReadListReply);
          const ListErr = ParseErr(ListReply);
          if (ListErr) {
            Finish({ Reachable: false, Error: `LIST UPS failed (${ListErr})` });
            return;
          }
          const UpsNames = ParseListUps(ListReply);

          // Read the status (and battery charge, best effort).
          const StatusReply = await Request(`GET VAR ${UpsName} ups.status\n`, ReadLine);
          const StatusErr = ParseErr(StatusReply);
          if (StatusErr === 'ACCESS-DENIED') {
            Finish({ Reachable: false, Error: 'Access denied reading ups.status' });
            return;
          }
          const Status = StatusErr ? null : ParseVarValue(StatusReply);

          let BatteryCharge: string | null = null;
          try {
            const ChargeReply = await Request(`GET VAR ${UpsName} battery.charge\n`, ReadLine);
            if (!ParseErr(ChargeReply)) BatteryCharge = ParseVarValue(ChargeReply);
          } catch {
            // battery.charge is optional; ignore failures.
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
            Status,
            StatusErr,
            BatteryCharge,
          });
        } catch (Err) {
          const Msg = Err instanceof Error ? Err.message : String(Err);
          Finish({ Reachable: false, Error: Msg });
        }
      })();
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Finish({
        Reachable: false,
        Error: Err instanceof Error ? Err.message : String(Err),
      });
    }
  });
}

function UpsNameMatches(Names: string[], Wanted: string): boolean {
  const WantedNorm = Wanted.trim().toLowerCase();
  return Names.some((Name) => Name.trim().toLowerCase() === WantedNorm);
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 3493;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 4000;
  const UpsName = Cfg.UPSName == null ? '' : String(Cfg.UPSName).trim();
  const Username = Cfg.Username == null ? '' : String(Cfg.Username).trim();
  const Password = Cfg.Password == null ? '' : String(Cfg.Password);
  if (Port < 1 || Port > 65535) return { Success: false, Error: `Invalid port: ${Port}` };
  if (!UpsName) return { Success: false, Error: 'No UPS name configured' };

  const Probe = await ProbeNut(Address, Port, TimeoutMs, UpsName, Username, Password);

  if (!Probe.Reachable) {
    return { Success: false, Error: Probe.Error || 'No reply from upsd' };
  }

  const UpsNames = Probe.UpsNames || [];
  if (!UpsNameMatches(UpsNames, UpsName)) {
    // upsd answered, so it is reachable — but this UPS is misconfigured.
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'UPS not found',
      LatencyMs: Probe.LatencyMs,
      UpsList: UpsNames,
    };
  }

  // A GET VAR error (other than access denied, handled as offline) means the
  // UPS exists but its status is not readable.
  if (Probe.StatusErr) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Status unavailable',
      LatencyMs: Probe.LatencyMs,
      Status: null,
      BatteryCharge: Probe.BatteryCharge,
      StatusErr: Probe.StatusErr,
      UpsList: UpsNames,
    };
  }

  const Classification = ClassifyStatus(Probe.Status);
  const Base: MonitoringResult = {
    Success: true,
    LatencyMs: Probe.LatencyMs,
    Status: Probe.Status,
    Tokens: Classification.Tokens,
    BatteryCharge: Probe.BatteryCharge,
    UpsList: UpsNames,
  };

  if (Classification.Online) return Base;

  return {
    ...Base,
    Degraded: true,
    DegradedReason: Classification.DegradedReason,
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 3493;
  const UpsName = Cfg.UPSName == null ? '' : String(Cfg.UPSName).trim();

  const Reachable = !!(Result && (Result.Success === true));
  const Degraded = !!(Result && Result.Degraded);
  const Online = Reachable && !Degraded;

  let StatusPill: string;
  if (Online) {
    StatusPill = Pill('success', 'Online (OL)');
  } else if (Reachable) {
    StatusPill = Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  } else {
    StatusPill = Pill('danger', 'Offline');
  }

  const RawStatus = Result && Result.Status != null ? String(Result.Status) : '';
  const Charge = Result && Result.BatteryCharge != null ? String(Result.BatteryCharge) : '';

  const Head = Rows([
    TextRow('Host', `${Address || '—'}:${Port}`),
    TextRow('UPS', UpsName || '—'),
    Row('Status', StatusPill),
    Reachable
      ? Row(
          'Reply time',
          `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`
        )
      : TextRow('Error', (Result && Result.Error) || 'Could not reach upsd'),
    Reachable && RawStatus
      ? Row('ups.status', `<span class="font-monospace">${Esc(RawStatus)}</span>`)
      : null,
    Reachable && Charge
      ? Row('Battery', `<span class="font-monospace">${Esc(Charge)}%</span>`)
      : null,
  ]);

  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach NUT (upsd)') + '</div>';
  }

  return Head;
}

export const Name = 'Network UPS Tools (NUT)';
export const Description =
  'Connects to a NUT upsd server over TCP and reports UPS power state (online / on battery / low battery) via the ups.status variable.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
// Exported for unit tests.
export const _internal = {
  ParseListUps,
  ParseVarValue,
  ParseErr,
  ClassifyStatus,
  UpsNameMatches,
  ProbeNut,
};
export { ID, Settings, Run, Debug };
