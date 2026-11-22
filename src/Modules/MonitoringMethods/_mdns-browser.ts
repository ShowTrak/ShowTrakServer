// Shared plumbing for the passive mDNS presence methods (NDI sources, Dante
// devices). Neither has anything to actively probe: every source or device
// advertises itself on mDNS, so instead of opening a socket per check the
// method runs ONE process-wide browser (built on the existing `bonjour-service`
// dependency) and each check's Run() reads its cache.
//
// MdnsPresenceBrowser owns the parts that are the same for every such method:
//
//   - one bonjour instance browsing one or more service types;
//   - a periodic re-query so responders re-announce, and a periodic sweep so
//     the owner can forget entries unheard-from within a retention window;
//   - a tap on the raw `multicast-dns` response stream (see below);
//   - failure handling: a browse that cannot start is retried after a cooldown.
//
// The cache itself, and what identifies an entry in it, stays with the method:
// NDI keys a source by its instance fqdn, Dante merges a device seen on several
// service types into one record keyed by its name. The browser reports what it
// hears through the hooks and the method decides what that means.
//
// Freshness note: bonjour's Browser emits `up` for an instance EXACTLY ONCE (the
// first time it is discovered) and `down` only on an explicit goodbye;
// re-announcements from our periodic re-query are deduped internally and never
// re-emitted. Relying on `up` alone therefore freezes each entry's timestamp at
// discovery time, so the grace window would expire seconds after boot and never
// recover. We therefore also tap the raw `multicast-dns` `response` stream
// underneath bonjour and report every instance that re-announces (Announced),
// so the owner can bump (or re-create) its timestamp. bonjour still owns
// add/remove bookkeeping (`up`/`down`); the tap only keeps timestamps honest.
//
// The browser is fully lazy (nothing starts until the first Observe()), so
// importing a method that holds one (e.g. from the method registry) has NO side
// effects.
import { CreateBonjourErrorHandler } from '@showtrak/protocol/runtime';
import type { CreateLogger } from '../Logger';

type Logger = ReturnType<typeof CreateLogger>;

export interface MdnsServiceType {
  Type: string;
  Protocol: string;
}

// "_ndi._tcp"
export function ServiceString(S: MdnsServiceType): string {
  return `_${S.Type}._${S.Protocol}`;
}

// "_ndi._tcp.local": the PTR record name, and the suffix of every instance's
// SRV record name, as they appear on the wire.
export function ServiceFqdn(S: MdnsServiceType): string {
  return `${ServiceString(S)}.local`;
}

// --- Matching and settings shared by the presence methods ----------------------

// How a method matches the configured target against a visible name.
export type MdnsMatchMode = 'exact' | 'contains';
export const DEFAULT_MATCH_MODE: MdnsMatchMode = 'contains';

export function NormalizeMatchMode(Value: unknown): MdnsMatchMode {
  return String(Value) === 'exact' ? 'exact' : 'contains';
}

// Normalize a name for case-insensitive comparison.
export function NormalizeName(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase();
}

// Does a visible name satisfy the configured target under the given mode?
// Comparison is case-insensitive. An empty target never matches.
export function MatchesName(CandidateName: unknown, Target: unknown, Mode: MdnsMatchMode): boolean {
  const C = NormalizeName(CandidateName);
  const T = NormalizeName(Target);
  if (!T) return false;
  return Mode === 'exact' ? C === T : C.includes(T);
}

// Default freshness window: how recently an entry must have been announced to
// count as "currently present". mDNS records carry generous TTLs and we re-query
// well within this, so a few seconds tolerates a missed re-announcement.
export const DEFAULT_GRACE_PERIOD_MS = 8000;
export const MIN_GRACE_PERIOD_MS = 1000;
export const MAX_GRACE_PERIOD_MS = 120000;

// The configured grace period, clamped to the supported range.
export function GracePeriodFrom(Value: unknown): number {
  return Number.isFinite(Value)
    ? Math.min(MAX_GRACE_PERIOD_MS, Math.max(MIN_GRACE_PERIOD_MS, (Value as number) | 0))
    : DEFAULT_GRACE_PERIOD_MS;
}

