// Shared Art-Net plumbing for the artnet-* monitoring methods: the packet
// codecs and the ONE process-wide UDP socket on port 6454.
//
// Why one socket: Art-Net fixes both source and destination port at 0x1936
// (6454) for every packet, and nodes send their ArtPollReply to port 6454 of the
// controller that polled them. Every Art-Net check therefore has to share a
// single socket bound to 6454 (with SO_REUSEADDR so a lighting console or
// DMX-Workshop on the same host can bind it too). That socket:
//
//   - RECEIVES and dispatches by OpCode:
//       ArtDmx       (OpDmx 0x5000)       -> latest state per (universe, source IP),
//                                            only for universes a check observes.
//       ArtPollReply (OpPollReply 0x2100) -> latest reply per (source IP, BindIndex),
//                                            and handed to any poll in flight.
//       ArtTimeCode  (OpTimeCode 0x9700)  -> latest value per (source IP, StreamId),
//                                            only while a timecode check is watching.
//     Everything else (ArtPoll from consoles, ArtSync, RDM, …) is ignored.
//   - SENDS ArtPoll (OpPoll 0x2000), so the node's reply comes back to 6454 —
//     the socket that is already listening — rather than to an ephemeral port a
//     spec-following node would never answer.
//
// Because the socket is bound to the wildcard address, the kernel delivers
// broadcast and unicast arriving on ANY interface, including VLAN NICs that
// appear at runtime; there are no multicast memberships to reconcile (contrast
// sACN). One caveat: when another process on this host has also bound 6454,
// broadcast reaches both sockets but the kernel hands each UNICAST datagram to
// only one of them, so a unicast ArtPollReply can be swallowed by the other
// application. That is inherent to sharing a UDP port and is called out in the
// node check's Info text.
//
// The receiver is fully lazy — nothing binds until the first check asks — so
// importing this module has no side effects. Field offsets are from the Art-Net 4
// specification (Artistic Licence, document revision 1.4dp, 23/10/2025).
import dgram from 'dgram';
import { CreateLogger } from '../Logger';
import { ARTNET_PORT, MONITORING_INTEREST_TTL_MS } from '../Config/constants';

const Logger = CreateLogger('Art-Net');

// --- Packet header -----------------------------------------------------------

export const ARTNET_PACKET_IDENTIFIER = Buffer.from([
  0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00,
]); // "Art-Net\0"
export const OP_POLL = 0x2000;
export const OP_POLL_REPLY = 0x2100;
export const OP_DMX = 0x5000; // OpOutput / OpDmx
export const OP_TIMECODE = 0x9700;
// Current Art-Net protocol revision; ArtDmx was introduced at 14 and the spec
// tells controllers to ignore nodes reporting anything lower.
export const PROTOCOL_VERSION = 14;

const OFFSET_ID = 0;
const OFFSET_OPCODE = 8; // uint16, transmitted low byte first
const OFFSET_PROTVER = 10; // uint16, big-endian (absent from ArtPollReply)
const HEADER_LENGTH = 10; // ID + OpCode — enough to dispatch

// Valid Port-Address range: Net (7 bits) << 8 | SubUni (8 bits) = 0..32767.
export const MIN_UNIVERSE = 0;
export const MAX_UNIVERSE = 32767;

// Drop a universe / stop caching timecode once unwatched this long. Must outlast
// the longest check interval (see MONITORING_INTEREST_TTL_MS).
const INTEREST_TTL_MS = MONITORING_INTEREST_TTL_MS;
const SOURCE_RETENTION_MS = 60000; // forget a source unheard-from this long
const SWEEP_INTERVAL_MS = 30000;
const RETRY_COOLDOWN_MS = 15000; // after a bind failure, wait before retrying
// Caps on per-source caches so a flood of spoofed source addresses cannot grow
// memory without bound between sweeps. Real rigs are far below these.
const MAX_POLL_REPLY_SOURCES = 512;
const MAX_TIMECODE_SOURCES = 256;

// --- Addresses ---------------------------------------------------------------

// Strip the IPv4-mapped IPv6 prefix so comparisons against a user-entered IPv4
// address work regardless of how the OS surfaced the sender address.
export function NormalizeAddress(Address: unknown): string {
  return String(Address == null ? '' : Address)
    .trim()
    .replace(/^::ffff:/i, '')
    .toLowerCase();
}

export function AddressesEqual(A: unknown, B: unknown): boolean {
  const Na = NormalizeAddress(A);
  const Nb = NormalizeAddress(B);
  return Na !== '' && Na === Nb;
}

