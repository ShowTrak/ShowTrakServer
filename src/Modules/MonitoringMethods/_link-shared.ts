// Shared plumbing for the Ableton Link monitoring method: the discovery-message
// decoder and the ONE process-wide UDP receiver on port 20808.
//
// Link is a peer-to-peer protocol with no server to ask. Every Link-enabled app
// multicasts its state as an ALIVE message to 224.76.78.75:20808 on each of its
// IPv4 interfaces (and on IPv6 link-local ff12::8080 as a backup; see below),
// every 250 ms, and multicasts a BYEBYE when it leaves. So, like sACN, the check
// is passive: one socket bound to 20808 (SO_REUSEADDR, so a Link app on this
// host can bind it too) joins the group on every interface and caches the latest
// state per peer node ID. A check's Run() merely reads that cache.
//
// ShowTrak never sends anything. Sending an ALIVE would make every Link app
// answer us (good for a fast first read) but would also add ShowTrak to their
// peer count ("2 Links" in Live's toolbar), which misreports the rig, so this is
// purely passive. The cost is that the first read after the listener starts has
// to wait for the next round of ALIVE broadcasts; Run() waits WARMUP_MS for that.
// RESPONSE messages are unicast back to the ALIVE's sender, so a passive
// listener never sees them; they are decoded anyway for completeness.
//
// Wire format, from the Link source (github.com/Ableton/link, master 4f5be99,
// 2026-11-10). All integers are big-endian (network byte order):
//
//   offset size
//   0      8   protocol header '_asdp_v' + 0x01
//                (include/ableton/discovery/v1/Messages.hpp:97-98)
//   8      1   message type: 1 ALIVE, 2 RESPONSE, 3 BYEBYE (Messages.hpp:40-43)
//   9      1   TTL in seconds (Messages.hpp:49)
//   10     2   session group ID, always 0; Link ignores any other value
//                (Messages.hpp:50, 109; discovery/UdpMessenger.hpp:283)
//   12     8   node ID, 8 random bytes (link/NodeId.hpp:34)
//   20     -   payload: a run of entries, each a uint32 key, a uint32 size and
//              `size` bytes of value (discovery/Payload.hpp:32-63). Unknown keys
//              are skipped (Payload.hpp:129-137). An entry whose size runs past
//              the end, or a known entry whose value is not exactly its own size,
//              makes Link drop the WHOLE message (Payload.hpp:123-127, 262-266;
//              UdpMessenger.hpp:313-326), so the decoder below does the same.
//
// Payload entries of a peer state (link/NodeState.hpp:66-69, link/PeerState.hpp):
//   'tmln' 24 B  Timeline (link/Timeline.hpp:41, 78-94): tempo as int64
//                microseconds per beat (link/Tempo.hpp:40-41, 79-85), beat
//                origin as int64 micro-beats (link/Beats.hpp:101-105) and time
//                origin as int64 microseconds.
//   'sess'  8 B  Session ID: the founding node's ID (link/SessionId.hpp:29-36).
//   'stst' 17 B  StartStopState (link/StartStopState.hpp:38-41): isPlaying as a
//                uint8 (non-zero = true, NetworkByteStreamSerializable.hpp:264-286),
//                beats as int64 micro-beats, timestamp as int64 microseconds.
//                All-zero is the "never set" default (StartStopState.hpp:89-91).
//   'artl' 24 B  Arrangement timeline (link/ArrangementTimeline.hpp:34-37), only
//                when set; read for size only.
//   'mep4'  6 B  Measurement endpoint, IPv4 as uint32 + uint16 port
//                (link/PeerState.hpp:40; link/EndpointV4.hpp:58-69).
//   'mep6' 18 B  Measurement endpoint, IPv6 16 bytes + uint16 port (EndpointV6.hpp).
//   'aep4' / 'aep6'  Link Audio endpoints, same layouts (PeerState.hpp:48-52).
//
// Expiry: a peer is forgotten TTL seconds after its last ALIVE/RESPONSE, and
// Link's prune timer adds one second of padding (discovery/PeerGateway.hpp:106-124,
// 159-165). A BYEBYE removes it at once (PeerGateway.hpp:126-135). Every Link
// app currently sends TTL 5 with a TTL ratio of 20 (PeerGateway.hpp:240-241), so
// it re-announces every 5000 / 20 = 250 ms (UdpMessenger.hpp:208-209).
//
// IPv6: Link adds an interface's IPv6 link-local address only "as backup in case
// multicast on IPv4 fails", and only for interfaces that also have IPv4
// (platforms/posix/ScanIpIfAddrs.hpp:104-125, platforms/windows/ScanIpIfAddrs.hpp:141),
// so every peer that is reachable over IPv4 also announces on IPv4. This
// receiver listens on IPv4 only.
import dgram from 'dgram';
import { CreateLogger } from '../Logger';
import { Manager as NetworkInterfaces, type InterfaceChange } from '../NetworkInterfaces';
import { MONITORING_INTEREST_TTL_MS } from '../Config/constants';