const QUERY_INTERVAL_MS = 5000; // re-query the network so timestamps stay fresh
// Forget an entry unheard-from this long; the owner applies it in Sweep.
export const RETENTION_MS = 60000;
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

// One service instance as bonjour reported it. Name and Fqdn are trimmed and
// may be empty (e.g. a goodbye carrying only one of them).
export interface MdnsInstance {
  Name: string;
  Fqdn: string;
  Txt: Record<string, unknown> | null | undefined;
}

function InstanceOf(Service: BonjourService): MdnsInstance {
  return {
    Name: Service && Service.name ? String(Service.name).trim() : '',
    Fqdn: Service && Service.fqdn ? String(Service.fqdn).trim() : '',
    Txt: Service && Service.txt,
  };
}

export interface MdnsPresenceHooks {
  // An instance appeared on one service type (bonjour fires this once).
  Up(Instance: MdnsInstance, Service: MdnsServiceType): void;
  // An instance said goodbye on one service type.
  Down(Instance: MdnsInstance, Service: MdnsServiceType): void;
  // The instance fqdns that re-announced in one mDNS response, goodbyes
  // excluded. Runs after bonjour's own `up` handler on the same packet, so a
  // freshly-discovered instance is already cached by then; an instance the
  // sweep dropped (bonjour won't re-emit `up` for it) arrives only here.
  Announced(Fqdns: ReadonlySet<string>, Now: number): void;
  // Periodic: forget entries unheard-from for longer than RETENTION_MS.
  Sweep(Now: number): void;
}

export interface MdnsPresenceOptions {
  // Prefixes the log lines ("NDI browser started ...").
  Label: string;
  Logger: Logger;
  Services: readonly MdnsServiceType[];
  Hooks: MdnsPresenceHooks;
}

export class MdnsPresenceBrowser {
  private readonly Label: string;
  private readonly Logger: Logger;
  private readonly Services: readonly MdnsServiceType[];
  private readonly Hooks: MdnsPresenceHooks;
  private readonly OnBonjourError: (Err: unknown) => void;
  private Instance: BonjourInstance | null = null;
  private Browsers: BonjourBrowser[] = [];
  private Mdns: MdnsLike | null = null;
  private ResponseHandler: MdnsResponseHandler | null = null;
  private State: 'idle' | 'ready' | 'failed' = 'idle';
  private LastError: string | null = null;
  private LastFailAt = 0;
  private SweepTimer: NodeJS.Timeout | null = null;
  private QueryTimer: NodeJS.Timeout | null = null;

  constructor(Options: MdnsPresenceOptions) {
    this.Label = Options.Label;
    this.Logger = Options.Logger;
    this.Services = Options.Services;
    this.Hooks = Options.Hooks;
    this.OnBonjourError = CreateBonjourErrorHandler(Options.Logger);
  }

  // Browsing and answering checks.
  get Ready(): boolean {
    return this.State === 'ready';
  }

  // Why browsing could not start, while it is waiting to retry; null otherwise.
  get Error(): string | null {
    return this.State === 'failed' ? this.LastError : null;
  }

