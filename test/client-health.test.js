const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The pure half of client health (Modules/ClientManager/health.ts): the
// sustained-alarm state machine, reboot detection from uptime, power and
// temperature normalization, and the display / network / USB transitions behind
// the finer-grained alert triggers. Every function here is a function of its
// arguments, so it is tested directly. What a monitored system check judges is
// covered by system-checks.test.js.

const Health = require(path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'health.js'));

// --- Threshold alarms -----------------------------------------------------------

function track() {
  return Health.EmptyResourceAlarmState().cpu;
}

test('a breach must last the sustain window before the alarm is raised', () => {
  const T = track();
  assert.equal(Health.StepResourceAlarm(T, 'cpu', true, 95, 90, 60000, 0), null);
  assert.equal(Health.StepResourceAlarm(T, 'cpu', true, 96, 90, 60000, 59999), null);
  assert.equal(Health.StepResourceAlarm(T, 'cpu', true, 97, 90, 60000, 60000), 'raised');
  assert.deepEqual(T.Active, { Key: 'cpu', Value: 97, Threshold: 90, Since: 60000 });
});

test('a spike shorter than the sustain window never raises the alarm', () => {
  const T = track();
  Health.StepResourceAlarm(T, 'cpu', true, 99, 90, 60000, 0);
  Health.StepResourceAlarm(T, 'cpu', false, 20, 90, 60000, 30000);
  // The run restarts from scratch, so another 59s over does not add up.
  Health.StepResourceAlarm(T, 'cpu', true, 99, 90, 60000, 31000);
  assert.equal(Health.StepResourceAlarm(T, 'cpu', true, 99, 90, 60000, 90000), null);
  assert.equal(T.Active, null);
});

test('a raised alarm clears only after the same window back under, so it does not flap', () => {
  const T = track();
  Health.StepResourceAlarm(T, 'cpu', true, 95, 90, 1000, 0);
  assert.equal(Health.StepResourceAlarm(T, 'cpu', true, 95, 90, 1000, 1000), 'raised');
  assert.equal(Health.StepResourceAlarm(T, 'cpu', false, 50, 90, 1000, 1500), null);
  assert.equal(Health.StepResourceAlarm(T, 'cpu', true, 92, 90, 1000, 2000), null, 'back over');
  assert.equal(Health.StepResourceAlarm(T, 'cpu', false, 50, 90, 1000, 2500), null);
  assert.equal(Health.StepResourceAlarm(T, 'cpu', false, 50, 90, 1000, 3500), 'cleared');
  assert.equal(T.Active, null);
});

test('a standing alarm tracks the latest reading', () => {
  const T = track();
  Health.StepResourceAlarm(T, 'cpu', true, 95, 90, 0, 0);
  Health.StepResourceAlarm(T, 'cpu', true, 99, 90, 0, 10);
  assert.equal(T.Active.Value, 99);
  assert.equal(T.Active.Since, 0);
});

test('losing the reading (or turning the check off) stands the alarm down at once', () => {
  const T = track();
  Health.StepResourceAlarm(T, 'cpu', true, 95, 90, 0, 0);
  assert.equal(Health.StepResourceAlarm(T, 'cpu', null, null, null, 60000, 1), 'cleared');
  assert.equal(Health.StepResourceAlarm(T, 'cpu', null, null, null, 60000, 2), null);
});

test('a zero sustain raises and clears on the reading itself', () => {
  const T = track();
  assert.equal(Health.StepResourceAlarm(T, 'cpu', true, 91, 90, 0, 0), 'raised');
  assert.equal(Health.StepResourceAlarm(T, 'cpu', false, 80, 90, 0, 1), 'cleared');
});

// --- Readings -----------------------------------------------------------------------

test('usage percentages read from both the CPU number and the RAM string', () => {
  assert.equal(Health.PercentReading(42.5), 42.5);
  assert.equal(Health.PercentReading('87.25'), 87.25);
  assert.equal(Health.PercentReading('110'), 100);
  assert.equal(Health.PercentReading(''), null);
  assert.equal(Health.PercentReading(undefined), null);
});

test('uptime prefers raw seconds and falls back to the formatted string of older clients', () => {
  assert.equal(Health.UptimeSecondsOf({ Seconds: 3725.9, Formatted: '99:00:00' }), 3725);
  assert.equal(Health.UptimeSecondsOf({ Formatted: '01:02:05' }), 3725);
  assert.equal(Health.UptimeSecondsOf({ Formatted: '250:00:00' }), 900000);
  assert.equal(Health.UptimeSecondsOf({ Formatted: 'soon' }), null);
  assert.equal(Health.UptimeSecondsOf({}), null);
});