// The OpCode of a datagram carrying the Art-Net identifier, or null for anything
// else (other protocols, runts).
export function ReadOpCode(Msg: unknown): number | null {
  if (!Buffer.isBuffer(Msg) || Msg.length < HEADER_LENGTH) return null;
  if (
    Msg.compare(
      ARTNET_PACKET_IDENTIFIER,
      0,
      ARTNET_PACKET_IDENTIFIER.length,
      OFFSET_ID,
      OFFSET_ID + ARTNET_PACKET_IDENTIFIER.length
    ) !== 0
  ) {
    return null;
  }
  return Msg.readUInt16LE(OFFSET_OPCODE);
}

// --- ArtDmx ------------------------------------------------------------------

const DMX_OFFSET_SEQUENCE = 12;
const DMX_OFFSET_SUBUNI = 14; // low byte of the 15-bit Port-Address
const DMX_OFFSET_NET = 15; // high 7 bits of the 15-bit Port-Address
// The 18-byte header is the minimum; the DMX slots that follow are optional to us.
const DMX_MIN_LENGTH = 18;

export interface ArtnetSource {
  Address: string;
  Sequence: number;
  Universe: number;
  LastSeenAt: number;
}

// Parse an inbound datagram as an ArtDmx packet. Returns null for anything that
// is not a well-formed ArtDmx packet (ArtPoll, ArtPollReply, other protocols,
// runts).
export function ParseArtnetPacket(Msg: Buffer, SourceAddress: string): ArtnetSource | null {
  if (!Buffer.isBuffer(Msg) || Msg.length < DMX_MIN_LENGTH) return null;
  if (ReadOpCode(Msg) !== OP_DMX) return null;
  if (Msg.readUInt16BE(OFFSET_PROTVER) < PROTOCOL_VERSION) return null;

  const SubUni = Msg[DMX_OFFSET_SUBUNI]!; // in range: length checked >= DMX_MIN_LENGTH above
  const Net = Msg[DMX_OFFSET_NET]! & 0x7f; // in range: length checked >= DMX_MIN_LENGTH above
  const Universe = (Net << 8) | SubUni;

  return {
    Address: NormalizeAddress(SourceAddress),
    Sequence: Msg[DMX_OFFSET_SEQUENCE]!, // in range: length checked >= DMX_MIN_LENGTH above
    Universe,
    LastSeenAt: Date.now(),
  };
}

// --- ArtPoll -----------------------------------------------------------------

// Build the 22-byte Art-Net 4 ArtPoll. Every optional field is zero:
//   Flags = 0x00:   targeted mode off (we want the node whatever it is patched to),
//                   no diagnostics, and bit 1 clear — "only send ArtPollReply in
//                   response to an ArtPoll", so we never ask the node to start
//                   sending us unsolicited replies. ArtPoll is the discovery packet
//                   every controller sends every 2.5–3 s; it changes no
//                   configuration on the node.
//   DiagPriority, TargetPortAddress Top/Bottom, EstaMan, Oem = 0 (unknown).
export function BuildArtPoll(): Buffer {
  const Buf = Buffer.alloc(22);
  ARTNET_PACKET_IDENTIFIER.copy(Buf, 0);
  Buf.writeUInt16LE(OP_POLL, OFFSET_OPCODE);
  Buf.writeUInt16BE(PROTOCOL_VERSION, OFFSET_PROTVER);
  return Buf;
}

// --- ArtPollReply ------------------------------------------------------------
//
// Byte offsets of the ArtPollReply fields (Art-Net 4, fields 1–54; 239 bytes in
// full). The spec obliges consumers to accept replies of 207 bytes or more with
// missing fields read as zero, and older Art-Net II/3 nodes send shorter or
// zero-filled tails, so every read below is length-guarded.
const PR = {
  IpAddress: 10, // [4]
  VersInfoH: 16,
  VersInfoL: 17,
  NetSwitch: 18, // bits 14-8 of the Port-Address in the low 7 bits
  SubSwitch: 19, // bits 7-4 of the Port-Address in the low 4 bits
  OemHi: 20,
  OemLo: 21,
  UbeaVersion: 22,
  Status1: 23,
  EstaManLo: 24, // NB: Lo byte first in ArtPollReply
  EstaManHi: 25,
  ShortName: 26, // [18] null-terminated ("PortName" in the spec)
  LongName: 44, // [64]
  NodeReport: 108, // [64]
  NumPortsHi: 172,
  NumPortsLo: 173,
  PortTypes: 174, // [4]
  GoodInput: 178, // [4]
  GoodOutputA: 182, // [4]
  SwIn: 186, // [4] bits 3-0 of each input port's Port-Address
  SwOut: 190, // [4] bits 3-0 of each output port's Port-Address
  AcnPriority: 194,
  SwMacro: 195,
  SwRemote: 196,
  Style: 200,
  Mac: 201, // [6] Hi..Lo
  BindIp: 207, // [4]
  BindIndex: 211,
  Status2: 212,
  GoodOutputB: 213, // [4]
  Status3: 217,
} as const;
const SHORT_NAME_LENGTH = 18;
const LONG_NAME_LENGTH = 64;
const NODE_REPORT_LENGTH = 64;
const PORT_COUNT = 4; // the per-reply port arrays are fixed at four entries

