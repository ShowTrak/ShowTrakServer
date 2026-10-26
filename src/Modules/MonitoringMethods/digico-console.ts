// DiGiCo SD / Quantum mixing console health over the console's OSC remote
// interface (the "DiGiCo Pad" external-control device the iPad app uses).
//
// Protocol (Bitfocus Companion's companion-module-digico-osc, whose command table
// was captured from consoles running the iPad v2 command files; DiGiCo has not
// published the iPad protocol itself):
//   - OSC over UDP. A query is the parameter address with "/?" appended and no
//     arguments, e.g. `/Console/Name/?`. The console answers with the parameter
//     address and its value, e.g. `/Console/Name ,s "SD12"`.
//   - The console sends every reply to the IP address and "Send" port set on the
//     DiGiCo Pad device in System > External Control, NOT to the port a query
//     came from. So this method listens on that fixed port; the operator must
//     add a DiGiCo Pad device pointing at ShowTrak and load the iPad command
//     file ("Commands Allowed"), or the console stays silent.
//   - Read here, all documented as readable (R) in that table:
//       /Console/Name                    string  console name
//       /Console/Session/Filename        string  loaded session file
//       /Console/Input_Channels          int     number of input channels
//       /Snapshots/Current_Snapshot      int     index of the current snapshot
//                                                (-1 when none)
//       /Input_Channels/N/mute           0 | 1   (sent as a float) 1 = muted
//       /Input_Channels/N/Channel_Input/name  string
//
// Design (mirrors x32-console.ts):
//   - UDP is lossy, so every unanswered query is re-sent on a short interval
//     until answered or the whole-probe budget (the configured Timeout) passes.
//     Reads are idempotent, so a duplicate is harmless.
//   - Replies are matched by OSC address, never by arrival order, and only from
//     the console's own IP.
//   - One process-wide UDP socket per listen port is shared by every DiGiCo
//     check (two consoles can feed the same port). Queries go out from that same
//     socket. Only Run() keeps it alive: a sweep closes a port nobody has probed
//     within MONITORING_INTEREST_TTL_MS.
//   - Run() never sets anything: it only sends "/?" queries. The operator
//     actions below are the only messages that change the console, and each is
//     sent ONCE (never re-sent like a query), after a query round has proved
//     the console is answering.
//
// Actions (same command table, both marked writable there):
//   /Snapshots/Recall_Snapshot/<index>   no arguments   recall that snapshot
//   /Input_Channels/N/mute               float 1 | 0    mute / unmute input N
// The snapshot index is the same list index /Snapshots/Current_Snapshot
// reports, not the number shown on the surface.
//
// Inferred, not documented: the "/?" query form and the reply shape come from
// Companion's module rather than from DiGiCo. Current_Snapshot is the snapshot's
// list index, not the number shown on the surface, so it is reported but not
// asserted on.
import dgram from 'dgram';
import dns from 'dns';
import net from 'net';
import { EncodeOscMessage, ParseOscPacket, type OscMessage } from './_osc-shared';
import { ErrorMessage } from './_tcp-session';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS, MONITORING_INTEREST_TTL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'digico-console';

export const DEFAULT_CONSOLE_PORT = 7001;
export const DEFAULT_LISTEN_PORT = 7000;
const DEFAULT_TIMEOUT_MS = 4000;
const MIN_RESEND_MS = 250;
const MAX_CHANNELS = 64;
const SWEEP_INTERVAL_MS = 30000;
const RETRY_COOLDOWN_MS = 5000;
// Pause before re-reading a mute that came back unchanged after an action.
const READBACK_RETRY_MS = 300;

