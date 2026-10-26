// TASCAM MX-8A matrix mixer health over TEAC's RS-232C/ETHERNET protocol
// ("TASCAM MX-8A/DCP Series ... protocol specifications", v1.00): plain text on
// TCP 54726 (fixed), every command and reply ending in CR+LF. One short-lived
// session per probe, one command in flight at a time:
//
//   1. CR+LF                → `Enter Password`, then the password (blank when
//                             none is set) + CR+LF → `Login Successful`. A unit
//                             that already has a controller connected answers
//                             `Another User Already Connected` and hangs up.
//   2. `GET DEVICE/MODELNAME DEVICE/NAME DEVICE/VER/SYSTEM DEVICE/SERIAL
//       DEVICE/SAMPLE TESTTONE/ENABLE`
//                           → `OK GET DEVICE/MODELNAME:"MX-8A" ...`, one
//                             `Key:Value` per key asked; a key the unit cannot
//                             answer reads `Key:ERR<n>`.
//   3. `GET ANLGOUT/<n>/TESTTONE ...` for outputs 1-8, only while the test tone is
//      on, to say which outputs it is reaching.
//   4. `GET ANLGIN/<n>/MUTE MIX/<n>/MUTE ANLGOUT/<n>/MUTE ...` for the listed
//      channels. Channel names come from the check's settings, not the unit.
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
  MonitoringTileWidget,
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
// The unit's noise floor sits around −95 to −98 dBFS; below this reads as silence.
const DEFAULT_SILENCE_DB = -90;
// Fader range per the spec: −∞, or −127.0 to +10.0 dB in 0.1 dB steps.
const FADER_MIN_DB = -127;
const FADER_MAX_DB = 10;

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
    Label: 'Inputs that must not be muted',
    // Checkboxes. Checks saved before 3.29.0 hold bare numbers ([3]), which the
    // field reads as this group's channels; new saves store IDs ('in:3').
    Type: 'channels',
    Groups: [
      {
        Prefix: 'in',
        Label: 'Inputs',
        Count: CHANNELS,
        ItemDefault: 'Channel {n}',
        NamesKey: 'InputLabels',
      },
    ],
    Default: [],
    VisibleWhen: { Key: 'CheckMutes', Equals: true },
    Note: 'Tick each input that should never be muted. The check reads Degraded while any ticked one is.',
  },
  {
    Key: 'MonitoredMixes',
    Label: 'Mix buses that must not be muted',
    // Checkboxes. Checks saved before 3.29.0 hold bare numbers ([3]), which the
    // field reads as this group's channels; new saves store IDs ('mix:3').
    Type: 'channels',
    Groups: [
      {
        Prefix: 'mix',
        Label: 'Mix buses',
        Count: CHANNELS,
        ItemDefault: 'Mix {n}',
        NamesKey: 'MixLabels',
      },
    ],
    Default: [],
    VisibleWhen: { Key: 'CheckMutes', Equals: true },
    Note: 'Tick each mix bus that should never be muted. The check reads Degraded while any ticked one is.',
  },
  {
    Key: 'MonitoredOutputs',
    Label: 'Outputs that must not be muted',
    // Checkboxes. Checks saved before 3.29.0 hold bare numbers ([3]), which the
    // field reads as this group's channels; new saves store IDs ('out:3').
    Type: 'channels',
    Groups: [
      {
        Prefix: 'out',
        Label: 'Outputs',
        Count: CHANNELS,
        ItemDefault: 'Output {n}',
        NamesKey: 'OutputLabels',
      },
    ],
    Default: [],
    VisibleWhen: { Key: 'CheckMutes', Equals: true },
    Note: 'Tick each output that should never be muted. The check reads Degraded while any ticked one is.',
  },
  {
    Key: 'ReadLevels',
    Label: 'Show live input levels',
    Type: 'boolean',
    Default: false,
    Note: 'Shows the eight input meters (pre-fader) in the monitor view while it is open. While they are showing, ShowTrak holds the unit’s only control connection, so MX Connect or a control system cannot connect.',
  },
  {
    Key: 'InputControl',
    Label: 'Live input control',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'ReadLevels', Equals: true },
    Note: 'Adds a fader and a mute button to each input in the monitor view. Changes are sent to the unit straight away, with no confirmation.',
  },
  {
    Key: 'ReadOutputLevels',
    Label: 'Show live output levels',
    Type: 'boolean',
    Default: false,
    Note: 'Shows the eight output meters in the monitor view while it is open. While they are showing, ShowTrak holds the unit’s only control connection, so MX Connect or a control system cannot connect.',
  },
  {
    Key: 'OutputControl',
    Label: 'Live output control',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'ReadOutputLevels', Equals: true },
    Note: 'Adds a fader and a mute button to each output in the monitor view. Changes are sent to the unit straight away, with no confirmation.',
  },
  {
    Key: 'ShowTileLevels',
    Label: 'Show levels on the tile',
    Type: 'boolean',
    Default: false,
    Note: 'Shows the chosen channels’ meters at the bottom of the monitor’s dashboard tile, when this is the monitor’s only check. The dashboard is usually open, so ShowTrak then holds the unit’s only control connection almost all the time: MX Connect or a control system cannot connect.',
  },
  {
    Key: 'TileChannels',
    Label: 'Channels on the tile',
    Type: 'channels',
    Groups: [
      {
        Prefix: 'in',
        Label: 'Inputs',
        Count: CHANNELS,
        ItemDefault: 'Channel {n}',
        NamesKey: 'InputLabels',
      },
      {
        Prefix: 'mix',
        Label: 'Mix buses',
        Count: CHANNELS,
        ItemDefault: 'Mix {n}',
        NamesKey: 'MixLabels',
      },
      {
        Prefix: 'out',
        Label: 'Outputs',
        Count: CHANNELS,
        ItemDefault: 'Output {n}',
        NamesKey: 'OutputLabels',
      },
    ],
    Default: ['out:1', 'out:2'],
    VisibleWhen: { Key: 'ShowTileLevels', Equals: true },
    Note: 'Tick the channels whose meters the tile shows, e.g. outputs 1 and 2 for a main left and right. Up to three fit one to a line; more go two to a line.',
  },
  {
    Key: 'SilenceBelowDb',
    Label: 'Treat as silence below (dBFS)',
    Type: 'number',
    Default: DEFAULT_SILENCE_DB,
    Min: -127,
    Max: 0,
    Note: 'A meter below this reads as −∞ and an empty bar, so the unit’s noise floor (around −95 dBFS) does not flicker. Applies to the monitor view and the tile.',
  },
  {
    Key: 'InputLabels',
    Label: 'Input names',
    Type: 'names',
    Count: CHANNELS,
    ItemDefault: 'Channel {n}',
    Default: [],
    Note: 'A name for each input, used throughout ShowTrak: the meters, the tile and the check’s messages. Leave a box blank for the default. The unit is not changed.',
  },
  {
    Key: 'MixLabels',
    Label: 'Mix bus names',
    Type: 'names',
    Count: CHANNELS,
    ItemDefault: 'Mix {n}',
    Default: [],
    Note: 'A name for each mix bus, used throughout ShowTrak: the meters, the tile and the check’s messages. Leave a box blank for the default. The unit is not changed.',
  },
  {
    Key: 'OutputLabels',
    Label: 'Output names',
    Type: 'names',
    Count: CHANNELS,
    ItemDefault: 'Output {n}',
    Default: [],
    Note: 'A name for each output, used throughout ShowTrak: the meters, the tile and the check’s messages. Leave a box blank for the default. The unit is not changed.',
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

// The names set in ShowTrak, number → name per channel kind. Pure; exported via
// _internal.
function ParseLabelOverrides(
  Target: MonitoringTargetLike
): Record<ChannelKind, Map<number, string>> {
  const Cfg = (Target && Target.Settings) || {};
  // One entry per channel, by position (a 'names' setting); blank = default.
  const Parse = (List: unknown) => {
    const Out = new Map<number, string>();
    (Array.isArray(List) ? List : []).slice(0, CHANNELS).forEach((Raw, I) => {
      const Name = String(Raw == null ? '' : Raw).trim();
      if (Name) Out.set(I + 1, Name.slice(0, 64));
    });
    return Out;
  };
  return {
    input: Parse(Cfg.InputLabels),
    mix: Parse(Cfg.MixLabels),
    output: Parse(Cfg.OutputLabels),
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
        // A channel ID ('in:3', from the checkboxes) or a bare number (saved
        // before the checkboxes, when these were typed lists).
        const Text_ = String(Raw == null ? '' : Raw).trim();
        const Match = /^(?:([a-z]+):)?(\d+)$/.exec(Text_);
        const N = Match && (!Match[1] || Match[1] === ID_PREFIX[Kind]) ? Number(Match[2]) : NaN;
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
 * line that answers a command, skipping blank lines and pushed NOTIFY / METER
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
 * `OK GET Key:Value ...` / `OK SET [Key:ERR<n> ...]`. The spec's own error example
 * also shows the reply without the leading OK (`GET Key:ERR1`), and one GET
 * example answered `OK SET`, so both are accepted. Null for anything else,
 * including `NG ...` (command not recognised).
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
    }
  } catch (Err) {
    if (!(Err instanceof UnexpectedReply)) throw Err;
    Snapshot.Incomplete = `${Err.message} during ${Stage}`;
  }
}

