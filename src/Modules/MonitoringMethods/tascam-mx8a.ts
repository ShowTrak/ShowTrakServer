// TASCAM MX-8A matrix mixer health over TEAC's RS-232C/ETHERNET protocol
// ("TASCAM MX-8A/DCP Series … protocol specifications", v1.00): plain text on
// TCP 54726 (fixed), every command and reply ending in CR+LF. One short-lived
// session per probe, one command in flight at a time:
//
//   1. CR+LF                → `Enter Password`, then the password (blank when
//                             none is set) + CR+LF → `Login Successful`. A unit
//                             that already has a controller connected answers
//                             `Another User Already Connected` and hangs up.
//   2. `GET DEVICE/MODELNAME DEVICE/NAME DEVICE/VER/SYSTEM DEVICE/SERIAL
//       DEVICE/SAMPLE TESTTONE/ENABLE`
//                           → `OK GET DEVICE/MODELNAME:"MX-8A" …`, one
//                             `Key:Value` per key asked; a key the unit cannot
//                             answer reads `Key:ERR<n>`.
//   3. `GET ANLGOUT/<n>/TESTTONE …` for outputs 1-8, only while the test tone is
//      on, to say which outputs it is reaching.
//   4. `GET ANLGIN/<n>/MUTE MIX/<n>/MUTE ANLGOUT/<n>/MUTE …` for the listed
//      channels, then `…/NAME` for the muted ones (at most four per GET, since
//      a name can be 96 bytes and the unit splits replies over 1024 bytes).
//
// NOTIFY (setting changes) and METER lines can arrive at any time and are
// skipped wherever they land. Nothing in Run() changes the unit: it never
// turns NOTIFY or meters on, since that would be a SET.
//
// The unit accepts ONE Ethernet connection. While TASCAM MX Connect or a
// control system holds it, this check reads `Another User Already Connected`:
// the unit is alive, so the check is online, but nothing else can be read.
// The other way round, a controller that tries to connect during this probe's
// short session is turned away and has to retry. Every session here is closed
// the moment it settles (see RunTcpSession).
//
// The protocol has no fault, temperature or power status, so health is what the
// unit's settings say: a test tone left on, and muted channels that should not
// be.
import { StringDecoder } from 'string_decoder';
import { ReplyQueue, RunTcpSession } from './_tcp-session';
import { Card, Esc, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  LiveLevelsFrame,
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'tascam-mx8a';
const DEFAULT_PORT = 54726;
const DEFAULT_TIMEOUT_MS = 4000;
// Replies are at most 1024 bytes a line; anything this large is not the unit.
const MAX_BUFFERED_CHARS = 64_000;
// The MX-8A has 8 analog inputs, 8 mix buses and 8 analog outputs.
const CHANNELS = 8;
// Names are up to 96 bytes, so four per GET keeps a reply under 1024 bytes.
const NAMES_PER_GET = 4;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Control port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'The MX-8A accepts control commands on TCP 54726. The port is fixed on the unit.',
  },
  {
    Key: 'Password',
    Label: 'Password',
    Type: 'string',
    Default: '',
    Sensitive: true,
    Note: 'The network password set in MX Connect. Leave blank when none is set, as on a new unit.',
  },
  {
    Key: 'CheckTestTone',
    Label: 'Check test tone',
    Type: 'boolean',
    Default: true,
    Note: 'Degraded while test tone mode is on, naming the outputs it is sent to.',
  },
  {
    Key: 'CheckMutes',
    Label: 'Check mutes',
    Type: 'boolean',
    Default: false,
    Note: 'Degraded while any listed input, mix bus or output is muted.',
  },
  {
    Key: 'MonitoredInputs',
    Label: 'Inputs',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckMutes', Equals: true },
    Note: 'Analog input numbers, 1 to 8, that should never be muted.',
  },
  {
    Key: 'MonitoredMixes',
    Label: 'Mix buses',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckMutes', Equals: true },
    Note: 'Mix bus numbers, 1 to 8, that should never be muted.',
  },
  {
    Key: 'MonitoredOutputs',
    Label: 'Outputs',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckMutes', Equals: true },
    Note: 'Analog output numbers, 1 to 8, that should never be muted.',
  },
  {
    Key: 'ReadLevels',
    Label: 'Show live input levels',
    Type: 'boolean',
    Default: false,
    Note: 'Shows the eight input meters (pre-fader) in the monitor view while it is open. While they are showing, ShowTrak holds the unit’s only control connection, so MX Connect or a control system cannot connect.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole session: connect, login and every read.',
  },
];

// --- Options -----------------------------------------------------------------

export type ChannelKind = 'input' | 'mix' | 'output';

const KIND_PREFIX: Record<ChannelKind, string> = {
  input: 'ANLGIN',
  mix: 'MIX',
  output: 'ANLGOUT',
};

const KIND_LABEL: Record<ChannelKind, string> = {
  input: 'Input',
  mix: 'Mix',
  output: 'Output',
};

interface MxConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
  Password: string;
}

export interface MonitoredChannel {
  Kind: ChannelKind;
  Channel: number;
}

interface HealthOptions {
  CheckTestTone: boolean;
  CheckMutes: boolean;
  Channels: MonitoredChannel[];
  // List entries outside 1-8; reported, never sent.
  InvalidChannels: string[];
}

function ParseConfig(Target: MonitoringTargetLike): MxConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Port | 0 : DEFAULT_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Timeout : DEFAULT_TIMEOUT_MS,
    Password: Cfg.Password == null ? '' : String(Cfg.Password),
  };
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const CheckMutes = Cfg.CheckMutes === true;
  const Channels: MonitoredChannel[] = [];
  const InvalidChannels: string[] = [];
  if (CheckMutes) {
    const Lists: Array<[ChannelKind, unknown]> = [
      ['input', Cfg.MonitoredInputs],
      ['mix', Cfg.MonitoredMixes],
      ['output', Cfg.MonitoredOutputs],
    ];
    for (const [Kind, List] of Lists) {
      const Seen = new Set<number>();
      for (const Raw of Array.isArray(List) ? List : []) {
        const N = Number(Raw);
        if (!Number.isInteger(N) || N < 1 || N > CHANNELS) {
          InvalidChannels.push(`${KIND_LABEL[Kind]} ${String(Raw)}`);
          continue;
        }
        if (Seen.has(N)) continue;
        Seen.add(N);
        Channels.push({ Kind, Channel: N });
      }
    }
  }
  return {
    CheckTestTone: Cfg.CheckTestTone !== false,
    CheckMutes,
    Channels,
    InvalidChannels,
  };
}

