// Critical USB devices — the pure half.
//
// Everything here is a function of its arguments: reading the optional fields a
// client reports, judging a critical device (by serial) or a critical group of
// serial-less devices (by name, with an expected quantity) against its
// conditions, building the list the renderer draws, and working out the
// conditions a mark/update request produces. The Client entity (./client.ts)
// holds the state and calls these.
//
// Clients before 3.22.0 report a device's names and serial only. The port it is
// plugged into, its firmware version and (on Windows) its Plug and Play problem
// state came later, so every one of them may be absent — and an absent or
// unreadable value is never a fault, the principle the display, audio and
// network halves follow. A condition on something a client cannot report simply
// waits until it can.
import type {
  CriticalUSBConditions,
  CriticalUSBDevice,
  CriticalUSBName,
  USBCapabilities,
  USBDevice,
  USBDeviceState,
  USBIssue,
  USBIssueKind,
} from '@showtrak/protocol';
import { AsRecord, normalizeSerialNumber, normalizeUSBNameKey } from './normalizers';

/** DegradedWarnings entries, one per kind of fault. */
export const USB_WARNINGS: Record<USBIssueKind, string> = {
  missing: 'Missing USB Device',
  location: 'USB Device Moved',
  firmware: 'USB Firmware Changed',
  device_error: 'USB Device Error',
};

/** A device in the renderer's list: reported, or a critical one that was not. */
export interface USBDeviceViewEntry extends Record<string, unknown> {
  SerialNumber: string | null;
  ManufacturerName: string | null;
  ProductName: string | null;
  IsConnected: boolean;
  IsCritical: boolean;
  Missing: boolean;
  Mismatch: boolean;
  Issues: USBIssue[];
  Critical: CriticalUSBDevice | CriticalUSBName | null;
  IsCriticalByName?: boolean;
  NameKey?: string;
  Quantity?: number;
  ConnectedCount?: number;
  Shortfall?: boolean;
}

// --- Reported values --------------------------------------------------------------

/** "1-2.4": a bus, then the port path through any hubs. Null when it is not one. */
export function normalizeUSBLocation(Value: unknown): string | null {
  if (typeof Value !== 'string') return null;
  const Text = Value.trim();
  return /^\d{1,3}-\d{1,3}(\.\d{1,3}){0,7}$/.test(Text) ? Text : null;
}

/** A firmware version as reported ("1.23"); null when empty. */
export function normalizeFirmwareVersion(Value: unknown): string | null {
  if (typeof Value !== 'string') return null;
  const Text = Value.trim();
  return Text ? Text.slice(0, 32) : null;
}

/** A Plug and Play state; null when it is not one. */
export function normalizeDeviceState(Value: unknown): USBDeviceState | null {
  const V = AsRecord(Value);
  const Code = Number(V.ErrorCode);
  if (!Number.isInteger(Code) || Code < 0) return null;
  const Message = typeof V.Message === 'string' && V.Message.trim() ? V.Message.trim() : null;
  return { ErrorCode: Code, Message: Code === 0 ? null : Message };
}

/** "Bus 1 · Port 2.4"; several, comma-separated, read one by one. */
export function DescribeUSBLocation(Location: string): string {
  return LocationList(Location)
    .map((One) => {
      const [Bus, Path] = One.split('-');
      return `Bus ${Bus} · Port ${Path}`;
    })
    .join(', ');
}

/** The sorted, de-duplicated ports in a stored location ("1-2,1-3"). */
export function LocationList(Location: string | null): string[] {
  if (!Location) return [];
  const Ports = Location.split(',')
    .map(normalizeUSBLocation)
    .filter((Port): Port is string => !!Port);
  return [...new Set(Ports)].sort();
}

/**
 * Whether the client reports each property at all: any device carrying the key
 * (even as null) says it can. Null until the client has reported anything.
 */
export function usbCapabilities(Devices: USBDevice[] | null): USBCapabilities | null {
  if (!Devices) return null;
  const Has = (Key: keyof USBDevice) =>
    Devices.some((Device) => Device && Device[Key] !== undefined);
  return {
    Location: Has('Location'),
    FirmwareVersion: Has('FirmwareVersion'),
    DeviceState: Has('DeviceState'),
  };
}

function ErrorOf(Device: USBDevice): USBDeviceState | null {
  const State = normalizeDeviceState(Device.DeviceState);
  return State && State.ErrorCode !== 0 ? State : null;
}

/** "Device error: This device cannot start (Code 10)". */
export function DescribeDeviceError(State: USBDeviceState): string {
  return State.Message
    ? `Device error: ${State.Message} (Code ${State.ErrorCode})`
    : `Device error (Code ${State.ErrorCode})`;
}

// --- Critical entries -------------------------------------------------------------

