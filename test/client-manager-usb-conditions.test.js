const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');

// Per-condition critical USB devices through the real ClientManager and a real
// (throwaway) SQLite database: marking, persistence, the group's quantity, an
// older client, and the migration that carries devices marked before
// conditions existed.

function loggerStub() {
  const noop = () => {};
  return { CreateLogger: () => new Proxy({}, { get: () => noop }) };
}

async function loadClientManager(
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-usb-db-'))
) {
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
  await dbModule.Manager.Ready();
  const clientManager = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../DB': dbModule,
      '../Broadcast': { Manager: { emit: () => {} } },
      '../SettingsManager': { Manager: { GetValue: async () => undefined } },
    }
  );
  return { Manager: clientManager.Manager };
}

function markStarted(client) {
  client.SetOnline(true);
  client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  client._refreshClientHealthState();
}

function device(overrides = {}) {
  return {
    VendorID: 1,
    ProductID: 2,
    ManufacturerName: 'Elgato',
    ProductName: 'Stream Deck',
    SerialNumber: 'CL12345',
    Location: '1-2.4',
    FirmwareVersion: '1.23',
    DeviceState: { ErrorCode: 0, Message: null },
    ...overrides,
  };
}

test('ticked conditions are alerted on, unticked ones are not, and they persist', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('u1');
  const [, client] = await Manager.Get('u1');
  markStarted(client);
  await Manager.SetUSBDeviceList('u1', [device()]);

  assert.deepEqual(
    await Manager.MarkUSBDeviceCritical('u1', { SerialNumber: 'CL12345', CheckLocation: true }),
    [null, true]
  );
  // Firmware is not guarded: a change is not a fault.
  await Manager.SetUSBDeviceList('u1', [device({ FirmwareVersion: '2.00' })]);
  assert.equal(client.Degraded, false);

  await Manager.SetUSBDeviceList('u1', [device({ Location: '1-3' })]);
  assert.deepEqual(client.DegradedWarnings, ['USB Device Moved']);

  await Manager.SetUSBDeviceList('u1', [
    device({ DeviceState: { ErrorCode: 43, Message: 'Windows has stopped this device' } }),
  ]);
  assert.deepEqual(client.DegradedWarnings, ['USB Device Error']);

  await Manager.ClearCache();
  await Manager.Init();
  const [, again] = await Manager.Get('u1');
  const entry = again.CriticalUSBDevices[0];
  assert.equal(entry.Location, '1-2.4');
  assert.equal(entry.FirmwareVersion, null);
  assert.equal(entry.RequireNoError, true);
  assert.equal(entry.RequirePresent, true);
});

test('an older client faults on presence only, and its rows read as unsupported', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('u2');
  const [, client] = await Manager.Get('u2');
  markStarted(client);
  const old = {
    VendorID: 1,
    ProductID: 2,
    ManufacturerName: 'Elgato',
    ProductName: 'Stream Deck',
    SerialNumber: 'CL12345',
  };
  await Manager.SetUSBDeviceList('u2', [old]);

  // Port and firmware cannot be captured from it.
  const [err] = await Manager.MarkUSBDeviceCritical('u2', {
    SerialNumber: 'CL12345',
    CheckLocation: true,
  });
  assert.match(err, /does not report a port/);
  assert.deepEqual(await Manager.MarkUSBDeviceCritical('u2', { SerialNumber: 'CL12345' }), [
    null,
    true,
  ]);
  assert.deepEqual(client.USBCapabilities, {
    Location: false,
    FirmwareVersion: false,
    DeviceState: false,
  });
  assert.equal(client.Degraded, false);

  await Manager.SetUSBDeviceList('u2', []);
  assert.deepEqual(client.DegradedWarnings, ['Missing USB Device']);
});

test('editing a group keeps the quantity it was marked with', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('u3');
  const [, client] = await Manager.Get('u3');
  markStarted(client);
  const dongle = (Location) =>
    device({ SerialNumber: null, ManufacturerName: 'Acme', ProductName: 'Dongle', Location });
  await Manager.SetUSBDeviceList('u3', [dongle('1-2'), dongle('1-3')]);
  await Manager.MarkUSBNameCritical('u3', { ManufacturerName: 'Acme', ProductName: 'Dongle' });
  assert.equal(client.CriticalUSBNames[0].Quantity, 2);

  // One is unplugged while the operator ticks another condition.
  await Manager.SetUSBDeviceList('u3', [dongle('1-2')]);
  await Manager.MarkUSBNameCritical('u3', {
    ManufacturerName: 'Acme',
    ProductName: 'Dongle',
    CheckFirmware: true,
  });
  assert.equal(client.CriticalUSBNames[0].Quantity, 2);
  assert.equal(client.CriticalUSBNames[0].FirmwareVersion, '1.23');
  assert.deepEqual(client.DegradedWarnings, ['Missing USB Device']);
});

test('devices marked before conditions existed migrate to the same guard', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-usb-mig-'));
  const file = path.join(storageDir, 'DB.sqlite');
  // The tables as 3.26.0 left them, at schema version 42.
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file);
    db.serialize(() => {
      db.run(
        'CREATE TABLE CriticalUSBDevices (UUID TEXT NOT NULL, SerialNumber TEXT NOT NULL, ManufacturerName TEXT, ProductName TEXT, Timestamp BIGINT(11) NOT NULL, PRIMARY KEY (UUID, SerialNumber))'
      );
      db.run(
        'CREATE TABLE CriticalUSBDeviceNames (UUID TEXT NOT NULL, NameKey TEXT NOT NULL, ManufacturerName TEXT, ProductName TEXT, Quantity INTEGER NOT NULL DEFAULT 1, Timestamp BIGINT(11) NOT NULL, PRIMARY KEY (UUID, NameKey))'
      );
      db.run(
        'CREATE TABLE SchemaMigrations (Version INTEGER PRIMARY KEY, AppliedAt BIGINT(11) NOT NULL)'
      );
      db.run('INSERT INTO SchemaMigrations VALUES (42, 0)');
      db.run("INSERT INTO CriticalUSBDevices VALUES ('m1', 'CL12345', 'Elgato', 'Stream Deck', 7)");
      db.run(
        "INSERT INTO CriticalUSBDeviceNames VALUES ('m1', 'acme dongle', 'Acme', 'Dongle', 2, 8)",
        (err) => (err ? reject(err) : db.close(resolve))
      );
    });
  });

  const { Manager } = await loadClientManager(storageDir);
  await Manager.Create('m1');
  await Manager.ClearCache();
  await Manager.Init();
  const [, client] = await Manager.Get('m1');
  assert.deepEqual(client.CriticalUSBDevices, [
    {
      SerialNumber: 'CL12345',
      ManufacturerName: 'Elgato',
      ProductName: 'Stream Deck',
      RequirePresent: true,
      Location: null,
      FirmwareVersion: null,
      RequireNoError: true,
      Timestamp: 7,
    },
  ]);
  assert.equal(client.CriticalUSBNames[0].Quantity, 2);
  assert.equal(client.CriticalUSBNames[0].RequirePresent, true);
  assert.equal(client.CriticalUSBNames[0].Location, null);
});