// --- Pure protocol helpers -----------------------------------------------------

const LINE_END_RE = /\r\n|\r|\n/g;

// Lines the unit pushes on its own, never an answer to a command.
function IsPushed(Line: string): boolean {
  return /^(NOTIFY|METER)\b/i.test(Line);
}

/**
 * A predicate for ReplyQueue: how many leading characters end with the first
 * line that answers a command — skipping blank lines and pushed NOTIFY / METER
 * lines. Null while no such line has arrived.
 */
function NextReplyLine(Buffered: string): number | null {
  const Re = new RegExp(LINE_END_RE.source, 'g');
  let Start = 0;
  let Match: RegExpExecArray | null;
  while ((Match = Re.exec(Buffered))) {
    const Line = Buffered.slice(Start, Match.index).trim();
    Start = Match.index + Match[0].length;
    if (Line && !IsPushed(Line)) return Start;
  }
  return null;
}

// The answering line out of what NextReplyLine consumed.
function ReplyLine(Consumed: string): string {
  const Lines = Consumed.split(LINE_END_RE)
    .map((L) => L.trim())
    .filter((L) => L && !IsPushed(L));
  return Lines[Lines.length - 1] || '';
}

// Space-separated parameters, keeping a "quoted name" with spaces in it whole.
function SplitParams(Text: string): string[] {
  const Out: string[] = [];
  let Current = '';
  let Quoted = false;
  for (const Ch of Text) {
    if (Ch === '"') Quoted = !Quoted;
    if (Ch === ' ' && !Quoted) {
      if (Current) Out.push(Current);
      Current = '';
    } else {
      Current += Ch;
    }
  }
  if (Current) Out.push(Current);
  return Out;
}

export interface ParsedReply {
  Type: 'GET' | 'SET';
  // Key → value as sent, quotes removed. `ERR<n>` marks a key the unit refused.
  Values: Record<string, string>;
}

/**
 * `OK GET Key:Value …` / `OK SET [Key:ERR<n> …]`. The spec's own error example
 * also shows the reply without the leading OK (`GET Key:ERR1`), and one GET
 * example answered `OK SET`, so both are accepted. Null for anything else,
 * including `NG …` (command not recognised).
 */
function ParseReply(Line: string): ParsedReply | null {
  const Match = /^(?:OK\s+)?(GET|SET)(?:\s+(.*))?$/i.exec(Line.trim());
  if (!Match) return null;
  const Values: Record<string, string> = {};
  for (const Param of SplitParams(Match[2] || '')) {
    const Colon = Param.indexOf(':');
    if (Colon <= 0) continue;
    const Key = Param.slice(0, Colon).toUpperCase();
    if (Key === 'CID') continue;
    let Value = Param.slice(Colon + 1);
    if (Value.length >= 2 && Value.startsWith('"') && Value.endsWith('"')) {
      Value = Value.slice(1, -1);
    }
    Values[Key] = Value;
  }
  return { Type: (Match[1] as string).toUpperCase() as 'GET' | 'SET', Values };
}

function IsError(Value: string | undefined): boolean {
  return Value != null && /^ERR\d*$/i.test(Value);
}

// What an ERR code means, per the spec's Command errors section.
function DescribeError(Value: string): string {
  const Code = Value.toUpperCase();
  if (Code === 'ERR1') return 'not available on this unit';
  if (Code === 'ERR2') return 'value refused';
  return Code;
}

function OnOff(Value: string | undefined): boolean | null {
  if (Value == null) return null;
  const Upper = Value.toUpperCase();
  if (Upper === 'ON') return true;
  if (Upper === 'OFF') return false;
  return null;
}

function Text(Value: string | undefined): string | null {
  return Value == null || Value === '' || IsError(Value) ? null : Value;
}

// `V1.00B0010` → `1.00 (build 0010)`; anything else as sent.
function FormatFirmware(Value: string | null): string | null {
  if (!Value) return null;
  const Match = /^V(\d+(?:\.\d+)*)B(\d+)$/i.exec(Value);
  return Match ? `${Match[1]} (build ${Match[2]})` : Value;
}

function ChannelLabel(Reading: {
  Kind: ChannelKind;
  Channel: number;
  Name?: string | null;
}): string {
  const Base = `${KIND_LABEL[Reading.Kind]} ${Reading.Channel}`;
  return Reading.Name ? `${Base} (${Reading.Name})` : Base;
}

// --- Session --------------------------------------------------------------------

class SessionEnded extends Error {}
class UnexpectedReply extends Error {}

export type LoginState = 'ok' | 'busy' | 'refused' | 'unexpected';

/**
 * Connect and log in, then hand over to OnLogin. Settles with whatever OnLogin
 * or one of the ending paths returns; the session is always closed when it does.
 */
interface MxSessionSpec<R> {
  Config: MxConfig;
  // Stay open for as long as OnLogin runs: no overall deadline, and an idle
  // timeout that only a unit gone quiet for LIVE_IDLE_MS trips.
  Persistent?: boolean;
  // A line the unit pushed on its own (NOTIFY / METER). Never fed to a reply.
  OnPushed?(Line: string): void;
  // Called once connecting has begun, with a way to end the session early.
  OnStart?(Cancel: () => void): void;
  // Logged in, or turned away; the caller decides what each means for its result.
  OnLogin(State: LoginState, Reply: string, Ask: (Command: string) => Promise<string>): Promise<R>;
  // Ending early. `Spoke` is whether the unit sent anything at all.
  OnEnded(Kind: 'timeout' | 'close', Spoke: boolean): R;
  OnError(Message: string): R;
}

