// d&b audiotechnik DS100 / DS100M Signal Engine (the d&b Soundscape processor:
// En-Scene and En-Space) health over the device's OSC remote interface.
//
// Protocol (d&b "OSC Protocol document for DS100", DOC05325 v1.3.12):
//   - OSC 1.0 over UDP. The DS100 listens on port 50010 and sends its replies
//     to port 50011 (3 "Description"). The d&b Soundscape DAW plug-in
//     (dbaudio-soundscape/db-Soundscape-DAW-Plugins, Controller.cpp) confirms
//     the reading: it sends to 50010 and binds 50011 as "UDP port to which the
//     DS100 will send OSC replies". So this method listens on that fixed port.
//   - Every address starts `/dbaudio1`. An address sent with no arguments is a
//     READ; the device answers with the same address and the value (3.1).
//   - Read here (all marked readable in the document):
//       /settings/devicename            ,s   device name (4.1)
//       /fixed/firmwareversion          ,s   "DS100 V3.02.02" (4.2; added in
//                                            v1.3.12 of the document, so older
//                                            firmware may not answer it)
//       /error/gnrlerr                  ,i   0 = no error, 1 = general error (4.3)
//       /error/errortext                ,s   error string (4.3)
//       /status/statustext              ,s   status string (4.4)
//       /status/audionetworksamplestatus ,i  4 = 48 kHz, 6 = 96 kHz, 1 = not in
//                                            sync / unsupported rate (4.4)
//       /status/matrixinputcount        ,i   licensed inputs (4.4; DS100 V3.00.01+)
//       /status/matrixoutputcount       ,i   licensed outputs (4.4; DS100 V3.00.01+)
//       /scene/sceneindex               ,s   "major.minor" (4.14)
//       /scene/scenename                ,s   name of the loaded scene (4.14)
//       /matrixsettings/reverbroomid    ,i   En-Space room, 0 = off (4.9; only
//                                            with the En-Space option)
//       /matrixoutput/mute/N            ,i   0 = unmuted, 1 = muted (4.7)
//       /matrixoutput/channelname/N     ,s   output name (4.7)
//
// Design (mirrors digico-console.ts, which has the same fixed reply port):
//   - One process-wide UDP socket per reply port, shared by every DS100 check.
//     Queries go out from that same socket, so the replies come back to it
//     whichever way the device addresses them. Only Run() keeps it alive: a
//     sweep closes a port nobody has probed within MONITORING_INTEREST_TTL_MS.
//   - The socket binds the port exclusively. Another OSC controller on this
//     computer that already holds 50011 (the Soundscape plug-in, Companion's
//     d&b DSP module, a second ShowTrak) makes the check fail with a clear
//     reason instead of silently taking the replies from that controller.
//   - UDP is lossy, so every unanswered query is re-sent on a short interval
//     until it is answered or the whole-probe budget (the configured Timeout)
//     passes. Reads are idempotent, so a duplicate is harmless. Replies are
//     matched by address, only from the device's own IP.
//   - Firmware, matrix size, scene and En-Space room are "optional" reads: on
//     firmware or licences without them the device stays silent, so they are
//     never waited for unless a check asks to assert on them.
//
// Actions (4.14, all writes; scenes are created in d&b R1):
//   /scene/recall ,i major | ,ii major minor   recall that scene
//   /scene/next, /scene/previous               no arguments
// /device/clear (factory reset) is deliberately not offered.
//
// Inferred, not documented: the sceneindex reply is typed ,s "major.minor" but
// the document's example shows `777 95`, so a string with a dot or a blank, two
// ints, or one int are all accepted. Status text and error text contents are
// not enumerated anywhere, so they are reported verbatim and never matched.
import dgram from 'dgram';
import dns from 'dns';
import net from 'net';
import { EncodeOscMessage, ParseOscPacket, type OscArg, type OscMessage } from './_osc-shared';
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

const ID = 'dbaudio-ds100';

export const DEFAULT_DEVICE_PORT = 50010;
export const DEFAULT_REPLY_PORT = 50011;
const DEFAULT_TIMEOUT_MS = 4000;
const MIN_RESEND_MS = 250;
const MAX_OUTPUTS = 64;
// After every required read is in, how long to keep listening for the
// optional ones (firmware, matrix size, scene, room) that older firmware or a
// missing licence never answers.
const OPTIONAL_GRACE_MS = 150;
const SWEEP_INTERVAL_MS = 30000;
const RETRY_COOLDOWN_MS = 5000;
// Pauses before reading the scene back after a recall. A scene load is not
// instant, so a second read follows if the first still shows the old scene.
const READBACK_DELAYS_MS = [300, 1000];