const Logger = CreateLogger('Ableton Link');

// --- Protocol constants --------------------------------------------------------

export const LINK_MULTICAST_GROUP = '224.76.78.75'; // discovery/IpInterface.hpp:30-33
export const LINK_PORT = 20808;
export const LINK_PROTOCOL_HEADER = Buffer.from([0x5f, 0x61, 0x73, 0x64, 0x70, 0x5f, 0x76, 0x01]); // "_asdp_v" 0x01

export const MESSAGE_ALIVE = 1;
export const MESSAGE_RESPONSE = 2;
export const MESSAGE_BYEBYE = 3;

const OFFSET_TYPE = 8;
const OFFSET_TTL = 9;
const OFFSET_GROUP = 10;
const OFFSET_NODE_ID = 12;
const NODE_ID_LENGTH = 8;
export const HEADER_LENGTH = OFFSET_NODE_ID + NODE_ID_LENGTH; // 20
const ENTRY_HEADER_LENGTH = 8;

// Payload entry keys: the four ASCII characters as a big-endian uint32.
export const KEY_TIMELINE = 0x746d6c6e; // 'tmln'
export const KEY_SESSION = 0x73657373; // 'sess'
export const KEY_START_STOP = 0x73747374; // 'stst'
export const KEY_ARRANGEMENT = 0x6172746c; // 'artl'
export const KEY_MEP4 = 0x6d657034; // 'mep4'
export const KEY_MEP6 = 0x6d657036; // 'mep6'
export const KEY_AEP4 = 0x61657034; // 'aep4'
export const KEY_AEP6 = 0x61657036; // 'aep6'

// The exact value size Link requires for each entry it understands. Anything
// else under one of these keys makes Link reject the message.
const ENTRY_SIZES: Record<number, number> = {
  [KEY_TIMELINE]: 24,
  [KEY_SESSION]: 8,
  [KEY_START_STOP]: 17,
  [KEY_ARRANGEMENT]: 24,
  [KEY_MEP4]: 6,
  [KEY_MEP6]: 18,
  [KEY_AEP4]: 6,
  [KEY_AEP6]: 18,
};

// Link clamps a session's tempo to this range (link/ClientSessionTimelines.hpp:33-35).
export const MIN_TEMPO_BPM = 20;
export const MAX_TEMPO_BPM = 999;

// The nominal re-announce period every Link app uses (TTL 5 s / ratio 20).
export const LINK_BROADCAST_PERIOD_MS = 250;
// Link's prune timer pads each peer's expiry by a second (PeerGateway.hpp:162-164).
export const EXPIRY_PADDING_MS = 1000;

// After the socket starts listening, the first Run() waits this long so at least
// a couple of ALIVE rounds (one every 250 ms) have arrived before it judges.
export const WARMUP_MS = 750;

const INTEREST_TTL_MS = MONITORING_INTEREST_TTL_MS; // close the socket if unwatched this long
const SWEEP_INTERVAL_MS = 30000;
const RETRY_COOLDOWN_MS = 15000; // after a bind failure, wait before retrying
// Cap on cached peers so a flood of spoofed node IDs cannot grow memory without
// bound between sweeps. A real Link session is a handful of apps.
export const MAX_PEERS = 256;

// --- Decoder -------------------------------------------------------------------

export interface LinkPeerState {
  Type: typeof MESSAGE_ALIVE | typeof MESSAGE_RESPONSE;
  Ttl: number;
  NodeId: string;
  // Hex of the 8-byte session ID. A message without a 'sess' entry leaves Link's
  // default all-zero ID, reproduced here.
  SessionId: string;
  // Null when the message had no 'tmln' entry or a non-positive tempo.
  Tempo: number | null;
  MicrosPerBeat: number | null;
  // Null when the message had no 'stst' entry (Link before 3.0).
  IsPlaying: boolean | null;
  // Session ghost time of the last start/stop change (µs). 0 = never set.
  StartStopTimestamp: number | null;
  // The peer's own ping endpoint, 'a.b.c.d:port', when it sent 'mep4'.
  MeasurementEndpoint: string | null;
}

