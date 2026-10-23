// Allen & Heath dLive, Avantis and SQ mixing console health over the consoles'
// MIDI-over-TCP protocol: raw MIDI bytes (no framing) on TCP 51325 (an SQ, an
// Avantis or a dLive MixRack) or TCP 51328 (a dLive Surface). The TLS ports
// (dLive 51327 / 51329) are not used. One short-lived session per probe, reads
// only. Operator actions (scene recall, input mute) open their own session.
//
// What each family documents as readable (Allen & Heath's own protocol PDFs):
//
//   dLive (V2.0)    Get Channel Name   SysEx Header, 0N, 01, CH, F7
//                                      -> SysEx Header, 0N, 02, CH, Name, F7
//                   Get Mute Status    SysEx Header, 0N, 05, 09, CH, F7
//                                      -> the channel's Mute ON / OFF message:
//                                         9N, CH, 7F|3F, 9N, CH, 00
//   Avantis (V2.0)  Get Channel Name   (same as dLive). No mute query is
//                                      documented, so mutes are not read.
//   SQ (Issue 5)    'Get' NRPN         BN 63 MB, BN 62 LB, BN 60 7F
//                                      -> BN 63 MB, BN 62 LB, BN 06 00, BN 26 VF
//                                         (VF 01 = muted, 00 = unmuted)
//
// SysEx Header = F0, 00, 00, 1A, 50, 10, 01, 00. N is the console's base MIDI
// channel (0-based on the wire); dLive and Avantis offset it by the channel
// type (inputs N, mains/DCAs N+4). The consoles use MIDI running status, so the
// reply parser keeps per-stream status and also skips interleaved real-time
// bytes (Active Sensing, FE).
//
// None of these consoles answers a "current scene" query: scene numbers are only
// transmitted when a scene is recalled, so the current scene is not read.
//
// Safety: the SQ 'get' is a Data Increment (CC 60) with value 7F, and the SQ
// treats a Data Increment with value 00 as a mute TOGGLE. Allen & Heath document
// the 7F form as a read for SQ firmware 1.5.0 and later, which is why SQ queries
// are only sent when a mute check is switched on (off by default), and the
// settings say so. The 7F value is a constant: no setting can change it.
// dLive/Avantis queries are SysEx, which a console ignores if it does not know
// them. Run() sends nothing else; every state-changing message lives in
// RunAction, which only an operator's press reaches.
//
// Actions (documented set messages, all on the base MIDI channel N):
//   Scene recall   BN 00 Bank, CN SS      dLive MixRack / Avantis 1-500
//                                         (banks 00-03), SQ 1-300 (00-02)
//   Mute ON/OFF    dLive / Avantis: 9N CH 7F|3F, 9N CH 00 (inputs: N, CH 00-)
//                  SQ: BN 63 00, BN 62 LB, BN 06 00, BN 26 01|00 (Issue 5 3.3)
// A dLive Surface (51328) reads the same bank + program change as a Cue List
// recall, not a scene, so scene recall is refused on that port.
//
// Sources: dLive MIDI Over TCP/IP Protocol V2.0, Avantis MIDI TCP/IP Protocol
// (firmware V2.0, A&H support article 45146889174801),
// SQ MIDI Protocol Issue 5 (all Allen & Heath), cross-checked against Bitfocus
// Companion's allenheath-dlive, allenheath-avantis and allenheath-sq modules.
// Inferred, not documented: that a dLive answers a name or mute query on any
// of its MIDI channels only when the base channel matches (a mismatch reads as
// "no reply"), and the SQ LR mute parameter: the Issue 5 'get' example lists
// "LR Mute" as 00/00, which is Input 1 in its own mute table; the table value
// 00/44 (also used by Companion's SQ module) is used here.
import { ErrorMessage, RunTcpSession, type TcpSession } from './_tcp-session';
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

const ID = 'allen-heath-console';
const DEFAULT_PORT = 51325;
const DLIVE_SURFACE_PORT = 51328;
const DEFAULT_TIMEOUT_MS = 4000;
// A SysEx message longer than this is not a reply this probe asked for.
const MAX_SYSEX_BYTES = 512;
// More channels than this in one probe is a configuration mistake, not a check.
const MAX_CHANNELS = 128;

export type AhFamily = 'dlive' | 'avantis' | 'sq';

const FAMILY_LABELS: Record<AhFamily, string> = {
  dlive: 'dLive',
  avantis: 'Avantis',
  sq: 'SQ',
};

// Input channel counts per family, from each protocol's channel table.
const INPUT_COUNTS: Record<AhFamily, number> = { dlive: 128, avantis: 96, sq: 48 };
// Scene counts per family, from each protocol's scene recall section.
const SCENE_COUNTS: Record<AhFamily, number> = { dlive: 500, avantis: 500, sq: 300 };

