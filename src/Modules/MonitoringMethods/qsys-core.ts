// Q-SYS Core health over QRC (Q-SYS Remote Control, the JSON-RPC 2.0 API on
// TCP 1710). One short-lived session per probe:
//
//   1. `Logon` { User, Password } — only when a user is supplied. Cores with
//      Access Control enabled refuse other methods without it (error 10,
//      "Logon required"); the password is the user's external-control PIN.
//   2. `StatusGet` — Platform, State (Active / Standby / Idle), DesignName,
//      DesignCode, IsRedundant, IsEmulator and Status { Code, String }.
//   3. `Control.Get` [names] — only when control assertions are enabled, and
//      only on an Active Core (QRC says commands sent to the inactive Core of a
//      redundant pair are ignored or refused with -32604, so asking would just
//      burn the timeout).
//
// Framing: every message in both directions is one JSON object terminated by a
// NUL byte. Responses carry the request's numeric id; the Core also pushes an
// unsolicited `EngineStatus` notification (no id) as soon as a client connects
// and whenever its state changes. Replies are therefore matched by id, never by
// arrival order, and notifications are only ever used as a fallback snapshot.
//
// Nothing here changes Core state: Logon / StatusGet / Control.Get are all
// reads. The session closes as soon as the last answer arrives, well inside the
// Core's 60-second idle disconnect, so no NoOp keep-alive is needed.
//
// Status.Code: the QRC page only documents 0 = "OK". The Core's status uses the
// same 0–5 scale as every Q-SYS Status control (0 OK, 1 Compromised, 2 Fault,
// 3 Unknown / Not Present, 4 Missing, 5 Initializing), so a non-zero code is
// reported with that label AND the Core's own Status.String, which is the text
// an operator recognises from Core Manager.
import { RunTcpSession, type TcpSession } from './_tcp-session';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'qsys-core';
const DEFAULT_PORT = 1710;
const DEFAULT_TIMEOUT_MS = 4000;
// A StatusGet reply is a few hundred bytes; anything this large is not a Core.
const MAX_BUFFERED_CHARS = 1_000_000;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'QRC port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'User',
    Label: 'User',
    Type: 'string',
    Default: '',
    Note: 'A Q-SYS Administrator user with an external-control PIN. Leave blank when Access Control is off on the Core.',
  },
  {
    Key: 'Password',
    Label: 'PIN',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'The PIN of the user above. Only sent when a user is set.',
  },
  {
    Key: 'CheckStatus',
    Label: 'Check Core status',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded while the Core reports anything other than OK (Compromised, Fault, Missing, Initializing…), quoting the Core’s own status text.',
  },
  {
    Key: 'RequireActive',
    Label: 'Require Active state',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the Core is Standby or Idle. For a redundant pair, turn this off on the check for the backup Core, which sits in Standby by design.',
  },
  {
    Key: 'CheckDesign',
    Label: 'Check running design',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the running design is not the expected one.',
  },
  {
    Key: 'ExpectedDesign',
    Label: 'Expected design name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckDesign', Equals: true },
    Note: 'Matched without regard to case. Leave blank to confirm only that a design is running.',
  },
  {
    Key: 'CheckControls',
    Label: 'Check Named Controls',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a listed Named Control does not hold its expected value. Controls are only read while the Core is Active.',
  },
  {
    Key: 'ControlAssertions',
    Label: 'Control assertions',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckControls', Equals: true },
    Note: 'One Name=Value per entry, e.g. MainMute=unmuted, MainMute=false or MainGain=-6. Compared with the control’s string (e.g. "unmuted", "-6.0dB"), then its value; case is ignored, numbers compare numerically and true/false match a 1/0 value.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole session: connect, logon, status and control reads.',
  },
];

// --- Options -----------------------------------------------------------------

export interface ControlAssertion {
  Name: string;
  Expected: string;
}

interface QsysConfig {
  Address: string;
  Port: number;
  User: string;
  Password: string;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckStatus: boolean;
  RequireActive: boolean;
  CheckDesign: boolean;
  ExpectedDesign: string;
  CheckControls: boolean;
  Assertions: ControlAssertion[];
  // Entries that could not be read as Name=Value; reported, never sent.
  InvalidAssertions: string[];
}