export interface LinkByeBye {
  Type: typeof MESSAGE_BYEBYE;
  NodeId: string;
}

export type LinkMessage = LinkPeerState | LinkByeBye;

function Hex(Msg: Buffer, Offset: number, Length: number): string {
  return Msg.subarray(Offset, Offset + Length).toString('hex');
}

function ReadInt64(Msg: Buffer, Offset: number): number {
  return Number(Msg.readBigInt64BE(Offset));
}

// Decode one datagram as a Link discovery message. Returns null for anything
// Link itself would ignore: other protocols, runts, a non-zero group, an unknown
// message type or a malformed payload.
export function ParseLinkMessage(Msg: unknown): LinkMessage | null {
  if (!Buffer.isBuffer(Msg) || Msg.length < HEADER_LENGTH) return null;
  if (Msg.compare(LINK_PROTOCOL_HEADER, 0, LINK_PROTOCOL_HEADER.length, 0, 8) !== 0) return null;
  if (Msg.readUInt16BE(OFFSET_GROUP) !== 0) return null;

  const Type = Msg[OFFSET_TYPE]!; // in range: length checked >= HEADER_LENGTH above
  const NodeId = Hex(Msg, OFFSET_NODE_ID, NODE_ID_LENGTH);
  // Link reads no payload from a BYEBYE (UdpMessenger.hpp:298-300).
  if (Type === MESSAGE_BYEBYE) return { Type: MESSAGE_BYEBYE, NodeId };
  if (Type !== MESSAGE_ALIVE && Type !== MESSAGE_RESPONSE) return null;

  const State: LinkPeerState = {
    Type,
    Ttl: Msg[OFFSET_TTL]!, // in range: length checked >= HEADER_LENGTH above
    NodeId,
    SessionId: '0000000000000000',
    Tempo: null,
    MicrosPerBeat: null,
    IsPlaying: null,
    StartStopTimestamp: null,
    MeasurementEndpoint: null,
  };

  let Offset = HEADER_LENGTH;
  while (Offset < Msg.length) {
    if (Offset + ENTRY_HEADER_LENGTH > Msg.length) return null;
    const Key = Msg.readUInt32BE(Offset);
    const Size = Msg.readUInt32BE(Offset + 4);
    const ValueAt = Offset + ENTRY_HEADER_LENGTH;
    if (ValueAt + Size > Msg.length) return null;
    const Expected = ENTRY_SIZES[Key];
    if (Expected !== undefined && Size !== Expected) return null;

    if (Key === KEY_TIMELINE) {
      const MicrosPerBeat = ReadInt64(Msg, ValueAt);
      State.MicrosPerBeat = MicrosPerBeat;
      State.Tempo = MicrosPerBeat > 0 ? 60e6 / MicrosPerBeat : null;
    } else if (Key === KEY_SESSION) {
      State.SessionId = Hex(Msg, ValueAt, 8);
    } else if (Key === KEY_START_STOP) {
      State.IsPlaying = Msg[ValueAt]! !== 0; // in range: Size === 17 checked above
      State.StartStopTimestamp = ReadInt64(Msg, ValueAt + 9);
    } else if (Key === KEY_MEP4) {
      const Ip = `${Msg[ValueAt]}.${Msg[ValueAt + 1]}.${Msg[ValueAt + 2]}.${Msg[ValueAt + 3]}`;
      State.MeasurementEndpoint = `${Ip}:${Msg.readUInt16BE(ValueAt + 4)}`;
    }
    Offset = ValueAt + Size;
  }
  return State;
}

// --- Addresses -----------------------------------------------------------------

// Strip the IPv4-mapped IPv6 prefix so comparisons against a user-entered IPv4
// address work regardless of how the OS surfaced the sender address.
export function NormalizeAddress(Address: unknown): string {
  return String(Address == null ? '' : Address)
    .trim()
    .replace(/^::ffff:/i, '')
    .toLowerCase();
}

// --- The receiver ----------------------------------------------------------------

