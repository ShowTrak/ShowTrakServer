// Runtime validation for the client-agent Socket.IO namespace.
//
// Everything arriving on the default namespace is untrusted network input from
// remote machines. Each inbound event gets a validator that (a) enforces the
// payload shape declared in shared/src/events.d.ts, (b) caps array sizes and
// string lengths, and (c) RECONSTRUCTS objects field-by-field so unexpected
// keys (including `__proto__`-style junk from raw JSON) never reach the
// managers or the database. Validators throw on invalid input; the namespace
// wrapper logs and drops the event.
//
// Mirrors the IPCValidation pattern (renderer -> main) and shares its
// primitives via Modules/Validation.
import {
  fail,
  isPlainObject,
  normalizeBoundedArray,
  normalizeFiniteNumber,
  normalizeIdentifier,
  normalizeOptionalFiniteNumber,
  normalizeOptionalString,
} from '../Validation/primitives';
import { INTEGRATED_EVENT_MAX_FEEDBACK_LENGTH } from '../Config/constants';

const MAX_USB_DEVICES = 512;
const MAX_DISPLAYS = 64;
const MAX_NETWORK_INTERFACES = 64;
// A dual-stack NIC reports an IPv4 address plus a link-local and any number of
// global IPv6 addresses; a generous cap still bounds the payload.
const MAX_ADDRESSES_PER_INTERFACE = 64;
const MAX_RUNNING_APPLICATIONS = 4096;
const MAX_INTEGRATED_ACTIONS = 256;

// Client/device identifier from the socket handshake. Constrained to a
// selector/room-safe charset — this is the value that ends up in Socket.IO
// room names, DOM ids and data-uuid attributes.
function HandshakeUUID(value: unknown): string {
  return normalizeIdentifier(value, 'UUID');
}

function AdoptionHeartbeat(data: unknown): {
  BootTime: number | null;
  Hostname: string | null;
  OperatingSystem: string | null;
  Version: string | null;
  ServerIdentity: string | null;
} {
  if (!isPlainObject(data)) fail('AdoptionHeartbeat payload must be an object');
  return {
    BootTime: normalizeOptionalFiniteNumber(data.BootTime, 'BootTime'),
    Hostname: normalizeOptionalString(data.Hostname, 'Hostname'),
    OperatingSystem: normalizeOptionalString(data.OperatingSystem, 'OperatingSystem', {
      maxLength: 128,
    }),
    Version: normalizeOptionalString(data.Version, 'Version', { maxLength: 64 }),
    ServerIdentity: normalizeOptionalString(data.ServerIdentity, 'ServerIdentity', {
      maxLength: 128,
    }),
  };
}

// Vitals are display-only telemetry. A malformed one is dropped and reported
// rather than failing the whole heartbeat, because failing the heartbeat stops
// the client being marked online — so a cosmetic value in the wrong type would
// make a healthy device read as offline indefinitely. Everything that survives
// is still normalized and bounded exactly as before.
function Tolerate<T>(compute: () => T, onWarn?: (message: string) => void): T | null {
  try {
    return compute();
  } catch (error) {
    if (onWarn) onWarn(error instanceof Error ? error.message : String(error));
    return null;
  }
}