// PortTypes bits 5-0.
const PORT_PROTOCOLS: Record<number, string> = {
  0: 'DMX512',
  1: 'MIDI',
  2: 'Avab',
  3: 'Colortran CMX',
  4: 'ADB 62.5',
  5: 'Art-Net',
  6: 'DALI',
};

// Table 4 — Style codes.
export const STYLE_CODES: Record<number, string> = {
  0: 'Node',
  1: 'Controller',
  2: 'Media server',
  3: 'Network router',
  4: 'Backup device',
  5: 'Configuration tool',
  6: 'Visualiser',
};

export interface ArtPollReplyPort {
  // 0-3 within this reply (the spec's per-reply port arrays are four long).
  Slot: number;
  PortType: number;
  CanOutput: boolean; // PortTypes bit 7
  CanInput: boolean; // PortTypes bit 6
  Protocol: string;
  GoodInput: number;
  GoodOutputA: number;
  // Null when the reply is too short to carry GoodOutputB (pre-Art-Net 4).
  GoodOutputB: number | null;
  InputUniverse: number;
  OutputUniverse: number;
}

export interface ArtPollReply {
  // The datagram's source IP — what a check matches the target Address against.
  Address: string;
  // The IP the node reports in the packet (field 3). Usually equal to Address.
  ReportedIp: string;
  BindIndex: number;
  BindIp: string | null;
  VersInfoH: number;
  VersInfoL: number;
  NetSwitch: number;
  SubSwitch: number;
  Oem: number;
  EstaMan: number;
  UbeaVersion: number;
  Status1: number;
  Status2: number | null;
  Status3: number | null;
  ShortName: string;
  LongName: string;
  NodeReport: string;
  NumPorts: number;
  Ports: ArtPollReplyPort[];
  Style: number | null;
  Mac: string | null;
  Length: number;
  ReceivedAt: number;
}

function ByteAt(Msg: Buffer, Offset: number): number | null {
  return Offset < Msg.length ? Msg[Offset]! : null; // in range: bounds checked
}

// A fixed-length, null-terminated ASCII field, clamped to what the packet holds.
// Non-printable bytes are dropped so a corrupt field cannot inject control codes.
function ReadCString(Msg: Buffer, Offset: number, Size: number): string {
  if (Offset >= Msg.length) return '';
  const End = Math.min(Msg.length, Offset + Size);
  let Text = '';
  for (let I = Offset; I < End; I++) {
    const Byte = Msg[I]!; // in range: I < End <= Msg.length
    if (Byte === 0) break;
    if (Byte >= 0x20 && Byte !== 0x7f) Text += String.fromCharCode(Byte);
  }
  return Text.trim();
}

function ReadIp(Msg: Buffer, Offset: number): string | null {
  if (Offset + 4 > Msg.length) return null;
  return `${Msg[Offset]}.${Msg[Offset + 1]}.${Msg[Offset + 2]}.${Msg[Offset + 3]}`;
}

// Combine the Net/Sub-Net switches with a port's low nibble into the 15-bit
// Port-Address (Net bits 14-8, Sub-Net bits 7-4, Universe bits 3-0).
export function PortAddress(NetSwitch: number, SubSwitch: number, Sw: number): number {
  return ((NetSwitch & 0x7f) << 8) | ((SubSwitch & 0x0f) << 4) | (Sw & 0x0f);
}

