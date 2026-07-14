// Shared plumbing for the NDI (NewTek / Network Device Interface) source-presence
// monitoring method.
//
// Like sACN, NDI discovery is *passive*: every running NDI source advertises
// itself on mDNS as a service instance of type `_ndi._tcp`, and there is nothing
// to actively probe — you simply listen for the announcements. Each source shows
// up as one service instance whose name looks like "MACHINE-NAME (Source Name)".
//
// So instead of opening a socket per check we run ONE process-wide mDNS browser
// (built on the existing `bonjour-service` dependency) that:
//
//   - Browses `_ndi._tcp` once for the whole process.
//   - Caches the set of currently-seen source (service instance) names, each with
//     a last-seen timestamp, refreshed every time the service re-announces.
//   - Periodically re-queries so responders re-announce and timestamps stay fresh,
//     and sweeps entries not heard from within a retention window.
//
// Freshness note: bonjour's Browser emits `up` for a source EXACTLY ONCE (the
// first time it is discovered) and `down` only on an explicit goodbye packet —
// re-announcements from our periodic re-query are deduped internally and never
// re-emitted. Relying on `up` alone therefore freezes each source's timestamp at
// its discovery time, so the grace window would expire ~8s after boot and never
// recover. To get real per-announcement freshness we additionally tap the raw
// `multicast-dns` `response` stream underneath bonjour and bump (or re-create)
// each source's timestamp whenever it re-announces. bonjour still owns add/remove
// bookkeeping (`up`/`down`); the tap only keeps timestamps honest.
//
// A check's Run() merely reads that cache and asks "was a source matching my
// target seen within the grace window?". The browser is fully lazy — nothing
// starts until the first Observe() — so importing this module (e.g. from the
// method registry) has NO side effects.
import { CreateLogger } from '../Logger';
import { CreateBonjourErrorHandler } from '../NetworkErrors';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const Logger = CreateLogger('NDI');

// The mDNS service the NDI SDK advertises every source on.
export const NDI_SERVICE_TYPE = 'ndi';
export const NDI_SERVICE_PROTOCOL = 'tcp';
export const NDI_SERVICE_STRING = `_${NDI_SERVICE_TYPE}._${NDI_SERVICE_PROTOCOL}`;
// Fully-qualified service name as it appears on the wire (PTR record name / the
// suffix of every source's SRV record name).
export const NDI_SERVICE_FQDN = `${NDI_SERVICE_STRING}.local`;

// How this method matches the configured target against a visible source name.
export type NdiMatchMode = 'exact' | 'contains';
export const DEFAULT_MATCH_MODE: NdiMatchMode = 'contains';

// Default freshness window: how recently a source must have been announced to
// count as "currently present". mDNS records carry generous TTLs and we re-query
// well within this, so a few seconds tolerates a missed re-announcement.
export const DEFAULT_GRACE_PERIOD_MS = 8000;
export const MIN_GRACE_PERIOD_MS = 1000;
export const MAX_GRACE_PERIOD_MS = 120000;

// How responsive the checks feel. Presence changes on the order of seconds.
export const DEFAULT_NDI_INTERVAL_MS = 10000;

const QUERY_INTERVAL_MS = 5000; // re-query the network so timestamps stay fresh
const RETENTION_MS = 60000; // forget a source unheard-from this long
const SWEEP_INTERVAL_MS = 30000;
const RETRY_COOLDOWN_MS = 15000; // after a browse failure, wait before retrying

// --- bonjour structural typing (no @types published for the classic package) --
interface BonjourService {
  name?: string;
  fqdn?: string;
  type?: string;
  protocol?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown> | null;
}

