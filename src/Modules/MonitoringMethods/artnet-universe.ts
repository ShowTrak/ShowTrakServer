// Art-Net monitoring: confirms a specific transmitter (source IP) is currently
// sending a given Art-Net universe (0-32767, the 15-bit Port-Address).
//
// Like sACN, Art-Net is a *passive* protocol: transmitters continuously emit
// ArtDmx packets and there is nothing to actively probe, so instead of opening a
// socket per check we run ONE process-wide receiver:
//
//   - A single UDP socket bound to port 6454 (shared with SO_REUSEADDR).
//   - Unlike sACN, Art-Net is delivered by directed broadcast or unicast, NOT
//     multicast, so there are no groups to join — binding the socket is enough
//     to receive every universe on the wire. Because the socket is bound to the
//     wildcard address (0.0.0.0), the kernel delivers broadcast/unicast arriving
//     on ANY interface, including VLAN NICs that appear or disappear at runtime;
//     there are no per-interface memberships to reconcile (contrast sACN, which
//     must re-join its multicast groups when interfaces change).
//   - Inbound ArtDmx packets are parsed and the latest state per (universe,
//     source IP) is cached in memory. A check's Run() merely reads that cache.
//
// Art-Net has no per-packet priority (that is an sACN concept) and ArtDmx carries
// no source name, so a universe is either being transmitted from the target or it
// is not — there is a single check with no priority variant.
//
// Universes whose checks stop asking about them are swept out after INTEREST_TTL_MS
// so the map doesn't grow forever. The receiver is fully lazy — nothing binds
// until the first Observe() — so importing this module has no side effects.
import dgram from 'dgram';
import { CreateLogger } from '../Logger';
import { ARTNET_PORT } from '../Config/constants';
import { Pill, Rows, TextRow, Row, Note, FormatLatency, Card } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const Logger = CreateLogger('Art-Net');

const ID = 'artnet-universe';

// Art-Net packet header (see the Art-Net 4 spec, ArtDmx / OpOutput).
const ARTNET_PACKET_IDENTIFIER = Buffer.from([
  0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00,
]); // "Art-Net\0"
const OP_ARTDMX = 0x5000; // OpCode for an ArtDmx packet (little-endian on the wire)
const MIN_PROTOCOL_VERSION = 14; // ArtDmx was introduced at protocol revision 14.

// Byte offsets within the UDP payload for the fields we read.
const OFFSET_ID = 0;
const OFFSET_OPCODE = 8; // uint16, little-endian
const OFFSET_PROTVER = 10; // uint16, big-endian
const OFFSET_SEQUENCE = 12;
const OFFSET_SUBUNI = 14; // low byte of the 15-bit Port-Address
const OFFSET_NET = 15; // high 7 bits of the 15-bit Port-Address
// The 18-byte header is the minimum; the DMX slots that follow are optional to us.
const MIN_PACKET_LENGTH = 18;

// Valid Port-Address range: Net (7 bits) << 8 | SubUni (8 bits) = 0..32767.
export const MIN_UNIVERSE = 0;
export const MAX_UNIVERSE = 32767;
// Default freshness window: how recently a packet must have arrived for a source
// to count as "currently transmitting". Continuous senders refresh well under a
// second, so a few seconds tolerates a couple of dropped frames.
export const DEFAULT_GRACE_PERIOD_MS = 5000;
// How responsive the checks feel; Art-Net state changes fast, so poll often.
export const DEFAULT_ARTNET_INTERVAL_MS = 5000;

const INTEREST_TTL_MS = 120000; // drop a universe from the map if unwatched this long
const SOURCE_RETENTION_MS = 60000; // forget a source unheard-from this long
const SWEEP_INTERVAL_MS = 30000;
const RETRY_COOLDOWN_MS = 15000; // after a bind failure, wait before retrying

// Strip the IPv4-mapped IPv6 prefix so comparisons against a user-entered IPv4
// address work regardless of how the OS surfaced the sender address.
export function NormalizeAddress(Address: unknown): string {
  return String(Address == null ? '' : Address)
    .trim()
    .replace(/^::ffff:/i, '')
    .toLowerCase();
}