// Heartbeat payloads arrive every second per client; validate structure and
// bound the strings, passing vitals through with only known fields.
function Heartbeat(
  data: unknown,
  onWarn?: (message: string) => void
): {
  Version: string | null;
  Vitals: Record<string, unknown> | null;
  ScriptsFingerprint: string | null;
} {
  if (!isPlainObject(data)) fail('Heartbeat payload must be an object');
  let Vitals: Record<string, unknown> | null = null;
  if (data.Vitals !== undefined && data.Vitals !== null) {
    if (!isPlainObject(data.Vitals)) fail('Vitals must be an object when present');
    const raw = data.Vitals;
    Vitals = {};
    const CPU = raw.CPU;
    if (CPU !== undefined) {
      const Normalized = Tolerate(() => {
        if (!isPlainObject(CPU)) fail('Vitals.CPU must be an object');
        return {
          UsagePercentage: normalizeOptionalFiniteNumber(
            CPU.UsagePercentage,
            'Vitals.CPU.UsagePercentage'
          ),
        };
      }, onWarn);
      if (Normalized) Vitals.CPU = Normalized;
    }
    const Ram = raw.Ram;
    if (Ram !== undefined) {
      const Normalized = Tolerate(() => {
        if (!isPlainObject(Ram)) fail('Vitals.Ram must be an object');
        // Each field is tolerated on its own so one bad value does not cost
        // the other two.
        return {
          Total: Tolerate(
            () => normalizeOptionalFiniteNumber(Ram.Total, 'Vitals.Ram.Total'),
            onWarn
          ),
          Used: Tolerate(() => normalizeOptionalFiniteNumber(Ram.Used, 'Vitals.Ram.Used'), onWarn),
          // Transmitted as a string (Number#toFixed) per shared/src/vitals.d.ts.
          UsagePercentage: Tolerate(
            () =>
              normalizeOptionalString(Ram.UsagePercentage, 'Vitals.Ram.UsagePercentage', {
                maxLength: 16,
              }),
            onWarn
          ),
        };
      }, onWarn);
      if (Normalized) Vitals.Ram = Normalized;
    }
    const Uptime = raw.Uptime;
    if (Uptime !== undefined) {
      const Normalized = Tolerate(() => {
        if (!isPlainObject(Uptime)) fail('Vitals.Uptime must be an object');
        return {
          Formatted: Tolerate(
            () =>
              normalizeOptionalString(Uptime.Formatted, 'Vitals.Uptime.Formatted', {
                maxLength: 32,
              }),
            onWarn
          ),
        };
      }, onWarn);
      if (Normalized) Vitals.Uptime = Normalized;
    }
  }
  return {
    Version: normalizeOptionalString(data.Version, 'Version', { maxLength: 64 }),
    Vitals,
    ScriptsFingerprint: normalizeOptionalString(data.ScriptsFingerprint, 'ScriptsFingerprint', {
      maxLength: 128,
    }),
  };
}

function SystemInfo(data: unknown): {
  Hostname: string | null;
  OperatingSystem: string | null;
  MacAddresses: Record<string, { ipv4: string | null; ipv6: string | null; mac: string | null }>;
} {
  if (!isPlainObject(data)) fail('SystemInfo payload must be an object');
  // The client sends `macaddress.all()` output: one entry per network
  // interface whose VALUE is an object `{ ipv4, ipv6, mac }`. Reconstruct each
  // entry field-by-field, preserving `ipv4` so the consumer can match the MAC
  // to the interface serving the active socket IP.
  const MacAddresses: Record<
    string,
    { ipv4: string | null; ipv6: string | null; mac: string | null }
  > = {};
  if (data.MacAddresses !== undefined && data.MacAddresses !== null) {
    if (!isPlainObject(data.MacAddresses)) fail('MacAddresses must be an object when present');
    const entries = Object.entries(data.MacAddresses);
    if (entries.length > MAX_NETWORK_INTERFACES) {
      fail(`MacAddresses exceeds the maximum of ${MAX_NETWORK_INTERFACES} entries`);
    }
    for (const [name, iface] of entries) {
      if (!isPlainObject(iface)) continue;
      MacAddresses[name.slice(0, 128)] = {
        ipv4: normalizeOptionalString(iface.ipv4, 'MacAddresses.ipv4', { maxLength: 64 }),
        ipv6: normalizeOptionalString(iface.ipv6, 'MacAddresses.ipv6', { maxLength: 64 }),
        mac: normalizeOptionalString(iface.mac, 'MacAddresses.mac', { maxLength: 64 }),
      };
    }
  }
  return {
    Hostname: normalizeOptionalString(data.Hostname, 'Hostname'),
    OperatingSystem: normalizeOptionalString(data.OperatingSystem, 'OperatingSystem', {
      maxLength: 128,
    }),
    MacAddresses,
  };
}

