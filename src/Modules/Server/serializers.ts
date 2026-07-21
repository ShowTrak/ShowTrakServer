// Safe, serializable projections of internal manager objects for the Web UI.
import type {
  ClientView,
  GroupView,
  Vitals,
  RunningApplicationsSnapshot,
} from '@showtrak/protocol';

// Structural view of the internal Client entity — only the fields the public
// projection reads. The array-shaped telemetry is accepted as `unknown` because
// the projection re-validates each field with `Array.isArray` before copying it
// (which narrows it to a safe array), so the caller's exact element types are
// intentionally not depended upon here.
interface PublicClientSource {
  UUID: string;
  Nickname?: string | null;
  Hostname?: string | null;
  OperatingSystem?: string | null;
  GroupID?: number | null;
  Weight?: number;
  Version?: string | null;
  Slug?: string | null;
  IP?: string | null;
  MacAddress?: string | null;
  // Every MAC the client is known by — the full Wake-on-LAN target set, of which
  // MacAddress above is the currently-active one. Loose here like the other
  // array telemetry; re-narrowed on output.
  MacAddresses?: unknown;
  Online?: boolean;
  LastSeen?: number;
  // Accepted loosely (like the array telemetry below): the internal Client holds
  // either a full heartbeat Vitals or, before the first heartbeat, empty
  // placeholder objects. The projection re-narrows to the wire shape on output.
  Vitals?: unknown;
  Integrated?: unknown;
  Identifying?: unknown;
  Unassigned?: unknown;
  Degraded?: unknown;
  // Loose for the same reason as Vitals: the internal view carries a nullable
  // SampledAt and augmented items the wire snapshot type doesn't model.
  RunningApplications?: unknown;
  USBDeviceList?: unknown;
  CriticalUSBDevices?: unknown;
  CriticalUSBSerials?: unknown;
  MissingCriticalUSBDevices?: unknown;
  CriticalUSBNames?: unknown;
  MissingCriticalUSBNames?: unknown;
  DegradedWarnings?: unknown;
  NetworkInterfaces?: unknown;
  IntegratedActions?: unknown;
  CriticalApplications?: unknown;
  MissingCriticalApplications?: unknown;
  DisplayList?: unknown;
  CriticalDisplays?: unknown;
  CriticalDisplayIDs?: unknown;
  MissingCriticalDisplays?: unknown;
  MismatchedCriticalDisplays?: unknown;
}

// Structural view of the internal Group entity read by ToPublicGroup.
interface PublicGroupSource {
  GroupID: number;
  Title: string | null;
  Weight: number;
  isFullWidth?: boolean;
  KeyBind?: string | null;
  Slug?: string | null;
}

function IsIntegratedClient(c: PublicClientSource): boolean {
  if (!c) return false;
  if (c.Integrated === true) return true;
  return (
    String(c.OperatingSystem || '')
      .trim()
      .toLowerCase() === 'integrated'
  );
}

function FormatClientVersionLabel(c: PublicClientSource): string {
  const RawVersion = String((c && c.Version) || '')
    .trim()
    .replace(/^v\s*/i, '');
  const Version = RawVersion.length > 0 ? RawVersion : 'Unknown';
  return `${IsIntegratedClient(c) ? 'SDK v' : 'v'}${Version}`;
}

