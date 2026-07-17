// Shared plumbing for the Millumin (Anome) OSC monitoring method.
//
// APPROACH: PASSIVE LISTENER (not an active query).
//
// Millumin's OSC integration is fundamentally one-directional feedback: when the
// operator enables "API feedback" (Device manager -> CMD+K -> OSC tab -> "API
// feedback"), Millumin SENDS OSC messages — all prefixed `/millumin` — to the
// OSC destination(s) configured in that same Device manager. Examples:
//   /millumin/board/launchedColumn        [index, "name"]
//   /millumin/layer:myLayer/mediaStarted  [index, "name", duration]
//   /millumin/selectedLayer/media/time    [time, duration]
//   /millumin/layer:myLayer/opacity       [value]
// There is NO dependable request/response query: even the documented `/ping`
// still requires "API feedback" to be enabled and its reply is delivered to the
// configured feedback destination, not back to the querying socket. So the only
// reliable liveness signal is Millumin's OUTBOUND feedback stream.
//
// Therefore, like sACN, this is a passive protocol: we run ONE process-wide UDP
// receiver per listen port, record the most-recent OSC activity per source IP,
// and Run() simply reads that cache against a freshness/grace window.
//
// >>> USER CONFIG REQUIREMENT <<<
// In Millumin, open the Device manager (CMD+K) -> "OSC" tab, enable "API
// feedback", and add ShowTrak's IP address + this ListenPort as an OSC output
// destination. Without this, Millumin sends nothing and the check reads Offline.
//
// Importing this module has no side effects — nothing binds until the first
// Observe(). Result semantics (consumed by MonitoringTarget.Tick):
//   Success:true             -> online   (matching OSC seen from target within grace)
//   Success:false + hint      -> offline  (OSC arriving, but from a different IP)
//   Success:false            -> offline  (no matching OSC in the grace window)
import dgram from 'dgram';
import { CreateLogger } from '../Logger';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const Logger = CreateLogger('Millumin');

// Default UDP port ShowTrak listens on for Millumin's OSC feedback. The user
// configures this same port as Millumin's OSC output destination.
export const DEFAULT_LISTEN_PORT = 5001;
// How recently a matching OSC message must have arrived for Millumin to count as
// "currently alive". Millumin only emits on state changes / property updates, so
// this is generously wide compared with a continuously-refreshing protocol.
export const DEFAULT_GRACE_PERIOD_MS = 8000;
// Presence changes fast once the show is running, so poll fairly often.
export const DEFAULT_MILLUMIN_INTERVAL_MS = 5000;

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MAX_RECENT_MESSAGES = 12; // recent OSC addresses retained per source for Debug()
const INTEREST_TTL_MS = 120000; // drop a port's socket if unwatched this long
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

// True when an OSC address passes the (optional) prefix filter. An empty filter
// accepts anything; matching is case-insensitive.
export function MatchesFilter(OscAddress: unknown, Filter: unknown): boolean {
  const F = String(Filter == null ? '' : Filter).trim();
  if (!F) return true;
  return String(OscAddress == null ? '' : OscAddress)
    .toLowerCase()
    .startsWith(F.toLowerCase());
}

// --- Minimal OSC decoding ---------------------------------------------------
// We only care about the ADDRESS pattern of each inbound OSC message (presence
// is the signal), so this decoder just walks the packet far enough to collect
// the leading OSC string(s). It handles both plain messages and #bundle packets
// (recursively), and ignores argument payloads entirely.

function OscPad(Len: number): number {
  return (4 - (Len % 4)) % 4;
}

// Read a null-terminated, 4-byte-padded OSC string at Offset. Returns null when
// the buffer is exhausted before a terminator is found.
function ReadOscString(Buf: Buffer, Offset: number): { Value: string; Next: number } | null {
  let End = Offset;
  while (End < Buf.length && Buf[End] !== 0) End++;
  if (End >= Buf.length) return null; // no null terminator -> malformed
  const Value = Buf.toString('utf8', Offset, End);
  const LenWithNull = End - Offset + 1;
  const Next = Offset + LenWithNull + OscPad(LenWithNull);
  return { Value, Next };
}

const BUNDLE_TAG = '#bundle';