async function QueryUnit(Config: MxConfig, Channels: MonitoredChannel[]): Promise<MxProbe> {
  // While live levels are showing, this server already holds the unit's only
  // connection, so the reads ride on it (between meter lines) instead of being
  // turned away as "Another User Already Connected". One still connecting is
  // waited for rather than raced.
  const Key = LiveKey(Config);
  const Ask = await LiveAskFor(Key, Config.TimeoutMs);
  if (Ask) return QueryOverLive(Config, Ask.Ask, Ask.Live, Channels);
  return OnUnit(Key, () => {
    // A live session may have come up while this waited its turn.
    const Live = LiveForUnit(Key);
    if (Live && Live.Ask) return QueryOverLive(Config, Live.Ask, Live, Channels);
    return QueryOwnSession(Config, Channels);
  });
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

// The reasons a reachable unit is unhealthy, per the enabled options. Pure;
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
  const Overrides = ParseLabelOverrides(Target);
  for (const Reading of Snapshot.Mutes || []) {
    Reading.Name = Overrides[Reading.Kind].get(Reading.Channel) ?? Reading.Name;
  }
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
// While someone is watching (the monitor's view with Show live input / output
// levels on, or a dashboard tile with Show output levels on the tile), one
// connection per unit is held open (see src/main/monitoring-live.ts):
//
//   1. GET ANLGIN/1..8/METER/PRE MIX/1..8/METER ANLGOUT/1..8/METER
//                                     what the meter switches were, to put back
//   2. GET .../FADER, .../MUTE        fader and mute state, for live control
//   3. SET ...:ON                     pre-fader input, mix bus and output meters on
//   4. SET METER/TOTAL:10000 METER/INTERVAL:100, again every 5 s: the unit sends
//      `METER ANLGIN/<n>/METER/PRE:<hex> ... MIX/<n>/METER ... ANLGOUT/<n>/METER:<hex>` every 100 ms
//      for TOTAL ms after each.
//
// Inputs, mix buses and outputs are always metered together: they arrive on the
// same line, so the extra groups cost nothing, and checks on the same unit that want
// different groups share the one connection the unit allows. Each subscriber's
// frames carry only the groups its own check asks for.
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

// The metered channels, in display order: inputs 1-8, mix buses 1-8, then
// outputs 1-8. ID is what the tile picker stores and the monitor view sends back
// to move a fader ('in:3', 'mix:1', 'out:1').
interface MeterChannel {
  ID: string;
  Group: 'Inputs' | 'Mixes' | 'Outputs';
  Kind: ChannelKind;
  Number: number;
  MeterKey: string;
  FaderKey: string;
  MuteKey: string;
}

const GROUP_OF: Record<ChannelKind, MeterChannel['Group']> = {
  input: 'Inputs',
  mix: 'Mixes',
  output: 'Outputs',
};
const ID_PREFIX: Record<ChannelKind, string> = { input: 'in', mix: 'mix', output: 'out' };

function MeterChannelFor(Kind: ChannelKind, N: number): MeterChannel {
  const Prefix = KIND_PREFIX[Kind];
  return {
    ID: `${ID_PREFIX[Kind]}:${N}`,
    Group: GROUP_OF[Kind],
    Kind,
    Number: N,
    MeterKey: Kind === 'input' ? `${Prefix}/${N}/METER/PRE` : `${Prefix}/${N}/METER`,
    FaderKey: `${Prefix}/${N}/FADER`,
    MuteKey: `${Prefix}/${N}/MUTE`,
  };
}

const METER_CHANNELS: MeterChannel[] = [
  ...Array.from({ length: CHANNELS }, (_, I) => MeterChannelFor('input', I + 1)),
  ...Array.from({ length: CHANNELS }, (_, I) => MeterChannelFor('mix', I + 1)),
  ...Array.from({ length: CHANNELS }, (_, I) => MeterChannelFor('output', I + 1)),
];
const METER_INDEX = new Map(METER_CHANNELS.map((C, I) => [C.MeterKey, I]));
const FADER_INDEX = new Map(METER_CHANNELS.map((C, I) => [C.FaderKey, I]));
const MUTE_INDEX = new Map(METER_CHANNELS.map((C, I) => [C.MuteKey, I]));
const ID_INDEX = new Map(METER_CHANNELS.map((C, I) => [C.ID, I]));

// What one subscriber's check asks to see. Pure; exported via _internal.
export interface LevelsWanted {
  Inputs: boolean;
  Outputs: boolean;
  // Channel IDs shown on the dashboard tile; empty when the tile shows none.
  TileChannels: string[];
  // Faders and mutes offered in the monitor view, per group.
  InputControl: boolean;
  OutputControl: boolean;
  // Meters below this read as silence.
  SilenceBelowDb: number;
  Labels: Record<ChannelKind, Map<number, string>>;
}

function ParseLevelsWanted(Target: MonitoringTargetLike): LevelsWanted {
  const Cfg = (Target && Target.Settings) || {};
  // Known channels only, in display order whatever order they were stored in.
  const Picked = new Set(
    (Array.isArray(Cfg.TileChannels) ? Cfg.TileChannels : []).map((V) => String(V))
  );
  const TileChannels =
    Cfg.ShowTileLevels === true
      ? METER_CHANNELS.filter((C) => Picked.has(C.ID)).map((C) => C.ID)
      : [];
  const Silence = Number(Cfg.SilenceBelowDb);
  return {
    Inputs: Cfg.ReadLevels === true,
    Outputs: Cfg.ReadOutputLevels === true,
    TileChannels,
    // Control needs its group's levels showing: the faders live on those rows.
    InputControl: Cfg.ReadLevels === true && Cfg.InputControl === true,
    OutputControl: Cfg.ReadOutputLevels === true && Cfg.OutputControl === true,
    SilenceBelowDb:
      Cfg.SilenceBelowDb != null && Cfg.SilenceBelowDb !== '' && Number.isFinite(Silence)
        ? Math.min(0, Math.max(FADER_MIN_DB, Silence))
        : DEFAULT_SILENCE_DB,
    Labels: ParseLabelOverrides(Target),
  };
}

interface LiveSession {
  Key: string;
  Config: MxConfig;
  Subscribers: Map<(Frame: LiveLevelsFrame) => void, LevelsWanted>;
  // Set while logged in and metering; serialised, safe to share.
  Ask: ((Command: string) => Promise<string>) | null;
  // Per METER_CHANNELS entry.
  Levels: Array<number | null>;
  // Fader in dB (null = −∞) and mute, from GET at the start, NOTIFY and the
  // periodic refresh; undefined until read.
  Faders: Array<number | null | undefined>;
  Mutes: Array<boolean | undefined>;
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
  // Set while nobody is subscribed: the session is kept this long in case a
  // viewer comes straight back (a settings save restarts every stream).
  LingerTimer: ReturnType<typeof setTimeout> | null;
  // Reconnect at once rather than after LIVE_RETRY_MS (the password changed).
  RetrySoon: boolean;
  // The current connection, settled once it has closed.
  Connection: Promise<void> | null;
}

// --- One unit, one connection ---------------------------------------------------------
//
// The unit accepts a single TCP connection, so everything this method opens to
// it is arranged around that:
//   - one live session per unit (address + port), shared by every check and
//     viewer on it, and kept for UNIT_LINGER_MS after the last one leaves;
//   - checks and actions ride on the live session when there is one, wait for
//     it while it is connecting, and otherwise take turns (OnUnit);
//   - a new connection waits for a closing live session to finish putting the
//     meters back, and for any check or action in flight.
// Without this a settings save, which stops a stream and starts its successor,
// turned the successor away as "Another User Already Connected".

const UNIT_LINGER_MS = 1500;
// After one of our connections to a unit closes, the unit takes a moment to let
// it go; connecting again sooner is turned away as "Another User Already
// Connected" (seen on CI against a local socket, and expected of the real unit).
const UNIT_RELEASE_MS = 1000;
// A turned-away connection (another session of ours was still closing, or a
// controller briefly connected) tries again sooner than other failures.
const BUSY_RETRY_MS = 1500;

const LiveSessions = new Map<string, LiveSession>();
// Per unit: the closing live connection, and the queue of checks and actions.
const Closing = new Map<string, Promise<void>>();
const UnitQueues = new Map<string, Promise<unknown>>();
// Per unit: when our last connection to it closed.
const LastClosedAt = new Map<string, number>();

function MarkUnitReleased(Key: string): void {
  LastClosedAt.set(Key, Date.now());
}

// Wait out UNIT_RELEASE_MS since our last connection to the unit closed.
async function WaitForUnitRelease(Key: string): Promise<void> {
  const At = LastClosedAt.get(Key);
  const Wait = At == null ? 0 : At + UNIT_RELEASE_MS - Date.now();
  if (Wait > 0) await new Promise((Resolve) => setTimeout(Resolve, Wait));
}

function LiveKey(Config: MxConfig): string {
  return `${Config.Address.toLowerCase()}|${Config.Port}`;
}

function LiveForUnit(Key: string): LiveSession | null {
  const Live = LiveSessions.get(Key);
  return Live && !Live.Stopped ? Live : null;
}

// The live connection to ride on: at once if logged in, after waiting (up to
// BudgetMs) if it is still connecting, or null when there is none to use.
async function LiveAskFor(
  Key: string,
  BudgetMs: number
): Promise<{ Live: LiveSession; Ask: (Command: string) => Promise<string> } | null> {
  const Deadline = Date.now() + Math.max(500, BudgetMs | 0);
  for (;;) {
    const Live = LiveForUnit(Key);
    if (!Live) return null;
    if (Live.Ask) return { Live, Ask: Live.Ask };
    if (Live.State !== 'connecting' || Date.now() >= Deadline) return null;
    await new Promise((Resolve) => setTimeout(Resolve, 50));
  }
}

// Run Fn with the unit to itself: after earlier checks and actions on it, and
// after a closing live connection has gone.
function OnUnit<T>(Key: string, Fn: () => Promise<T>): Promise<T> {
  const Before = UnitQueues.get(Key) || Promise.resolve();
  const Run = Before.then(() => Closing.get(Key))
    .then(() => WaitForUnitRelease(Key))
    .then(Fn)
    .finally(() => MarkUnitReleased(Key));
  const Tail = Run.catch(() => undefined);
  UnitQueues.set(Key, Tail);
  void Tail.then(() => {
    if (UnitQueues.get(Key) === Tail) UnitQueues.delete(Key);
  });
  return Run;
}

// What a channel is called until it is named in the check's settings.
function DefaultLabel(Channel: MeterChannel): string {
  const Word =
    Channel.Group === 'Inputs' ? 'Channel' : Channel.Group === 'Mixes' ? 'Mix' : 'Output';
  return `${Word} ${Channel.Number}`;
}

// `<hex>` → dBFS to 0.1 dB; null for silence or anything unreadable.
function MeterToDb(Value: string): number | null {
  if (!/^[0-9a-f]{1,8}$/i.test(Value)) return null;
  const Linear = parseInt(Value, 16);
  if (!(Linear > 0)) return null;
  return Math.round(200 * Math.log10(Linear / FULL_SCALE)) / 10;
}

// `-INF` → null, `-6.0` / `+3.5` → dB; undefined for anything else.
function ParseFader(Value: string | undefined): number | null | undefined {
  if (Value == null) return undefined;
  if (/^-INF$/i.test(Value.trim())) return null;
  const N = Number(Value);
  return Number.isFinite(N) ? N : undefined;
}

// Fader and mute values out of a GET reply or a NOTIFY line.
function ApplyControlValues(Live: LiveSession, Values: Record<string, string>): void {
  for (const [Key, Value] of Object.entries(Values)) {
    const Fader = FADER_INDEX.get(Key);
    if (Fader != null) {
      const Db = ParseFader(Value);
      if (Db !== undefined) Live.Faders[Fader] = Db;
      continue;
    }
    const Mute = MUTE_INDEX.get(Key);
    if (Mute != null) {
      const Muted = OnOff(Value);
      if (Muted != null) Live.Mutes[Mute] = Muted;
    }
  }
}

function ApplyMeterLine(Live: LiveSession, Line: string): void {
  if (/^NOTIFY\b/i.test(Line)) {
    // Someone moved a fader or mute (MX Connect is locked out, but the unit's
    // front panel, GPI and wall controllers are not).
    const Parsed = ParseReply(Line.replace(/^NOTIFY/i, 'GET'));
    if (Parsed) ApplyControlValues(Live, Parsed.Values);
    return;
  }
  if (!/^METER\b/i.test(Line)) return;
  let Any = false;
  for (const Param of SplitParams(Line.replace(/^METER\s*/i, ''))) {
    const Colon = Param.indexOf(':');
    if (Colon <= 0) continue;
    const Index = METER_INDEX.get(Param.slice(0, Colon).toUpperCase());
    if (Index == null) continue;
    Live.Levels[Index] = MeterToDb(Param.slice(Colon + 1));
    Any = true;
  }
  if (Any) {
    Live.LastMeterAt = Date.now();
    Live.State = 'live';
    Live.Message = null;
  }
}

// The frame one subscriber sees: the groups its monitor view shows (marked View)
// and the channels its tile shows (marked Tile); nothing else.
function LiveFrame(Live: LiveSession, Wanted: LevelsWanted): LiveLevelsFrame {
  const Stale = Live.State === 'live' && Date.now() - Live.LastMeterAt > LIVE_STALE_MS;
  const Showing = Live.State === 'live' && !Stale;
  const Channels: LiveLevelsFrame['Channels'] = [];
  METER_CHANNELS.forEach((Channel, I) => {
    const OnTile = Wanted.TileChannels.includes(Channel.ID);
    const InView =
      Channel.Group === 'Inputs'
        ? Wanted.Inputs
        : Channel.Group === 'Outputs'
          ? Wanted.Outputs
          : false;
    if (!InView && !OnTile) return;
    const Raw = Showing ? (Live.Levels[I] ?? null) : null;
    const Control =
      InView && (Channel.Group === 'Inputs' ? Wanted.InputControl : Wanted.OutputControl);
    Channels.push({
      ID: Channel.ID,
      Group: Channel.Group,
      Label: Wanted.Labels[Channel.Kind].get(Channel.Number) || DefaultLabel(Channel),
      Db: Raw != null && Raw < Wanted.SilenceBelowDb ? null : Raw,
      ...(InView ? { View: true } : {}),
      ...(OnTile ? { Tile: true } : {}),
      ...(Control
        ? {
            Control: true,
            ...(Live.Faders[I] !== undefined ? { Fader: Live.Faders[I] as number | null } : {}),
            ...(Live.Mutes[I] !== undefined ? { Muted: Live.Mutes[I] as boolean } : {}),
          }
        : {}),
    });
  });
  return {
    State: Stale ? 'unavailable' : Live.State,
    Message: Stale ? 'The unit stopped sending levels' : Live.Message,
    Channels,
  };
}

function EmitLive(Live: LiveSession): void {
  for (const [Send, Wanted] of Live.Subscribers) {
    try {
      Send(LiveFrame(Live, Wanted));
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
  void (async () => {
    // Wait for the unit: a closing live connection, and checks or actions in
    // flight, would each turn this one away.
    await Closing.get(Live.Key);
    await UnitQueues.get(Live.Key);
    await WaitForUnitRelease(Live.Key);
    if (Live.Stopped) return;
    RunLiveConnection(Live);
  })();
}

function RunLiveConnection(Live: LiveSession): void {
  const Connection = RunMxSession<void>({
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
      const MeterKeys = METER_CHANNELS.map((C) => C.MeterKey);
      const Before = await GetValues(Ask, MeterKeys);
      const RefreshControls = async () => {
        ApplyControlValues(
          Live,
          await GetValues(
            Ask,
            METER_CHANNELS.map((C) => C.FaderKey)
          )
        );
        ApplyControlValues(
          Live,
          await GetValues(
            Ask,
            METER_CHANNELS.map((C) => C.MuteKey)
          )
        );
      };
      await RefreshControls();
      const Renew = `SET METER/TOTAL:${LIVE_METER_TOTAL_MS} METER/INTERVAL:${LIVE_METER_INTERVAL_MS}`;
      const Restore = async () => {
        Live.Ask = null;
        await Ask('SET METER/TOTAL:0');
        const WasOff = MeterKeys.filter((Key) => OnOff(Before[Key]) === false);
        if (WasOff.length) await Ask(`SET ${WasOff.map((Key) => `${Key}:OFF`).join(' ')}`);
      };
      await Ask(`SET ${MeterKeys.map((Key) => `${Key}:ON`).join(' ')}`);
      await Ask(Renew);
      if (Live.Stopped) return Restore();

      Live.Ask = Ask;
      let Release: () => void = () => undefined;
      const Released = new Promise<void>((Resolve) => (Release = Resolve));
      Live.End = Release;
      // The renew keeps meters flowing; the refresh catches a fader or mute moved
      // where the unit sends no NOTIFY.
      const RenewTimer = setInterval(() => {
        Ask(Renew)
          .then(RefreshControls)
          .catch(() => undefined);
      }, LIVE_RENEW_MS);
      if (typeof RenewTimer.unref === 'function') RenewTimer.unref();
      await Released;
      clearInterval(RenewTimer);
      // Ended by RestartLive / the last viewer: put the meters back. Ended by the
      // connection dropping: these throw SessionEnded and nothing is sent.
      return Restore();
    },
  }).then(() => {
    MarkUnitReleased(Live.Key);
    Live.Ask = null;
    // A dropped connection leaves its wait pending; release it so its renew
    // timer stops (its restore then fails quietly on the closed session).
    if (Live.End) Live.End();
    Live.End = null;
    Live.Cancel = null;
    if (Live.Stopped) return;
    // A deliberate reconnect (a corrected password) is not a problem to show.
    if (Live.State !== 'unavailable' && !Live.RetrySoon) {
      SetLiveProblem(Live, 'The unit closed the connection');
    }
    const Delay = Live.RetrySoon ? 0 : Live.Message === BUSY_ERROR ? BUSY_RETRY_MS : LIVE_RETRY_MS;
    Live.RetrySoon = false;
    Live.RetryTimer = setTimeout(() => {
      Live.RetryTimer = null;
      if (Live.Stopped) return;
      Live.State = 'connecting';
      Live.Message = null;
      ConnectLive(Live);
    }, Delay);
    if (typeof Live.RetryTimer.unref === 'function') Live.RetryTimer.unref();
  });
  Live.Connection = Connection;
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
  if (Live.LingerTimer) clearTimeout(Live.LingerTimer);
  Live.LingerTimer = null;
  // Until the connection has closed (meters put back), the next one waits.
  if (Live.Connection) {
    const Done: Promise<void> = Live.Connection.then(() => {
      if (Closing.get(Live.Key) === Done) Closing.delete(Live.Key);
    });
    Closing.set(Live.Key, Done);
  }
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

// The monitor view shows levels for this check.
function HasLiveLevels(Target: MonitoringTargetLike): boolean {
  const Wanted = ParseLevelsWanted(Target);
  return Wanted.Inputs || Wanted.Outputs;
}

// The dashboard tile shows levels for this check (when it is its monitor's only one).
function GetTileWidget(Target: MonitoringTargetLike): MonitoringTileWidget | null {
  return ParseLevelsWanted(Target).TileChannels.length ? { Kind: 'levels' } : null;
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
      Subscribers: new Map(),
      Ask: null,
      Levels: METER_CHANNELS.map(() => null),
      Faders: METER_CHANNELS.map(() => undefined),
      Mutes: METER_CHANNELS.map(() => undefined),
      LastMeterAt: 0,
      State: 'connecting',
      Message: null,
      Stopped: false,
      Cancel: null,
      End: null,
      RetryTimer: null,
      FrameTimer: null,
      LingerTimer: null,
      RetrySoon: false,
      Connection: null,
    };
    Created.FrameTimer = setInterval(() => EmitLive(Created), LIVE_FRAME_MS);
    if (typeof Created.FrameTimer.unref === 'function') Created.FrameTimer.unref();
    LiveSessions.set(Key, Created);
    ConnectLive(Created);
    Live = Created;
  }
  const Session = Live;
  // Back before the linger ran out (e.g. the settings were just saved).
  if (Session.LingerTimer) clearTimeout(Session.LingerTimer);
  Session.LingerTimer = null;
  // A corrected password replaces one the unit refused; a working connection is
  // kept whatever the newcomer's settings say.
  if (!Session.Ask && Config.Password !== Session.Config.Password) {
    Session.Config = Config;
    Session.RetrySoon = true;
    if (Session.RetryTimer) {
      clearTimeout(Session.RetryTimer);
      Session.RetryTimer = null;
      Session.State = 'connecting';
      Session.Message = null;
      ConnectLive(Session);
    } else RestartLive(Session);
  }
  const Wanted = ParseLevelsWanted(Target);
  Session.Subscribers.set(OnFrame, Wanted);
  OnFrame(LiveFrame(Session, Wanted));
  return () => {
    if (!Session.Subscribers.delete(OnFrame)) return;
    if (Session.Subscribers.size || Session.Stopped) return;
    Session.LingerTimer = setTimeout(() => {
      Session.LingerTimer = null;
      if (!Session.Subscribers.size) StopLive(Session);
    }, UNIT_LINGER_MS);
    if (typeof Session.LingerTimer.unref === 'function') Session.LingerTimer.unref();
  };
}

// Move one channel's fader or mute from the monitor view. Rides on the held
// connection: there is no other while levels are showing.
async function SetLiveLevel(
  Target: MonitoringTargetLike,
  ChannelID: string,
  Change: { Fader?: number | null; Muted?: boolean }
): Promise<MonitoringActionResult> {
  const Index = ID_INDEX.get(String(ChannelID));
  if (Index == null) return { Success: false, Error: `Unknown channel "${String(ChannelID)}"` };
  const Channel = METER_CHANNELS[Index]!;
  const Wanted = ParseLevelsWanted(Target);
  if (Channel.Group === 'Mixes') {
    return {
      Success: false,
      Error: 'Mix buses are shown on the tile only; they have no live control.',
    };
  }
  const Allowed = Channel.Group === 'Inputs' ? Wanted.InputControl : Wanted.OutputControl;
  if (!Allowed) {
    return {
      Success: false,
      Error: `Live ${Channel.Group === 'Inputs' ? 'input' : 'output'} control is turned off for this check.`,
    };
  }
  let Command: string;
  let Detail: string;
  const Live = LiveSessions.get(LiveKey(ParseConfig(Target)));
  const Label = ChannelLabel({
    Kind: Channel.Kind,
    Channel: Channel.Number,
    Name: Wanted.Labels[Channel.Kind].get(Channel.Number) || null,
  });
  if (typeof Change.Muted === 'boolean' && Change.Fader === undefined) {
    Command = `SET ${Channel.MuteKey}:${Change.Muted ? 'ON' : 'OFF'}`;
    Detail = `${Label} ${Change.Muted ? 'muted' : 'unmuted'}`;
  } else if (Change.Muted === undefined && Change.Fader !== undefined) {
    const Db = Change.Fader;
    if (Db !== null && !(typeof Db === 'number' && Db >= FADER_MIN_DB && Db <= FADER_MAX_DB)) {
      return {
        Success: false,
        Error: `A fader level must be from ${FADER_MIN_DB} to +${FADER_MAX_DB} dB, or −∞.`,
      };
    }
    const Value =
      Db === null ? '-INF' : `${Db > 0 ? '+' : ''}${(Math.round(Db * 10) / 10).toFixed(1)}`;
    Command = `SET ${Channel.FaderKey}:${Value}`;
    Detail = `${Label} fader set to ${Db === null ? '−∞' : `${Value} dB`}`;
  } else {
    return { Success: false, Error: 'Send either a fader level or a mute, not both.' };
  }
  if (!Live || !Live.Ask) {
    return { Success: false, Error: 'Live levels are not connected to the unit.' };
  }
  let Line: string;
  let Timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const BudgetMs = Math.max(500, Live.Config.TimeoutMs | 0);
    const Answer = await Promise.race([
      Live.Ask(Command),
      new Promise<null>((Resolve) => (Timer = setTimeout(() => Resolve(null), BudgetMs))),
    ]);
    if (Answer === null) {
      // Whatever is stuck on the shared connection would hold up everything after it.
      RestartLive(Live);
      return {
        Success: false,
        Error: 'The unit did not answer in time. The change may or may not have been applied.',
      };
    }
    Line = Answer;
  } catch {
    return { Success: false, Error: 'The connection to the unit closed before it answered.' };
  } finally {
    if (Timer) clearTimeout(Timer);
  }
  const Parsed = ParseReply(Line);
  if (!Parsed || Parsed.Type !== 'SET') {
    return { Success: false, Error: `Unexpected reply "${Line.slice(0, 60)}"` };
  }
  const Refused = Object.entries(Parsed.Values).find(([, V]) => IsError(V));
  if (Refused) {
    return {
      Success: false,
      Error: `The unit refused ${Refused[0]} (${DescribeError(Refused[1])}).`,
    };
  }
  // Shown at once rather than after the next refresh.
  if (Change.Muted !== undefined) Live.Mutes[Index] = Change.Muted;
  else Live.Faders[Index] = Change.Fader ?? null;
  return { Success: true, Detail };
}

