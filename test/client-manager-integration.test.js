const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');

// Bring a client online as a machine that has already finished booting.
//
// A freshly-connected client holds its critical-hardware guards for
// CLIENT_STARTUP_GRACE_MS (the show software is still launching), which is not
// what the guard tests below are about — they are about what happens once the
// machine is up. Backdating the connection puts them past that window; the
// window itself has its own tests.
function markStarted(client) {
  client.SetOnline(true);
  client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  client._refreshClientHealthState();
}

function loggerStub() {
  const noop = () => {};
  return {
    CreateLogger: () => ({
      log: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      trace: noop,
      success: noop,
      database: noop,
      databaseError: noop,
      silent: noop,
    }),
  };
}

// Build a real SQLite-backed DB module pointed at a throwaway storage directory
// so ClientManager exercises genuine persistence rather than a hand-rolled stub.
async function buildRealDB() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-cm-db-'));
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
  await dbModule.Manager.Ready();
  return dbModule;
}

async function loadClientManager(settings = {}) {
  const dbModule = await buildRealDB();
  const events = [];
  const sounds = [];
  const clientManager = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../DB': dbModule,
      '../Broadcast': {
        Manager: {
          emit: (event, ...rest) => {
            events.push(event);
            if (event === 'PlaySound') sounds.push(rest[0]);
          },
        },
      },
      '../SettingsManager': { Manager: { GetValue: async (key) => settings[key] } },
    }
  );
  return { Manager: clientManager.Manager, DB: dbModule.Manager, events, sounds };
}

test('ClientManager creates, fetches, updates, and deletes clients', async () => {
  const { Manager, events } = await loadClientManager();

  // Create a client and confirm it lands in cache + DB.
  const [createErr] = await Manager.Create('uuid-1');
  assert.equal(createErr, null);
  assert.equal(await Manager.Exists('uuid-1'), true);

  // Duplicate create is rejected.
  const [dupErr] = await Manager.Create('uuid-1');
  assert.match(String(dupErr), /already exists/i);

  // Get returns a Client object.
  const [getErr, client] = await Manager.Get('uuid-1');
  assert.equal(getErr, null);
  assert.equal(client.UUID, 'uuid-1');

  // Update applies nickname + group changes.
  const [updErr, updated] = await Manager.Update('uuid-1', { Nickname: 'Booth PC', GroupID: null });
  assert.equal(updErr, null);
  assert.equal(updated.Nickname, 'Booth PC');

  // Updating a missing client fails.
  const [missErr] = await Manager.Update('nope', { Nickname: 'x' });
  assert.match(String(missErr), /not found/i);

  // Delete removes from cache + DB.
  const [delErr] = await Manager.Delete('uuid-1');
  assert.equal(delErr, null);
  assert.equal(await Manager.Exists('uuid-1'), false);

  assert.ok(events.includes('ClientListChanged'));
});

test('ClientManager hydrates a heartbeat from the database when uncached', async () => {
  const { Manager, DB } = await loadClientManager();

  // Insert directly into the DB (not via cache) then send a heartbeat.
  await DB.Run('INSERT INTO Clients (UUID, Hostname, Timestamp) VALUES (?, ?, ?)', [
    'hb-1',
    'host',
    Date.now(),
  ]);

  const [err, msg] = await Manager.Heartbeat(
    'hb-1',
    { Version: '2.0', Vitals: { CPU: {} } },
    '10.0.0.5'
  );
  assert.equal(err, null);
  assert.match(msg, /processed/i);

  const [, client] = await Manager.Get('hb-1');
  assert.equal(client.Online, true);
  assert.equal(client.IP, '10.0.0.5');
  assert.equal(client.Version, '2.0');

  // Heartbeat for a totally unknown client reports invalid.
  const [, invalidMsg] = await Manager.Heartbeat('ghost', { Vitals: {} }, '1.1.1.1');
  assert.equal(invalidMsg, null);
});

// Hotplug events are the real-time USB signal — the client sends one per plug
// and the server applies it to the connected list incrementally. That only works
// if applying an event is correct on its own; it used to be papered over by a
// full device list arriving immediately afterwards, which no longer happens.
test('adding a serial-less USB device leaves the other serial-less devices connected', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('dev-1');

  const keyboard = { VendorID: 1, ProductID: 2, ManufacturerName: 'Generic', ProductName: 'Kbd' };
  const hub = { VendorID: 3, ProductID: 4, ManufacturerName: 'Generic', ProductName: 'Hub' };
  const mouse = { VendorID: 5, ProductID: 6, ManufacturerName: 'Logitech', ProductName: 'Mouse' };
  await Manager.SetUSBDeviceList('dev-1', [keyboard, hub]);

  await Manager.USBDeviceAdded('dev-1', mouse);
  const [, afterAdd] = await Manager.Get('dev-1');
  // Matching on a normalised serial number treated every absent serial as equal,
  // so plugging in one unserialised device filtered out every other one — the
  // keyboard and hub simply vanished from the server's view until the next full
  // list arrived.
  assert.equal(afterAdd.ConnectedUSBDeviceList.length, 3);
  assert.deepEqual(afterAdd.ConnectedUSBDeviceList.map((d) => d.ProductName).sort(), [
    'Hub',
    'Kbd',
    'Mouse',
  ]);

  await Manager.USBDeviceRemoved('dev-1', mouse);
  const [, afterRemove] = await Manager.Get('dev-1');
  assert.deepEqual(
    afterRemove.ConnectedUSBDeviceList.map((d) => d.ProductName).sort(),
    ['Hub', 'Kbd'],
    'unplugging one serial-less device must not remove the rest'
  );
});

