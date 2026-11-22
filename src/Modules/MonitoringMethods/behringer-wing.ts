// Behringer WING / WING Rack / WING Compact console check over the console's
// native OSC-over-UDP remote protocol.
//
// Protocol (Patrick-Gilles Maillot, "WING Remote Protocols" V3.0.5-1, for WING
// FW 3.0.5 and above, cross-checked against Bitfocus
// companion-module-behringer-wing):
//   - OSC is served on UDP 2223 only. The console replies to the IP and port the
//     request came FROM, so one ephemeral socket per probe is enough and two
//     checks (or Companion on the same host) never fight over a port.
//   - `/?` (no args) -> `/? ,s "WING,<ip>,<name>,<model>,<serial>,<firmware>"`,
//     the same signature the native `WING?` discovery on UDP 2222 returns, e.g.
//     `WING,192.168.1.71,PGM,ngc-full,NO_SERIAL,1.08.1-0-g33e69f88:release`.
//     The model is `ngc-full` on the full-size desk; `wing-rack`,
//     `wing-compact` and `wing-bk` are documented for /$syscfg/$cnsmdl.
//   - Any leaf address sent with no arguments is a READ. Strings and enums
//     answer `,s <text>`; ints `,sfi <text> <raw 0..1> <value>`; floats
//     `,sff <text> <raw 0..1> <value>`. A fader at -oo answers text `-oo` and
//     value -144.
//   - `/<strip>/<n>/mute` is an int, 1 = muted, for ch 1-40, aux 1-8, bus 1-16,
//     main 1-4, mtx 1-8, dca 1-16 and mgrp 1-8. `/<strip>/<n>/fdr` is the fader
//     in dB (-144..10) on every strip but mute groups. `$name` is the read-only
//     name as shown on the scribble strip (ch/aux/bus/main/mtx); DCAs and mute
//     groups only have `name`.
//   - Status: `/$stat/lock` (int, clock lock), `/$stat/A|B|C/stat` (AES50 port:
//     `-`, OK, ERR, UPD), `/$stat/A|B|C/dev` (device on the port),
//     `/$stat/sc_stat` (StageConnect: OK, ERR); `/$globals/clkrate` (48000.0,
//     44100.0) and `/$globals/clksrc` (INT, A, B, C, AES, CARD, MOD).
//   - Library: `/$ctl/lib/$actshow` (open show, e.g. `I:SHOW2`) and
//     `/$ctl/lib/$active` (active scene, e.g. `I:SHOW2/scene_1.snap`).
//   - Writes are the same address with a typed argument. WING does NOT echo a
//     write over UDP, so every action reads the value back.
//   - Scene recall (Companion's "Recall Scene by Number"):
//     `/$ctl/lib/$actionidx ,i <n>` then `/$ctl/lib/$action ,s GO`; GONEXT and
//     GOPREV step through the open show. A show must be open.
//
// Design:
//   - One probe = one short exchange: `/?` first (the fingerprint and the reply
//     time), then every enabled read is sent at once, each as its own datagram
//     (WING does not accept OSC bundles). UDP is lossy, so unanswered reads are
//     re-sent on a short interval until answered or the probe deadline passes.
//     Reads are idempotent, so a duplicate is harmless.
//   - Replies are matched by OSC address, never by arrival order.
//   - No subscription (`/*s`, `/*S`, `/*b`) is ever sent: WING allows only one
//     subscriber, and taking it would steal Companion's or a tablet's feed.
//     Nothing outlives the probe, so no interest TTL is needed.
//   - Run() never writes. Only RunAction, reached by an operator's press, does.
import dgram from 'dgram';
import net from 'net';
import { EncodeOscMessage, ParseOscPacket, type OscArg, type OscMessage } from './_osc-shared';
import { ErrorMessage } from './_tcp-session';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow, HealthPill } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';
import { AddressPortError } from './_target-checks';

const ID = 'behringer-wing';

export const DEFAULT_WING_OSC_PORT = 2223;
const DEFAULT_TIMEOUT_MS = 4000;
// How often an unanswered query is sent again. A quarter of the budget gives a
// lost datagram three more chances without flooding a busy console.
const MIN_RESEND_MS = 250;
// At most this many strips are read per probe (three small reads each).
export const MAX_MONITORED_STRIPS = 32;
// The documented fader floor: -oo reads back as -144 dB.
const FADER_MINUS_INF_DB = -144;
// Companion's "Recall Scene by Number" range.
const MAX_SCENE_INDEX = 16384;

const AES50_PORTS = ['A', 'B', 'C'] as const;
type Aes50Port = (typeof AES50_PORTS)[number];

