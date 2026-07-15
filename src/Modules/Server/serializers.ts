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
  IP?: string | null;
  MacAddress?: string | null;
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
  IP: c.IP,
  MacAddress: c.MacAddress,
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
});

export { FormatClientVersionLabel, ToPublicClient, ToPublicGroup };
