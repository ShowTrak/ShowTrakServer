// USB section of the client info modal — the decisions, without the DOM.
//
// What the section shows, the badge each device's critical toggle wears, the
// conditions a critical device can be held to, and turning the conditions table
// back into a request. Mirrors lib/displays and lib/audio-devices.
//
// What a device supports is read from what the client reported, never from a
// version table: a client before 3.22.0 sends no port, firmware or device state
// at all, so those rows read Unsupported until it is updated.
import type {
  ClientView,
  CriticalUSBConditions,
  USBCapabilities,
  USBDeviceView,
} from '@showtrak/protocol';

/**
 * Which overall message the section shows:
 *  - `offline`: nothing live to show beyond the critical baselines;
 *  - `ok`: render the devices.
 */
export type USBSectionState = 'offline' | 'ok';

export function GetUSBSectionState(Client: ClientView): USBSectionState {
  return Client.Online ? 'ok' : 'offline';
}

/** The devices the section lists: offline, only the critical ones' baselines. */
export function VisibleUSBDevices(Client: ClientView, State: USBSectionState): USBDeviceView[] {
  const List = Array.isArray(Client.USBDeviceList) ? Client.USBDeviceList : [];
  return State === 'offline' ? List.filter((Device) => Device.IsCritical) : List;
}

/** "Generic USB Device" when a name is missing, as the client tile reads it. */
export function USBDeviceTitle(Device: USBDeviceView): string {
  return `${Device.ManufacturerName || 'Generic'} ${Device.ProductName || 'USB Device'}`;
}

/** How a device is guarded: by its serial when it has one, else by its name. */
export function USBGuardMode(Device: USBDeviceView): 'serial' | 'name' {
  return typeof Device.SerialNumber === 'string' && Device.SerialNumber.trim() ? 'serial' : 'name';
}

/** "Bus 1 · Port 2.4"; several ports, comma-separated. Null when there is none. */
export function DescribeLocation(Location: unknown): string | null {
  if (typeof Location !== 'string' || !Location.trim()) return null;
  const Parts = Location.split(',')
    .map((One) => One.trim())
    .filter((One) => /^\d+-[\d.]+$/.test(One))
    .map((One) => {
      const [Bus, Path] = One.split('-');
      return `Bus ${Bus} · Port ${Path}`;
    });
  return Parts.length ? Parts.join(', ') : null;
}

function Text(Value: unknown): string | null {
  return typeof Value === 'string' && Value.trim() ? Value.trim() : null;
}

/** "Device error: This device cannot start (Code 10)" — null when it is working or unknown. */
export function USBDeviceError(Device: USBDeviceView): string | null {
  const State = Device.DeviceState;
  if (!State || !State.ErrorCode) return null;
  return State.Message
    ? `Device error: ${State.Message} (Code ${State.ErrorCode})`
    : `Device error (Code ${State.ErrorCode})`;
}

/**
 * The card's subtitle: the serial (or, guarded by name, how many are connected
 * of how many expected), then the port and firmware when the client reports them.
 */
export function USBDeviceSummary(Device: USBDeviceView): string {
  const Parts: string[] = [];
  if (USBGuardMode(Device) === 'serial') Parts.push(String(Device.SerialNumber).trim());
  else if (Device.IsCriticalByName && typeof Device.Quantity === 'number') {
    Parts.push(`${Device.ConnectedCount ?? 0} of ${Device.Quantity} connected`);
  } else Parts.push('No serial number');
  if (Device.IsConnected === false) {
    // By name, "0 of 2 connected" already says it.
    if (USBGuardMode(Device) === 'serial') Parts.push('Not connected');
    return Parts.join(' · ');
  }
  const Location = DescribeLocation(Device.Location);
  if (Location) Parts.push(Location);
  const Firmware = Text(Device.FirmwareVersion);
  if (Firmware) Parts.push(`Firmware ${Firmware}`);
  return Parts.join(' · ');
}

export type USBDeviceState = 'healthy' | 'issue' | 'short' | 'missing' | 'absent' | 'plain';