const CLOCK_SOURCES = ['INT', 'A', 'B', 'C', 'AES', 'CARD', 'MOD'];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'OSC port',
    Type: 'number',
    Default: DEFAULT_WING_OSC_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'WING consoles answer OSC on UDP 2223.',
  },
  {
    Key: 'CheckName',
    Label: 'Check console name',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different console answers on this address.',
  },
  {
    Key: 'ExpectedName',
    Label: 'Expected console name',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckName', Equals: true },
    Note: 'The console name shown in the console’s Setup screen. Not case-sensitive.',
  },
  {
    Key: 'CheckClock',
    Label: 'Check clock',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while the console clock is not locked.',
  },
  {
    Key: 'ExpectedClockSource',
    Label: 'Expected clock source',
    Type: 'select',
    Default: '',
    Options: [
      { value: '', label: 'Any' },
      { value: 'INT', label: 'Internal' },
      { value: 'A', label: 'AES50 A' },
      { value: 'B', label: 'AES50 B' },
      { value: 'C', label: 'AES50 C' },
      { value: 'AES', label: 'AES/EBU' },
      { value: 'CARD', label: 'Card' },
      { value: 'MOD', label: 'Module' },
    ],
    VisibleWhen: { Key: 'CheckClock', Equals: true },
    Note: 'Reports Degraded when the master clock source is different.',
  },
  {
    Key: 'ExpectedSampleRate',
    Label: 'Expected sample rate',
    Type: 'select',
    Default: '',
    Options: [
      { value: '', label: 'Any' },
      { value: '48000', label: '48 kHz' },
      { value: '44100', label: '44.1 kHz' },
    ],
    VisibleWhen: { Key: 'CheckClock', Equals: true },
  },
  {
    Key: 'CheckAes50',
    Label: 'Check AES50 links',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while a listed AES50 port has no healthy link.',
  },
  {
    Key: 'Aes50Ports',
    Label: 'AES50 ports',
    Type: 'list',
    Default: ['A'],
    VisibleWhen: { Key: 'CheckAes50', Equals: true },
    Note: 'A, B or C. Each listed port must report OK.',
  },
  {
    Key: 'CheckStageConnect',
    Label: 'Check StageConnect',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while StageConnect reports an error.',
  },
  {
    Key: 'CheckShow',
    Label: 'Check show and scene',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a different show or scene is loaded.',
  },
  {
    Key: 'ExpectedShow',
    Label: 'Expected show',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckShow', Equals: true },
    Note: 'The show name, e.g. SHOW2. Leave blank to accept any show. Not case-sensitive.',
  },
  {
    Key: 'ExpectedScene',
    Label: 'Expected scene',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckShow', Equals: true },
    Note: 'The scene name, e.g. scene_1. Leave blank to accept any scene. Not case-sensitive.',
  },
  {
    Key: 'CheckStrips',
    Label: 'Check strips',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded while any listed strip is muted.',
  },
  {
    Key: 'MonitoredStrips',
    Label: 'Strips',
    Type: 'list',
    Default: [],
    VisibleWhen: { Key: 'CheckStrips', Equals: true },
    Note: 'For example Main 1, Ch 12, Bus 3, Aux 2, Mtx 1, DCA 4 or Mgrp 1 (a mute group is flagged while engaged). Up to 32.',
  },
  {
    Key: 'CheckFaders',
    Label: 'Flag faders at −∞',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'CheckStrips', Equals: true },
    Note: 'Also report Degraded while a listed strip’s fader is fully down. Mute groups have no fader.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
];

// --- Config -----------------------------------------------------------------

export interface WingConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): WingConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: Number.isFinite(Port) && Port > 0 ? Math.floor(Port) : DEFAULT_WING_OSC_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
  };
}

// Shared by Run and RunAction: the reason a config cannot be used, or null.
function ValidateConfig(Config: WingConfig): string | null {
  return AddressPortError(Config);
}

// --- Strips -------------------------------------------------------------------

export type StripKind = 'ch' | 'aux' | 'bus' | 'main' | 'mtx' | 'dca' | 'mgrp';

const STRIP_KINDS: Record<
  StripKind,
  { Label: string; Count: number; NameLeaf: string; HasFader: boolean }
> = {
  ch: { Label: 'Ch', Count: 40, NameLeaf: '$name', HasFader: true },
  aux: { Label: 'Aux', Count: 8, NameLeaf: '$name', HasFader: true },
  bus: { Label: 'Bus', Count: 16, NameLeaf: '$name', HasFader: true },
  main: { Label: 'Main', Count: 4, NameLeaf: '$name', HasFader: true },
  mtx: { Label: 'Mtx', Count: 8, NameLeaf: '$name', HasFader: true },
  dca: { Label: 'DCA', Count: 16, NameLeaf: 'name', HasFader: true },
  mgrp: { Label: 'Mgrp', Count: 8, NameLeaf: 'name', HasFader: false },
};

// Words an operator might type for each strip kind.
const KIND_ALIASES: Record<string, StripKind> = {
  ch: 'ch',
  channel: 'ch',
  aux: 'aux',
  bus: 'bus',
  main: 'main',
  mtx: 'mtx',
  matrix: 'mtx',
  dca: 'dca',
  mgrp: 'mgrp',
  mutegroup: 'mgrp',
  mg: 'mgrp',
};

export interface StripRef {
  Kind: StripKind;
  Number: number;
}

// "Ch 12", "ch12", "ch.12", "Mute group 2" -> { Kind, Number }; null when the
// kind is unknown or the number is outside the documented range.
function ParseStrip(Value: unknown): StripRef | null {
  const Text = String(Value == null ? '' : Value)
    .trim()
    .toLowerCase();
  const Match = /^([a-z][a-z ]*?)[\s./_-]*(\d{1,3})$/.exec(Text);
  if (!Match) return null;
  const Kind = KIND_ALIASES[Match[1]!.replace(/\s+/g, '')];
  if (!Kind) return null;
  const N = Number(Match[2]);
  if (!Number.isInteger(N) || N < 1 || N > STRIP_KINDS[Kind].Count) return null;
  return { Kind, Number: N };
}

function StripKey(Ref: StripRef): string {
  return `${STRIP_KINDS[Ref.Kind].Label} ${Ref.Number}`;
}

function StripPath(Ref: StripRef, Leaf: string): string {
  return `/${Ref.Kind}/${Ref.Number}/${Leaf}`;
}

// The listed strips, de-duplicated and capped, plus the entries that did not
// parse (so EvaluateHealth can name them instead of silently ignoring them).
function ParseStripList(Value: unknown): { Strips: StripRef[]; Invalid: string[] } {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Strips: StripRef[] = [];
  const Invalid: string[] = [];
  const Seen = new Set<string>();
  for (const Item of Raw) {
    const Text = String(Item == null ? '' : Item).trim();
    if (!Text) continue;
    const Ref = ParseStrip(Text);
    if (!Ref) {
      Invalid.push(Text);
      continue;
    }
    const Key = StripKey(Ref);
    if (Seen.has(Key) || Strips.length >= MAX_MONITORED_STRIPS) continue;
    Seen.add(Key);
    Strips.push(Ref);
  }
  return { Strips, Invalid };
}

function ParseAes50Ports(Value: unknown): { Ports: Aes50Port[]; Invalid: string[] } {
  const Raw = Array.isArray(Value) ? Value : Value == null || Value === '' ? [] : [Value];
  const Ports: Aes50Port[] = [];
  const Invalid: string[] = [];
  for (const Item of Raw) {
    const Text = String(Item == null ? '' : Item)
      .trim()
      .toUpperCase()
      .replace(/^AES50\s*/, '');
    if (!Text) continue;
    if ((AES50_PORTS as readonly string[]).includes(Text)) {
      if (!Ports.includes(Text as Aes50Port)) Ports.push(Text as Aes50Port);
    } else {
      Invalid.push(String(Item).trim());
    }
  }
  return { Ports, Invalid };
}

