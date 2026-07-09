const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Manager: SocketValidation } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'SocketValidation', 'index')
);

test('HandshakeUUID accepts UUID-shaped identifiers', () => {
  assert.equal(
    SocketValidation.HandshakeUUID('8b1f4d6e-2c3a-4f5b-9d7e-1a2b3c4d5e6f'),
    '8b1f4d6e-2c3a-4f5b-9d7e-1a2b3c4d5e6f'
  );
  assert.equal(SocketValidation.HandshakeUUID('client_01.local:2'), 'client_01.local:2');
});

test('HandshakeUUID rejects selector/markup metacharacters and non-strings', () => {
  for (const bad of [
    '"><img src=x onerror=alert(1)>',
    "x' onmouseover='alert(1)",
    'a]b',
    '',
    '   ',
    null,
    undefined,
    123,
    'x'.repeat(65),
  ]) {
    assert.throws(() => SocketValidation.HandshakeUUID(bad), /UUID/);
  }
});

test('Heartbeat normalizes known fields and drops unknown keys', () => {
  const normalized = SocketValidation.Heartbeat({
    Version: ' 3.9.0 ',
    ScriptsFingerprint: 'abc123',
    Vitals: {
      CPU: { UsagePercentage: 42.5, Junk: 'dropped' },
      Ram: { Total: 16e9, Used: 8e9, UsagePercentage: '50.00' },
      Uptime: { Formatted: '01:02:03' },
    },
    __proto__: { polluted: true },
    Extra: 'dropped',
  });
  assert.deepEqual(normalized, {
    Version: '3.9.0',
    Vitals: {
      CPU: { UsagePercentage: 42.5 },
      Ram: { Total: 16e9, Used: 8e9, UsagePercentage: '50.00' },
      Uptime: { Formatted: '01:02:03' },
    },
    ScriptsFingerprint: 'abc123',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'Extra'), false);
});

test('Heartbeat rejects non-object payloads', () => {
  for (const bad of [null, undefined, 'str', 42, [], true]) {
    assert.throws(() => SocketValidation.Heartbeat(bad));
  }
});

test('SystemInfo bounds MacAddresses and keeps only string values', () => {
  const normalized = SocketValidation.SystemInfo({
    Hostname: 'HOST-1',
    OperatingSystem: 'Windows 11',
    MacAddresses: { eth0: 'aa:bb:cc:dd:ee:ff', bogus: 42 },
  });
  assert.deepEqual(normalized.MacAddresses, { eth0: 'aa:bb:cc:dd:ee:ff' });
  assert.equal(normalized.Hostname, 'HOST-1');
});

test('USBDeviceList rejects non-arrays (the DeviceList.length crash case)', () => {
  for (const bad of [null, undefined, {}, 'x', 42]) {
    assert.throws(() => SocketValidation.USBDeviceList(bad), /array/);
  }
});

test('USBDeviceList prunes device entries to the known fields', () => {
  const [device] = SocketValidation.USBDeviceList([
    {
      VendorID: 1133,
      ProductID: 49948,
      ManufacturerName: 'Logitech',
      ProductName: 'Receiver',
      SerialNumber: null,
      Evil: '<script>',
    },
  ]);
  assert.deepEqual(device, {
    VendorID: 1133,
    ProductID: 49948,
    ManufacturerName: 'Logitech',
    ProductName: 'Receiver',
    SerialNumber: null,
  });
});

test('USBDeviceList enforces the element cap', () => {
  const oversized = Array.from({ length: 513 }, () => ({}));
  assert.throws(() => SocketValidation.USBDeviceList(oversized), /maximum/);
});

test('DisplayList validates entries and rejects non-arrays', () => {
  assert.throws(() => SocketValidation.DisplayList(null));
  const [display] = SocketValidation.DisplayList([
    {
      SessionID: '1',
      ScreenNumber: 1,
      DisplayID: 'edid:foo',
      HardwareID: null,
      IsStableIdentity: true,
      IdentitySource: 'edid',
      Label: 'DELL U2723QE',
      Width: 3840,
      Height: 2160,
      ScaleFactor: 1.5,
      RefreshRate: 60,
      Rotation: 0,
      Internal: false,
      Primary: true,
      Bounds: { x: 0, y: 0, width: 3840, height: 2160 },
    },
  ]);
  assert.equal(display.Label, 'DELL U2723QE');
  assert.deepEqual(display.Bounds, { x: 0, y: 0, width: 3840, height: 2160 });
});

test('NetworkInterfaces prunes to known fields and requires an array', () => {
  assert.throws(() => SocketValidation.NetworkInterfaces(null));
  const [iface] = SocketValidation.NetworkInterfaces([
    { Name: 'en0', Address: '10.0.0.5', MAC: 'aa:bb', Family: 'IPv4', Internal: false, X: 1 },
  ]);
  assert.deepEqual(iface, {
    Name: 'en0',
    Address: '10.0.0.5',
    MAC: 'aa:bb',
    Family: 'IPv4',
    Internal: false,
  });
});

test('RunningApplications normalizes items and status', () => {
  const snapshot = SocketValidation.RunningApplications({
    SampledAt: 1700000000000,
    TotalCount: 2,
    Truncated: false,
    Items: [{ Name: 'QLab', Count: 1 }, { Name: '', Count: 3 }],
    Status: { State: 'ok', Message: null },
  });
  assert.deepEqual(snapshot.Items, [{ Name: 'QLab', Count: 1 }]);
  assert.equal(snapshot.Status.State, 'ok');
});

test('RunningApplications rejects malformed item containers', () => {
  assert.throws(() => SocketValidation.RunningApplications({ Items: 'nope' }));
  assert.throws(() => SocketValidation.RunningApplications({ Items: ['garbage'] }));
  assert.throws(() => SocketValidation.RunningApplications(null));
});

test('RequestID rejects markup and accepts server-issued ids', () => {
  assert.equal(SocketValidation.RequestID('req-123'), 'req-123');
  assert.throws(() => SocketValidation.RequestID('<img src=x>'));
  assert.throws(() => SocketValidation.RequestID(null));
});

test('ExecutionProgress clamps to 0-100 and bounds status text', () => {
  assert.deepEqual(SocketValidation.ExecutionProgress(150, 'ok'), [100, 'ok']);
  assert.deepEqual(SocketValidation.ExecutionProgress(-5, null), [0, null]);
  assert.throws(() => SocketValidation.ExecutionProgress('NaN', 'x'));
});

test('ExecutionError accepts strings/null and bounds length', () => {
  assert.equal(SocketValidation.ExecutionError(null), null);
  assert.equal(SocketValidation.ExecutionError('boom'), 'boom');
  assert.equal(SocketValidation.ExecutionError('x'.repeat(5000)).length, 2048);
  assert.throws(() => SocketValidation.ExecutionError({ nope: true }));
});

test('IPCValidation primitives remain available from their historical path', () => {
  const primitives = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'IPCValidation', 'primitives')
  );
  assert.equal(typeof primitives.fail, 'function');
  assert.equal(typeof primitives.isPlainObject, 'function');
  assert.equal(typeof primitives.normalizeNonEmptyString, 'function');
});