interface BonjourBrowser {
  on(event: 'up', listener: (service: BonjourService) => void): void;
  on(event: 'down', listener: (service: BonjourService) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  start(): void;
  update(): void;
  stop(): void;
}

interface BonjourInstance {
  find(options: Record<string, unknown>): BonjourBrowser;
  destroy(): void;
}

// --- multicast-dns structural typing (the transport under bonjour) -----------
// We tap this directly for per-announcement freshness; see the freshness note in
// the file header.
interface MdnsResourceRecord {
  type?: string;
  name?: string;
  data?: unknown;
  ttl?: number;
}

interface MdnsResponsePacket {
  answers?: MdnsResourceRecord[];
  additionals?: MdnsResourceRecord[];
}

type MdnsResponseHandler = (packet: MdnsResponsePacket) => void;

interface MdnsLike {
  on(event: 'response', listener: MdnsResponseHandler): void;
  removeListener(event: 'response', listener: MdnsResponseHandler): void;
}

// Recover the raw multicast-dns emitter bonjour builds its Browser on. `server`
// is a private field of bonjour-service's Bonjour class holding the mDNS server;
// we degrade gracefully to null if a future version reshapes it.
function ExtractMdns(Instance: BonjourInstance): MdnsLike | null {
  const Server = (Instance as unknown as { server?: { mdns?: unknown } }).server;
  const Mdns = Server && Server.mdns;
  if (Mdns && typeof (Mdns as MdnsLike).on === 'function') return Mdns as MdnsLike;
  return null;
}

// Derive the display name for a source from its fully-qualified instance name by
// stripping the `._ndi._tcp.local` suffix. Matches the name bonjour surfaces via
// `up` for the typical (dotless) NDI instance name.
function DeriveNameFromFqdn(Fqdn: string): string {
  const Suffix = `.${NDI_SERVICE_FQDN}`;
  let N = String(Fqdn).replace(/\.$/, '');
  if (N.toLowerCase().endsWith(Suffix.toLowerCase())) N = N.slice(0, -Suffix.length);
  return N.trim();
}

type BonjourFactory = (options?: Record<string, unknown>) => BonjourInstance;

// bonjour-service exports a class whose optional second constructor argument is
// an mDNS `errorCallback`. Its default (`function (err) { throw err }`) turns a
// routine interface drop (send → EADDRNOTAVAIL) into an uncaught exception, so we
// always pass a logging handler instead.
const { Bonjour } = require('bonjour-service') as {
  Bonjour: new (
    options?: Record<string, unknown>,
    errorCallback?: (err: unknown) => void
  ) => BonjourInstance;
};
const OnBonjourError = CreateBonjourErrorHandler(Logger);
const bonjour: BonjourFactory = (options) => new Bonjour(options, OnBonjourError);

export interface NdiSource {
  Name: string;
  LastSeenAt: number;
}

export interface NdiSnapshot {
  Ready: boolean;
  Error: string | null;
  Sources: NdiSource[];
}

// Normalize a name for case-insensitive comparison.
export function NormalizeName(Value: unknown): string {
  return String(Value == null ? '' : Value).trim().toLowerCase();
}

// Does a visible source name satisfy the configured target under the given mode?
// Comparison is case-insensitive. An empty target never matches.
export function MatchesSource(CandidateName: unknown, Target: unknown, Mode: NdiMatchMode): boolean {
  const C = NormalizeName(CandidateName);
  const T = NormalizeName(Target);
  if (!T) return false;
  return Mode === 'exact' ? C === T : C.includes(T);
}

// The process-wide singleton browser.
class NdiBrowserImpl {
  // Keyed by each source's fully-qualified instance name (fqdn) so the `up`/`down`
  // bonjour events and the raw response tap agree on identity. Falls back to the
  // display name as a key when no fqdn is available (e.g. under test stubs).
  private Sources = new Map<string, NdiSource>();
  private Instance: BonjourInstance | null = null;
  private Browser: BonjourBrowser | null = null;
  private Mdns: MdnsLike | null = null;
  private ResponseHandler: MdnsResponseHandler | null = null;
  private State: 'idle' | 'ready' | 'failed' = 'idle';
  private LastError: string | null = null;
  private LastFailAt = 0;
  private SweepTimer: NodeJS.Timeout | null = null;
  private QueryTimer: NodeJS.Timeout | null = null;

  // Start browsing if we aren't already. Cheap to call on every Run().
  Observe(): void {
    this.EnsureStarted();
  }

  // Read the current cache. Does not start the browser — callers Observe() first.
  Snapshot(): NdiSnapshot {
    return {
      Ready: this.State === 'ready',
      Error: this.State === 'failed' ? this.LastError : null,
      Sources: Array.from(this.Sources.values()),
    };
  }