// Parse an inbound datagram as an ArtPollReply. Returns null for anything that
// is not one. Fields beyond the end of a short reply are reported as absent
// (null / empty) rather than guessed.
export function ParseArtPollReply(
  Msg: Buffer,
  SourceAddress: string,
  Now: number = Date.now()
): ArtPollReply | null {
  if (ReadOpCode(Msg) !== OP_POLL_REPLY) return null;
  // Need at least the IP, port, firmware and switch fields to call it a reply.
  if (Msg.length < PR.SubSwitch + 1) return null;

  const Byte = (Offset: number): number => ByteAt(Msg, Offset) ?? 0;
  const NetSwitch = Byte(PR.NetSwitch);
  const SubSwitch = Byte(PR.SubSwitch);

  // Ports: only when every per-port array (up to SwOut) is present, and only the
  // slots whose PortTypes declare a direction. NumPorts is advisory — the spec
  // notes the information is implicit in PortTypes — and nodes commonly report
  // four slots with only some populated.
  const Ports: ArtPollReplyPort[] = [];
  const HasGoodOutputB = Msg.length >= PR.GoodOutputB + PORT_COUNT;
  if (Msg.length >= PR.SwOut + PORT_COUNT) {
    for (let Slot = 0; Slot < PORT_COUNT; Slot++) {
      const PortType = Byte(PR.PortTypes + Slot);
      const CanOutput = (PortType & 0x80) !== 0;
      const CanInput = (PortType & 0x40) !== 0;
      if (!CanOutput && !CanInput) continue;
      const ProtocolCode = PortType & 0x3f;
      Ports.push({
        Slot,
        PortType,
        CanOutput,
        CanInput,
        Protocol: PORT_PROTOCOLS[ProtocolCode] ?? `Protocol ${ProtocolCode}`,
        GoodInput: Byte(PR.GoodInput + Slot),
        GoodOutputA: Byte(PR.GoodOutputA + Slot),
        GoodOutputB: HasGoodOutputB ? Byte(PR.GoodOutputB + Slot) : null,
        InputUniverse: PortAddress(NetSwitch, SubSwitch, Byte(PR.SwIn + Slot)),
        OutputUniverse: PortAddress(NetSwitch, SubSwitch, Byte(PR.SwOut + Slot)),
      });
    }
  }

  let Mac: string | null = null;
  if (Msg.length >= PR.Mac + 6) {
    const Bytes = Array.from(Msg.subarray(PR.Mac, PR.Mac + 6));
    // "Set to zero if node cannot supply this information."
    if (Bytes.some((B) => B !== 0)) {
      Mac = Bytes.map((B) => B.toString(16).padStart(2, '0')).join(':');
    }
  }

  const BindIp = ReadIp(Msg, PR.BindIp);
  return {
    Address: NormalizeAddress(SourceAddress),
    ReportedIp: ReadIp(Msg, PR.IpAddress) ?? '',
    // 0 and 1 both mean "root device"; normalise so a merge keys them together.
    BindIndex: Math.max(1, Byte(PR.BindIndex)),
    BindIp: BindIp && BindIp !== '0.0.0.0' ? BindIp : null,
    VersInfoH: Byte(PR.VersInfoH),
    VersInfoL: Byte(PR.VersInfoL),
    NetSwitch: NetSwitch & 0x7f,
    SubSwitch: SubSwitch & 0x0f,
    Oem: (Byte(PR.OemHi) << 8) | Byte(PR.OemLo),
    EstaMan: (Byte(PR.EstaManHi) << 8) | Byte(PR.EstaManLo),
    UbeaVersion: Byte(PR.UbeaVersion),
    Status1: Byte(PR.Status1),
    Status2: ByteAt(Msg, PR.Status2),
    Status3: ByteAt(Msg, PR.Status3),
    ShortName: ReadCString(Msg, PR.ShortName, SHORT_NAME_LENGTH),
    LongName: ReadCString(Msg, PR.LongName, LONG_NAME_LENGTH),
    NodeReport: ReadCString(Msg, PR.NodeReport, NODE_REPORT_LENGTH),
    NumPorts: (Byte(PR.NumPortsHi) << 8) | Byte(PR.NumPortsLo),
    Ports,
    Style: ByteAt(Msg, PR.Style),
    Mac,
    Length: Msg.length,
    ReceivedAt: Now,
  };
}

// --- ArtTimeCode -------------------------------------------------------------
//
// 19 bytes: ID[8] OpCode ProtVerHi ProtVerLo Filler1 StreamId Frames Seconds
// Minutes Hours Type. StreamId (Art-Net 4; formerly a filler, so legacy senders
// send 0) distinguishes parallel streams, 0x00 being the master.
const TC = {
  StreamId: 13,
  Frames: 14,
  Seconds: 15,
  Minutes: 16,
  Hours: 17,
  Type: 18,
} as const;
const TIMECODE_LENGTH = 19;

export const TIMECODE_TYPES: Record<number, { Label: string; Fps: number; DropFrame: boolean }> = {
  0: { Label: 'Film 24 fps', Fps: 24, DropFrame: false },
  1: { Label: 'EBU 25 fps', Fps: 25, DropFrame: false },
  2: { Label: 'Drop-frame 29.97 fps', Fps: 29.97, DropFrame: true },
  3: { Label: 'SMPTE 30 fps', Fps: 30, DropFrame: false },
};