test('removing one of two identical serial-less devices leaves the other', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('dev-1');

  const adapter = { VendorID: 9, ProductID: 9, ManufacturerName: 'Generic', ProductName: 'DAC' };
  await Manager.SetUSBDeviceList('dev-1', [{ ...adapter }, { ...adapter }]);

  await Manager.USBDeviceRemoved('dev-1', { ...adapter });
  const [, after] = await Manager.Get('dev-1');
  // Nothing distinguishes the two, so exactly one entry is dropped rather than
  // every matching entry.
  assert.equal(after.ConnectedUSBDeviceList.length, 1);
});

test('re-announcing a serialised USB device replaces it rather than duplicating it', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('dev-1');

  await Manager.USBDeviceAdded('dev-1', { SerialNumber: 'S1', ProductName: 'Drive' });
  await Manager.USBDeviceAdded('dev-1', { SerialNumber: 's1', ProductName: 'Drive' });
  const [, after] = await Manager.Get('dev-1');
  // A serial number identifies one physical device, and is matched
  // case-insensitively.
  assert.equal(after.ConnectedUSBDeviceList.length, 1);
});

test('ClientManager updates system info, USB devices, and network interfaces', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('dev-1');
  await Manager.Create('dev-2');

  const [siErr] = await Manager.SystemInfo(
    'dev-1',
    {
      Hostname: 'STAGE-PC',
      OperatingSystem: 'macOS',
      MacAddresses: { eth0: { ipv4: '10.0.0.7', mac: 'aa:bb' } },
    },
    '10.0.0.7'
  );
  assert.equal(siErr, null);
  const [, afterSI] = await Manager.Get('dev-1');
  assert.equal(afterSI.Hostname, 'STAGE-PC');
  assert.equal(afterSI.OperatingSystem, 'macOS');
  assert.equal(afterSI.MacAddress, 'aa:bb');

  await Manager.SetUSBDeviceList('dev-1', [{ SerialNumber: 'S1' }]);
  await Manager.USBDeviceAdded('dev-1', { SerialNumber: 'S2' });
  await Manager.SetUSBDeviceList('dev-2', [{ SerialNumber: 'S2' }]);
  let [, withUsb] = await Manager.Get('dev-1');
  assert.equal(withUsb.USBDeviceList.length, 2);

  const [markErr] = await Manager.MarkUSBDeviceCritical('dev-1', {
    SerialNumber: 's2',
    ManufacturerName: 'SanDisk',
    ProductName: 'Ultra',
  });
  assert.equal(markErr, null);

  [, withUsb] = await Manager.Get('dev-1');
  const criticalDevice = withUsb.USBDeviceList.find((d) => d.SerialNumber === 'S2');
  assert.equal(criticalDevice.IsCritical, true);

  const [, withUsbOther] = await Manager.Get('dev-2');
  const otherDevice = withUsbOther.USBDeviceList.find((d) => d.SerialNumber === 'S2');
  assert.equal(otherDevice.IsCritical, false);

  assert.deepEqual(await Manager.IsUSBDeviceCritical('dev-1', 'S2'), [null, true]);
  assert.deepEqual(await Manager.IsUSBDeviceCritical('dev-2', 'S2'), [null, false]);

  await Manager.USBDeviceRemoved('dev-1', { SerialNumber: 'S2' });
  [, withUsb] = await Manager.Get('dev-1');
  assert.equal(withUsb.USBDeviceList.length, 2);
  const missingCritical = withUsb.USBDeviceList.find((d) => d.SerialNumber === 'S2');
  assert.equal(!!missingCritical, true);
  assert.equal(missingCritical.IsConnected, false);
  assert.equal(missingCritical.IsCritical, true);

  const [removeErr] = await Manager.RemoveUSBDeviceCritical('dev-1', 'S2');
  assert.equal(removeErr, null);
  [, withUsb] = await Manager.Get('dev-1');
  assert.equal(withUsb.USBDeviceList.length, 1);
  assert.equal(
    withUsb.USBDeviceList.some((d) => d.SerialNumber === 'S2'),
    false
  );

  // Connect + disconnect each broadcast a device event (audio/alerts are handled
  // downstream by the alerts system, not by ClientManager directly).
  assert.ok(events.includes('USBDeviceAdded'));
  assert.ok(events.includes('USBDeviceRemoved'));

  await Manager.SetNetworkInterfaces('dev-1', [
    { name: 'eth0', addresses: [{ family: 'IPv4', address: '10.0.0.7', mac: 'aa:bb' }] },
  ]);
  const [, withNics] = await Manager.Get('dev-1');
  assert.equal(withNics.NetworkInterfaces[0].name, 'eth0');

  // Operations against a missing client return errors.
  assert.match(String((await Manager.SetUSBDeviceList('missing', []))[0]), /not found/i);
  assert.match(String((await Manager.SystemInfo('missing', {}, '0'))[0]), /not found/i);
});

