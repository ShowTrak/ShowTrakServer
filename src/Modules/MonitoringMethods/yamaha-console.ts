// Yamaha digital mixing console health over Yamaha's Remote Control Protocol
// (RCP, formerly "SCP"): plain ASCII text over TCP 49280, one command per line
// terminated by LF. The console answers each command with one line
// (`OK <command> <args...> <value>` or `ERROR <command> <code>`) and may
// interleave unsolicited `NOTIFY ...` lines (parameter or scene changes made on
// the surface), which are skipped.
//
// One short-lived session per probe, all reads:
//
//   1. `devstatus runmode`:   "normal", or e.g. "booting" / "update" (Yamaha's
//                              RCP specs say the device takes no other commands
//                              in those modes, so the probe stops there).
//   2. `devinfo productname`: e.g. "CL5", "QL1", "TF5", "DM7".
//   3. `devinfo version`:     firmware version.
//   4. `devinfo devicename`:  the name assigned to the device.
//   5. `devstatus error`:     only with CheckAlerts: "none" or an alert.
//   6. `get MIXER:Current/St/Fader/On 0 0` and `... 1 0`: only with
//      CheckMasterMute: the ON key of the first stereo bus, left and right.
//
// Nothing is ever `set`, and the session never changes `scpmode` (encoding /
// keep-alive), so the console's state is untouched. Consoles accept only a few
// RCP clients at once, so the socket closes as soon as the last answer is in.
//
// Wire details come from Yamaha's published RCP specifications for the same
// protocol family (MCP2 and DME7 "Remote Control Protocol Specifications"),
// cross-checked against console traffic in Bitfocus Companion's yamaha-rcp
// module and its per-series parameter dumps. The stereo master address
// `MIXER:Current/St/Fader/On` appears in those dumps for CL/QL, TF, DM3, DM7 and
// RIVAGE PM; any other product is told the check is unsupported rather than
// being sent an address it may not have.
import { StringDecoder } from 'string_decoder';
import { ReplyQueue, RunTcpSession } from './_tcp-session';
import { FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'yamaha-console';
const DEFAULT_PORT = 49280;
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUFFERED_CHARS = 1_000_000;
const MASTER_ADDRESS = 'MIXER:Current/St/Fader/On';
// Index 0 and 1 of the St address are the first stereo bus's left and right
// (CL/QL and TF ship index 0 labelled "ST L").
const MASTER_CHANNELS = [
  { X: 0, Label: 'ST L' },
  { X: 1, Label: 'ST R' },
];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'RCP port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'CheckRunMode',
    Label: 'Check run mode',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded when the console is not in its normal run mode, e.g. booting or updating firmware.',
  },
  {
    Key: 'CheckModel',
    Label: 'Check console model',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the console reports a different product name, e.g. a CL3 where a CL5 is expected.',
  },
  {
    Key: 'ExpectedModel',
    Label: 'Expected model prefix',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckModel', Equals: true },
    Note: 'Matched on a prefix without regard to case, e.g. CL or CL5.',
  },
  {
    Key: 'CheckAlerts',
    Label: 'Check alert status',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded while the console reports a fault, error or warning alert. Degraded with a note on consoles that do not report alerts.',
  },
  {
    Key: 'CheckMasterMute',
    Label: 'Check stereo master is on',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded when the ON key of the first stereo bus (ST L or ST R) is off. Supported on CL, QL, TF, DM3, DM7 and RIVAGE PM.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole session, every query included.',
  },
];

// --- Options -----------------------------------------------------------------

interface YamahaConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckRunMode: boolean;
  CheckModel: boolean;
  ExpectedModel: string;
  CheckAlerts: boolean;
  CheckMasterMute: boolean;
}

function ParseConfig(Target: MonitoringTargetLike): YamahaConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Timeout : DEFAULT_TIMEOUT_MS,
  };
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    // Default ON: absent means enabled, so only an explicit false turns it off.
    CheckRunMode: Cfg.CheckRunMode !== false,
    CheckModel: Cfg.CheckModel === true,
    ExpectedModel: String(Cfg.ExpectedModel == null ? '' : Cfg.ExpectedModel).trim(),
    CheckAlerts: Cfg.CheckAlerts === true,
    CheckMasterMute: Cfg.CheckMasterMute === true,
  };
}

// --- Pure protocol helpers ---------------------------------------------------

export interface RcpToken {
  Value: string;
  Quoted: boolean;
}