interface HealthOptions {
  CheckName: boolean;
  ExpectedName: string;
  CheckClock: boolean;
  ExpectedClockSource: string;
  ExpectedSampleRate: number | null;
  CheckAes50: boolean;
  Aes50Ports: Aes50Port[];
  InvalidAes50: string[];
  CheckStageConnect: boolean;
  CheckShow: boolean;
  ExpectedShow: string;
  ExpectedScene: string;
  CheckStrips: boolean;
  Strips: StripRef[];
  InvalidStrips: string[];
  CheckFaders: boolean;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const Source = String(Cfg.ExpectedClockSource || '')
    .trim()
    .toUpperCase();
  const Rate = Number(Cfg.ExpectedSampleRate);
  const Aes = ParseAes50Ports(Cfg.Aes50Ports);
  const StripList = ParseStripList(Cfg.MonitoredStrips);
  return {
    CheckName: !!Cfg.CheckName,
    ExpectedName: String(Cfg.ExpectedName || '').trim(),
    CheckClock: !!Cfg.CheckClock,
    ExpectedClockSource: CLOCK_SOURCES.includes(Source) ? Source : '',
    ExpectedSampleRate: Rate === 48000 || Rate === 44100 ? Rate : null,
    CheckAes50: !!Cfg.CheckAes50,
    Aes50Ports: Aes.Ports,
    InvalidAes50: Aes.Invalid,
    CheckStageConnect: !!Cfg.CheckStageConnect,
    CheckShow: !!Cfg.CheckShow,
    ExpectedShow: String(Cfg.ExpectedShow || '').trim(),
    ExpectedScene: String(Cfg.ExpectedScene || '').trim(),
    CheckStrips: !!Cfg.CheckStrips,
    Strips: StripList.Strips,
    InvalidStrips: StripList.Invalid,
    CheckFaders: !!Cfg.CheckFaders,
  };
}

// --- Value decoding -----------------------------------------------------------

export interface WingInfo {
  Ip: string;
  Name: string;
  Model: string;
  Serial: string;
  Firmware: string;
}

// Decode the `/?` signature string. Null unless it starts with WING and carries
// all five fields; that shape is the fingerprint.
function ParseWingInfo(Msg: OscMessage): WingInfo | null {
  if (Msg.Address !== '/?' || typeof Msg.Args[0] !== 'string') return null;
  const Parts = Msg.Args[0].split(',');
  if (Parts.length < 6 || Parts[0]!.trim().toUpperCase() !== 'WING') return null;
  const Ip = Parts[1]!.trim();
  return {
    Ip: net.isIP(Ip) ? Ip : '',
    Name: Parts[2]!.trim(),
    Model: Parts[3]!.trim(),
    Serial: Parts[4]!.trim(),
    // The firmware is the last field; keep any comma inside it.
    Firmware: Parts.slice(5).join(',').trim(),
  };
}

const MODEL_LABELS: Record<string, string> = {
  'ngc-full': 'WING',
  'wing-bk': 'WING BK',
  'wing-rack': 'WING Rack',
  'wing-compact': 'WING Compact',
};

function ModelLabel(Model: string | null): string | null {
  if (!Model) return null;
  return MODEL_LABELS[Model.toLowerCase()] || Model;
}

// An int parameter (`,sfi text raw value`) as a number. A bare `,i` or a
// numeric text is accepted defensively. Null when nothing numeric came back.
function ParseIntValue(Msg: OscMessage | undefined): number | null {
  if (!Msg) return null;
  const Args = Msg.Args;
  if (Args.length >= 3 && typeof Args[2] === 'number' && Number.isFinite(Args[2])) return Args[2];
  for (const Arg of Args) {
    if (typeof Arg === 'number' && Number.isFinite(Arg)) return Arg;
    if (typeof Arg === 'boolean') return Arg ? 1 : 0;
  }
  if (typeof Args[0] === 'string' && /^-?\d+$/.test(Args[0].trim())) return Number(Args[0]);
  return null;
}

function ParseSwitch(Msg: OscMessage | undefined): boolean | null {
  const N = ParseIntValue(Msg);
  return N == null ? null : N !== 0;
}

// A float parameter (`,sff text raw value`) as its dB value; text `-oo` is the
// documented -144 floor. A bare `,f` is accepted defensively.
function ParseDb(Msg: OscMessage | undefined): number | null {
  if (!Msg) return null;
  const Args = Msg.Args;
  if (Args.length >= 3 && typeof Args[2] === 'number' && Number.isFinite(Args[2])) {
    return Math.max(FADER_MINUS_INF_DB, Args[2]);
  }
  if (Args.length === 1 && typeof Args[0] === 'number' && Number.isFinite(Args[0])) {
    return Math.max(FADER_MINUS_INF_DB, Args[0]);
  }
  if (typeof Args[0] === 'string') {
    const Text = Args[0].trim();
    if (Text === '-oo') return FADER_MINUS_INF_DB;
    const N = Number.parseFloat(Text);
    if (Number.isFinite(N)) return Math.max(FADER_MINUS_INF_DB, N);
  }
  return null;
}

function ParseText(Msg: OscMessage | undefined): string | null {
  if (!Msg || typeof Msg.Args[0] !== 'string') return null;
  return Msg.Args[0].trim();
}

// `/$globals/clkrate` is documented as the string 48000.0 / 44100.0.
function ParseSampleRate(Msg: OscMessage | undefined): number | null {
  if (!Msg) return null;
  const First = Msg.Args[0];
  const N = typeof First === 'number' ? First : Number.parseFloat(String(First ?? ''));
  return Number.isFinite(N) && N > 0 ? Math.round(N) : null;
}

// --- Transport ----------------------------------------------------------------
//
// One connected UDP socket per probe or action. Read() sends each address with
// no arguments and re-sends the unanswered ones until all are answered or the
// deadline passes; it resolves with whatever came back. Only one Read is in
// flight at a time (callers await them in turn).

interface Reply {
  Msg: OscMessage;
  At: number;
}

export interface WingSession {
  Read(Paths: string[], Deadline: number): Promise<Map<string, Reply>>;
  Write(Address: string, Args: OscArg[]): void;
  Close(): void;
  // Set when the socket failed (ICMP unreachable surfaces as ECONNREFUSED).
  Failure(): { Error: string; Refused: boolean } | null;
  // Whether any datagram at all has come back.
  AnyReply(): boolean;
  // The last `/*` error string the console sent (e.g. NODE NOT FOUND).
  ConsoleError(): string | null;
}