function ParseConfig(Target: MonitoringTargetLike): QsysConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    User: Cfg.User == null ? '' : String(Cfg.User).trim(),
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Timeout : DEFAULT_TIMEOUT_MS,
  };
}

// Split `Name=Value` entries. The FIRST `=` separates them: Named Control names
// are free text but an `=` in one is far less likely than in a string value.
function ParseControlAssertions(Input: unknown): {
  Assertions: ControlAssertion[];
  Invalid: string[];
} {
  const Assertions: ControlAssertion[] = [];
  const Invalid: string[] = [];
  const List = Array.isArray(Input) ? Input : [];
  for (const Raw of List) {
    const Entry = String(Raw == null ? '' : Raw).trim();
    if (!Entry) continue;
    const Eq = Entry.indexOf('=');
    const Name = Eq > 0 ? Entry.slice(0, Eq).trim() : '';
    if (!Name) {
      Invalid.push(Entry);
      continue;
    }
    Assertions.push({ Name, Expected: Entry.slice(Eq + 1).trim() });
  }
  return { Assertions, Invalid };
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const CheckControls = Cfg.CheckControls === true;
  const Parsed = CheckControls
    ? ParseControlAssertions(Cfg.ControlAssertions)
    : { Assertions: [], Invalid: [] };
  return {
    // Default ON: absent means enabled, so only an explicit false turns it off.
    CheckStatus: Cfg.CheckStatus !== false,
    RequireActive: Cfg.RequireActive !== false,
    CheckDesign: Cfg.CheckDesign === true,
    ExpectedDesign: String(Cfg.ExpectedDesign == null ? '' : Cfg.ExpectedDesign).trim(),
    CheckControls,
    Assertions: Parsed.Assertions,
    InvalidAssertions: Parsed.Invalid,
  };
}

// --- Pure protocol helpers ---------------------------------------------------

// Split NUL-terminated frames off the front of the receive buffer. Rest is the
// incomplete tail still arriving. Whitespace around a frame is tolerated.
function SplitFrames(Buffered: string): { Frames: string[]; Rest: string } {
  const Parts = Buffered.split('\0');
  const Rest = Parts.pop() ?? '';
  return { Frames: Parts.map((Part) => Part.trim()).filter(Boolean), Rest };
}

export interface QrcError {
  Code: number | null;
  Message: string;
}

// The QRC error table, used when a Core sends a code without a message.
const ERROR_MESSAGES: Record<number, string> = {
  [-32700]: 'Parse error',
  [-32600]: 'Invalid request',
  [-32601]: 'Method not found',
  [-32602]: 'Invalid params',
  [-32603]: 'Server error',
  [-32604]: 'Core is on Standby',
  7: 'Unknown component name',
  8: 'Unknown control',
  10: 'Logon required',
};

// Device JSON is untrusted: every conversion below reads primitives only, by
// typeof, so an object where a string or number belongs (or one with a hostile
// toString / valueOf) becomes null instead of throwing.
const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

function PrimString(Value: unknown): string | null {
  if (typeof Value === 'string') return Value;
  if (typeof Value === 'number' || typeof Value === 'boolean') return String(Value);
  return null;
}

function PrimNumber(Value: unknown): number | null {
  if (typeof Value === 'number') return Number.isFinite(Value) ? Value : null;
  if (typeof Value === 'string' && NUMBER_RE.test(Value.trim())) return Number(Value.trim());
  return null;
}

function PrimBool(Value: unknown): boolean | null {
  if (typeof Value === 'boolean') return Value;
  if (typeof Value === 'number') return Value !== 0;
  return null;
}

// A control Value as reported, or undefined when it is not a primitive.
function PrimValue(Value: unknown): string | number | boolean | undefined {
  return typeof Value === 'string' || typeof Value === 'number' || typeof Value === 'boolean'
    ? Value
    : undefined;
}

function ParseError(Value: unknown): QrcError {
  const Obj = Value && typeof Value === 'object' ? (Value as Record<string, unknown>) : {};
  const Code = PrimNumber(Obj.code);
  const HasCode = Code != null;
  const Message =
    typeof Obj.message === 'string' && Obj.message.trim()
      ? Obj.message.trim()
      : HasCode && ERROR_MESSAGES[Code]
        ? ERROR_MESSAGES[Code]
        : 'Error';
  return { Code, Message };
}

function DescribeError(Err: QrcError): string {
  return Err.Code == null ? Err.Message : `${Err.Message} (${Err.Code})`;
}