const SYSEX_HEADER = [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x10, 0x01, 0x00];
// dLive/Avantis: mains are on MIDI channel N+4, Main 1 at note 0x30.
const DLIVE_MAIN_OFFSET = 4;
const DLIVE_MAIN_NOTE = 0x30;
// SQ: mute parameter numbers (MSB/LSB) from the Issue 5 mute table.
const SQ_LR_MUTE = { Msb: 0x00, Lsb: 0x44 };

const MUTE_FAMILIES = ['dlive', 'sq'];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Family',
    Label: 'Console family',
    Type: 'select',
    Default: 'dlive',
    Options: [
      { value: 'dlive', label: 'dLive (MixRack or Surface)' },
      { value: 'avantis', label: 'Avantis' },
      { value: 'sq', label: 'SQ' },
    ],
    Required: true,
  },
  {
    Key: 'Port',
    Label: 'MIDI TCP port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: 'Use 51325 for an SQ, an Avantis or a dLive MixRack, and 51328 for a dLive Surface. The encrypted ports are not supported.',
  },
  {
    Key: 'MidiChannel',
    Label: 'Base MIDI channel',
    Type: 'number',
    Default: 1,
    Min: 1,
    Max: 16,
    Required: true,
    Note: 'The MIDI channel set on the console under Utility, Control, MIDI (dLive and Avantis, 1 to 12) or Utility, General, MIDI (SQ). Avantis ships set to 12.',
  },
  {
    Key: 'CheckMainMute',
    Label: 'Check main mute',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'Family', In: MUTE_FAMILIES },
    Note: 'Enable to report Degraded while the main mix is muted (Main 1 on dLive, LR on SQ). On SQ this needs firmware 1.5.0 or later. Older SQ firmware may treat the query as a mute toggle.',
  },
  {
    Key: 'CheckChannelMutes',
    Label: 'Check channel mutes',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'Family', In: MUTE_FAMILIES },
    Note: 'Enable to report Degraded while any listed input channel is muted. On SQ this needs firmware 1.5.0 or later. Older SQ firmware may treat the query as a mute toggle.',
  },
  {
    Key: 'MonitoredChannels',
    Label: 'Input channels',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    VisibleWhen: [
      { Key: 'Family', In: MUTE_FAMILIES },
      { Key: 'CheckChannelMutes', Equals: true },
    ],
    Note: 'Input channel numbers: 1 to 128 on dLive, 1 to 48 on SQ. Mute groups and DCA mutes are not reflected.',
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

export interface AhConfig {
  Address: string;
  Port: number;
  TimeoutMs: number;
  Family: AhFamily;
  // 0-based base MIDI channel, as it goes on the wire. -1 when the stored
  // setting is not a whole number (refused rather than guessed).
  BaseChannel: number;
}

interface HealthOptions {
  CheckMainMute: boolean;
  CheckChannelMutes: boolean;
  Channels: number[];
}

function ParseFamily(Value: unknown): AhFamily {
  const Text = String(Value == null ? '' : Value)
    .trim()
    .toLowerCase();
  return Text === 'avantis' || Text === 'sq' ? Text : 'dlive';
}

function ParseConfig(Target: MonitoringTargetLike): AhConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const Timeout = Number(Cfg.Timeout);
  // Absent = the field default (channel 1). Present but not a whole number of
  // at least 1 is refused: guessing a channel would aim queries (and actions)
  // at whatever the console has on channel 1.
  const MidiRaw = Cfg.MidiChannel;
  const Midi = MidiRaw == null || MidiRaw === '' ? 1 : Number(MidiRaw);
  return {
    Address: String((Target && Target.Address) || '').trim(),
    Port: Number.isFinite(Port) && Port > 0 ? Math.floor(Port) : DEFAULT_PORT,
    TimeoutMs: Number.isFinite(Timeout) && Timeout > 0 ? Math.floor(Timeout) : DEFAULT_TIMEOUT_MS,
    Family: ParseFamily(Cfg.Family),
    BaseChannel: Number.isInteger(Midi) && Midi >= 1 ? Midi - 1 : -1,
  };
}

// Coerce the channel list to unique positive integers, in the order given.
// Out-of-range numbers are kept so EvaluateHealth can name them.
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
  // Avantis documents no mute query, so its mute toggles are ignored even if
  // a stored setting says otherwise (e.g. after the family was changed).
  const MutesReadable = ParseFamily(Cfg.Family) !== 'avantis';
  return {
    CheckMainMute: MutesReadable && Cfg.CheckMainMute === true,
    CheckChannelMutes: MutesReadable && Cfg.CheckChannelMutes === true,
    Channels: ParseChannelList(Cfg.MonitoredChannels),
  };
}

// The highest base MIDI channel (1-based) each family accepts. dLive and
// Avantis use five consecutive channels from the base, so it stops at 12.
function MaxBaseChannel(Family: AhFamily): number {
  return Family === 'sq' ? 16 : 12;
}

// --- MIDI stream parsing -------------------------------------------------------

