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

test('SystemInfo normalizes MacAddresses entries and drops non-object values', () => {
  const normalized = SocketValidation.SystemInfo({
    Hostname: 'HOST-1',
    OperatingSystem: 'Windows 11',
    MacAddresses: {
      eth0: { ipv4: '10.0.0.5', ipv6: 'fe80::1', mac: 'aa:bb:cc:dd:ee:ff' },
      bogus: 42,
    },
  });
  assert.deepEqual(normalized.MacAddresses, {
    eth0: { ipv4: '10.0.0.5', ipv6: 'fe80::1', mac: 'aa:bb:cc:dd:ee:ff' },
  });
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

test('NetworkInterfaces preserves the nested payload the client actually sends', () => {
  assert.throws(() => SocketValidation.NetworkInterfaces(null));

  // Copied from the client's NetworkMonitor.normalize() output. This validator
  // used to reconstruct a flat PascalCase shape that neither side produced, so
  // every field read as undefined and the whole payload was rewritten to nulls
  // — the client record ended up storing `{ name: 'unknown', addresses: [] }`
  // for every interface. The previous version of this test asserted that flat
  // shape, so it passed while the feature was broken end to end.
  const [iface] = SocketValidation.NetworkInterfaces([
    {
      name: 'en0',
      addresses: [
        {
          family: 'IPv4',
          address: '10.0.0.5',
          netmask: '255.255.255.0',
          cidr: '10.0.0.5/24',
          mac: 'aa:bb',
          internal: false,
          scopeid: null,
        },
        {
          family: 'IPv6',
          address: 'fe80::1',
          netmask: 'ffff::',
          cidr: 'fe80::1/64',
          mac: 'aa:bb',
          internal: false,
          scopeid: 5,
        },
      ],
      Rogue: 'dropped',
    },
  ]);

  assert.equal(iface.name, 'en0');
  assert.equal(iface.Rogue, undefined, 'unexpected keys are still pruned');
  assert.equal(iface.addresses.length, 2);
  // The MAC has to survive: CollectReportedMacAddresses reads it from here, and
  // it is the only path a Wi-Fi adapter's MAC reaches the server on.
  assert.equal(iface.addresses[0].mac, 'aa:bb');
  assert.equal(iface.addresses[0].address, '10.0.0.5');
  assert.equal(iface.addresses[0].cidr, '10.0.0.5/24');
  assert.equal(iface.addresses[0].internal, false);
  assert.equal(iface.addresses[1].family, 'IPv6');
  assert.equal(iface.addresses[1].scopeid, 5);
});

test('NetworkInterfaces tolerates an interface reporting no addresses', () => {
  const [iface] = SocketValidation.NetworkInterfaces([{ name: 'utun0' }]);
  assert.deepEqual(iface, { name: 'utun0', addresses: [] });
});

test('RunningApplications normalizes items and status', () => {
  const snapshot = SocketValidation.RunningApplications({
    SampledAt: 1700000000000,
    TotalCount: 2,
    Truncated: false,
    Items: [
      { Name: 'QLab', Count: 1 },
      { Name: '', Count: 3 },
    ],
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

test('IntegratedEventFeedback trims, caps and rejects empty messages', () => {
  assert.equal(SocketValidation.IntegratedEventFeedback('  Step 2 of 5  '), 'Step 2 of 5');

  // Over-long messages are cut to the cap rather than rejected, so a chatty
  // handler never has its event torn down over a status string.
  const capped = SocketValidation.IntegratedEventFeedback('x'.repeat(400));
  assert.equal(capped.length, 255);

  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => SocketValidation.IntegratedEventFeedback(bad), /Message/);
  }
});

test('Heartbeat drops a malformed vital instead of failing the whole beat', () => {
  // Exactly what the Android SDK sent before 1.2.1: a numeric Ram percentage
  // and no Total/Used. Rejecting this cost the client its online mark, so the
  // device read as offline while it was connected and heartbeating.
  const warnings = [];
  const result = SocketValidation.Heartbeat(
    {
      Version: '1.2.0',
      Vitals: {
        CPU: { UsagePercentage: 3 },
        Ram: { UsagePercentage: 55, TotalBytes: 2087780352 },
        Uptime: { Seconds: 1234 },
      },
    },
    (message) => warnings.push(message)
  );

  // The beat survives, so the client still gets marked online.
  assert.equal(result.Version, '1.2.0');
  // Good vitals are kept; only the offending field is dropped.
  assert.deepEqual(result.Vitals.CPU, { UsagePercentage: 3 });
  assert.equal(result.Vitals.Ram.UsagePercentage, null);
  assert.equal(result.Vitals.Ram.Total, null);
  // The drift is reported rather than swallowed.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Vitals\.Ram\.UsagePercentage must be a string/);
});

test('Heartbeat drops a whole vitals section that is the wrong type', () => {
  const warnings = [];
  const result = SocketValidation.Heartbeat(
    { Version: '1.0.0', Vitals: { CPU: 'nonsense', Uptime: { Formatted: '00:01:02' } } },
    (message) => warnings.push(message)
  );
  assert.equal('CPU' in result.Vitals, false);
  assert.deepEqual(result.Vitals.Uptime, { Formatted: '00:01:02' });
  assert.match(warnings[0], /Vitals\.CPU must be an object/);
});

test('Heartbeat stays strict about the payload envelope', () => {
  // Tolerance is scoped to display-only vitals: a payload that is not an
  // object, or a Version of the wrong type, is still rejected outright.
  assert.throws(() => SocketValidation.Heartbeat('nope'), /Heartbeat payload must be an object/);
  assert.throws(() => SocketValidation.Heartbeat({ Vitals: 'nope' }), /Vitals must be an object/);
  assert.throws(() => SocketValidation.Heartbeat({ Version: 42 }), /Version must be a string/);
});