const STATUS_LABELS: Record<number, string> = {
  0: 'OK',
  1: 'Compromised',
  2: 'Fault',
  3: 'Unknown',
  4: 'Missing',
  5: 'Initializing',
};

function StatusLabel(Code: number | null): string {
  if (Code == null) return 'Unknown';
  return STATUS_LABELS[Code] || `Code ${Code}`;
}

export interface CoreStatus {
  Platform: string | null;
  State: string | null;
  DesignName: string | null;
  DesignCode: string | null;
  IsRedundant: boolean | null;
  IsEmulator: boolean | null;
  StatusCode: number | null;
  StatusString: string | null;
}

// Read a StatusGet result (or EngineStatus params, which carry the same fields
// minus Platform and Status). Null when it is not shaped like either.
function ParseCoreStatus(Value: unknown): CoreStatus | null {
  if (!Value || typeof Value !== 'object' || Array.isArray(Value)) return null;
  const Obj = Value as Record<string, unknown>;
  if (typeof Obj.State !== 'string' && typeof Obj.Platform !== 'string') return null;
  const Status =
    Obj.Status && typeof Obj.Status === 'object' ? (Obj.Status as Record<string, unknown>) : null;
  return {
    Platform: PrimString(Obj.Platform),
    State: PrimString(Obj.State),
    DesignName: PrimString(Obj.DesignName),
    DesignCode: PrimString(Obj.DesignCode),
    IsRedundant: PrimBool(Obj.IsRedundant),
    IsEmulator: PrimBool(Obj.IsEmulator),
    StatusCode: Status ? PrimNumber(Status.Code) : null,
    StatusString: Status ? PrimString(Status.String) : null,
  };
}

export interface ControlReading {
  Name: string;
  Found: boolean;
  Value?: string | number | boolean;
  String?: string | null;
  // Why the control could not be read (e.g. "Unknown control (8)").
  Error?: string;
}

// Map a Control.Get result array back onto the requested names. A requested
// name the Core left out of its answer is "not found" rather than silently
// passing.
function ParseControlResult(Names: string[], Result: unknown): ControlReading[] {
  const ByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(Result)) {
    for (const Entry of Result) {
      if (
        Entry &&
        typeof Entry === 'object' &&
        typeof (Entry as { Name?: unknown }).Name === 'string'
      ) {
        ByName.set((Entry as { Name: string }).Name, Entry as Record<string, unknown>);
      }
    }
  }
  return Names.map((Name) => {
    const Entry = ByName.get(Name);
    if (!Entry) return { Name, Found: false, Error: 'Not returned by the Core' };
    return {
      Name,
      Found: true,
      Value: PrimValue(Entry.Value),
      String: typeof Entry.String === 'string' ? Entry.String : null,
    };
  });
}

// Expected values that mean a boolean state. A toggle such as a mute reports
// its Value as JSON true/false in the QRC examples but as 0/1 from many Cores,
// with a String of "muted" / "unmuted", so `MainMute=false` must match all of
// false, 0 and 0.0.
const TRUE_WORDS = new Set(['true', 'on', 'yes']);
const FALSE_WORDS = new Set(['false', 'off', 'no']);

function ExpectedBool(Want: string): boolean | null {
  const Lower = Want.toLowerCase();
  if (TRUE_WORDS.has(Lower)) return true;
  if (FALSE_WORDS.has(Lower)) return false;
  return null;
}

// Does one reported representation equal the expectation? Booleans and the
// boolean words compare by truth (a number is true when non-zero), numbers
// compare numerically (Q-SYS reports gains as floats such as -5.9999995), and
// everything else as trimmed, case-insensitive text.
function OneMatches(
  Expected: string,
  Actual: string | number | boolean | null | undefined
): boolean {
  if (Actual == null) return false;
  const Want = Expected.trim();
  if (typeof Actual === 'boolean') {
    const Lower = Want.toLowerCase();
    if (Lower === '1') return Actual;
    if (Lower === '0') return !Actual;
    const Bool = ExpectedBool(Want);
    return Bool != null && Bool === Actual;
  }
  if (typeof Actual === 'number') {
    // Only the words get truth semantics; "1" / "0" stay numeric so a gain of
    // 0.5 never passes for MainGain=1.
    const Bool = ExpectedBool(Want);
    if (Bool != null) return Bool === (Actual !== 0);
  }
  const Got = String(Actual).trim();
  if (NUMBER_RE.test(Want) && NUMBER_RE.test(Got)) {
    const A = Number(Want);
    const B = Number(Got);
    return Math.abs(A - B) <= 1e-4 * Math.max(1, Math.abs(A), Math.abs(B));
  }
  return Want.toLowerCase() === Got.toLowerCase();
}