function RunMxSession<R>(Spec: MxSessionSpec<R>): Promise<R> {
  const BudgetMs = Math.max(500, Spec.Config.TimeoutMs | 0);
  const Queue = new ReplyQueue(MAX_BUFFERED_CHARS);
  const Decoder = new StringDecoder('utf8');
  let Partial = '';
  let BytesSeen = 0;
  let Cancel: (() => void) | null = null;
  let CancelRequested = false;

  const Running = RunTcpSession<R>({
    Address: Spec.Config.Address,
    Port: Spec.Config.Port,
    IdleMs: Spec.Persistent ? Math.max(BudgetMs, LIVE_IDLE_MS) : BudgetMs,
    ...(Spec.Persistent ? {} : { DeadlineMs: BudgetMs }),
    NoDelay: true,
    OnSettle: () => Queue.FailPending(new SessionEnded('session ended')),
    OnData: (Chunk, Session) => {
      BytesSeen += Chunk.length;
      // Whole lines only: pushed ones go to OnPushed, so a stream of meter lines
      // never piles up in front of the next reply.
      const Lines = (Partial + Decoder.write(Chunk).replace(/\0/g, '')).split(LINE_END_RE);
      Partial = Lines.pop() || '';
      for (const Raw of Lines) {
        const Line = Raw.trim();
        if (!Line) continue;
        if (IsPushed(Line)) {
          if (Spec.OnPushed) Spec.OnPushed(Line);
        } else if (!Queue.Feed(`${Line}\r\n`)) {
          Session.Finish(Spec.OnError('The unit sent an oversized reply'));
          return;
        }
      }
      if (Partial.length > MAX_BUFFERED_CHARS) {
        Session.Finish(Spec.OnError('The unit sent an oversized reply'));
      }
    },
    OnTimeout: () => Spec.OnEnded('timeout', BytesSeen > 0),
    OnError: (Message) => Spec.OnError(Message),
    OnClose: () => Spec.OnEnded('close', BytesSeen > 0),
    OnConnect: (Session) => {
      Cancel = () => Session.Finish(Spec.OnError('Cancelled'));
      if (CancelRequested) {
        Cancel();
        return;
      }
      const Ask = async (Command: string): Promise<string> => {
        if (Session.Settled) throw new SessionEnded('session ended');
        Session.Socket.write(`${Command}\r\n`);
        return ReplyLine(await Queue.Next(NextReplyLine));
      };
      void (async () => {
        try {
          const Prompt = await Ask('');
          let State: LoginState;
          let Reply = Prompt;
          if (/already connected/i.test(Prompt)) State = 'busy';
          else if (/login successful/i.test(Prompt)) State = 'ok';
          else if (/enter password/i.test(Prompt)) {
            Reply = await Ask(Spec.Config.Password);
            State = /login successful/i.test(Reply) ? 'ok' : 'refused';
          } else State = 'unexpected';
          Session.Finish(await Spec.OnLogin(State, Reply, Ask));
        } catch (Err) {
          if (Err instanceof SessionEnded) return; // already settled by timeout/close
          Session.Finish(Spec.OnError(Err instanceof Error ? Err.message : String(Err)));
        }
      })();
    },
  });
  // Cancelled before the connect completes: the session ends as soon as it does
  // (or when the connect fails).
  if (Spec.OnStart) {
    Spec.OnStart(() => {
      CancelRequested = true;
      if (Cancel) Cancel();
    });
  }
  return Running;
}

// --- One-connection probe --------------------------------------------------------

export interface MuteReading {
  Kind: ChannelKind;
  Channel: number;
  Muted: boolean | null;
  Name: string | null;
  // Why the mute could not be read.
  Error: string | null;
}

export interface MxSnapshot {
  Login: LoginState;
  // The unit's reply when the login did not succeed.
  LoginReply: string | null;
  Model: string | null;
  DeviceName: string | null;
  Firmware: string | null;
  Serial: string | null;
  SampleRate: number | null;
  TestTone: boolean | null;
  // Outputs the test tone is switched on for; null = not read.
  TestToneOutputs: number[] | null;
  Mutes: MuteReading[] | null;
  // A stage that did not finish inside the budget, as a human reason.
  Incomplete: string | null;
}

export type MxProbe =
  | { Reachable: false; Error: string; Refused: boolean }
  | { Reachable: true; LatencyMs: number; Snapshot: MxSnapshot };

function EmptySnapshot(): MxSnapshot {
  return {
    Login: 'unexpected',
    LoginReply: null,
    Model: null,
    DeviceName: null,
    Firmware: null,
    Serial: null,
    SampleRate: null,
    TestTone: null,
    TestToneOutputs: null,
    Mutes: null,
    Incomplete: null,
  };
}

async function GetValues(
  Ask: (Command: string) => Promise<string>,
  Keys: string[]
): Promise<Record<string, string>> {
  const Line = await Ask(`GET ${Keys.join(' ')}`);
  const Parsed = ParseReply(Line);
  if (!Parsed) throw new UnexpectedReply(`Unexpected reply "${Line.slice(0, 80)}"`);
  return Parsed.Values;
}