export interface ArtTimecodePacket {
  Address: string;
  StreamId: number;
  Hours: number;
  Minutes: number;
  Seconds: number;
  Frames: number;
  Type: number;
}

// Parse an inbound datagram as an ArtTimeCode packet. The protocol version is
// deliberately NOT enforced: the packet carries nothing version-dependent and
// rejecting a generator over a header detail would report running timecode as
// absent. Out-of-range fields are rejected as corrupt.
export function ParseArtTimeCode(Msg: Buffer, SourceAddress: string): ArtTimecodePacket | null {
  if (ReadOpCode(Msg) !== OP_TIMECODE) return null;
  if (Msg.length < TIMECODE_LENGTH) return null;
  const Hours = Msg[TC.Hours]!; // in range: length checked >= TIMECODE_LENGTH above
  const Minutes = Msg[TC.Minutes]!; // in range: as above
  const Seconds = Msg[TC.Seconds]!; // in range: as above
  const Frames = Msg[TC.Frames]!; // in range: as above
  const Type = Msg[TC.Type]!; // in range: as above
  if (Hours > 23 || Minutes > 59 || Seconds > 59 || Frames > 29) return null;
  return {
    Address: NormalizeAddress(SourceAddress),
    StreamId: Msg[TC.StreamId]!, // in range: as above
    Hours,
    Minutes,
    Seconds,
    Frames,
    Type,
  };
}

// HH:MM:SS:FF, with ';' before the frames for drop-frame (the SMPTE convention).
export function FormatTimecode(T: {
  Hours: number;
  Minutes: number;
  Seconds: number;
  Frames: number;
  Type: number;
}): string {
  const P = (N: number): string => String(N).padStart(2, '0');
  const Sep = TIMECODE_TYPES[T.Type]?.DropFrame ? ';' : ':';
  return `${P(T.Hours)}:${P(T.Minutes)}:${P(T.Seconds)}${Sep}${P(T.Frames)}`;
}

export interface ArtTimecodeSource extends ArtTimecodePacket {
  LastSeenAt: number;
  // When the time value last differed from the previous packet. Starts at the
  // first packet, so a stream that has never moved stalls from first sight.
  LastChangedAt: number;
  FirstSeenAt: number;
  PacketCount: number;
}

// --- The receiver ------------------------------------------------------------

interface UniverseEntry {
  Universe: number;
  LastInterestAt: number;
  Sources: Map<string, ArtnetSource>;
}

export interface ArtnetSnapshot {
  Ready: boolean;
  Error: string | null;
  Sources: ArtnetSource[];
}

export interface ArtTimecodeSnapshot {
  Ready: boolean;
  Error: string | null;
  Sources: ArtTimecodeSource[];
}

export type PollOutcome =
  | { Ok: true; SentAt: number; FirstReplyAt: number; Replies: ArtPollReply[] }
  | { Ok: false; Error: string };

// After the first reply of a poll arrives, keep listening this long for the
// other BindIndex replies of a node with more than four ports; each new reply
// restarts the window. Bound devices send their replies as a burst.
export const POLL_SETTLE_MS = 300;
// A second poll of the same IP inside this window reuses the last outcome rather
// than putting another ArtPoll on the wire (e.g. the editor's test button racing
// the scheduled run). Well inside the spec's 2.5–3 s controller poll cadence.
export const POLL_MIN_GAP_MS = 1000;

function ReplyMatches(Reply: ArtPollReply, Address: string): boolean {
  // A node with several IPs can answer from one and report another, so accept
  // either the datagram source or the IP the node reports in the packet.
  return Reply.Address === Address || NormalizeAddress(Reply.ReportedIp) === Address;
}

class ArtnetReceiverImpl {
  private Universes = new Map<number, UniverseEntry>();
  // Latest ArtPollReply per source IP, then per BindIndex.
  private PollReplies = new Map<string, Map<number, ArtPollReply>>();
  private Timecodes = new Map<string, ArtTimecodeSource>();
  private TimecodeInterestAt = 0;
  private ReplyListeners = new Set<(Reply: ArtPollReply) => void>();
  private InFlightPolls = new Map<string, Promise<PollOutcome>>();
  private RecentPolls = new Map<string, { At: number; Outcome: PollOutcome }>();
  private ReadyWaiters: Array<(Ready: boolean) => void> = [];
  private Socket: dgram.Socket | null = null;
  private State: 'idle' | 'binding' | 'ready' | 'failed' = 'idle';
  private LastError: string | null = null;
  private LastFailAt = 0;
  private SweepTimer: NodeJS.Timeout | null = null;