test('a reboot is uptime falling well below its last reading, never a small wobble', () => {
  assert.equal(Health.IsReboot(null, 30), false, 'first reading is a baseline');
  assert.equal(Health.IsReboot(86400, 30), true);
  assert.equal(Health.IsReboot(86400, 86430), false);
  assert.equal(Health.IsReboot(86400, 86400 - 30), false, 'a clock step is not a reboot');
});

// --- Power ---------------------------------------------------------------------------

test('a power report is normalized and bounded', () => {
  const Power = Health.normalizePowerStatus({
    SampledAt: 10,
    Status: { State: 'OK', Platform: 'win32', Backend: 'wmi', Message: ' ' },
    Battery: { Percent: 104.4, Charging: false, TimeRemainingMinutes: -5 },
    OnBattery: true,
    LastSuspendAt: 0,
    LastResumeAt: 200,
  });
  assert.deepEqual(Power, {
    SampledAt: 10,
    Status: { State: 'ok', Message: null, Platform: 'win32', Backend: 'wmi' },
    Battery: { Percent: 100, Charging: false, TimeRemainingMinutes: null },
    OnBattery: true,
    LastSuspendAt: null,
    LastResumeAt: 200,
  });
});

test('an unknown collector state reads as unknown, and a desktop has no battery', () => {
  const Power = Health.normalizePowerStatus({ Status: { State: 'weird' }, Battery: null });
  assert.equal(Power.Status.State, 'unknown');
  assert.equal(Power.Battery, null);
});

// --- Temperatures -----------------------------------------------------------------------

test('temperature reports drop unusable sensors and duplicate names', () => {
  const Snapshot = Health.normalizeTemperatures({
    Status: { State: 'ok', Platform: 'linux', Backend: 'sysfs' },
    Sensors: [
      { Name: 'CPU Package', Kind: 'cpu', Celsius: 61.26 },
      { Name: 'CPU Package', Kind: 'cpu', Celsius: 99 },
      { Name: '', Kind: 'gpu', Celsius: 40 },
      { Name: 'GPU 0', Kind: 'quantum', Celsius: 55 },
      { Name: 'NVMe', Kind: 'storage', Celsius: 'hot' },
    ],
    ThermalState: 'NOMINAL',
  });
  assert.deepEqual(Snapshot.Sensors, [
    { Name: 'CPU Package', Kind: 'cpu', Celsius: 61.3 },
    { Name: 'GPU 0', Kind: 'other', Celsius: 55 },
  ]);
  assert.equal(Snapshot.ThermalState, 'nominal');
});

// --- Displays -------------------------------------------------------------------------------

function display(overrides = {}) {
  return {
    DisplayID: 'edid:AAA:1:1',
    ScreenNumber: 1,
    Label: 'Projector',
    Width: 1920,
    Height: 1080,
    RefreshRate: 60,
    ScaleFactor: 1,
    Rotation: 0,
    Primary: true,
    Bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    ...overrides,
  };
}

test('displays that appear, go or change mode are reported once each', () => {
  const Before = [display(), display({ DisplayID: 'edid:BBB:1:1', Primary: false })];
  const After = [
    display({ RefreshRate: 59.94 }),
    display({ DisplayID: 'edid:CCC:1:1', Label: 'LED Wall' }),
  ];
  const Diff = Health.diffDisplays(Before, After);
  assert.deepEqual(
    Diff.Added.map((D) => D.DisplayID),
    ['edid:CCC:1:1']
  );
  assert.deepEqual(
    Diff.Removed.map((D) => D.DisplayID),
    ['edid:BBB:1:1']
  );
  // 59.94 rounds to 60: a fractional refresh wobble is not a change.
  assert.deepEqual(Diff.Changed, []);
});

test('a resolution, rotation or position change is a configuration change', () => {
  for (const Change of [{ Width: 1280 }, { Rotation: 90 }, { Bounds: { x: 1920, y: 0 } }]) {
    const Diff = Health.diffDisplays([display()], [display(Change)]);
    assert.equal(Diff.Changed.length, 1, JSON.stringify(Change));
    assert.equal(Diff.Changed[0].Previous.Width, 1920);
  }
  // A new label is not configuration.
  assert.equal(Health.diffDisplays([display()], [display({ Label: 'Renamed' })]).Changed.length, 0);
});

// --- Network interfaces ---------------------------------------------------------------------

function iface(name, addresses, gateway) {
  return {
    name,
    addresses: addresses.map((address) => ({
      family: address.includes(':') ? 'IPv6' : 'IPv4',
      address,
      internal: address.startsWith('127.') || address === '::1',
    })),
    ...(gateway !== undefined ? { gateway } : {}),
  };
}

