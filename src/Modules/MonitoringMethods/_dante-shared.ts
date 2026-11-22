// Shared plumbing for the Dante (Audinate) device-presence monitoring method.
//
// Like NDI, Dante discovery is *passive*: every Dante device advertises itself on
// mDNS, and there is nothing to actively probe; you simply listen. Unlike NDI,
// a device announces itself across SEVERAL service types, each carrying a
// different slice of metadata in its TXT record:
//
//   _netaudio-arc._udp   (port 4440) audio routing control: model, firmware
//                        (router_vers), sample rate, latency_ns, router_info
//   _netaudio-cmc._udp   (port 8800) control & monitoring: id (MAC), process,
//                        server_vers, channels
//
// We browse both and merge them into ONE device record keyed by device name (the
// mDNS instance name, which is the Dante device name and is identical across
// service types). Browsing both also gives presence redundancy: a device that has
// stopped answering on one service type is still seen on the other.
//
// SCOPE: this method reports device *presence* only. Dante subscription health
// (which receive channels are subscribed, and whether those subscriptions have
// failed) is NOT carried in mDNS; it lives in the proprietary ARC protocol on
// UDP 4440. That is deliberately out of scope here.
//
// The process-wide browser, its freshness tap and its retry handling are shared
// with NDI (./_mdns-browser); this module owns the device cache, keyed by name
// and merged across service types. The browser is fully lazy (nothing starts
// until the first Observe()), so importing this module (e.g. from the method
// registry) has NO side effects.
import { CreateLogger } from '../Logger';
import { Pill, Rows, TextRow, Row, Note, FormatLatency, Card } from './debug';
import {
  MdnsPresenceBrowser,
  ServiceFqdn,
  ServiceString,
  MatchesName,
  NormalizeName,
  NormalizeMatchMode,
  GracePeriodFrom,
  RETENTION_MS,
  DEFAULT_MATCH_MODE,
  DEFAULT_GRACE_PERIOD_MS,
  MIN_GRACE_PERIOD_MS,
  MAX_GRACE_PERIOD_MS,
  type MdnsInstance,
  type MdnsMatchMode,
  type MdnsServiceType,
} from './_mdns-browser';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

export {
  ServiceFqdn,
  ServiceString,
  NormalizeName,
  NormalizeMatchMode,
  DEFAULT_MATCH_MODE,
  DEFAULT_GRACE_PERIOD_MS,
  MIN_GRACE_PERIOD_MS,
  MAX_GRACE_PERIOD_MS,
};

const Logger = CreateLogger('Dante');

// The mDNS service types Dante devices advertise on. ARC is listed first because
// its TXT record carries the richer metadata (model / firmware / rate / latency).
export type DanteServiceType = MdnsServiceType;

export const DANTE_SERVICE_TYPES: DanteServiceType[] = [
  { Type: 'netaudio-arc', Protocol: 'udp' },
  { Type: 'netaudio-cmc', Protocol: 'udp' },
];

// How this method matches the configured target against a visible device name.
export type DanteMatchMode = MdnsMatchMode;

// How responsive the checks feel. Presence changes on the order of seconds.
export const DEFAULT_DANTE_INTERVAL_MS = 10000;

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

// The metadata we lift out of the merged TXT records. Every field is optional:
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

// Does a visible device name satisfy the configured target under the given mode?
// Comparison is case-insensitive. An empty target never matches.
export const MatchesDevice = MatchesName;

// TXT values arrive as strings from bonjour-service, but can be Buffers if a
// future version switches to binary mode, so coerce defensively.
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
  if (!Number.isFinite(N) || N <= 0) return '-';
  const K = N / 1000;
  return `${Number.isInteger(K) ? K : K.toFixed(1)} kHz`;
}

// Dante reports device latency in nanoseconds; show it in the millisecond /
// sub-millisecond units operators actually think in (1 ms, 0.25 ms, ...).
export function FormatDanteLatency(Ns: unknown): string {
  const N = Number(Ns);
  if (!Number.isFinite(N) || N < 0) return '-';
  const Ms = N / 1e6;
  if (Ms >= 1) return `${Number.isInteger(Ms) ? Ms : Ms.toFixed(2)} ms`;
  return `${Ms.toFixed(2)} ms`;
}