// Every read the check makes, on a logged-in session. OnStage names the step in
// progress, for a timeout message.
async function ReadUnit(
  Ask: (Command: string) => Promise<string>,
  Channels: MonitoredChannel[],
  Snapshot: MxSnapshot,
  OnStage: (Stage: string) => void
): Promise<void> {
  let Stage = 'the device read';
  const SetStage = (Next: string) => {
    Stage = Next;
    OnStage(Next);
  };
  try {
    SetStage('the device read');
    const Device = await GetValues(Ask, [
      'DEVICE/MODELNAME',
      'DEVICE/NAME',
      'DEVICE/VER/SYSTEM',
      'DEVICE/SERIAL',
      'DEVICE/SAMPLE',
      'TESTTONE/ENABLE',
    ]);
    Snapshot.Model = Text(Device['DEVICE/MODELNAME']);
    Snapshot.DeviceName = Text(Device['DEVICE/NAME']);
    Snapshot.Firmware = Text(Device['DEVICE/VER/SYSTEM']);
    Snapshot.Serial = Text(Device['DEVICE/SERIAL']);
    const Rate = Number(Device['DEVICE/SAMPLE']);
    Snapshot.SampleRate = Number.isFinite(Rate) && Rate > 0 ? Rate : null;
    Snapshot.TestTone = OnOff(Device['TESTTONE/ENABLE']);

    if (Snapshot.TestTone) {
      SetStage('the test tone read');
      const Keys = Array.from({ length: CHANNELS }, (_, I) => `ANLGOUT/${I + 1}/TESTTONE`);
      const Outputs = await GetValues(Ask, Keys);
      Snapshot.TestToneOutputs = Keys.map((Key, I) => (OnOff(Outputs[Key]) ? I + 1 : 0)).filter(
        (N) => N > 0
      );
    }

    if (Channels.length) {
      SetStage('the mute read');
      const MuteKey = (C: MonitoredChannel) => `${KIND_PREFIX[C.Kind]}/${C.Channel}/MUTE`;
      const Values = await GetValues(Ask, Channels.map(MuteKey));
      const Readings: MuteReading[] = Channels.map((C) => {
        const Value = Values[MuteKey(C)];
        const Muted = OnOff(Value);
        return {
          Kind: C.Kind,
          Channel: C.Channel,
          Muted,
          Name: null,
          Error:
            Muted != null
              ? null
              : Value == null
                ? 'No answer'
                : IsError(Value)
                  ? DescribeError(Value)
                  : `Unexpected value "${Value.slice(0, 40)}"`,
        };
      });
      Snapshot.Mutes = Readings;

      SetStage('the channel names');
      const Muted = Readings.filter((R) => R.Muted);
      for (let I = 0; I < Muted.length; I += NAMES_PER_GET) {
        const Batch = Muted.slice(I, I + NAMES_PER_GET);
        const NameKey = (R: MuteReading) => `${KIND_PREFIX[R.Kind]}/${R.Channel}/NAME`;
        const Names = await GetValues(Ask, Batch.map(NameKey));
        for (const R of Batch) R.Name = Text(Names[NameKey(R)]);
      }
    }
  } catch (Err) {
    if (!(Err instanceof UnexpectedReply)) throw Err;
    Snapshot.Incomplete = `${Err.message} during ${Stage}`;
  }
}

function QueryUnit(Config: MxConfig, Channels: MonitoredChannel[]): Promise<MxProbe> {
  // While live levels are showing, this server already holds the unit's only
  // connection, so the reads ride on it (between meter lines) instead of being
  // turned away as "Another User Already Connected".
  const Live = LiveSessions.get(LiveKey(Config));
  if (Live && Live.Ask) return QueryOverLive(Config, Live.Ask, Live, Channels);
  return QueryOwnSession(Config, Channels);
}

async function QueryOverLive(
  Config: MxConfig,
  Ask: (Command: string) => Promise<string>,
  Live: LiveSession,
  Channels: MonitoredChannel[]
): Promise<MxProbe> {
  const Snapshot = EmptySnapshot();
  Snapshot.Login = 'ok';
  const StartedAt = Date.now();
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  let Stage = 'the device read';
  let Timer: ReturnType<typeof setTimeout> | null = null;
  const TimedOut = new Promise<'timeout'>((Resolve) => {
    Timer = setTimeout(() => Resolve('timeout'), BudgetMs);
  });
  let Outcome: 'done' | 'timeout' | 'ended';
  try {
    Outcome = await Promise.race([
      ReadUnit(Ask, Channels, Snapshot, (Next) => (Stage = Next)).then(() => 'done' as const),
      TimedOut,
    ]);
  } catch {
    Outcome = 'ended';
  } finally {
    if (Timer) clearTimeout(Timer);
  }
  if (Outcome === 'ended') {
    // The live connection dropped mid-read; it reconnects on its own. Read on a
    // session of our own meanwhile.
    return QueryOwnSession(Config, Channels);
  }
  if (Outcome === 'timeout') {
    Snapshot.Incomplete = `The unit did not finish ${Stage} in time`;
    // A read stuck on the shared connection would hold up every later one.
    RestartLive(Live);
  }
  return { Reachable: true, LatencyMs: Date.now() - StartedAt, Snapshot };
}

function QueryOwnSession(Config: MxConfig, Channels: MonitoredChannel[]): Promise<MxProbe> {
  const Snapshot = EmptySnapshot();
  let Stage = 'the login';
  const StartedAt = Date.now();

  const Reached = (): MxProbe => ({
    Reachable: true,
    LatencyMs: Date.now() - StartedAt,
    Snapshot,
  });

  return RunMxSession<MxProbe>({
    Config,
    OnEnded: (Kind, Spoke) => {
      if (!Spoke) {
        return {
          Reachable: false,
          Error:
            Kind === 'timeout'
              ? `No reply from the MX-8A after ${Math.max(500, Config.TimeoutMs | 0)}ms`
              : 'Connection closed before any reply',
          Refused: false,
        };
      }
      if (Snapshot.Login === 'ok') Snapshot.Incomplete = `The unit did not finish ${Stage} in time`;
      else Snapshot.LoginReply = Snapshot.LoginReply || 'No login reply';
      return Reached();
    },
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnLogin: async (State, Reply, Ask) => {
      Snapshot.Login = State;
      if (State !== 'ok') {
        Snapshot.LoginReply = Reply.slice(0, 120);
        return Reached();
      }
      await ReadUnit(Ask, Channels, Snapshot, (Next) => (Stage = Next));
      return Reached();
    },
  });
}

// --- Evaluation ----------------------------------------------------------------------