// Split one RCP line into tokens. Text values are double-quoted and may contain
// spaces; inside quotes a backslash escapes the next character (\" and \\, per
// Yamaha's spec).
function Tokenize(Line: string): RcpToken[] {
  const Tokens: RcpToken[] = [];
  let I = 0;
  while (I < Line.length) {
    const Ch = Line.charAt(I);
    if (Ch === ' ' || Ch === '\t') {
      I++;
      continue;
    }
    if (Ch === '"') {
      let Value = '';
      I++;
      while (I < Line.length && Line.charAt(I) !== '"') {
        if (Line.charAt(I) === '\\' && I + 1 < Line.length) I++;
        Value += Line.charAt(I);
        I++;
      }
      I++; // closing quote (or end of an unterminated value)
      Tokens.push({ Value, Quoted: true });
      continue;
    }
    let Value = '';
    while (I < Line.length && Line.charAt(I) !== ' ' && Line.charAt(I) !== '\t') {
      Value += Line.charAt(I);
      I++;
    }
    Tokens.push({ Value, Quoted: false });
  }
  return Tokens;
}

export interface RcpLine {
  // 'OK' (also covers 'OKm'), 'NOTIFY' or 'ERROR'.
  Status: 'OK' | 'NOTIFY' | 'ERROR';
  Tokens: RcpToken[];
}

function ParseLine(Raw: string): RcpLine | null {
  const Tokens = Tokenize(Raw.replace(/\r$/, '').trim());
  const Head = Tokens[0];
  if (!Head || Head.Quoted) return null;
  const Status = Head.Value.toUpperCase();
  if (Status === 'OK' || Status === 'OKM') return { Status: 'OK', Tokens };
  if (Status === 'NOTIFY' || Status === 'ERROR') return { Status, Tokens };
  return null;
}

// What a pending request is waiting for: an `OK` echoing these leading tokens
// (e.g. ['devinfo', 'productname']), or any `ERROR` line; commands go one at a
// time, so an error can only belong to the command in flight.
function MatchesRequest(Line: RcpLine, Echo: string[]): boolean {
  if (Line.Status === 'ERROR') return true;
  if (Line.Status !== 'OK') return false;
  return Echo.every((Part, Index) => {
    const Token = Line.Tokens[Index + 1];
    return !!Token && Token.Value.toLowerCase() === Part.toLowerCase();
  });
}

// ReplyQueue predicate: consume every complete line up to and including the
// first one that answers the request; NOTIFY and unrelated lines before it are
// consumed with it and ignored.
function ReplyPredicate(Echo: string[]): (Buffered: string) => number | null {
  return (Buffered) => {
    let Pos = 0;
    while (true) {
      const Nl = Buffered.indexOf('\n', Pos);
      if (Nl === -1) return null;
      const Parsed = ParseLine(Buffered.slice(Pos, Nl));
      if (Parsed && MatchesRequest(Parsed, Echo)) return Nl + 1;
      Pos = Nl + 1;
    }
  };
}

// The answering line is the last complete line of what the predicate consumed.
function LastLine(Consumed: string): RcpLine | null {
  const Lines = Consumed.split('\n').filter((L) => L.trim());
  const Last = Lines[Lines.length - 1];
  return Last == null ? null : ParseLine(Last);
}

type RcpAnswer = { Ok: true; Line: RcpLine } | { Ok: false; Error: string };

// Turn the answering line into a value or an error. The value is the final
// token for devinfo/devstatus, and the token after the x/y indices for `get`
// (a quoted display label such as "ON" may follow it).
function AnswerValue(Answer: RcpAnswer, ValueIndex: number | 'last'): string | null {
  if (!Answer.Ok) return null;
  const Tokens = Answer.Line.Tokens;
  const Token = ValueIndex === 'last' ? Tokens[Tokens.length - 1] : Tokens[ValueIndex];
  return Token ? Token.Value : null;
}

export type ConsoleSeries = 'CL' | 'QL' | 'TF' | 'DM3' | 'DM7' | 'RIVAGE PM';

// Which console family a product name belongs to. RIVAGE PM components report
// several product names (surfaces and DSP engines), so that family is matched
// loosely. Null for anything else (RIO, Tio, DME, DM5, etc.).
function DetectSeries(ProductName: string | null): ConsoleSeries | null {
  const Name = (ProductName || '').trim();
  if (/^CL\d/i.test(Name)) return 'CL';
  if (/^QL\d/i.test(Name)) return 'QL';
  if (/^TF/i.test(Name)) return 'TF';
  if (/^DM3/i.test(Name)) return 'DM3';
  if (/^DM7/i.test(Name)) return 'DM7';
  if (/rivage|^PM\d|^CSD?-R|^DSP-R/i.test(Name)) return 'RIVAGE PM';
  return null;
}