test('ClientManager guards serial-less USB devices by name and quantity', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('kiosk-1');

  // Two identical serial-less dongles are connected.
  await Manager.SetUSBDeviceList('kiosk-1', [
    { ManufacturerName: 'Acme', ProductName: 'Dongle' },
    { ManufacturerName: 'Acme', ProductName: 'Dongle' },
  ]);

  // Marking one captures the current connected count (2) as the expected qty.
  const [markErr] = await Manager.MarkUSBNameCritical('kiosk-1', {
    ManufacturerName: 'Acme',
    ProductName: 'Dongle',
  });
  assert.equal(markErr, null);

  let [, client] = await Manager.Get('kiosk-1');
  assert.equal(client.CriticalUSBNames.length, 1);
  assert.equal(client.CriticalUSBNames[0].Quantity, 2);
  // Both connected cards are flagged critical-by-name, none in shortfall.
  const connectedCards = client.USBDeviceList.filter((d) => d.IsCriticalByName);
  assert.equal(connectedCards.length, 2);
  assert.equal(
    connectedCards.every((d) => d.Shortfall === false),
    true
  );
  assert.equal(client.MissingCriticalUSBNames.length, 0);
  assert.equal(client.Degraded === true, false);

  // Case-insensitive name lookup works.
  assert.deepEqual(await Manager.IsUSBNameCritical('kiosk-1', 'acme dongle'), [null, true]);

  // Unplug one → shortfall (1 of 2). Client is degraded; the surviving card is
  // flagged Shortfall, and no duplicate "missing" card is emitted.
  markStarted(client);
  await Manager.SetUSBDeviceList('kiosk-1', [{ ManufacturerName: 'Acme', ProductName: 'Dongle' }]);
  [, client] = await Manager.Get('kiosk-1');
  assert.equal(client.MissingCriticalUSBNames.length, 1);
  assert.equal(client.USBDeviceList.filter((d) => d.IsCriticalByName).length, 1);
  const short = client.USBDeviceList.find((d) => d.IsCriticalByName);
  assert.equal(short.Shortfall, true);
  assert.equal(short.ConnectedCount, 1);
  assert.equal(short.Quantity, 2);
  assert.equal(client.Degraded, true);
  assert.ok(client.DegradedWarnings.includes('Missing USB Device'));

  // Unplug the last one → a single fully-absent card (0 of 2).
  await Manager.SetUSBDeviceList('kiosk-1', []);
  [, client] = await Manager.Get('kiosk-1');
  const absent = client.USBDeviceList.filter((d) => d.IsCriticalByName);
  assert.equal(absent.length, 1);
  assert.equal(absent[0].IsConnected, false);
  assert.equal(absent[0].ConnectedCount, 0);

  // Removing critical status clears the guard entirely.
  const [removeErr] = await Manager.RemoveUSBNameCritical('kiosk-1', {
    ManufacturerName: 'Acme',
    ProductName: 'Dongle',
  });
  assert.equal(removeErr, null);
  [, client] = await Manager.Get('kiosk-1');
  assert.equal(client.CriticalUSBNames.length, 0);
  assert.equal(client.MissingCriticalUSBNames.length, 0);
  assert.deepEqual(await Manager.IsUSBNameCritical('kiosk-1', 'acme dongle'), [null, false]);
});

test('ClientManager tracks critical displays and flags resolution/refresh changes', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('disp-1');

  // Report two connected displays.
  await Manager.SetDisplayList('disp-1', [
    {
      DisplayID: '100',
      Label: 'Primary',
      Width: 1920,
      Height: 1080,
      RefreshRate: 60,
      Primary: true,
    },
    { DisplayID: '200', Label: 'Secondary', Width: 2560, Height: 1440, RefreshRate: 144 },
  ]);
  let [, client] = await Manager.Get('disp-1');
  assert.equal(client.DisplayList.length, 2);

  // Mark the primary display critical; baseline captured from the live report.
  const [markErr] = await Manager.MarkDisplayCritical('disp-1', { DisplayID: '100' });
  assert.equal(markErr, null);
  assert.deepEqual(await Manager.IsDisplayCritical('disp-1', '100'), [null, true]);
  assert.deepEqual(await Manager.IsDisplayCritical('disp-1', '200'), [null, false]);

  [, client] = await Manager.Get('disp-1');
  let primary = client.DisplayList.find((d) => d.DisplayID === '100');
  assert.equal(primary.IsCritical, true);
  assert.equal(primary.Mismatch, false);
  assert.equal(client.MismatchedCriticalDisplays.length, 0);
  assert.equal(client.Degraded, false);

  // Same display, changed resolution/refresh -> mismatch + degraded.
  markStarted(client);
  await Manager.SetDisplayList('disp-1', [
    { DisplayID: '100', Label: 'Primary', Width: 1280, Height: 720, RefreshRate: 30 },
    { DisplayID: '200', Label: 'Secondary', Width: 2560, Height: 1440, RefreshRate: 144 },
  ]);
  [, client] = await Manager.Get('disp-1');
  primary = client.DisplayList.find((d) => d.DisplayID === '100');
  assert.equal(primary.Mismatch, true);
  assert.equal(client.MismatchedCriticalDisplays.length, 1);
  assert.equal(client.Degraded, true);
  assert.ok(client.DegradedWarnings.includes('Display Configuration Changed'));

  // Restoring the original configuration clears the mismatch.
  await Manager.SetDisplayList('disp-1', [
    { DisplayID: '100', Label: 'Primary', Width: 1920, Height: 1080, RefreshRate: 60 },
  ]);
  [, client] = await Manager.Get('disp-1');
  primary = client.DisplayList.find((d) => d.DisplayID === '100');
  assert.equal(primary.Mismatch, false);
  assert.equal(client.MismatchedCriticalDisplays.length, 0);

  // Disconnecting the critical display surfaces it as missing + degraded.
  await Manager.SetDisplayList('disp-1', [
    { DisplayID: '200', Label: 'Secondary', Width: 2560, Height: 1440, RefreshRate: 144 },
  ]);
  [, client] = await Manager.Get('disp-1');
  const missing = client.DisplayList.find((d) => d.DisplayID === '100');
  assert.equal(missing.Missing, true);
  assert.equal(missing.IsConnected, false);
  assert.equal(client.MissingCriticalDisplays.length, 1);
  assert.ok(client.DegradedWarnings.includes('Missing Display'));

  // Removing the critical flag clears everything.
  const [removeErr] = await Manager.RemoveDisplayCritical('disp-1', '100');
  assert.equal(removeErr, null);
  assert.deepEqual(await Manager.IsDisplayCritical('disp-1', '100'), [null, false]);
  [, client] = await Manager.Get('disp-1');
  assert.equal(client.MissingCriticalDisplays.length, 0);
  assert.equal(
    client.DisplayList.some((d) => d.DisplayID === '100'),
    false
  );

  // Operations against a missing client return errors.
  assert.match(String((await Manager.SetDisplayList('nope', []))[0]), /not found/i);
  assert.match(
    String((await Manager.MarkDisplayCritical('nope', { DisplayID: '1' }))[0]),
    /not found/i
  );
});