// The control's String is what an operator sees on the Core ("-6.0dB",
// "muted"); its Value is the raw number/boolean. Either matching passes, so
// MainMute=true and MainGain=-6 work as naturally as MainGain=-6.0dB.
function ControlMatches(Expected: string, Reading: ControlReading): boolean {
  if (!Reading.Found) return false;
  if (Reading.String != null && OneMatches(Expected, Reading.String)) return true;
  return OneMatches(Expected, Reading.Value);
}

function DescribeReading(Reading: ControlReading): string {
  if (Reading.String != null && Reading.String !== '') return Reading.String;
  if (Reading.Value === undefined) return '—';
  return String(Reading.Value);
}

// --- One-connection probe ------------------------------------------------------

export type LogonState = 'not-attempted' | 'ok' | 'rejected';

export interface CoreSnapshot {
  // A JSON-RPC answer or notification proved this is a Q-SYS Core.
  IsQsys: boolean;
  Status: CoreStatus | null;
  // Where Status came from: the StatusGet reply, or (when that never arrived)
  // the unsolicited EngineStatus notification.
  StatusSource: 'StatusGet' | 'EngineStatus' | null;
  LogonState: LogonState;
  LogonError: string | null;
  StatusGetError: string | null;
  Controls: ControlReading[] | null;
  // Why the controls were not read (Standby/Idle Core), for the debug panel.
  ControlsSkipped: string | null;
  // A stage that did not finish inside the budget, as a human reason.
  Incomplete: string | null;
}

export type CoreProbe =
  | { Reachable: false; Error: string; Refused: boolean }
  | { Reachable: true; LatencyMs: number; Snapshot: CoreSnapshot };

type RpcReply = { Result: unknown } | { Error: QrcError };

class SessionEnded extends Error {}

