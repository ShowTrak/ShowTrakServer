const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');

// The per-client ingress hot path through the real ClientManager and a real
// (throwaway) SQLite database: what a repeated report costs (nothing reaches
// the push pipeline), which references stay stable across an unchanged
// heartbeat, and how a heartbeat from a machine that is not in the show is
// answered once the cache is authoritative.

function loggerStub() {
  const noop = () => {};
  return { CreateLogger: () => new Proxy({}, { get: () => noop }) };
}

async function loadClientManager() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-ingress-db-'));
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
  await dbModule.Manager.Ready();
  const events = [];
  const clientManager = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../DB': dbModule,
      '../Broadcast': { Manager: { emit: (event, ...args) => events.push([event, ...args]) } },
      '../SettingsManager': { Manager: { GetValue: async () => undefined } },
    }
  );
  return { Manager: clientManager.Manager, DB: dbModule.Manager, events };
}

const updates = (events) => events.filter((e) => e[0] === 'ClientUpdated').length;

function heartbeat(cpu = 10) {
  return {
    Version: '3.28.2',
    ScriptsFingerprint: null,
    Vitals: {
      CPU: { UsagePercentage: cpu },
      Ram: { Total: 16e9, Used: 6e9, UsagePercentage: '40.00' },
      Uptime: { Formatted: '01:00:00', Seconds: 3600 },
    },
  };
}

async function onlineClient(Manager, UUID = 'ingress-1') {
  const [CreateErr] = await Manager.Create(UUID);
  assert.equal(CreateErr, null);
  const [HbErr] = await Manager.Heartbeat(UUID, heartbeat(), '10.0.0.5');
  assert.equal(HbErr, null);
  const [, Client] = await Manager.Get(UUID);
  Client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  Client._refreshClientHealthState();
  return Client;
}

const usb = () => [
  { ManufacturerName: 'Vendor', ProductName: 'Dongle', SerialNumber: 'SN-1', Location: '1-1' },
];
const displays = () => [
  {
    DisplayID: 'edid:A',
    Label: 'Main',
    ScreenNumber: 1,
    Width: 1920,
    Height: 1080,
    RefreshRate: 60,
    ScaleFactor: 1,
    Rotation: 0,
    Primary: true,
  },
];
const interfaces = () => [
  {
    name: 'Ethernet',
    addresses: [
      {
        family: 'IPv4',
        address: '10.0.0.5',
        netmask: '255.255.255.0',
        cidr: '10.0.0.5/24',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        scopeid: null,
      },
    ],
    gateway: '10.0.0.1',
  },
];
const audio = (SampledAt) => ({
  SampledAt,
  Status: { State: 'ok', Message: null },
  Endpoints: [{ EndpointID: 'ep-1', Name: 'Speakers', Flow: 'output', IsDefault: true }],
});
const storage = (SampledAt) => ({
  SampledAt,
  Status: { State: 'ok', Message: null },
  Volumes: [{ MountPoint: 'C:', Name: 'System', TotalBytes: 100, FreeBytes: 50 }],
});
const power = (SampledAt) => ({
  SampledAt,
  Status: { State: 'ok', Message: null },
  OnBattery: false,
  Battery: null,
  LastSuspendAt: null,
  LastResumeAt: null,
});
const temps = (SampledAt) => ({
  SampledAt,
  Status: { State: 'ok', Message: null },
  Sensors: [{ Name: 'CPU', Kind: 'cpu', Celsius: 50 }],
  ThermalState: 'nominal',
});
const apps = (SampledAt, NoChanges = false) => ({
  SampledAt,
  TotalCount: 2,
  Truncated: false,
  Items: NoChanges
    ? []
    : [
        { Name: 'show.exe', Count: 1 },
        { Name: 'helper.exe', Count: 1 },
      ],
  Status: { State: 'ok', Message: null, Platform: 'win32' },
  ...(NoChanges ? { NoChanges: true } : {}),
});

