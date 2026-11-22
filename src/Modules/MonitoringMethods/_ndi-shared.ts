// Shared plumbing for the NDI (NewTek / Network Device Interface) source-presence
// monitoring method.
//
// Like sACN, NDI discovery is *passive*: every running NDI source advertises
// itself on mDNS as a service instance of type `_ndi._tcp`, and there is nothing
// to actively probe; you simply listen for the announcements. Each source shows
// up as one service instance whose name looks like "MACHINE-NAME (Source Name)".
//
// So instead of opening a socket per check we run ONE process-wide mDNS browser
// (./_mdns-browser) that browses `_ndi._tcp`, and cache the set of
// currently-seen source (service instance) names, each with a last-seen
// timestamp refreshed every time the service re-announces.
//
// A check's Run() merely reads that cache and asks "was a source matching my
// target seen within the grace window?". The browser is fully lazy (nothing
// starts until the first Observe()), so importing this module (e.g. from the
// method registry) has NO side effects.
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
} from './_mdns-browser';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

export {
  NormalizeName,
  NormalizeMatchMode,
  DEFAULT_MATCH_MODE,
  DEFAULT_GRACE_PERIOD_MS,
  MIN_GRACE_PERIOD_MS,
  MAX_GRACE_PERIOD_MS,
};

const Logger = CreateLogger('NDI');

// The mDNS service the NDI SDK advertises every source on.
const NDI_SERVICE = { Type: 'ndi', Protocol: 'tcp' };
export const NDI_SERVICE_TYPE = NDI_SERVICE.Type;
export const NDI_SERVICE_PROTOCOL = NDI_SERVICE.Protocol;
export const NDI_SERVICE_STRING = ServiceString(NDI_SERVICE);
// Fully-qualified service name as it appears on the wire (PTR record name / the
// suffix of every source's SRV record name).
export const NDI_SERVICE_FQDN = ServiceFqdn(NDI_SERVICE);

// How this method matches the configured target against a visible source name.
export type NdiMatchMode = MdnsMatchMode;

// How responsive the checks feel. Presence changes on the order of seconds.
export const DEFAULT_NDI_INTERVAL_MS = 10000;

// Derive the display name for a source from its fully-qualified instance name by
// stripping the `._ndi._tcp.local` suffix. Matches the name bonjour surfaces via
// `up` for the typical (dotless) NDI instance name.
function DeriveNameFromFqdn(Fqdn: string): string {
  const Suffix = `.${NDI_SERVICE_FQDN}`;
  let N = String(Fqdn).replace(/\.$/, '');
  if (N.toLowerCase().endsWith(Suffix.toLowerCase())) N = N.slice(0, -Suffix.length);
  return N.trim();
}

export interface NdiSource {
  Name: string;
  LastSeenAt: number;
}

export interface NdiSnapshot {
  Ready: boolean;
  Error: string | null;
  Sources: NdiSource[];
}

// Does a visible source name satisfy the configured target under the given mode?
// Comparison is case-insensitive. An empty target never matches.
export const MatchesSource = MatchesName;

// The process-wide singleton browser and its source cache.
class NdiBrowserImpl {
  // Keyed by each source's fully-qualified instance name (fqdn) so the `up`/`down`
  // bonjour events and the raw response tap agree on identity. Falls back to the
  // display name as a key when no fqdn is available (e.g. under test stubs).
  private Sources = new Map<string, NdiSource>();
  private Browser = new MdnsPresenceBrowser({
    Label: 'NDI',
    Logger,
    Services: [NDI_SERVICE],
    Hooks: {
      Up: (Instance) => this.HandleUp(Instance),
      Down: (Instance) => this.HandleDown(Instance),
      Announced: (Fqdns, Now) => this.HandleAnnounced(Fqdns, Now),
      Sweep: (Now) => this.Sweep(Now),
    },
  });

  // Start browsing if we aren't already. Cheap to call on every Run().
  Observe(): void {
    this.Browser.Observe();
  }

  // Read the current cache. Does not start the browser; callers Observe() first.
  Snapshot(): NdiSnapshot {
    return {
      Ready: this.Browser.Ready,
      Error: this.Browser.Error,
      Sources: Array.from(this.Sources.values()),
    };
  }