function AddressesEqual(A: unknown, B: unknown): boolean {
  const Na = NormalizeAddress(A);
  const Nb = NormalizeAddress(B);
  return Na !== '' && Na === Nb;
}

export interface ArtnetSource {
  Address: string;
  Sequence: number;
  Universe: number;
  LastSeenAt: number;
}

// Parse an inbound datagram as an ArtDmx packet. Returns null for anything that
// is not a well-formed ArtDmx packet (ArtPoll, ArtPollReply, other protocols,
// runts).
export function ParseArtnetPacket(
  Msg: Buffer,
  SourceAddress: string
): ArtnetSource | null {
  if (!Buffer.isBuffer(Msg) || Msg.length < MIN_PACKET_LENGTH) return null;
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
  if (Msg.readUInt16LE(OFFSET_OPCODE) !== OP_ARTDMX) return null;
  if (Msg.readUInt16BE(OFFSET_PROTVER) < MIN_PROTOCOL_VERSION) return null;

  const SubUni = Msg[OFFSET_SUBUNI]!; // in range: length checked >= MIN_PACKET_LENGTH above
  const Net = Msg[OFFSET_NET]! & 0x7f; // in range: length checked >= MIN_PACKET_LENGTH above
  const Universe = (Net << 8) | SubUni;

  return {
    Address: NormalizeAddress(SourceAddress),
    Sequence: Msg[OFFSET_SEQUENCE]!, // in range: length checked >= MIN_PACKET_LENGTH above
    Universe,
    LastSeenAt: Date.now(),
  };
}

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

// The process-wide singleton receiver.
class ArtnetReceiverImpl {
  private Universes = new Map<number, UniverseEntry>();
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
      Error: this.State === 'failed' ? this.LastError : null,
      Sources: Entry ? Array.from(Entry.Sources.values()) : [],
    };
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
      this.HandleMessage(Msg, RInfo)
    );
    Sock.on('listening', () => {
      if (this.Socket !== Sock) return;
      this.State = 'ready';
      Logger.log(`Art-Net receiver listening on udp/${ARTNET_PORT}`);
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

  private Fail(Err: unknown): void {
    this.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    this.LastFailAt = Date.now();
    this.State = 'failed';
    this.Socket = null;
    Logger.warn(`Art-Net receiver unavailable: ${this.LastError}`);
  }

  private HandleMessage(Msg: Buffer, RInfo: dgram.RemoteInfo): void {
    const Parsed = ParseArtnetPacket(Msg, RInfo && RInfo.address ? RInfo.address : '');
    if (!Parsed) return;
    // Ignore universes nothing is watching.
    const Entry = this.Universes.get(Parsed.Universe);
    if (!Entry) return;
    Entry.Sources.set(Parsed.Address, Parsed);
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
  }
}

export const ArtnetReceiver = new ArtnetReceiverImpl();

// --- Settings / Run / Debug --------------------------------------------------

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Universe',
    Label: 'Universe',
    Type: 'number',
    Default: 0,
    Min: MIN_UNIVERSE,
    Max: MAX_UNIVERSE,
    Required: true,
  },
  {
    Key: 'Timeout',
    Label: 'Grace period (ms)',
    Type: 'number',
    Default: DEFAULT_GRACE_PERIOD_MS,
    Min: 500,
    Max: 60000,
    Advanced: true,
  },
];

interface EvaluateParams {
  Snapshot: ArtnetSnapshot;
  Address: string;
  Universe: number;
  GracePeriodMs: number;
  Now: number;
}