const NAME_PATH = '/Console/Name';
const SESSION_PATH = '/Console/Session/Filename';
const INPUT_COUNT_PATH = '/Console/Input_Channels';
const SNAPSHOT_PATH = '/Snapshots/Current_Snapshot';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Console receive port',
    Type: 'number',
    Default: DEFAULT_CONSOLE_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'The Rcv port of the DiGiCo Pad device in External Control. ShowTrak sends its queries here.',
  },
  {
    Key: 'ListenPort',
    Label: 'Listen port',
    Type: 'number',
    Default: DEFAULT_LISTEN_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'The Send port of the same DiGiCo Pad device. The console sends its replies to this port on this computer, so it must not be used by another program here.',
  },
  {
    Key: 'CheckSession',
    Label: 'Check session',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different session file is loaded.',
  },
  {
    Key: 'ExpectedSession',
    Label: 'Expected session',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckSession', Equals: true },
    Note: 'The session file name. Not case-sensitive, and the file extension may be left off.',
  },
  {
    Key: 'CheckChannelMutes',
    Label: 'Check channel mutes',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while any listed input channel is muted.',
  },
  {
    Key: 'MonitoredChannels',
    Label: 'Input channels',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckChannelMutes', Equals: true },
    Note: 'Input channel numbers as shown on the console. Control group mutes are not reflected.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole probe, every query included.',
  },
];

// --- Config ---------------------------------------------------------------------

export interface DigicoConfig {
  Address: string;
  Port: number;
  ListenPort: number;
  TimeoutMs: number;
}

interface HealthOptions {
  CheckSession: boolean;
  ExpectedSession: string;
  CheckChannelMutes: boolean;
  Channels: number[];
}

function PortOr(Value: unknown, Fallback: number): number {
  const N = Number(Value);
  return Number.isFinite(N) && N > 0 ? Math.floor(N) : Fallback;
}

function ParseConfig(Target: MonitoringTargetLike): DigicoConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: PortOr(Cfg.Port, DEFAULT_CONSOLE_PORT),
    ListenPort: PortOr(Cfg.ListenPort, DEFAULT_LISTEN_PORT),
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

function ParseChannelList(Value: unknown): number[] {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Out: number[] = [];
  for (const Item of Raw) {
    const N = Number(String(Item == null ? '' : Item).trim());
    if (!Number.isInteger(N) || N < 1 || N > 999) continue;
    if (!Out.includes(N)) Out.push(N);
    if (Out.length >= MAX_CHANNELS) break;
  }
  return Out;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  return {
    CheckSession: Cfg.CheckSession === true,
    ExpectedSession: String(Cfg.ExpectedSession == null ? '' : Cfg.ExpectedSession).trim(),
    CheckChannelMutes: Cfg.CheckChannelMutes === true,
    Channels: ParseChannelList(Cfg.MonitoredChannels),
  };
}

// --- Address map / value helpers ----------------------------------------------------

function MutePath(Channel: number): string {
  return `/Input_Channels/${Channel}/mute`;
}

function ChannelNamePath(Channel: number): string {
  return `/Input_Channels/${Channel}/Channel_Input/name`;
}

// The query for a parameter: its address with "/?" appended and no arguments.
function QueryPacket(Path: string): Buffer {
  return EncodeOscMessage(`${Path}/?`);
}

// A mute value as a boolean (true = muted). Sent as a float; int and T/F are
// accepted defensively. Anything else is unknown.
function ParseMute(Arg: unknown): boolean | null {
  if (typeof Arg === 'boolean') return Arg;
  if (typeof Arg === 'number' && Number.isFinite(Arg)) return Arg >= 0.5;
  return null;
}

function ParseInt(Arg: unknown): number | null {
  return typeof Arg === 'number' && Number.isFinite(Arg) ? Math.trunc(Arg) : null;
}

// Session names compared without regard to case or file extension.
function NormalizeSession(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/, '');
}

export function NormalizeAddress(Address: unknown): string {
  return String(Address == null ? '' : Address)
    .trim()
    .replace(/^::ffff:/i, '')
    .toLowerCase();
}

// --- Shared receiver ------------------------------------------------------------------

type Handler = (Msg: OscMessage) => void;

