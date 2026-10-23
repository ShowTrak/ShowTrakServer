// Symetrix Composer DSP health (Radius NX, Edge, Prism, Solus NX, xControl and
// other Composer units) over the Composer Control Protocol: plain text on TCP
// 48631, every command and reply ending in a carriage return. One short-lived
// session per probe, one command in flight at a time:
//
//   1. `$q NOP`      → `ACK`. Documented as "a simple check of whether a system
//                      is up and running and responding to commands"; it is
//                      also what proves the port is a Symetrix control port.
//   2. `$v V`        → the multi-line version report ("Firmware Version: V2.000",
//                      "Build Date: …", …), followed by a second `$q NOP` whose
//                      ACK marks the end of that report. The report has no
//                      documented terminator, so bracketing it with a NOP is
//                      this probe's own device (inferred from "one response per
//                      command, in order"), not a documented framing rule. The
//                      report's last line ends in a `>` prompt with no line end,
//                      so that ACK may arrive as "…>ACK" on the same line.
//   3. `$q GPR`      → the last preset loaded, four digits (0000 = none).
//   4. `$q GS2 <n>`  → `<n> <value>` for each listed control number, only when
//                      control assertions are enabled. NAK means the control
//                      number does not exist in the running site file.
//
// The `$q` / `$v` prefixes force quiet / verbose output for that one command,
// whatever the port's saved Quiet Mode, so replies have a known shape. Echo
// Mode (off by default) is tolerated by skipping a line identical to the
// command just sent. Pushed data (`#00007=12321`, sent to every open TCP
// session for push-enabled controls) is ignored wherever it lands.
//
// The protocol has no fault, alarm or status command. What a unit can report
// about its own health it reports through control numbers: Composer's
// diagnostics panels (power supply and thermal Status LEDs, 0 = OK, 65535 =
// Failed; Connected LEDs, 65535 = connected) can be given control numbers and
// asserted here like any other control.
//
// Everything the check sends is a read (NOP, V, GPR, GS2); nothing in Run()
// changes the unit. The operator actions (load preset, set control) are
// separate presses, each on its own session; see Controllable actions below.
// The unit allows six TCP sessions and closes the least recently used one when
// a seventh connects, so this probe's short session can displace an idle
// control system's connection on a unit that already has six. Every session
// here is closed the moment it settles, by any path (see RunTcpSession).
import { ReplyQueue, RunTcpSession, type TcpSession } from './_tcp-session';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'symetrix-dsp';
const DEFAULT_PORT = 48631;
const DEFAULT_TIMEOUT_MS = 4000;
// The version report is about a kilobyte; anything this large is not a unit.
const MAX_BUFFERED_CHARS = 200_000;
const MAX_CONTROL_NUMBER = 10000;
const MAX_CONTROL_VALUE = 65535;
const MAX_PRESET = 1000;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Control port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'Symetrix units accept control commands on TCP 48631.',
  },
  {
    Key: 'CheckPreset',
    Label: 'Check last preset',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the last preset loaded is not the expected one.',
  },
  {
    Key: 'ExpectedPreset',
    Label: 'Expected preset number',
    Type: 'number',
    Default: 1,
    Min: 1,
    Max: MAX_PRESET,
    VisibleWhen: { Key: 'CheckPreset', Equals: true },
    Note: 'The preset number as shown in Composer. A unit that has not loaded a preset since it started reports none.',
  },
  {
    Key: 'CheckControls',
    Label: 'Check control numbers',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when a listed control number does not hold its expected value, or does not exist in the site file.',
  },
  {
    Key: 'ControlAssertions',
    Label: 'Control assertions',
    Type: 'list',
    ItemType: 'string',
    Default: [],
    VisibleWhen: { Key: 'CheckControls', Equals: true },
    Note: 'One per entry: control number, a comparison (=, <, >, <= or >=) and a value from 0 to 65535, e.g. 101=0 or 205>=30000. On and off also work with =, e.g. 12=off. Control values are always 0 to 65535: a button reads 0 or 65535.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole session: connect and every read.',
  },
];

// --- Options -----------------------------------------------------------------

export type Comparison = '=' | '<' | '>' | '<=' | '>=';