  private EnsureStarted(): void {
    if (this.State === 'ready') return;
    if (this.State === 'failed' && Date.now() - this.LastFailAt < RETRY_COOLDOWN_MS) return;

    let Instance: BonjourInstance;
    let Browser: BonjourBrowser;
    try {
      Instance = bonjour({ reuseAddr: true, loopback: true });
      Browser = Instance.find({ type: NDI_SERVICE_TYPE, protocol: NDI_SERVICE_PROTOCOL });
    } catch (Err) {
      this.Fail(Err);
      return;
    }

    this.Instance = Instance;
    this.Browser = Browser;
    this.LastError = null;
    this.State = 'ready';

    Browser.on('up', (Service: BonjourService) => {
      const Name = Service && Service.name ? String(Service.name).trim() : '';
      const Fqdn = Service && Service.fqdn ? String(Service.fqdn).trim() : '';
      const Key = Fqdn || Name;
      if (!Key) return;
      this.Sources.set(Key, { Name: Name || DeriveNameFromFqdn(Fqdn), LastSeenAt: Date.now() });
    });
    Browser.on('down', (Service: BonjourService) => {
      const Name = Service && Service.name ? String(Service.name).trim() : '';
      const Fqdn = Service && Service.fqdn ? String(Service.fqdn).trim() : '';
      const Key = Fqdn || Name;
      if (Key) this.Sources.delete(Key);
    });
    Browser.on('error', (Err: Error) => {
      Logger.warn(`NDI browser error: ${Err && Err.message ? Err.message : Err}`);
    });

    // Tap the raw multicast-dns response stream so re-announcements refresh each
    // source's timestamp (bonjour's `up` fires only once — see the file header).
    const Mdns = ExtractMdns(Instance);
    if (Mdns) {
      const Handler: MdnsResponseHandler = (Packet) => this.HandleResponse(Packet);
      Mdns.on('response', Handler);
      this.Mdns = Mdns;
      this.ResponseHandler = Handler;
    } else {
      Logger.warn('NDI: could not tap multicast-dns responses; presence may go stale between re-announcements');
    }

    try {
      Browser.start();
    } catch {
      // Some bonjour builds auto-start on find(); a redundant start() is harmless.
    }
    // Kick an initial re-query shortly after start so we don't wait a full
    // interval for the first announcements.
    setTimeout(() => this.Requery(), 100);

    this.EnsureTimers();
    Logger.log(`NDI browser started (${NDI_SERVICE_STRING})`);
  }

  private Requery(): void {
    if (!this.Browser || this.State !== 'ready') return;
    try {
      this.Browser.update();
    } catch {
      // Best-effort re-query; the periodic timer will try again.
    }
  }

  // Bump (or re-create) the last-seen timestamp for every NDI source that just
  // re-announced. Runs after bonjour's own `up` handler on the same packet, so a
  // freshly-discovered source is already in the cache by the time we refresh it;
  // if a source had been swept out (bonjour won't re-emit `up` for it), we
  // re-create the entry here so it can recover.
  private HandleResponse(Packet: MdnsResponsePacket): void {
    if (!Packet) return;
    const Records = [
      ...(Array.isArray(Packet.answers) ? Packet.answers : []),
      ...(Array.isArray(Packet.additionals) ? Packet.additionals : []),
    ];
    const SrvSuffix = `.${NDI_SERVICE_FQDN}`;
    const Fqdns = new Set<string>();
    for (const RR of Records) {
      if (!RR || RR.ttl === 0) continue; // ttl 0 is a goodbye; bonjour's `down` handles it
      if (RR.type === 'PTR' && RR.name === NDI_SERVICE_FQDN && typeof RR.data === 'string') {
        Fqdns.add(RR.data.trim());
      } else if (
        RR.type === 'SRV' &&
        typeof RR.name === 'string' &&
        RR.name.toLowerCase().endsWith(SrvSuffix.toLowerCase())
      ) {
        Fqdns.add(RR.name.trim());
      }
    }
    if (!Fqdns.size) return;

    const Now = Date.now();
    for (const Fqdn of Fqdns) {
      if (!Fqdn) continue;
      const Existing = this.Sources.get(Fqdn);
      if (Existing) Existing.LastSeenAt = Now;
      else this.Sources.set(Fqdn, { Name: DeriveNameFromFqdn(Fqdn), LastSeenAt: Now });
    }
  }

