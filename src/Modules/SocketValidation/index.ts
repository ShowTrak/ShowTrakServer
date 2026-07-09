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

const MAX_USB_DEVICES = 512;
const MAX_DISPLAYS = 64;
const MAX_NETWORK_INTERFACES = 64;
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

// Heartbeat payloads arrive every second per client; validate structure and
// bound the strings, passing vitals through with only known fields.
function Heartbeat(data: unknown): {
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
    if (raw.CPU !== undefined) {
      if (!isPlainObject(raw.CPU)) fail('Vitals.CPU must be an object');
      Vitals.CPU = { UsagePercentage: normalizeOptionalFiniteNumber(raw.CPU.UsagePercentage, 'Vitals.CPU.UsagePercentage') };
    }
    if (raw.Ram !== undefined) {
      if (!isPlainObject(raw.Ram)) fail('Vitals.Ram must be an object');
      Vitals.Ram = {
        Total: normalizeOptionalFiniteNumber(raw.Ram.Total, 'Vitals.Ram.Total'),
        Used: normalizeOptionalFiniteNumber(raw.Ram.Used, 'Vitals.Ram.Used'),
        // Transmitted as a string (Number#toFixed) per shared/src/vitals.d.ts.
        UsagePercentage: normalizeOptionalString(raw.Ram.UsagePercentage, 'Vitals.Ram.UsagePercentage', { maxLength: 16 }),
      };
    }
    if (raw.Uptime !== undefined) {
      if (!isPlainObject(raw.Uptime)) fail('Vitals.Uptime must be an object');
      Vitals.Uptime = {
        Formatted: normalizeOptionalString(raw.Uptime.Formatted, 'Vitals.Uptime.Formatted', { maxLength: 32 }),
      };
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
  MacAddresses: Record<string, string>;
} {
  if (!isPlainObject(data)) fail('SystemInfo payload must be an object');
  const MacAddresses: Record<string, string> = {};
  if (data.MacAddresses !== undefined && data.MacAddresses !== null) {
    if (!isPlainObject(data.MacAddresses)) fail('MacAddresses must be an object when present');
    const entries = Object.entries(data.MacAddresses);
    if (entries.length > MAX_NETWORK_INTERFACES) {
      fail(`MacAddresses exceeds the maximum of ${MAX_NETWORK_INTERFACES} entries`);
    }
    for (const [name, mac] of entries) {
      if (typeof mac !== 'string') continue;
      MacAddresses[name.slice(0, 128)] = mac.slice(0, 64);
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

function USBDevice(value: unknown, fieldName = 'USBDevice'): {
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
    ManufacturerName: normalizeOptionalString(value.ManufacturerName, `${fieldName}.ManufacturerName`),
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
    SessionID: normalizeOptionalString(value.SessionID, `${fieldName}.SessionID`, { maxLength: 128 }),
    ScreenNumber: normalizeOptionalFiniteNumber(value.ScreenNumber, `${fieldName}.ScreenNumber`),
    DisplayID: normalizeOptionalString(value.DisplayID, `${fieldName}.DisplayID`, { maxLength: 256 }),
    HardwareID: normalizeOptionalString(value.HardwareID, `${fieldName}.HardwareID`, { maxLength: 256 }),
    IsStableIdentity: value.IsStableIdentity === true,
    IdentitySource: normalizeOptionalString(value.IdentitySource, `${fieldName}.IdentitySource`, { maxLength: 32 }),
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

function NetworkInterfaces(value: unknown) {
  const list = normalizeBoundedArray(value, 'NetworkInterfaces', {
    maxItems: MAX_NETWORK_INTERFACES,
  });
  return list.map((item, index) => {
    const fieldName = `NetworkInterfaces[${index}]`;
    if (!isPlainObject(item)) fail(`${fieldName} must be an object`);
    return {
      Name: normalizeOptionalString(item.Name, `${fieldName}.Name`, { maxLength: 128 }),
      Address: normalizeOptionalString(item.Address, `${fieldName}.Address`, { maxLength: 64 }),
      MAC: normalizeOptionalString(item.MAC, `${fieldName}.MAC`, { maxLength: 64 }),
      Family: normalizeOptionalString(item.Family, `${fieldName}.Family`, { maxLength: 16 }),
      Internal: item.Internal === true,
    };
  });
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
  const Status = isPlainObject(value.Status)
    ? {
        State: normalizeOptionalString(value.Status.State, 'Status.State', { maxLength: 32 }) || 'ok',
        Message: normalizeOptionalString(value.Status.Message, 'Status.Message', { maxLength: 512 }),
        Platform: normalizeOptionalString(value.Status.Platform, 'Status.Platform', { maxLength: 32 }),
      }
    : null;
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
  RegisterActions,
  IntegratedState,
  RequestID,
  ExecutionError,
  ExecutionProgress,
};
