// Shared plumbing for the Dante (Audinate) device-presence monitoring method.
//
// Like NDI, Dante discovery is *passive*: every Dante device advertises itself on
// mDNS, and there is nothing to actively probe — you simply listen. Unlike NDI,
// a device announces itself across SEVERAL service types, each carrying a
// different slice of metadata in its TXT record:
//
//   _netaudio-arc._udp   (port 4440) audio routing control — model, firmware
//                        (router_vers), sample rate, latency_ns, router_info
//   _netaudio-cmc._udp   (port 8800) control & monitoring — id (MAC), process,
//                        server_vers, channels
//
// We browse both and merge them into ONE device record keyed by device name (the
// mDNS instance name, which is the Dante device name and is identical across
// service types). Browsing both also gives presence redundancy: a device that has
// stopped answering on one service type is still seen on the other.
//
// SCOPE: this method reports device *presence* only. Dante subscription health
// (which receive channels are subscribed, and whether those subscriptions have
// failed) is NOT carried in mDNS — it lives in the proprietary ARC protocol on
// UDP 4440. That is deliberately out of scope here.
//
// Freshness note (inherited from the NDI method, same trap): bonjour's Browser
// emits `up` for a service EXACTLY ONCE and `down` only on an explicit goodbye —
// re-announcements from our periodic re-query are deduped internally and never
// re-emitted. Relying on `up` alone freezes each device's timestamp at discovery
// time, so the grace window would expire seconds after boot and never recover. We
// therefore also tap the raw `multicast-dns` `response` stream underneath bonjour
// and bump each device's timestamp whenever it re-announces. bonjour still owns
// add/remove bookkeeping; the tap only keeps timestamps honest.
//
// The browser is fully lazy — nothing starts until the first Observe() — so
// importing this module (e.g. from the method registry) has NO side effects.
import { CreateLogger } from '../Logger';
import { CreateBonjourErrorHandler } from '../NetworkErrors';
import { Pill, Rows, TextRow, Row, Note, FormatLatency, Card } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const Logger = CreateLogger('Dante');

// The mDNS service types Dante devices advertise on. ARC is listed first because
// its TXT record carries the richer metadata (model / firmware / rate / latency).
export interface DanteServiceType {
  Type: string;
  Protocol: string;
}

export const DANTE_SERVICE_TYPES: DanteServiceType[] = [
  { Type: 'netaudio-arc', Protocol: 'udp' },
  { Type: 'netaudio-cmc', Protocol: 'udp' },
];

export function ServiceString(S: DanteServiceType): string {
  return `_${S.Type}._${S.Protocol}`;
}

export function ServiceFqdn(S: DanteServiceType): string {
  return `${ServiceString(S)}.local`;
}

// How this method matches the configured target against a visible device name.
export type DanteMatchMode = 'exact' | 'contains';
export const DEFAULT_MATCH_MODE: DanteMatchMode = 'contains';

// Default freshness window: how recently a device must have been announced to
// count as "currently present". Dante hardware announces on generous TTLs and we
// re-query well within this, so a few seconds tolerates a missed re-announcement.
export const DEFAULT_GRACE_PERIOD_MS = 8000;
export const MIN_GRACE_PERIOD_MS = 1000;
export const MAX_GRACE_PERIOD_MS = 120000;

// How responsive the checks feel. Presence changes on the order of seconds.
export const DEFAULT_DANTE_INTERVAL_MS = 10000;

const QUERY_INTERVAL_MS = 5000; // re-query the network so timestamps stay fresh
const RETENTION_MS = 60000; // forget a device unheard-from this long
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