/**
 * The conditions of a stored or requested entry. A row written before
 * conditions existed was always required to be present, and a Windows device
 * that failed used to vanish from the list (so it faulted as missing); no device
 * error is required by default so that keeps faulting now it stays listed.
 */
export function normalizeUSBConditions(Value: unknown): CriticalUSBConditions {
  const E = AsRecord(Value);
  const Flag = (Raw: unknown) =>
    Raw === undefined || Raw === null ? true : Raw === true || Raw === 1;
  const Location = LocationList(typeof E.Location === 'string' ? E.Location : null).join(',');
  return {
    RequirePresent: Flag(E.RequirePresent),
    Location: Location || null,
    FirmwareVersion: normalizeFirmwareVersion(E.FirmwareVersion),
    RequireNoError: Flag(E.RequireNoError),
  };
}

function TimestampOrNull(Value: unknown): number | null {
  return Number.isFinite(Number(Value)) && Value ? Number(Value) : null;
}

function NameOrNull(Value: unknown): string | null {
  return Value ? String(Value) : null;
}

/** Normalise a stored or requested serial-keyed entry; null when it has no serial. */
export function normalizeCriticalUSBEntry(Value: unknown): CriticalUSBDevice | null {
  const E = AsRecord(Value);
  const SerialNumber = normalizeSerialNumber(E.SerialNumber);
  if (!SerialNumber) return null;
  return {
    SerialNumber,
    ManufacturerName: NameOrNull(E.ManufacturerName),
    ProductName: NameOrNull(E.ProductName),
    ...normalizeUSBConditions(E),
    Timestamp: TimestampOrNull(E.Timestamp),
  };
}

/** Normalise a stored or requested name-keyed entry. */
export function normalizeCriticalUSBNameEntry(Value: unknown): CriticalUSBName | null {
  const E = AsRecord(Value);
  const ManufacturerName = NameOrNull(E.ManufacturerName);
  const ProductName = NameOrNull(E.ProductName);
  const NameKey = E.NameKey
    ? String(E.NameKey).trim().toLowerCase()
    : normalizeUSBNameKey(ManufacturerName, ProductName);
  if (!NameKey) return null;
  return {
    NameKey,
    ManufacturerName,
    ProductName,
    Quantity: Math.max(1, parseInt(String(E.Quantity), 10) || 1),
    ...normalizeUSBConditions(E),
    Timestamp: TimestampOrNull(E.Timestamp),
  };
}

// --- Judging ----------------------------------------------------------------------

function NameOf(Entry: { ManufacturerName: string | null; ProductName: string | null }): string {
  return `${Entry.ManufacturerName || 'Generic'} ${Entry.ProductName || 'USB Device'}`;
}

/**
 * The faults one device shows against the conditions it is held to, other than
 * presence. A property the device does not report is not judged.
 */
function DeviceIssues(
  Device: USBDevice,
  Conditions: CriticalUSBConditions,
  ExpectedPorts: string[]
): USBIssue[] {
  const Issues: USBIssue[] = [];
  const Location = normalizeUSBLocation(Device.Location);
  if (ExpectedPorts.length && Location && !ExpectedPorts.includes(Location)) {
    Issues.push({
      Kind: 'location',
      Message: `Plugged into ${DescribeUSBLocation(Location)} (expected ${DescribeUSBLocation(
        ExpectedPorts.join(',')
      )})`,
    });
  }
  const Firmware = normalizeFirmwareVersion(Device.FirmwareVersion);
  if (Conditions.FirmwareVersion && Firmware && Firmware !== Conditions.FirmwareVersion) {
    Issues.push({
      Kind: 'firmware',
      Message: `Firmware is ${Firmware} (expected ${Conditions.FirmwareVersion})`,
    });
  }
  const Error = ErrorOf(Device);
  if (Conditions.RequireNoError && Error) {
    Issues.push({ Kind: 'device_error', Message: DescribeDeviceError(Error) });
  }
  return Issues;
}

/** Judge one serial-keyed device; `Device` is null when it is not connected. */
export function evaluateUSBIssues(
  Device: USBDevice | null,
  Critical: CriticalUSBDevice
): USBIssue[] {
  if (!Device) {
    return Critical.RequirePresent
      ? [{ Kind: 'missing', Message: `${NameOf(Critical)} is not connected` }]
      : [];
  }
  return DeviceIssues(Device, Critical, LocationList(Critical.Location));
}

/** The presence fault of a name-keyed group, when fewer are connected than expected. */
export function evaluateUSBNameShortfall(Count: number, Critical: CriticalUSBName): USBIssue[] {
  if (!Critical.RequirePresent || Count >= Critical.Quantity) return [];
  return [
    {
      Kind: 'missing',
      Message:
        Critical.Quantity === 1
          ? `${NameOf(Critical)} is not connected`
          : `${Count} of ${Critical.Quantity} connected`,
    },
  ];
}