test('a periodic resync that repeats the stored report changes and announces nothing', async () => {
  const { Manager, events } = await loadClientManager();
  const Client = await onlineClient(Manager);

  await Manager.SetUSBDeviceList(Client.UUID, usb());
  await Manager.SetDisplayList(Client.UUID, displays());
  await Manager.SetNetworkInterfaces(Client.UUID, interfaces());
  await Manager.SetAudioDevices(Client.UUID, audio(1000));
  await Manager.SetStorageVolumes(Client.UUID, storage(1000));
  await Manager.SetPowerStatus(Client.UUID, power(1000));
  await Manager.SetTemperatures(Client.UUID, temps(1000));
  await Manager.SetRunningApplications(Client.UUID, apps(1000));

  const Views = {
    USB: Client.USBDeviceList,
    Display: Client.DisplayList,
    Network: Client.NetworkStatus,
    Audio: Client.AudioDevices,
    Storage: Client.StorageStatus,
    Power: Client.PowerStatus,
    Temps: Client.Temperatures,
    Apps: Client.RunningApplications,
    Warnings: Client.DegradedWarnings,
  };
  const Before = updates(events);

  // The same reports again, a minute later.
  const Step = async (Name, Fn) => {
    const N = updates(events);
    await Fn();
    assert.equal(updates(events), N, `${Name} announced a repeated report`);
  };
  await Step('usb', () => Manager.SetUSBDeviceList(Client.UUID, usb()));
  await Step('display', () => Manager.SetDisplayList(Client.UUID, displays()));
  await Step('net', () => Manager.SetNetworkInterfaces(Client.UUID, interfaces()));
  await Step('audio', () => Manager.SetAudioDevices(Client.UUID, audio(2000)));
  await Step('storage', () => Manager.SetStorageVolumes(Client.UUID, storage(2000)));
  await Step('power', () => Manager.SetPowerStatus(Client.UUID, power(2000)));
  await Step('temps', () => Manager.SetTemperatures(Client.UUID, temps(2000)));
  await Step('apps', () => Manager.SetRunningApplications(Client.UUID, apps(2000)));
  // And the 20-second "nothing changed" keepalive.
  await Manager.SetRunningApplications(Client.UUID, apps(3000, true));

  assert.equal(updates(events), Before, 'no ClientUpdated for a report that changes nothing');
  assert.equal(Client.USBDeviceList, Views.USB);
  assert.equal(Client.DisplayList, Views.Display);
  assert.equal(Client.NetworkStatus, Views.Network);
  assert.equal(Client.AudioDevices, Views.Audio);
  assert.equal(Client.StorageStatus, Views.Storage);
  assert.equal(Client.PowerStatus, Views.Power);
  assert.equal(Client.Temperatures, Views.Temps);
  assert.equal(Client.RunningApplications, Views.Apps);
  assert.equal(Client.DegradedWarnings, Views.Warnings);
  // The sample time still moves (in place), so a "last sampled" reading is current.
  assert.equal(Client.AudioDevices.SampledAt, 2000);
  assert.equal(Client.StorageStatus.SampledAt, 2000);
  assert.equal(Client.PowerStatus.SampledAt, 2000);
  assert.equal(Client.RunningApplications.SampledAt, 3000);
});

test('a changed report after a repeat is applied and announced as before', async () => {
  const { Manager, events } = await loadClientManager();
  const Client = await onlineClient(Manager);
  await Manager.SetUSBDeviceList(Client.UUID, usb());
  await Manager.SetUSBDeviceList(Client.UUID, usb());
  const Before = updates(events);
  const View = Client.USBDeviceList;

  const Next = usb();
  Next.push({ ManufacturerName: 'Vendor', ProductName: 'Pad', SerialNumber: 'SN-2' });
  await Manager.SetUSBDeviceList(Client.UUID, Next);
  assert.equal(updates(events), Before + 1);
  assert.notEqual(Client.USBDeviceList, View);
  assert.equal(Client.ConnectedUSBDeviceList.length, 2);

  // An add/remove event in between means the next full list is applied whatever
  // it says, even if it repeats the last full list.
  await Manager.USBDeviceRemoved(Client.UUID, { SerialNumber: 'SN-2' });
  assert.equal(Client.ConnectedUSBDeviceList.length, 1);
  await Manager.SetUSBDeviceList(Client.UUID, Next);
  assert.equal(Client.ConnectedUSBDeviceList.length, 2, 'the resync restores the device');
});