// Collect every OSC address pattern in a datagram. A plain message contributes
// its single leading address; a bundle contributes the addresses of all nested
// elements. Depth-guarded against maliciously deep/circular bundles.
export function ParseOscAddresses(Msg: Buffer, Depth = 0): string[] {
  if (!Buffer.isBuffer(Msg) || Msg.length < 4 || Depth > 8) return [];
  const First = ReadOscString(Msg, 0);
  if (!First) return [];

  if (First.Value === BUNDLE_TAG) {
    // #bundle + 8-byte OSC time tag, then repeated [int32 size][element bytes].
    const Addresses: string[] = [];
    let Pos = First.Next + 8; // skip the time tag
    while (Pos + 4 <= Msg.length) {
      const Size = Msg.readUInt32BE(Pos);
      Pos += 4;
      if (Size <= 0 || Pos + Size > Msg.length) break;
      const Element = Msg.subarray(Pos, Pos + Size);
      for (const Addr of ParseOscAddresses(Element, Depth + 1)) Addresses.push(Addr);
      Pos += Size;
    }
    return Addresses;
  }

  // Plain message: the address is the only thing we need.
  if (First.Value.startsWith('/')) return [First.Value];
  return [];
}

export interface MilluminMessage {
  OscAddress: string;
  ReceivedAt: number;
}

export interface MilluminSource {
  Address: string; // normalized source IP
  LastSeenAt: number;
  LastOscAddress: string;
  Count: number;
  Recent: MilluminMessage[]; // newest last
}

export interface MilluminSnapshot {
  Ready: boolean;
  Error: string | null;
  Sources: MilluminSource[];
}

interface PortListener {
  Port: number;
  Socket: dgram.Socket | null;
  State: 'idle' | 'binding' | 'ready' | 'failed';
  LastError: string | null;
  LastFailAt: number;
  LastInterestAt: number;
  Sources: Map<string, MilluminSource>;
}

// The process-wide singleton receiver. One UDP socket per distinct listen port.
class MilluminReceiverImpl {
  private Ports = new Map<number, PortListener>();
  private SweepTimer: NodeJS.Timeout | null = null;

  // Register interest in a listen port: start the socket if needed.
  Observe(Port: number): void {
    if (!Number.isInteger(Port) || Port < MIN_PORT || Port > MAX_PORT) return;
    let Listener = this.Ports.get(Port);
    if (!Listener) {
      Listener = {
        Port,
        Socket: null,
        State: 'idle',
        LastError: null,
        LastFailAt: 0,
        LastInterestAt: Date.now(),
        Sources: new Map(),
      };
      this.Ports.set(Port, Listener);
    }
    Listener.LastInterestAt = Date.now();
    this.EnsureBound(Listener);
    this.EnsureSweep();
  }

  // Read the current cache for a port. Does not start the socket.
  Snapshot(Port: number): MilluminSnapshot {
    const Listener = this.Ports.get(Port);
    if (!Listener) return { Ready: false, Error: null, Sources: [] };
    return {
      Ready: Listener.State === 'ready',
      Error: Listener.State === 'failed' ? Listener.LastError : null,
      Sources: Array.from(Listener.Sources.values()),
    };
  }