interface PortListener {
  Port: number;
  Socket: dgram.Socket | null;
  State: 'binding' | 'ready' | 'failed';
  LastError: string | null;
  LastFailAt: number;
  LastInterestAt: number;
  // Waiters for the bind to finish.
  Ready: Array<(Error: string | null) => void>;
  // Probe handlers keyed by console source IP.
  Handlers: Map<string, Set<Handler>>;
}

class DigicoReceiverImpl {
  private Ports = new Map<number, PortListener>();
  private SweepTimer: NodeJS.Timeout | null = null;

  /**
   * Register interest in a listen port and wait for its socket. Resolves to
   * the socket, or to the reason it cannot listen.
   */
  Acquire(Port: number): Promise<{ Socket: dgram.Socket } | { Error: string }> {
    let Listener = this.Ports.get(Port);
    if (!Listener) {
      Listener = {
        Port,
        Socket: null,
        State: 'failed',
        LastError: null,
        LastFailAt: 0,
        LastInterestAt: Date.now(),
        Ready: [],
        Handlers: new Map(),
      };
      this.Ports.set(Port, Listener);
    }
    Listener.LastInterestAt = Date.now();
    this.EnsureSweep();
    const L = Listener;
    if (L.State === 'ready' && L.Socket) return Promise.resolve({ Socket: L.Socket });
    if (L.State === 'failed' && L.LastFailAt && Date.now() - L.LastFailAt < RETRY_COOLDOWN_MS) {
      return Promise.resolve({ Error: L.LastError || 'listen failed' });
    }
    return new Promise((Resolve) => {
      L.Ready.push((Err) =>
        Resolve(Err || !L.Socket ? { Error: Err || 'listen failed' } : { Socket: L.Socket })
      );
      if (L.State !== 'binding') this.Bind(L);
    });
  }

  Subscribe(Port: number, Source: string, H: Handler): () => void {
    const Listener = this.Ports.get(Port);
    if (!Listener) return () => {};
    let Set_ = Listener.Handlers.get(Source);
    if (!Set_) {
      Set_ = new Set();
      Listener.Handlers.set(Source, Set_);
    }
    Set_.add(H);
    return () => {
      const Current = Listener.Handlers.get(Source);
      if (!Current) return;
      Current.delete(H);
      if (!Current.size) Listener.Handlers.delete(Source);
    };
  }