function QueryCore(Config: QsysConfig, ControlNames: string[]): Promise<CoreProbe> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Snapshot: CoreSnapshot = {
    IsQsys: false,
    Status: null,
    StatusSource: null,
    LogonState: 'not-attempted',
    LogonError: null,
    StatusGetError: null,
    Controls: null,
    ControlsSkipped: null,
    Incomplete: null,
  };
  let Buffer0 = '';
  let BytesSeen = 0;
  let Stage = 'connect';
  let NextId = 1;
  const Pending = new Map<number, (Reply: RpcReply) => void>();
  const Failers = new Set<(Err: Error) => void>();

  const Reached = (Session: TcpSession<CoreProbe>): CoreProbe => ({
    Reachable: true,
    LatencyMs: Date.now() - Session.StartedAt,
    Snapshot,
  });

  // Ending early (timeout / close): reachable if the Core said anything at all.
  const Unfinished = (Session: TcpSession<CoreProbe>, NoReplyError: string): CoreProbe => {
    if (!BytesSeen) return { Reachable: false, Error: NoReplyError, Refused: false };
    if (Snapshot.IsQsys) Snapshot.Incomplete = `The Core did not finish ${Stage} in time`;
    return Reached(Session);
  };

  const HandleFrame = (Frame: string): void => {
    let Msg: unknown;
    try {
      Msg = JSON.parse(Frame);
    } catch {
      return; // junk between frames; a non-Core answer stays IsQsys = false
    }
    if (!Msg || typeof Msg !== 'object' || Array.isArray(Msg)) return;
    const Obj = Msg as Record<string, unknown>;
    if (Obj.method === 'EngineStatus') {
      const Parsed = ParseCoreStatus(Obj.params);
      if (Parsed) {
        Snapshot.IsQsys = true;
        // Keep it only as a fallback: StatusGet also carries Platform and Status.
        if (Snapshot.StatusSource !== 'StatusGet') {
          Snapshot.Status = Parsed;
          Snapshot.StatusSource = 'EngineStatus';
        }
      }
      return;
    }
    const Id = PrimNumber(Obj.id);
    const Resolve = Id != null ? Pending.get(Id) : undefined;
    if (Id == null || !Resolve) return;
    Pending.delete(Id);
    Resolve(
      'error' in Obj && Obj.error != null
        ? { Error: ParseError(Obj.error) }
        : { Result: Obj.result }
    );
  };

  return RunTcpSession<CoreProbe>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnSettle: () => {
      for (const Fail of Failers) Fail(new SessionEnded('session ended'));
      Failers.clear();
      Pending.clear();
    },
    OnData: (Chunk, Session) => {
      BytesSeen += Chunk.length;
      Buffer0 += Chunk.toString('utf8');
      if (Buffer0.length > MAX_BUFFERED_CHARS) {
        Session.Finish(Reached(Session));
        return;
      }
      const { Frames, Rest } = SplitFrames(Buffer0);
      Buffer0 = Rest;
      for (const Frame of Frames) HandleFrame(Frame);
    },
    OnTimeout: (Session) => Unfinished(Session, `No reply from the Q-SYS Core after ${BudgetMs}ms`),
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => Unfinished(Session, 'Connection closed before any reply'),
    OnConnect: (Session) => {
      const Call = (Method: string, Params: unknown): Promise<RpcReply> =>
        new Promise<RpcReply>((Resolve, Reject) => {
          const Id = NextId++;
          const Fail = (Err: Error) => Reject(Err);
          Failers.add(Fail);
          Pending.set(Id, (Reply) => {
            Failers.delete(Fail);
            Resolve(Reply);
          });
          try {
            Session.Socket.write(
              JSON.stringify({ jsonrpc: '2.0', id: Id, method: Method, params: Params }) + '\0'
            );
          } catch (Err) {
            Failers.delete(Fail);
            Pending.delete(Id);
            Reject(Err instanceof Error ? Err : new Error(String(Err)));
          }
        });

      void (async () => {
        try {
          if (Config.User) {
            Stage = 'logon';
            const Reply = await Call('Logon', { User: Config.User, Password: Config.Password });
            Snapshot.IsQsys = true;
            if ('Error' in Reply) {
              Snapshot.LogonState = 'rejected';
              Snapshot.LogonError = DescribeError(Reply.Error);
            } else {
              Snapshot.LogonState = 'ok';
            }
          }

          Stage = 'StatusGet';
          const StatusReply = await Call('StatusGet', 0);
          if ('Error' in StatusReply) {
            // Logon required / Standby are Q-SYS's own codes; method-not-found
            // from some other JSON-RPC server is not a Core.
            const Code = StatusReply.Error.Code;
            if (Code === 10 || Code === -32604) Snapshot.IsQsys = true;
            Snapshot.StatusGetError = DescribeError(StatusReply.Error);
          } else {
            const Parsed = ParseCoreStatus(StatusReply.Result);
            if (Parsed) {
              Snapshot.IsQsys = true;
              Snapshot.Status = Parsed;
              Snapshot.StatusSource = 'StatusGet';
            }
          }

          if (ControlNames.length && Snapshot.IsQsys) {
            const State = Snapshot.Status ? Snapshot.Status.State : null;
            if (!Snapshot.Status) {
              Snapshot.ControlsSkipped = 'Core status unknown';
            } else if (State !== 'Active') {
              Snapshot.ControlsSkipped = `Core is ${State || 'not Active'}`;
            } else {
              Stage = 'Control.Get';
              const Batch = await Call('Control.Get', ControlNames);
              if (!('Error' in Batch)) {
                Snapshot.Controls = ParseControlResult(ControlNames, Batch.Result);
              } else {
                // One unknown name fails the whole batch, so ask one at a time
                // to say WHICH control is missing.
                const Readings: ControlReading[] = [];
                for (const Name of ControlNames) {
                  const One = await Call('Control.Get', [Name]);
                  if ('Error' in One) {
                    Readings.push({ Name, Found: false, Error: DescribeError(One.Error) });
                  } else {
                    Readings.push(...ParseControlResult([Name], One.Result));
                  }
                }
                Snapshot.Controls = Readings;
              }
            }
          }
          Session.Finish(Reached(Session));
        } catch (Err) {
          if (Err instanceof SessionEnded) return; // already settled by timeout/close
          Session.Finish({
            Reachable: false,
            Error: Err instanceof Error ? Err.message : String(Err),
            Refused: false,
          });
        }
      })();
    },
  });
}