  private EnsureBound(Listener: PortListener): void {
    if (Listener.State === 'ready' || Listener.State === 'binding') return;
    if (Listener.State === 'failed' && Date.now() - Listener.LastFailAt < RETRY_COOLDOWN_MS) return;

    Listener.State = 'binding';
    Listener.LastError = null;

    let Sock: dgram.Socket;
    try {
      Sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (Err) {
      this.Fail(Listener, Err);
      return;
    }
    Listener.Socket = Sock;

    Sock.on('error', (Err: Error) => {
      if (Listener.Socket === Sock) this.Fail(Listener, Err);
      try {
        Sock.close();
      } catch {
        // already closing
      }
    });
    Sock.on('message', (Msg: Buffer, RInfo: dgram.RemoteInfo) =>
      this.HandleMessage(Listener, Msg, RInfo)
    );
    Sock.on('listening', () => {
      if (Listener.Socket !== Sock) return;
      Listener.State = 'ready';
      Logger.log(`Millumin OSC receiver listening on udp/${Listener.Port}`);
    });

    try {
      Sock.bind(Listener.Port);
      // Don't keep the event loop (or a test process) alive on our account.
      Sock.unref();
    } catch (Err) {
      this.Fail(Listener, Err);
      try {
        Sock.close();
      } catch {
        // ignore
      }
    }
  }

  private Fail(Listener: PortListener, Err: unknown): void {
    Listener.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    Listener.LastFailAt = Date.now();
    Listener.State = 'failed';
    Listener.Socket = null;
    Logger.warn(`Millumin OSC receiver on udp/${Listener.Port} unavailable: ${Listener.LastError}`);
  }

  private HandleMessage(Listener: PortListener, Msg: Buffer, RInfo: dgram.RemoteInfo): void {
    const Addresses = ParseOscAddresses(Msg);
    if (!Addresses.length) return;
    const Source = NormalizeAddress(RInfo && RInfo.address ? RInfo.address : '');
    if (!Source) return;
    const Now = Date.now();

    let Entry = Listener.Sources.get(Source);
    if (!Entry) {
      Entry = { Address: Source, LastSeenAt: Now, LastOscAddress: '', Count: 0, Recent: [] };
      Listener.Sources.set(Source, Entry);
    }
    for (const Addr of Addresses) {
      Entry.LastOscAddress = Addr;
      Entry.LastSeenAt = Now;
      Entry.Count += 1;
      Entry.Recent.push({ OscAddress: Addr, ReceivedAt: Now });
      if (Entry.Recent.length > MAX_RECENT_MESSAGES) {
        Entry.Recent.splice(0, Entry.Recent.length - MAX_RECENT_MESSAGES);
      }
    }
  }

  private EnsureSweep(): void {
    if (this.SweepTimer) return;
    this.SweepTimer = setInterval(() => this.Sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
  }

  private Sweep(): void {
    const Now = Date.now();
    for (const [Port, Listener] of this.Ports) {
      if (Now - Listener.LastInterestAt > INTEREST_TTL_MS) {
        if (Listener.Socket) {
          try {
            Listener.Socket.close();
          } catch {
            // ignore
          }
        }
        this.Ports.delete(Port);
        continue;
      }
      for (const [Addr, Src] of Listener.Sources) {
        if (Now - Src.LastSeenAt > SOURCE_RETENTION_MS) Listener.Sources.delete(Addr);
      }
    }
  }

  // Test-only teardown so a suite can bind/unbind deterministically.
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

export const MilluminReceiver = new MilluminReceiverImpl();

// --- Settings / Run / Debug -------------------------------------------------

export function BuildMilluminSettings(): MonitoringSettingField[] {
  return [
    {
      Key: 'ListenPort',
      Label: 'Listen port (Millumin OSC output destination)',
      Type: 'number',
      Default: DEFAULT_LISTEN_PORT,
      Min: MIN_PORT,
      Max: MAX_PORT,
    },
    {
      Key: 'AddressFilter',
      Label: 'OSC address prefix (optional, e.g. /millumin)',
      Type: 'string',
      Default: '',
    },
    {
      Key: 'GracePeriodMs',
      Label: 'Grace period (ms)',
      Type: 'number',
      Default: DEFAULT_GRACE_PERIOD_MS,
      Min: 500,
      Max: 120000,
      Advanced: true,
    },
  ];
}

export interface EvaluateParams {
  Snapshot: MilluminSnapshot;
  Address: string;
  ListenPort: number;
  AddressFilter: string;
  GracePeriodMs: number;
  Now: number;
}

// Most-recent OSC message from a source that is both fresh and passes the filter.
function NewestMatching(Src: MilluminSource, Filter: string, GraceMs: number, Now: number): MilluminMessage | null {
  let Best: MilluminMessage | null = null;
  for (const M of Src.Recent) {
    if (Now - M.ReceivedAt > GraceMs) continue;
    if (!MatchesFilter(M.OscAddress, Filter)) continue;
    if (!Best || M.ReceivedAt > Best.ReceivedAt) Best = M;
  }
  return Best;
}

// Pure decision logic, separated from the receiver so it can be unit-tested with
// a hand-built snapshot.
export function EvaluateMillumin(P: EvaluateParams): MonitoringResult {
  const Base = {
    Address: P.Address,
    ListenPort: P.ListenPort,
    AddressFilter: P.AddressFilter,
  };

  if (P.Snapshot.Error) {
    return { Success: false, Error: `Millumin OSC listener error: ${P.Snapshot.Error}`, ...Base, Sources: [] };
  }

  // Snapshot of fresh, filter-matching activity per source for Debug().
  const FreshSources = P.Snapshot.Sources.map((S) => ({ Source: S, Newest: NewestMatching(S, P.AddressFilter, P.GracePeriodMs, P.Now) }))
    .filter((X) => X.Newest !== null)
    .sort((A, B) => (B.Newest as MilluminMessage).ReceivedAt - (A.Newest as MilluminMessage).ReceivedAt);
  const WithSources = { ...Base, Sources: P.Snapshot.Sources };

  const FromTarget = FreshSources.find((X) => AddressesEqual(X.Source.Address, P.Address));
  if (FromTarget && FromTarget.Newest) {
    return {
      Success: true,
      LatencyMs: P.Now - FromTarget.Newest.ReceivedAt,
      Matched: true,
      LastOscAddress: FromTarget.Newest.OscAddress,
      ...WithSources,
    };
  }

  if (FreshSources.length) {
    // Millumin OSC is arriving, but not from the configured machine — the target
    // is not confirmed present, so this is Offline (the aggregator only honours
    // Degraded on a Success:true result). The other source is surfaced as a hint.
    const Other = FreshSources[0]!; // non-empty: length checked above
    return {
      Success: false,
      Error: `Millumin OSC arriving from ${Other.Source.Address}, not ${P.Address}`,
      Matched: false,
      ...WithSources,
    };
  }

  const FilterNote = P.AddressFilter ? ` matching "${P.AddressFilter}"` : '';
  return {
    Success: false,
    Error: P.Snapshot.Ready
      ? `No Millumin OSC${FilterNote} from ${P.Address} in ${P.GracePeriodMs}ms`
      : 'Millumin OSC listener starting…',
    Matched: false,
    ...WithSources,
  };
}

export function RunMillumin(Target: MonitoringTargetLike): MonitoringResult {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const ListenPort = Number.isFinite(Cfg.ListenPort) ? (Cfg.ListenPort as number) | 0 : DEFAULT_LISTEN_PORT;
  if (ListenPort < MIN_PORT || ListenPort > MAX_PORT) {
    return { Success: false, Error: `Invalid listen port: ${ListenPort}` };
  }
  const AddressFilter = Cfg.AddressFilter == null ? '' : String(Cfg.AddressFilter).trim();
  const GracePeriodMs = Number.isFinite(Cfg.GracePeriodMs)
    ? Math.max(500, (Cfg.GracePeriodMs as number) | 0)
    : DEFAULT_GRACE_PERIOD_MS;

  MilluminReceiver.Observe(ListenPort);
  const Snapshot = MilluminReceiver.Snapshot(ListenPort);

  return EvaluateMillumin({
    Snapshot,
    Address,
    ListenPort,
    AddressFilter,
    GracePeriodMs,
    Now: Date.now(),
  });
}

export function BuildMilluminDebug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const ListenPort =
    Result && Number.isFinite(Result.ListenPort as number)
      ? (Result.ListenPort as number)
      : Number.isFinite(Cfg.ListenPort)
        ? (Cfg.ListenPort as number) | 0
        : DEFAULT_LISTEN_PORT;
  const AddressFilter =
    (Result && typeof Result.AddressFilter === 'string' ? (Result.AddressFilter as string) : null) ??
    (Cfg.AddressFilter == null ? '' : String(Cfg.AddressFilter).trim());

  const Online = !!(Result && Result.Success);
  const StatusPill = Online ? Pill('success', 'Receiving') : Pill('danger', 'Not receiving');

  const Head = Rows([
    TextRow('Approach', 'Passive OSC feedback listener'),
    TextRow('Millumin IP', Address || '—'),
    TextRow('Listen port', `udp/${ListenPort}`),
    AddressFilter ? TextRow('Address filter', AddressFilter) : null,
    Row('Status', StatusPill),
    Online
      ? Row('Last OSC age', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : Result && Result.Error
        ? TextRow('Detail', Result.Error as string)
        : null,
    Online && Result && Result.LastOscAddress
      ? TextRow('Last OSC address', Result.LastOscAddress as string)
      : null,
  ]);

  const ConfigNote =
    '<div class="mt-2">' +
    Note(
      'Requires Millumin: Device manager (CMD+K) -> OSC tab -> enable "API feedback" ' +
        `and add ShowTrak's IP + udp/${ListenPort} as an OSC output destination.`
    ) +
    '</div>';

  const Sources: MilluminSource[] = Array.isArray(Result && Result.Sources)
    ? (Result.Sources as MilluminSource[])
    : [];
  if (!Sources.length) {
    return Head + '<div class="mt-2">' + Note('No OSC activity observed on this port') + '</div>' + ConfigNote;
  }

  const List = Sources.map((S) => {
    const IsTarget = AddressesEqual(S.Address, Address);
    const RowCls = IsTarget ? 'border border-success' : 'border border-transparent';
    const Recent = Array.isArray(S.Recent) ? S.Recent : [];
    const Latest = Recent.slice(-4).reverse();
    const Msgs = Latest.map(
      (M) => `<div class="text-muted small font-monospace text-break">${Esc(M.OscAddress)}</div>`
    ).join('');
    return (
      `<div class="bg-ghost rounded p-2 ${RowCls}">` +
      '<div class="d-flex justify-content-between align-items-center gap-2">' +
      `<span class="text-light small font-monospace text-break">${Esc(S.Address)}</span>` +
      Pill('muted', `${S.Count} msg`) +
      '</div>' +
      Msgs +
      '</div>'
    );
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Sources seen on udp/${ListenPort} (${Sources.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>` +
    ConfigNote
  );
}

// Exported for unit tests.
export const _internal = {
  NormalizeAddress,
  AddressesEqual,
  MatchesFilter,
  ParseOscAddresses,
  EvaluateMillumin,
  RunMillumin,
  MilluminReceiver,
};