export type MidiEvent =
  | { Type: 'note'; Channel: number; Note: number; Velocity: number }
  | { Type: 'cc'; Channel: number; Controller: number; Value: number }
  | { Type: 'sysex'; Data: number[] };

// Data byte count for a channel-voice status byte.
function DataLength(Status: number): number {
  const Kind = Status & 0xf0;
  return Kind === 0xc0 || Kind === 0xd0 ? 1 : 2;
}

// Data byte count for a system-common status byte (F1-F6).
function SystemCommonLength(Status: number): number {
  if (Status === 0xf2) return 2;
  if (Status === 0xf1 || Status === 0xf3) return 1;
  return 0;
}

/**
 * Incremental MIDI byte-stream parser with running status. Real-time bytes
 * (F8-FF) are dropped wherever they appear, as MIDI allows them mid-message.
 * Only the event types this probe reads are emitted; everything else is
 * consumed and dropped. Pure: no I/O, exported via _internal for tests.
 */
export class MidiStreamParser {
  private Running = 0;
  private Data: number[] = [];
  private Expect = 0;
  private SysEx: number[] | null = null;
  private SysExOverflow = false;
  private SkipCommon = 0;

  Feed(Chunk: Buffer | number[]): MidiEvent[] {
    const Events: MidiEvent[] = [];
    for (const Byte of Chunk) {
      if (Byte >= 0xf8) continue; // real-time: ignored, never breaks a message
      if (this.SysEx) {
        if (Byte === 0xf7) {
          if (!this.SysExOverflow) Events.push({ Type: 'sysex', Data: [...this.SysEx, 0xf7] });
          this.SysEx = null;
          continue;
        }
        if (Byte < 0x80) {
          if (this.SysEx.length < MAX_SYSEX_BYTES) this.SysEx.push(Byte);
          else this.SysExOverflow = true;
          continue;
        }
        // Any other status byte ends an unterminated SysEx; fall through.
        this.SysEx = null;
      }
      if (Byte === 0xf0) {
        this.SysEx = [0xf0];
        this.SysExOverflow = false;
        this.Running = 0;
        continue;
      }
      if (Byte >= 0xf1 && Byte <= 0xf7) {
        // System common clears running status.
        this.Running = 0;
        this.Data = [];
        this.SkipCommon = SystemCommonLength(Byte);
        continue;
      }
      if (Byte >= 0x80) {
        this.Running = Byte;
        this.Data = [];
        this.Expect = DataLength(Byte);
        this.SkipCommon = 0;
        continue;
      }
      // A data byte.
      if (this.SkipCommon > 0) {
        this.SkipCommon--;
        continue;
      }
      if (!this.Running) continue; // stray data byte with no status
      this.Data.push(Byte);
      if (this.Data.length < this.Expect) continue;
      const Status = this.Running;
      const [D1 = 0, D2 = 0] = this.Data;
      this.Data = [];
      const Kind = Status & 0xf0;
      const Channel = Status & 0x0f;
      if (Kind === 0x90) Events.push({ Type: 'note', Channel, Note: D1, Velocity: D2 });
      else if (Kind === 0xb0) Events.push({ Type: 'cc', Channel, Controller: D1, Value: D2 });
    }
    return Events;
  }
}

/**
 * Per-MIDI-channel NRPN assembly for the SQ: CC 63 (parameter MSB), CC 62
 * (parameter LSB), CC 06 (value coarse), then CC 26 (value fine) completes one
 * parameter report. Returns the completed report, or null.
 */
export class NrpnTracker {
  private State = new Map<number, { Msb: number; Lsb: number; Coarse: number }>();

  Feed(
    Event: MidiEvent
  ): { Channel: number; Msb: number; Lsb: number; Coarse: number; Fine: number } | null {
    if (Event.Type !== 'cc') return null;
    let S = this.State.get(Event.Channel);
    if (!S) {
      S = { Msb: -1, Lsb: -1, Coarse: 0 };
      this.State.set(Event.Channel, S);
    }
    if (Event.Controller === 0x63) S.Msb = Event.Value;
    else if (Event.Controller === 0x62) S.Lsb = Event.Value;
    else if (Event.Controller === 0x06) S.Coarse = Event.Value;
    else if (Event.Controller === 0x26 && S.Msb >= 0 && S.Lsb >= 0) {
      return {
        Channel: Event.Channel,
        Msb: S.Msb,
        Lsb: S.Lsb,
        Coarse: S.Coarse,
        Fine: Event.Value,
      };
    }
    return null;
  }
}

// --- Request encoding ------------------------------------------------------------

function NameRequest(MidiChannel: number, Note: number): Buffer {
  return Buffer.from([...SYSEX_HEADER, MidiChannel & 0x0f, 0x01, Note & 0x7f, 0xf7]);
}

function DliveMuteRequest(MidiChannel: number, Note: number): Buffer {
  return Buffer.from([...SYSEX_HEADER, MidiChannel & 0x0f, 0x05, 0x09, Note & 0x7f, 0xf7]);
}