// --- Evaluation ----------------------------------------------------------------

// The reasons a reachable Core is unhealthy, per the enabled options. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: CoreSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsQsys) return ['Responded, but not as a Q-SYS Core (QRC)'];

  const Reasons: string[] = [];
  // A Core answers a bad PIN with error 10 "Logon required", the same code a
  // missing logon gets, so the two cases are told apart by whether one was sent.
  const LogonRejected = Snapshot.LogonState === 'rejected';
  if (LogonRejected) Reasons.push('Logon rejected (check the user and PIN)');
  if (Snapshot.StatusGetError) {
    const NeedsLogon = /logon required/i.test(Snapshot.StatusGetError);
    if (!NeedsLogon) Reasons.push(`StatusGet failed: ${Snapshot.StatusGetError}`);
    else if (!LogonRejected) Reasons.push('Logon required: set a user and PIN');
  }
  if (Snapshot.Incomplete) Reasons.push(Snapshot.Incomplete);

  const Status = Snapshot.Status;
  if (Status) {
    // EngineStatus carries no Status object, so the code is only judged when
    // StatusGet itself answered.
    if (Options.CheckStatus && Status.StatusCode != null && Status.StatusCode !== 0) {
      const Label = StatusLabel(Status.StatusCode);
      const Text = (Status.StatusString || '').trim();
      Reasons.push(
        Text && Text.toLowerCase() !== Label.toLowerCase()
          ? `Core status ${Label}: ${Text}`
          : `Core status ${Label}`
      );
    }
    if (Options.RequireActive && Status.State != null && Status.State !== 'Active') {
      Reasons.push(
        Status.State === 'Idle'
          ? 'Core is Idle (no design running)'
          : `Core is ${Status.State} (not Active)`
      );
    }
    if (Options.CheckDesign) {
      const Design = (Status.DesignName || '').trim();
      if (!Design) {
        Reasons.push('No design running');
      } else if (
        Options.ExpectedDesign &&
        Design.toLowerCase() !== Options.ExpectedDesign.toLowerCase()
      ) {
        Reasons.push(`Design "${Design}" (expected "${Options.ExpectedDesign}")`);
      }
    }
  }

  if (Options.CheckControls) {
    for (const Entry of Options.InvalidAssertions) {
      Reasons.push(`Invalid control assertion "${Entry}" (use Name=Value)`);
    }
    for (const Reading of Snapshot.Controls || []) {
      const Assertion = Options.Assertions.find((A) => A.Name === Reading.Name);
      if (!Assertion) continue;
      if (!Reading.Found) {
        Reasons.push(
          `Control "${Reading.Name}" not found${Reading.Error ? ` (${Reading.Error})` : ''}`
        );
      } else if (!ControlMatches(Assertion.Expected, Reading)) {
        Reasons.push(
          `Control "${Reading.Name}" is ${DescribeReading(Reading)} (expected ${Assertion.Expected})`
        );
      }
    }
  }
  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Options = ParseHealthOptions(Target);
  const Names = Array.from(new Set(Options.Assertions.map((A) => A.Name)));

  const Probe = await QueryCore(Config, Names);
  if (!Probe.Reachable) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }

  const { Snapshot } = Probe;
  const Reasons = EvaluateHealth(Snapshot, Options);
  const Status = Snapshot.Status;
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    IsQsys: Snapshot.IsQsys,
    Platform: Status ? Status.Platform : null,
    State: Status ? Status.State : null,
    DesignName: Status ? Status.DesignName : null,
    DesignCode: Status ? Status.DesignCode : null,
    IsRedundant: Status ? Status.IsRedundant : null,
    IsEmulator: Status ? Status.IsEmulator : null,
    StatusCode: Status ? Status.StatusCode : null,
    StatusString: Status ? Status.StatusString : null,
    StatusSource: Snapshot.StatusSource,
    LogonState: Snapshot.LogonState,
    LogonError: Snapshot.LogonError,
    Controls: Snapshot.Controls,
    ControlsSkipped: Snapshot.ControlsSkipped,
  };
}

// --- Debug panel -----------------------------------------------------------------