/** The badge the critical toggle shows, and what clicking it will do. */
export function USBDeviceBadge(Device: USBDeviceView): {
  State: USBDeviceState;
  Label: string;
  Icon: string;
  Title: string;
} {
  if (!Device.IsCritical) {
    return {
      State: 'plain',
      Label: 'Monitor',
      Icon: 'bi-check-circle',
      Title: 'Monitor this USB device',
    };
  }
  if (Device.IsConnected === false) {
    if (Device.Missing) {
      return {
        State: 'missing',
        Label: 'Missing',
        Icon: 'bi-x-circle-fill',
        Title: 'Stop monitoring (device disconnected)',
      };
    }
    return {
      State: 'absent',
      Label: 'Monitored',
      Icon: 'bi-question-circle',
      Title: 'Stop monitoring (not connected)',
    };
  }
  const Issues = Device.Issues || [];
  if (Issues.some((Issue) => Issue.Kind === 'missing')) {
    return {
      State: 'short',
      Label: 'Short',
      Icon: 'bi-x-circle-fill',
      Title: 'Stop monitoring (fewer connected than expected)',
    };
  }
  if (Issues.length) {
    return {
      State: 'issue',
      Label: 'Changed',
      Icon: 'bi-exclamation-triangle-fill',
      Title: 'Stop monitoring (conditions not met)',
    };
  }
  return {
    State: 'healthy',
    Label: 'Monitored',
    Icon: 'bi-check-circle-fill',
    Title: 'Stop monitoring',
  };
}

/** A condition a critical device can be held to, as its form field is named. */
export type USBConditionField =
  'RequirePresent' | 'CheckLocation' | 'CheckFirmware' | 'RequireNoError';

export const USB_CONDITION_FIELDS: USBConditionField[] = [
  'RequirePresent',
  'CheckLocation',
  'CheckFirmware',
  'RequireNoError',
];

/** One row of a critical device's conditions table. */
export interface USBConditionRow {
  Field: USBConditionField;
  /** Key-style label, e.g. "Firmware version". */
  Label: string;
  /** What is guarded when monitored, else what the device reports now; "—" when neither is known. */
  Value: string;
  /** Whether this device can be held to it. */
  Supported: boolean;
  /** Whether the condition is being monitored. */
  Checked: boolean;
  /** The issue this condition currently raises, when it is not met. */
  Failing: string | null;
}

/**
 * The conditions table of a critical device, one row per condition. A port or
 * firmware already guarded can always be cleared; a new one can only be
 * captured from a connected device that reports it.
 *
 * The device-error row is the exception: no device error is required by default
 * on every entry (so a Windows device that fails keeps faulting, as it did when
 * it simply vanished), so its tick says nothing on a client that cannot read the
 * state. It is shown only where the client reports it, and reads Unsupported
 * everywhere else.
 */
export function USBConditionRows(
  Device: USBDeviceView,
  Capabilities: USBCapabilities | null
): USBConditionRow[] {
  const Critical: CriticalUSBConditions | null | undefined = Device.Critical;
  if (!Device.IsCritical || !Critical) return [];
  const Connected = Device.IsConnected !== false;
  const Issue = (Kind: string) =>
    (Device.Issues || []).find((Candidate) => Candidate.Kind === Kind)?.Message ?? null;
  const Row = (
    Field: USBConditionField,
    Label: string,
    Guarded: string | null,
    Live: string | null,
    Checked: boolean,
    Failing: string | null,
    Supported: boolean
  ): USBConditionRow => ({
    Field,
    Label,
    Value: !Supported ? 'Unsupported' : ((Checked ? Guarded : null) ?? Live ?? '—'),
    Supported,
    Checked,
    Failing,
  });
  const ByName = !!Device.IsCriticalByName && typeof Device.Quantity === 'number';
  const LiveLocation = Connected ? DescribeLocation(Device.Location) : null;
  const LiveFirmware = Connected ? Text(Device.FirmwareVersion) : null;
  const StateKnown = Capabilities ? Capabilities.DeviceState : false;
  const Error = USBDeviceError(Device);
  return [
    Row(
      'RequirePresent',
      'Connected',
      null,
      ByName ? `${Device.ConnectedCount ?? 0} of ${Device.Quantity}` : Connected ? 'Yes' : 'No',
      Critical.RequirePresent,
      Issue('missing'),
      true
    ),
    Row(
      'CheckLocation',
      ByName ? 'Ports' : 'Port',
      DescribeLocation(Critical.Location),
      LiveLocation,
      Critical.Location !== null,
      Issue('location'),
      Critical.Location !== null || LiveLocation !== null
    ),
    Row(
      'CheckFirmware',
      'Firmware version',
      Critical.FirmwareVersion,
      LiveFirmware,
      Critical.FirmwareVersion !== null,
      Issue('firmware'),
      Critical.FirmwareVersion !== null || LiveFirmware !== null
    ),
    Row(
      'RequireNoError',
      'Device error',
      null,
      Connected && Device.DeviceState
        ? Error
          ? `Code ${Device.DeviceState.ErrorCode}`
          : 'None'
        : null,
      StateKnown && Critical.RequireNoError,
      Issue('device_error'),
      StateKnown
    ),
  ];
}