// The window this covers is the first few seconds of a connection. The client's
// heartbeat lands immediately and its USB, display and application reports
// follow a second apart, so between them the server holds guards for hardware
// it has been told nothing about. Judging that silence as "missing" marked every
// client degraded on connect — and at server start, with the whole rig
// connecting at once, that arrived as a wave of alerts for faults that did not
// exist.
test('hardware a client has not reported yet is unknown, not missing', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('booth-1');

  // Establish the guards from a live report, the way an operator marks them.
  await Manager.SetUSBDeviceList('booth-1', [
    { SerialNumber: 'S1', ManufacturerName: 'Acme', ProductName: 'Dongle' },
  ]);
  await Manager.SetDisplayList('booth-1', [
    { DisplayID: '100', Label: 'Primary', Width: 1920, Height: 1080, RefreshRate: 60 },
  ]);
  await Manager.MarkUSBDeviceCritical('booth-1', { SerialNumber: 'S1' });
  await Manager.MarkDisplayCritical('booth-1', { DisplayID: '100' });

  let [, client] = await Manager.Get('booth-1');
  markStarted(client);
  assert.equal(client.Degraded, false);

  // The server restarts (or the client reconnects): the heartbeat arrives, the
  // hardware reports have not. Started long enough ago that the start-up window
  // is not what is holding the fault back — only the missing evidence is.
  client.SetOnline(false);
  markStarted(client);
  assert.equal(client.Degraded, false, 'silence about a device is not a report that it is gone');
  assert.deepEqual(client.DegradedWarnings, []);
  // Suppressing the fault must not mean lying about the connection: the client
  // is genuinely connected and still says so.
  assert.equal(client.Online, true);

  // Reporting displays proves nothing about USB — the gates are per-domain.
  await Manager.SetDisplayList('booth-1', [
    { DisplayID: '100', Label: 'Primary', Width: 1920, Height: 1080, RefreshRate: 60 },
  ]);
  [, client] = await Manager.Get('booth-1');
  assert.equal(client.Degraded, false);

  // The first real USB report is judged the moment it lands: the dongle really
  // is gone, so this is a fault seconds into the connection, not a missed one.
  await Manager.SetUSBDeviceList('booth-1', []);
  [, client] = await Manager.Get('booth-1');
  assert.equal(client.Degraded, true);
  assert.ok(client.DegradedWarnings.includes('Missing USB Device'));
});

// The other half of the start-up problem. Once a machine's telemetry DOES
// arrive, the report is accurate — the show software genuinely is not running
// yet, because the machine finished booting ten seconds ago. That is a true
// observation of a state that is about to fix itself, and at rig power-up it
// arrives from every machine at once.
test('a critical application missing during the start-up window reads as starting up, not degraded', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('stage-1');
  await Manager.MarkApplicationCritical('stage-1', { Name: 'QLab' });

  const [, client] = await Manager.Get('stage-1');
  client.SetOnline(true);

  // First successful sample: QLab is not up yet.
  await Manager.SetRunningApplications('stage-1', {
    SampledAt: Date.now(),
    TotalCount: 1,
    Truncated: false,
    Items: [{ Name: 'Finder', Count: 1 }],
    Status: { State: 'ok', Message: null, Platform: 'darwin' },
  });

  assert.equal(client.Initialising, true, 'the machine is still coming up');
  assert.equal(client.Degraded, false, 'so the fault is held rather than published');
  assert.deepEqual(client.DegradedWarnings, []);
  // The connection itself is never in doubt, and is never misreported.
  assert.equal(client.Online, true);

  // QLab launches inside the window: the fault existed, was never announced,
  // and is now simply gone. This is the alert that used to fire at every show
  // start-up for every machine on the rig.
  await Manager.SetRunningApplications('stage-1', {
    SampledAt: Date.now(),
    TotalCount: 2,
    Truncated: false,
    Items: [
      { Name: 'Finder', Count: 1 },
      { Name: 'QLab', Count: 1 },
    ],
    Status: { State: 'ok', Message: null, Platform: 'darwin' },
  });
  assert.equal(client.Initialising, false);
  assert.equal(client.Degraded, false);

  // A machine that is still missing it when the window closes is a real fault,
  // and is published as one — this is the case the window must not swallow.
  await Manager.SetRunningApplications('stage-1', {
    SampledAt: Date.now(),
    TotalCount: 1,
    Truncated: false,
    Items: [{ Name: 'Finder', Count: 1 }],
    Status: { State: 'ok', Message: null, Platform: 'darwin' },
  });
  assert.equal(client.Initialising, true);
  client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  client._refreshClientHealthState();
  assert.equal(client.Initialising, false);
  assert.equal(client.Degraded, true);
  assert.ok(client.DegradedWarnings.includes('Critical Application Issue'));
  assert.ok(events.includes('ClientUpdated'));
});