const LOGON_LABELS: Record<LogonState, string> = {
  'not-attempted': 'Not attempted',
  ok: 'Logged on',
  rejected: 'Rejected',
};

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatePill = !Reachable
    ? Pill('danger', 'Offline')
    : Degraded
      ? Pill('warning', Result.DegradedReason || 'Degraded')
      : Pill('success', 'Healthy');

  const Head = [
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Row('Status', StatePill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the Core'),
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(`Failed to reach Q-SYS Remote Control on TCP ${Config.Port}`) +
      '</div>'
    );
  }
  if (Result.IsQsys === false) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note('The device answered, but not as a Q-SYS Core') +
      '</div>'
    );
  }

  const Code = Result.StatusCode == null ? null : Number(Result.StatusCode);
  const StatusText =
    Code == null
      ? null
      : `${StatusLabel(Code)}${Result.StatusString ? ` — ${String(Result.StatusString)}` : ''}`;
  const Flags: string[] = [];
  if (Result.IsRedundant === true) Flags.push('Redundant');
  if (Result.IsEmulator === true) Flags.push('Emulator');

  const Body = [
    ...Head,
    Result.Platform != null && Result.Platform !== ''
      ? TextRow('Platform', String(Result.Platform))
      : null,
    Result.State != null
      ? Row('State', Pill(Result.State === 'Active' ? 'success' : 'warning', String(Result.State)))
      : null,
    StatusText != null
      ? Row('Core status', Pill(Code === 0 ? 'success' : 'warning', StatusText))
      : null,
    Result.DesignName != null
      ? TextRow(
          'Design',
          (String(Result.DesignName) || '(none)') +
            (Options.CheckDesign && Options.ExpectedDesign
              ? ` (expected "${Options.ExpectedDesign}")`
              : '')
        )
      : null,
    Result.DesignCode ? TextRow('Design code', String(Result.DesignCode)) : null,
    Flags.length ? TextRow('Mode', Flags.join(' · ')) : null,
    Result.LogonState && Result.LogonState !== 'not-attempted'
      ? TextRow(
          'Logon',
          (LOGON_LABELS[Result.LogonState as LogonState] || String(Result.LogonState)) +
            (Result.LogonError ? ` — ${String(Result.LogonError)}` : '')
        )
      : null,
    Result.StatusSource === 'EngineStatus'
      ? TextRow('Source', 'EngineStatus notification (StatusGet not answered)')
      : null,
  ];

  let ControlsHtml = '';
  if (Options.CheckControls && Options.Assertions.length) {
    const Readings = Array.isArray(Result.Controls) ? (Result.Controls as ControlReading[]) : null;
    if (!Readings) {
      ControlsHtml = Note(
        Result.ControlsSkipped
          ? `Named Controls not read: ${String(Result.ControlsSkipped)}`
          : 'Named Controls not read'
      );
    } else {
      ControlsHtml = Readings.map((Reading) => {
        const Assertion = Options.Assertions.find((A) => A.Name === Reading.Name);
        const Ok = !!Assertion && ControlMatches(Assertion.Expected, Reading);
        const Badge = !Reading.Found
          ? Pill('danger', 'Not found')
          : Ok
            ? Pill('success', DescribeReading(Reading))
            : Pill('warning', DescribeReading(Reading));
        const Detail = Reading.Found
          ? `Expected ${Assertion ? Assertion.Expected : '—'} · value ${Reading.Value === undefined ? '—' : String(Reading.Value)}`
          : Reading.Error || 'Not found';
        return Card({
          Title: Reading.Name,
          TitleClass: 'font-monospace',
          Badge,
          Highlight: Ok,
          BodyHtml: `<div class="text-muted small text-break">${Esc(Detail)}</div>`,
        });
      }).join('');
    }
    ControlsHtml = `<div class="mt-2 d-grid gap-1">${ControlsHtml}</div>`;
  }

  return Rows(Body) + ControlsHtml;
}

export const Name = 'Q-SYS Core';
export const Description =
  'Connects to a Q-SYS Core over Q-SYS Remote Control (QRC, TCP 1710) and reads its status, state, running design and redundancy flags — read-only. Reports Degraded when the Core status is not OK or the Core is not Active, and optionally when the design or listed Named Controls are not as expected.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseControlAssertions,
  SplitFrames,
  ParseError,
  ParseCoreStatus,
  ParseControlResult,
  OneMatches,
  ControlMatches,
  StatusLabel,
  EvaluateHealth,
  QueryCore,
};
export { ID, Settings, Run, Debug };