  // Register interest in a universe: start the socket if needed and remember that
  // a check is watching it. No multicast join is required for Art-Net.
  Observe(Universe: number): void {
    if (!Number.isInteger(Universe) || Universe < MIN_UNIVERSE || Universe > MAX_UNIVERSE) return;
    this.EnsureStarted();
    let Entry = this.Universes.get(Universe);
    if (!Entry) {
      Entry = {
        Universe,
        LastInterestAt: Date.now(),
        Sources: new Map(),
      };
      this.Universes.set(Universe, Entry);
    }
    Entry.LastInterestAt = Date.now();
  }

  // Read the current cache for a universe. Does not start the socket — callers
  // are expected to Observe() first.
  Snapshot(Universe: number): ArtnetSnapshot {
    const Entry = this.Universes.get(Universe);
    return {
      Ready: this.State === 'ready',
      Error: this.ListenerError(),
      Sources: Entry ? Array.from(Entry.Sources.values()) : [],
    };
  }

  // Register interest in ArtTimeCode. Timecode is only cached while a check has
  // asked within INTEREST_TTL_MS, so a rig with no timecode checks never stores it.
  ObserveTimecode(): void {
    this.EnsureStarted();
    this.TimecodeInterestAt = Date.now();
  }

  TimecodeSnapshot(): ArtTimecodeSnapshot {
    return {
      Ready: this.State === 'ready',
      Error: this.ListenerError(),
      Sources: Array.from(this.Timecodes.values()).map((S) => ({ ...S })),
    };
  }

  // Every cached ArtPollReply (all BindIndexes) from a node, oldest bind first.
  LatestReplies(Address: string): ArtPollReply[] {
    const Entry = this.PollReplies.get(NormalizeAddress(Address));
    return Entry ? Array.from(Entry.values()).sort((A, B) => A.BindIndex - B.BindIndex) : [];
  }

  ListenerError(): string | null {
    return this.State === 'failed' ? this.LastError : null;
  }

  // Resolve true once the socket is listening, false on a bind failure or when
  // TimeoutMs elapses first.
  WhenReady(TimeoutMs: number): Promise<boolean> {
    this.EnsureStarted();
    if (this.State === 'ready') return Promise.resolve(true);
    if (this.State !== 'binding') return Promise.resolve(false);
    return new Promise((Resolve) => {
      let Settled = false;
      const Waiter = (Ready: boolean): void => {
        if (Settled) return;
        Settled = true;
        clearTimeout(Timer);
        Resolve(Ready);
      };
      const Timer = setTimeout(
        () => {
          this.ReadyWaiters = this.ReadyWaiters.filter((W) => W !== Waiter);
          Waiter(false);
        },
        Math.max(0, TimeoutMs)
      );
      this.ReadyWaiters.push(Waiter);
    });
  }

  // Send a datagram from the shared 6454 socket.
  Send(Msg: Buffer, Address: string, Port: number = ARTNET_PORT): Promise<void> {
    const Sock = this.Socket;
    if (!Sock || this.State !== 'ready') {
      return Promise.reject(new Error('Art-Net socket is not ready'));
    }
    return new Promise((Resolve, Reject) => {
      try {
        Sock.send(Msg, Port, Address, (Err) => (Err ? Reject(Err) : Resolve()));
      } catch (Err) {
        Reject(Err instanceof Error ? Err : new Error(String(Err)));
      }
    });
  }

  // Unicast an ArtPoll to one node and collect its ArtPollReply(s). Concurrent
  // polls of the same IP share one ArtPoll, and a poll within POLL_MIN_GAP_MS of
  // the last completed one reuses its outcome, so several checks on one node
  // never multiply the traffic.
  PollNode(
    Address: string,
    TimeoutMs: number,
    SettleMs: number = POLL_SETTLE_MS
  ): Promise<PollOutcome> {
    const Key = NormalizeAddress(Address);
    const InFlight = this.InFlightPolls.get(Key);
    if (InFlight) return InFlight;
    const Recent = this.RecentPolls.get(Key);
    if (Recent && Date.now() - Recent.At < POLL_MIN_GAP_MS) return Promise.resolve(Recent.Outcome);

    const Pending = this.DoPoll(Key, TimeoutMs, SettleMs).then((Outcome) => {
      this.InFlightPolls.delete(Key);
      this.RecentPolls.set(Key, { At: Date.now(), Outcome });
      return Outcome;
    });
    this.InFlightPolls.set(Key, Pending);
    return Pending;
  }

