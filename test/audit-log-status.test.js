const test = require('node:test');
const assert = require('node:assert/strict');

// What the audit log records as a status change: each entity's top-level state
// and the things monitored on it, never unmonitored hardware, never a
// heartbeat that changes nothing. Each diff is pure, so a scenario is a series
// of snapshots fed through it.
const {
  DiffClientStatus,
  DiffDummyStatus,
  DiffFreeKioskStatus,
  DiffMonitorStatus,
  DescribeDisplayMode,
} = require('../dist/Modules/AuditLog/status');

const Text = (Entry) => Entry.Summary.map((Segment) => Segment.T).join('');
const Texts = (Entries) => Entries.map(Text);

// Feed snapshots through a diff in order, returning the entries each produced.
function run(Diff, Snapshots) {
  let State;
  return Snapshots.map((Snapshot) => {
    const Result = Diff(State, Snapshot);
    State = Result.State;
    return Texts(Result.Entries);
  });
}

function client(Overrides = {}) {
  return {
    UUID: 'c-1',
    Nickname: 'CONSOLE-01',
    Online: true,
    Degraded: false,
    DegradedWarnings: [],
    Initialising: false,
    HasUSBTelemetry: true,
    HasDisplayTelemetry: true,
    HasAudioTelemetry: true,
    HasNetworkTelemetry: true,
    HasApplicationTelemetry: true,
    USBDeviceList: [],
    DisplayList: [],
    AudioDevices: { Endpoints: [] },
    NetworkStatus: { Interfaces: [] },
    RunningApplications: { Items: [], Status: { State: 'ok' } },
    ResourceAlarms: [],
    ...Overrides,
  };
}

const MOUSE = {
  ProductName: 'Logitech Mouse',
  SerialNumber: 'abc123',
  IsCritical: true,
  IsConnected: true,
  Location: '1-1',
  Issues: [],
};

test('a client connecting, dropping and coming back', () => {
  assert.deepEqual(
    run(DiffClientStatus, [
      client({ Online: false }),
      client(),
      client(),
      client({ Online: false }),
      client(),
    ]),
    [[], ['CONSOLE-01 Connected'], [], ['CONSOLE-01 Disconnected'], ['CONSOLE-01 Reconnected']]
  );
});

test('a heartbeat that changes nothing records nothing', () => {
  const Snapshots = Array.from({ length: 50 }, () => client({ USBDeviceList: [MOUSE] }));
  const Produced = run(DiffClientStatus, Snapshots).flat();
  assert.deepEqual(Produced, ['CONSOLE-01 Connected']);
});

test('a monitored USB device moving, unplugging and coming back', () => {
  assert.deepEqual(
    run(DiffClientStatus, [
      client({ USBDeviceList: [MOUSE] }),
      client({ USBDeviceList: [{ ...MOUSE, Location: '1-3' }] }),
      client({ USBDeviceList: [{ ...MOUSE, IsConnected: false, Location: null }] }),
      client({ USBDeviceList: [{ ...MOUSE, Location: '1-3' }] }),
    ]),
    [
      ['CONSOLE-01 Connected'],
      ['Logitech Mouse moved from Bus 1 · Port 1 → Bus 1 · Port 3'],
      ['Logitech Mouse Disconnected'],
      ['Logitech Mouse Reconnected'],
    ]
  );
});

test('the device and port names are highlighted segments', () => {
  const { State } = DiffClientStatus(undefined, client({ USBDeviceList: [MOUSE] }));
  const { Entries } = DiffClientStatus(
    State,
    client({ USBDeviceList: [{ ...MOUSE, Location: '1-3' }] })
  );
  assert.deepEqual(Entries[0].Summary, [
    { T: 'Logitech Mouse', H: 'device' },
    { T: ' moved from ' },
    { T: 'Bus 1 · Port 1', H: 'value' },
    { T: ' → ' },
    { T: 'Bus 1 · Port 3', H: 'value' },
  ]);
  assert.equal(Entries[0].EntityType, 'client');
  assert.equal(Entries[0].EntityID, 'c-1');
  assert.equal(Entries[0].Category, 'status');
});