  private Fail(Err: unknown): void {
    this.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    this.LastFailAt = Date.now();
    this.State = 'failed';
    this.TeardownInstance();
    Logger.warn(`NDI browser unavailable: ${this.LastError}`);
  }

  private EnsureTimers(): void {
    if (!this.SweepTimer) {
      this.SweepTimer = setInterval(() => this.Sweep(), SWEEP_INTERVAL_MS);
      if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
    }
    if (!this.QueryTimer) {
      this.QueryTimer = setInterval(() => this.Requery(), QUERY_INTERVAL_MS);
      if (typeof this.QueryTimer.unref === 'function') this.QueryTimer.unref();
    }
  }

  private Sweep(): void {
    const Now = Date.now();
    for (const [Key, Src] of this.Sources) {
      if (Now - Src.LastSeenAt > RETENTION_MS) this.Sources.delete(Key);
    }
  }

  private TeardownInstance(): void {
    if (this.Mdns && this.ResponseHandler) {
      try {
        this.Mdns.removeListener('response', this.ResponseHandler);
      } catch {
        // ignore
      }
    }
    this.Mdns = null;
    this.ResponseHandler = null;
    if (this.Browser) {
      try {
        this.Browser.stop();
      } catch {
        // ignore
      }
      this.Browser = null;
    }
    if (this.Instance) {
      try {
        this.Instance.destroy();
      } catch {
        // ignore
      }
      this.Instance = null;
    }
  }

  // Test-only teardown so a suite can start/stop deterministically.
  Stop(): void {
    if (this.SweepTimer) {
      clearInterval(this.SweepTimer);
      this.SweepTimer = null;
    }
    if (this.QueryTimer) {
      clearInterval(this.QueryTimer);
      this.QueryTimer = null;
    }
    this.TeardownInstance();
    this.State = 'idle';
    this.LastError = null;
    this.Sources.clear();
  }