// Series whose parameter set is known to contain MIXER:Current/St/Fader/On.
const MASTER_SUPPORTED: ReadonlySet<ConsoleSeries> = new Set<ConsoleSeries>([
  'CL',
  'QL',
  'TF',
  'DM3',
  'DM7',
  'RIVAGE PM',
]);

export interface AlertStatus {
  Level: 'Fault' | 'Error' | 'Warning' | null;
  Message: string | null;
}

// `devstatus error` answers "none", a bare level ("fault" / "error" /
// "warning"), or a detailed "flt/<message>// x53 on ..." form; read all three.
function ParseAlert(Value: string | null): AlertStatus | null {
  if (Value == null) return null;
  const Text = Value.trim();
  if (!Text || /^none$/i.test(Text)) return { Level: null, Message: null };
  const Lower = Text.toLowerCase();
  const Level: AlertStatus['Level'] =
    Lower.startsWith('flt') || Lower.startsWith('fault')
      ? 'Fault'
      : Lower.startsWith('err')
        ? 'Error'
        : Lower.startsWith('wrn') || Lower.startsWith('warn')
          ? 'Warning'
          : 'Error';
  const Detail = Text.match(/^[a-z]+\/(.*?)(?:\/\/|$)/i);
  const Message = Detail && Detail[1] ? Detail[1].trim() : null;
  return { Level, Message: Message || (/^(fault|error|warning)$/i.test(Text) ? null : Text) };
}

// --- One-connection probe ------------------------------------------------------

export interface MasterReading {
  Label: string;
  On: boolean | null;
  Error?: string;
}

export interface ConsoleSnapshot {
  // The device answered in RCP's OK / ERROR line format.
  IsYamaha: boolean;
  RunMode: string | null;
  // Run mode in which Yamaha says the device accepts no other commands.
  NotReady: boolean;
  ProductName: string | null;
  Version: string | null;
  DeviceName: string | null;
  // Null when not asked for; Error when the console refused the query.
  Alert: AlertStatus | null;
  AlertError: string | null;
  Master: MasterReading[] | null;
  // Why the stereo master was not read (unsupported product).
  MasterSkipped: string | null;
  // A stage that did not finish inside the budget, as a human reason.
  Incomplete: string | null;
}

export type ConsoleProbe =
  | { Reachable: false; Error: string; Refused: boolean }
  | { Reachable: true; LatencyMs: number; Snapshot: ConsoleSnapshot };

class SessionEnded extends Error {}

function ErrorText(Answer: RcpAnswer): string | null {
  return Answer.Ok ? null : Answer.Error;
}