test('unmonitored USB devices coming and going are not logged', () => {
  const Keyboard = {
    ProductName: 'Keyboard',
    SerialNumber: 'K1',
    IsCritical: false,
    IsConnected: true,
  };
  assert.deepEqual(
    run(DiffClientStatus, [
      client({ USBDeviceList: [Keyboard] }),
      client({ USBDeviceList: [] }),
      client({ USBDeviceList: [{ ...Keyboard, Location: '2-1' }] }),
    ]).slice(1),
    [[], []]
  );
});

test('a monitored device missing when the client first reports is logged once', () => {
  const Missing = { ...MOUSE, IsConnected: false, Location: null };
  assert.deepEqual(
    run(DiffClientStatus, [
      client({ USBDeviceList: [Missing] }),
      client({ USBDeviceList: [Missing] }),
    ]),
    [['CONSOLE-01 Connected', 'Logitech Mouse Not Connected'], []]
  );
});

test('a device unplugged while the client was offline is reported when it reports again', () => {
  assert.deepEqual(
    run(DiffClientStatus, [
      client({ USBDeviceList: [MOUSE] }),
      client({ Online: false }),
      // Reconnected but has not reported its USB devices yet: nothing to judge.
      client({ HasUSBTelemetry: false, USBDeviceList: [{ ...MOUSE, IsConnected: false }] }),
      client({ USBDeviceList: [{ ...MOUSE, IsConnected: false, Location: null }] }),
    ]),
    [
      ['CONSOLE-01 Connected'],
      ['CONSOLE-01 Disconnected'],
      ['CONSOLE-01 Reconnected'],
      ['Logitech Mouse Disconnected'],
    ]
  );
});

test('the start-up window holds monitored-item changes until it publishes', () => {
  assert.deepEqual(
    run(DiffClientStatus, [
      client({ USBDeviceList: [MOUSE] }),
      client({ Initialising: true, USBDeviceList: [{ ...MOUSE, IsConnected: false }] }),
      // Enumerated in time: nothing happened as far as the log is concerned.
      client({ USBDeviceList: [MOUSE] }),
    ]),
    [['CONSOLE-01 Connected'], [], []]
  );
});

test('a monitored condition breaking and clearing', () => {
  const Wrong = {
    ...MOUSE,
    Issues: [
      { Kind: 'location', Message: 'Plugged into Bus 1 · Port 3 (expected Bus 1 · Port 1)' },
    ],
  };
  const [, Broken, Fixed] = (() => {
    let State;
    return [
      client({ USBDeviceList: [MOUSE] }),
      client({ USBDeviceList: [Wrong] }),
      client({ USBDeviceList: [MOUSE] }),
    ].map((Snapshot) => {
      const Result = DiffClientStatus(State, Snapshot);
      State = Result.State;
      return Result.Entries;
    });
  })();
  assert.deepEqual(Texts(Broken), [
    'Logitech Mouse: Plugged into Bus 1 · Port 3 (expected Bus 1 · Port 1)',
  ]);
  assert.equal(Broken[0].Severity, 'warning');
  assert.deepEqual(Texts(Fixed), ['Logitech Mouse back to normal']);
  assert.equal(Fixed[0].Severity, 'success');
});

test('a monitored display changing mode reads as a configuration change', () => {
  const Display = {
    DisplayID: 'edid:1',
    Label: 'LG Ultrafine',
    IsCritical: true,
    IsConnected: true,
    Width: 1920,
    Height: 1080,
    RefreshRate: 60,
    ScaleFactor: 1,
    Rotation: 0,
    Primary: true,
    Issues: [],
  };
  const { State } = DiffClientStatus(undefined, client({ DisplayList: [Display] }));
  const { Entries } = DiffClientStatus(
    State,
    client({ DisplayList: [{ ...Display, RefreshRate: 30 }] })
  );
  assert.deepEqual(Texts(Entries), ['LG Ultrafine configuration changed']);
  assert.deepEqual(Entries[0].Details, ['1920×1080 @ 60 Hz, primary → 1920×1080 @ 30 Hz, primary']);
});