export interface ControlAssertion {
  // The entry as written, for messages.
  Label: string;
  Number: number;
  Op: Comparison;
  // 'on' / 'off' compare by state (non-zero / zero); otherwise a number.
  Expected: number | 'on' | 'off';
}

interface SymetrixConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckPreset: boolean;
  ExpectedPreset: number;
  CheckControls: boolean;
  Assertions: ControlAssertion[];
  // Entries that could not be read as an assertion; reported, never sent.
  InvalidAssertions: string[];
}

function ParseConfig(Target: MonitoringTargetLike): SymetrixConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Timeout : DEFAULT_TIMEOUT_MS,
  };
}

const ASSERTION_RE = /^(\d+)\s*(<=|>=|=|<|>)\s*(\S+)$/;

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
    const Match = ASSERTION_RE.exec(Entry);
    const Number_ = Match ? Number(Match[1]) : NaN;
    const Op = (Match ? Match[2] : '=') as Comparison;
    const Word = Match ? (Match[3] as string).toLowerCase() : '';
    let Expected: ControlAssertion['Expected'] | null = null;
    if (Word === 'on' || Word === 'true') Expected = 'on';
    else if (Word === 'off' || Word === 'false') Expected = 'off';
    else if (/^\d+$/.test(Word) && Number(Word) <= MAX_CONTROL_VALUE) Expected = Number(Word);
    const Valid =
      Number_ >= 1 &&
      Number_ <= MAX_CONTROL_NUMBER &&
      Expected != null &&
      (typeof Expected === 'number' || Op === '=');
    if (!Valid || Expected == null) {
      Invalid.push(Entry);
      continue;
    }
    Assertions.push({ Label: Entry.replace(/\s+/g, ''), Number: Number_, Op, Expected });
  }
  return { Assertions, Invalid };
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const CheckControls = Cfg.CheckControls === true;
  const Parsed = CheckControls
    ? ParseControlAssertions(Cfg.ControlAssertions)
    : { Assertions: [], Invalid: [] };
  const Preset = Number(Cfg.ExpectedPreset);
  return {
    CheckPreset: Cfg.CheckPreset === true,
    ExpectedPreset:
      Number.isFinite(Preset) && Preset >= 1 && Preset <= MAX_PRESET ? Math.trunc(Preset) : 1,
    CheckControls,
    Assertions: Parsed.Assertions,
    InvalidAssertions: Parsed.Invalid,
  };
}

// --- Pure protocol helpers -----------------------------------------------------

const LINE_END_RE = /\r\n|\r|\n/g;

// A received line without its surrounding whitespace or `>` prompt marks.
// Verbose output is framed by `>` with no line end after it (the V example on
// the Setup Commands page ends "TCP/IP instance #1 of 4 >", the $v SSYSS
// example reads ">Set System String … succeeded>"), so a `>` can be left at
// either end of the next line. Tolerated rather than documented as framing.
function CleanLine(Line: string): string {
  return Line.trim()
    .replace(/^>+\s*/, '')
    .replace(/\s*>+$/, '');
}

/**
 * A predicate for ReplyQueue: how many leading characters end with the first
 * line that answers Sent — skipping blank lines, pushed data (`#…`) and an echo
 * of Sent itself. Null while no such line has arrived.
 */
function ReplyTo(Sent: string): (Buffered: string) => number | null {
  return (Buffered) => {
    const Re = new RegExp(LINE_END_RE.source, 'g');
    let Start = 0;
    let Match: RegExpExecArray | null;
    while ((Match = Re.exec(Buffered))) {
      const Line = CleanLine(Buffered.slice(Start, Match.index));
      Start = Match.index + Match[0].length;
      if (Line && !Line.startsWith('#') && Line !== Sent) return Start;
    }
    return null;
  };
}

// Everything up to and including the closing NOP's ACK. The report's last line
// ends in a `>` prompt with no line end, so that ACK can arrive glued to it
// ("… TCP/IP instance #1 of 4 >ACK"): a line that is ACK, or ends in `>ACK`.
const ACK_LINE_RE = /(?:^|>)\s*ACK$/i;

