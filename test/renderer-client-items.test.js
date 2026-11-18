// The list view's monitored-item rows under an expanded ShowTrak client
// (src/UI/js/app/lib/client-items.ts). What is at stake:
//
//   - every item the client's view modal shows on its Status tab must have a
//     row, and nothing unmonitored may: the list and the modal must agree;
//   - each row's key must match the key the server files its series under
//     (status-history-overview.ts), or the row's graph is grey for ever;
//   - the State word must agree with the row's colour class, or a red row reads
//     "Healthy".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const Items = require(path.join(APP, 'lib', 'client-items.js'));

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;

function Client(Overrides = {}) {
  return {
    UUID: 'c1',
    Online: true,
    SystemChecks: { Cpu: { MaxPercent: 90, SustainSeconds: 60 } },
    Vitals: { CPU: { UsagePercentage: 12 }, Ram: { UsagePercentage: 40 } },
    RunningApplications: {
      Status: { State: 'ok' },
      Items: [
        { IsCritical: true, Key: 'qlab', Name: 'QLab', IsRunning: false },
        { IsCritical: false, Key: 'finder', Name: 'Finder', IsRunning: true },
      ],
    },
    USBDeviceList: [
      {
        IsCritical: true,
        SerialNumber: 'SN1',
        ManufacturerName: 'Elgato',
        ProductName: 'Stream Deck',
        Issues: [],
      },
      { IsCritical: false, SerialNumber: 'SN2', ProductName: 'Mouse' },
      {
        IsCritical: true,
        IsCriticalByName: true,
        NameKey: 'Gamepad',
        ProductName: 'Gamepad',
        Quantity: 2,
        Issues: [],
      },
      {
        IsCritical: true,
        IsCriticalByName: true,
        NameKey: 'gamepad',
        ProductName: 'Gamepad',
        Quantity: 2,
        Issues: [],
      },
    ],
    StorageStatus: {
      Volumes: [
        {
          MountPoint: '/Volumes/Media',
          Name: 'Media',
          IsConnected: true,
          IsCritical: true,
          Missing: false,
          Issues: [{ Kind: 'free_percent', Message: 'Low on space' }],
          Critical: null,
          FreeBytes: 1,
          TotalBytes: 10,
        },
        {
          MountPoint: '/',
          Name: 'Macintosh HD',
          IsConnected: true,
          IsCritical: false,
          Missing: false,
          Issues: [],
          Critical: null,
        },
      ],
    },
    NetworkStatus: {
      Interfaces: [
        {
          Name: 'en0',
          IsCritical: true,
          IsConnected: true,
          Missing: false,
          Issues: [],
          Addresses: [{ address: '10.0.0.5', family: 'IPv4', cidr: '10.0.0.5/24' }],
        },
      ],
    },
    ...Overrides,
  };
}

test("only monitored items get rows, in the Status tab's order, keyed as the server files them", () => {
  const Rows = Items.ClientMonitoredItems(Client());
  assert.deepEqual(
    Rows.map((Row) => Row.Key),
    [
      'system:cpu',
      'app:qlab',
      'usb:SN1',
      'usb:usbname:gamepad',
      'net:en0',
      'storage:/Volumes/Media',
    ]
  );
});

test('each row says what it is, where it is and how it is', () => {
  const ByKey = new Map(Items.ClientMonitoredItems(Client()).map((Row) => [Row.Key, Row]));
  assert.deepEqual(
    [ByKey.get('app:qlab').State, ByKey.get('app:qlab').Label],
    ['OFFLINE', 'Not Running']
  );
  assert.equal(ByKey.get('usb:SN1').Name, 'Elgato Stream Deck');
  assert.equal(ByKey.get('usb:SN1').Address, 'SN1');
  assert.equal(ByKey.get('usb:SN1').State, 'ONLINE');
  assert.equal(ByKey.get('usb:usbname:gamepad').Address, '2 expected');
  assert.equal(ByKey.get('net:en0').Address, '10.0.0.5');
  assert.equal(ByKey.get('net:en0').Kind, 'Network Interface');
  assert.deepEqual(
    [ByKey.get('storage:/Volumes/Media').State, ByKey.get('storage:/Volumes/Media').Label],
    ['DEGRADED', 'Low on space']
  );
  assert.equal(ByKey.get('storage:/Volumes/Media').Address, '/Volumes/Media');
});

test('an offline client judges nothing: every row is idle', () => {
  const Rows = Items.ClientMonitoredItems(Client({ Online: false }));
  assert.ok(Rows.length > 0);
  for (const Row of Rows) assert.equal(Row.State, 'IDLE', Row.Key);
});

test('applications are not judged while their collector is not reporting', () => {
  const Rows = Items.ClientMonitoredItems(
    Client({
      RunningApplications: {
        Status: { State: 'denied' },
        Items: [{ IsCritical: true, Key: 'qlab', Name: 'QLab', IsRunning: false }],
      },
    })
  );
  const App = Rows.find((Row) => Row.Key === 'app:qlab');
  assert.equal(App.State, 'IDLE');
});

test('the state word and the colour class agree', () => {
  assert.deepEqual(
    ['ONLINE', 'DEGRADED', 'OFFLINE', 'IDLE'].map((State) => [
      Items.ClientItemStateWord(State),
      Items.ClientItemStateClass(State),
    ]),
    [
      ['Healthy', 'ONLINE'],
      ['Degraded', 'DEGRADED'],
      ['Failed', ''],
      ['Idle', 'IDLE'],
    ]
  );
});

