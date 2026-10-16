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
// Universes whose checks stop asking about them are swept out after a couple of
// minutes so the map doesn't grow forever. The receiver is fully lazy — nothing
// binds until the first Observe() — so importing this module has no side effects.
// The socket itself lives in ./_artnet-shared, shared with the node-health and
// timecode checks: Art-Net fixes everything to port 6454, so there is only ever
// one socket.
import {
  ArtnetReceiver,
  AddressesEqual,
  NormalizeAddress,
  ParseArtnetPacket,
  MIN_UNIVERSE,
  MAX_UNIVERSE,
  type ArtnetSource,
  type ArtnetSnapshot,
} from './_artnet-shared';
import { Pill, Rows, TextRow, Row, Note, FormatLatency, Card } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'artnet-universe';

// Re-exported so existing importers of this module keep working after the
// receiver moved to ./_artnet-shared.
export { ArtnetReceiver, NormalizeAddress, ParseArtnetPacket, MIN_UNIVERSE, MAX_UNIVERSE };
export type { ArtnetSource, ArtnetSnapshot };

// Default freshness window: how recently a packet must have arrived for a source
// to count as "currently transmitting". Continuous senders refresh well under a
// second, so a few seconds tolerates a couple of dropped frames.
export const DEFAULT_GRACE_PERIOD_MS = 5000;
// How responsive the checks feel; Art-Net state changes fast, so poll often.
export const DEFAULT_ARTNET_INTERVAL_MS = 5000;

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
    return {
      Success: false,
      Error: `Art-Net listener error: ${P.Snapshot.Error}`,
      ...Base,
      Sources: [],
    };
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