function UpToAck(Buffered: string): number | null {
  const Re = new RegExp(LINE_END_RE.source, 'g');
  let Start = 0;
  let Match: RegExpExecArray | null;
  while ((Match = Re.exec(Buffered))) {
    const Line = Buffered.slice(Start, Match.index).trim();
    Start = Match.index + Match[0].length;
    if (ACK_LINE_RE.test(Line)) return Start;
  }
  return null;
}

// The meaningful lines of a consumed reply: cleaned, no blanks, no pushes,
// no echo of Sent.
function ReplyLines(Consumed: string, Sent: string): string[] {
  return Consumed.split(LINE_END_RE)
    .map(CleanLine)
    .filter((L) => L && !L.startsWith('#') && L !== Sent);
}

// The version report's lines out of everything up to the closing ACK: the
// echoes, the ACK itself and a `>ACK` glued to the last line all removed.
function VersionReportLines(Consumed: string): string[] {
  return Consumed.split(LINE_END_RE)
    .map((L) => CleanLine(L.trim().replace(/\s*>\s*ACK$/i, '')))
    .filter((L) => L && !L.startsWith('#') && L !== '$v V' && L !== '$q NOP' && L !== 'ACK');
}

export interface VersionLine {
  Key: string;
  Value: string;
}

// `Key: Value` lines of the version report. The first "Firmware Version"
// line is the unit's firmware.
function ParseVersionReport(Lines: string[]): VersionLine[] {
  const Out: VersionLine[] = [];
  for (const Line of Lines) {
    const Match = /^([A-Za-z][A-Za-z0-9 /.-]*?)\s*:\s*(.+)$/.exec(Line);
    if (!Match) continue;
    const Value = (Match[2] as string).replace(/\s*>\s*$/, '').trim();
    if (Value) Out.push({ Key: (Match[1] as string).trim(), Value });
  }
  return Out;
}

// GPR: four digits, 0000 = no preset recalled. Null for anything else.
function ParsePreset(Line: string): number | null {
  const Trimmed = Line.trim();
  return /^\d{1,4}$/.test(Trimmed) ? Number(Trimmed) : null;
}

// GS2: `<control number> <value>`, possibly zero-padded. Null for anything else.
function ParseGs2(Line: string): { Number: number; Value: number } | null {
  const Match = /^(\d+)\s+(-?\d+)$/.exec(Line.trim());
  if (!Match) return null;
  return { Number: Number(Match[1]), Value: Number(Match[2]) };
}

export interface ControlReading {
  Number: number;
  Found: boolean;
  Value?: number;
  // Why the control could not be read.
  Error?: string;
}

function ControlMatches(Assertion: ControlAssertion, Value: number | undefined): boolean {
  if (Value == null || !Number.isFinite(Value)) return false;
  const Want = Assertion.Expected;
  if (Want === 'on') return Value !== 0;
  if (Want === 'off') return Value === 0;
  switch (Assertion.Op) {
    case '<':
      return Value < Want;
    case '>':
      return Value > Want;
    case '<=':
      return Value <= Want;
    case '>=':
      return Value >= Want;
    default:
      return Value === Want;
  }
}

function DescribeExpected(Assertion: ControlAssertion): string {
  return Assertion.Op === '='
    ? String(Assertion.Expected)
    : `${Assertion.Op} ${Assertion.Expected}`;
}

// --- One-connection probe --------------------------------------------------------

export interface SymetrixSnapshot {
  // The unit answered NOP with ACK (or NAK): a Symetrix control port.
  IsSymetrix: boolean;
  // What came back instead, when IsSymetrix is false.
  UnexpectedReply: string | null;
  Version: VersionLine[];
  Firmware: string | null;
  // Last preset loaded; 0 = none since start-up; null = not read.
  LastPreset: number | null;
  PresetError: string | null;
  Controls: ControlReading[] | null;
  // A stage that did not finish inside the budget, as a human reason.
  Incomplete: string | null;
}

export type SymetrixProbe =
  | { Reachable: false; Error: string; Refused: boolean }
  | { Reachable: true; LatencyMs: number; Snapshot: SymetrixSnapshot };

class SessionEnded extends Error {}