// --- Controllable actions ------------------------------------------------------------
//
// Each press opens its own session (same port, password and budget as the
// check), logs in, sends ONE documented SET and closes as soon as the unit
// answers `OK SET` (applied) or `OK SET Key:ERR<n>` / `NG ...` (refused):
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
      Icon: 'volume-mute',
      Group: MUTE_GROUPS[Kind],
      Destructive: true,
      Params: [ChannelParam(Kind)],
      Note: `Mutes one ${Noun.toLowerCase()} on the unit.`,
    },
    {
      ID: `${Kind}.unmute`,
      Label: `Unmute ${Noun}`,
      Icon: 'volume-up',
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

// Validate an action's parameters and build its one command. Pure; exported
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
      return InterpretSetReply(await Ask(Built.Command), Built);
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
  const Key = LiveKey(Config);
  const Ask = await LiveAskFor(Key, Config.TimeoutMs);
  if (Ask) return SendOverLive(Ask.Live, Ask.Ask, Built);
  return OnUnit(Key, () => {
    const Live = LiveForUnit(Key);
    if (Live && Live.Ask) return SendOverLive(Live, Live.Ask, Built);
    return SendUnitCommand(Config, Built);
  });
}

// An action on the held live connection: the unit allows no other.
async function SendOverLive(
  Live: LiveSession,
  Ask: (Command: string) => Promise<string>,
  Built: BuiltAction
): Promise<MonitoringActionResult> {
  let Timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const Line = await Promise.race([
      Ask(Built.Command),
      new Promise<null>((Resolve) => {
        Timer = setTimeout(() => Resolve(null), Math.max(500, Live.Config.TimeoutMs | 0));
      }),
    ]);
    if (Line === null) {
      RestartLive(Live);
      return {
        Success: false,
        Error: 'The unit did not answer in time. The command may or may not have been applied.',
      };
    }
    return InterpretSetReply(Line, Built);
  } catch {
    // A reboot drops the connection, possibly before it answers.
    if (Built.CloseMeansDone) return { Success: true, Detail: Built.Detail };
    return { Success: false, Error: 'The unit closed the connection before answering' };
  } finally {
    if (Timer) clearTimeout(Timer);
  }
}

// What the unit's answer to a SET means for an action.
function InterpretSetReply(Line: string, Built: BuiltAction): MonitoringActionResult {
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
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
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
  'Logs in to a TASCAM MX-8A matrix mixer on its Ethernet control port (TCP 54726) and confirms it answers, reading its model, firmware, serial number and sample rate (read-only). Reports Degraded while the test tone is on, and optionally while listed inputs, mix buses or outputs are muted.';
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
  ParseLevelsWanted,
  ParseLabelOverrides,
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
  GetTileWidget,
  StartLiveLevels,
  SetLiveLevel,
};