// Strip the `._netaudio-xxx._udp.local` suffix from a fully-qualified instance
// name to recover the Dante device name. Tries every known service type, so one
// helper serves both browsers and the raw response tap.
export function DeriveNameFromFqdn(Fqdn: string): string {
  const N = String(Fqdn).replace(/\.$/, '').trim();
  for (const S of DANTE_SERVICE_TYPES) {
    const Suffix = `.${ServiceFqdn(S)}`;
    if (N.toLowerCase().endsWith(Suffix.toLowerCase())) return N.slice(0, -Suffix.length).trim();
  }
  return N;
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

// The metadata we lift out of the merged TXT records. Every field is optional —
// TXT content varies by manufacturer and firmware, and a device that answers on
// only one service type will carry only that service's keys.
export interface DanteDeviceInfo {
  Model?: string;
  Firmware?: string;
  SampleRate?: number;
  LatencyNs?: number;
  Mac?: string;
  RouterInfo?: string;
}

export interface DanteDevice {
  Name: string;
  LastSeenAt: number;
  // Which service types this device is currently visible on, e.g. ['arc', 'cmc'].
  Services: string[];
  Info: DanteDeviceInfo;
}

export interface DanteSnapshot {
  Ready: boolean;
  Error: string | null;
  Devices: DanteDevice[];
}

// Normalize a name for case-insensitive comparison.
export function NormalizeName(Value: unknown): string {
  return String(Value == null ? '' : Value)
    .trim()
    .toLowerCase();
}

// Does a visible device name satisfy the configured target under the given mode?
// Comparison is case-insensitive. An empty target never matches.
export function MatchesDevice(
  CandidateName: unknown,
  Target: unknown,
  Mode: DanteMatchMode
): boolean {
  const C = NormalizeName(CandidateName);
  const T = NormalizeName(Target);
  if (!T) return false;
  return Mode === 'exact' ? C === T : C.includes(T);
}

// TXT values arrive as strings from bonjour-service, but can be Buffers if a
// future version switches to binary mode — coerce defensively.
function TxtString(
  Txt: Record<string, unknown> | null | undefined,
  Key: string
): string | undefined {
  if (!Txt) return undefined;
  const Raw = Txt[Key] ?? Txt[Key.toLowerCase()];
  if (Raw == null) return undefined;
  const S = Buffer.isBuffer(Raw) ? Raw.toString('utf8') : String(Raw);
  const Trimmed = S.trim();
  return Trimmed ? Trimmed : undefined;
}

function TxtNumber(
  Txt: Record<string, unknown> | null | undefined,
  Key: string
): number | undefined {
  const S = TxtString(Txt, Key);
  if (S == null) return undefined;
  const N = Number(S);
  return Number.isFinite(N) ? N : undefined;
}

// Lift the fields we display out of one service's TXT record. Keys differ per
// service type; absent keys simply yield undefined and are dropped on merge.
export function ParseTxt(Txt: Record<string, unknown> | null | undefined): DanteDeviceInfo {
  const Info: DanteDeviceInfo = {};
  const Model = TxtString(Txt, 'model');
  const Firmware = TxtString(Txt, 'router_vers');
  const SampleRate = TxtNumber(Txt, 'rate');
  const LatencyNs = TxtNumber(Txt, 'latency_ns');
  const RouterInfo = TxtString(Txt, 'router_info');
  const Mac = TxtString(Txt, 'id');
  if (Model !== undefined) Info.Model = Model;
  if (Firmware !== undefined) Info.Firmware = Firmware;
  if (SampleRate !== undefined) Info.SampleRate = SampleRate;
  if (LatencyNs !== undefined) Info.LatencyNs = LatencyNs;
  if (RouterInfo !== undefined) Info.RouterInfo = RouterInfo;
  if (Mac !== undefined) Info.Mac = Mac;
  return Info;
}

// Merge newly-parsed TXT metadata over what we already hold, keeping existing
// values when the new record omits a key. A device seen on ARC then CMC ends up
// with the union of both records rather than the last one to arrive.
function MergeInfo(Existing: DanteDeviceInfo, Incoming: DanteDeviceInfo): DanteDeviceInfo {
  const Merged: DanteDeviceInfo = { ...Existing };
  for (const [Key, Value] of Object.entries(Incoming)) {
    if (Value !== undefined) (Merged as Record<string, unknown>)[Key] = Value;
  }
  return Merged;
}

// Human-readable sample rate: 48000 -> "48 kHz", 44100 -> "44.1 kHz".
export function FormatSampleRate(Rate: unknown): string {
  const N = Number(Rate);
  if (!Number.isFinite(N) || N <= 0) return '—';
  const K = N / 1000;
  return `${Number.isInteger(K) ? K : K.toFixed(1)} kHz`;
}

// Dante reports device latency in nanoseconds; show it in the millisecond /
// sub-millisecond units operators actually think in (1 ms, 0.25 ms, ...).
export function FormatDanteLatency(Ns: unknown): string {
  const N = Number(Ns);
  if (!Number.isFinite(N) || N < 0) return '—';
  const Ms = N / 1e6;
  if (Ms >= 1) return `${Number.isInteger(Ms) ? Ms : Ms.toFixed(2)} ms`;
  return `${Ms.toFixed(2)} ms`;
}

// The process-wide singleton browser.
class DanteBrowserImpl {
  // Keyed by NORMALIZED device name (not fqdn) so the same device seen on both
  // _netaudio-arc and _netaudio-cmc collapses into one record.
  private Devices = new Map<string, DanteDevice>();
  // Tracks which (device, service) pairs are currently up, so a `down` on one
  // service type doesn't evict a device still visible on the other.
  private ServiceKeys = new Map<string, Set<string>>();
  private Instance: BonjourInstance | null = null;
  private Browsers: BonjourBrowser[] = [];
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
  Snapshot(): DanteSnapshot {
    return {
      Ready: this.State === 'ready',
      Error: this.State === 'failed' ? this.LastError : null,
      Devices: Array.from(this.Devices.values()),
    };
  }

  private EnsureStarted(): void {
    if (this.State === 'ready') return;
    if (this.State === 'failed' && Date.now() - this.LastFailAt < RETRY_COOLDOWN_MS) return;

    let Instance: BonjourInstance;
    const Browsers: BonjourBrowser[] = [];
    try {
      Instance = bonjour({ reuseAddr: true, loopback: true });
      for (const S of DANTE_SERVICE_TYPES) {
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
      const Service = DANTE_SERVICE_TYPES[Index]!;
      Browser.on('up', (Svc: BonjourService) => this.HandleUp(Svc, Service));
      Browser.on('down', (Svc: BonjourService) => this.HandleDown(Svc, Service));
      Browser.on('error', (Err: Error) => {
        Logger.warn(
          `Dante browser error (${ServiceString(Service)}): ${Err && Err.message ? Err.message : Err}`
        );
      });
      try {
        Browser.start();
      } catch {
        // Some bonjour builds auto-start on find(); a redundant start() is harmless.
      }
    });

    // Tap the raw multicast-dns response stream so re-announcements refresh each
    // device's timestamp (bonjour's `up` fires only once — see the file header).
    const Mdns = ExtractMdns(Instance);
    if (Mdns) {
      const Handler: MdnsResponseHandler = (Packet) => this.HandleResponse(Packet);
      Mdns.on('response', Handler);
      this.Mdns = Mdns;
      this.ResponseHandler = Handler;
    } else {
      Logger.warn(
        'Dante: could not tap multicast-dns responses; presence may go stale between re-announcements'
      );
    }

    // Kick an initial re-query shortly after start so we don't wait a full
    // interval for the first announcements.
    setTimeout(() => this.Requery(), 100);

    this.EnsureTimers();
    Logger.log(
      `Dante browser started (${DANTE_SERVICE_TYPES.map((S) => ServiceString(S)).join(', ')})`
    );
  }

  private HandleUp(Svc: BonjourService, Service: DanteServiceType): void {
    const Name = Svc && Svc.name ? String(Svc.name).trim() : '';
    const Fqdn = Svc && Svc.fqdn ? String(Svc.fqdn).trim() : '';
    const DeviceName = Name || DeriveNameFromFqdn(Fqdn);
    if (!DeviceName) return;

    const Key = NormalizeName(DeviceName);
    const Info = ParseTxt(Svc && Svc.txt);
    const Existing = this.Devices.get(Key);
    if (Existing) {
      Existing.LastSeenAt = Date.now();
      Existing.Info = MergeInfo(Existing.Info, Info);
    } else {
      this.Devices.set(Key, { Name: DeviceName, LastSeenAt: Date.now(), Services: [], Info });
    }
    this.AddService(Key, Service);
  }

  private HandleDown(Svc: BonjourService, Service: DanteServiceType): void {
    const Name = Svc && Svc.name ? String(Svc.name).trim() : '';
    const Fqdn = Svc && Svc.fqdn ? String(Svc.fqdn).trim() : '';
    const DeviceName = Name || DeriveNameFromFqdn(Fqdn);
    if (!DeviceName) return;

    const Key = NormalizeName(DeviceName);
    const Set_ = this.ServiceKeys.get(Key);
    if (Set_) {
      Set_.delete(Service.Type);
      // Only evict the device once it has gone away on EVERY service type it was
      // visible on — a goodbye on ARC alone doesn't mean the device is offline.
      if (Set_.size) {
        this.SyncServices(Key);
        return;
      }
      this.ServiceKeys.delete(Key);
    }
    this.Devices.delete(Key);
  }

  private AddService(Key: string, Service: DanteServiceType): void {
    let Set_ = this.ServiceKeys.get(Key);
    if (!Set_) {
      Set_ = new Set<string>();
      this.ServiceKeys.set(Key, Set_);
    }
    Set_.add(Service.Type);
    this.SyncServices(Key);
  }

  // Mirror the service-key set onto the device record in a stable, display-ready
  // form ('netaudio-arc' -> 'arc') so the debug panel can render it directly.
  private SyncServices(Key: string): void {
    const Device = this.Devices.get(Key);
    const Set_ = this.ServiceKeys.get(Key);
    if (!Device || !Set_) return;
    Device.Services = DANTE_SERVICE_TYPES.filter((S) => Set_.has(S.Type)).map((S) =>
      S.Type.replace(/^netaudio-/, '')
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

  // Bump (or re-create) the last-seen timestamp for every Dante device that just
  // re-announced. Runs after bonjour's own `up` handler on the same packet, so a
  // freshly-discovered device is already in the cache by the time we refresh it;
  // if a device had been swept out (bonjour won't re-emit `up` for it), we
  // re-create the entry here so it can recover.
  private HandleResponse(Packet: MdnsResponsePacket): void {
    if (!Packet) return;
    const Records = [
      ...(Array.isArray(Packet.answers) ? Packet.answers : []),
      ...(Array.isArray(Packet.additionals) ? Packet.additionals : []),
    ];

    const Fqdns = new Set<string>();
    for (const RR of Records) {
      if (!RR || RR.ttl === 0) continue; // ttl 0 is a goodbye; bonjour's `down` handles it
      for (const S of DANTE_SERVICE_TYPES) {
        const Fqdn = ServiceFqdn(S);
        const SrvSuffix = `.${Fqdn}`;
        if (RR.type === 'PTR' && RR.name === Fqdn && typeof RR.data === 'string') {
          Fqdns.add(RR.data.trim());
        } else if (
          RR.type === 'SRV' &&
          typeof RR.name === 'string' &&
          RR.name.toLowerCase().endsWith(SrvSuffix.toLowerCase())
        ) {
          Fqdns.add(RR.name.trim());
        }
      }
    }
    if (!Fqdns.size) return;

    const Now = Date.now();
    for (const Fqdn of Fqdns) {
      if (!Fqdn) continue;
      const DeviceName = DeriveNameFromFqdn(Fqdn);
      if (!DeviceName) continue;
      const Key = NormalizeName(DeviceName);
      const Existing = this.Devices.get(Key);
      if (Existing) Existing.LastSeenAt = Now;
      else this.Devices.set(Key, { Name: DeviceName, LastSeenAt: Now, Services: [], Info: {} });
    }
  }

  private Fail(Err: unknown): void {
    this.LastError = Err && (Err as Error).message ? (Err as Error).message : String(Err);
    this.LastFailAt = Date.now();
    this.State = 'failed';
    this.TeardownInstance();
    Logger.warn(`Dante browser unavailable: ${this.LastError}`);
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
    for (const [Key, Device] of this.Devices) {
      if (Now - Device.LastSeenAt > RETENTION_MS) {
        this.Devices.delete(Key);
        this.ServiceKeys.delete(Key);
      }
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
    this.Devices.clear();
    this.ServiceKeys.clear();
  }

  // Test-only: drop the cache without tearing the browser down, to simulate the
  // retention sweep having removed a device that is still on the network.
  _testClearDevices(): void {
    this.Devices.clear();
    this.ServiceKeys.clear();
  }
}

export const DanteBrowser = new DanteBrowserImpl();

// --- Settings / Run / Debug -------------------------------------------------

export const Settings: MonitoringSettingField[] = [
  {
    Key: 'DeviceName',
    Label: 'Dante device name',
    Type: 'string',
    Default: '',
    Required: true,
    Note: 'The Dante device name as shown in Dante Controller, or a substring of it.',
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
    Note: 'Contains matches any device name that includes the text; Exact requires the full name.',
  },
  {
    Key: 'GracePeriodMs',
    Label: 'Grace period (ms)',
    Type: 'number',
    Default: DEFAULT_GRACE_PERIOD_MS,
    Min: MIN_GRACE_PERIOD_MS,
    Max: MAX_GRACE_PERIOD_MS,
    Advanced: true,
    Note: 'How long a device may go unseen before the check reports Offline.',
  },
];

export function NormalizeMatchMode(Value: unknown): DanteMatchMode {
  return String(Value) === 'exact' ? 'exact' : 'contains';
}

interface EvaluateParams {
  Snapshot: DanteSnapshot;
  DeviceName: string;
  MatchMode: DanteMatchMode;
  GracePeriodMs: number;
  Now: number;
}

// Pure decision logic, separated from the browser so it can be unit-tested with a
// hand-built snapshot. Dante presence has no meaningful "degraded" state:
//   Success:true            -> online  (a matching device seen within grace)
//   Success:false           -> offline (no match, or the browser is unavailable)
export function EvaluateDante(P: EvaluateParams): MonitoringResult {
  const Base = { DeviceName: P.DeviceName, MatchMode: P.MatchMode };

  if (P.Snapshot.Error) {
    return {
      Success: false,
      Error: `Dante browser error: ${P.Snapshot.Error}`,
      ...Base,
      Devices: [],
    };
  }

  const Fresh = P.Snapshot.Devices.filter((D) => P.Now - D.LastSeenAt <= P.GracePeriodMs).sort(
    (A, B) => B.LastSeenAt - A.LastSeenAt
  );
  const WithDevices = { ...Base, Devices: Fresh, VisibleCount: Fresh.length };

  const Matched = Fresh.filter((D) => MatchesDevice(D.Name, P.DeviceName, P.MatchMode));
  if (Matched.length) {
    const Device = Matched[0]!; // non-empty: length checked above
    return {
      Success: true,
      LatencyMs: P.Now - Device.LastSeenAt,
      Matched: true,
      MatchedName: Device.Name,
      MatchedInfo: Device.Info,
      MatchedServices: Device.Services,
      ...WithDevices,
    };
  }

  return {
    Success: false,
    Error: P.Snapshot.Ready
      ? `Dante device not found (${Fresh.length} device${Fresh.length === 1 ? '' : 's'} visible)`
      : 'Dante browser starting…',
    Matched: false,
    ...WithDevices,
  };
}

export function RunDante(Target: MonitoringTargetLike): MonitoringResult {
  const Cfg = (Target && Target.Settings) || {};
  const DeviceName = Cfg.DeviceName != null ? String(Cfg.DeviceName).trim() : '';
  if (!DeviceName) return { Success: false, Error: 'No Dante device name configured' };

  const MatchMode = NormalizeMatchMode(Cfg.MatchMode);
  const GracePeriodMs = Number.isFinite(Cfg.GracePeriodMs)
    ? Math.min(
        MAX_GRACE_PERIOD_MS,
        Math.max(MIN_GRACE_PERIOD_MS, (Cfg.GracePeriodMs as number) | 0)
      )
    : DEFAULT_GRACE_PERIOD_MS;

  DanteBrowser.Observe();
  const Snapshot = DanteBrowser.Snapshot();

  return EvaluateDante({ Snapshot, DeviceName, MatchMode, GracePeriodMs, Now: Date.now() });
}

export function BuildDanteDebug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Cfg = (Target && Target.Settings) || {};
  const DeviceName =
    Result && Result.DeviceName != null
      ? String(Result.DeviceName)
      : Cfg.DeviceName != null
        ? String(Cfg.DeviceName).trim()
        : '';
  const MatchMode = NormalizeMatchMode(
    Result && Result.MatchMode != null ? Result.MatchMode : Cfg.MatchMode
  );
  const MatchedName = Result && Result.MatchedName != null ? String(Result.MatchedName) : '';
  const Info: DanteDeviceInfo =
    Result && Result.MatchedInfo && typeof Result.MatchedInfo === 'object'
      ? (Result.MatchedInfo as DanteDeviceInfo)
      : {};

  const Online = !!(Result && Result.Success);
  const StatusPill = Online ? Pill('success', 'Present') : Pill('danger', 'Not found');

  const Head = Rows([
    TextRow('Target device', DeviceName || '—'),
    TextRow('Match mode', MatchMode === 'exact' ? 'Exact' : 'Contains'),
    Row('Status', StatusPill),
    Online
      ? Row(
          'Last seen',
          `<span class="font-monospace">${FormatLatency(Result.LatencyMs)} ago</span>`
        )
      : Result && Result.Error
        ? TextRow('Detail', Result.Error as string)
        : null,
    // Only shown for a matched device, and only when the TXT record carried it.
    Online && Info.Model ? TextRow('Model', Info.Model) : null,
    Online && Info.Firmware ? TextRow('Firmware', Info.Firmware) : null,
    Online && Info.SampleRate ? TextRow('Sample rate', FormatSampleRate(Info.SampleRate)) : null,
    Online && Info.LatencyNs != null
      ? TextRow('Device latency', FormatDanteLatency(Info.LatencyNs))
      : null,
    Online && Info.Mac
      ? Row(
          'MAC / ID',
          `<span class="font-monospace">${Info.Mac.replace(/[^0-9a-fA-F]/g, '')}</span>`
        )
      : null,
    // Discovery is network-wide via mDNS, so the check's Address field is unused.
    Row(
      'Address',
      '<span class="text-muted small">Not used — Dante discovery is network-wide</span>'
    ),
  ]);

  const Devices: DanteDevice[] = Array.isArray(Result && Result.Devices)
    ? (Result.Devices as DanteDevice[])
    : [];
  if (!Devices.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note('No Dante devices currently visible on the network') +
      '</div>'
    );
  }

  const List = Devices.map((D) => {
    const IsMatch = MatchedName
      ? D.Name === MatchedName
      : MatchesDevice(D.Name, DeviceName, MatchMode);
    const Detail = [
      D.Info && D.Info.Model ? D.Info.Model : null,
      D.Info && D.Info.SampleRate ? FormatSampleRate(D.Info.SampleRate) : null,
      Array.isArray(D.Services) && D.Services.length ? D.Services.join(' + ') : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return Card({
      Title: D.Name,
      Badge: IsMatch ? Pill('success', 'Match') : null,
      Highlight: IsMatch,
      BodyHtml: Detail ? Note(Detail) : '',
    });
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Visible Dante devices (${Devices.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>`
  );
}

// Exported for unit tests.
export const _internal = {
  NormalizeName,
  MatchesDevice,
  NormalizeMatchMode,
  EvaluateDante,
  ParseTxt,
  DeriveNameFromFqdn,
  FormatSampleRate,
  FormatDanteLatency,
  DanteBrowser,
  DANTE_SERVICE_TYPES,
};
