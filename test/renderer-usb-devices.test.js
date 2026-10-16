const test = require('node:test');
const assert = require('node:assert/strict');

// The USB section of the client info modal. lib/usb-devices.ts holds the
// decisions (the card's subtitle and badge, the conditions table and what it
// can offer, turning the table back into a request) and is tested directly;
// client-info-usb.ts builds the markup as a pure string function.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/usb-devices.js');
const USB = require('../dist-test/UI/js/app/client-info-usb.js');

const WINDOWS = { Location: true, FirmwareVersion: true, DeviceState: true };
const MAC = { Location: true, FirmwareVersion: true, DeviceState: false };
const OLD = { Location: false, FirmwareVersion: false, DeviceState: false };

function conditions(overrides = {}) {
  return {
    SerialNumber: 'CL12345',
    ManufacturerName: 'Elgato',
    ProductName: 'Stream Deck',
    RequirePresent: true,
    Location: null,
    FirmwareVersion: null,
    RequireNoError: true,
    Timestamp: 1,
    ...overrides,
  };
}

function view(overrides = {}) {
  return {
    VendorID: 1,
    ProductID: 2,
    ManufacturerName: 'Elgato',
    ProductName: 'Stream Deck',
    SerialNumber: 'CL12345',
    Location: '1-2.4',
    FirmwareVersion: '1.23',
    DeviceState: { ErrorCode: 0, Message: null },
    IsConnected: true,
    IsCritical: false,
    Missing: false,
    Mismatch: false,
    Issues: [],
    Critical: null,
    ...overrides,
  };
}

function legacyView(overrides = {}) {
  const {
    Location: _Location,
    FirmwareVersion: _Firmware,
    DeviceState: _State,
    ...rest
  } = view(overrides);
  return rest;
}

const byField = (rows) => Object.fromEntries(rows.map((Row) => [Row.Field, Row]));

function client(overrides = {}) {
  return {
    UUID: 'c1',
    Online: true,
    USBDeviceList: [view()],
    USBCapabilities: WINDOWS,
    ...overrides,
  };
}

test('a Windows port reads under its controller address', () => {
  assert.equal(Lib.DescribeLocation('PCI0:14.0-3.1'), 'Bus PCI0:14.0 · Port 3.1');
  assert.equal(
    Lib.DescribeLocation('PCI0:14.0-3.1,1-2'),
    'Bus PCI0:14.0 · Port 3.1, Bus 1 · Port 2'
  );
  assert.equal(Lib.DescribeLocation('PCI 0-1'), null);
});

test('the subtitle reads serial, port and firmware', () => {
  assert.equal(Lib.USBDeviceSummary(view()), 'CL12345 · Bus 1 · Port 2.4 · Firmware 1.23');
  assert.equal(Lib.USBDeviceSummary(legacyView()), 'CL12345');
  assert.equal(
    Lib.USBDeviceSummary(view({ IsConnected: false, Missing: true })),
    'CL12345 · Not connected'
  );
  assert.equal(
    Lib.USBDeviceSummary(
      view({ SerialNumber: null, IsCriticalByName: true, Quantity: 2, ConnectedCount: 1 })
    ),
    '1 of 2 connected · Bus 1 · Port 2.4 · Firmware 1.23'
  );
});

test('badge states', () => {
  assert.equal(Lib.USBDeviceBadge(view()).State, 'plain');
  const crit = { IsCritical: true, Critical: conditions() };
  assert.equal(Lib.USBDeviceBadge(view(crit)).State, 'healthy');
  assert.equal(
    Lib.USBDeviceBadge(view({ ...crit, Issues: [{ Kind: 'firmware', Message: 'x' }] })).State,
    'issue'
  );
  assert.equal(
    Lib.USBDeviceBadge(view({ ...crit, Issues: [{ Kind: 'missing', Message: '1 of 2' }] })).State,
    'short'
  );
  assert.equal(
    Lib.USBDeviceBadge(view({ ...crit, IsConnected: false, Missing: true })).State,
    'missing'
  );
  assert.equal(Lib.USBDeviceBadge(view({ ...crit, IsConnected: false })).State, 'absent');
});