function SqGetRequest(MidiChannel: number, Msb: number, Lsb: number): Buffer {
  const Cc = 0xb0 | (MidiChannel & 0x0f);
  return Buffer.from([Cc, 0x63, Msb & 0x7f, Cc, 0x62, Lsb & 0x7f, Cc, 0x60, 0x7f]);
}

// SQ input N (1-based) mute parameter: MSB 00, LSB N-1 (Ip1 = 00/00 ... Ip48 = 00/2F).
function SqInputMute(Channel: number): { Msb: number; Lsb: number } {
  return { Msb: 0x00, Lsb: (Channel - 1) & 0x7f };
}

// Decode a channel-name SysEx reply: header, 0N, 02, CH, name..., F7. The two
// version bytes after the A&H ID are not checked.
function ParseNameReply(
  Data: number[]
): { MidiChannel: number; Note: number; Name: string } | null {
  if (Data.length < 12 || Data[Data.length - 1] !== 0xf7) return null;
  for (let I = 0; I < 6; I++) if (Data[I] !== SYSEX_HEADER[I]) return null;
  if (Data[9] !== 0x02) return null;
  const MidiChannel = Data[8];
  const Note = Data[10];
  if (MidiChannel == null || MidiChannel > 0x0f || Note == null) return null;
  const Name = Data.slice(11, -1)
    .filter((B) => B >= 0x20 && B <= 0x7e)
    .map((B) => String.fromCharCode(B))
    .join('')
    .trim();
  return { MidiChannel, Note, Name };
}

// --- Probe ---------------------------------------------------------------------

export interface AhChannelState {
  Channel: number;
  // Whether the channel exists on this family.
  Supported: boolean;
  Name: string | null;
  // true = muted, false = unmuted, null = not read.
  Muted: boolean | null;
}

export interface AhSnapshot {
  LatencyMs: number;
  // A documented reply arrived (name or mute). Null when nothing was asked
  // (an SQ with no mute checks): the TCP connection is then all there is.
  IsAllenHeath: boolean | null;
  BytesSeen: number;
  // Name of Input 1 (dLive / Avantis identity read).
  Input1Name: string | null;
  MainMuted: boolean | null;
  Channels: AhChannelState[];
}

export type AhProbeOutcome =
  { Reachable: true; Snapshot: AhSnapshot } | { Reachable: false; Error: string; Refused: boolean };

export interface AhProbeWants {
  MainMute: boolean;
  Channels: number[];
}