export interface LinkPeer extends Omit<LinkPeerState, 'Type'> {
  // Source address of the datagram that last carried this peer's state.
  Address: string;
  FirstSeenAt: number;
  LastSeenAt: number;
  ExpiresAt: number;
}

export interface LinkSnapshot {
  Ready: boolean;
  Error: string | null;
  Peers: LinkPeer[];
}

class LinkReceiverImpl {
  private Peers = new Map<string, LinkPeer>();
  private Socket: dgram.Socket | null = null;
  private State: 'idle' | 'binding' | 'ready' | 'failed' = 'idle';
  private LastError: string | null = null;
  private LastFailAt = 0;
  private ReadyAt = 0;
  private LastInterestAt = 0;
  private SweepTimer: NodeJS.Timeout | null = null;
  private IfaceUnsub: (() => void) | null = null;
  // Interface addresses the group is currently joined on. '' is the default
  // interface, used only when no explicit join succeeded.
  private JoinedIfaces = new Set<string>();
  private ReadyWaiters: Array<(Ready: boolean) => void> = [];

  // Register interest: start the socket if needed and keep it open for another
  // INTEREST_TTL_MS. Cheap to call on every Run().
  Observe(): void {
    this.LastInterestAt = Date.now();
    this.EnsureStarted();
  }

  // Resolve once the socket has been listening for WARMUP_MS (so the first
  // read after start has heard a round of ALIVEs), or straight away when it
  // already has. Resolves false when the socket failed to bind.
  async WarmUp(): Promise<boolean> {
    const Ready = await this.WhenReady(WARMUP_MS + 1000);
    if (!Ready) return false;
    const Remaining = this.ReadyAt + WARMUP_MS - Date.now();
    if (Remaining > 0) await new Promise((Resolve) => setTimeout(Resolve, Remaining));
    return true;
  }

  Snapshot(Now: number = Date.now()): LinkSnapshot {
    return {
      Ready: this.State === 'ready',
      Error: this.State === 'failed' ? this.LastError : null,
      Peers: Array.from(this.Peers.values())
        .filter((P) => P.ExpiresAt > Now)
        .map((P) => ({ ...P })),
    };
  }

  // Feed one datagram through the decoder. The socket's message handler calls
  // this; tests call it directly with crafted packets.
  Ingest(Msg: Buffer, FromAddress: string, Now: number = Date.now()): void {
    const Parsed = ParseLinkMessage(Msg);
    if (!Parsed) return;
    if (Parsed.Type === MESSAGE_BYEBYE) {
      this.Peers.delete(Parsed.NodeId);
      return;
    }
    const Prev = this.Peers.get(Parsed.NodeId);
    if (!Prev && this.Peers.size >= MAX_PEERS) {
      this.PruneExpired(Now);
      if (this.Peers.size >= MAX_PEERS) return;
    }
    const { Type: _Type, ...State } = Parsed;
    this.Peers.set(Parsed.NodeId, {
      ...State,
      Address: NormalizeAddress(FromAddress),
      FirstSeenAt: Prev ? Prev.FirstSeenAt : Now,
      LastSeenAt: Now,
      ExpiresAt: Now + Parsed.Ttl * 1000 + EXPIRY_PADDING_MS,
    });
  }

  private PruneExpired(Now: number): void {
    for (const [Id, Peer] of this.Peers) {
      if (Peer.ExpiresAt <= Now) this.Peers.delete(Id);
    }
  }