test('an SDK client reporting its own degraded state is never held by the start-up window', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('integrated-1');

  const [, client] = await Manager.Get('integrated-1');
  client.SetOnline(true);

  // Inferred faults are held while a machine boots because we deduced them.
  // This one is not deduced: the client itself is saying so, and it knows.
  const [stateErr] = await Manager.SetIntegratedState(
    'integrated-1',
    'DEGRADED',
    'Show file missing'
  );
  assert.equal(stateErr, null);
  assert.equal(client.Degraded, true);
  assert.equal(client.Initialising, false);
  assert.ok(client.DegradedWarnings.includes('Show file missing'));
});

test('a display topology reported before the client dropped is not reused after it returns', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('booth-2');

  await Manager.SetDisplayList('booth-2', [
    { DisplayID: '100', Label: 'Primary', Width: 1920, Height: 1080, RefreshRate: 60 },
  ]);
  await Manager.MarkDisplayCritical('booth-2', { DisplayID: '100' });

  let [, client] = await Manager.Get('booth-2');
  markStarted(client);
  client.SetOnline(false);
  markStarted(client);

  // The stored list still describes the previous session. It is neither trusted
  // (which would hide a projector unplugged during the reboot) nor treated as
  // absent (which would alert on hardware that is about to report in fine).
  assert.equal(client.Degraded, false);

  await Manager.SetDisplayList('booth-2', []);
  [, client] = await Manager.Get('booth-2');
  assert.equal(client.Degraded, true);
  assert.ok(client.DegradedWarnings.includes('Missing Display'));
});

test('ClientManager manages groups, ordering, and reconciliation', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.Create('c2');

  // Assign both to a group via direct DB + cache update.
  const [, c1] = await Manager.Get('c1');
  const [, c2] = await Manager.Get('c2');
  await c1.SetGroupID(7);
  await c2.SetGroupID(7);

  const inGroup = await Manager.GetClientsInGroup(7);
  assert.equal(inGroup.length, 2);

  // MoveGroupToNoGroup clears the assignment.
  const [moveErr, moved] = await Manager.MoveGroupToNoGroup(7);
  assert.equal(moveErr, null);
  assert.equal(moved, 2);
  assert.equal((await Manager.GetClientsInGroup(7)).length, 0);

  // Invalid GroupID is rejected.
  assert.match(String((await Manager.MoveGroupToNoGroup('abc'))[0]), /invalid/i);

  // Reassign and reconcile orphans (only group 7 valid -> others to null).
  // Re-fetch from the cache since MoveGroupToNoGroup may have rebuilt it.
  const [, c1c] = await Manager.Get('c1');
  const [, c2c] = await Manager.Get('c2');
  await c1c.SetGroupID(7);
  await c2c.SetGroupID(99);
  const [, changed] = await Manager.ReconcileOrphanedGroups([7]);
  assert.equal(changed, 1);

  // SetGroupOrder assigns increasing weights.
  const [orderErr] = await Manager.SetGroupOrder(7, ['c1', 'c2']);
  assert.equal(orderErr, null);
  const [, c1b] = await Manager.Get('c1');
  const [, c2b] = await Manager.Get('c2');
  assert.equal(c1b.Weight < c2b.Weight, true);

  // SetGroupOrderWithWeights honors explicit weights and validates input.
  const [weightErr] = await Manager.SetGroupOrderWithWeights(7, ['c1', 'c2'], [50, 60]);
  assert.equal(weightErr, null);
  assert.match(String((await Manager.SetGroupOrderWithWeights(7, ['c1'], [1, 2]))[0]), /mismatch/i);
  assert.match(String((await Manager.SetGroupOrder(7, 'bad'))[0]), /invalid/i);

  // GetAll returns the cached clients.
  const [, all] = await Manager.GetAll();
  assert.equal(all.length, 2);

  await Manager.ClearCache();
  void DB;
});

test('ClientManager.Timeout marks a client offline', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('t1');
  const [, client] = await Manager.Get('t1');
  client.SetOnline(true);
  await Manager.Timeout('t1');
  assert.equal(client.Online, false);

  // Timeout on a missing client is a no-op (no throw).
  await Manager.Timeout('does-not-exist');
});