test('display modes are described for reading', () => {
  assert.equal(
    DescribeDisplayMode({
      Width: 3840,
      Height: 2160,
      RefreshRate: 59.94,
      ScaleFactor: 2,
      Rotation: 90,
      Primary: false,
    }),
    '3840×2160 @ 60 Hz, 2× scale, rotated 90°'
  );
  assert.equal(DescribeDisplayMode({ Width: 0, Height: 0 }), null);
});

test('monitored network interfaces and applications', () => {
  const Iface = (Address, Connected = true) => ({
    Name: 'en0',
    IsCritical: true,
    IsConnected: Connected,
    Addresses: Address ? [{ family: 'IPv4', address: Address, internal: false }] : [],
    Issues: [],
  });
  const App = (Running, Responding = true) => ({
    Key: 'qlab',
    Name: 'QLab',
    IsCritical: true,
    IsRunning: Running,
    RequireResponding: true,
    Responding,
  });
  const At = (Interfaces, Items) =>
    client({
      NetworkStatus: { Interfaces },
      RunningApplications: { Items, Status: { State: 'ok' } },
    });
  assert.deepEqual(
    run(DiffClientStatus, [
      At([Iface('10.0.0.5')], [App(true)]),
      At([Iface('10.0.0.9')], [App(true, false)]),
      At([Iface(null, false)], [App(false)]),
    ]),
    [
      ['CONSOLE-01 Connected'],
      ['en0 address changed from 10.0.0.5 → 10.0.0.9', 'QLab: Not Responding'],
      ['en0 Disconnected', 'QLab Stopped'],
    ]
  );
});

test('system check alarms raise and clear, and a disconnect stands them down silently', () => {
  const Cpu = { Key: 'cpu', Value: 97.2, Threshold: 90, Since: 1 };
  const Steps = (() => {
    let State;
    return [
      client(),
      client({ ResourceAlarms: [Cpu] }),
      client({ ResourceAlarms: [] }),
      client({ ResourceAlarms: [Cpu] }),
      client({ Online: false, ResourceAlarms: [] }),
      client({ ResourceAlarms: [] }),
    ].map((Snapshot) => {
      const Result = DiffClientStatus(State, Snapshot);
      State = Result.State;
      return Result.Entries;
    });
  })();
  assert.deepEqual(Texts(Steps[1]), ['High CPU Usage']);
  assert.deepEqual(Steps[1][0].Details, ['97.2% (limit 90%)']);
  assert.deepEqual(Texts(Steps[2]), ['High CPU Usage cleared']);
  assert.deepEqual(Texts(Steps[4]), ['CONSOLE-01 Disconnected']);
  assert.deepEqual(
    Texts(Steps[5]),
    ['CONSOLE-01 Reconnected'],
    'no stale "cleared" after the outage'
  );
});

test('degraded and recovered carry the warnings behind them', () => {
  const { State } = DiffClientStatus(undefined, client());
  const Down = DiffClientStatus(
    State,
    client({ Degraded: true, DegradedWarnings: ['Missing USB Device'] })
  );
  assert.deepEqual(Texts(Down.Entries), ['CONSOLE-01 Degraded']);
  assert.deepEqual(Down.Entries[0].Details, ['Missing USB Device']);
  const Up = DiffClientStatus(Down.State, client());
  assert.deepEqual(Texts(Up.Entries), ['CONSOLE-01 Recovered']);
  // Going offline ends a degraded state without a "Recovered".
  const Again = DiffClientStatus(Up.State, client({ Degraded: true, DegradedWarnings: ['x'] }));
  assert.deepEqual(Texts(DiffClientStatus(Again.State, client({ Online: false })).Entries), [
    'CONSOLE-01 Disconnected',
  ]);
});