const PREFIX = '/dbaudio1';
const DEVICE_NAME_PATH = `${PREFIX}/settings/devicename`;
const FIRMWARE_PATH = `${PREFIX}/fixed/firmwareversion`;
const GENERAL_ERROR_PATH = `${PREFIX}/error/gnrlerr`;
const ERROR_TEXT_PATH = `${PREFIX}/error/errortext`;
const STATUS_TEXT_PATH = `${PREFIX}/status/statustext`;
const SAMPLE_STATUS_PATH = `${PREFIX}/status/audionetworksamplestatus`;
const INPUT_COUNT_PATH = `${PREFIX}/status/matrixinputcount`;
const OUTPUT_COUNT_PATH = `${PREFIX}/status/matrixoutputcount`;
const SCENE_INDEX_PATH = `${PREFIX}/scene/sceneindex`;
const SCENE_NAME_PATH = `${PREFIX}/scene/scenename`;
const ROOM_PATH = `${PREFIX}/matrixsettings/reverbroomid`;
const SCENE_RECALL_PATH = `${PREFIX}/scene/recall`;
const SCENE_NEXT_PATH = `${PREFIX}/scene/next`;
const SCENE_PREVIOUS_PATH = `${PREFIX}/scene/previous`;

// The En-Space rooms the document lists for reverbroomid (4.9).
export const ENSPACE_ROOMS: Record<number, string> = {
  0: 'Off',
  1: 'Modern – small (Blaibach Concert Hall)',
  2: 'Classic – small (Schubert-Saal, Vienna Concert Hall)',
  3: 'Modern – medium (Angelika-Kauffmann-Saal, Schwarzenberg)',
  4: 'Classic – medium (Mozart-Saal, Vienna Concert Hall)',
  5: 'Modern – large (KKL Luzern)',
  6: 'Classic – large (Großer Saal, Vienna Concert Hall)',
  7: 'Modern – medium (Bing Concert Hall, Stanford)',
  8: 'Theatre – small (Alighieri Theatre, Ravenna)',
  9: 'Cathedral (San Vitale, Ravenna)',
  101: 'Custom room 1',
  102: 'Custom room 2',
  103: 'Custom room 3',
};

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'OSC port',
    Type: 'number',
    Default: DEFAULT_DEVICE_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'The DS100 listens for OSC on UDP 50010.',
  },
  {
    Key: 'CheckError',
    Label: 'Check error state',
    Type: 'boolean',
    Default: true,
    Note: 'Enable to report Degraded while the DS100 raises its general error flag.',
  },
  {
    Key: 'CheckSync',
    Label: 'Check audio network sync',
    Type: 'boolean',
    Default: true,
    Note: 'Enable to report Degraded while the audio network is not in sync or runs at an unsupported sample rate.',
  },
  {
    Key: 'CheckName',
    Label: 'Check device name',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different DS100 answers on this address.',
  },
  {
    Key: 'ExpectedName',
    Label: 'Expected device name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckName', Equals: true },
    Note: 'The device name set in d&b R1. Not case-sensitive.',
  },
  {
    Key: 'CheckScene',
    Label: 'Check scene',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different scene is loaded.',
  },
  {
    Key: 'ExpectedScene',
    Label: 'Expected scene',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckScene', Equals: true },
    Note: 'The scene number as shown in R1, e.g. 7 or 12.05. Give the minor number as two digits.',
  },
  {
    Key: 'CheckRoom',
    Label: 'Check En-Space room',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different En-Space room is selected. Needs the En-Space option.',
  },
  {
    Key: 'ExpectedRoom',
    Label: 'Expected En-Space room',
    Type: 'select',
    Default: '0',
    Options: Object.entries(ENSPACE_ROOMS).map(([value, label]) => ({ value, label })),
    VisibleWhen: { Key: 'CheckRoom', Equals: true },
  },
  {
    Key: 'CheckOutputMutes',
    Label: 'Check output mutes',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while any listed matrix output is muted.',
  },
  {
    Key: 'MonitoredOutputs',
    Label: 'Matrix outputs',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: { Key: 'CheckOutputMutes', Equals: true },
    Note: 'Matrix output numbers: 1–24 or 1–64, depending on the licence.',
  },
  {
    Key: 'ReplyPort',
    Label: 'Reply port',
    Type: 'number',
    Default: DEFAULT_REPLY_PORT,
    Min: 1,
    Max: 65535,
    Advanced: true,
    Note: 'The DS100 sends its replies to UDP 50011 on this computer, so no other program here may use that port.',
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

export interface Ds100Config {
  Address: string;
  Port: number;
  ReplyPort: number;
  TimeoutMs: number;
}

export interface SceneIndex {
  Major: number;
  Minor: number;
}

interface HealthOptions {
  CheckError: boolean;
  CheckSync: boolean;
  CheckName: boolean;
  ExpectedName: string;
  CheckScene: boolean;
  ExpectedScene: SceneIndex | null;
  ExpectedSceneRaw: string;
  CheckRoom: boolean;
  ExpectedRoom: number | null;
  CheckOutputMutes: boolean;
  Outputs: number[];
}

function PortOr(Value: unknown, Fallback: number): number {
  const N = Number(Value);
  return Number.isFinite(N) && N > 0 ? Math.floor(N) : Fallback;
}

function ParseConfig(Target: MonitoringTargetLike): Ds100Config {
  const Cfg = (Target && Target.Settings) || {};
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: PortOr(Cfg.Port, DEFAULT_DEVICE_PORT),
    ReplyPort: PortOr(Cfg.ReplyPort, DEFAULT_REPLY_PORT),
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

// Unique output numbers in the order given. Numbers past the licensed size are
// kept: only the probe knows the size, and EvaluateHealth says so by name.
function ParseOutputList(Value: unknown): number[] {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Out: number[] = [];
  for (const Item of Raw) {
    const N = Number(String(Item == null ? '' : Item).trim());
    if (!Number.isInteger(N) || N < 1 || N > 999) continue;
    if (!Out.includes(N)) Out.push(N);
    if (Out.length >= MAX_OUTPUTS) break;
  }
  return Out;
}

function ParseRoomId(Value: unknown): number | null {
  if (Value == null || Value === '' || typeof Value === 'boolean') return null;
  const N = Number(typeof Value === 'string' ? Value.trim() : Value);
  return Number.isInteger(N) && N >= 0 && N <= 103 ? N : null;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const SceneRaw = String(Cfg.ExpectedScene == null ? '' : Cfg.ExpectedScene).trim();
  return {
    // Error and sync default ON: a stored check from before they existed, or a
    // target with no settings, still gets the device's own fault reporting.
    CheckError: Cfg.CheckError !== false,
    CheckSync: Cfg.CheckSync !== false,
    CheckName: Cfg.CheckName === true,
    ExpectedName: String(Cfg.ExpectedName == null ? '' : Cfg.ExpectedName).trim(),
    CheckScene: Cfg.CheckScene === true,
    ExpectedScene: ParseSceneText(SceneRaw),
    ExpectedSceneRaw: SceneRaw,
    CheckRoom: Cfg.CheckRoom === true,
    ExpectedRoom: ParseRoomId(Cfg.ExpectedRoom == null ? '0' : Cfg.ExpectedRoom),
    CheckOutputMutes: Cfg.CheckOutputMutes === true,
    Outputs: ParseOutputList(Cfg.MonitoredOutputs),
  };
}

// --- Value helpers ------------------------------------------------------------------

function OutputMutePath(Output: number): string {
  return `${PREFIX}/matrixoutput/mute/${Output}`;
}

function OutputNamePath(Output: number): string {
  return `${PREFIX}/matrixoutput/channelname/${Output}`;
}

function ParseIntArg(Arg: unknown): number | null {
  return typeof Arg === 'number' && Number.isFinite(Arg) ? Math.trunc(Arg) : null;
}

// A 0/1 switch as a boolean. Documented as int32; float and T/F accepted.
function ParseSwitch(Arg: unknown): boolean | null {
  if (typeof Arg === 'boolean') return Arg;
  if (typeof Arg === 'number' && Number.isFinite(Arg)) return Arg >= 0.5;
  return null;
}

function ParseText(Arg: unknown): string | null {
  return typeof Arg === 'string' ? Arg.trim() : null;
}

function InRange(Major: number, Minor: number): boolean {
  return (
    Number.isInteger(Major) &&
    Number.isInteger(Minor) &&
    Major >= 0 &&
    Major <= 999 &&
    Minor >= 0 &&
    Minor <= 99
  );
}

// "7", "7.00", "777.95" or "777 95" as a scene index. The minor part is read
// as written ("12.05" = minor 5, "12.5" = minor 5 too), so the setting's note
// asks for two digits. Null for anything else.
function ParseSceneText(Text: unknown): SceneIndex | null {
  const S = String(Text == null ? '' : Text).trim();
  const M = /^(\d{1,3})(?:\s*[.\s]\s*(\d{1,2}))?$/.exec(S);
  if (!M) return null;
  const Major = Number(M[1]);
  const Minor = M[2] == null ? 0 : Number(M[2]);
  return InRange(Major, Minor) ? { Major, Minor } : null;
}

// The sceneindex reply. Typed ,s "major.minor" in the document, whose example
// nevertheless shows two values, so two ints and a single int are accepted.
function ParseSceneReply(Args: Array<string | number | boolean>): SceneIndex | null {
  const [First, Second] = Args;
  if (typeof First === 'string') return ParseSceneText(First);
  if (typeof First === 'number' && Number.isInteger(First)) {
    const Minor = typeof Second === 'number' && Number.isInteger(Second) ? Second : 0;
    return InRange(First, Minor) ? { Major: First, Minor } : null;
  }
  return null;
}

function FormatScene(Scene: SceneIndex | null | undefined): string {
  if (!Scene) return '-';
  return `${Scene.Major}.${Scene.Minor < 10 ? '0' : ''}${Scene.Minor}`;
}

function SameScene(A: SceneIndex | null, B: SceneIndex | null): boolean {
  return !!A && !!B && A.Major === B.Major && A.Minor === B.Minor;
}

function RoomLabel(Room: number | null | undefined): string {
  if (Room == null) return '-';
  return ENSPACE_ROOMS[Room] || `Room ${Room}`;
}

function SampleRateLabel(Status: number | null | undefined): string {
  if (Status === 4) return '48 kHz';
  if (Status === 6) return '96 kHz';
  if (Status === 1) return 'Not in sync';
  return Status == null ? '-' : `Status ${Status}`;
}

// "DS100 V3.02.02" split into the device type and the version.
function ParseFirmware(Text: string | null): { Model: string | null; Version: string | null } {
  if (!Text) return { Model: null, Version: null };
  const M = /^(\S+)\s+(.+)$/.exec(Text.trim());
  if (!M) return { Model: null, Version: Text.trim() || null };
  return { Model: M[1] || null, Version: M[2]!.trim() || null };
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
  Ready: Array<(Error: string | null) => void>;
  // Probe handlers keyed by the device's source IP.
  Handlers: Map<string, Set<Handler>>;
}

class Ds100ReceiverImpl {
  private Ports = new Map<number, PortListener>();
  private SweepTimer: NodeJS.Timeout | null = null;

  /**
   * Register interest in a reply port and wait for its socket. Resolves to the
   * socket, or to the reason it cannot listen.
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
      // No reuseAddr: when another controller on this computer already holds
      // the port, binding must fail rather than split the replies with it.
      Sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    } catch (Err) {
      this.Fail(Listener, ErrorMessage(Err));
      Settle(Listener.LastError);
      return;
    }
    Listener.Socket = Sock;
    Sock.on('error', (Err: NodeJS.ErrnoException) => {
      if (Listener.Socket === Sock) {
        const InUse = Err && Err.code === 'EADDRINUSE';
        this.Fail(
          Listener,
          InUse
            ? `port ${Listener.Port} is already in use by another program on this computer (another OSC controller such as the Soundscape plug-in or Companion)`
            : ErrorMessage(Err)
        );
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

const Ds100Receiver = new Ds100ReceiverImpl();

// --- Probe ------------------------------------------------------------------------

export interface Ds100OutputState {
  Output: number;
  // False when the device reported fewer matrix outputs than this number.
  Supported: boolean;
  Name: string | null;
  // true = muted, false = unmuted, null = not read.
  Muted: boolean | null;
}

export interface Ds100Snapshot {
  LatencyMs: number;
  DeviceName: string | null;
  Firmware: string | null;
  GeneralError: boolean | null;
  ErrorText: string | null;
  StatusText: string | null;
  SampleStatus: number | null;
  InputCount: number | null;
  OutputCount: number | null;
  Scene: SceneIndex | null;
  SceneName: string | null;
  Room: number | null;
  Outputs: Ds100OutputState[];
}

export type Ds100ProbeOutcome =
  { Reachable: true; Snapshot: Ds100Snapshot } | { Reachable: false; Error: string };

export interface Ds100ProbeWants {
  // Wait for the scene (index and name) rather than taking it if it comes.
  Scene: boolean;
  // Wait for the En-Space room.
  Room: boolean;
  Outputs: number[];
}

async function ResolveAddress(Address: string, BudgetMs: number): Promise<string> {
  // The shared listener is udp4, so an IPv6 address could never be answered.
  if (net.isIP(Address) === 6) throw new Error('Use the DS100’s IPv4 address');
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

export async function QueryDs100(
  Config: Ds100Config,
  Wants: Ds100ProbeWants
): Promise<Ds100ProbeOutcome> {
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
    Ds100Receiver.Acquire(Config.ReplyPort),
    new Promise<{ Error: string }>((Resolve) =>
      setTimeout(() => Resolve({ Error: 'timed out' }), Remaining()).unref()
    ),
  ]);
  if ('Error' in Acquired) {
    return {
      Reachable: false,
      Error: `Failed to listen on UDP port ${Config.ReplyPort}: ${Acquired.Error}`,
    };
  }
  const Socket = Acquired.Socket;

  return new Promise<Ds100ProbeOutcome>((Resolve) => {
    const Snap: Ds100Snapshot = {
      LatencyMs: 0,
      DeviceName: null,
      Firmware: null,
      GeneralError: null,
      ErrorText: null,
      StatusText: null,
      SampleStatus: null,
      InputCount: null,
      OutputCount: null,
      Scene: null,
      SceneName: null,
      Room: null,
      Outputs: Wants.Outputs.map((Output) => ({
        Output,
        Supported: true,
        Name: null,
        Muted: null,
      })),
    };
    let Settled = false;
    let FirstReplyAt: number | null = null;
    const SentAt = Date.now();

    // Required reads decide when the probe is complete; optional ones are
    // asked for and kept if they arrive, within a short grace.
    const Required = new Set<string>([
      DEVICE_NAME_PATH,
      GENERAL_ERROR_PATH,
      ERROR_TEXT_PATH,
      STATUS_TEXT_PATH,
      SAMPLE_STATUS_PATH,
    ]);
    const Optional = new Set<string>([FIRMWARE_PATH, INPUT_COUNT_PATH, OUTPUT_COUNT_PATH]);
    (Wants.Scene ? Required : Optional).add(SCENE_INDEX_PATH);
    (Wants.Scene ? Required : Optional).add(SCENE_NAME_PATH);
    (Wants.Room ? Required : Optional).add(ROOM_PATH);
    for (const Output of Wants.Outputs) {
      Required.add(OutputMutePath(Output));
      Required.add(OutputNamePath(Output));
    }

    let ResendTimer: ReturnType<typeof setInterval> | null = null;
    let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let GraceTimer: ReturnType<typeof setTimeout> | null = null;
    let Unsubscribe: () => void = () => {};

    const Finish = (Outcome: Ds100ProbeOutcome): void => {
      if (Settled) return;
      Settled = true;
      if (ResendTimer) clearInterval(ResendTimer);
      if (DeadlineTimer) clearTimeout(DeadlineTimer);
      if (GraceTimer) clearTimeout(GraceTimer);
      Unsubscribe();
      Resolve(Outcome);
    };

    const Reached = (): Ds100ProbeOutcome => {
      Snap.LatencyMs = (FirstReplyAt ?? Date.now()) - SentAt;
      for (const O of Snap.Outputs) {
        if (Snap.OutputCount != null && O.Output > Snap.OutputCount) O.Supported = false;
      }
      return { Reachable: true, Snapshot: Snap };
    };

    const Send = (Path: string): void => {
      if (Settled) return;
      try {
        // The callback takes any send error (host unreachable, no route) so it
        // is not emitted on the shared socket, where it would close the port
        // for every other DS100 check. An unanswered probe ends at the deadline.
        Socket.send(EncodeOscMessage(Path), Config.Port, Source, () => {});
      } catch {
        // A send on a closed socket is ended by the deadline.
      }
    };

    const MaybeDone = (): void => {
      if (Settled || Required.size) return;
      if (!Optional.size) {
        Finish(Reached());
        return;
      }
      if (!GraceTimer) {
        GraceTimer = setTimeout(
          () => Finish(Reached()),
          Math.max(1, Math.min(OPTIONAL_GRACE_MS, Remaining()))
        );
      }
    };

    const OnMessage = (Msg: OscMessage): void => {
      if (Settled) return;
      const Path = Msg.Address;
      if (!Required.has(Path) && !Optional.has(Path)) return;
      const Arg = Msg.Args[0];
      if (Arg === undefined) return; // a read echoed without a value
      if (Path === DEVICE_NAME_PATH) Snap.DeviceName = ParseText(Arg) || null;
      else if (Path === FIRMWARE_PATH) Snap.Firmware = ParseText(Arg) || null;
      else if (Path === GENERAL_ERROR_PATH) Snap.GeneralError = ParseSwitch(Arg);
      else if (Path === ERROR_TEXT_PATH) Snap.ErrorText = ParseText(Arg);
      else if (Path === STATUS_TEXT_PATH) Snap.StatusText = ParseText(Arg);
      else if (Path === SAMPLE_STATUS_PATH) Snap.SampleStatus = ParseIntArg(Arg);
      else if (Path === INPUT_COUNT_PATH) Snap.InputCount = ParseIntArg(Arg);
      else if (Path === OUTPUT_COUNT_PATH) {
        Snap.OutputCount = ParseIntArg(Arg);
        // Outputs past the licensed size will never answer: stop waiting.
        for (const O of Snap.Outputs) {
          if (Snap.OutputCount == null || O.Output <= Snap.OutputCount) continue;
          Required.delete(OutputMutePath(O.Output));
          Required.delete(OutputNamePath(O.Output));
        }
      } else if (Path === SCENE_INDEX_PATH) Snap.Scene = ParseSceneReply(Msg.Args);
      else if (Path === SCENE_NAME_PATH) Snap.SceneName = ParseText(Arg);
      else if (Path === ROOM_PATH) Snap.Room = ParseIntArg(Arg);
      else {
        const Match = /^\/dbaudio1\/matrixoutput\/(mute|channelname)\/(\d+)$/.exec(Path);
        if (!Match) return;
        const Entry = Snap.Outputs.find((O) => O.Output === Number(Match[2]));
        if (Entry) {
          if (Match[1] === 'mute') Entry.Muted = ParseSwitch(Arg);
          else Entry.Name = ParseText(Arg) || null;
        }
      }
      Required.delete(Path);
      Optional.delete(Path);
      if (FirstReplyAt == null) FirstReplyAt = Date.now();
      MaybeDone();
    };

    Unsubscribe = Ds100Receiver.Subscribe(Config.ReplyPort, Source, OnMessage);

    DeadlineTimer = setTimeout(
      () => {
        if (FirstReplyAt != null) {
          Finish(Reached());
          return;
        }
        Finish({
          Reachable: false,
          Error: `No reply from the DS100 within ${BudgetMs}ms. Check the address, that UDP ${Config.Port} reaches the device, and that the DS100 can send to this computer on UDP ${Config.ReplyPort}.`,
        });
      },
      Math.max(1, Remaining())
    );

    const SendPending = (): void => {
      for (const Path of Required) Send(Path);
      for (const Path of Optional) Send(Path);
    };
    SendPending();
    ResendTimer = setInterval(SendPending, ResendMs);
  });
}

// --- Evaluation -----------------------------------------------------------------

function OutputLabel(State: Ds100OutputState): string {
  return State.Name ? `Output ${State.Output} (${State.Name})` : `Output ${State.Output}`;
}

// The reasons a reachable DS100 is unhealthy, per the enabled toggles. Pure;
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: Ds100Snapshot, Options: HealthOptions): string[] {
  const Reasons: string[] = [];

  if (Options.CheckError) {
    if (Snapshot.GeneralError === true) {
      const Text = Snapshot.ErrorText && Snapshot.ErrorText.toLowerCase() !== 'ok';
      Reasons.push(Text ? `General error: ${Snapshot.ErrorText}` : 'General error');
    } else if (Snapshot.GeneralError == null) {
      Reasons.push('Failed to read the error state');
    }
  }

  if (Options.CheckSync && Snapshot.SampleStatus === 1) {
    Reasons.push('Audio network not in sync or at an unsupported sample rate');
  }

  if (Options.CheckName && Options.ExpectedName) {
    const Actual = String(Snapshot.DeviceName || '').trim();
    if (Actual.toLowerCase() !== Options.ExpectedName.toLowerCase()) {
      Reasons.push(`Name "${Actual || '(blank)'}" (expected "${Options.ExpectedName}")`);
    }
  }

  if (Options.CheckScene && Options.ExpectedSceneRaw) {
    if (!Options.ExpectedScene) {
      Reasons.push(`Expected scene "${Options.ExpectedSceneRaw}" is not a scene number`);
    } else if (!Snapshot.Scene) {
      Reasons.push('Failed to read the current scene');
    } else if (!SameScene(Snapshot.Scene, Options.ExpectedScene)) {
      const Name = Snapshot.SceneName ? ` "${Snapshot.SceneName}"` : '';
      Reasons.push(
        `Scene ${FormatScene(Snapshot.Scene)}${Name} (expected ${FormatScene(Options.ExpectedScene)})`
      );
    }
  }

  if (Options.CheckRoom && Options.ExpectedRoom != null) {
    if (Snapshot.Room == null) {
      Reasons.push('Failed to read the En-Space room');
    } else if (Snapshot.Room !== Options.ExpectedRoom) {
      Reasons.push(
        `En-Space room ${RoomLabel(Snapshot.Room)} (expected ${RoomLabel(Options.ExpectedRoom)})`
      );
    }
  }

  if (Options.CheckOutputMutes) {
    for (const Output of Options.Outputs) {
      const State = Snapshot.Outputs.find((O) => O.Output === Output) || {
        Output,
        Supported: true,
        Name: null,
        Muted: null,
      };
      if (!State.Supported) {
        Reasons.push(`Output ${Output}: not on this DS100 (${Snapshot.OutputCount} outputs)`);
      } else if (State.Muted === true) {
        Reasons.push(`${OutputLabel(State)}: muted`);
      } else if (State.Muted == null) {
        Reasons.push(`${OutputLabel(State)}: failed to read mute state`);
      }
    }
  }
  return Reasons;
}

// Shared by Run and RunAction: the reason a config cannot be used, or null.
function ValidateConfig(Config: Ds100Config): string | null {
  if (!Config.Address) return 'No address configured';
  for (const P of [Config.Port, Config.ReplyPort]) {
    if (P < 1 || P > 65535) return `Invalid port: ${P}`;
  }
  return null;
}

// --- Actions -------------------------------------------------------------------------
//
// Params carry no Default, Min or Max on purpose: the shared normaliser would
// otherwise turn a missing or out-of-range number into a real scene instead of
// letting RunAction refuse it.

const Actions: MonitoringActionDef[] = [
  {
    ID: 'scene.recall',
    Label: 'Recall Scene',
    Icon: 'collection-play',
    Group: 'Scenes',
    Destructive: true,
    Params: [
      {
        Key: 'Major',
        Label: 'Scene number',
        Type: 'number',
        Required: true,
        Note: 'The major scene number, 0–999. Scene 7.00 is 7.',
      },
      {
        Key: 'Minor',
        Label: 'Minor number',
        Type: 'number',
        Note: 'Optional, 0–99. Scene 12.05 is scene number 12, minor number 5. Leave blank for .00.',
      },
    ],
    Note: 'Recalls a scene stored in the R1 project, then reads the scene back to confirm it.',
  },
  {
    ID: 'scene.next',
    Label: 'Next Scene',
    Icon: 'skip-forward',
    Group: 'Scenes',
    Destructive: true,
    Note: 'Recalls the next scene in the R1 project.',
  },
  {
    ID: 'scene.previous',
    Label: 'Previous Scene',
    Icon: 'skip-backward',
    Group: 'Scenes',
    Destructive: true,
    Note: 'Recalls the previous scene in the R1 project.',
  },
];

// A whole number in [Min, Max], or null. Accepts numeric strings.
function ParseWhole(Value: unknown, Min: number, Max: number): number | null {
  if (Value == null || Value === '' || typeof Value === 'boolean') return null;
  const N = Number(typeof Value === 'string' ? Value.trim() : Value);
  return Number.isInteger(N) && N >= Min && N <= Max ? N : null;
}

function IsBlank(Value: unknown): boolean {
  return Value == null || (typeof Value === 'string' && Value.trim() === '');
}

// `/scene/recall ,i major` for an .00 scene, `,ii major minor` otherwise. The
// document lists both forms; the single-int one is used for .00 so a firmware
// that predates the minor form still recalls the scene.
function SceneRecallPacket(Scene: SceneIndex): Buffer {
  const Args: OscArg[] = [{ Int: Scene.Major }];
  if (Scene.Minor) Args.push({ Int: Scene.Minor });
  return EncodeOscMessage(SCENE_RECALL_PATH, Args);
}

// Send one packet from the shared reply socket. Exactly one datagram: never
// re-sent, because every write here changes the show.
export async function SendDs100(Config: Ds100Config, Packet: Buffer): Promise<string | null> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  let Destination: string;
  try {
    Destination = await ResolveAddress(Config.Address, BudgetMs);
  } catch (Err) {
    return ErrorMessage(Err);
  }
  const Acquired = await Ds100Receiver.Acquire(Config.ReplyPort);
  if ('Error' in Acquired) {
    return `Failed to use UDP port ${Config.ReplyPort}: ${Acquired.Error}`;
  }
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

const SCENE_WANTS: Ds100ProbeWants = { Scene: true, Room: false, Outputs: [] };

function SceneText(Scene: SceneIndex | null, Name: string | null): string {
  return Name ? `${FormatScene(Scene)} (${Name})` : FormatScene(Scene);
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  const ConfigError = ValidateConfig(Config);
  if (ConfigError) return { Success: false, Error: ConfigError };

  let Wanted: SceneIndex | null = null;
  let Packet: Buffer;
  if (ActionID === 'scene.recall') {
    const Major = ParseWhole(Params && Params.Major, 0, 999);
    if (Major == null) return { Success: false, Error: 'Scene number must be 0 to 999' };
    const MinorRaw = Params && Params.Minor;
    const Minor = IsBlank(MinorRaw) ? 0 : ParseWhole(MinorRaw, 0, 99);
    if (Minor == null) return { Success: false, Error: 'Minor number must be 0 to 99' };
    Wanted = { Major, Minor };
    Packet = SceneRecallPacket(Wanted);
  } else if (ActionID === 'scene.next') {
    Packet = EncodeOscMessage(SCENE_NEXT_PATH);
  } else if (ActionID === 'scene.previous') {
    Packet = EncodeOscMessage(SCENE_PREVIOUS_PATH);
  } else {
    return { Success: false, Error: `Unknown DS100 action "${ActionID}"` };
  }

  // A UDP send cannot fail on its own, so prove the device is answering first;
  // otherwise the press would report success to a silent DS100.
  const Pre = await QueryDs100(Config, SCENE_WANTS);
  if (!Pre.Reachable) return { Success: false, Error: `${Pre.Error} Nothing was sent.` };
  const Before = Pre.Snapshot.Scene;

  const SendError = await SendDs100(Config, Packet);
  if (SendError) return { Success: false, Error: SendError };

  // Read the scene back. A lost read-back still reports what was sent; only a
  // definite answer decides success. Scene loads take a moment, so a read that
  // still shows the old scene is repeated once before it counts.
  let After: { Scene: SceneIndex | null; Name: string | null } | null = null;
  for (const Delay of READBACK_DELAYS_MS) {
    await new Promise((Res) => setTimeout(Res, Delay));
    const Post = await QueryDs100(Config, SCENE_WANTS);
    After = Post.Reachable ? { Scene: Post.Snapshot.Scene, Name: Post.Snapshot.SceneName } : null;
    if (!After || !After.Scene) continue;
    if (Wanted ? SameScene(After.Scene, Wanted) : !SameScene(After.Scene, Before)) break;
  }

  if (Wanted) {
    if (After && After.Scene && !SameScene(After.Scene, Wanted)) {
      return {
        Success: false,
        Error: `The DS100 still reports scene ${SceneText(After.Scene, After.Name)}. Check that scene ${FormatScene(Wanted)} exists in the R1 project.`,
      };
    }
    if (After && After.Scene) {
      return { Success: true, Detail: `Scene ${SceneText(After.Scene, After.Name)} recalled` };
    }
    return { Success: true, Detail: `Scene ${FormatScene(Wanted)} recall sent` };
  }

  const Word = ActionID === 'scene.next' ? 'Next' : 'Previous';
  if (After && After.Scene && Before && !SameScene(After.Scene, Before)) {
    return {
      Success: true,
      Detail: `Scene ${SceneText(After.Scene, After.Name)} recalled (was ${FormatScene(Before)})`,
    };
  }
  if (After && After.Scene && Before) {
    return {
      Success: false,
      Error: `The DS100 still reports scene ${SceneText(After.Scene, After.Name)}. There may be no ${Word.toLowerCase()} scene in the R1 project.`,
    };
  }
  return { Success: true, Detail: `${Word} scene sent` };
}

// Bind the scene into a favourite's label.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID !== 'scene.recall') return null;
  const Major = ParseWhole(Params && Params.Major, 0, 999);
  if (Major == null) return null;
  const MinorRaw = Params && Params.Minor;
  const Minor = IsBlank(MinorRaw) ? 0 : ParseWhole(MinorRaw, 0, 99);
  if (Minor == null) return null;
  return `Recall Scene ${FormatScene({ Major, Minor })}`;
}

// --- Run / Debug --------------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const ConfigError = ValidateConfig(Config);
  if (ConfigError) return { Success: false, Error: ConfigError };
  const Options = ParseHealthOptions(Target);

  let Outcome: Ds100ProbeOutcome;
  try {
    Outcome = await QueryDs100(Config, {
      Scene: Options.CheckScene && !!Options.ExpectedScene,
      Room: Options.CheckRoom && Options.ExpectedRoom != null,
      Outputs: Options.CheckOutputMutes ? Options.Outputs : [],
    });
  } catch (Err) {
    return { Success: false, Error: ErrorMessage(Err) };
  }
  if (!Outcome.Reachable) return { Success: false, Error: Outcome.Error };

  const Snap = Outcome.Snapshot;
  const Reasons = EvaluateHealth(Snap, Options);
  const Firmware = ParseFirmware(Snap.Firmware);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    DeviceName: Snap.DeviceName,
    Model: Firmware.Model,
    Firmware: Firmware.Version,
    GeneralError: Snap.GeneralError,
    ErrorText: Snap.ErrorText,
    StatusText: Snap.StatusText,
    SampleStatus: Snap.SampleStatus,
    SampleRate: SampleRateLabel(Snap.SampleStatus),
    InputCount: Snap.InputCount,
    OutputCount: Snap.OutputCount,
    Scene: Snap.Scene ? FormatScene(Snap.Scene) : null,
    SceneName: Snap.SceneName,
    Room: Snap.Room,
    RoomName: Snap.Room == null ? null : RoomLabel(Snap.Room),
    Outputs: Snap.Outputs,
  };
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  if (Reachable && !Result.Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', Result.DegradedReason || 'Degraded');
  return Pill('danger', 'Offline');
}

function Present(Value: unknown): boolean {
  return Value != null && String(Value).trim() !== '';
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Identity = [Result && Result.Model, Result && Result.DeviceName]
    .filter(Present)
    .join(' · ');
  const MatrixSize =
    typeof Result.InputCount === 'number' && typeof Result.OutputCount === 'number'
      ? `${Result.InputCount} × ${Result.OutputCount}`
      : null;

  const Head = Rows([
    TextRow(
      'Host',
      `${Config.Address || '-'}:${Config.Port} (replies to port ${Config.ReplyPort})`
    ),
    Reachable && Identity ? TextRow('Device', Identity) : null,
    Reachable && Present(Result.Firmware) ? TextRow('Firmware', String(Result.Firmware)) : null,
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the DS100'),
    Reachable && Result.GeneralError != null
      ? Row(
          'Error flag',
          Result.GeneralError ? Pill('warning', 'General error') : Pill('success', 'None')
        )
      : null,
    Reachable && Present(Result.ErrorText) ? TextRow('Error text', String(Result.ErrorText)) : null,
    Reachable && Present(Result.StatusText)
      ? TextRow('Status text', String(Result.StatusText))
      : null,
    Reachable && Result.SampleStatus != null
      ? Row(
          'Audio network',
          Result.SampleStatus === 1
            ? Pill('warning', 'Not in sync')
            : Pill('success', String(Result.SampleRate || ''))
        )
      : null,
    Reachable && MatrixSize ? TextRow('Matrix', MatrixSize) : null,
    Reachable && Present(Result.Scene)
      ? TextRow(
          'Scene',
          (Present(Result.SceneName)
            ? `${String(Result.Scene)} (${String(Result.SceneName)})`
            : String(Result.Scene)) +
            (Options.CheckScene && Options.ExpectedScene
              ? ` (expected ${FormatScene(Options.ExpectedScene)})`
              : '')
        )
      : null,
    Reachable && Present(Result.RoomName)
      ? TextRow('En-Space room', String(Result.RoomName))
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `The DS100 sends its replies to UDP ${Config.ReplyPort} on this computer, so a firewall must allow it and no other OSC program here may hold that port.`
      ) +
      '</div>'
    );
  }

  const Outputs = Array.isArray(Result.Outputs) ? (Result.Outputs as Ds100OutputState[]) : [];
  if (!Options.CheckOutputMutes || !Outputs.length) return Head;
  const Cards = Outputs.map((O) =>
    Card({
      Title: OutputLabel(O),
      Badge: !O.Supported
        ? Pill('warning', 'Not on this DS100')
        : O.Muted === false
          ? Pill('success', 'On')
          : O.Muted === true
            ? Pill('warning', 'Muted')
            : Pill('muted', 'No reply'),
    })
  ).join('');
  return Head + `<div class="d-grid gap-1 mt-2">${Cards}</div>`;
}

export const Name = 'd&b DS100 Signal Engine';
export const Description =
  'Queries a d&b audiotechnik DS100 or DS100M Signal Engine (d&b Soundscape) over its OSC interface (UDP 50010, replies to UDP 50011) for the device name, firmware, error flag, status text and audio network sync. Optionally flags a different device name, scene or En-Space room, or muted matrix outputs. The check itself only reads; scene recall is a separate operator action.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseOutputList,
  ParseSceneText,
  ParseSceneReply,
  ParseFirmware,
  FormatScene,
  SampleRateLabel,
  RoomLabel,
  SceneRecallPacket,
  ParseWhole,
  EvaluateHealth,
  QueryDs100,
  Ds100Receiver,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