function QueryUnit(Config: SymetrixConfig, Numbers: number[]): Promise<SymetrixProbe> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Snapshot: SymetrixSnapshot = {
    IsSymetrix: false,
    UnexpectedReply: null,
    Version: [],
    Firmware: null,
    LastPreset: null,
    PresetError: null,
    Controls: null,
    Incomplete: null,
  };
  const Queue = new ReplyQueue(MAX_BUFFERED_CHARS);
  let BytesSeen = 0;
  let Stage = 'the NOP check';

  const Reached = (Session: TcpSession<SymetrixProbe>): SymetrixProbe => ({
    Reachable: true,
    LatencyMs: Date.now() - Session.StartedAt,
    Snapshot,
  });

  // Ending early (timeout / close): reachable if the unit said anything at all.
  const Unfinished = (Session: TcpSession<SymetrixProbe>, NoReplyError: string): SymetrixProbe => {
    if (!BytesSeen) return { Reachable: false, Error: NoReplyError, Refused: false };
    if (Snapshot.IsSymetrix) Snapshot.Incomplete = `The unit did not finish ${Stage} in time`;
    return Reached(Session);
  };

  const Send = (Session: TcpSession<SymetrixProbe>, Command: string): void => {
    Session.Socket.write(`${Command}\r`);
  };

  // One command, one reply line.
  const Call = async (Session: TcpSession<SymetrixProbe>, Command: string): Promise<string> => {
    Send(Session, Command);
    const Consumed = await Queue.Next(ReplyTo(Command));
    const Lines = ReplyLines(Consumed, Command);
    return Lines[Lines.length - 1] || '';
  };

  return RunTcpSession<SymetrixProbe>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnSettle: () => Queue.FailPending(new SessionEnded('session ended')),
    OnData: (Chunk, Session) => {
      BytesSeen += Chunk.length;
      // Replies are ASCII; latin1 keeps one character per byte whatever arrives.
      if (!Queue.Feed(Chunk.toString('latin1').replace(/\0/g, ''))) {
        Session.Finish(Reached(Session));
      }
    },
    OnTimeout: (Session) =>
      Unfinished(Session, `No reply from the Symetrix unit after ${BudgetMs}ms`),
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => Unfinished(Session, 'Connection closed before any reply'),
    OnConnect: (Session) => {
      void (async () => {
        try {
          const Nop = await Call(Session, '$q NOP');
          const Upper = Nop.toUpperCase();
          if (Upper !== 'ACK' && Upper !== 'NAK') {
            Snapshot.UnexpectedReply = Nop.slice(0, 120);
            Session.Finish(Reached(Session));
            return;
          }
          Snapshot.IsSymetrix = true;

          Stage = 'the version report';
          Send(Session, '$v V');
          Send(Session, '$q NOP');
          const Report = await Queue.Next(UpToAck);
          Snapshot.Version = ParseVersionReport(VersionReportLines(Report));
          const Firmware = Snapshot.Version.find((V) => /^firmware version$/i.test(V.Key));
          Snapshot.Firmware = Firmware ? Firmware.Value : null;

          Stage = 'the preset read';
          const Preset = await Call(Session, '$q GPR');
          Snapshot.LastPreset = ParsePreset(Preset);
          if (Snapshot.LastPreset == null) Snapshot.PresetError = Preset || 'No answer';

          if (Numbers.length) {
            Stage = 'the control reads';
            const Readings: ControlReading[] = [];
            for (const Number_ of Numbers) {
              const Reply = await Call(Session, `$q GS2 ${Number_}`);
              const Parsed = ParseGs2(Reply);
              if (Parsed && Parsed.Number === Number_ && Parsed.Value >= 0) {
                Readings.push({ Number: Number_, Found: true, Value: Parsed.Value });
              } else {
                Readings.push({
                  Number: Number_,
                  Found: false,
                  Error:
                    Reply.toUpperCase() === 'NAK'
                      ? 'Not in the site file'
                      : `Unexpected reply "${Reply.slice(0, 60)}"`,
                });
              }
            }
            Snapshot.Controls = Readings;
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

// --- Evaluation ----------------------------------------------------------------------

// The reasons a reachable unit is unhealthy, per the enabled options. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: SymetrixSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsSymetrix) return ['Responded, but not as a Symetrix control port'];

  const Reasons: string[] = [];
  if (Snapshot.Incomplete) Reasons.push(Snapshot.Incomplete);

  if (Options.CheckPreset) {
    if (Snapshot.LastPreset == null) {
      // A session cut short before GPR already says so through Incomplete.
      if (!Snapshot.Incomplete)
        Reasons.push(
          `Last preset unavailable${Snapshot.PresetError ? ` (${Snapshot.PresetError})` : ''}`
        );
    } else if (Snapshot.LastPreset === 0) {
      Reasons.push(`No preset loaded (expected preset ${Options.ExpectedPreset})`);
    } else if (Snapshot.LastPreset !== Options.ExpectedPreset) {
      Reasons.push(`Preset ${Snapshot.LastPreset} loaded (expected ${Options.ExpectedPreset})`);
    }
  }

  if (Options.CheckControls) {
    for (const Entry of Options.InvalidAssertions) {
      Reasons.push(`Invalid control assertion "${Entry}" (use e.g. 101=0 or 205>=30000)`);
    }
    for (const Assertion of Options.Assertions) {
      const Reading = (Snapshot.Controls || []).find((R) => R.Number === Assertion.Number);
      if (!Reading) continue;
      if (!Reading.Found) {
        Reasons.push(
          `Control ${Assertion.Number} not read${Reading.Error ? ` (${Reading.Error})` : ''}`
        );
      } else if (!ControlMatches(Assertion, Reading.Value)) {
        Reasons.push(
          `Control ${Assertion.Number} is ${Reading.Value} (expected ${DescribeExpected(Assertion)})`
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
  const Numbers = Array.from(new Set(Options.Assertions.map((A) => A.Number)));

  const Probe = await QueryUnit(Config, Numbers);
  if (!Probe.Reachable) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }

  const { Snapshot } = Probe;
  const Reasons = EvaluateHealth(Snapshot, Options);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    IsSymetrix: Snapshot.IsSymetrix,
    UnexpectedReply: Snapshot.UnexpectedReply,
    Firmware: Snapshot.Firmware,
    Version: Snapshot.Version,
    LastPreset: Snapshot.LastPreset,
    PresetError: Snapshot.PresetError,
    Controls: Snapshot.Controls,
  };
}

// --- Controllable actions ------------------------------------------------------------
//
// Each press opens its own short session (same port and budget as the check),
// sends ONE documented command and closes it as soon as the unit answers:
//   $q LP <preset>             (LP) Load Preset, preset 1-1000
//   $q CS <control> <value>    (CS) Control Set, control 1-10000, value 0-65535
// Both answer ACK when accepted and NAK when refused; the docs give an undefined
// preset and a control number not in the site file as the typical refusals.
// CS (not CSQ) is used because CS checks the control exists, so a mistyped
// number is reported rather than silently acknowledged. `$q` forces the quiet
// ACK/NAK reply whatever the port's saved mode.

const Actions: MonitoringActionDef[] = [
  {
    ID: 'preset.load',
    Label: 'Load Preset',
    Icon: 'collection-play',
    Group: 'Presets',
    Destructive: true,
    Params: [
      {
        Key: 'Preset',
        Label: 'Preset number',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'The preset number as shown in Composer, from 1 to 1000.',
      },
    ],
    Note: 'Loads a preset on the unit. The unit refuses a preset that is not defined in its site file.',
  },
  {
    ID: 'control.set',
    Label: 'Set Control',
    Icon: 'sliders',
    Group: 'Controls',
    Destructive: true,
    Params: [
      {
        Key: 'Control',
        Label: 'Control number',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'The control number assigned in Composer, from 1 to 10000.',
      },
      {
        Key: 'Value',
        Label: 'Value',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'The control position, from 0 to 65535. A button is 0 for off and 65535 for on; on and off also work.',
      },
    ],
    Note: 'Moves a control to an absolute position. The unit refuses a control number that is not in its site file.',
  },
];

// Validate an action's parameters and build its one command. Pure — exported
// via _internal for unit tests.
function BuildActionCommand(
  ActionID: string,
  Params: Record<string, unknown>
): { Ok: true; Command: string; Detail: string; Refused: string } | { Ok: false; Error: string } {
  const Text = (Value: unknown) => String(Value == null ? '' : Value).trim();
  if (ActionID === 'preset.load') {
    const Raw = Text(Params.Preset);
    const Preset = /^\d{1,4}$/.test(Raw) ? Number(Raw) : NaN;
    if (!(Preset >= 1 && Preset <= MAX_PRESET)) {
      return { Ok: false, Error: `Preset must be a number from 1 to ${MAX_PRESET}.` };
    }
    return {
      Ok: true,
      Command: `$q LP ${Preset}`,
      Detail: `Preset ${Preset} loaded`,
      Refused: `The unit refused to load preset ${Preset}. Check that it is defined in the site file.`,
    };
  }
  if (ActionID === 'control.set') {
    const RawControl = Text(Params.Control);
    const Control = /^\d{1,5}$/.test(RawControl) ? Number(RawControl) : NaN;
    if (!(Control >= 1 && Control <= MAX_CONTROL_NUMBER)) {
      return {
        Ok: false,
        Error: `Control number must be a number from 1 to ${MAX_CONTROL_NUMBER}.`,
      };
    }
    const RawValue = Text(Params.Value).toLowerCase();
    const Value =
      RawValue === 'on'
        ? MAX_CONTROL_VALUE
        : RawValue === 'off'
          ? 0
          : /^\d{1,5}$/.test(RawValue)
            ? Number(RawValue)
            : NaN;
    if (!(Value >= 0 && Value <= MAX_CONTROL_VALUE)) {
      return {
        Ok: false,
        Error: `Value must be a number from 0 to ${MAX_CONTROL_VALUE}, or on or off.`,
      };
    }
    return {
      Ok: true,
      Command: `$q CS ${Control} ${Value}`,
      Detail: `Control ${Control} set to ${Value}`,
      Refused: `The unit refused control ${Control}. Check that the number is in the site file.`,
    };
  }
  return { Ok: false, Error: `Unknown Symetrix action "${ActionID}"` };
}

// One command on its own session: the reply line, or why there is none. The
// session closes the moment it settles, so a press holds one of the unit's six
// TCP sessions only for the length of one exchange.
function SendUnitCommand(
  Config: SymetrixConfig,
  Command: string
): Promise<{ Ok: true; Reply: string } | { Ok: false; Error: string }> {
  type Outcome = { Ok: true; Reply: string } | { Ok: false; Error: string };
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Queue = new ReplyQueue(MAX_BUFFERED_CHARS);
  let Sent = false;
  const NoAnswer = (): Outcome => ({
    Ok: false,
    Error: Sent
      ? 'The unit did not answer in time. The command may or may not have been applied.'
      : `No reply from the Symetrix unit after ${BudgetMs}ms`,
  });
  return RunTcpSession<Outcome>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnSettle: () => Queue.FailPending(new SessionEnded('session ended')),
    OnData: (Chunk, Session) => {
      if (!Queue.Feed(Chunk.toString('latin1').replace(/\0/g, ''))) {
        Session.Finish({ Ok: false, Error: 'The unit sent an oversized reply' });
      }
    },
    OnTimeout: NoAnswer,
    OnError: (Message) => ({ Ok: false, Error: Message }),
    OnClose: () =>
      Sent
        ? { Ok: false, Error: 'The unit closed the connection before answering' }
        : { Ok: false, Error: 'Connection closed before any reply' },
    OnConnect: (Session) => {
      Session.Socket.write(`${Command}\r`);
      Sent = true;
      Queue.Next(ReplyTo(Command)).then(
        (Consumed) => {
          const Lines = ReplyLines(Consumed, Command);
          Session.Finish({ Ok: true, Reply: Lines[Lines.length - 1] || '' });
        },
        () => {
          // SessionEnded: already settled by timeout, close or error.
        }
      );
    },
  });
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Built = BuildActionCommand(ActionID, Params || {});
  if (!Built.Ok) return { Success: false, Error: Built.Error };

  const Outcome = await SendUnitCommand(Config, Built.Command);
  if (!Outcome.Ok) return { Success: false, Error: Outcome.Error };
  const Reply = Outcome.Reply.toUpperCase();
  if (Reply === 'ACK') return { Success: true, Detail: Built.Detail };
  if (Reply === 'NAK') return { Success: false, Error: Built.Refused };
  return {
    Success: false,
    Error: `Unexpected reply "${Outcome.Reply.slice(0, 60)}". Is this a Symetrix control port?`,
  };
}

// No GetActionOptions: offering the asserted control numbers would turn Set
// Control into a fixed dropdown of just those, and a show programmer needs any
// control number in the site file.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  const Text = (Value: unknown) => String(Value == null ? '' : Value).trim();
  if (ActionID === 'preset.load') {
    const Preset = Text(Params.Preset);
    return Preset ? `Load Preset ${Preset}` : null;
  }
  if (ActionID === 'control.set') {
    const Control = Text(Params.Control);
    const Value = Text(Params.Value);
    if (!Control) return null;
    return Value ? `Set Control ${Control} to ${Value}` : `Set Control ${Control}`;
  }
  return null;
}

// --- Debug panel -----------------------------------------------------------------------

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
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the unit'),
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(`Failed to reach the Symetrix control port on TCP ${Config.Port}`) +
      '</div>'
    );
  }
  if (Result.IsSymetrix === false) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(
        Result.UnexpectedReply
          ? `The device answered "${String(Result.UnexpectedReply)}", not as a Symetrix control port`
          : 'The device answered, but not as a Symetrix control port'
      ) +
      '</div>'
    );
  }

  const Version = Array.isArray(Result.Version) ? (Result.Version as VersionLine[]) : [];
  const Preset = Result.LastPreset == null ? null : Number(Result.LastPreset);
  const PresetText =
    Preset == null
      ? Result.PresetError
        ? `Not read (${String(Result.PresetError)})`
        : 'Not read'
      : Preset === 0
        ? 'None loaded'
        : String(Preset);
  const PresetOk = !Options.CheckPreset || Preset === Options.ExpectedPreset;
  const Body = [
    ...Head,
    Result.Firmware ? TextRow('Firmware', String(Result.Firmware)) : null,
    ...Version.filter((V) => !/^firmware version$/i.test(V.Key))
      .slice(0, 12)
      .map((V) => TextRow(V.Key, V.Value)),
    Options.CheckPreset
      ? Row(
          'Last preset',
          Pill(
            PresetOk ? 'success' : 'warning',
            `${PresetText} (expected ${Options.ExpectedPreset})`
          )
        )
      : TextRow('Last preset', PresetText),
  ];

  let ControlsHtml = '';
  if (Options.CheckControls && Options.Assertions.length) {
    const Readings = Array.isArray(Result.Controls) ? (Result.Controls as ControlReading[]) : null;
    if (!Readings) {
      ControlsHtml = Note('Control numbers not read');
    } else {
      ControlsHtml = Options.Assertions.map((Assertion) => {
        const Reading = Readings.find((R) => R.Number === Assertion.Number);
        const Ok = !!Reading && Reading.Found && ControlMatches(Assertion, Reading.Value);
        const Badge =
          !Reading || !Reading.Found
            ? Pill('danger', 'Not read')
            : Pill(Ok ? 'success' : 'warning', String(Reading.Value));
        const Detail =
          Reading && !Reading.Found
            ? Reading.Error || 'Not read'
            : `Expected ${DescribeExpected(Assertion)}`;
        return Card({
          Title: `Control ${Assertion.Number}`,
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

export const Name = 'Symetrix DSP';
export const Description =
  'Connects to a Symetrix Composer DSP (Radius NX, Edge, Prism, Solus NX) on the Composer Control Protocol (TCP 48631) and confirms it answers commands, reading its firmware version and last loaded preset — read-only. Optionally reports Degraded when the wrong preset is loaded or a listed control number does not hold its expected value, such as a diagnostics status LED.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseControlAssertions,
  ReplyTo,
  UpToAck,
  ParseVersionReport,
  ParsePreset,
  ParseGs2,
  ControlMatches,
  EvaluateHealth,
  QueryUnit,
  BuildActionCommand,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