test('a reconnect re-applies the first report of every domain', async () => {
  const { Manager, events } = await loadClientManager();
  const Client = await onlineClient(Manager);
  await Manager.SetDisplayList(Client.UUID, displays());
  Client.SetOnline(false);
  assert.equal(Client.HasDisplayTelemetry, false);
  await Manager.Heartbeat(Client.UUID, heartbeat(), '10.0.0.5');
  const Before = updates(events);
  await Manager.SetDisplayList(Client.UUID, displays());
  assert.equal(Client.HasDisplayTelemetry, true, 'the same list is evidence on the new connection');
  assert.equal(updates(events), Before + 1);
});

test('an unchanged heartbeat keeps ResourceAlarms and DegradedWarnings by reference', async () => {
  const { Manager } = await loadClientManager();
  const Client = await onlineClient(Manager);
  const Alarms = Client.ResourceAlarms;
  const Warnings = Client.DegradedWarnings;
  await Manager.Heartbeat(Client.UUID, heartbeat(12), '10.0.0.5');
  await Manager.Heartbeat(Client.UUID, heartbeat(14), '10.0.0.5');
  assert.equal(Client.ResourceAlarms, Alarms);
  assert.equal(Client.DegradedWarnings, Warnings);
});

test('an active alarm publishes a copy whose reading follows the heartbeats', async () => {
  const { Manager } = await loadClientManager();
  const Client = await onlineClient(Manager);
  const [MarkErr] = await Manager.MarkSystemCheck(Client.UUID, {
    Key: 'cpu',
    MaxPercent: 50,
    SustainSeconds: 0,
  });
  assert.equal(MarkErr, null);
  await Manager.Heartbeat(Client.UUID, heartbeat(90), '10.0.0.5');
  assert.equal(Client.ResourceAlarms.length, 1);
  const First = Client.ResourceAlarms;
  assert.equal(First[0].Value, 90);

  await Manager.Heartbeat(Client.UUID, heartbeat(95), '10.0.0.5');
  assert.notEqual(Client.ResourceAlarms, First, 'a new reading is a new list');
  assert.equal(Client.ResourceAlarms[0].Value, 95);
  assert.equal(First[0].Value, 90, 'a published list is never changed afterwards');

  await Manager.Heartbeat(Client.UUID, heartbeat(95), '10.0.0.5');
  const Same = Client.ResourceAlarms;
  await Manager.Heartbeat(Client.UUID, heartbeat(95), '10.0.0.5');
  assert.equal(Client.ResourceAlarms, Same, 'the same reading keeps the list');
});

test('once the cache is loaded, an unknown client is answered without the database', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Init();
  let Queries = 0;
  const RealGet = DB.Get;
  DB.Get = async (...args) => {
    Queries += 1;
    return RealGet(...args);
  };
  try {
    const [Err] = await Manager.Heartbeat('not-in-this-show', heartbeat(), '10.0.0.9');
    assert.equal(Err, 'Client Not Valid');
    assert.equal(await Manager.Exists('not-in-this-show'), false);
    const [GetErr] = await Manager.Get('not-in-this-show');
    assert.equal(GetErr, 'Client Not Found');
    assert.equal(Queries, 0);
  } finally {
    DB.Get = RealGet;
  }

  // A client created later is in the cache, so it is found.
  await Manager.Create('created-later');
  assert.equal(await Manager.Exists('created-later'), true);
});

test('before the cache is loaded (and after it is cleared) a miss still asks the database', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Init();
  await Manager.Create('in-db');
  await Manager.ClearCache();
  let Queries = 0;
  const RealGet = DB.Get;
  DB.Get = async (...args) => {
    Queries += 1;
    return RealGet(...args);
  };
  try {
    assert.equal(await Manager.Exists('in-db'), true);
    assert.ok(Queries > 0, 'a cleared cache is not authoritative');
  } finally {
    DB.Get = RealGet;
  }
});