const ToPublicClient = (c: PublicClientSource): ClientView => ({
  Type: 'client',
  UUID: c.UUID,
  Nickname: c.Nickname,
  Hostname: c.Hostname,
  OperatingSystem: c.OperatingSystem || '',
  GroupID: c.GroupID,
  Weight: c.Weight,
  Version: c.Version,
  VersionLabel: FormatClientVersionLabel(c),
  Slug: c.Slug ?? null,
  IP: c.IP,
  MacAddress: c.MacAddress,
  MacAddresses: Array.isArray(c.MacAddresses) ? c.MacAddresses : [],
  Online: c.Online,
  LastSeen: c.LastSeen,
  Vitals: (c.Vitals ?? null) as Vitals | null,
  USBDeviceList: Array.isArray(c.USBDeviceList) ? c.USBDeviceList : [],
  CriticalUSBDevices: Array.isArray(c.CriticalUSBDevices) ? c.CriticalUSBDevices : [],
  CriticalUSBSerials: Array.isArray(c.CriticalUSBSerials) ? c.CriticalUSBSerials : [],
  MissingCriticalUSBDevices: Array.isArray(c.MissingCriticalUSBDevices)
    ? c.MissingCriticalUSBDevices
    : [],
  CriticalUSBNames: Array.isArray(c.CriticalUSBNames) ? c.CriticalUSBNames : [],
  MissingCriticalUSBNames: Array.isArray(c.MissingCriticalUSBNames)
    ? c.MissingCriticalUSBNames
    : [],
  Degraded: !!c.Degraded,
  DegradedWarnings: Array.isArray(c.DegradedWarnings) ? c.DegradedWarnings : [],
  NetworkInterfaces: Array.isArray(c.NetworkInterfaces) ? c.NetworkInterfaces : [],
  Integrated: !!c.Integrated,
  IntegratedActions: Array.isArray(c.IntegratedActions) ? c.IntegratedActions : [],
  Identifying: !!c.Identifying,
  Unassigned: !!c.Unassigned,
  RunningApplications: (c.RunningApplications as RunningApplicationsSnapshot | undefined) ?? {
    Items: [],
  },
  CriticalApplications: Array.isArray(c.CriticalApplications) ? c.CriticalApplications : [],
  MissingCriticalApplications: Array.isArray(c.MissingCriticalApplications)
    ? c.MissingCriticalApplications
    : [],
  DisplayList: Array.isArray(c.DisplayList) ? c.DisplayList : [],
  CriticalDisplays: Array.isArray(c.CriticalDisplays) ? c.CriticalDisplays : [],
  CriticalDisplayIDs: Array.isArray(c.CriticalDisplayIDs) ? c.CriticalDisplayIDs : [],
  MissingCriticalDisplays: Array.isArray(c.MissingCriticalDisplays)
    ? c.MissingCriticalDisplays
    : [],
  MismatchedCriticalDisplays: Array.isArray(c.MismatchedCriticalDisplays)
    ? c.MismatchedCriticalDisplays
    : [],
});

const ToPublicGroup = (g: PublicGroupSource): GroupView => ({
  GroupID: g.GroupID,
  Title: g.Title,
  Weight: g.Weight,
  isFullWidth: g.isFullWidth !== false,
  KeyBind: g.KeyBind ?? null,
  Slug: g.Slug ?? null,
});

// Structural view of a MonitoringTarget snapshot read by ToPublicMonitor.
interface PublicMonitorSource {
  TargetID: number;
  Nickname?: string | null;
  Slug?: string | null;
  GroupID?: number | null;
  Online?: boolean;
  Degraded?: boolean;
}

// Structural view of a DummyClient snapshot read by ToPublicDummy.
interface PublicDummySource {
  UUID: string;
  DummyID?: string | null;
  Nickname?: string | null;
  Hostname?: string | null;
  GroupID?: number | null;
  Online?: boolean;
  Degraded?: boolean;
  DegradedWarnings?: unknown;
}

// Monitors and dummies are surfaced to the SDK as CLIENT-shaped views so external
// integrations (Companion, etc.) treat them uniformly with real clients — they
// appear in the client list, carry status + label, and are addressable by slug.
// They reuse ToPublicClient to fill the full ClientView shape (empty telemetry),
// then override two things:
//   - Type — the wire discriminator ('monitor' / 'dummy' instead of 'client').
//   - UUID — a synthetic scoped id (`monitor:<TargetID>` / `dummy:<UUID>`) matching
//     the shared slug-namespace owner convention, so tag-scope membership (which
//     stores these scoped ids) resolves for them too.
// The Type override is not expressible against ClientView's 'client' literal, so
// each projection casts once at its boundary.
const ToPublicMonitor = (m: PublicMonitorSource): ClientView =>
  ({
    ...ToPublicClient({
      UUID: `monitor:${m.TargetID}`,
      Nickname: m.Nickname,
      Hostname: m.Nickname,
      Slug: m.Slug ?? null,
      GroupID: m.GroupID,
      Online: m.Online,
      Degraded: m.Degraded,
      Version: 'Monitor',
    }),
    Type: 'monitor',
  }) as unknown as ClientView;

const ToPublicDummy = (d: PublicDummySource): ClientView =>
  ({
    ...ToPublicClient({
      UUID: `dummy:${d.UUID}`,
      Nickname: d.Nickname,
      Hostname: d.Hostname ?? d.Nickname,
      Slug: d.DummyID ?? null,
      GroupID: d.GroupID,
      Online: d.Online,
      Degraded: d.Degraded,
      DegradedWarnings: Array.isArray(d.DegradedWarnings) ? d.DegradedWarnings : [],
      Version: 'Dummy',
    }),
    Type: 'dummy',
  }) as unknown as ClientView;

export { FormatClientVersionLabel, ToPublicClient, ToPublicGroup, ToPublicMonitor, ToPublicDummy };