export function QueryConsole(Config: AhConfig, Wants: AhProbeWants): Promise<AhProbeOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const Family = Config.Family;
  const N = Config.BaseChannel;
  const Parser = new MidiStreamParser();
  const Nrpn = new NrpnTracker();
  const Snap: AhSnapshot = {
    LatencyMs: 0,
    IsAllenHeath: null,
    BytesSeen: 0,
    Input1Name: null,
    MainMuted: null,
    Channels: [],
  };
  let FirstReplyAt: number | null = null;
  // Keys of queries still awaiting an answer.
  const Pending = new Set<string>();
  const Requests: Buffer[] = [];

  const Ask = (Key: string, Bytes: Buffer): void => {
    if (Pending.has(Key)) return;
    Pending.add(Key);
    Requests.push(Bytes);
  };

  const ChannelEntry = (Channel: number): AhChannelState | undefined =>
    Snap.Channels.find((C) => C.Channel === Channel);

  // Build the query list.
  if (Family !== 'sq') Ask(`name:${N}:0`, NameRequest(N, 0));
  for (const Channel of Wants.Channels) {
    const Supported = Channel <= INPUT_COUNTS[Family];
    Snap.Channels.push({ Channel, Supported, Name: null, Muted: null });
    if (!Supported) continue;
    const Note = Channel - 1;
    if (Family === 'sq') {
      const P = SqInputMute(Channel);
      Ask(`nrpn:${N}:${P.Msb}:${P.Lsb}`, SqGetRequest(N, P.Msb, P.Lsb));
    } else {
      if (Note !== 0) Ask(`name:${N}:${Note}`, NameRequest(N, Note));
      Ask(`mute:${N}:${Note}`, DliveMuteRequest(N, Note));
    }
  }
  if (Wants.MainMute) {
    if (Family === 'sq') {
      Ask(
        `nrpn:${N}:${SQ_LR_MUTE.Msb}:${SQ_LR_MUTE.Lsb}`,
        SqGetRequest(N, SQ_LR_MUTE.Msb, SQ_LR_MUTE.Lsb)
      );
    } else {
      const MainChannel = N + DLIVE_MAIN_OFFSET;
      Ask(`mute:${MainChannel}:${DLIVE_MAIN_NOTE}`, DliveMuteRequest(MainChannel, DLIVE_MAIN_NOTE));
    }
  }

  const Answered = (Key: string): void => {
    if (!Pending.delete(Key)) return;
    Snap.IsAllenHeath = true;
    if (FirstReplyAt == null) FirstReplyAt = Date.now();
  };

  const HandleEvent = (Event: MidiEvent): void => {
    if (Event.Type === 'sysex') {
      const Reply = ParseNameReply(Event.Data);
      if (!Reply) return;
      const Key = `name:${Reply.MidiChannel}:${Reply.Note}`;
      if (!Pending.has(Key)) return;
      if (Reply.MidiChannel === N) {
        if (Reply.Note === 0) Snap.Input1Name = Reply.Name || null;
        const Entry = ChannelEntry(Reply.Note + 1);
        if (Entry) Entry.Name = Reply.Name || null;
      }
      Answered(Key);
      return;
    }
    if (Event.Type === 'note' && Family !== 'sq') {
      // Velocity 00 is the trailing note-off of the pair and carries nothing.
      if (Event.Velocity === 0) return;
      const Key = `mute:${Event.Channel}:${Event.Note}`;
      if (!Pending.has(Key)) return;
      const Muted = Event.Velocity >= 0x40;
      if (Event.Channel === N + DLIVE_MAIN_OFFSET && Event.Note === DLIVE_MAIN_NOTE) {
        Snap.MainMuted = Muted;
      } else if (Event.Channel === N) {
        const Entry = ChannelEntry(Event.Note + 1);
        if (Entry) Entry.Muted = Muted;
      }
      Answered(Key);
      return;
    }
    if (Event.Type === 'cc' && Family === 'sq') {
      const Report = Nrpn.Feed(Event);
      if (!Report) return;
      const Key = `nrpn:${Report.Channel}:${Report.Msb}:${Report.Lsb}`;
      if (!Pending.has(Key)) return;
      const Muted = Report.Fine === 0x01;
      if (Report.Msb === SQ_LR_MUTE.Msb && Report.Lsb === SQ_LR_MUTE.Lsb) {
        Snap.MainMuted = Muted;
      } else if (Report.Msb === 0x00 && Report.Lsb < INPUT_COUNTS.sq) {
        const Entry = ChannelEntry(Report.Lsb + 1);
        if (Entry) Entry.Muted = Muted;
      }
      Answered(Key);
    }
  };

  return RunTcpSession<AhProbeOutcome>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnConnect: (Session) => {
      if (!Requests.length) {
        // Nothing documented is safe to ask (an SQ with no mute checks): the
        // accepted connection is the whole probe.
        Snap.LatencyMs = Date.now() - Session.StartedAt;
        Session.Finish({ Reachable: true, Snapshot: Snap });
        return;
      }
      Session.Socket.write(Buffer.concat(Requests));
    },
    OnData: (Chunk, Session) => {
      Snap.BytesSeen += Chunk.length;
      for (const Event of Parser.Feed(Chunk)) HandleEvent(Event);
      if (!Pending.size) {
        Snap.LatencyMs = (FirstReplyAt ?? Date.now()) - Session.StartedAt;
        Session.Finish({ Reachable: true, Snapshot: Snap });
      }
    },
    OnTimeout: (Session) => {
      if (Snap.IsAllenHeath == null && Snap.BytesSeen === 0) {
        return {
          Reachable: false,
          Error: `The console accepted the connection but did not answer within ${BudgetMs}ms. Check the console family and base MIDI channel.`,
          Refused: false,
        };
      }
      if (Snap.IsAllenHeath == null) Snap.IsAllenHeath = false;
      Snap.LatencyMs = (FirstReplyAt ?? Date.now()) - Session.StartedAt;
      return { Reachable: true, Snapshot: Snap };
    },
    OnError: (Message) => ({
      Reachable: false,
      Error: Message,
      Refused: Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET'),
    }),
    OnClose: (Session) => {
      if (Snap.IsAllenHeath) {
        Snap.LatencyMs = (FirstReplyAt ?? Date.now()) - Session.StartedAt;
        return { Reachable: true, Snapshot: Snap };
      }
      return { Reachable: false, Error: 'Connection closed before any reply', Refused: false };
    },
  });
}

// --- Evaluation ------------------------------------------------------------------

function ChannelLabel(State: AhChannelState): string {
  return State.Name ? `Ch ${State.Channel} (${State.Name})` : `Ch ${State.Channel}`;
}

// The reasons a reachable console is unhealthy, per the enabled toggles. Pure —
// exported via _internal for unit tests.
function EvaluateHealth(Snapshot: AhSnapshot, Options: HealthOptions, Family: AhFamily): string[] {
  if (Snapshot.IsAllenHeath === false) {
    return ['Responded, but not as an Allen & Heath console (check the family and MIDI channel)'];
  }
  const Reasons: string[] = [];
  const Label = FAMILY_LABELS[Family];

  if (Options.CheckMainMute) {
    const Main = Family === 'sq' ? 'LR' : 'Main 1';
    if (Snapshot.MainMuted === true) Reasons.push(`${Main} muted`);
    else if (Snapshot.MainMuted == null) Reasons.push(`Failed to read the ${Main} mute state`);
  }

  if (Options.CheckChannelMutes) {
    for (const Channel of Options.Channels) {
      const State = Snapshot.Channels.find((C) => C.Channel === Channel) || {
        Channel,
        Supported: true,
        Name: null,
        Muted: null,
      };
      if (!State.Supported) Reasons.push(`Ch ${Channel}: not on ${Label}`);
      else if (State.Muted === true) Reasons.push(`${ChannelLabel(State)}: muted`);
      else if (State.Muted == null)
        Reasons.push(`${ChannelLabel(State)}: failed to read mute state`);
    }
  }
  return Reasons;
}