// The reasons a reachable unit is unhealthy, per the enabled options. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: MxSnapshot, Options: HealthOptions): string[] {
  if (Snapshot.Login === 'unexpected') return ['Responded, but not as a TASCAM MX-8A control port'];
  if (Snapshot.Login === 'refused') {
    return [
      `The unit refused the password${Snapshot.LoginReply ? ` ("${Snapshot.LoginReply}")` : ''}`,
    ];
  }
  // Another controller holds the only connection: the unit is alive, and what it
  // would say about its settings is unknown, not faulty.
  if (Snapshot.Login === 'busy') return [];

  const Reasons: string[] = [];
  if (Snapshot.Incomplete) Reasons.push(Snapshot.Incomplete);

  if (Options.CheckTestTone && Snapshot.TestTone) {
    const Outputs = Snapshot.TestToneOutputs || [];
    Reasons.push(
      Outputs.length
        ? `Test tone is on (output${Outputs.length === 1 ? '' : 's'} ${Outputs.join(', ')})`
        : 'Test tone is on'
    );
  }

  if (Options.CheckMutes) {
    for (const Entry of Options.InvalidChannels) {
      Reasons.push(`Invalid channel "${Entry}" (use 1 to ${CHANNELS})`);
    }
    for (const Reading of Snapshot.Mutes || []) {
      if (Reading.Muted) Reasons.push(`${ChannelLabel(Reading)} is muted`);
      else if (Reading.Muted == null) {
        Reasons.push(`${ChannelLabel(Reading)} mute not read (${Reading.Error || 'No answer'})`);
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
  if (/[\r\n]/.test(Config.Password)) {
    return { Success: false, Error: 'The password cannot contain line breaks' };
  }
  const Options = ParseHealthOptions(Target);

  const Probe = await QueryUnit(Config, Options.Channels);
  if (!Probe.Reachable) {
    return { Success: false, ...(Probe.Refused ? { Degraded: true } : {}), Error: Probe.Error };
  }

  const { Snapshot } = Probe;
  const Reasons = EvaluateHealth(Snapshot, Options);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Probe.LatencyMs,
    Login: Snapshot.Login,
    LoginReply: Snapshot.LoginReply,
    Model: Snapshot.Model,
    DeviceName: Snapshot.DeviceName,
    Firmware: Snapshot.Firmware,
    Serial: Snapshot.Serial,
    SampleRate: Snapshot.SampleRate,
    TestTone: Snapshot.TestTone,
    TestToneOutputs: Snapshot.TestToneOutputs,
    Mutes: Snapshot.Mutes,
  };
}

// --- Live levels ---------------------------------------------------------------------
//
// While the monitor's view is open and Show live input levels is on, one
// connection per unit is held open (see src/main/monitoring-live.ts):
//
//   1. GET ANLGIN/1..8/METER/PRE      what the meter switches were, to put back
//   2. GET ANLGIN/1..8/NAME           labels, four to a GET
//   3. SET ANLGIN/1..8/METER/PRE:ON   pre-fader input meters on
//   4. SET METER/TOTAL:10000 METER/INTERVAL:100, again every 5 s: the unit sends
//      `METER ANLGIN/<n>/METER/PRE:<hex>` every 100 ms for TOTAL ms after each.
//
// The meter value is a 32-bit linear amplitude, 0x80000000 = 0 dBFS (spec
// appendix 5.3). On the last viewer leaving, METER/TOTAL:0 stops the stream and
// any switch that was off is turned off again before the connection closes.
// The scheduled check reads over this same connection meanwhile (QueryUnit).

const LIVE_METER_INTERVAL_MS = 100;
const LIVE_METER_TOTAL_MS = 10_000;
const LIVE_RENEW_MS = 5_000;
const LIVE_RETRY_MS = 5_000;
const LIVE_IDLE_MS = 10_000;
const LIVE_FRAME_MS = 100;
// No meter line for this long while live reads as no levels.
const LIVE_STALE_MS = 2_000;
const FULL_SCALE = 2 ** 31;

interface LiveSession {
  Key: string;
  Config: MxConfig;
  Subscribers: Set<(Frame: LiveLevelsFrame) => void>;
  // Set while logged in and metering; serialised, safe to share.
  Ask: ((Command: string) => Promise<string>) | null;
  Labels: string[];
  Levels: Array<number | null>;
  LastMeterAt: number;
  State: LiveLevelsFrame['State'];
  Message: string | null;
  Stopped: boolean;
  // Ends the current connection at once.
  Cancel: (() => void) | null;
  // Ends it gracefully, putting the meters back first; set once metering.
  End: (() => void) | null;
  RetryTimer: ReturnType<typeof setTimeout> | null;
  FrameTimer: ReturnType<typeof setInterval> | null;
}

const LiveSessions = new Map<string, LiveSession>();

function LiveKey(Config: MxConfig): string {
  return `${Config.Address.toLowerCase()}|${Config.Port}|${Config.Password}`;
}

const PRE_KEYS = Array.from({ length: CHANNELS }, (_, I) => `ANLGIN/${I + 1}/METER/PRE`);

// `<hex>` → dBFS to 0.1 dB; null for silence or anything unreadable.
function MeterToDb(Value: string): number | null {
  if (!/^[0-9a-f]{1,8}$/i.test(Value)) return null;
  const Linear = parseInt(Value, 16);
  if (!(Linear > 0)) return null;
  return Math.round(200 * Math.log10(Linear / FULL_SCALE)) / 10;
}

function ApplyMeterLine(Live: LiveSession, Line: string): void {
  if (!/^METER\b/i.test(Line)) return;
  let Any = false;
  for (const Param of SplitParams(Line.replace(/^METER\s*/i, ''))) {
    const Match = /^ANLGIN\/(\d+)\/METER\/PRE:(.*)$/i.exec(Param);
    if (!Match) continue;
    const Index = Number(Match[1]) - 1;
    if (Index < 0 || Index >= CHANNELS) continue;
    Live.Levels[Index] = MeterToDb(Match[2] as string);
    Any = true;
  }
  if (Any) {
    Live.LastMeterAt = Date.now();
    Live.State = 'live';
    Live.Message = null;
  }
}

function LiveFrame(Live: LiveSession): LiveLevelsFrame {
  const Stale = Live.State === 'live' && Date.now() - Live.LastMeterAt > LIVE_STALE_MS;
  return {
    State: Stale ? 'unavailable' : Live.State,
    Message: Stale ? 'The unit stopped sending levels' : Live.Message,
    Channels: Live.Labels.map((Label, I) => ({
      Label,
      Db: Live.State === 'live' && !Stale ? (Live.Levels[I] ?? null) : null,
    })),
  };
}

function EmitLive(Live: LiveSession): void {
  const Frame = LiveFrame(Live);
  for (const Send of Live.Subscribers) {
    try {
      Send(Frame);
    } catch {
      // A subscriber's failure is its own; the others still get the frame.
    }
  }
}

function SetLiveProblem(Live: LiveSession, Message: string): void {
  Live.State = 'unavailable';
  Live.Message = Message;
  Live.Levels = Live.Levels.map(() => null);
}

// One serialised command at a time on a shared connection: the scheduled
// check's reads queue behind the renew, and the other way round.
function Serialise(
  Ask: (Command: string) => Promise<string>
): (Command: string) => Promise<string> {
  let Tail: Promise<unknown> = Promise.resolve();
  return (Command) => {
    const Next = Tail.then(() => Ask(Command));
    Tail = Next.catch(() => undefined);
    return Next;
  };
}

function ConnectLive(Live: LiveSession): void {
  Live.End = null;
  Live.Cancel = null;
  void RunMxSession<void>({
    Config: Live.Config,
    Persistent: true,
    OnPushed: (Line) => ApplyMeterLine(Live, Line),
    OnStart: (Cancel) => {
      Live.Cancel = Cancel;
    },
    OnEnded: (Kind, Spoke) =>
      SetLiveProblem(
        Live,
        !Spoke
          ? Kind === 'timeout'
            ? 'No reply from the MX-8A'
            : 'Connection closed before any reply'
          : Kind === 'timeout'
            ? 'The unit stopped answering'
            : 'The unit closed the connection'
      ),
    OnError: (Message) => {
      if (Message !== 'Cancelled') SetLiveProblem(Live, Message);
    },
    OnLogin: async (State, Reply, RawAsk) => {
      if (State === 'busy') return SetLiveProblem(Live, BUSY_ERROR);
      if (State === 'refused') return SetLiveProblem(Live, 'The unit refused the password');
      if (State === 'unexpected') {
        return SetLiveProblem(Live, `Unexpected reply "${Reply.slice(0, 60)}"`);
      }
      const Ask = Serialise(RawAsk);
      const Before = await GetValues(Ask, PRE_KEYS);
      for (let I = 0; I < CHANNELS; I += NAMES_PER_GET) {
        const Keys = Array.from(
          { length: Math.min(NAMES_PER_GET, CHANNELS - I) },
          (_, J) => `ANLGIN/${I + J + 1}/NAME`
        );
        const Names = await GetValues(Ask, Keys);
        Keys.forEach((Key, J) => {
          Live.Labels[I + J] = Text(Names[Key]) || `Input ${I + J + 1}`;
        });
      }
      const Renew = `SET METER/TOTAL:${LIVE_METER_TOTAL_MS} METER/INTERVAL:${LIVE_METER_INTERVAL_MS}`;
      const Restore = async () => {
        Live.Ask = null;
        await Ask('SET METER/TOTAL:0');
        const WasOff = PRE_KEYS.filter((Key) => OnOff(Before[Key]) === false);
        if (WasOff.length) await Ask(`SET ${WasOff.map((Key) => `${Key}:OFF`).join(' ')}`);
      };
      await Ask(`SET ${PRE_KEYS.map((Key) => `${Key}:ON`).join(' ')}`);
      await Ask(Renew);
      if (Live.Stopped) return Restore();

      Live.Ask = Ask;
      let Release: () => void = () => undefined;
      const Released = new Promise<void>((Resolve) => (Release = Resolve));
      Live.End = Release;
      const RenewTimer = setInterval(() => {
        Ask(Renew).catch(() => undefined);
      }, LIVE_RENEW_MS);
      if (typeof RenewTimer.unref === 'function') RenewTimer.unref();
      await Released;
      clearInterval(RenewTimer);
      // Ended by RestartLive / the last viewer: put the meters back. Ended by the
      // connection dropping: these throw SessionEnded and nothing is sent.
      return Restore();
    },
  }).then(() => {
    Live.Ask = null;
    // A dropped connection leaves its wait pending; release it so its renew
    // timer stops (its restore then fails quietly on the closed session).
    if (Live.End) Live.End();
    Live.End = null;
    Live.Cancel = null;
    if (Live.Stopped) return;
    if (Live.State !== 'unavailable') SetLiveProblem(Live, 'The unit closed the connection');
    Live.RetryTimer = setTimeout(() => {
      Live.RetryTimer = null;
      if (Live.Stopped) return;
      Live.State = 'connecting';
      Live.Message = null;
      ConnectLive(Live);
    }, LIVE_RETRY_MS);
    if (typeof Live.RetryTimer.unref === 'function') Live.RetryTimer.unref();
  });
}

// Drop and remake the connection, keeping the viewers. Cancelled outright: a
// graceful end would queue its restore behind whatever is stuck.
function RestartLive(Live: LiveSession): void {
  if (Live.Stopped) return;
  if (Live.Cancel) Live.Cancel();
}

function StopLive(Live: LiveSession): void {
  Live.Stopped = true;
  if (LiveSessions.get(Live.Key) === Live) LiveSessions.delete(Live.Key);
  if (Live.RetryTimer) clearTimeout(Live.RetryTimer);
  Live.RetryTimer = null;
  if (Live.FrameTimer) clearInterval(Live.FrameTimer);
  Live.FrameTimer = null;
  const Cancel = Live.Cancel;
  if (Live.End) {
    // Put the meters back, but never hold the unit's only connection for longer
    // than one check's budget doing it.
    Live.End();
    const Deadline = setTimeout(() => Cancel && Cancel(), Math.max(500, Live.Config.TimeoutMs | 0));
    if (typeof Deadline.unref === 'function') Deadline.unref();
  } else if (Cancel) Cancel();
}

function HasLiveLevels(Target: MonitoringTargetLike): boolean {
  const Cfg = (Target && Target.Settings) || {};
  return Cfg.ReadLevels === true;
}

function StartLiveLevels(
  Target: MonitoringTargetLike,
  OnFrame: (Frame: LiveLevelsFrame) => void
): () => void {
  const Config = ParseConfig(Target);
  const Problem = !Config.Address
    ? 'No address configured'
    : Config.Port < 1 || Config.Port > 65535
      ? `Invalid port: ${Config.Port}`
      : /[\r\n]/.test(Config.Password)
        ? 'The password cannot contain line breaks'
        : null;
  if (Problem) {
    OnFrame({ State: 'unavailable', Message: Problem, Channels: [] });
    return () => undefined;
  }

  const Key = LiveKey(Config);
  let Live = LiveSessions.get(Key);
  if (!Live) {
    const Created: LiveSession = {
      Key,
      Config,
      Subscribers: new Set(),
      Ask: null,
      Labels: Array.from({ length: CHANNELS }, (_, I) => `Input ${I + 1}`),
      Levels: Array.from({ length: CHANNELS }, () => null),
      LastMeterAt: 0,
      State: 'connecting',
      Message: null,
      Stopped: false,
      Cancel: null,
      End: null,
      RetryTimer: null,
      FrameTimer: null,
    };
    Created.FrameTimer = setInterval(() => EmitLive(Created), LIVE_FRAME_MS);
    if (typeof Created.FrameTimer.unref === 'function') Created.FrameTimer.unref();
    LiveSessions.set(Key, Created);
    ConnectLive(Created);
    Live = Created;
  }
  const Session = Live;
  Session.Subscribers.add(OnFrame);
  OnFrame(LiveFrame(Session));
  return () => {
    if (!Session.Subscribers.delete(OnFrame)) return;
    if (!Session.Subscribers.size) StopLive(Session);
  };
}

// --- Controllable actions ------------------------------------------------------------
//
// Each press opens its own session (same port, password and budget as the
// check), logs in, sends ONE documented SET and closes as soon as the unit
// answers `OK SET` (applied) or `OK SET Key:ERR<n>` / `NG …` (refused):
//   SET DEVICE/IDENTIFY:EXE            flash the unit's front panel (about 5 s)
//   SET TESTTONE/ENABLE:OFF            stop the test tone
//   SET ANLGIN|MIX|ANLGOUT/<n>/MUTE:ON|OFF
//   SET DEVICE/RESET:BOOT              reboot (FACT, the factory reset, is never sent)
// Turning the test tone ON is deliberately absent: it sends a tone at whatever
// level was last set to whichever outputs have it enabled.

const CHANNEL_NOTE = 'The channel number, 1 to 8.';

function ChannelParam(Kind: ChannelKind): MonitoringSettingField {
  return {
    Key: 'Channel',
    Label: `${KIND_LABEL[Kind]} number`,
    Type: 'number',
    Required: true,
    Note: CHANNEL_NOTE,
  };
}

const MUTE_GROUPS: Record<ChannelKind, string> = {
  input: 'Inputs',
  mix: 'Mix Buses',
  output: 'Outputs',
};

function MuteActions(Kind: ChannelKind): MonitoringActionDef[] {
  const Noun = Kind === 'mix' ? 'Mix Bus' : KIND_LABEL[Kind];
  return [
    {
      ID: `${Kind}.mute`,
      Label: `Mute ${Noun}`,
      Icon: 'volume-mute-fill',
      Group: MUTE_GROUPS[Kind],
      Destructive: true,
      Params: [ChannelParam(Kind)],
      Note: `Mutes one ${Noun.toLowerCase()} on the unit.`,
    },
    {
      ID: `${Kind}.unmute`,
      Label: `Unmute ${Noun}`,
      Icon: 'volume-up-fill',
      Group: MUTE_GROUPS[Kind],
      Params: [ChannelParam(Kind)],
      Note: `Unmutes one ${Noun.toLowerCase()} on the unit.`,
    },
  ];
}

const Actions: MonitoringActionDef[] = [
  {
    ID: 'identify',
    Label: 'Identify',
    Icon: 'lightbulb',
    Group: 'Device',
    Note: 'Flashes the unit’s front panel for about five seconds so it can be found in the rack.',
  },
  {
    ID: 'testtone.off',
    Label: 'Stop Test Tone',
    Icon: 'soundwave',
    Group: 'Device',
    Note: 'Turns test tone mode off on every output.',
  },
  ...MuteActions('input'),
  ...MuteActions('mix'),
  ...MuteActions('output'),
  {
    ID: 'reboot',
    Label: 'Reboot',
    Icon: 'arrow-clockwise',
    Group: 'Device',
    Destructive: true,
    Note: 'Restarts the unit. Audio stops until it has started again.',
  },
];

interface BuiltAction {
  Ok: true;
  Command: string;
  Detail: string;
  // The unit drops the connection when it restarts, which may come before the reply.
  CloseMeansDone?: boolean;
}

// Validate an action's parameters and build its one command. Pure — exported
// via _internal for unit tests.
function BuildActionCommand(
  ActionID: string,
  Params: Record<string, unknown>
): BuiltAction | { Ok: false; Error: string } {
  if (ActionID === 'identify') {
    return { Ok: true, Command: 'SET DEVICE/IDENTIFY:EXE', Detail: 'Identifying' };
  }
  if (ActionID === 'testtone.off') {
    return { Ok: true, Command: 'SET TESTTONE/ENABLE:OFF', Detail: 'Test tone off' };
  }
  if (ActionID === 'reboot') {
    return {
      Ok: true,
      Command: 'SET DEVICE/RESET:BOOT',
      Detail: 'Rebooting',
      CloseMeansDone: true,
    };
  }
  const Match = /^(input|mix|output)\.(mute|unmute)$/.exec(ActionID);
  if (Match) {
    const Kind = Match[1] as ChannelKind;
    const Mute = Match[2] === 'mute';
    const Raw = Params.Channel;
    const Channel =
      Raw == null || Raw === '' || typeof Raw === 'boolean'
        ? NaN
        : Number(typeof Raw === 'string' ? Raw.trim() : Raw);
    if (!Number.isInteger(Channel) || Channel < 1 || Channel > CHANNELS) {
      return {
        Ok: false,
        Error: `${KIND_LABEL[Kind]} number must be a number from 1 to ${CHANNELS}.`,
      };
    }
    const Noun = Kind === 'mix' ? 'Mix bus' : KIND_LABEL[Kind];
    return {
      Ok: true,
      Command: `SET ${KIND_PREFIX[Kind]}/${Channel}/MUTE:${Mute ? 'ON' : 'OFF'}`,
      Detail: `${Noun} ${Channel} ${Mute ? 'muted' : 'unmuted'}`,
    };
  }
  return { Ok: false, Error: `Unknown MX-8A action "${ActionID}"` };
}

const BUSY_ERROR =
  'Another controller (MX Connect or a control system) holds the unit’s only control connection. Disconnect it and try again.';

function SendUnitCommand(Config: MxConfig, Built: BuiltAction): Promise<MonitoringActionResult> {
  let Sent = false;
  return RunMxSession<MonitoringActionResult>({
    Config,
    OnEnded: (Kind, Spoke) => {
      if (Sent && Built.CloseMeansDone && Kind === 'close') {
        return { Success: true, Detail: Built.Detail };
      }
      if (Sent) {
        return {
          Success: false,
          Error:
            Kind === 'timeout'
              ? 'The unit did not answer in time. The command may or may not have been applied.'
              : 'The unit closed the connection before answering',
        };
      }
      return {
        Success: false,
        Error: Spoke
          ? 'The unit did not finish the login in time'
          : Kind === 'timeout'
            ? `No reply from the MX-8A after ${Math.max(500, Config.TimeoutMs | 0)}ms`
            : 'Connection closed before any reply',
      };
    },
    OnError: (Message) => ({ Success: false, Error: Message }),
    OnLogin: async (State, Reply, Ask) => {
      if (State === 'busy') return { Success: false, Error: BUSY_ERROR };
      if (State === 'refused') {
        return {
          Success: false,
          Error: 'The unit refused the password. Check it in the check settings.',
        };
      }
      if (State === 'unexpected') {
        return {
          Success: false,
          Error: `Unexpected reply "${Reply.slice(0, 60)}". Is this an MX-8A control port?`,
        };
      }
      Sent = true;
      const Line = await Ask(Built.Command);
      const Parsed = ParseReply(Line);
      if (!Parsed) {
        return {
          Success: false,
          Error: /^NG\b/i.test(Line)
            ? 'The unit did not recognise the command.'
            : `Unexpected reply "${Line.slice(0, 60)}"`,
        };
      }
      const Refused = Object.entries(Parsed.Values).find(([, V]) => IsError(V));
      if (Refused) {
        return {
          Success: false,
          Error: `The unit refused ${Refused[0]} (${DescribeError(Refused[1])}).`,
        };
      }
      return { Success: true, Detail: Built.Detail };
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
  if (/[\r\n]/.test(Config.Password)) {
    return { Success: false, Error: 'The password cannot contain line breaks' };
  }
  const Built = BuildActionCommand(ActionID, Params || {});
  if (!Built.Ok) return { Success: false, Error: Built.Error };
  return SendUnitCommand(Config, Built);
}

function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  const Action = Actions.find((A) => A.ID === ActionID);
  if (!Action) return null;
  if (!Action.Params) return Action.Label;
  const Channel = String(Params.Channel == null ? '' : Params.Channel).trim();
  return Channel ? `${Action.Label} ${Channel}` : null;
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
      Note(`Failed to reach the MX-8A control port on TCP ${Config.Port}`) +
      '</div>'
    );
  }
  if (Result.Login === 'busy') {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(
        'Another controller (MX Connect or a control system) holds the unit’s only control connection. The unit answered, so it is online, but its settings could not be read.'
      ) +
      '</div>'
    );
  }
  if (Result.Login !== 'ok') {
    return (
      Rows(Head) +
      '<div class="mt-2">' +
      Note(
        Result.Login === 'refused'
          ? `The unit refused the password${Result.LoginReply ? `: "${String(Result.LoginReply)}"` : ''}`
          : Result.LoginReply
            ? `The device answered "${String(Result.LoginReply)}", not as an MX-8A control port`
            : 'The device answered, but not as an MX-8A control port'
      ) +
      '</div>'
    );
  }

  const Outputs = Array.isArray(Result.TestToneOutputs) ? (Result.TestToneOutputs as number[]) : [];
  const ToneText =
    Result.TestTone == null
      ? 'Not read'
      : Result.TestTone
        ? Outputs.length
          ? `On (output${Outputs.length === 1 ? '' : 's'} ${Outputs.join(', ')})`
          : 'On'
        : 'Off';
  const Body = [
    ...Head,
    Result.Model ? TextRow('Model', String(Result.Model)) : null,
    Result.DeviceName ? TextRow('Device name', String(Result.DeviceName)) : null,
    Result.Firmware ? TextRow('Firmware', FormatFirmware(String(Result.Firmware))) : null,
    Result.Serial ? TextRow('Serial', String(Result.Serial)) : null,
    Result.SampleRate ? TextRow('Sample rate', `${Number(Result.SampleRate) / 1000} kHz`) : null,
    Options.CheckTestTone
      ? Row('Test tone', Pill(Result.TestTone ? 'warning' : 'success', ToneText))
      : TextRow('Test tone', ToneText),
  ];

  let MutesHtml = '';
  if (Options.CheckMutes && Options.Channels.length) {
    const Readings = Array.isArray(Result.Mutes) ? (Result.Mutes as MuteReading[]) : null;
    if (!Readings) {
      MutesHtml = Note('Mutes not read');
    } else {
      MutesHtml = Readings.map((Reading) => {
        const Ok = Reading.Muted === false;
        const Badge =
          Reading.Muted == null
            ? Pill('danger', 'Not read')
            : Pill(Ok ? 'success' : 'warning', Ok ? 'Unmuted' : 'Muted');
        return Card({
          Title: ChannelLabel(Reading),
          Badge,
          Highlight: Ok,
          BodyHtml: Reading.Error
            ? `<div class="text-muted small text-break">${Esc(Reading.Error)}</div>`
            : '',
        });
      }).join('');
    }
    MutesHtml = `<div class="mt-2 d-grid gap-1">${MutesHtml}</div>`;
  }

  return Rows(Body) + MutesHtml;
}

export const Name = 'TASCAM MX-8A';
export const Description =
  'Logs in to a TASCAM MX-8A matrix mixer on its Ethernet control port (TCP 54726) and confirms it answers, reading its model, firmware, serial number and sample rate — read-only. Reports Degraded while the test tone is on, and optionally while listed inputs, mix buses or outputs are muted.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  NextReplyLine,
  SplitParams,
  ParseReply,
  FormatFirmware,
  EvaluateHealth,
  QueryUnit,
  BuildActionCommand,
  MeterToDb,
  LiveSessions,
};
export {
  ID,
  Settings,
  Actions,
  Run,
  RunAction,
  DescribeAction,
  Debug,
  HasLiveLevels,
  StartLiveLevels,
};