  private async DoPoll(Address: string, TimeoutMs: number, SettleMs: number): Promise<PollOutcome> {
    const Deadline = Date.now() + TimeoutMs;
    const Ready = await this.WhenReady(TimeoutMs);
    if (!Ready) {
      const Err = this.ListenerError();
      return {
        Ok: false,
        Error: Err ? `Art-Net listener error: ${Err}` : 'Art-Net listener starting…',
      };
    }

    return new Promise<PollOutcome>((Resolve) => {
      const Replies = new Map<number, ArtPollReply>();
      let FirstReplyAt: number | null = null;
      let SettleTimer: NodeJS.Timeout | null = null;
      let Done = false;
      // Taken before the send so a reply racing the send callback still counts.
      const SentAt = Date.now();

      const Finish = (SendError?: string): void => {
        if (Done) return;
        Done = true;
        this.ReplyListeners.delete(Listener);
        clearTimeout(DeadlineTimer);
        if (SettleTimer) clearTimeout(SettleTimer);
        if (SendError) Resolve({ Ok: false, Error: SendError });
        else if (FirstReplyAt == null) {
          Resolve({ Ok: false, Error: `No ArtPollReply from ${Address} within ${TimeoutMs} ms` });
        } else {
          Resolve({
            Ok: true,
            SentAt,
            FirstReplyAt,
            Replies: Array.from(Replies.values()).sort((A, B) => A.BindIndex - B.BindIndex),
          });
        }
      };

      // Any reply from the node after our ArtPoll went out counts — including one
      // provoked by another controller's poll, since it equally proves the node
      // is alive now. Replies heard BEFORE the poll never do.
      const Listener = (Reply: ArtPollReply): void => {
        if (Reply.ReceivedAt < SentAt || !ReplyMatches(Reply, Address)) return;
        Replies.set(Reply.BindIndex, Reply);
        if (FirstReplyAt == null) FirstReplyAt = Reply.ReceivedAt;
        if (SettleTimer) clearTimeout(SettleTimer);
        SettleTimer = setTimeout(
          () => Finish(),
          Math.min(SettleMs, Math.max(0, Deadline - Date.now()))
        );
      };

      const DeadlineTimer = setTimeout(() => Finish(), Math.max(0, Deadline - Date.now()));
      this.ReplyListeners.add(Listener);
      this.Send(BuildArtPoll(), Address).catch((Err: unknown) => {
        Finish(`Failed to send ArtPoll: ${Err instanceof Error ? Err.message : String(Err)}`);
      });
    });
  }

  // Feed one datagram through the dispatcher. The socket's message handler calls
  // this; tests call it directly with crafted packets.
  Ingest(Msg: Buffer, FromAddress: string): void {
    const OpCode = ReadOpCode(Msg);
    if (OpCode === OP_DMX) this.IngestDmx(Msg, FromAddress);
    else if (OpCode === OP_POLL_REPLY) this.IngestPollReply(Msg, FromAddress);
    else if (OpCode === OP_TIMECODE) this.IngestTimecode(Msg, FromAddress);
  }

  private IngestDmx(Msg: Buffer, FromAddress: string): void {
    const Parsed = ParseArtnetPacket(Msg, FromAddress);
    if (!Parsed) return;
    // Ignore universes nothing is watching.
    const Entry = this.Universes.get(Parsed.Universe);
    if (!Entry) return;
    Entry.Sources.set(Parsed.Address, Parsed);
  }

  private IngestPollReply(Msg: Buffer, FromAddress: string): void {
    const Reply = ParseArtPollReply(Msg, FromAddress);
    if (!Reply) return;
    let Entry = this.PollReplies.get(Reply.Address);
    if (!Entry && this.PollReplies.size < MAX_POLL_REPLY_SOURCES) {
      Entry = new Map();
      this.PollReplies.set(Reply.Address, Entry);
    }
    if (Entry) Entry.set(Reply.BindIndex, Reply);
    // Copy first: a listener finishing its poll removes itself mid-iteration.
    for (const Listener of Array.from(this.ReplyListeners)) Listener(Reply);
  }