  private WhenReady(TimeoutMs: number): Promise<boolean> {
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
      const Timer = setTimeout(() => {
        this.ReadyWaiters = this.ReadyWaiters.filter((W) => W !== Waiter);
        Waiter(false);
      }, TimeoutMs);
      this.ReadyWaiters.push(Waiter);
    });
  }

  private FlushReadyWaiters(Ready: boolean): void {
    const Waiters = this.ReadyWaiters;
    this.ReadyWaiters = [];
    for (const Waiter of Waiters) Waiter(Ready);
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
      this.ReadyAt = Date.now();
      this.Reconcile();
      Logger.log(`Ableton Link listener on udp/${LINK_PORT} (${LINK_MULTICAST_GROUP})`);
      this.FlushReadyWaiters(true);
    });

    try {
      Sock.bind(LINK_PORT);
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

    if (!this.IfaceUnsub) {
      this.IfaceUnsub = NetworkInterfaces.OnChange((Change) => this.OnInterfacesChanged(Change));
    }
    this.EnsureSweep();
  }

  private OnInterfacesChanged(Change: InterfaceChange): void {
    if (!this.Socket || this.State !== 'ready') return;
    Logger.log(
      `Reconciling Ableton Link membership after interface change ` +
        `(+${Change.Added.length}/-${Change.Removed.length})`
    );
    this.Reconcile();
  }

  // The interfaces to join the group on: every external IPv4 interface, plus
  // loopback, because a Link app on this host announces on 127.0.0.1 with
  // multicast loopback on (platforms/asio/Context.hpp:167-172) and on its other
  // interfaces with it off, so loopback is the only way to hear it.
  private DesiredInterfaces(): string[] {
    const List = NetworkInterfaces.List(true);
    return List.filter((I) => !I.Internal || I.Address === '127.0.0.1').map((I) => I.Address);
  }

  // Join the group on any interface not yet joined and leave it on interfaces
  // that have gone. Safe to call repeatedly; it only issues the deltas.
  private Reconcile(): void {
    if (!this.Socket || this.State !== 'ready') return;
    const Ifaces = this.DesiredInterfaces();
    const Desired = new Set<string>(Ifaces.length ? Ifaces : ['']);
    for (const Ip of Desired) {
      if (this.JoinedIfaces.has(Ip)) continue;
      if (this.TryAddMembership(Ip || undefined)) this.JoinedIfaces.add(Ip);
    }
    if (Ifaces.length && this.JoinedIfaces.size === 0) {
      Desired.add('');
      if (this.TryAddMembership(undefined)) this.JoinedIfaces.add('');
    }
    for (const Ip of Array.from(this.JoinedIfaces)) {
      if (Desired.has(Ip)) continue;
      this.TryDropMembership(Ip || undefined);
      this.JoinedIfaces.delete(Ip);
    }
  }

  private TryAddMembership(Iface?: string): boolean {
    if (!this.Socket) return false;
    try {
      this.Socket.addMembership(LINK_MULTICAST_GROUP, Iface);
      Logger.log(
        `Joined ${LINK_MULTICAST_GROUP}${Iface ? ` on ${Iface}` : ' (default interface)'}`
      );
      return true;
    } catch (Err) {
      // A NIC may not support multicast; other interfaces can still carry it.
      Logger.warn(
        `Failed to join ${LINK_MULTICAST_GROUP}${Iface ? ` on ${Iface}` : ''}: ${
          Err && (Err as Error).message ? (Err as Error).message : Err
        }`
      );
      return false;
    }
  }

  private TryDropMembership(Iface?: string): void {
    if (!this.Socket) return;
    try {
      this.Socket.dropMembership(LINK_MULTICAST_GROUP, Iface);
    } catch {
      // Best-effort; a removed interface drops its membership by itself.
    }
  }

  private Fail(Err: unknown): void {
    this.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    this.LastFailAt = Date.now();
    this.State = 'failed';
    this.Socket = null;
    this.JoinedIfaces.clear();
    if (this.IfaceUnsub) {
      this.IfaceUnsub();
      this.IfaceUnsub = null;
    }
    Logger.warn(`Ableton Link listener unavailable: ${this.LastError}`);
    this.FlushReadyWaiters(false);
  }

  private EnsureSweep(): void {
    if (this.SweepTimer) return;
    this.SweepTimer = setInterval(() => this.Sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
  }

  // Drop expired peers and, once no check has asked for INTEREST_TTL_MS, close
  // the socket altogether.
  Sweep(Now: number = Date.now()): void {
    if (Now - this.LastInterestAt > INTEREST_TTL_MS) {
      if (this.State !== 'idle') Logger.log('Ableton Link listener closed: no checks watching');
      this.Stop();
      return;
    }
    this.PruneExpired(Now);
  }

  // Close the socket and forget everything. Also the test-only teardown.
  Stop(): void {
    if (this.IfaceUnsub) {
      this.IfaceUnsub();
      this.IfaceUnsub = null;
    }
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
    this.ReadyAt = 0;
    this.JoinedIfaces.clear();
    this.Peers.clear();
    this.FlushReadyWaiters(false);
  }

  // Test-only: whether the socket is open (or opening).
  IsOpen(): boolean {
    return this.State === 'ready' || this.State === 'binding';
  }
}

export const LinkReceiver = new LinkReceiverImpl();
export type LinkReceiverType = LinkReceiverImpl;