test('ClientManager.ReplaceClient migrates settings and UUID references', async () => {
  const { Manager, DB } = await loadClientManager();

  await Manager.Create('legacy-client');
  const [, legacy] = await Manager.Get('legacy-client');
  await legacy.SetNickname('Front Desk');
  await legacy.SetGroupID(12);
  await legacy.SetWeight(55);
  await legacy.SetHostname('custom-host');

  await Manager.SetUSBDeviceList('legacy-client', [
    {
      SerialNumber: 'ABC123',
      ManufacturerName: 'Test',
      ProductName: 'Drive',
    },
  ]);
  await Manager.MarkUSBDeviceCritical('legacy-client', { SerialNumber: 'ABC123' });
  await Manager.MarkApplicationCritical('legacy-client', { Name: 'Spotify' });

  const scope = {
    Workspace: false,
    Groups: [],
    Clients: ['legacy-client'],
  };
  const actions = [
    {
      Type: 'http-api',
      Settings: {
        Route: '/test',
        UUID: 'legacy-client',
      },
    },
  ];
  const [ruleInsertErr] = await DB.Run(
    'INSERT INTO AlertRules (Title, Scope, TriggerType, TriggerConfig, Actions, Enabled, Timestamp, UpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'Replace Rule',
      JSON.stringify(scope),
      'CLIENT_OFFLINE',
      JSON.stringify({}),
      JSON.stringify(actions),
      1,
      Date.now(),
      Date.now(),
    ]
  );
  assert.equal(ruleInsertErr, null);

  const [replaceErr] = await Manager.ReplaceClient('legacy-client', 'replacement-client');
  assert.equal(replaceErr, null);

  assert.equal(await Manager.Exists('legacy-client'), false);
  assert.equal(await Manager.Exists('replacement-client'), true);

  const [, replacement] = await Manager.Get('replacement-client');
  assert.equal(replacement.Nickname, 'Front Desk');
  assert.equal(replacement.GroupID, 12);
  assert.equal(replacement.Weight, 55);
  assert.equal(replacement.Hostname, 'custom-host');

  assert.deepEqual(await Manager.IsUSBDeviceCritical('replacement-client', 'ABC123'), [null, true]);
  assert.deepEqual(await Manager.IsApplicationCritical('replacement-client', 'Spotify'), [
    null,
    true,
  ]);

  const [, updatedRuleRow] = await DB.Get('SELECT Scope, Actions FROM AlertRules WHERE Title = ?', [
    'Replace Rule',
  ]);
  const updatedScope = JSON.parse(updatedRuleRow.Scope);
  const updatedActions = JSON.parse(updatedRuleRow.Actions);
  assert.ok(updatedScope.Clients.includes('replacement-client'));
  assert.ok(!updatedScope.Clients.includes('legacy-client'));
  assert.equal(updatedActions[0].Settings.UUID, 'replacement-client');
});

test('ClientManager.ReplaceClient rejects replacing an online client', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('online-client');
  const [, online] = await Manager.Get('online-client');
  online.SetOnline(true);

  const [replaceErr] = await Manager.ReplaceClient('online-client', 'replacement-client');
  assert.match(String(replaceErr), /offline/i);
});

test('ClientManager.CreateUnassigned persists reserved slots with filler details', async () => {
  const { Manager, DB, events } = await loadClientManager();

  const [err, created] = await Manager.CreateUnassigned('Stage Left', 3);
  assert.equal(err, null);
  assert.equal(created.length, 3);

  // A batch is numbered so the slots are tellable apart before being renamed.
  assert.deepEqual(
    created.map((c) => c.Nickname),
    ['Stage Left 1', 'Stage Left 2', 'Stage Left 3']
  );
  // Random UUIDs: nothing will ever connect with them.
  assert.equal(new Set(created.map((c) => c.UUID)).size, 3);
  for (const slot of created) {
    assert.equal(slot.Unassigned, true);
    assert.equal(slot.OperatingSystem, 'Windows');
    assert.equal(slot.Online, false);
  }

  const [, rows] = await DB.All('SELECT * FROM Clients ORDER BY Nickname', []);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].Unassigned, 1);
  assert.equal(rows[0].Hostname, 'Stage Left 1');
  assert.equal(rows[0].Version, 'X.X.X');

  assert.ok(events.includes('ClientListChanged'));
});

test('ClientManager.CreateUnassigned keeps the bare name for a single slot', async () => {
  const { Manager } = await loadClientManager();

  const [, created] = await Manager.CreateUnassigned('FOH Mac', 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].Nickname, 'FOH Mac');
});

test('ClientManager.CreateUnassigned rejects a bad name or count', async () => {
  const { Manager } = await loadClientManager();

  assert.match(String((await Manager.CreateUnassigned('', 1))[0]), /name is required/i);
  assert.match(String((await Manager.CreateUnassigned('Rig', 0))[0]), /positive integer/i);
  assert.match(String((await Manager.CreateUnassigned('Rig', 2.5))[0]), /positive integer/i);
});

test('ClientManager re-hydrates the Unassigned flag as a boolean from sqlite', async () => {
  const { Manager } = await loadClientManager();
  await Manager.CreateUnassigned('Slot', 1);
  await Manager.Create('real-client');

  // Force a reload so the entities are rebuilt from the stored 0/1 integers.
  Manager.Initialized = false;
  await Manager.Init();

  const [, all] = await Manager.GetAll();
  const slot = all.find((c) => c.Nickname === 'Slot');
  const real = all.find((c) => c.UUID === 'real-client');
  assert.equal(slot.Unassigned, true);
  assert.equal(real.Unassigned, false);
});

test('ClientManager.ReplaceClient clears the Unassigned flag when a slot is filled', async () => {
  const { Manager, DB } = await loadClientManager();

  const [, created] = await Manager.CreateUnassigned('Spare', 1);
  const slotUUID = created[0].UUID;

  const [replaceErr, filled] = await Manager.ReplaceClient(slotUUID, 'real-device');
  assert.equal(replaceErr, null);
  assert.equal(filled.UUID, 'real-device');
  // Filling the slot promotes it to an ordinary client, in memory...
  assert.equal(filled.Unassigned, false);

  // ...and in the row, within the same transaction that re-keyed it.
  const [, row] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', ['real-device']);
  assert.equal(row.Unassigned, 0);
  assert.equal(row.Nickname, 'Spare');

  const [, oldRow] = await DB.Get('SELECT * FROM Clients WHERE UUID = ?', [slotUUID]);
  assert.equal(oldRow, undefined);
});

