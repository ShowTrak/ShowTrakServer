const test = require('node:test');
const assert = require('node:assert/strict');

// Critical USB devices, the pure half (ClientManager/usb.ts): reading the
// optional fields a client reports, judging a device (by serial) or a group (by
// name) against its conditions, the list the renderer draws, and the conditions
// a mark request makes. Clients before 3.27.0 send none of the new fields, so
// much of this is about what happens when they are missing.

const USB = require('../dist/Modules/ClientManager/usb');
const { Manager: SocketValidation } = require('../dist/Modules/SocketValidation/index');
const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');

function device(overrides = {}) {
  return {
    VendorID: 0x0fd9,
    ProductID: 0x0080,
    ManufacturerName: 'Elgato',
    ProductName: 'Stream Deck',
    SerialNumber: 'CL12345',
    Location: '1-2.4',
    FirmwareVersion: '1.23',
    DeviceState: { ErrorCode: 0, Message: null },
    ...overrides,
  };
}

// A device as a client before 3.27.0 reports it.
function legacy(overrides = {}) {
  const {
    Location: _Location,
    FirmwareVersion: _Firmware,
    DeviceState: _State,
    ...rest
  } = device(overrides);
  return rest;
}

function critical(overrides = {}) {
  return USB.normalizeCriticalUSBEntry({
    SerialNumber: 'CL12345',
    ManufacturerName: 'Elgato',
    ProductName: 'Stream Deck',
    Timestamp: 1,
    ...overrides,
  });
}

function named(overrides = {}) {
  return USB.normalizeCriticalUSBNameEntry({
    ManufacturerName: 'Acme',
    ProductName: 'Dongle',
    Quantity: 2,
    Timestamp: 1,
    ...overrides,
  });
}

// --- Entries ----------------------------------------------------------------------

test('a row written before conditions existed reads as the old guard, plus no device error', () => {
  assert.deepEqual(critical(), {
    SerialNumber: 'CL12345',
    ManufacturerName: 'Elgato',
    ProductName: 'Stream Deck',
    RequirePresent: true,
    Location: null,
    FirmwareVersion: null,
    RequireNoError: true,
    Timestamp: 1,
  });
  const entry = named({ RequirePresent: 0, RequireNoError: 0, Location: '1-3, 1-2,junk' });
  assert.equal(entry.NameKey, 'acme dongle');
  // A row saved while presence could still be unticked is required again.
  assert.equal(entry.RequirePresent, true);
  assert.equal(entry.RequireNoError, false);
  assert.equal(entry.Location, '1-2,1-3');
});

test('reported values are read loosely, and junk is unknown rather than an error', () => {
  assert.equal(USB.normalizeUSBLocation(' 1-2.4 '), '1-2.4');
  assert.equal(USB.normalizeUSBLocation('Port_#0004.Hub_#0001'), null);
  assert.equal(USB.normalizeFirmwareVersion(''), null);
  assert.deepEqual(USB.normalizeDeviceState({ ErrorCode: 43, Message: 'Stopped' }), {
    ErrorCode: 43,
    Message: 'Stopped',
  });
  assert.equal(USB.normalizeDeviceState({ ErrorCode: 'x' }), null);
  assert.equal(USB.DescribeUSBLocation('1-2.4,2-1'), 'Bus 1 · Port 2.4, Bus 2 · Port 1');
});

test('a Windows bus is a controller address, and stays one part of a stored list', () => {
  assert.equal(USB.normalizeUSBLocation('PCI0:14.0-3.1'), 'PCI0:14.0-3.1');
  assert.equal(USB.normalizeUSBLocation('PCI0:02.1/00.0/r1-2'), 'PCI0:02.1/00.0/r1-2');
  assert.equal(
    USB.normalizeUSBLocation('ACPI(_SB_)#ACPI(URS0)#USBROOT(0)-1'),
    'ACPI(_SB_)#ACPI(URS0)#USBROOT(0)-1'
  );
  // No port path, or a bus that could hide a separator, is not a location.
  assert.equal(USB.normalizeUSBLocation('PCI0:14.0'), null);
  assert.equal(USB.normalizeUSBLocation('PCI 0-1'), null);
  assert.deepEqual(USB.LocationList('PCI0:14.0-3.1,1-2'), ['1-2', 'PCI0:14.0-3.1']);
  assert.equal(USB.DescribeUSBLocation('PCI0:14.0-3.1'), 'Bus PCI0:14.0 · Port 3.1');
});

// --- Capabilities -----------------------------------------------------------------

test('capabilities come from which keys the client sends, not their values', () => {
  assert.deepEqual(USB.usbCapabilities([legacy()]), {
    Location: false,
    FirmwareVersion: false,
    DeviceState: false,
  });
  assert.deepEqual(USB.usbCapabilities([device({ Location: null, DeviceState: null })]), {
    Location: true,
    FirmwareVersion: true,
    DeviceState: true,
  });
  // A Mac or Linux client: port and firmware, no device state.
  const { DeviceState: _State, ...mac } = device();
  assert.equal(USB.usbCapabilities([mac]).DeviceState, false);
  assert.equal(USB.usbCapabilities(null), null);
});