test('an unassigned client slot is never logged', () => {
  assert.deepEqual(run(DiffClientStatus, [client({ Unassigned: true })]), [[]]);
});

test('dummy clients log their state machine, but not idle', () => {
  const Dummy = (State) => ({
    UUID: 'd-1',
    Nickname: 'Projector PC',
    State,
    DegradedWarnings: State === 'DEGRADED' ? ['Missed Heartbeat'] : [],
  });
  assert.deepEqual(
    run(DiffDummyStatus, [
      Dummy('IDLE'),
      Dummy('ONLINE'),
      Dummy('ONLINE'),
      Dummy('DEGRADED'),
      Dummy('ONLINE'),
      Dummy('DEGRADED'),
      Dummy('OFFLINE'),
      Dummy('IDLE'),
      Dummy('ONLINE'),
    ]),
    [
      [],
      ['Projector PC Online'],
      [],
      ['Projector PC Degraded'],
      ['Projector PC Recovered'],
      ['Projector PC Degraded'],
      ['Projector PC Offline'],
      [],
      ['Projector PC Online'],
    ]
  );
});

test('FreeKiosk terminals log online, offline and their metric alarms', () => {
  const Kiosk = (Overrides) => ({
    UUID: 'k-1',
    Nickname: 'Lobby Kiosk',
    State: 'ONLINE',
    Online: true,
    Degraded: false,
    Alarms: [],
    ...Overrides,
  });
  const Battery = { Key: 'battery', Label: 'Battery Level', Reason: 'Battery at 12% (below 20%)' };
  assert.deepEqual(
    run(DiffFreeKioskStatus, [
      Kiosk({ State: 'IDLE', Online: false }),
      Kiosk(),
      Kiosk({ Degraded: true, Alarms: [Battery] }),
      Kiosk({ State: 'OFFLINE', Online: false, LastError: 'timeout' }),
      Kiosk(),
    ]),
    [
      [],
      ['Lobby Kiosk Online'],
      ['Battery Level', 'Lobby Kiosk Degraded'],
      ['Lobby Kiosk Offline'],
      ['Lobby Kiosk Back Online', 'Battery Level back to normal', 'Lobby Kiosk Recovered'],
    ]
  );
});

test('monitors log each check and their own overall state', () => {
  const Monitor = (Checks, Overrides = {}) => ({
    TargetID: 7,
    Nickname: 'Main Projector',
    LastChecked: 1,
    Online: true,
    Degraded: false,
    Checks,
    ...Overrides,
  });
  const Check = (ID, Name, Online, Overrides = {}) => ({
    CheckID: ID,
    Name,
    LastChecked: 1,
    Online,
    Degraded: false,
    ...Overrides,
  });
  assert.deepEqual(
    run(DiffMonitorStatus, [
      Monitor(
        [
          Check(1, 'Ping', false, { LastChecked: null }),
          Check(2, 'PJLink', false, { LastChecked: null }),
        ],
        { LastChecked: null }
      ),
      Monitor([Check(1, 'Ping', true), Check(2, 'PJLink', true)]),
      Monitor([Check(1, 'Ping', true), Check(2, 'PJLink', false, { LastError: 'Lamp failure' })], {
        Degraded: true,
      }),
      Monitor([Check(1, 'Ping', true), Check(2, 'PJLink', true)]),
      Monitor([Check(1, 'Ping', false), Check(2, 'PJLink', false)], { Online: false }),
    ]),
    [
      [],
      ['Main Projector Online'],
      ['PJLink Offline', 'Main Projector Degraded'],
      ['PJLink Back Online', 'Main Projector Recovered'],
      ['Ping Offline', 'PJLink Offline', 'Main Projector Offline'],
    ]
  );
});