// The process-wide singleton browser and its device cache.
class DanteBrowserImpl {
  // Keyed by NORMALIZED device name (not fqdn) so the same device seen on both
  // _netaudio-arc and _netaudio-cmc collapses into one record.
  private Devices = new Map<string, DanteDevice>();
  // Tracks which (device, service) pairs are currently up, so a `down` on one
  // service type doesn't evict a device still visible on the other.
  private ServiceKeys = new Map<string, Set<string>>();
  private Browser = new MdnsPresenceBrowser({
    Label: 'Dante',
    Logger,
    Services: DANTE_SERVICE_TYPES,
    Hooks: {
      Up: (Instance, Service) => this.HandleUp(Instance, Service),
      Down: (Instance, Service) => this.HandleDown(Instance, Service),
      Announced: (Fqdns, Now) => this.HandleAnnounced(Fqdns, Now),
      Sweep: (Now) => this.Sweep(Now),
    },
  });

  // Start browsing if we aren't already. Cheap to call on every Run().
  Observe(): void {
    this.Browser.Observe();
  }

  // Read the current cache. Does not start the browser; callers Observe() first.
  Snapshot(): DanteSnapshot {
    return {
      Ready: this.Browser.Ready,
      Error: this.Browser.Error,
      Devices: Array.from(this.Devices.values()),
    };
  }

  private HandleUp(Instance: MdnsInstance, Service: DanteServiceType): void {
    const DeviceName = Instance.Name || DeriveNameFromFqdn(Instance.Fqdn);
    if (!DeviceName) return;

    const Key = NormalizeName(DeviceName);
    const Info = ParseTxt(Instance.Txt);
    const Existing = this.Devices.get(Key);
    if (Existing) {
      Existing.LastSeenAt = Date.now();
      Existing.Info = MergeInfo(Existing.Info, Info);
    } else {
      this.Devices.set(Key, { Name: DeviceName, LastSeenAt: Date.now(), Services: [], Info });
    }
    this.AddService(Key, Service);
  }

  private HandleDown(Instance: MdnsInstance, Service: DanteServiceType): void {
    const DeviceName = Instance.Name || DeriveNameFromFqdn(Instance.Fqdn);
    if (!DeviceName) return;

    const Key = NormalizeName(DeviceName);
    const Set_ = this.ServiceKeys.get(Key);
    if (Set_) {
      Set_.delete(Service.Type);
      // Only evict the device once it has gone away on EVERY service type it was
      // visible on; a goodbye on ARC alone doesn't mean the device is offline.
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

  // Bump (or re-create) the last-seen timestamp for every Dante device that just
  // re-announced, on either service type; a device the sweep dropped is
  // re-created so it can recover.
  private HandleAnnounced(Fqdns: ReadonlySet<string>, Now: number): void {
    for (const Fqdn of Fqdns) {
      const DeviceName = DeriveNameFromFqdn(Fqdn);
      if (!DeviceName) continue;
      const Key = NormalizeName(DeviceName);
      const Existing = this.Devices.get(Key);
      if (Existing) Existing.LastSeenAt = Now;
      else this.Devices.set(Key, { Name: DeviceName, LastSeenAt: Now, Services: [], Info: {} });
    }
  }

  private Sweep(Now: number): void {
    for (const [Key, Device] of this.Devices) {
      if (Now - Device.LastSeenAt > RETENTION_MS) {
        this.Devices.delete(Key);
        this.ServiceKeys.delete(Key);
      }
    }
  }

  // Test-only teardown so a suite can start/stop deterministically.
  Stop(): void {
    this.Browser.Stop();
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
      : 'Dante browser starting...',
    Matched: false,
    ...WithDevices,
  };
}

export function RunDante(Target: MonitoringTargetLike): MonitoringResult {
  const Cfg = (Target && Target.Settings) || {};
  const DeviceName = Cfg.DeviceName != null ? String(Cfg.DeviceName).trim() : '';
  if (!DeviceName) return { Success: false, Error: 'No Dante device name configured' };

  const MatchMode = NormalizeMatchMode(Cfg.MatchMode);
  const GracePeriodMs = GracePeriodFrom(Cfg.GracePeriodMs);

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
    TextRow('Target device', DeviceName || '-'),
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
      '<span class="text-muted small">Not used: Dante discovery is network-wide</span>'
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