  // Start browsing if we aren't already. Cheap to call on every Run().
  Observe(): void {
    if (this.State === 'ready') return;
    if (this.State === 'failed' && Date.now() - this.LastFailAt < RETRY_COOLDOWN_MS) return;

    let Instance: BonjourInstance;
    const Browsers: BonjourBrowser[] = [];
    try {
      Instance = new Bonjour({ reuseAddr: true, loopback: true }, this.OnBonjourError);
      for (const S of this.Services) {
        Browsers.push(Instance.find({ type: S.Type, protocol: S.Protocol }));
      }
    } catch (Err) {
      this.Fail(Err);
      return;
    }

    this.Instance = Instance;
    this.Browsers = Browsers;
    this.LastError = null;
    this.State = 'ready';

    Browsers.forEach((Browser, Index) => {
      const Service = this.Services[Index]!;
      Browser.on('up', (Svc: BonjourService) => this.Hooks.Up(InstanceOf(Svc), Service));
      Browser.on('down', (Svc: BonjourService) => this.Hooks.Down(InstanceOf(Svc), Service));
      Browser.on('error', (Err: Error) => {
        const Where = this.Services.length > 1 ? ` (${ServiceString(Service)})` : '';
        this.Logger.warn(
          `${this.Label} browser error${Where}: ${Err && Err.message ? Err.message : Err}`
        );
      });
    });

    // Tap the raw multicast-dns response stream so re-announcements refresh each
    // entry's timestamp (bonjour's `up` fires only once; see the file header).
    const Mdns = ExtractMdns(Instance);
    if (Mdns) {
      const Handler: MdnsResponseHandler = (Packet) => this.HandleResponse(Packet);
      Mdns.on('response', Handler);
      this.Mdns = Mdns;
      this.ResponseHandler = Handler;
    } else {
      this.Logger.warn(
        `${this.Label}: could not tap multicast-dns responses; presence may go stale between re-announcements`
      );
    }

    for (const Browser of Browsers) {
      try {
        Browser.start();
      } catch {
        // Some bonjour builds auto-start on find(); a redundant start() is harmless.
      }
    }
    // Kick an initial re-query shortly after start so we don't wait a full
    // interval for the first announcements.
    setTimeout(() => this.Requery(), 100);

    this.EnsureTimers();
    this.Logger.log(
      `${this.Label} browser started (${this.Services.map((S) => ServiceString(S)).join(', ')})`
    );
  }

  private Requery(): void {
    if (this.State !== 'ready') return;
    for (const Browser of this.Browsers) {
      try {
        Browser.update();
      } catch {
        // Best-effort re-query; the periodic timer will try again.
      }
    }
  }

  // Report every instance of our service types that just re-announced.
  private HandleResponse(Packet: MdnsResponsePacket): void {
    if (!Packet) return;
    const Records = [
      ...(Array.isArray(Packet.answers) ? Packet.answers : []),
      ...(Array.isArray(Packet.additionals) ? Packet.additionals : []),
    ];

    const Fqdns = new Set<string>();
    for (const RR of Records) {
      if (!RR || RR.ttl === 0) continue; // ttl 0 is a goodbye; bonjour's `down` handles it
      for (const S of this.Services) {
        const Fqdn = ServiceFqdn(S);
        const SrvSuffix = `.${Fqdn}`;
        let Heard = '';
        if (RR.type === 'PTR' && RR.name === Fqdn && typeof RR.data === 'string') {
          Heard = RR.data.trim();
        } else if (
          RR.type === 'SRV' &&
          typeof RR.name === 'string' &&
          RR.name.toLowerCase().endsWith(SrvSuffix.toLowerCase())
        ) {
          Heard = RR.name.trim();
        }
        if (Heard) Fqdns.add(Heard);
      }
    }
    if (Fqdns.size) this.Hooks.Announced(Fqdns, Date.now());
  }

  private Fail(Err: unknown): void {
    this.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    this.LastFailAt = Date.now();
    this.State = 'failed';
    this.TeardownInstance();
    this.Logger.warn(`${this.Label} browser unavailable: ${this.LastError}`);
  }

  private EnsureTimers(): void {
    if (!this.SweepTimer) {
      this.SweepTimer = setInterval(() => this.Hooks.Sweep(Date.now()), SWEEP_INTERVAL_MS);
      if (typeof this.SweepTimer.unref === 'function') this.SweepTimer.unref();
    }
    if (!this.QueryTimer) {
      this.QueryTimer = setInterval(() => this.Requery(), QUERY_INTERVAL_MS);
      if (typeof this.QueryTimer.unref === 'function') this.QueryTimer.unref();
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
    for (const Browser of this.Browsers) {
      try {
        Browser.stop();
      } catch {
        // ignore
      }
    }
    this.Browsers = [];
    if (this.Instance) {
      try {
        this.Instance.destroy();
      } catch {
        // ignore
      }
      this.Instance = null;
    }
  }

  // Test-only teardown so a suite can start/stop deterministically. The owner
  // clears its own cache.
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
  }
}