// Pure decision logic, separated from the receiver so it can be unit-tested with
// a hand-built snapshot. Result semantics match MonitoringTarget.Tick:
//   Success:true               -> online (target source is transmitting)
//   Success:false + Degraded   -> amber (universe present, but from another source)
//   Success:false              -> offline (universe not seen from anyone)
export function EvaluateArtnet(P: EvaluateParams): MonitoringResult {
  const Base = {
    Universe: P.Universe,
    Address: P.Address,
  };

  if (P.Snapshot.Error) {
    return { Success: false, Error: `Art-Net listener error: ${P.Snapshot.Error}`, ...Base, Sources: [] };
  }

  const Fresh = P.Snapshot.Sources.filter((S) => P.Now - S.LastSeenAt <= P.GracePeriodMs).sort(
    (A, B) => B.LastSeenAt - A.LastSeenAt
  );
  const WithSources = { ...Base, Sources: Fresh };

  const FromTarget = Fresh.filter((S) => AddressesEqual(S.Address, P.Address));
  if (FromTarget.length) {
    const Src = FromTarget[0]!; // non-empty: length checked above
    return {
      Success: true,
      LatencyMs: P.Now - Src.LastSeenAt,
      Matched: true,
      MatchedSource: Src,
      ...WithSources,
    };
  }

  if (Fresh.length) {
    const Other = Fresh[0]!; // non-empty: length checked above
    return {
      Success: false,
      Degraded: true,
      DegradedReason: `Universe ${P.Universe} present from ${Other.Address}, not ${P.Address}`,
      Matched: false,
      ...WithSources,
    };
  }

  return {
    Success: false,
    Error: P.Snapshot.Ready
      ? `No Art-Net data for universe ${P.Universe} from ${P.Address}`
      : 'Art-Net listener starting…',
    Matched: false,
    ...WithSources,
  };
}

function Run(Target: MonitoringTargetLike): MonitoringResult {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No source IP configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Universe = Number.isFinite(Cfg.Universe) ? (Cfg.Universe as number) | 0 : 0;
  if (Universe < MIN_UNIVERSE || Universe > MAX_UNIVERSE) {
    return { Success: false, Error: `Invalid universe: ${Universe}` };
  }

  const GracePeriodMs = Number.isFinite(Cfg.Timeout)
    ? Math.max(500, (Cfg.Timeout as number) | 0)
    : DEFAULT_GRACE_PERIOD_MS;

  ArtnetReceiver.Observe(Universe);
  const Snapshot = ArtnetReceiver.Snapshot(Universe);

  return EvaluateArtnet({
    Snapshot,
    Address,
    Universe,
    GracePeriodMs,
    Now: Date.now(),
  });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Universe =
    Result && Number.isFinite(Result.Universe as number)
      ? (Result.Universe as number)
      : Number.isFinite(Cfg.Universe)
        ? (Cfg.Universe as number) | 0
        : 0;

  const Online = !!(Result && Result.Success);
  const Degraded = !!(Result && Result.Degraded);
  const StatusPill = Online
    ? Pill('success', 'Receiving')
    : Degraded
      ? Pill('warning', (Result && (Result.DegradedReason as string)) || 'Degraded')
      : Pill('danger', 'Not receiving');

  const Head = Rows([
    TextRow('Source IP', Address || '—'),
    TextRow('Universe', String(Universe)),
    Row('Status', StatusPill),
    Online
      ? Row('Data age', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : Result && Result.Error
        ? TextRow('Detail', Result.Error as string)
        : null,
  ]);

  const Sources: ArtnetSource[] = Array.isArray(Result && Result.Sources)
    ? (Result.Sources as ArtnetSource[])
    : [];
  if (!Sources.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note('No sources currently transmitting this universe') +
      '</div>'
    );
  }

  const List = Sources.map((S) => {
    const IsTarget = AddressesEqual(S.Address, Address);
    return Card({
      Title: S.Address,
      TitleClass: 'font-monospace',
      Badge: IsTarget ? Pill('success', 'Target') : Pill('muted', 'Other'),
      Highlight: IsTarget,
    });
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Sources on universe ${Universe} (${Sources.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>`
  );
}

export const Name = 'Art-Net - Receiving universe from target';
export const Description =
  'Passively listens for Art-Net (ArtDmx) data and confirms the configured source IP is transmitting the given universe.';
export const DefaultInterval = DEFAULT_ARTNET_INTERVAL_MS;
// Passive listener: no round-trip latency is measured, so the latency-based
// Degraded Threshold field is hidden in the editor.
export const SupportsLatencyThreshold = false;
export { ID, Settings, Run, Debug };

// Exported for unit tests.
export const _internal = {
  ParseArtnetPacket,
  NormalizeAddress,
  AddressesEqual,
  EvaluateArtnet,
  ArtnetReceiver,
};