  private HandleUp(Instance: MdnsInstance): void {
    const Key = Instance.Fqdn || Instance.Name;
    if (!Key) return;
    this.Sources.set(Key, {
      Name: Instance.Name || DeriveNameFromFqdn(Instance.Fqdn),
      LastSeenAt: Date.now(),
    });
  }

  private HandleDown(Instance: MdnsInstance): void {
    const Key = Instance.Fqdn || Instance.Name;
    if (Key) this.Sources.delete(Key);
  }

  // Bump (or re-create) the last-seen timestamp for every NDI source that just
  // re-announced; a source the sweep dropped is re-created so it can recover.
  private HandleAnnounced(Fqdns: ReadonlySet<string>, Now: number): void {
    for (const Fqdn of Fqdns) {
      const Existing = this.Sources.get(Fqdn);
      if (Existing) Existing.LastSeenAt = Now;
      else this.Sources.set(Fqdn, { Name: DeriveNameFromFqdn(Fqdn), LastSeenAt: Now });
    }
  }

  private Sweep(Now: number): void {
    for (const [Key, Src] of this.Sources) {
      if (Now - Src.LastSeenAt > RETENTION_MS) this.Sources.delete(Key);
    }
  }

  // Test-only teardown so a suite can start/stop deterministically.
  Stop(): void {
    this.Browser.Stop();
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
    Required: true,
    Note: 'The name or a substring to match. NDI source names take the form "MACHINE (Source Name)".',
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
    Note: 'Contains matches any source name that includes the text; Exact requires the full name.',
  },
  {
    Key: 'GracePeriodMs',
    Label: 'Grace period (ms)',
    Type: 'number',
    Default: DEFAULT_GRACE_PERIOD_MS,
    Min: MIN_GRACE_PERIOD_MS,
    Max: MAX_GRACE_PERIOD_MS,
    Advanced: true,
    Note: 'How long a source may go unseen before the check reports Offline.',
  },
];

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
    return {
      Success: false,
      Error: `NDI browser error: ${P.Snapshot.Error}`,
      ...Base,
      Sources: [],
    };
  }

  const Fresh = P.Snapshot.Sources.filter((S) => P.Now - S.LastSeenAt <= P.GracePeriodMs).sort(
    (A, B) => B.LastSeenAt - A.LastSeenAt
  );
  const WithSources = { ...Base, Sources: Fresh, VisibleCount: Fresh.length };

  const Matched = Fresh.filter((S) => MatchesSource(S.Name, P.SourceName, P.MatchMode));
  if (Matched.length) {
    const Src = Matched[0]!; // non-empty: length checked above
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
      : 'NDI browser starting...',
    Matched: false,
    ...WithSources,
  };
}

export function RunNdi(Target: MonitoringTargetLike): MonitoringResult {
  const Cfg = (Target && Target.Settings) || {};
  const SourceName = Cfg.SourceName != null ? String(Cfg.SourceName).trim() : '';
  if (!SourceName) return { Success: false, Error: 'No NDI source name configured' };

  const MatchMode = NormalizeMatchMode(Cfg.MatchMode);
  const GracePeriodMs = GracePeriodFrom(Cfg.GracePeriodMs);

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
    TextRow('Target source', SourceName || '-'),
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
    // Discovery is network-wide via mDNS, so the check's Address field is unused.
    Row('Address', '<span class="text-muted small">Not used: NDI discovery is network-wide</span>'),
  ]);

  const Sources: NdiSource[] = Array.isArray(Result && Result.Sources)
    ? (Result.Sources as NdiSource[])
    : [];
  if (!Sources.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note('No NDI sources currently visible on the network') +
      '</div>'
    );
  }

  const List = Sources.map((S) => {
    const IsMatch = MatchedName
      ? S.Name === MatchedName
      : MatchesSource(S.Name, SourceName, MatchMode);
    return Card({
      Title: S.Name,
      Badge: IsMatch ? Pill('success', 'Match') : null,
      Highlight: IsMatch,
    });
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