function USBDevice(
  value: unknown,
  fieldName = 'USBDevice'
): {
  VendorID: number | null;
  ProductID: number | null;
  ManufacturerName: string | null;
  ProductName: string | null;
  SerialNumber: string | null;
} {
  if (!isPlainObject(value)) fail(`${fieldName} must be an object`);
  return {
    VendorID: normalizeOptionalFiniteNumber(value.VendorID, `${fieldName}.VendorID`),
    ProductID: normalizeOptionalFiniteNumber(value.ProductID, `${fieldName}.ProductID`),
    ManufacturerName: normalizeOptionalString(
      value.ManufacturerName,
      `${fieldName}.ManufacturerName`
    ),
    ProductName: normalizeOptionalString(value.ProductName, `${fieldName}.ProductName`),
    SerialNumber: normalizeOptionalString(value.SerialNumber, `${fieldName}.SerialNumber`),
  };
}

function USBDeviceList(value: unknown) {
  const list = normalizeBoundedArray(value, 'USBDeviceList', { maxItems: MAX_USB_DEVICES });
  return list.map((device, index) => USBDevice(device, `USBDeviceList[${index}]`));
}

function Display(value: unknown, fieldName = 'Display'): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${fieldName} must be an object`);
  const Bounds = isPlainObject(value.Bounds)
    ? {
        x: normalizeOptionalFiniteNumber(value.Bounds.x, `${fieldName}.Bounds.x`),
        y: normalizeOptionalFiniteNumber(value.Bounds.y, `${fieldName}.Bounds.y`),
        width: normalizeOptionalFiniteNumber(value.Bounds.width, `${fieldName}.Bounds.width`),
        height: normalizeOptionalFiniteNumber(value.Bounds.height, `${fieldName}.Bounds.height`),
      }
    : null;
  return {
    SessionID: normalizeOptionalString(value.SessionID, `${fieldName}.SessionID`, {
      maxLength: 128,
    }),
    ScreenNumber: normalizeOptionalFiniteNumber(value.ScreenNumber, `${fieldName}.ScreenNumber`),
    DisplayID: normalizeOptionalString(value.DisplayID, `${fieldName}.DisplayID`, {
      maxLength: 256,
    }),
    HardwareID: normalizeOptionalString(value.HardwareID, `${fieldName}.HardwareID`, {
      maxLength: 256,
    }),
    IsStableIdentity: value.IsStableIdentity === true,
    IdentitySource: normalizeOptionalString(value.IdentitySource, `${fieldName}.IdentitySource`, {
      maxLength: 32,
    }),
    Label: normalizeOptionalString(value.Label, `${fieldName}.Label`),
    Width: normalizeOptionalFiniteNumber(value.Width, `${fieldName}.Width`),
    Height: normalizeOptionalFiniteNumber(value.Height, `${fieldName}.Height`),
    ScaleFactor: normalizeOptionalFiniteNumber(value.ScaleFactor, `${fieldName}.ScaleFactor`),
    RefreshRate: normalizeOptionalFiniteNumber(value.RefreshRate, `${fieldName}.RefreshRate`),
    Rotation: normalizeOptionalFiniteNumber(value.Rotation, `${fieldName}.Rotation`),
    Internal: value.Internal === true,
    Primary: value.Primary === true,
    Bounds,
  };
}

function DisplayList(value: unknown) {
  const list = normalizeBoundedArray(value, 'DisplayList', { maxItems: MAX_DISPLAYS });
  return list.map((display, index) => Display(display, `DisplayList[${index}]`));
}

// One address on a reported interface. A single NIC carries several — IPv4 plus
// one or more IPv6 — which is why the wire shape nests them.
function NetworkInterfaceAddress(value: unknown, fieldName: string) {
  if (!isPlainObject(value)) fail(`${fieldName} must be an object`);
  return {
    family: normalizeOptionalString(value.family, `${fieldName}.family`, { maxLength: 16 }),
    address: normalizeOptionalString(value.address, `${fieldName}.address`, { maxLength: 64 }),
    netmask: normalizeOptionalString(value.netmask, `${fieldName}.netmask`, { maxLength: 64 }),
    cidr: normalizeOptionalString(value.cidr, `${fieldName}.cidr`, { maxLength: 64 }),
    mac: normalizeOptionalString(value.mac, `${fieldName}.mac`, { maxLength: 64 }),
    internal: value.internal === true,
    scopeid: normalizeOptionalFiniteNumber(value.scopeid, `${fieldName}.scopeid`),
  };
}

/**
 * The client's `NetworkInterfaces` payload: `[{ name, addresses[] }]`.
 *
 * This validator previously reconstructed a FLAT, PascalCase shape
 * (`{ Name, Address, MAC, Family, Internal }`) that nothing on either side ever
 * produced or consumed. Because the reconstruction reads named fields off the
 * incoming object, every one of them resolved to undefined and the whole
 * payload was rewritten to nulls before any manager saw it — the client record
 * then stored `{ name: 'unknown', addresses: [] }` for every interface, and
 * CollectReportedMacAddresses found no MACs to ingest. The visible symptom was
 * Wi-Fi never appearing on a client, since a wired NIC still arrives separately
 * through SystemInfo's MacAddresses map while Wi-Fi only reaches the server here.
 *
 * The shape below is the one documented on `NetworkInterface` in the protocol
 * package, and the one the client-info modal reads.
 */
function NetworkInterfaces(value: unknown) {
  const list = normalizeBoundedArray(value, 'NetworkInterfaces', {
    maxItems: MAX_NETWORK_INTERFACES,
  });
  return list.map((item, index) => {
    const fieldName = `NetworkInterfaces[${index}]`;
    if (!isPlainObject(item)) fail(`${fieldName} must be an object`);
    const addresses = normalizeBoundedArray(item.addresses ?? [], `${fieldName}.addresses`, {
      maxItems: MAX_ADDRESSES_PER_INTERFACE,
    });
    return {
      name: normalizeOptionalString(item.name, `${fieldName}.name`, { maxLength: 128 }),
      addresses: addresses.map((address, addressIndex) =>
        NetworkInterfaceAddress(address, `${fieldName}.addresses[${addressIndex}]`)
      ),
    };
  });
}

// Health of the client's application collector. Shared by the full snapshot and
// the delta, which both carry it — a permission failure has to reach the UI
// whichever path the client is reporting on.
function RunningApplicationsStatus(value: unknown) {
  if (!isPlainObject(value)) return null;
  return {
    State: normalizeOptionalString(value.State, 'Status.State', { maxLength: 32 }) || 'ok',
    Message: normalizeOptionalString(value.Message, 'Status.Message', { maxLength: 512 }),
    Platform: normalizeOptionalString(value.Platform, 'Status.Platform', { maxLength: 32 }),
  };
}

// --- Incremental telemetry -------------------------------------------------
// A delta is untrusted input like everything else here, and is bounded by the
// same per-domain caps as the full list it amends: a client cannot use a delta
// to smuggle in a larger payload than a snapshot would allow.

function RemovedKeys(value: unknown, fieldName: string, maxItems: number): string[] {
  const list = normalizeBoundedArray(value ?? [], fieldName, { maxItems });
  return list.flatMap((entry, index) => {
    const name = normalizeOptionalString(entry, `${fieldName}[${index}]`, { maxLength: 128 });
    return name ? [name] : [];
  });
}

function NetworkInterfaceDelta(value: unknown) {
  if (!isPlainObject(value)) fail('NetworkInterfaceDelta payload must be an object');
  return {
    Added: NetworkInterfaces(value.Added ?? []),
    Changed: NetworkInterfaces(value.Changed ?? []),
    Removed: RemovedKeys(value.Removed, 'NetworkInterfaceDelta.Removed', MAX_NETWORK_INTERFACES),
  };
}

function DisplayDelta(value: unknown) {
  if (!isPlainObject(value)) fail('DisplayDelta payload must be an object');
  return {
    Added: DisplayList(value.Added ?? []),
    Changed: DisplayList(value.Changed ?? []),
    Removed: RemovedKeys(value.Removed, 'DisplayDelta.Removed', MAX_DISPLAYS),
  };
}

function ApplicationDelta(value: unknown) {
  if (!isPlainObject(value)) fail('ApplicationDelta payload must be an object');
  const entries = (raw: unknown, fieldName: string) => {
    const list = normalizeBoundedArray(raw ?? [], fieldName, {
      maxItems: MAX_RUNNING_APPLICATIONS,
    });
    return list.flatMap((item, index) => {
      if (!isPlainObject(item)) fail(`${fieldName}[${index}] must be an object`);
      const Name = normalizeOptionalString(item.Name, `${fieldName}[${index}].Name`, {
        maxLength: 256,
      });
      if (!Name) return [];
      const Count = normalizeOptionalFiniteNumber(item.Count, `${fieldName}[${index}].Count`);
      return [{ Name, Count: Count && Count > 0 ? Math.floor(Count) : 1 }];
    });
  };
  return {
    Started: entries(value.Started, 'ApplicationDelta.Started'),
    Changed: entries(value.Changed, 'ApplicationDelta.Changed'),
    Stopped: RemovedKeys(value.Stopped, 'ApplicationDelta.Stopped', MAX_RUNNING_APPLICATIONS),
    SampledAt: normalizeOptionalFiniteNumber(value.SampledAt, 'ApplicationDelta.SampledAt'),
    TotalCount: normalizeOptionalFiniteNumber(value.TotalCount, 'ApplicationDelta.TotalCount'),
    Truncated: value.Truncated === true,
    Status: RunningApplicationsStatus(value.Status),
  };
}

function RunningApplications(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) fail('RunningApplications payload must be an object');
  let Items: Array<{ Name: string; Count: number }> = [];
  if (value.Items !== undefined && value.Items !== null) {
    const list = normalizeBoundedArray(value.Items, 'Items', {
      maxItems: MAX_RUNNING_APPLICATIONS,
    });
    Items = list.flatMap((item, index) => {
      if (!isPlainObject(item)) fail(`Items[${index}] must be an object`);
      const Name = normalizeOptionalString(item.Name, `Items[${index}].Name`);
      if (!Name) return [];
      const Count = normalizeOptionalFiniteNumber(item.Count, `Items[${index}].Count`);
      return [{ Name, Count: Count === null ? 1 : Count }];
    });
  }
  const Status = RunningApplicationsStatus(value.Status);
  return {
    SampledAt: normalizeOptionalFiniteNumber(value.SampledAt, 'SampledAt'),
    TotalCount: normalizeOptionalFiniteNumber(value.TotalCount, 'TotalCount'),
    Truncated: value.Truncated === true,
    Items,
    Status,
    NoChanges: value.NoChanges === true,
  };
}

// Integrated action catalogs are normalized again by
// ClientManager.SetIntegratedActions; here we only enforce the container
// shape and cap so a hostile payload cannot blow up memory first.
function RegisterActions(value: unknown): unknown[] {
  return normalizeBoundedArray(value, 'RegisterActions', { maxItems: MAX_INTEGRATED_ACTIONS });
}

function IntegratedState(state: unknown, message: unknown): [string, string | null] {
  if (typeof state !== 'string') fail('State must be a string');
  return [
    state.trim().slice(0, 32),
    normalizeOptionalString(message, 'Message', { maxLength: 512 }),
  ];
}

// Progress line for an in-flight integrated event. Over-long messages are
// trimmed to the cap rather than rejected: a chatty handler should not have its
// event torn down over a status string.
function IntegratedEventFeedback(value: unknown): string {
  if (typeof value !== 'string') fail('Message must be a string');
  const Trimmed = value.trim();
  if (!Trimmed) fail('Message cannot be empty');
  return Trimmed.slice(0, INTEGRATED_EVENT_MAX_FEEDBACK_LENGTH);
}

// Execution request ids are server-generated UUIDs echoed back by the client.
function RequestID(value: unknown): string {
  return normalizeIdentifier(value, 'RequestID');
}

function ExecutionError(value: unknown): string | null {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === 'string') return value.slice(0, 2048);
  if (value instanceof Error) return String(value.message || value).slice(0, 2048);
  fail('Error must be a string or null');
}

function ExecutionProgress(progress: unknown, statusText: unknown): [number, string | null] {
  const n = normalizeFiniteNumber(progress, 'Progress');
  return [
    Math.max(0, Math.min(100, n)),
    normalizeOptionalString(statusText, 'StatusText', { maxLength: 512 }),
  ];
}

export const Manager = {
  HandshakeUUID,
  AdoptionHeartbeat,
  Heartbeat,
  SystemInfo,
  USBDevice,
  USBDeviceList,
  DisplayList,
  NetworkInterfaces,
  RunningApplications,
  NetworkInterfaceDelta,
  DisplayDelta,
  ApplicationDelta,
  RegisterActions,
  IntegratedEventFeedback,
  IntegratedState,
  RequestID,
  ExecutionError,
  ExecutionProgress,
};