test('ClientManager.ReplaceClient migrates critical USB-name rows in the database', async () => {
  const { Manager, DB } = await loadClientManager();

  await Manager.Create('legacy-names');
  await Manager.MarkUSBNameCritical('legacy-names', {
    ManufacturerName: 'Acme',
    ProductName: 'Widget',
  });

  // The row lands under the old UUID.
  const [, beforeRow] = await DB.Get('SELECT UUID FROM CriticalUSBDeviceNames WHERE UUID = ?', [
    'legacy-names',
  ]);
  assert.ok(beforeRow, 'critical USB-name row should exist under the old UUID');

  const [replaceErr] = await Manager.ReplaceClient('legacy-names', 'replacement-names');
  assert.equal(replaceErr, null);

  // After the rename it must follow the client to the new UUID — not be orphaned
  // under the old one, which was the pre-fix behaviour (in-memory rekey only).
  const [, oldRow] = await DB.Get('SELECT UUID FROM CriticalUSBDeviceNames WHERE UUID = ?', [
    'legacy-names',
  ]);
  assert.equal(oldRow, undefined, 'no critical USB-name row should remain under the old UUID');

  const [, newRow] = await DB.Get('SELECT UUID FROM CriticalUSBDeviceNames WHERE UUID = ?', [
    'replacement-names',
  ]);
  assert.ok(newRow, 'critical USB-name row should be re-keyed to the new UUID');
});

test('ClientManager.Delete removes the client and every critical row atomically', async () => {
  const { Manager, DB } = await loadClientManager();

  await Manager.Create('purge-me');
  await Manager.SetUSBDeviceList('purge-me', [
    { SerialNumber: 'SER-1', ManufacturerName: 'Acme', ProductName: 'Drive' },
  ]);
  await Manager.MarkUSBDeviceCritical('purge-me', { SerialNumber: 'SER-1' });
  await Manager.MarkUSBNameCritical('purge-me', { ManufacturerName: 'Acme', ProductName: 'Drive' });
  await Manager.MarkApplicationCritical('purge-me', { Name: 'Spotify' });
  await Manager.MarkDisplayCritical('purge-me', { DisplayID: 'DISP-1' });

  const [delErr] = await Manager.Delete('purge-me');
  assert.equal(delErr, null);
  assert.equal(await Manager.Exists('purge-me'), false);

  // The client row and all four critical tables must be clear for this UUID.
  for (const table of [
    'Clients',
    'CriticalUSBDevices',
    'CriticalUSBDeviceNames',
    'CriticalApplications',
    'CriticalDisplays',
  ]) {
    const [, row] = await DB.Get(`SELECT UUID FROM ${table} WHERE UUID = ?`, ['purge-me']);
    assert.equal(row, undefined, `${table} should have no rows left for the deleted client`);
  }
});

test('ClientManager.Get adopts an uncached client into the cache so callers share one instance', async () => {
  const { Manager, DB } = await loadClientManager();

  // Insert straight into the DB so the client is absent from the cache.
  await DB.Run('INSERT INTO Clients (UUID, Hostname, Timestamp) VALUES (?, ?, ?)', [
    'adopt-1',
    'host',
    Date.now(),
  ]);

  const [firstErr, first] = await Manager.Get('adopt-1');
  assert.equal(firstErr, null);

  // Runtime-only mutation on the hydrated instance.
  first.SetOnline(true);

  // A second Get must return the same adopted instance, carrying the mutation —
  // proving Get cached the hydrated client rather than returning a fresh orphan.
  const [secondErr, second] = await Manager.Get('adopt-1');
  assert.equal(secondErr, null);
  assert.equal(second, first);
  assert.equal(second.Online, true);
});

// --- Incremental telemetry -------------------------------------------------
// A delta amends state that the corresponding full list replaces outright. The
// full list stays the authority, so the property that matters most here is that
// applying a delta leaves the client in exactly the state the equivalent full
// list would have produced — otherwise the next resync would report a spurious
// change and the two paths would fight each other forever.

test('a network interface delta adds, changes and removes interfaces', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('dev-1');

  const wifi = {
    name: 'en0',
    addresses: [{ family: 'IPv4', address: '10.0.0.5', mac: 'aa:bb', internal: false }],
  };
  const vpn = { name: 'utun0', addresses: [] };
  await Manager.SetNetworkInterfaces('dev-1', [wifi]);

  await Manager.ApplyNetworkInterfaceDelta('dev-1', { Added: [vpn], Removed: [], Changed: [] });
  let [, client] = await Manager.Get('dev-1');
  assert.deepEqual(client.NetworkInterfaces.map((i) => i.name).sort(), ['en0', 'utun0']);

  const moved = {
    name: 'en0',
    addresses: [{ family: 'IPv4', address: '10.0.0.99', mac: 'aa:bb', internal: false }],
  };
  await Manager.ApplyNetworkInterfaceDelta('dev-1', { Added: [], Removed: [], Changed: [moved] });
  [, client] = await Manager.Get('dev-1');
  assert.equal(
    client.NetworkInterfaces.find((i) => i.name === 'en0').addresses[0].address,
    '10.0.0.99'
  );

  await Manager.ApplyNetworkInterfaceDelta('dev-1', { Added: [], Removed: ['utun0'], Changed: [] });
  [, client] = await Manager.Get('dev-1');
  assert.deepEqual(
    client.NetworkInterfaces.map((i) => i.name),
    ['en0']
  );
});