function OpenWingSession(
  Config: WingConfig
): Promise<{ Session: WingSession } | { Error: string; Refused: boolean }> {
  const ResendMs = Math.max(MIN_RESEND_MS, Math.floor(Math.max(500, Config.TimeoutMs) / 4));

  return new Promise((Resolve) => {
    let Socket: dgram.Socket;
    let Closed = false;
    let Failed: { Error: string; Refused: boolean } | null = null;
    let Any = false;
    let LastConsoleError: string | null = null;
    // The Read in flight, if any.
    let Current: {
      Pending: Set<string>;
      Replies: Map<string, Reply>;
      Done: () => void;
    } | null = null;

    try {
      Socket = dgram.createSocket(net.isIPv6(Config.Address) ? 'udp6' : 'udp4');
    } catch (Err) {
      Resolve({ Error: ErrorMessage(Err), Refused: false });
      return;
    }

    const SendRaw = (Buf: Buffer): void => {
      if (Closed || Failed) return;
      try {
        Socket.send(Buf);
      } catch {
        // A send on a socket that errored is reported by the 'error' handler.
      }
    };

    const Session: WingSession = {
      Read(Paths, Deadline) {
        return new Promise((Done) => {
          const Replies = new Map<string, Reply>();
          const Pending = new Set(Paths);
          let ResendTimer: ReturnType<typeof setInterval> | null = null;
          let DeadlineTimer: ReturnType<typeof setTimeout> | null = null;
          const Finish = (): void => {
            if (ResendTimer) clearInterval(ResendTimer);
            if (DeadlineTimer) clearTimeout(DeadlineTimer);
            if (Current && Current.Replies === Replies) Current = null;
            Done(Replies);
          };
          if (!Pending.size || Closed || Failed) {
            Finish();
            return;
          }
          Current = {
            Pending,
            Replies,
            Done: () => {
              if (!Pending.size || Failed) Finish();
            },
          };
          for (const Path of Pending) SendRaw(EncodeOscMessage(Path));
          ResendTimer = setInterval(() => {
            for (const Path of Pending) SendRaw(EncodeOscMessage(Path));
          }, ResendMs);
          DeadlineTimer = setTimeout(Finish, Math.max(0, Deadline - Date.now()));
        });
      },
      Write(Address, Args) {
        SendRaw(EncodeOscMessage(Address, Args));
      },
      Close() {
        if (Closed) return;
        Closed = true;
        try {
          Socket.close();
        } catch {
          // already closed
        }
      },
      Failure: () => Failed,
      AnyReply: () => Any,
      ConsoleError: () => LastConsoleError,
    };

    Socket.on('error', (Err: NodeJS.ErrnoException) => {
      if (!Failed) {
        Failed = { Error: ErrorMessage(Err), Refused: Err && Err.code === 'ECONNREFUSED' };
      }
      if (Current) Current.Done();
    });

    Socket.on('message', (Buf: Buffer) => {
      if (Closed) return;
      Any = true;
      const At = Date.now();
      for (const Msg of ParseOscPacket(Buf)) {
        if (Msg.Address === '/*' || Msg.Address.endsWith('*')) {
          const Text = typeof Msg.Args[0] === 'string' ? Msg.Args[0].trim() : '';
          if (Text && Text !== 'OK') LastConsoleError = Text;
          continue;
        }
        if (!Current || !Current.Pending.has(Msg.Address)) continue; // stale or unsolicited
        Current.Pending.delete(Msg.Address);
        Current.Replies.set(Msg.Address, { Msg, At });
      }
      if (Current) Current.Done();
    });

    try {
      // Connecting a UDP socket fixes the peer, so stray datagrams from other
      // hosts are dropped by the kernel and an ICMP unreachable is reported.
      Socket.connect(Config.Port, Config.Address, () => Resolve({ Session }));
    } catch (Err) {
      Session.Close();
      Resolve({ Error: ErrorMessage(Err), Refused: false });
    }
  });
}

// --- Probe ------------------------------------------------------------------

export interface WingStripState {
  Strip: string;
  Kind: StripKind;
  Number: number;
  Name: string | null;
  // true = muted (mute group engaged), false = not, null = not read.
  Muted: boolean | null;
  // dB, -144 = -oo. Null when not read or the strip has no fader.
  FaderDb: number | null;
}

export interface WingAes50State {
  Port: Aes50Port;
  // '-', 'OK', 'ERR', 'UPD' as reported; null = not read.
  State: string | null;
  Device: string | null;
}

export interface WingSnapshot {
  LatencyMs: number;
  IsConsole: boolean;
  Info: WingInfo | null;
  ClockLocked: boolean | null;
  ClockSource: string | null;
  SampleRate: number | null;
  ShowName: string | null;
  SceneName: string | null;
  StageConnect: string | null;
  Aes50: WingAes50State[];
  Strips: WingStripState[];
  ConsoleError: string | null;
}

export type WingProbeOutcome =
  | { Reachable: true; Snapshot: WingSnapshot }
  | { Reachable: false; Error: string; Refused: boolean };

export interface WingProbeWants {
  Aes50Ports: Aes50Port[];
  StageConnect: boolean;
  Strips: StripRef[];
  Faders: boolean;
}

const STATUS_PATHS = {
  Lock: '/$stat/lock',
  ClockRate: '/$globals/clkrate',
  ClockSource: '/$globals/clksrc',
  Show: '/$ctl/lib/$actshow',
  Scene: '/$ctl/lib/$active',
  StageConnect: '/$stat/sc_stat',
};

// The follow-up reads for one probe, in send order.
function FollowupPaths(Wants: WingProbeWants): string[] {
  const Paths = [
    STATUS_PATHS.Lock,
    STATUS_PATHS.ClockRate,
    STATUS_PATHS.ClockSource,
    STATUS_PATHS.Show,
    STATUS_PATHS.Scene,
  ];
  if (Wants.StageConnect) Paths.push(STATUS_PATHS.StageConnect);
  for (const Port of Wants.Aes50Ports) Paths.push(`/$stat/${Port}/stat`, `/$stat/${Port}/dev`);
  for (const Ref of Wants.Strips) {
    const Kind = STRIP_KINDS[Ref.Kind];
    Paths.push(StripPath(Ref, 'mute'), StripPath(Ref, Kind.NameLeaf));
    if (Wants.Faders && Kind.HasFader) Paths.push(StripPath(Ref, 'fdr'));
  }
  return Paths;
}