  private Bind(Listener: PortListener): void {
    Listener.State = 'binding';
    Listener.LastError = null;
    const Settle = (Err: string | null): void => {
      const Waiters = Listener.Ready;
      Listener.Ready = [];
      for (const W of Waiters) W(Err);
    };
    let Sock: dgram.Socket;
    try {
      Sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (Err) {
      this.Fail(Listener, ErrorMessage(Err));
      Settle(Listener.LastError);
      return;
    }
    Listener.Socket = Sock;
    Sock.on('error', (Err: Error) => {
      if (Listener.Socket === Sock) {
        this.Fail(Listener, ErrorMessage(Err));
        Settle(Listener.LastError);
      }
      try {
        Sock.close();
      } catch {
        // already closing
      }
    });
    Sock.on('message', (Buf: Buffer, RInfo: dgram.RemoteInfo) => {
      const Handlers = Listener.Handlers.get(NormalizeAddress(RInfo && RInfo.address));
      if (!Handlers || !Handlers.size) return;
      for (const Msg of ParseOscPacket(Buf)) for (const H of Handlers) H(Msg);
    });
    Sock.on('listening', () => {
      if (Listener.Socket !== Sock) return;
      Listener.State = 'ready';
      Settle(null);
    });
    try {
      Sock.bind(Listener.Port);
      Sock.unref();
    } catch (Err) {
      this.Fail(Listener, ErrorMessage(Err));
      Settle(Listener.LastError);
    }
  }

  private Fail(Listener: PortListener, Message: string): void {
    Listener.LastError = Message;
    Listener.LastFailAt = Date.now();
    Listener.State = 'failed';
    Listener.Socket = null;
  }

  private EnsureSweep(): void {
    if (this.SweepTimer) return;
    this.SweepTimer = setInterval(() => this.Sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
  }

  // Close any port no probe has used within the interest TTL.
  Sweep(Now = Date.now()): void {
    for (const [Port, Listener] of this.Ports) {
      if (Now - Listener.LastInterestAt <= MONITORING_INTEREST_TTL_MS) continue;
      if (Listener.Socket) {
        try {
          Listener.Socket.close();
        } catch {
          // ignore
        }
      }
      this.Ports.delete(Port);
    }
    if (!this.Ports.size && this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
  }

  OpenPorts(): number[] {
    return Array.from(this.Ports.keys());
  }

  // Test-only teardown.
  Stop(): void {
    if (this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
    for (const Listener of this.Ports.values()) {
      if (Listener.Socket) {
        try {
          Listener.Socket.close();
        } catch {
          // ignore
        }
      }
    }
    this.Ports.clear();
  }
}

const DigicoReceiver = new DigicoReceiverImpl();

// --- Probe ------------------------------------------------------------------------

export interface DigicoChannelState {
  Channel: number;
  // False when the console reported fewer input channels than this number.
  Supported: boolean;
  Name: string | null;
  // true = muted, false = unmuted, null = not read.
  Muted: boolean | null;
}

export interface DigicoSnapshot {
  LatencyMs: number;
  ConsoleName: string | null;
  Session: string | null;
  InputCount: number | null;
  CurrentSnapshot: number | null;
  Channels: DigicoChannelState[];
}

export type DigicoProbeOutcome =
  { Reachable: true; Snapshot: DigicoSnapshot } | { Reachable: false; Error: string };

export interface DigicoProbeWants {
  Channels: number[];
}

async function ResolveAddress(Address: string, BudgetMs: number): Promise<string> {
  // The shared listener is udp4, so an IPv6 console could never be reached.
  if (net.isIP(Address) === 6) throw new Error('Use the console’s IPv4 address');
  if (net.isIP(Address)) return NormalizeAddress(Address);
  const Lookup = dns.promises.lookup(Address, { family: 4 }).then((R) => R.address);
  const Timer = new Promise<never>((_, Reject) =>
    setTimeout(
      () => Reject(new Error(`DNS lookup timed out after ${BudgetMs}ms`)),
      BudgetMs
    ).unref()
  );
  return NormalizeAddress(await Promise.race([Lookup, Timer]));
}

export async function QueryDigico(
  Config: DigicoConfig,
  Wants: DigicoProbeWants
): Promise<DigicoProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const ResendMs = Math.max(MIN_RESEND_MS, Math.floor(BudgetMs / 4));
  const StartedAt = Date.now();
  const Remaining = (): number => Math.max(0, BudgetMs - (Date.now() - StartedAt));

  let Source: string;
  try {
    Source = await ResolveAddress(Config.Address, BudgetMs);
  } catch (Err) {
    return { Reachable: false, Error: ErrorMessage(Err) };
  }

  const Acquired = await Promise.race([
    DigicoReceiver.Acquire(Config.ListenPort),
    new Promise<{ Error: string }>((Resolve) =>
      setTimeout(() => Resolve({ Error: 'timed out' }), Remaining()).unref()
    ),
  ]);
  if ('Error' in Acquired) {
    return {
      Reachable: false,
      Error: `Cannot listen on UDP port ${Config.ListenPort}: ${Acquired.Error}`,
    };
  }
  const Socket = Acquired.Socket;

  return new Promise<DigicoProbeOutcome>((Resolve) => {
    const Snap: DigicoSnapshot = {
      LatencyMs: 0,
      ConsoleName: null,
      Session: null,
      InputCount: null,
      CurrentSnapshot: null,
      Channels: Wants.Channels.map((Channel) => ({
        Channel,
        Supported: true,
        Name: null,
        Muted: null,
      })),
    };
    let Settled = false;
    let FirstReplyAt: number | null = null;
    const SentAt = Date.now();
    const Pending = new Set<string>([NAME_PATH, SESSION_PATH, SNAPSHOT_PATH]);
    if (Wants.Channels.length) Pending.add(INPUT_COUNT_PATH);
    for (const Channel of Wants.Channels) {
      Pending.add(MutePath(Channel));
      Pending.add(ChannelNamePath(Channel));
    }
    let ResendTimer: ReturnType<typeof setInterval> | null = null;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let Unsubscribe: () => void = () => {};

    const Finish = (Outcome: DigicoProbeOutcome): void => {
      if (Settled) return;
      Settled = true;
      if (ResendTimer) clearInterval(ResendTimer);
      if (DeadlineTimer) clearTimeout(DeadlineTimer);
      Unsubscribe();
      Resolve(Outcome);
    };

    const Reached = (): DigicoProbeOutcome => {
      Snap.LatencyMs = (FirstReplyAt ?? Date.now()) - SentAt;
      for (const C of Snap.Channels) {
        if (Snap.InputCount != null && C.Channel > Snap.InputCount) C.Supported = false;
      }
      return { Reachable: true, Snapshot: Snap };
    };

    const Send = (Path: string): void => {
      if (Settled) return;
      try {
        Socket.send(QueryPacket(Path), Config.Port, Source);
      } catch {
        // A send on a closed socket is ended by the deadline.
      }
    };

    const OnMessage = (Msg: OscMessage): void => {
      if (Settled || !Pending.has(Msg.Address) || !Msg.Args.length) return;
      const Arg = Msg.Args[0];
      if (Msg.Address === NAME_PATH) {
        if (typeof Arg === 'string') Snap.ConsoleName = Arg.trim() || null;
      } else if (Msg.Address === SESSION_PATH) {
        if (typeof Arg === 'string') Snap.Session = Arg.trim() || null;
      } else if (Msg.Address === INPUT_COUNT_PATH) {
        Snap.InputCount = ParseInt(Arg);
        // Channels past the console's count will never answer: stop waiting.
        for (const C of Snap.Channels) {
          if (Snap.InputCount == null || C.Channel <= Snap.InputCount) continue;
          Pending.delete(MutePath(C.Channel));
          Pending.delete(ChannelNamePath(C.Channel));
        }
      } else if (Msg.Address === SNAPSHOT_PATH) {
        Snap.CurrentSnapshot = ParseInt(Arg);
      } else {
        const Match = /^\/Input_Channels\/(\d+)\/(mute|Channel_Input\/name)$/.exec(Msg.Address);
        if (!Match) return;
        const Entry = Snap.Channels.find((C) => C.Channel === Number(Match[1]));
        if (Entry) {
          if (Match[2] === 'mute') Entry.Muted = ParseMute(Arg);
          else if (typeof Arg === 'string') Entry.Name = Arg.trim() || null;
        }
      }
      Pending.delete(Msg.Address);
      if (FirstReplyAt == null) FirstReplyAt = Date.now();
      if (!Pending.size) Finish(Reached());
    };

    Unsubscribe = DigicoReceiver.Subscribe(Config.ListenPort, Source, OnMessage);

    DeadlineTimer = setTimeout(
      () => {
        if (FirstReplyAt != null) {
          Finish(Reached());
          return;
        }
        Finish({
          Reachable: false,
          Error: `No reply from the console within ${BudgetMs}ms. Check that External Control has an enabled DiGiCo Pad device for this computer's IP address, with Send port ${Config.ListenPort} and Rcv port ${Config.Port}, and the iPad command file loaded.`,
        });
      },
      Math.max(1, Remaining())
    );

    for (const Path of Pending) Send(Path);
    ResendTimer = setInterval(() => {
      for (const Path of Pending) Send(Path);
    }, ResendMs);
  });
}

// --- Evaluation -----------------------------------------------------------------

function ChannelLabel(State: DigicoChannelState): string {
  return State.Name ? `Ch ${State.Channel} (${State.Name})` : `Ch ${State.Channel}`;
}

// The reasons a reachable console is unhealthy, per the enabled toggles. Pure;
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: DigicoSnapshot, Options: HealthOptions): string[] {
  const Reasons: string[] = [];

  if (Options.CheckSession && Options.ExpectedSession) {
    if (Snapshot.Session == null) Reasons.push('Session not reported');
    else if (NormalizeSession(Snapshot.Session) !== NormalizeSession(Options.ExpectedSession)) {
      Reasons.push(`Session "${Snapshot.Session}" (expected "${Options.ExpectedSession}")`);
    }
  }

  if (Options.CheckChannelMutes) {
    for (const Channel of Options.Channels) {
      const State = Snapshot.Channels.find((C) => C.Channel === Channel) || {
        Channel,
        Supported: true,
        Name: null,
        Muted: null,
      };
      if (!State.Supported) Reasons.push(`Ch ${Channel}: not on this console`);
      else if (State.Muted === true) Reasons.push(`${ChannelLabel(State)}: muted`);
      else if (State.Muted == null)
        Reasons.push(`${ChannelLabel(State)}: failed to read mute state`);
    }
  }
  return Reasons;
}

// Shared by Run and RunAction: the reason a config cannot be used, or null.
function ValidateConfig(Config: DigicoConfig): string | null {
  if (!Config.Address) return 'No address configured';
  for (const P of [Config.Port, Config.ListenPort]) {
    if (P < 1 || P > 65535) return `Invalid port: ${P}`;
  }
  return null;
}

// --- Actions -------------------------------------------------------------------------
//
// Params carry no Default, Min or Max on purpose: the shared normaliser would
// otherwise turn a missing or out-of-range number into a real snapshot or
// channel instead of letting RunAction refuse it.

const CHANNEL_PARAM: MonitoringSettingField = {
  Key: 'Channel',
  Label: 'Input channel',
  Type: 'number',
  Required: true,
  Note: 'The input channel number as shown on the console.',
};

const Actions: MonitoringActionDef[] = [
  {
    ID: 'snapshot.fire',
    Label: 'Fire Snapshot',
    Icon: 'collection-play',
    Group: 'Snapshots',
    Destructive: true,
    Params: [
      {
        Key: 'Snapshot',
        Label: 'Snapshot index',
        Type: 'number',
        Required: true,
        Note: 'The snapshot’s position in the console’s list, the same number this check shows as Current snapshot. It is not the number shown on the surface.',
      },
    ],
    Note: 'Recalls the snapshot at that position in the list. Sent once.',
  },
  {
    ID: 'mute.on',
    Label: 'Mute Input',
    Icon: 'mic-mute',
    Group: 'Mute',
    Destructive: true,
    Params: [CHANNEL_PARAM],
    Note: 'Mutes one input channel, then reads the mute back to confirm it.',
  },
  {
    ID: 'mute.off',
    Label: 'Unmute Input',
    Icon: 'mic',
    Group: 'Mute',
    Params: [CHANNEL_PARAM],
    Note: 'Unmutes one input channel. Control group mutes still apply.',
  },
];

// A whole number in [Min, Max], or null. Accepts numeric strings (OSC values).
function ParseWhole(Value: unknown, Min: number, Max: number): number | null {
  if (Value == null || Value === '' || typeof Value === 'boolean') return null;
  const N = Number(typeof Value === 'string' ? Value.trim() : Value);
  return Number.isInteger(N) && N >= Min && N <= Max ? N : null;
}

function SnapshotRecallPacket(Index: number): Buffer {
  return EncodeOscMessage(`/Snapshots/Recall_Snapshot/${Index}`);
}

// The table types mute as a float, so it is always sent as one (1.0 / 0.0).
function MuteSetPacket(Channel: number, Mute: boolean): Buffer {
  return EncodeOscMessage(MutePath(Channel), [{ Float: Mute ? 1 : 0 }]);
}

// Send one packet to the console from the shared listen socket (the same
// source a DiGiCo Pad device expects). Exactly one datagram: never re-sent.
export async function SendDigico(Config: DigicoConfig, Packet: Buffer): Promise<string | null> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  let Destination: string;
  try {
    Destination = await ResolveAddress(Config.Address, BudgetMs);
  } catch (Err) {
    return ErrorMessage(Err);
  }
  const Acquired = await DigicoReceiver.Acquire(Config.ListenPort);
  if ('Error' in Acquired) return `Cannot use UDP port ${Config.ListenPort}: ${Acquired.Error}`;
  return new Promise<string | null>((Resolve) => {
    try {
      Acquired.Socket.send(Packet, Config.Port, Destination, (Err) =>
        Resolve(Err ? ErrorMessage(Err) : null)
      );
    } catch (Err) {
      Resolve(ErrorMessage(Err));
    }
  });
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  const ConfigError = ValidateConfig(Config);
  if (ConfigError) return { Success: false, Error: ConfigError };

  if (ActionID === 'snapshot.fire') {
    const Index = ParseWhole(Params && Params.Snapshot, 0, 9999);
    if (Index == null) return { Success: false, Error: 'Snapshot index must be 0 to 9999' };
    // A UDP send cannot fail on its own, so prove the console is answering
    // first; otherwise the press would report success to a silent desk.
    const Pre = await QueryDigico(Config, { Channels: [] });
    if (!Pre.Reachable) return { Success: false, Error: `${Pre.Error} Nothing was sent.` };
    const SendError = await SendDigico(Config, SnapshotRecallPacket(Index));
    if (SendError) return { Success: false, Error: SendError };
    return { Success: true, Detail: `Snapshot ${Index} fired` };
  }

  if (ActionID === 'mute.on' || ActionID === 'mute.off') {
    const Channel = ParseWhole(Params && Params.Channel, 1, 999);
    if (Channel == null) return { Success: false, Error: 'Input channel must be a whole number' };
    const Mute = ActionID === 'mute.on';
    const Pre = await QueryDigico(Config, { Channels: [Channel] });
    if (!Pre.Reachable) return { Success: false, Error: `${Pre.Error} Nothing was sent.` };
    const Before = Pre.Snapshot.Channels[0];
    if (Before && !Before.Supported) {
      return {
        Success: false,
        Error: `Ch ${Channel} is not on this console (it has ${Pre.Snapshot.InputCount} inputs)`,
      };
    }
    const SendError = await SendDigico(Config, MuteSetPacket(Channel, Mute));
    if (SendError) return { Success: false, Error: SendError };
    // Read the mute back. Only a definite opposite answer is a failure; a lost
    // read-back still reports what was sent. A reply to one of the first
    // round's re-sent queries can still be in flight carrying the OLD state,
    // so a mismatch is read once more after a pause before it counts.
    const ReadBack = async (): Promise<DigicoChannelState | undefined> => {
      const Post = await QueryDigico(Config, { Channels: [Channel] });
      return Post.Reachable ? Post.Snapshot.Channels[0] : undefined;
    };
    let After = await ReadBack();
    if (After && After.Muted != null && After.Muted !== Mute) {
      await new Promise((Res) => setTimeout(Res, READBACK_RETRY_MS));
      After = await ReadBack();
    }
    const Label = ChannelLabel(
      After || Before || { Channel, Supported: true, Name: null, Muted: null }
    );
    if (After && After.Muted != null && After.Muted !== Mute) {
      return {
        Success: false,
        Error: `The console still reports ${Label} as ${After.Muted ? 'muted' : 'unmuted'}. Check that the iPad command file under Commands Allowed permits mute changes.`,
      };
    }
    return { Success: true, Detail: `${Label} ${Mute ? 'muted' : 'unmuted'}` };
  }

  return { Success: false, Error: `Unknown DiGiCo action "${ActionID}"` };
}

// Bind the snapshot or channel into a favourite's label.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID === 'snapshot.fire') {
    const Index = ParseWhole(Params && Params.Snapshot, 0, 9999);
    return Index == null ? null : `Fire Snapshot (index ${Index})`;
  }
  if (ActionID === 'mute.on' || ActionID === 'mute.off') {
    const Channel = ParseWhole(Params && Params.Channel, 1, 999);
    if (Channel == null) return null;
    return `${ActionID === 'mute.on' ? 'Mute' : 'Unmute'} Ch ${Channel}`;
  }
  return null;
}