// Shared by Run and RunAction: the reason a config cannot be used, or null.
function ValidateConfig(Config: AhConfig): string | null {
  if (!Config.Address) return 'No address configured';
  if (Config.Port < 1 || Config.Port > 65535) return `Invalid port: ${Config.Port}`;
  const MaxChannel = MaxBaseChannel(Config.Family);
  if (Config.BaseChannel < 0 || Config.BaseChannel + 1 > MaxChannel) {
    return `Base MIDI channel must be 1 to ${MaxChannel} on ${FAMILY_LABELS[Config.Family]}`;
  }
  return null;
}

// --- Actions ---------------------------------------------------------------------
//
// Every message here changes the console, so none of it is reachable from Run().
// Params are re-validated strictly: the schema has no Default, Min or Max on
// purpose, because the shared normaliser would otherwise turn a missing or
// out-of-range number into scene 1 or the last scene instead of refusing it.

const INPUT_PARAM: MonitoringSettingField = {
  Key: 'Channel',
  Label: 'Input channel',
  Type: 'number',
  Required: true,
  Note: 'The input channel number: 1 to 128 on dLive, 1 to 96 on Avantis, 1 to 48 on SQ.',
};

const Actions: MonitoringActionDef[] = [
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
        Note: 'The scene number as shown on the console: 1 to 500 on dLive and Avantis, 1 to 300 on SQ.',
      },
    ],
    Note: 'Recalls the scene on the base MIDI channel. On dLive the check must point at the MixRack (port 51325). An SQ ignores a scene that has not been saved.',
  },
  {
    ID: 'mute.on',
    Label: 'Mute Input',
    Icon: 'mic-mute-fill',
    Group: 'Mute',
    Destructive: true,
    Params: [INPUT_PARAM],
    Note: 'Mutes one input channel. It uses the Base MIDI channel setting, so check that it matches the console first.',
  },
  {
    ID: 'mute.off',
    Label: 'Unmute Input',
    Icon: 'mic-fill',
    Group: 'Mute',
    Params: [INPUT_PARAM],
    Note: 'Unmutes one input channel. Mute groups and DCA mutes still apply.',
  },
];

// A whole number in [Min, Max], or null. Accepts numeric strings (OSC values).
function ParseWhole(Value: unknown, Min: number, Max: number): number | null {
  if (Value == null || Value === '' || typeof Value === 'boolean') return null;
  const N = Number(typeof Value === 'string' ? Value.trim() : Value);
  return Number.isInteger(N) && N >= Min && N <= Max ? N : null;
}

// Scene recall: bank select (CC 00) then program change, on the base channel.
// Scene 1-128 = bank 00, 129-256 = 01, 257-384 = 02, 385-500 = 03.
function SceneRecallMessage(MidiChannel: number, Scene: number): Buffer {
  const Index = Scene - 1;
  const Bank = Math.floor(Index / 128) & 0x7f;
  const Program = Index % 128;
  const Ch = MidiChannel & 0x0f;
  return Buffer.from([0xb0 | Ch, 0x00, Bank, 0xc0 | Ch, Program]);
}

// Input mute set. dLive/Avantis: Note On velocity 7F (on) or 3F (off), then the
// Note Off (velocity 00) the protocol pairs with it. SQ: absolute NRPN mute.
function MuteMessage(
  Family: AhFamily,
  MidiChannel: number,
  Channel: number,
  Mute: boolean
): Buffer {
  const Ch = MidiChannel & 0x0f;
  const Note = (Channel - 1) & 0x7f;
  if (Family === 'sq') {
    const P = SqInputMute(Channel);
    const Cc = 0xb0 | Ch;
    return Buffer.from([Cc, 0x63, P.Msb, Cc, 0x62, P.Lsb, Cc, 0x06, 0x00, Cc, 0x26, Mute ? 1 : 0]);
  }
  return Buffer.from([0x90 | Ch, Note, Mute ? 0x7f : 0x3f, 0x90 | Ch, Note, 0x00]);
}

interface AhActionPlan {
  // Sent once, after the console has proved it is listening (dLive/Avantis).
  Command: Buffer;
  // dLive/Avantis: name of this input (0-based note) is asked first, so a
  // console that is not answering on the base channel is never sent the command.
  PreflightNote: number | null;
  // dLive input mute: read the mute back after the command.
  ConfirmMuteNote: number | null;
}