  private IngestTimecode(Msg: Buffer, FromAddress: string): void {
    const Now = Date.now();
    if (!this.TimecodeInterestAt || Now - this.TimecodeInterestAt > INTEREST_TTL_MS) return;
    const Packet = ParseArtTimeCode(Msg, FromAddress);
    if (!Packet) return;
    const Key = `${Packet.Address}#${Packet.StreamId}`;
    const Prev = this.Timecodes.get(Key);
    if (!Prev && this.Timecodes.size >= MAX_TIMECODE_SOURCES) return;
    const Changed =
      !Prev ||
      Prev.Hours !== Packet.Hours ||
      Prev.Minutes !== Packet.Minutes ||
      Prev.Seconds !== Packet.Seconds ||
      Prev.Frames !== Packet.Frames;
    this.Timecodes.set(Key, {
      ...Packet,
      LastSeenAt: Now,
      LastChangedAt: Prev && !Changed ? Prev.LastChangedAt : Now,
      FirstSeenAt: Prev ? Prev.FirstSeenAt : Now,
      PacketCount: (Prev ? Prev.PacketCount : 0) + 1,
    });
  }

  private EnsureStarted(): void {
    if (this.State === 'ready' || this.State === 'binding') return;
    if (this.State === 'failed' && Date.now() - this.LastFailAt < RETRY_COOLDOWN_MS) return;

    this.State = 'binding';
    this.LastError = null;

    let Sock: dgram.Socket;
    try {
      Sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (Err) {
      this.Fail(Err);
      return;
    }
    this.Socket = Sock;

    Sock.on('error', (Err: Error) => {
      if (this.Socket === Sock) this.Fail(Err);
      try {
        Sock.close();
      } catch {
        // already closing
      }
    });
    Sock.on('message', (Msg: Buffer, RInfo: dgram.RemoteInfo) =>
      this.Ingest(Msg, RInfo && RInfo.address ? RInfo.address : '')
    );
    Sock.on('listening', () => {
      if (this.Socket !== Sock) return;
      this.State = 'ready';
      Logger.log(`Art-Net receiver listening on udp/${ARTNET_PORT}`);
      this.FlushReadyWaiters(true);
    });

    try {
      Sock.bind(ARTNET_PORT);
      // Don't keep the event loop (or a test process) alive on our account.
      Sock.unref();
    } catch (Err) {
      this.Fail(Err);
      try {
        Sock.close();
      } catch {
        // ignore
      }
    }

    this.EnsureSweep();
  }

  private FlushReadyWaiters(Ready: boolean): void {
    const Waiters = this.ReadyWaiters;
    this.ReadyWaiters = [];
    for (const Waiter of Waiters) Waiter(Ready);
  }

  private Fail(Err: unknown): void {
    this.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    this.LastFailAt = Date.now();
    this.State = 'failed';
    this.Socket = null;
    Logger.warn(`Art-Net receiver unavailable: ${this.LastError}`);
    this.FlushReadyWaiters(false);
  }

  private EnsureSweep(): void {
    if (this.SweepTimer) return;
    this.SweepTimer = setInterval(() => this.Sweep(), SWEEP_INTERVAL_MS);
    // Timer must not hold the process open by itself.
    if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
  }

  private Sweep(): void {
    const Now = Date.now();
    for (const [Universe, Entry] of this.Universes) {
      if (Now - Entry.LastInterestAt > INTEREST_TTL_MS) {
        this.Universes.delete(Universe);
        continue;
      }
      for (const [Addr, Src] of Entry.Sources) {
        if (Now - Src.LastSeenAt > SOURCE_RETENTION_MS) Entry.Sources.delete(Addr);
      }
    }
    for (const [Addr, Binds] of this.PollReplies) {
      for (const [Index, Reply] of Binds) {
        if (Now - Reply.ReceivedAt > SOURCE_RETENTION_MS) Binds.delete(Index);
      }
      if (!Binds.size) this.PollReplies.delete(Addr);
    }
    for (const [Addr, Last] of this.RecentPolls) {
      if (Now - Last.At > POLL_MIN_GAP_MS) this.RecentPolls.delete(Addr);
    }
    if (Now - this.TimecodeInterestAt > INTEREST_TTL_MS) this.Timecodes.clear();
    for (const [Key, Src] of this.Timecodes) {
      if (Now - Src.LastSeenAt > SOURCE_RETENTION_MS) this.Timecodes.delete(Key);
    }
  }

  // Test-only teardown so a suite can bind/unbind deterministically.
  Stop(): void {
    if (this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
    if (this.Socket) {
      try {
        this.Socket.close();
      } catch {
        // ignore
      }
    }
    this.Socket = null;
    this.State = 'idle';
    this.LastError = null;
    this.Universes.clear();
    this.PollReplies.clear();
    this.Timecodes.clear();
    this.TimecodeInterestAt = 0;
    this.InFlightPolls.clear();
    this.RecentPolls.clear();
    this.FlushReadyWaiters(false);
  }
}

export const ArtnetReceiver = new ArtnetReceiverImpl();
export type ArtnetReceiverType = ArtnetReceiverImpl;