/** Rebuild the list only when something it shows changes. */
export function USBRenderKey(Client: ClientView, State: USBSectionState): string {
  const Capabilities = Client.USBCapabilities ?? null;
  const Devices = VisibleUSBDevices(Client, State).map((Device) =>
    [
      USBGuardMode(Device),
      Device.SerialNumber || Device.NameKey || '',
      USBDeviceTitle(Device),
      USBDeviceSummary(Device),
      USBDeviceBadge(Device).State,
      USBDeviceError(Device) ?? '',
      (Device.Issues || []).map((Issue) => Issue.Message).join(','),
      USBConditionRows(Device, Capabilities)
        .map((Row) => `${Row.Field}:${Row.Supported ? 1 : 0}${Row.Checked ? 1 : 0}:${Row.Value}`)
        .join(','),
    ].join('|')
  );
  return `${Client.UUID}::${State}::${Devices.join(';;')}`;
}

/** The ticks of a critical device's conditions form, as read from the DOM. */
export type USBRuleFields = Record<USBConditionField, boolean>;

/**
 * Turn the conditions form into a request. The device-error tick is only sent
 * when its row could be ticked, so saving from a client that cannot read device
 * state leaves the stored default alone.
 */
export function ParseUSBRuleFields(
  Fields: Partial<USBRuleFields>
): Partial<Record<USBConditionField, boolean>> {
  const Out: Partial<Record<USBConditionField, boolean>> = {
    RequirePresent: !!Fields.RequirePresent,
    CheckLocation: !!Fields.CheckLocation,
    CheckFirmware: !!Fields.CheckFirmware,
  };
  if (Fields.RequireNoError !== undefined) Out.RequireNoError = !!Fields.RequireNoError;
  return Out;
}

/**
 * The live state of a critical device's history row — or, guarded by name, of
 * the group (every card of the name): green while connected and meeting its
 * conditions, orange while connected but not, red while missing or short. Idle
 * while the client is offline, or while a device allowed to be absent is.
 */
export function USBTimelineLiveState(
  Devices: USBDeviceView[],
  Online: boolean
): { State: 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE'; Label: string } {
  if (!Online) return { State: 'IDLE', Label: 'Idle' };
  const Issues = Devices.flatMap((Device) => Device.Issues || []);
  if (
    Devices.some((Device) => Device.Missing) ||
    Issues.some((Issue) => Issue.Kind === 'missing')
  ) {
    return { State: 'OFFLINE', Label: 'Disconnected' };
  }
  if (!Devices.some((Device) => Device.IsConnected !== false)) {
    return { State: 'IDLE', Label: 'Not Connected' };
  }
  if (Issues.length) {
    return {
      State: 'DEGRADED',
      Label: [...new Set(Issues.map((Issue) => Issue.Message))].join('; '),
    };
  }
  return { State: 'ONLINE', Label: 'Connected' };
}