// --- Judging ----------------------------------------------------------------------

test('each guarded condition raises its own issue', () => {
  const entry = critical({ Location: '1-2.4', FirmwareVersion: '1.23' });
  assert.deepEqual(USB.evaluateUSBIssues(device(), entry), []);
  const moved = device({
    Location: '1-3',
    FirmwareVersion: '2.00',
    DeviceState: { ErrorCode: 43, Message: 'Windows has stopped this device' },
  });
  assert.deepEqual(
    USB.evaluateUSBIssues(moved, entry).map((Issue) => Issue.Message),
    [
      'Plugged into Bus 1 · Port 3 (expected Bus 1 · Port 2.4)',
      'Firmware is 2.00 (expected 1.23)',
      'Device error: Windows has stopped this device (Code 43)',
    ]
  );
  assert.deepEqual(
    USB.evaluateUSBIssues(moved, critical({ RequireNoError: false })).map((Issue) => Issue.Kind),
    []
  );
});

test('an older client is judged on presence alone, whatever is guarded', () => {
  const entry = critical({ Location: '1-2.4', FirmwareVersion: '1.23' });
  assert.deepEqual(USB.evaluateUSBIssues(legacy(), entry), []);
  assert.deepEqual(USB.evaluateUSBIssues(device({ Location: null, DeviceState: null }), entry), []);
  assert.equal(USB.evaluateUSBIssues(null, entry)[0].Kind, 'missing');
});

test('absence always faults: a monitored device cannot opt out of being connected', () => {
  assert.equal(USB.evaluateUSBIssues(null, critical({ RequirePresent: false }))[0].Kind, 'missing');
  assert.deepEqual(USB.evaluateUSBNameShortfall(1, named()), [
    { Kind: 'missing', Message: '1 of 2 connected' },
  ]);
  assert.deepEqual(USB.evaluateUSBNameShortfall(1, named({ RequirePresent: false })), [
    { Kind: 'missing', Message: '1 of 2 connected' },
  ]);
});

// --- View -------------------------------------------------------------------------

test('the view keeps every field the renderer and older consumers read', () => {
  const entry = critical({ FirmwareVersion: '1.00' });
  const result = USB.buildUSBView([device()], [entry], [], true);
  const [card] = result.List;
  assert.equal(card.IsCritical, true);
  assert.equal(card.IsConnected, true);
  assert.equal(card.Missing, false);
  assert.equal(card.Mismatch, true);
  assert.equal(card.Critical, entry);
  assert.equal(card.Location, '1-2.4');
  assert.deepEqual(result.Warnings, ['USB Firmware Changed']);
  assert.deepEqual(result.Capabilities, {
    Location: true,
    FirmwareVersion: true,
    DeviceState: true,
  });
});

test('missing devices and short groups still drive the old Missing lists', () => {
  const absent = critical({ SerialNumber: 'GONE' });
  // Saved while presence could be unticked: it is missing like any other.
  const optedOut = critical({ SerialNumber: 'AWAY', RequirePresent: false });
  const group = named();
  const dongle = legacy({ SerialNumber: null, ManufacturerName: 'Acme', ProductName: 'Dongle' });
  const result = USB.buildUSBView([dongle], [absent, optedOut], [group], true);
  assert.deepEqual(
    result.MissingDevices.map((Entry) => Entry.SerialNumber),
    ['GONE', 'AWAY']
  );
  assert.equal(result.MissingNames.length, 1);
  const optedOutCard = result.List.find((Entry) => Entry.SerialNumber === 'AWAY');
  assert.equal(optedOutCard.Missing, true);
  assert.equal(optedOutCard.IsConnected, false);
  const dongleCard = result.List.find((Entry) => Entry.NameKey === 'acme dongle');
  assert.equal(dongleCard.Shortfall, true);
  assert.equal(dongleCard.ConnectedCount, 1);
  assert.equal(dongleCard.Issues[0].Message, '1 of 2 connected');
  assert.deepEqual(result.Warnings, ['Missing USB Device']);
});

test('a group guarding its ports faults when one of its devices moves', () => {
  const group = named({ Location: '1-2,1-3' });
  const dongle = (Location) =>
    device({ SerialNumber: null, ManufacturerName: 'Acme', ProductName: 'Dongle', Location });
  let result = USB.buildUSBView([dongle('1-3'), dongle('1-2')], [], [group], true);
  assert.deepEqual(result.Warnings, []);
  result = USB.buildUSBView([dongle('1-3'), dongle('1-4')], [], [group], true);
  assert.deepEqual(result.Warnings, ['USB Device Moved']);
  assert.match(result.List[1].Issues[0].Message, /Plugged into Bus 1 · Port 4/);
});