function QueryConsole(
  Config: YamahaConfig,
  Want: { Alerts: boolean; Master: boolean }
): Promise<ConsoleProbe> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Replies = new ReplyQueue(MAX_BUFFERED_CHARS);
  // Text arrives ASCII by default but a device name may be UTF-8; a decoder
  // keeps a multi-byte character split across two packets intact.
  const Decoder = new StringDecoder('utf8');
  const Snapshot: ConsoleSnapshot = {
    IsYamaha: false,
    RunMode: null,
    NotReady: false,
    ProductName: null,
    Version: null,
    DeviceName: null,
    Alert: null,
    AlertError: null,
    Master: null,
    MasterSkipped: null,
    Incomplete: null,
  };
  let BytesSeen = 0;
  let Stage = 'the run-mode query';

  const Reached = (StartedAt: number): ConsoleProbe => ({
    Reachable: true,
    LatencyMs: Date.now() - StartedAt,
    Snapshot,
  });
  const Unfinished = (StartedAt: number, NoReplyError: string): ConsoleProbe => {
    if (!BytesSeen) return { Reachable: false, Error: NoReplyError, Refused: false };
    if (Snapshot.IsYamaha) Snapshot.Incomplete = `The console did not answer ${Stage} in time`;
    return Reached(StartedAt);
  };

  return RunTcpSession<ConsoleProbe>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnSettle: () => Replies.FailPending(new SessionEnded('session ended')),
    OnData: (Chunk, Session) => {
      BytesSeen += Chunk.length;
      if (!Replies.Feed(Decoder.write(Chunk))) Session.Finish(Reached(Session.StartedAt));
    },
    OnTimeout: (Session) =>
      Unfinished(Session.StartedAt, `No reply from the console after ${BudgetMs}ms`),
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => Unfinished(Session.StartedAt, 'Connection closed before any reply'),
    OnConnect: (Session) => {
      const Ask = async (Command: string, Echo: string[]): Promise<RcpAnswer> => {
        const Reply = Replies.Next(ReplyPredicate(Echo));
        Session.Socket.write(`${Command}\n`);
        const Line = LastLine(await Reply);
        Snapshot.IsYamaha = true;
        if (!Line || Line.Status === 'ERROR') {
          const Code = Line && Line.Tokens.length > 1 ? Line.Tokens[Line.Tokens.length - 1] : null;
          return { Ok: false, Error: Code ? Code.Value : 'ERROR' };
        }
        return { Ok: true, Line };
      };

      void (async () => {
        try {
          const RunMode = await Ask('devstatus runmode', ['devstatus', 'runmode']);
          Snapshot.RunMode = AnswerValue(RunMode, 'last');
          // Yamaha: "booting" and "update" take no other commands; asking
          // would only run the budget out.
          if (Snapshot.RunMode && /^(booting|update)$/i.test(Snapshot.RunMode)) {
            Snapshot.NotReady = true;
            Session.Finish(Reached(Session.StartedAt));
            return;
          }

          Stage = 'the product-name query';
          Snapshot.ProductName = AnswerValue(
            await Ask('devinfo productname', ['devinfo', 'productname']),
            'last'
          );
          Stage = 'the firmware-version query';
          Snapshot.Version = AnswerValue(
            await Ask('devinfo version', ['devinfo', 'version']),
            'last'
          );
          Stage = 'the device-name query';
          Snapshot.DeviceName = AnswerValue(
            await Ask('devinfo devicename', ['devinfo', 'devicename']),
            'last'
          );

          if (Want.Alerts) {
            Stage = 'the alert-status query';
            const Alert = await Ask('devstatus error', ['devstatus', 'error']);
            Snapshot.AlertError = ErrorText(Alert);
            Snapshot.Alert = ParseAlert(AnswerValue(Alert, 'last'));
          }

          if (Want.Master) {
            const Series = DetectSeries(Snapshot.ProductName);
            if (!Series || !MASTER_SUPPORTED.has(Series)) {
              Snapshot.MasterSkipped = `not supported on ${Snapshot.ProductName || 'this device'}`;
            } else {
              Stage = 'the stereo master query';
              const Readings: MasterReading[] = [];
              for (const Channel of MASTER_CHANNELS) {
                const Answer = await Ask(`get ${MASTER_ADDRESS} ${Channel.X} 0`, [
                  'get',
                  MASTER_ADDRESS,
                  String(Channel.X),
                ]);
                const Value = AnswerValue(Answer, 5);
                const Num = Value == null ? NaN : Number(Value);
                if (!Answer.Ok) {
                  Readings.push({ Label: Channel.Label, On: null, Error: Answer.Error });
                } else if (!Number.isFinite(Num)) {
                  Readings.push({ Label: Channel.Label, On: null, Error: 'Unreadable value' });
                } else {
                  Readings.push({ Label: Channel.Label, On: Num !== 0 });
                }
              }
              Snapshot.Master = Readings;
            }
          }
          Session.Finish(Reached(Session.StartedAt));
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

// The reasons a reachable console is unhealthy, per the enabled options. Pure;
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: ConsoleSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsYamaha) return ['Responded, but not as a Yamaha console (RCP)'];

  if (Snapshot.NotReady) {
    // Nothing else was read, so any enabled check is moot until it is back.
    const AnyCheck =
      Options.CheckRunMode || Options.CheckModel || Options.CheckAlerts || Options.CheckMasterMute;
    return AnyCheck ? [`Console in ${Snapshot.RunMode} mode`] : [];
  }

  const Reasons: string[] = [];
  if (Snapshot.Incomplete) Reasons.push(Snapshot.Incomplete);

  if (Options.CheckRunMode) {
    if (!Snapshot.RunMode) Reasons.push('Run mode not reported');
    else if (Snapshot.RunMode.toLowerCase() !== 'normal') {
      Reasons.push(`Console in ${Snapshot.RunMode} mode`);
    }
  }

  const Product = Snapshot.ProductName || 'this console';
  if (Options.CheckModel && Options.ExpectedModel) {
    if (!Snapshot.ProductName) Reasons.push('Model not reported');
    else if (!Snapshot.ProductName.toLowerCase().startsWith(Options.ExpectedModel.toLowerCase())) {
      Reasons.push(`Model ${Snapshot.ProductName} (expected ${Options.ExpectedModel}...)`);
    }
  }

  if (Options.CheckAlerts) {
    if (Snapshot.AlertError) {
      Reasons.push(`Alert status not available on ${Product}`);
    } else if (Snapshot.Alert && Snapshot.Alert.Level) {
      Reasons.push(
        Snapshot.Alert.Message
          ? `${Snapshot.Alert.Level} alert: ${Snapshot.Alert.Message}`
          : `${Snapshot.Alert.Level} alert`
      );
    }
  }

  if (Options.CheckMasterMute) {
    if (Snapshot.MasterSkipped) {
      Reasons.push(`Stereo master check ${Snapshot.MasterSkipped}`);
    }
    for (const Reading of Snapshot.Master || []) {
      if (Reading.On === false) Reasons.push(`Stereo master ${Reading.Label} is off`);
      else if (Reading.On == null) {
        Reasons.push(
          `Failed to read stereo master ${Reading.Label} (${Reading.Error || 'no value'})`
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

  const Probe = await QueryConsole(Config, {
    Alerts: Options.CheckAlerts,
    Master: Options.CheckMasterMute,
  });
  if (!Probe.Reachable) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }

  const { Snapshot } = Probe;
  const Reasons = EvaluateHealth(Snapshot, Options);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    IsYamaha: Snapshot.IsYamaha,
    ProductName: Snapshot.ProductName,
    Series: DetectSeries(Snapshot.ProductName),
    Version: Snapshot.Version,
    DeviceName: Snapshot.DeviceName,
    RunMode: Snapshot.RunMode,
    Alert: Snapshot.Alert,
    AlertError: Snapshot.AlertError,
    Master: Snapshot.Master,
    MasterSkipped: Snapshot.MasterSkipped,
  };
}

// --- Debug panel -----------------------------------------------------------------

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
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Row('Status', StatePill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the console'),
  ];
  if (!Reachable) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(`Failed to reach the Yamaha remote control port (TCP ${Config.Port})`) +
      '</div>'
    );
  }
  if (Result.IsYamaha === false) {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note('The device answered, but not as a Yamaha console') +
      '</div>'
    );
  }

  const Product =
    Result.ProductName != null
      ? String(Result.ProductName) + (Result.Series ? ` (${String(Result.Series)} series)` : '')
      : null;
  const RunMode = Result.RunMode == null ? null : String(Result.RunMode);
  const Alert =
    Result.Alert && typeof Result.Alert === 'object' ? (Result.Alert as AlertStatus) : null;
  const Master = Array.isArray(Result.Master) ? (Result.Master as MasterReading[]) : null;

  return Rows([
    ...Head,
    Product != null
      ? TextRow(
          'Model',
          Product +
            (Options.CheckModel && Options.ExpectedModel
              ? ` (expected ${Options.ExpectedModel}...)`
              : '')
        )
      : null,
    Result.Version != null ? TextRow('Firmware', String(Result.Version)) : null,
    Result.DeviceName != null && Result.DeviceName !== ''
      ? TextRow('Device name', String(Result.DeviceName))
      : null,
    RunMode != null
      ? Row('Run mode', Pill(RunMode.toLowerCase() === 'normal' ? 'success' : 'warning', RunMode))
      : null,
    Result.AlertError
      ? TextRow('Alerts', `Not reported (${String(Result.AlertError)})`)
      : Alert
        ? Row(
            'Alerts',
            Alert.Level
              ? Pill('warning', Alert.Message ? `${Alert.Level}: ${Alert.Message}` : Alert.Level)
              : Pill('success', 'None')
          )
        : null,
    Result.MasterSkipped ? TextRow('Stereo master', `Check ${String(Result.MasterSkipped)}`) : null,
    ...(Master || []).map((Reading) =>
      Row(
        `Stereo master ${Reading.Label}`,
        Reading.On == null
          ? Pill('muted', Reading.Error || 'Unknown')
          : Reading.On
            ? Pill('success', 'On')
            : Pill('warning', 'Off')
      )
    ),
  ]);
}

export const Name = 'Yamaha Console';
export const Description =
  'Connects to a Yamaha digital mixing console (CL, QL, TF, DM3, DM7, RIVAGE PM) on its remote control port (TCP 49280) and reads model, firmware and run mode (read-only). Optionally checks the model, the console’s alert status and that the stereo master is on.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  Tokenize,
  ParseLine,
  MatchesRequest,
  ReplyPredicate,
  DetectSeries,
  ParseAlert,
  EvaluateHealth,
  QueryConsole,
  MASTER_ADDRESS,
};
export { ID, Settings, Run, Debug };