test('each current item of a named client gets a timeline; others none', () => {
  const C = Client();
  const Blocks = Items.BuildClientItemHistoryBlocks(
    { c1: { 'app:qlab': [{ ts: NOW - 5 * MINUTE, online: false, degraded: false }] } },
    [C, Client({ UUID: 'c2' })],
    NOW
  );
  const Keys = [...Blocks.keys()];
  assert.ok(
    Keys.every((Key) => Key.startsWith('item:c1:')),
    'c2 was not read'
  );
  assert.equal(Keys.length, Items.ClientMonitoredItems(C).length, 'items with no samples too');
  assert.ok(Blocks.get('item:c1:app:qlab').some((Block) => Block.state === 'OFFLINE'));
  assert.equal(Items.BuildClientItemHistoryBlocks(undefined, [C], NOW).size, 0);
});

test('the shape changes when an item is marked or unmarked, not when it changes state', () => {
  const Before = Items.ClientItemsShapeKey(Items.ClientMonitoredItems(Client()));
  const Running = Client();
  Running.RunningApplications.Items[0].IsRunning = true;
  assert.equal(Items.ClientItemsShapeKey(Items.ClientMonitoredItems(Running)), Before);
  const Unmarked = Client();
  Unmarked.USBDeviceList[0].IsCritical = false;
  assert.notEqual(Items.ClientItemsShapeKey(Items.ClientMonitoredItems(Unmarked)), Before);
});

// --- FreeKiosk terminals ---------------------------------------------------------
//
// A terminal's items are its MONITORED readings: a check armed, in a section
// that is monitored, meaning something in the declared display mode. The same
// rule as its view modal's Status tab, which never shows a reading its own tab
// would hide.

const Catalogue = {
  Sections: ['Battery', 'Content'],
  Groups: [
    { Key: 'Battery', Label: 'Battery', DefaultOn: true },
    { Key: 'Content', Label: 'Content', DefaultOn: true },
  ],
  AlarmFields: [],
  Metrics: [
    {
      Key: 'battery_level',
      Label: 'Battery Level',
      Type: 'number',
      Section: 'Battery',
      Chart: 'line',
      Unit: '%',
      Operators: ['below', 'above'],
      DefaultOperator: 'below',
    },
    {
      Key: 'battery_charging',
      Label: 'Charging',
      Type: 'boolean',
      Section: 'Battery',
      Chart: 'blocks',
      Operators: ['isNot'],
    },
    {
      Key: 'webview_url',
      Label: 'Current URL',
      Type: 'string',
      Section: 'Content',
      Chart: 'blocks',
      RequiresMode: ['webview'],
      Operators: ['notContains'],
    },
  ],
};

function Terminal(Overrides = {}) {
  return {
    UUID: 'k1',
    Online: true,
    Settings: {
      A_battery_level_On: true,
      A_battery_level_Op: 'below',
      A_battery_level_V: 20,
      A_webview_url_On: true,
      A_webview_url_Op: 'notContains',
      A_webview_url_V: 'show',
    },
    Metrics: { battery_level: 12, battery_charging: true, webview_url: 'https://x/show' },
    Alarms: [{ Key: 'battery_level', Label: 'Battery Level', Value: 12, Reason: '' }],
    ...Overrides,
  };
}

test('a terminal lists only its armed readings, in registry order', () => {
  const Rows = Items.FreeKioskMonitoredItems(Terminal(), Catalogue);
  assert.deepEqual(
    Rows.map((Row) => [Row.Key, Row.Name, Row.Kind]),
    [
      ['battery_level', 'Battery Level', 'Battery'],
      ['webview_url', 'Current URL', 'Content'],
    ]
  );
  assert.equal(Items.FreeKioskMonitoredItems(Terminal(), null).length, 0, 'no catalogue yet');
});

test('a breaching reading is degraded and says what it should have been', () => {
  const [Battery, Url] = Items.FreeKioskMonitoredItems(Terminal(), Catalogue);
  assert.equal(Battery.State, 'DEGRADED');
  assert.match(Battery.Label, /expected at least 20/);
  assert.equal(Url.State, 'ONLINE');
  const Offline = Items.FreeKioskMonitoredItems(Terminal({ Online: false }), Catalogue);
  assert.ok(
    Offline.every((Row) => Row.State === 'IDLE'),
    'offline is unknown, not faulty'
  );
});

test('a switched-off section or another display mode hides its readings', () => {
  const Off = Terminal();
  Off.Settings = { ...Off.Settings, G_Battery_On: false };
  assert.deepEqual(
    Items.FreeKioskMonitoredItems(Off, Catalogue).map((Row) => Row.Key),
    ['webview_url']
  );
  const App = Terminal();
  App.Settings = { ...App.Settings, DisplayMode: 'external_app' };
  assert.deepEqual(
    Items.FreeKioskMonitoredItems(App, Catalogue).map((Row) => Row.Key),
    ['battery_level']
  );
});

test("a terminal's readings get timelines under its kiosk: owner id, coloured by breach", () => {
  const Blocks = Items.BuildFreeKioskItemHistoryBlocks(
    {
      k1: {
        battery_level: [{ ts: NOW - 5 * MINUTE, ok: true, n: 12, s: null, breach: true }],
      },
    },
    [Terminal()],
    Catalogue,
    NOW
  );
  assert.deepEqual(
    [...Blocks.keys()],
    ['item:kiosk:k1:battery_level', 'item:kiosk:k1:webview_url']
  );
  const Battery = Blocks.get('item:kiosk:k1:battery_level');
  // The one sample is carried forward to now, so the run is degraded, not grey.
  assert.ok(Battery.slice(-3).every((Block) => Block.state === 'DEGRADED'));
});