// --- View -------------------------------------------------------------------------

export interface USBViewResult {
  List: USBDeviceViewEntry[];
  /** Serial-keyed critical devices required to be connected that are not. */
  MissingDevices: USBDeviceViewEntry[];
  /** Name-keyed groups required to be connected with fewer than expected connected. */
  MissingNames: USBDeviceViewEntry[];
  /** De-duplicated DegradedWarnings entries (only populated when trusted). */
  Warnings: string[];
  Capabilities: USBCapabilities | null;
}

/**
 * Merge the reported devices with the critical baselines into the renderer's
 * list. `Trusted` is whether the list was reported on this connection: until
 * then the list is shown but nothing beyond presence is judged, and no warning
 * is raised.
 */
export function buildUSBView(
  Devices: USBDevice[],
  Serials: CriticalUSBDevice[],
  Names: CriticalUSBName[],
  Trusted: boolean
): USBViewResult {
  const Reported = Array.isArray(Devices) ? Devices.filter(Boolean) : [];
  const BySerial = new Map<string, CriticalUSBDevice>();
  for (const Entry of Serials)
    if (Entry && !BySerial.has(Entry.SerialNumber)) BySerial.set(Entry.SerialNumber, Entry);
  const ByName = new Map<string, CriticalUSBName>();
  for (const Entry of Names)
    if (Entry && !ByName.has(Entry.NameKey)) ByName.set(Entry.NameKey, Entry);

  // Name-based guarding counts every connected device of the name, but only
  // devices without a serial can be guarded by it (a serial is the better key).
  const CountByName = new Map<string, number>();
  for (const Device of Reported) {
    const Key = normalizeUSBNameKey(Device.ManufacturerName, Device.ProductName);
    CountByName.set(Key, (CountByName.get(Key) || 0) + 1);
  }
  const Judge = (Issues: USBIssue[]) => (Trusted ? Issues : []);

  const Connected: USBDeviceViewEntry[] = Reported.map((Device) => {
    const SerialNumber = normalizeSerialNumber(Device.SerialNumber);
    const BySerialEntry = SerialNumber ? BySerial.get(SerialNumber) || null : null;
    const NameKey = normalizeUSBNameKey(Device.ManufacturerName, Device.ProductName);
    const ByNameEntry = !SerialNumber ? ByName.get(NameKey) || null : null;
    const Count = ByNameEntry ? CountByName.get(NameKey) || 0 : undefined;
    const Issues = BySerialEntry
      ? Judge(evaluateUSBIssues(Device, BySerialEntry))
      : ByNameEntry
        ? Judge([
            ...evaluateUSBNameShortfall(Count as number, ByNameEntry),
            ...DeviceIssues(Device, ByNameEntry, LocationList(ByNameEntry.Location)),
          ])
        : [];
    return {
      ...Device,
      SerialNumber: Device.SerialNumber ? String(Device.SerialNumber) : null,
      IsConnected: true,
      IsCritical: !!BySerialEntry || !!ByNameEntry,
      IsCriticalByName: !!ByNameEntry,
      NameKey,
      Quantity: ByNameEntry ? ByNameEntry.Quantity : undefined,
      ConnectedCount: Count,
      Shortfall: ByNameEntry ? (Count as number) < ByNameEntry.Quantity : undefined,
      Missing: false,
      Mismatch: Issues.some((Issue) => Issue.Kind !== 'missing'),
      Issues,
      Critical: BySerialEntry || ByNameEntry,
      ManufacturerName: Device.ManufacturerName || BySerialEntry?.ManufacturerName || null,
      ProductName: Device.ProductName || BySerialEntry?.ProductName || null,
    };
  });

  const ConnectedSerials = new Set(
    Reported.map((Device) => normalizeSerialNumber(Device.SerialNumber)).filter(Boolean)
  );
  const AbsentDevices: USBDeviceViewEntry[] = [];
  for (const Entry of BySerial.values()) {
    if (ConnectedSerials.has(Entry.SerialNumber)) continue;
    AbsentDevices.push({
      ManufacturerName: Entry.ManufacturerName,
      ProductName: Entry.ProductName,
      SerialNumber: Entry.SerialNumber,
      IsConnected: false,
      IsCritical: true,
      // Absent but allowed to be: shown as not connected, never as missing.
      Missing: Entry.RequirePresent,
      Mismatch: false,
      Issues: Judge(evaluateUSBIssues(null, Entry)),
      Critical: Entry,
    });
  }

  // A name group short of its quantity is "missing" (it drives the degraded
  // state); only a group with none connected needs a card of its own, since a
  // partly connected one is already shown by its connected cards.
  const ShortNames: USBDeviceViewEntry[] = [];
  const AbsentNameCards: USBDeviceViewEntry[] = [];
  for (const Entry of ByName.values()) {
    const Count = CountByName.get(Entry.NameKey) || 0;
    if (Count >= Entry.Quantity) continue;
    const Record: USBDeviceViewEntry = {
      ManufacturerName: Entry.ManufacturerName,
      ProductName: Entry.ProductName,
      SerialNumber: null,
      NameKey: Entry.NameKey,
      Quantity: Entry.Quantity,
      ConnectedCount: Count,
      IsConnected: false,
      IsCritical: true,
      IsCriticalByName: true,
      Shortfall: true,
      Missing: Entry.RequirePresent,
      Mismatch: false,
      Issues: Judge(evaluateUSBNameShortfall(Count, Entry)),
      Critical: Entry,
    };
    if (Entry.RequirePresent) ShortNames.push(Record);
    if (Count === 0) AbsentNameCards.push(Record);
  }

  const List = Connected.concat(AbsentDevices).concat(AbsentNameCards);
  const Warnings: string[] = [];
  if (Trusted) {
    for (const Entry of List) {
      for (const Issue of Entry.Issues) {
        const Warning = USB_WARNINGS[Issue.Kind];
        if (!Warnings.includes(Warning)) Warnings.push(Warning);
      }
    }
    // A partly connected group's shortfall is on its connected cards above.
    if (ShortNames.length && !Warnings.includes(USB_WARNINGS.missing)) {
      Warnings.push(USB_WARNINGS.missing);
    }
  }
  return {
    List,
    MissingDevices: AbsentDevices.filter((Entry) => Entry.Missing),
    MissingNames: ShortNames,
    Warnings,
    Capabilities: Trusted ? usbCapabilities(Reported) : null,
  };
}