// --- Run / Debug --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const ConfigError = ValidateConfig(Config);
  if (ConfigError) return { Success: false, Error: ConfigError };
  const Options = ParseHealthOptions(Target);

  let Outcome: DigicoProbeOutcome;
  try {
    Outcome = await QueryDigico(Config, {
      Channels: Options.CheckChannelMutes ? Options.Channels : [],
    });
  } catch (Err) {
    return { Success: false, Error: ErrorMessage(Err) };
  }
  if (!Outcome.Reachable) return { Success: false, Error: Outcome.Error };

  const Snap = Outcome.Snapshot;
  const Reasons = EvaluateHealth(Snap, Options);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    ConsoleName: Snap.ConsoleName,
    Session: Snap.Session,
    InputCount: Snap.InputCount,
    CurrentSnapshot: Snap.CurrentSnapshot,
    Channels: Snap.Channels,
  };
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Snapshot =
    Result && typeof Result.CurrentSnapshot === 'number' ? Result.CurrentSnapshot : null;

  const Head = Rows([
    TextRow(
      'Host',
      `${Config.Address || '-'}:${Config.Port} (replies to port ${Config.ListenPort})`
    ),
    Reachable && Result.ConsoleName ? TextRow('Console', String(Result.ConsoleName)) : null,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the console'),
    Reachable && Result.Session != null
      ? TextRow(
          'Session',
          String(Result.Session) +
            (Options.CheckSession && Options.ExpectedSession
              ? ` (expected ${Options.ExpectedSession})`
              : '')
        )
      : null,
    Reachable && Snapshot != null
      ? TextRow('Current snapshot', Snapshot < 0 ? 'None' : `Index ${Snapshot}`)
      : null,
    Reachable && typeof Result.InputCount === 'number'
      ? TextRow('Input channels', String(Result.InputCount))
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `The console only replies to a DiGiCo Pad device configured in External Control, sending to this computer on port ${Config.ListenPort}.`
      ) +
      '</div>'
    );
  }

  const Channels = Array.isArray(Result.Channels) ? (Result.Channels as DigicoChannelState[]) : [];
  if (!Options.CheckChannelMutes || !Channels.length) return Head;
  const Cards = Channels.map((C) =>
    Card({
      Title: ChannelLabel(C),
      Badge: !C.Supported
        ? Pill('warning', 'Not on this console')
        : C.Muted === false
          ? Pill('success', 'On')
          : C.Muted === true
            ? Pill('warning', 'Muted')
            : Pill('muted', 'No reply'),
    })
  ).join('');
  return Head + `<div class="d-grid gap-1 mt-2">${Cards}</div>`;
}

export const Name = 'DiGiCo SD / Quantum';
export const Description =
  'Queries a DiGiCo SD or Quantum console over its DiGiCo Pad OSC interface for the console name, loaded session and current snapshot. Optionally flags a different session or muted input channels. The check itself only sends queries; snapshot recall and input mute are separate operator actions.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseChannelList,
  ParseMute,
  NormalizeSession,
  QueryPacket,
  SnapshotRecallPacket,
  MuteSetPacket,
  ParseWhole,
  EvaluateHealth,
  QueryDigico,
  DigicoReceiver,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