export async function QueryWing(
  Config: WingConfig,
  Wants: WingProbeWants
): Promise<WingProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Opened = await OpenWingSession(Config);
  if (!('Session' in Opened)) return { Reachable: false, ...Opened };
  const Session = Opened.Session;
  try {
    const StartedAt = Date.now();
    const Deadline = StartedAt + BudgetMs;
    const Identity = await Session.Read(['/?'], Deadline);
    const IdReply = Identity.get('/?');
    const Info = IdReply ? ParseWingInfo(IdReply.Msg) : null;
    const Failure = Session.Failure();

    if (!Info) {
      if (Failure) return { Reachable: false, ...Failure };
      if (!IdReply && !Session.AnyReply()) {
        return { Reachable: false, Error: `No reply within ${BudgetMs}ms`, Refused: false };
      }
    }

    const Snap: WingSnapshot = {
      LatencyMs: (IdReply ? IdReply.At : Date.now()) - StartedAt,
      IsConsole: !!Info,
      Info,
      ClockLocked: null,
      ClockSource: null,
      SampleRate: null,
      ShowName: null,
      SceneName: null,
      StageConnect: null,
      Aes50: Wants.Aes50Ports.map((Port) => ({ Port, State: null, Device: null })),
      Strips: Wants.Strips.map((Ref) => ({
        Strip: StripKey(Ref),
        Kind: Ref.Kind,
        Number: Ref.Number,
        Name: null,
        Muted: null,
        FaderDb: null,
      })),
      ConsoleError: null,
    };
    // Something answered that is not a WING: report it without asking it for
    // anything else.
    if (!Info) return { Reachable: true, Snapshot: Snap };

    const Replies = await Session.Read(FollowupPaths(Wants), Deadline);
    const Get = (Path: string): OscMessage | undefined => Replies.get(Path)?.Msg;

    Snap.ClockLocked = ParseSwitch(Get(STATUS_PATHS.Lock));
    Snap.SampleRate = ParseSampleRate(Get(STATUS_PATHS.ClockRate));
    const Source = ParseText(Get(STATUS_PATHS.ClockSource));
    Snap.ClockSource = Source ? Source.toUpperCase() : null;
    Snap.ShowName = ParseText(Get(STATUS_PATHS.Show));
    Snap.SceneName = ParseText(Get(STATUS_PATHS.Scene));
    if (Wants.StageConnect) Snap.StageConnect = ParseText(Get(STATUS_PATHS.StageConnect));
    for (const Port of Snap.Aes50) {
      Port.State = ParseText(Get(`/$stat/${Port.Port}/stat`));
      Port.Device = ParseText(Get(`/$stat/${Port.Port}/dev`)) || null;
    }
    for (const State of Snap.Strips) {
      const Ref: StripRef = { Kind: State.Kind, Number: State.Number };
      const Kind = STRIP_KINDS[State.Kind];
      State.Muted = ParseSwitch(Get(StripPath(Ref, 'mute')));
      State.Name = ParseText(Get(StripPath(Ref, Kind.NameLeaf))) || null;
      if (Wants.Faders && Kind.HasFader) State.FaderDb = ParseDb(Get(StripPath(Ref, 'fdr')));
    }
    Snap.ConsoleError = Session.ConsoleError();
    return { Reachable: true, Snapshot: Snap };
  } finally {
    Session.Close();
  }
}

// --- Evaluation -------------------------------------------------------------

function StripLabel(State: { Strip: string; Name: string | null }): string {
  return State.Name ? `${State.Strip} (${State.Name})` : State.Strip;
}