// --- Mark requests ----------------------------------------------------------------

/** Options a mark/update request may carry; absent ones keep their current value. */
export interface CriticalUSBOptions {
  RequirePresent?: boolean;
  CheckLocation?: boolean;
  CheckFirmware?: boolean;
  RequireNoError?: boolean;
}

/**
 * Work out the conditions a mark/update request produces, for one device (by
 * serial: `Live` is it, or empty) or a group (by name: `Live` is every connected
 * device of the name).
 *
 * A FIRST mark guards presence, and no device error (judged only where the
 * client reports it). Ticking the port or firmware guards what the device has at
 * that moment — for a group, the ports all of them occupy, and the one firmware
 * they all report; a guarded value keeps its baseline, so editing one condition
 * never quietly accepts a change to another. A disconnected device can have
 * conditions cleared, but not new ones captured.
 */
export function resolveUSBConditions(
  Options: CriticalUSBOptions,
  Live: USBDevice[],
  Existing: CriticalUSBConditions | null
): [string | null, CriticalUSBConditions | null] {
  const Has = (Key: keyof CriticalUSBOptions) =>
    Object.prototype.hasOwnProperty.call(Options, Key) && Options[Key] !== undefined;
  const Flag = (Key: 'RequirePresent' | 'RequireNoError') =>
    Has(Key) ? !!Options[Key] : Existing ? Existing[Key] : true;
  const Wants = (Key: 'CheckLocation' | 'CheckFirmware', Guarded: boolean) =>
    Has(Key) ? !!Options[Key] : Existing ? Guarded : false;
  const Group = Live.length > 1;

  let Location: string | null = null;
  if (Wants('CheckLocation', !!Existing?.Location)) {
    if (Existing?.Location) {
      Location = Existing.Location;
    } else {
      const Ports = Live.map((Device) => normalizeUSBLocation(Device.Location));
      if (!Live.length) return ['Connect the device to start monitoring its port', null];
      if (Ports.some((Port) => !Port)) {
        return [`${Group ? 'These devices do' : 'This device does'} not report a port`, null];
      }
      Location = LocationList(Ports.join(',')).join(',');
    }
  }

  let FirmwareVersion: string | null = null;
  if (Wants('CheckFirmware', !!Existing?.FirmwareVersion)) {
    if (Existing?.FirmwareVersion) {
      FirmwareVersion = Existing.FirmwareVersion;
    } else {
      const Versions = Live.map((Device) => normalizeFirmwareVersion(Device.FirmwareVersion));
      if (!Live.length) return ['Connect the device to start monitoring its firmware', null];
      if (Versions.some((Version) => !Version)) {
        return [
          `${Group ? 'These devices do' : 'This device does'} not report a firmware version`,
          null,
        ];
      }
      const Distinct = [...new Set(Versions)];
      if (Distinct.length > 1) {
        return [`These devices report different firmware (${Distinct.join(', ')})`, null];
      }
      FirmwareVersion = Distinct[0]!;
    }
  }

  return [
    null,
    {
      RequirePresent: Flag('RequirePresent'),
      Location,
      FirmwareVersion,
      RequireNoError: Flag('RequireNoError'),
    },
  ];
}