test('an interface coming up, going down, or changing address or router is reported', () => {
  const Before = [
    iface('Ethernet', ['10.0.0.5'], '10.0.0.1'),
    iface('Wi-Fi', ['192.168.1.20'], '192.168.1.1'),
    iface('Show LAN', ['10.10.0.5'], null),
  ];
  const After = [
    iface('Ethernet', ['10.0.0.9'], '10.0.0.254'),
    iface('Show LAN', [], null),
    iface('USB Ethernet', ['172.16.0.2'], null),
  ];
  const Diff = Health.diffNetworkInterfaces(Before, After);
  assert.deepEqual(Diff.Up, [{ Name: 'USB Ethernet', Addresses: ['172.16.0.2'] }]);
  assert.deepEqual(Diff.Down.map((D) => D.Name).sort(), ['Show LAN', 'Wi-Fi']);
  assert.deepEqual(Diff.AddressChanged, [
    { Name: 'Ethernet', Previous: ['10.0.0.5'], Addresses: ['10.0.0.9'] },
  ]);
  assert.deepEqual(Diff.GatewayChanged, [
    { Name: 'Ethernet', Previous: '10.0.0.1', Gateway: '10.0.0.254' },
  ]);
});

test('IPv6-only and loopback adapters never raise up/down churn', () => {
  // macOS awdl/llw/utun come and go constantly with link-local IPv6 only.
  const Diff = Health.diffNetworkInterfaces(
    [iface('lo0', ['127.0.0.1', '::1']), iface('awdl0', ['fe80::1'])],
    [iface('utun4', ['fe80::2'])]
  );
  assert.deepEqual(Diff, { Up: [], Down: [], AddressChanged: [], GatewayChanged: [] });
});

test('an absent router is "cannot tell", never a router change', () => {
  const Diff = Health.diffNetworkInterfaces(
    [iface('Ethernet', ['10.0.0.5'])],
    [iface('Ethernet', ['10.0.0.5'], '10.0.0.1')]
  );
  assert.deepEqual(Diff.GatewayChanged, []);
});

// --- USB ----------------------------------------------------------------------------------------

function usb(overrides = {}) {
  return {
    VendorID: 0x1234,
    ProductID: 0x0001,
    ManufacturerName: 'Acme',
    ProductName: 'Button Box',
    SerialNumber: 'SN-1',
    Location: '1-2',
    FirmwareVersion: '1.00',
    DeviceState: { ErrorCode: 0, Message: null },
    ...overrides,
  };
}

test('the first list of a connection is a baseline and reports nothing', () => {
  const Memory = new Map();
  assert.deepEqual(
    Health.trackUSBDevices(Memory, [usb({ DeviceState: { ErrorCode: 43 } })], false),
    []
  );
  assert.equal(Memory.size, 1);
});

test('a serialised device unplugged and replugged elsewhere reads as moved', () => {
  const Memory = new Map();
  Health.trackUSBDevices(Memory, [usb()], false);
  assert.deepEqual(Health.trackUSBDevices(Memory, [], true), []);
  const Moves = Health.trackUSBDevices(Memory, [usb({ Location: '1-4' })], true);
  assert.equal(Moves.length, 1);
  assert.equal(Moves[0].Kind, 'moved');
  assert.equal(Moves[0].Previous.Location, '1-2');
});

test('a firmware change and a device starting to fail are reported once', () => {
  const Memory = new Map();
  Health.trackUSBDevices(Memory, [usb()], false);
  const Firmware = Health.trackUSBDevices(Memory, [usb({ FirmwareVersion: '1.10' })], true);
  assert.deepEqual(
    Firmware.map((T) => T.Kind),
    ['firmware']
  );
  const Failing = Health.trackUSBDevices(
    Memory,
    [usb({ FirmwareVersion: '1.10', DeviceState: { ErrorCode: 43, Message: 'Stopped' } })],
    true
  );
  assert.deepEqual(
    Failing.map((T) => T.Kind),
    ['error']
  );
  // Still failing on the next list: not news.
  const Again = Health.trackUSBDevices(
    Memory,
    [usb({ FirmwareVersion: '1.10', DeviceState: { ErrorCode: 43, Message: 'Stopped' } })],
    true
  );
  assert.deepEqual(Again, []);
});

test('a serial-less device can fail but never "move"', () => {
  const Memory = new Map();
  const Plain = usb({ SerialNumber: null });
  Health.trackUSBDevices(Memory, [Plain], false);
  // Same model on another port is a different device as far as anyone can tell.
  assert.deepEqual(
    Health.trackUSBDevices(Memory, [usb({ SerialNumber: null, Location: '1-4' })], true),
    []
  );
  const Failing = Health.trackUSBDevices(
    Memory,
    [usb({ SerialNumber: null, Location: '1-4', DeviceState: { ErrorCode: 10 } })],
    true
  );
  assert.deepEqual(
    Failing.map((T) => T.Kind),
    ['error']
  );
});

test('a key an older client cannot report is never a change', () => {
  const Memory = new Map();
  Health.trackUSBDevices(Memory, [usb({ Location: undefined, FirmwareVersion: undefined })], false);
  assert.deepEqual(Health.trackUSBDevices(Memory, [usb()], true), []);
});