// A show or scene name as an operator would type it: `I:SHOW2/scene_1.snap`
// -> `scene_1`, `I:SHOW2` -> `show2`.
function LibraryBaseName(Value: string): string {
  const Last =
    Value.trim()
      .replace(/^[A-Za-z]:/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || '';
  return Last.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase();
}

function LibraryNameMatches(Actual: string | null, Expected: string): boolean {
  const A = String(Actual || '').trim();
  if (!A) return false;
  if (A.toLowerCase() === Expected.toLowerCase()) return true;
  return LibraryBaseName(A) === LibraryBaseName(Expected);
}

function FormatRate(Rate: number): string {
  return Rate === 44100 ? '44.1 kHz' : `${Rate / 1000} kHz`;
}

function FormatDb(Db: number | null): string {
  if (Db == null) return '-';
  if (Db <= FADER_MINUS_INF_DB) return '−∞ dB';
  return `${Db.toFixed(1)} dB`;
}

const AES50_STATE_LABELS: Record<string, string> = {
  '-': 'no link',
  ERR: 'error',
  UPD: 'updating',
};

// The reasons a reachable console is unhealthy, per the enabled toggles. Pure,
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: WingSnapshot, Options: HealthOptions): string[] {
  if (!Snapshot.IsConsole) {
    return ['Responded, but does not look like a Behringer WING'];
  }
  const Reasons: string[] = [];

  if (Options.CheckName && Options.ExpectedName) {
    const Actual = String((Snapshot.Info && Snapshot.Info.Name) || '').trim();
    if (Actual.toLowerCase() !== Options.ExpectedName.toLowerCase()) {
      Reasons.push(`Name "${Actual || '(blank)'}" (expected "${Options.ExpectedName}")`);
    }
  }

  if (Options.CheckClock) {
    if (Snapshot.ClockLocked === false) Reasons.push('Clock not locked');
    else if (Snapshot.ClockLocked == null) Reasons.push('Failed to read the clock lock state');
    if (Options.ExpectedClockSource) {
      if (Snapshot.ClockSource == null) Reasons.push('Failed to read the clock source');
      else if (Snapshot.ClockSource !== Options.ExpectedClockSource) {
        Reasons.push(
          `Clock source ${Snapshot.ClockSource} (expected ${Options.ExpectedClockSource})`
        );
      }
    }
    if (Options.ExpectedSampleRate != null) {
      if (Snapshot.SampleRate == null) Reasons.push('Failed to read the sample rate');
      else if (Snapshot.SampleRate !== Options.ExpectedSampleRate) {
        Reasons.push(
          `Sample rate ${FormatRate(Snapshot.SampleRate)} (expected ${FormatRate(Options.ExpectedSampleRate)})`
        );
      }
    }
  }

  if (Options.CheckAes50) {
    for (const Bad of Options.InvalidAes50) Reasons.push(`Unknown AES50 port "${Bad}"`);
    for (const Port of Options.Aes50Ports) {
      const State = Snapshot.Aes50.find((P) => P.Port === Port);
      const Value = State ? State.State : null;
      if (Value == null) Reasons.push(`Failed to read AES50 ${Port}`);
      else if (Value.toUpperCase() !== 'OK') {
        Reasons.push(`AES50 ${Port}: ${AES50_STATE_LABELS[Value.toUpperCase()] || Value}`);
      }
    }
  }

  if (Options.CheckStageConnect) {
    if (Snapshot.StageConnect == null) Reasons.push('Failed to read the StageConnect status');
    else if (Snapshot.StageConnect.toUpperCase() !== 'OK') {
      Reasons.push(
        `StageConnect: ${Snapshot.StageConnect.toUpperCase() === 'ERR' ? 'error' : Snapshot.StageConnect}`
      );
    }
  }

  if (Options.CheckShow) {
    if (Options.ExpectedShow && !LibraryNameMatches(Snapshot.ShowName, Options.ExpectedShow)) {
      Reasons.push(
        Snapshot.ShowName
          ? `Show "${Snapshot.ShowName}" (expected "${Options.ExpectedShow}")`
          : `No show open (expected "${Options.ExpectedShow}")`
      );
    }
    if (Options.ExpectedScene && !LibraryNameMatches(Snapshot.SceneName, Options.ExpectedScene)) {
      Reasons.push(
        Snapshot.SceneName
          ? `Scene "${Snapshot.SceneName}" (expected "${Options.ExpectedScene}")`
          : `No scene loaded (expected "${Options.ExpectedScene}")`
      );
    }
  }

  if (Options.CheckStrips) {
    for (const Bad of Options.InvalidStrips) Reasons.push(`Unknown strip "${Bad}"`);
    for (const Ref of Options.Strips) {
      const Key = StripKey(Ref);
      const State = Snapshot.Strips.find((S) => S.Strip === Key) || {
        Strip: Key,
        Name: null,
        Muted: null,
        FaderDb: null,
      };
      const Label = StripLabel(State);
      if (State.Muted === true)
        Reasons.push(`${Label}: ${Ref.Kind === 'mgrp' ? 'engaged' : 'muted'}`);
      else if (State.Muted == null) Reasons.push(`${Label}: failed to read mute state`);
      if (Options.CheckFaders && STRIP_KINDS[Ref.Kind].HasFader) {
        if (State.FaderDb == null) Reasons.push(`${Label}: failed to read fader`);
        else if (State.FaderDb <= FADER_MINUS_INF_DB) Reasons.push(`${Label}: fader at −∞`);
      }
    }
  }

  return Reasons;
}

// --- Actions ---------------------------------------------------------------------
//
// Every message here changes the console, so none of it is reachable from Run().
// Params are re-validated strictly: the schema has no Default, Min or Max on
// purpose, because the shared normaliser would otherwise turn a missing or
// out-of-range value into a real target instead of refusing it.

const STRIP_PARAM: MonitoringSettingField = {
  Key: 'Strip',
  Label: 'Strip',
  Type: 'string',
  Required: true,
  Note: 'For example Main 1, Ch 12, Bus 3, Aux 2, Mtx 1, DCA 4 or Mgrp 1.',
};

const SHOW_NOTE = 'A show must be open on the console.';
const SCENE_INDEX_PATH = '/$ctl/lib/$actidx';

const Actions: MonitoringActionDef[] = [
  {
    ID: 'strip.mute',
    Label: 'Mute Strip',
    Icon: 'volume-mute',
    Group: 'Mute',
    Destructive: true,
    Params: [STRIP_PARAM],
    Note: 'Mutes one strip, or engages a mute group. The console is read back to confirm.',
  },
  {
    ID: 'strip.unmute',
    Label: 'Unmute Strip',
    Icon: 'volume-up',
    Group: 'Mute',
    Destructive: true,
    Params: [STRIP_PARAM],
    Note: 'Unmutes one strip, or releases a mute group. Other mute groups and DCA mutes still apply.',
  },
  {
    ID: 'scene.recall',
    Label: 'Recall Scene',
    Icon: 'collection-play',
    Group: 'Scenes',
    Destructive: true,
    Params: [
      {
        Key: 'Scene',
        Label: 'Scene',
        Type: 'number',
        Required: true,
        Note: 'The scene’s position in the open show’s list, starting at 1.',
      },
    ],
    Note: `Selects the scene and presses Go. ${SHOW_NOTE}`,
  },
  {
    ID: 'scene.next',
    Label: 'Next Scene',
    Icon: 'skip-forward',
    Group: 'Scenes',
    Destructive: true,
    Note: `Selects the next scene and presses Go. ${SHOW_NOTE}`,
  },
  {
    ID: 'scene.previous',
    Label: 'Previous Scene',
    Icon: 'skip-backward',
    Group: 'Scenes',
    Destructive: true,
    Note: `Selects the previous scene and presses Go. ${SHOW_NOTE}`,
  },
];

// A whole number in [Min, Max], or null. Accepts numeric strings (OSC values).
function ParseWhole(Value: unknown, Min: number, Max: number): number | null {
  if (Value == null || Value === '' || typeof Value === 'boolean') return null;
  const N = Number(typeof Value === 'string' ? Value.trim() : Value);
  return Number.isInteger(N) && N >= Min && N <= Max ? N : null;
}