test('on Windows every condition can be held', () => {
  const rows = byField(
    Lib.USBConditionRows(
      view({ IsCritical: true, Critical: conditions({ Location: '1-2.4' }) }),
      WINDOWS
    )
  );
  assert.deepEqual(Object.keys(rows), [
    'RequirePresent',
    'CheckLocation',
    'CheckFirmware',
    'RequireNoError',
  ]);
  assert.equal(rows.CheckLocation.Value, 'Bus 1 · Port 2.4');
  assert.equal(rows.CheckLocation.Checked, true);
  assert.equal(rows.CheckFirmware.Value, '1.23');
  assert.equal(rows.CheckFirmware.Checked, false);
  assert.equal(rows.RequireNoError.Value, 'None');
  assert.equal(rows.RequireNoError.Checked, true);
  // Connected is the point of monitoring a device: always ticked, never editable.
  assert.equal(rows.RequirePresent.Checked, true);
  assert.equal(rows.RequirePresent.Locked, true);
  assert.equal(rows.CheckLocation.Locked, false);
});

test('the connected tick renders ticked and disabled, even for an old opted-out row', () => {
  const rows = byField(
    Lib.USBConditionRows(
      view({ IsCritical: true, Critical: conditions({ RequirePresent: false }) }),
      MAC
    )
  );
  assert.equal(rows.RequirePresent.Checked, true);
  assert.equal(rows.RequirePresent.Locked, true);
  const html = USB.BuildUSBSectionHtml(
    client({
      USBCapabilities: MAC,
      USBDeviceList: [view({ IsCritical: true, Critical: conditions() })],
    }),
    'ok'
  );
  assert.match(html, /data-rule="RequirePresent"\s+checked disabled/);
  assert.doesNotMatch(html, /data-rule="CheckLocation"[^>]*disabled/);
});

test('off Windows the device error reads Unsupported, even though it is on by default', () => {
  const rows = byField(
    Lib.USBConditionRows(view({ IsCritical: true, Critical: conditions() }), MAC)
  );
  assert.equal(rows.RequireNoError.Supported, false);
  assert.equal(rows.RequireNoError.Value, 'Unsupported');
  assert.equal(rows.RequireNoError.Checked, false);
  assert.equal(rows.CheckLocation.Supported, true);
});

test('an older client can only be held to presence', () => {
  const rows = byField(
    Lib.USBConditionRows(legacyView({ IsCritical: true, Critical: conditions() }), OLD)
  );
  assert.equal(rows.RequirePresent.Supported, true);
  for (const field of ['CheckLocation', 'CheckFirmware', 'RequireNoError']) {
    assert.equal(rows[field].Value, 'Unsupported', field);
  }
});

test('a disconnected device can only clear what it guards', () => {
  const rows = byField(
    Lib.USBConditionRows(
      view({
        IsConnected: false,
        Missing: true,
        IsCritical: true,
        Critical: conditions({ FirmwareVersion: '1.23' }),
      }),
      WINDOWS
    )
  );
  assert.equal(rows.CheckFirmware.Supported, true);
  assert.equal(rows.CheckFirmware.Value, '1.23');
  assert.equal(rows.CheckLocation.Supported, false);
  assert.equal(rows.RequirePresent.Value, 'No');
});

test('a group shows its count and its ports', () => {
  const rows = byField(
    Lib.USBConditionRows(
      view({
        SerialNumber: null,
        IsCritical: true,
        IsCriticalByName: true,
        Quantity: 2,
        ConnectedCount: 2,
        Critical: conditions({ Location: '1-2,1-3' }),
      }),
      WINDOWS
    )
  );
  assert.equal(rows.RequirePresent.Value, '2 of 2');
  assert.equal(rows.CheckLocation.Label, 'Ports');
  assert.equal(rows.CheckLocation.Value, 'Bus 1 · Port 2, Bus 1 · Port 3');
});

test('the form sends the device-error tick only when it was offered, and never presence', () => {
  assert.deepEqual(
    Lib.ParseUSBRuleFields({ RequirePresent: false, CheckLocation: true, CheckFirmware: false }),
    { CheckLocation: true, CheckFirmware: false }
  );
  assert.equal(Lib.ParseUSBRuleFields({ RequireNoError: false }).RequireNoError, false);
});