test('a network delta and the equivalent full list leave identical state', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('dev-1');
  await Manager.Create('dev-2');

  const wifi = {
    name: 'en0',
    addresses: [{ family: 'IPv4', address: '10.0.0.5', mac: 'aa:bb', internal: false }],
  };
  const vpn = { name: 'utun0', addresses: [] };

  await Manager.SetNetworkInterfaces('dev-1', [wifi]);
  await Manager.ApplyNetworkInterfaceDelta('dev-1', { Added: [vpn], Removed: [], Changed: [] });
  await Manager.SetNetworkInterfaces('dev-2', [wifi, vpn]);

  const [, viaDelta] = await Manager.Get('dev-1');
  const [, viaFullList] = await Manager.Get('dev-2');
  // Both paths normalise through the same helper precisely so this holds; if it
  // ever stopped holding, every resync would look like a change.
  assert.deepEqual(viaDelta.NetworkInterfaces, viaFullList.NetworkInterfaces);
});

test('a display delta merges by DisplayID', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('dev-1');

  await Manager.SetDisplayList('dev-1', [{ DisplayID: 'edid:A', Width: 1920 }]);
  await Manager.ApplyDisplayDelta('dev-1', {
    Added: [{ DisplayID: 'edid:B', Width: 2560 }],
    Removed: [],
    Changed: [],
  });
  let [, client] = await Manager.Get('dev-1');
  assert.deepEqual(client.ConnectedDisplayList.map((d) => d.DisplayID).sort(), [
    'edid:A',
    'edid:B',
  ]);

  await Manager.ApplyDisplayDelta('dev-1', { Added: [], Removed: ['edid:A'], Changed: [] });
  [, client] = await Manager.Get('dev-1');
  assert.deepEqual(
    client.ConnectedDisplayList.map((d) => d.DisplayID),
    ['edid:B']
  );
});

test('an application delta raises the same start and stop events as a full snapshot', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('dev-1');

  await Manager.SetRunningApplications('dev-1', {
    SampledAt: 1,
    TotalCount: 2,
    Truncated: false,
    Items: [
      { Name: 'Safari', Count: 1 },
      { Name: 'Code', Count: 1 },
    ],
    Status: { State: 'ok', Message: null, Platform: 'darwin' },
  });
  const before = events.filter((e) => e === 'ApplicationStarted').length;

  await Manager.ApplyApplicationDelta('dev-1', {
    Started: [{ Name: 'QLab', Count: 1 }],
    Stopped: ['code'],
    Changed: [],
    SampledAt: 2,
    TotalCount: 2,
    Truncated: false,
    Status: { State: 'ok', Message: null, Platform: 'darwin' },
  });

  // These are the events the alert rules hang off, so a delta has to raise them
  // just as the snapshot diff does.
  assert.equal(events.filter((e) => e === 'ApplicationStarted').length, before + 1);
  assert.ok(events.includes('ApplicationStopped'));

  const [, client] = await Manager.Get('dev-1');
  assert.deepEqual(client.ObservedRunningApplications.Items.map((i) => i.Name).sort(), [
    'QLab',
    'Safari',
  ]);
  // Stopped is matched case-insensitively: the client sends the lower-cased key.
  assert.equal(
    client.ObservedRunningApplications.Items.some((i) => i.Name === 'Code'),
    false
  );
});

test('a full snapshot after an applied delta reports no further changes', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('dev-1');

  const status = { State: 'ok', Message: null, Platform: 'darwin' };
  await Manager.SetRunningApplications('dev-1', {
    SampledAt: 1,
    TotalCount: 1,
    Truncated: false,
    Items: [{ Name: 'Safari', Count: 1 }],
    Status: status,
  });
  await Manager.ApplyApplicationDelta('dev-1', {
    Started: [{ Name: 'QLab', Count: 1 }],
    Stopped: [],
    Changed: [],
    SampledAt: 2,
    TotalCount: 2,
    Truncated: false,
    Status: status,
  });
  const afterDelta = events.filter((e) => e === 'ApplicationStarted').length;

  // The 60s resync carries the same state the delta already produced. If the
  // delta path stored a different signature or ordering, this would re-fire
  // every alert once a minute forever.
  await Manager.SetRunningApplications('dev-1', {
    SampledAt: 3,
    TotalCount: 2,
    Truncated: false,
    Items: [
      { Name: 'QLab', Count: 1 },
      { Name: 'Safari', Count: 1 },
    ],
    Status: status,
  });
  assert.equal(events.filter((e) => e === 'ApplicationStarted').length, afterDelta);
});

test('an application count change is applied without raising a start', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('dev-1');

  const status = { State: 'ok', Message: null, Platform: 'darwin' };
  await Manager.SetRunningApplications('dev-1', {
    SampledAt: 1,
    TotalCount: 1,
    Truncated: false,
    Items: [{ Name: 'Safari', Count: 1 }],
    Status: status,
  });
  const before = events.filter((e) => e === 'ApplicationStarted').length;

  await Manager.ApplyApplicationDelta('dev-1', {
    Started: [],
    Stopped: [],
    Changed: [{ Name: 'Safari', Count: 3 }],
    SampledAt: 2,
    TotalCount: 1,
    Truncated: false,
    Status: status,
  });

  const [, client] = await Manager.Get('dev-1');
  assert.equal(client.ObservedRunningApplications.Items[0].Count, 3);
  assert.equal(
    events.filter((e) => e === 'ApplicationStarted').length,
    before,
    'a second window of an already-running app is not a start'
  );
});