// Open a session and prove a WING is answering before anything is written.
async function WithWing<T>(
  Config: WingConfig,
  Body: (Session: WingSession, Info: WingInfo, Deadline: number) => Promise<T>
): Promise<T | { Error: string }> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Opened = await OpenWingSession(Config);
  if (!('Session' in Opened)) return { Error: `${Opened.Error}. Nothing was sent.` };
  const Session = Opened.Session;
  try {
    const Deadline = Date.now() + BudgetMs;
    const Reply = (await Session.Read(['/?'], Deadline)).get('/?');
    const Info = Reply ? ParseWingInfo(Reply.Msg) : null;
    if (!Info) {
      const Failure = Session.Failure();
      return {
        Error: Failure
          ? `${Failure.Error}. Nothing was sent.`
          : `No WING answered at ${Config.Address}:${Config.Port} within ${BudgetMs}ms, so nothing was sent.`,
      };
    }
    return await Body(Session, Info, Deadline);
  } finally {
    Session.Close();
  }
}

async function SetStripMute(
  Config: WingConfig,
  Ref: StripRef,
  Mute: boolean
): Promise<MonitoringActionResult> {
  const MutePath = StripPath(Ref, 'mute');
  const NamePath = StripPath(Ref, STRIP_KINDS[Ref.Kind].NameLeaf);
  const Outcome = await WithWing(Config, async (Session, _Info, Deadline) => {
    // WING does not echo a write, and either datagram can be lost, so write and
    // read back until the console agrees or the budget runs out. The write is
    // an absolute value, so repeating it is harmless.
    let Muted: boolean | null = null;
    let Name: string | null = null;
    for (let Attempt = 0; Attempt < 3 && Date.now() < Deadline; Attempt++) {
      Session.Write(MutePath, [{ Int: Mute ? 1 : 0 }]);
      const AttemptDeadline = Math.min(
        Deadline,
        Date.now() + Math.max(250, (Deadline - Date.now()) / 2)
      );
      const Replies = await Session.Read(
        Name == null ? [MutePath, NamePath] : [MutePath],
        AttemptDeadline
      );
      if (Name == null) Name = ParseText(Replies.get(NamePath)?.Msg) || null;
      Muted = ParseSwitch(Replies.get(MutePath)?.Msg);
      if (Muted === Mute || Session.Failure()) break;
    }
    return { Muted, Name, Failure: Session.Failure() };
  });
  if ('Error' in Outcome) return { Success: false, Error: Outcome.Error };
  const Which = StripLabel({ Strip: StripKey(Ref), Name: Outcome.Name });
  const Verb = Ref.Kind === 'mgrp' ? (Mute ? 'engaged' : 'released') : Mute ? 'muted' : 'unmuted';
  if (Outcome.Failure) {
    return {
      Success: false,
      Error: `${Outcome.Failure.Error}. The command may not have reached the console.`,
    };
  }
  if (Outcome.Muted == null) {
    return { Success: true, Detail: `${Which} ${Verb} (the console did not confirm it)` };
  }
  if (Outcome.Muted !== Mute) {
    return {
      Success: false,
      Error: `The console still reports ${Which} as ${Outcome.Muted ? 'muted' : 'unmuted'}`,
    };
  }
  return { Success: true, Detail: `${Which} ${Verb}` };
}

async function SceneAction(
  Config: WingConfig,
  Action: 'GO' | 'GONEXT' | 'GOPREV',
  Scene: number | null
): Promise<MonitoringActionResult> {
  const Outcome = await WithWing(Config, async (Session, _Info, Deadline) => {
    // Without an open show the console ignores show control, so check first
    // and say so rather than report a recall that never happened.
    const Replies = await Session.Read([STATUS_PATHS.Show], Deadline);
    const Show = ParseText(Replies.get(STATUS_PATHS.Show)?.Msg);
    if (Show == null) {
      return { Error: 'Failed to read the open show from the console, so nothing was sent.' };
    }
    if (!Show) return { Error: 'No show is open on the console, so nothing was sent.' };
    if (Action === 'GO') Session.Write('/$ctl/lib/$actionidx', [{ Int: Scene || 0 }]);
    Session.Write('/$ctl/lib/$action', [Action]);
    // A read after the writes keeps the socket open until the console has
    // answered something sent after them, so closing cannot drop a queued
    // write. The recall itself may still be loading, so the index is not
    // judged.
    await Session.Read([SCENE_INDEX_PATH], Math.min(Deadline, Date.now() + 1000));
    return { Show };
  });
  if ('Error' in Outcome) return { Success: false, Error: Outcome.Error };
  const Detail =
    Action === 'GO'
      ? `Scene ${Scene} recalled`
      : Action === 'GONEXT'
        ? 'Next scene recalled'
        : 'Previous scene recalled';
  return { Success: true, Detail: `${Detail} in ${Outcome.Show}` };
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParseConfig(Target);
  const ConfigError = ValidateConfig(Config);
  if (ConfigError) return { Success: false, Error: ConfigError };

  if (ActionID === 'strip.mute' || ActionID === 'strip.unmute') {
    const Ref = ParseStrip(Params && Params.Strip);
    if (!Ref) {
      return {
        Success: false,
        Error: 'Strip must be like Main 1, Ch 12, Bus 3, Aux 2, Mtx 1, DCA 4 or Mgrp 1',
      };
    }
    return SetStripMute(Config, Ref, ActionID === 'strip.mute');
  }

  if (ActionID === 'scene.recall') {
    const Scene = ParseWhole(Params && Params.Scene, 1, MAX_SCENE_INDEX);
    if (Scene == null) {
      return { Success: false, Error: `Scene must be 1 to ${MAX_SCENE_INDEX}` };
    }
    return SceneAction(Config, 'GO', Scene);
  }
  if (ActionID === 'scene.next') return SceneAction(Config, 'GONEXT', null);
  if (ActionID === 'scene.previous') return SceneAction(Config, 'GOPREV', null);

  return { Success: false, Error: `Unknown WING action "${ActionID}"` };
}

// Offer the strips this check monitors (with their console names) as choices.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Strips = Array.isArray(Result && Result.Strips) ? (Result.Strips as WingStripState[]) : [];
  const Choices = Strips.filter((S) => S && typeof S.Strip === 'string').map((S) => ({
    value: S.Strip,
    label: StripLabel(S),
  }));
  return Choices.length ? { Strip: Choices } : {};
}