  // Test-only: drop the cache without tearing the browser down, to simulate the
  // retention sweep having removed a source that is still on the network.
  _testClearSources(): void {
    this.Sources.clear();
  }
}

export const NdiBrowser = new NdiBrowserImpl();

// --- Settings / Run / Debug -------------------------------------------------

export const Settings: MonitoringSettingField[] = [
  {
    Key: 'SourceName',
    Label: 'NDI source name',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'MatchMode',
    Label: 'Match mode',
    Type: 'select',
    Default: DEFAULT_MATCH_MODE,
    Options: [
      { value: 'contains', label: 'Contains' },
      { value: 'exact', label: 'Exact' },
    ],
  },
  {
    Key: 'GracePeriodMs',
    Label: 'Grace period (ms)',
    Type: 'number',
    Default: DEFAULT_GRACE_PERIOD_MS,
    Min: MIN_GRACE_PERIOD_MS,
    Max: MAX_GRACE_PERIOD_MS,
    Advanced: true,
  },
];

export function NormalizeMatchMode(Value: unknown): NdiMatchMode {
  return String(Value) === 'exact' ? 'exact' : 'contains';
}

interface EvaluateParams {
  Snapshot: NdiSnapshot;
  SourceName: string;
  MatchMode: NdiMatchMode;
  GracePeriodMs: number;
  Now: number;
}

// Pure decision logic, separated from the browser so it can be unit-tested with a
// hand-built snapshot. NDI presence has no meaningful "degraded" state:
//   Success:true            -> online  (a matching source was seen within grace)
//   Success:false           -> offline (no match, or the browser is unavailable)
export function EvaluateNdi(P: EvaluateParams): MonitoringResult {
  const Base = { SourceName: P.SourceName, MatchMode: P.MatchMode };

  if (P.Snapshot.Error) {
    return { Success: false, Error: `NDI browser error: ${P.Snapshot.Error}`, ...Base, Sources: [] };
  }

  const Fresh = P.Snapshot.Sources.filter((S) => P.Now - S.LastSeenAt <= P.GracePeriodMs).sort(
    (A, B) => B.LastSeenAt - A.LastSeenAt
  );
  const WithSources = { ...Base, Sources: Fresh, VisibleCount: Fresh.length };

  const Matched = Fresh.filter((S) => MatchesSource(S.Name, P.SourceName, P.MatchMode));
  if (Matched.length) {
    const Src = Matched[0];
    return {
      Success: true,
      LatencyMs: P.Now - Src.LastSeenAt,
      Matched: true,
      MatchedName: Src.Name,
      ...WithSources,
    };
  }

  return {
    Success: false,
    Error: P.Snapshot.Ready
      ? `NDI source not found (${Fresh.length} source${Fresh.length === 1 ? '' : 's'} visible)`
      : 'NDI browser starting…',
    Matched: false,
    ...WithSources,
  };
}

export function RunNdi(Target: MonitoringTargetLike): MonitoringResult {
  const Cfg = (Target && Target.Settings) || {};
  const SourceName = Cfg.SourceName != null ? String(Cfg.SourceName).trim() : '';
  if (!SourceName) return { Success: false, Error: 'No NDI source name configured' };

  const MatchMode = NormalizeMatchMode(Cfg.MatchMode);
  const GracePeriodMs = Number.isFinite(Cfg.GracePeriodMs)
    ? Math.min(MAX_GRACE_PERIOD_MS, Math.max(MIN_GRACE_PERIOD_MS, (Cfg.GracePeriodMs as number) | 0))
    : DEFAULT_GRACE_PERIOD_MS;

  NdiBrowser.Observe();
  const Snapshot = NdiBrowser.Snapshot();

  return EvaluateNdi({ Snapshot, SourceName, MatchMode, GracePeriodMs, Now: Date.now() });
}

export function BuildNdiDebug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Cfg = (Target && Target.Settings) || {};
  const SourceName =
    Result && Result.SourceName != null
      ? String(Result.SourceName)
      : Cfg.SourceName != null
        ? String(Cfg.SourceName).trim()
        : '';
  const MatchMode = NormalizeMatchMode(
    Result && Result.MatchMode != null ? Result.MatchMode : Cfg.MatchMode
  );
  const MatchedName = Result && Result.MatchedName != null ? String(Result.MatchedName) : '';

  const Online = !!(Result && Result.Success);
  const StatusPill = Online ? Pill('success', 'Present') : Pill('danger', 'Not found');

  const Head = Rows([
    TextRow('Target source', SourceName || '—'),
    TextRow('Match mode', MatchMode === 'exact' ? 'Exact' : 'Contains'),
    Row('Status', StatusPill),
    Online
      ? Row('Last seen', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)} ago</span>`)
      : Result && Result.Error
        ? TextRow('Detail', Result.Error as string)
        : null,
    // Discovery is network-wide via mDNS, so the check's Address field is unused.
    Row('Address', '<span class="text-muted small">Not used — NDI discovery is network-wide</span>'),
  ]);

  const Sources: NdiSource[] = Array.isArray(Result && Result.Sources)
    ? (Result.Sources as NdiSource[])
    : [];
  if (!Sources.length) {
    return Head + '<div class="mt-2">' + Note('No NDI sources currently visible on the network') + '</div>';
  }

  const List = Sources.map((S) => {
    const IsMatch = MatchedName ? S.Name === MatchedName : MatchesSource(S.Name, SourceName, MatchMode);
    const RowCls = IsMatch ? 'border border-success' : 'border border-transparent';
    return (
      `<div class="bg-ghost rounded p-2 ${RowCls}">` +
      '<div class="d-flex justify-content-between align-items-center gap-2">' +
      `<span class="text-light small text-break">${Esc(S.Name)}</span>` +
      (IsMatch ? Pill('success', 'Match') : '') +
      '</div>' +
      '</div>'
    );
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Visible NDI sources (${Sources.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>`
  );
}

// Exported for unit tests.
export const _internal = {
  NormalizeName,
  MatchesSource,
  NormalizeMatchMode,
  EvaluateNdi,
  NdiBrowser,
  NDI_SERVICE_STRING,
};