test('timeline live state, for one device and for a group', () => {
  const crit = view({ IsCritical: true, Critical: conditions() });
  assert.deepEqual(Lib.USBTimelineLiveState([crit], false), { State: 'IDLE', Label: 'Idle' });
  assert.deepEqual(Lib.USBTimelineLiveState([crit], true), { State: 'ONLINE', Label: 'Connected' });
  assert.deepEqual(
    Lib.USBTimelineLiveState([{ ...crit, Issues: [{ Kind: 'location', Message: 'moved' }] }], true),
    { State: 'DEGRADED', Label: 'moved' }
  );
  const short = { ...crit, Issues: [{ Kind: 'missing', Message: '1 of 2 connected' }] };
  assert.equal(Lib.USBTimelineLiveState([crit, short], true).State, 'OFFLINE');
  assert.equal(Lib.USBTimelineLiveState([{ ...crit, IsConnected: false }], true).State, 'IDLE');
});

test('the render key moves with ticks and readings, not with nothing', () => {
  const base = client({ USBDeviceList: [view({ IsCritical: true, Critical: conditions() })] });
  const key = Lib.USBRenderKey(base, 'ok');
  assert.equal(Lib.USBRenderKey(base, 'ok'), key);
  const moved = client({
    USBDeviceList: [view({ Location: '1-3', IsCritical: true, Critical: conditions() })],
  });
  assert.notEqual(Lib.USBRenderKey(moved, 'ok'), key);
  const ticked = client({
    USBDeviceList: [view({ IsCritical: true, Critical: conditions({ FirmwareVersion: '1.23' }) })],
  });
  assert.notEqual(Lib.USBRenderKey(ticked, 'ok'), key);
});

// --- client-info-usb.ts: markup ---------------------------------------------------

test('a plain card is styled like the other device cards, with no table', () => {
  const html = USB.BuildUSBSectionHtml(client(), 'ok');
  assert.match(html, /SHOWTRAK_AUDIO_CARD SHOWTRAK_USB_CARD/);
  assert.match(html, /SHOWTRAK_TOGGLE_CRITICAL_USB_DEVICE/);
  assert.match(html, /data-mode="serial" data-serial="CL12345"/);
  assert.doesNotMatch(html, /SHOWTRAK_USB_CONDITIONS/);
});

test('a critical card carries its conditions table, with Unsupported rows untickable', () => {
  const html = USB.BuildUSBSectionHtml(
    client({
      USBCapabilities: MAC,
      USBDeviceList: [view({ IsCritical: true, Critical: conditions({ Location: '1-2.4' }) })],
    }),
    'ok'
  );
  assert.match(html, /SHOWTRAK_AUDIO_CONDITIONS SHOWTRAK_USB_CONDITIONS/);
  assert.match(html, /data-rule="CheckLocation"\s+checked/);
  assert.match(html, /<tr data-cond="RequireNoError" class="is-unsupported/);
  assert.doesNotMatch(html, /data-rule="RequireNoError"/);
});

test('a device error is shown on any card; a name-guarded one keeps its warning', () => {
  const html = USB.BuildUSBSectionHtml(
    client({
      USBDeviceList: [
        view({ DeviceState: { ErrorCode: 10, Message: 'This device cannot start' } }),
        view({
          SerialNumber: null,
          IsCritical: true,
          IsCriticalByName: true,
          Quantity: 2,
          ConnectedCount: 2,
          Critical: conditions(),
        }),
      ],
    }),
    'ok'
  );
  assert.match(html, /Device error: This device cannot start \(Code 10\)/);
  assert.match(html, /can only monitor this device by name \(expects 2\)/);
  assert.match(html, /data-mode="name"/);
});

test('messages: offline, none connected', () => {
  assert.match(USB.BuildUSBSectionHtml(client({ Online: false }), 'offline'), /Client Offline/);
  assert.match(
    USB.BuildUSBSectionHtml(client({ USBDeviceList: [] }), 'ok'),
    /No USB Devices Connected/
  );
});