// Bind the strip or scene into a favourite's label.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID === 'strip.mute' || ActionID === 'strip.unmute') {
    const Ref = ParseStrip(Params && Params.Strip);
    if (!Ref) return null;
    const Verb =
      Ref.Kind === 'mgrp'
        ? ActionID === 'strip.mute'
          ? 'Engage'
          : 'Release'
        : ActionID === 'strip.mute'
          ? 'Mute'
          : 'Unmute';
    return `${Verb} ${StripKey(Ref)}`;
  }
  if (ActionID === 'scene.recall') {
    const Scene = ParseWhole(Params && Params.Scene, 1, MAX_SCENE_INDEX);
    return Scene == null ? null : `Recall Scene ${Scene}`;
  }
  return null;
}

// --- Run / Debug ------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const ConfigError = ValidateConfig(Config);
  if (ConfigError) return { Success: false, Error: ConfigError };
  const Options = ParseHealthOptions(Target);

  const Outcome = await QueryWing(Config, {
    Aes50Ports: Options.CheckAes50 ? Options.Aes50Ports : [],
    StageConnect: Options.CheckStageConnect,
    Strips: Options.CheckStrips ? Options.Strips : [],
    Faders: Options.CheckStrips && Options.CheckFaders,
  });
  if (!Outcome.Reachable) {
    return {
      Success: false,
      ...(Outcome.Refused ? { Degraded: true } : {}),
      Error: Outcome.Error,
    };
  }

  const Snap = Outcome.Snapshot;
  const Reasons = EvaluateHealth(Snap, Options);
  const Info = Snap.Info;
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    IsConsole: Snap.IsConsole,
    Model: Info ? Info.Model || null : null,
    ModelLabel: ModelLabel(Info ? Info.Model : null),
    ConsoleName: Info ? Info.Name || null : null,
    Serial: Info ? Info.Serial || null : null,
    Firmware: Info ? Info.Firmware || null : null,
    ReportedIp: Info ? Info.Ip || null : null,
    ClockLocked: Snap.ClockLocked,
    ClockSource: Snap.ClockSource,
    SampleRate: Snap.SampleRate,
    ShowName: Snap.ShowName,
    SceneName: Snap.SceneName,
    StageConnect: Snap.StageConnect,
    Aes50: Snap.Aes50,
    Strips: Snap.Strips,
    ConsoleError: Snap.ConsoleError,
  };
}

function Aes50Pill(State: string | null): string {
  if (State == null) return Pill('muted', 'No reply');
  const Upper = State.toUpperCase();
  if (Upper === 'OK') return Pill('success', 'OK');
  return Pill('warning', AES50_STATE_LABELS[Upper] || State);
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Identity = [Result && (Result.ModelLabel || Result.Model), Result && Result.ConsoleName]
    .filter((Part) => Part != null && String(Part).trim() !== '')
    .join(' · ');
  const Clock = [
    typeof Result.SampleRate === 'number' ? FormatRate(Result.SampleRate) : null,
    Result.ClockSource ? `source ${Result.ClockSource}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const Head = Rows([
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Identity ? TextRow('Console', Identity) : null,
    Reachable && Result.Serial ? TextRow('Serial', Result.Serial) : null,
    Reachable && Result.Firmware ? TextRow('Firmware', Result.Firmware) : null,
    Reachable && Result.ReportedIp ? TextRow('Reported IP', Result.ReportedIp) : null,
    Row('Status', HealthPill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the console'),
    Reachable && Clock ? TextRow('Clock', Clock) : null,
    Reachable && Result.ClockLocked != null
      ? Row(
          'Clock lock',
          Result.ClockLocked ? Pill('success', 'Locked') : Pill('warning', 'Not locked')
        )
      : null,
    Reachable && Result.ShowName ? TextRow('Show', Result.ShowName) : null,
    Reachable && Result.SceneName ? TextRow('Scene', Result.SceneName) : null,
    Reachable && Result.StageConnect != null
      ? Row(
          'StageConnect',
          String(Result.StageConnect).toUpperCase() === 'OK'
            ? Pill('success', 'OK')
            : Pill('warning', Result.StageConnect)
        )
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(`Failed to reach the console over OSC. WING answers on UDP ${DEFAULT_WING_OSC_PORT}.`) +
      '</div>'
    );
  }

  const Aes50 = Array.isArray(Result.Aes50) ? (Result.Aes50 as WingAes50State[]) : [];
  const Strips = Array.isArray(Result.Strips) ? (Result.Strips as WingStripState[]) : [];
  const Cards = [
    ...Aes50.map((P) =>
      Card({
        Title: P.Device ? `AES50 ${P.Port} (${P.Device})` : `AES50 ${P.Port}`,
        Badge: Aes50Pill(P.State),
      })
    ),
    ...Strips.map((S) =>
      Card({
        Title: StripLabel(S),
        Badge:
          (S.FaderDb != null
            ? `<span class="text-muted small font-monospace me-2">${FormatDb(S.FaderDb)}</span>`
            : '') +
          (S.Muted === false
            ? Pill('success', S.Kind === 'mgrp' ? 'Released' : 'On')
            : S.Muted === true
              ? Pill('warning', S.Kind === 'mgrp' ? 'Engaged' : 'Muted')
              : Pill('muted', 'No reply')),
      })
    ),
  ].join('');
  const ErrorNote = Result.ConsoleError
    ? '<div class="mt-2">' +
      Note(`The console answered: ${String(Result.ConsoleError)}.`) +
      '</div>'
    : '';
  return (Cards ? Head + `<div class="d-grid gap-1 mt-2">${Cards}</div>` : Head) + ErrorNote;
}

export const Name = 'Behringer WING';
export const Description =
  'Queries a Behringer WING, WING Rack or WING Compact over its OSC remote protocol (UDP 2223) for the model, name, serial and firmware. Optionally flags a different console name, an unlocked or unexpected clock, AES50 or StageConnect faults, a different show or scene, or muted listed strips. Mute and scene actions are available from the monitor.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ValidateConfig,
  ParseHealthOptions,
  ParseStrip,
  ParseStripList,
  ParseAes50Ports,
  StripKey,
  StripPath,
  ParseWingInfo,
  ModelLabel,
  ParseIntValue,
  ParseSwitch,
  ParseDb,
  ParseSampleRate,
  LibraryBaseName,
  LibraryNameMatches,
  FollowupPaths,
  EvaluateHealth,
  QueryWing,
  OpenWingSession,
};
export { ID, Settings, Actions, Run, RunAction, GetActionOptions, DescribeAction, Debug };