type AhActionOutcome =
  { Sent: true; Name: string | null; Muted: boolean | null } | { Sent: false; Error: string };

export function SendConsoleAction(Config: AhConfig, Plan: AhActionPlan): Promise<AhActionOutcome> {
  const BudgetMs = Math.max(500, Config.TimeoutMs | 0);
  const N = Config.BaseChannel;
  const Parser = new MidiStreamParser();
  let Phase: 'preflight' | 'confirm' | 'done' = 'preflight';
  let Name: string | null = null;

  const SendCommand = (Session: TcpSession<AhActionOutcome>): void => {
    const Bytes =
      Plan.ConfirmMuteNote == null
        ? Plan.Command
        : Buffer.concat([Plan.Command, DliveMuteRequest(N, Plan.ConfirmMuteNote)]);
    Phase = Plan.ConfirmMuteNote == null ? 'done' : 'confirm';
    Session.Socket.write(Bytes, (Err) => {
      if (Err) Session.Finish({ Sent: false, Error: ErrorMessage(Err) });
      else if (Phase === 'done') Session.Finish({ Sent: true, Name, Muted: null });
    });
  };

  return RunTcpSession<AhActionOutcome>({
    Address: Config.Address,
    Port: Config.Port,
    IdleMs: BudgetMs,
    DeadlineMs: BudgetMs,
    NoDelay: true,
    OnConnect: (Session) => {
      if (Plan.PreflightNote == null) {
        SendCommand(Session);
        return;
      }
      Session.Socket.write(NameRequest(N, Plan.PreflightNote));
    },
    OnData: (Chunk, Session) => {
      for (const Event of Parser.Feed(Chunk)) {
        if (Phase === 'preflight' && Event.Type === 'sysex') {
          const Reply = ParseNameReply(Event.Data);
          if (!Reply || Reply.MidiChannel !== N || Reply.Note !== Plan.PreflightNote) continue;
          Name = Reply.Name || null;
          SendCommand(Session);
        } else if (
          Phase === 'confirm' &&
          Event.Type === 'note' &&
          Event.Velocity !== 0 &&
          Event.Channel === N &&
          Event.Note === Plan.ConfirmMuteNote
        ) {
          Session.Finish({ Sent: true, Name, Muted: Event.Velocity >= 0x40 });
          return;
        }
      }
    },
    OnTimeout: () =>
      Phase === 'preflight'
        ? {
            Sent: false,
            Error: `The console did not answer on MIDI channel ${N + 1} within ${BudgetMs}ms, so nothing was sent. Check the console family and base MIDI channel.`,
          }
        : // Sent; the read-back did not arrive in time.
          { Sent: true, Name, Muted: null },
    OnError: (Message) =>
      Phase === 'preflight'
        ? { Sent: false, Error: `${Message}. Nothing was sent.` }
        : { Sent: false, Error: `${Message}. The command may not have reached the console.` },
    OnClose: () =>
      Phase === 'preflight'
        ? { Sent: false, Error: 'The console closed the connection, so nothing was sent.' }
        : { Sent: true, Name, Muted: null },
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
  const Family = Config.Family;
  const Label = FAMILY_LABELS[Family];
  // dLive and Avantis can prove the console is listening first; the SQ has no
  // safe read outside the mute 'get', so its command is sent straight away.
  const CanPreflight = Family !== 'sq';

  if (ActionID === 'scene.recall') {
    const Max = SCENE_COUNTS[Family];
    const Scene = ParseWhole(Params && Params.Scene, 1, Max);
    if (Scene == null) return { Success: false, Error: `Scene must be 1 to ${Max} on ${Label}` };
    if (Family === 'dlive' && Config.Port === DLIVE_SURFACE_PORT) {
      return {
        Success: false,
        Error:
          'Scene recall needs the dLive MixRack (port 51325). The Surface reads this message as a cue recall instead.',
      };
    }
    const Outcome = await SendConsoleAction(Config, {
      Command: SceneRecallMessage(Config.BaseChannel, Scene),
      PreflightNote: CanPreflight ? 0 : null,
      ConfirmMuteNote: null,
    });
    if (!Outcome.Sent) return { Success: false, Error: Outcome.Error };
    return { Success: true, Detail: `Scene ${Scene} recalled` };
  }

  if (ActionID === 'mute.on' || ActionID === 'mute.off') {
    const Max = INPUT_COUNTS[Family];
    const Channel = ParseWhole(Params && Params.Channel, 1, Max);
    if (Channel == null) {
      return { Success: false, Error: `Input channel must be 1 to ${Max} on ${Label}` };
    }
    const Mute = ActionID === 'mute.on';
    const Note = Channel - 1;
    const Outcome = await SendConsoleAction(Config, {
      Command: MuteMessage(Family, Config.BaseChannel, Channel, Mute),
      PreflightNote: CanPreflight ? Note : null,
      // Only dLive documents a mute read; the SQ 'get' is not used from an
      // action, so an SQ on old firmware can never see a stray toggle.
      ConfirmMuteNote: Family === 'dlive' ? Note : null,
    });
    if (!Outcome.Sent) return { Success: false, Error: Outcome.Error };
    const Which = Outcome.Name ? `Input ${Channel} (${Outcome.Name})` : `Input ${Channel}`;
    if (Outcome.Muted != null && Outcome.Muted !== Mute) {
      return {
        Success: false,
        Error: `The console still reports ${Which} as ${Outcome.Muted ? 'muted' : 'unmuted'}`,
      };
    }
    return { Success: true, Detail: `${Which} ${Mute ? 'muted' : 'unmuted'}` };
  }

  return { Success: false, Error: `Unknown Allen & Heath action "${ActionID}"` };
}

// Bind the scene or channel into a favourite's label.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID === 'scene.recall') {
    const Scene = ParseWhole(Params && Params.Scene, 1, 500);
    return Scene == null ? null : `Recall Scene ${Scene}`;
  }
  if (ActionID === 'mute.on' || ActionID === 'mute.off') {
    const Channel = ParseWhole(Params && Params.Channel, 1, 128);
    if (Channel == null) return null;
    return `${ActionID === 'mute.on' ? 'Mute' : 'Unmute'} Input ${Channel}`;
  }
  return null;
}