test('nothing is judged before the client has reported on this connection', () => {
  const result = USB.buildUSBView([], [critical()], [], false);
  assert.deepEqual(result.List[0].Issues, []);
  assert.deepEqual(result.Warnings, []);
  assert.equal(result.Capabilities, null);
});

// --- Mark requests ----------------------------------------------------------------

test('a first mark guards presence and no device error; port and firmware are opt-in', () => {
  assert.deepEqual(USB.resolveUSBConditions({}, [device()], null), [
    null,
    { RequirePresent: true, Location: null, FirmwareVersion: null, RequireNoError: true },
  ]);
  const [, ticked] = USB.resolveUSBConditions(
    { CheckLocation: true, CheckFirmware: true },
    [device()],
    null
  );
  assert.equal(ticked.Location, '1-2.4');
  assert.equal(ticked.FirmwareVersion, '1.23');
});

test('a guarded value keeps its baseline while other conditions change', () => {
  const existing = critical({ Location: '1-2.4', FirmwareVersion: '1.23' });
  const [, entry] = USB.resolveUSBConditions(
    { RequirePresent: false },
    [device({ Location: '9-9', FirmwareVersion: '9.99' })],
    existing
  );
  assert.equal(entry.Location, '1-2.4');
  assert.equal(entry.FirmwareVersion, '1.23');
  // Presence cannot be turned off, even when a request asks.
  assert.equal(entry.RequirePresent, true);
  // Omitted ticks keep what is stored — including the device-error default a
  // client that cannot read device state never shows.
  assert.equal(entry.RequireNoError, true);
});

test('what cannot be captured is refused with a reason', () => {
  assert.match(
    USB.resolveUSBConditions({ CheckLocation: true }, [legacy()], null)[0],
    /does not report a port/
  );
  assert.match(
    USB.resolveUSBConditions({ CheckFirmware: true }, [], critical())[0],
    /Connect the device/
  );
  const a = device({ SerialNumber: null, FirmwareVersion: '1.0' });
  const b = device({ SerialNumber: null, FirmwareVersion: '1.1' });
  assert.match(
    USB.resolveUSBConditions({ CheckFirmware: true }, [a, b], null)[0],
    /different firmware \(1\.0, 1\.1\)/
  );
  const [, ports] = USB.resolveUSBConditions(
    { CheckLocation: true },
    [device({ Location: '1-3' }), device({ Location: '1-2' })],
    null
  );
  assert.equal(ports.Location, '1-2,1-3');
});

// --- Boundaries -------------------------------------------------------------------

test('the socket keeps an absent field absent and a junk one null', () => {
  const [old, now, junk] = SocketValidation.USBDeviceList([
    legacy(),
    device(),
    device({ Location: 7, FirmwareVersion: {}, DeviceState: 'broken' }),
  ]);
  assert.equal('Location' in old, false);
  assert.equal('DeviceState' in old, false);
  assert.equal(now.Location, '1-2.4');
  assert.deepEqual(now.DeviceState, { ErrorCode: 0, Message: null });
  assert.equal(junk.Location, null);
  assert.equal(junk.FirmwareVersion, null);
  assert.equal(junk.DeviceState, null);
});

test('mark payloads carry only the conditions that were sent', () => {
  assert.deepEqual(IPCValidation.CriticalUSBDevicePayload({ SerialNumber: 'abc' }), {
    SerialNumber: 'ABC',
    ManufacturerName: null,
    ProductName: null,
  });
  assert.deepEqual(
    IPCValidation.CriticalUSBNamePayload({ ProductName: 'Dongle', CheckLocation: true }),
    { CheckLocation: true, ManufacturerName: null, ProductName: 'Dongle' }
  );
  // A generic device with no manufacturer string: the renderer sends the key
  // with an undefined value, which Electron IPC preserves.
  assert.deepEqual(
    IPCValidation.CriticalUSBNamePayload({ ManufacturerName: undefined, ProductName: 'Dongle' }),
    { ManufacturerName: null, ProductName: 'Dongle' }
  );
  assert.deepEqual(
    IPCValidation.CriticalUSBNamePayload({ ManufacturerName: null, ProductName: 'Dongle' }),
    { ManufacturerName: null, ProductName: 'Dongle' }
  );
  assert.deepEqual(
    IPCValidation.CriticalUSBNamePayload({ ManufacturerName: '  ', ProductName: 'Dongle' }),
    { ManufacturerName: null, ProductName: 'Dongle' }
  );
  assert.throws(
    () => IPCValidation.CriticalUSBNamePayload({ ManufacturerName: 7, ProductName: 'Dongle' }),
    /ManufacturerName must be a string/
  );
  assert.throws(
    () => IPCValidation.CriticalUSBDevicePayload({ SerialNumber: 'A', RequireNoError: 1 }),
    /RequireNoError must be true or false/
  );
});