// --- Run / Debug -----------------------------------------------------------------

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const ConfigError = ValidateConfig(Config);
  if (ConfigError) return { Success: false, Error: ConfigError };
  const Options = ParseHealthOptions(Target);

  let Outcome: AhProbeOutcome;
  try {
    Outcome = await QueryConsole(Config, {
      MainMute: Options.CheckMainMute,
      Channels: Options.CheckChannelMutes ? Options.Channels : [],
    });
  } catch (Err) {
    return { Success: false, Error: ErrorMessage(Err) };
  }
  if (!Outcome.Reachable) {
    return {
      Success: false,
      ...(Outcome.Refused ? { Degraded: true } : {}),
      Error: Outcome.Error,
    };
  }

  const Snap = Outcome.Snapshot;
  const Reasons = EvaluateHealth(Snap, Options, Config.Family);
  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snap.LatencyMs,
    Family: Config.Family,
    IsAllenHeath: Snap.IsAllenHeath,
    Input1Name: Snap.Input1Name,
    MainMuted: Snap.MainMuted,
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
  const Family = FAMILY_LABELS[Config.Family];

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    TextRow(
      'Console',
      `${Family}, MIDI channel ${Config.BaseChannel >= 0 ? Config.BaseChannel + 1 : '—'}`
    ),
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Failed to reach the console'),
    Reachable && Result.IsAllenHeath == null
      ? TextRow(
          'Identity',
          'Connected. The SQ has no identity query, so only the connection is checked.'
        )
      : null,
    Reachable && Result.Input1Name != null
      ? TextRow('Input 1 name', String(Result.Input1Name))
      : null,
    Reachable && Options.CheckMainMute
      ? Row(
          Config.Family === 'sq' ? 'LR' : 'Main 1',
          Result.MainMuted === true
            ? Pill('warning', 'Muted')
            : Result.MainMuted === false
              ? Pill('success', 'On')
              : Pill('muted', 'No reply')
        )
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        `Failed to reach the console's MIDI over TCP port. Use 51325 for SQ, Avantis and a dLive MixRack, and 51328 for a dLive Surface.`
      ) +
      '</div>'
    );
  }

  const Channels = Array.isArray(Result.Channels) ? (Result.Channels as AhChannelState[]) : [];
  if (!Options.CheckChannelMutes || !Channels.length) return Head;
  const Cards = Channels.map((C) =>
    Card({
      Title: ChannelLabel(C),
      Badge: !C.Supported
        ? Pill('warning', `Not on ${Family}`)
        : C.Muted === false
          ? Pill('success', 'On')
          : C.Muted === true
            ? Pill('warning', 'Muted')
            : Pill('muted', 'No reply'),
    })
  ).join('');
  return Head + `<div class="d-grid gap-1 mt-2">${Cards}</div>`;
}

export const Name = 'Allen & Heath dLive / Avantis / SQ';
export const Description =
  'Connects to an Allen & Heath dLive, Avantis or SQ console on its MIDI over TCP port (51325, or 51328 for a dLive Surface) and confirms it answers. Optionally flags a muted main mix or muted input channels on dLive and SQ. The check itself only sends documented queries; scene recall and input mute are separate operator actions.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseHealthOptions,
  ParseChannelList,
  ParseFamily,
  MidiStreamParser,
  NrpnTracker,
  NameRequest,
  DliveMuteRequest,
  SqGetRequest,
  SqInputMute,
  SceneRecallMessage,
  MuteMessage,
  ParseWhole,
  ParseNameReply,
  EvaluateHealth,
  QueryConsole,
};
export { ID, Settings, Actions, Run, RunAction, DescribeAction, Debug };
