const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function modulePath(...parts) {
  return path.join(__dirname, '..', 'src', 'Modules', ...parts);
}

test('AppData initializes folders and resolves directory paths', async () => {
  const made = [];
  const existing = new Set();
  const fsMock = {
    existsSync: (p) => existing.has(p),
    mkdirSync: (p) => {
      made.push(p);
      existing.add(p);
    },
  };
  let spawned = null;
  const childMock = {
    spawn: (command, args) => {
      spawned = { command, args };
      return { unref: () => {} };
    },
  };
  const osMock = { homedir: () => '/home/test' };

  const { Manager } = loadWithMocks(modulePath('AppData', 'index.js'), {
    fs: fsMock,
    os: osMock,
    child_process: childMock,
  });

  await Manager.Initialize();
  // Re-running is a no-op.
  await Manager.Initialize();

  assert.ok(made.some((p) => p.endsWith('Logs')));
  assert.ok(made.some((p) => p.endsWith('Scripts')));
  assert.ok(made.some((p) => p.endsWith('Storage')));

  assert.match(Manager.GetLogsDirectory(), /Logs$/);
  assert.match(Manager.GetScriptsDirectory(), /Scripts$/);
  assert.match(Manager.GetStorageDirectory(), /Storage$/);
  assert.match(Manager.GetStateFilePath(), /state\.json$/);

  // OpenFolder returns false when the folder does not exist.
  assert.equal(Manager.OpenFolder('/missing'), false);

  // OpenFolder spawns the platform opener when the folder exists.
  existing.add('/some/dir');
  assert.equal(Manager.OpenFolder('/some/dir'), true);
  assert.ok(spawned);
  assert.deepEqual(spawned.args, ['/some/dir']);
});

test('Broadcast manager is a shared event emitter', () => {
  const { Manager } = loadWithMocks(modulePath('Broadcast', 'index.js'), {});
  let received = null;
  Manager.on('Ping', (payload) => (received = payload));
  Manager.emit('Ping', 42);
  assert.equal(received, 42);
});

test('OS manager exposes the hostname', () => {
  const { Manager } = loadWithMocks(modulePath('OS', 'index.js'), {
    os: { hostname: () => 'unit-test-host' },
  });
  assert.equal(Manager.Hostname, 'unit-test-host');
});

test('FileSelectorManager delegates to the electron dialog', async () => {
  const calls = [];
  const dialogMock = {
    showOpenDialog: async (opts) => {
      calls.push(['open', opts]);
      return { canceled: false, filePaths: ['/x.ShowTrak'] };
    },
    showSaveDialog: async (opts) => {
      calls.push(['save', opts]);
      return { canceled: false, filePath: '/y.ShowTrak' };
    },
  };
  const { Manager } = loadWithMocks(modulePath('FileSelectorManager', 'index.js'), {
    electron: { dialog: dialogMock },
  });

  const open = await Manager.OpenDialog('Open a show');
  assert.deepEqual(open.filePaths, ['/x.ShowTrak']);
  assert.equal(calls[0][1].title, 'Open a show');

  const save = await Manager.SaveDialog('Save a show');
  assert.equal(save.filePath, '/y.ShowTrak');
  assert.match(calls[1][1].defaultPath, /\.ShowTrak$/);
});

test('Server serializers project safe public shapes', () => {
  const { ToPublicClient, ToPublicGroup } = loadWithMocks(
    modulePath('Server', 'serializers.js'),
    {}
  );

  const client = ToPublicClient({
    UUID: 'u1',
    Nickname: 'PC',
    Hostname: 'host',
    GroupID: 3,
    Weight: 100,
    Version: '1.0',
    IP: '10.0.0.2',
    MacAddress: 'aa',
    Online: true,
    LastSeen: 123,
    Vitals: { CPU: {} },
    USBDeviceList: null,
    NetworkInterfaces: undefined,
    Secret: 'should-not-leak',
  });
  assert.equal(client.Type, 'client');
  assert.equal(client.UUID, 'u1');
  assert.deepEqual(client.USBDeviceList, []);
  assert.deepEqual(client.NetworkInterfaces, []);
  assert.equal(Object.prototype.hasOwnProperty.call(client, 'Secret'), false);

  const group = ToPublicGroup({ GroupID: 3, Title: 'A', Weight: 1, Extra: 'x' });
  assert.deepEqual(group, { GroupID: 3, Title: 'A', Weight: 1 });
});

test('NetworkDiscovery network-utils convert IPs and probe ports', async () => {
  const utils = loadWithMocks(modulePath('NetworkDiscovery', 'network-utils.js'), {});

  assert.equal(utils.clampInt('500', 0, 100, 10), 100);
  assert.equal(utils.clampInt('not-a-number', 0, 100, 10), 10);
  assert.equal(utils.clampInt(-5, 0, 100, 10), 0);

  assert.equal(utils.ipv4ToInt('0.0.0.0'), 0);
  assert.equal(utils.ipv4ToInt('255.255.255.255'), 4294967295);
  assert.equal(utils.ipv4ToInt('bad.ip'), null);
  assert.equal(utils.ipv4ToInt('1.2.3'), null);

  const roundTrip = utils.intToIPv4(utils.ipv4ToInt('192.168.1.10'));
  assert.equal(roundTrip, '192.168.1.10');

  // getLocalSubnets / buildProbeTargets run against the real host without throwing.
  assert.ok(Array.isArray(utils.getLocalSubnets(16)));
  assert.ok(Array.isArray(utils.buildProbeTargets(4)));

  // probePort against an open local port.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const open = await utils.probePort('127.0.0.1', port, 1000);
  assert.equal(open, port);
  await new Promise((resolve) => server.close(resolve));

  const closed = await utils.probePort('127.0.0.1', port, 500);
  assert.equal(closed, null);

  // probeHost honors the cancellation flag.
  const cancelled = await utils.probeHost('127.0.0.1', [port], 500, { Cancelled: true });
  assert.equal(cancelled, null);
});

test('NetworkDiscovery manager starts and stops probe scans', async () => {
  const bonjourMock = () => ({
    find: () => ({ on: () => {}, start: () => {}, update: () => {}, stop: () => {} }),
    destroy: () => {},
  });
  const noopLogger = { CreateLogger: () => ({ error: () => {}, warn: () => {}, log: () => {} }) };

  const { Manager } = loadWithMocks(modulePath('NetworkDiscovery', 'index.js'), {
    bonjour: bonjourMock,
    '../Logger': noopLogger,
  });

  // Callback is required.
  assert.equal(Manager.Start({}, null)[0], 'Callback is required');

  const events = [];
  const [startErr, started] = Manager.Start(
    {
      EnableProbe: true,
      EnableBonjour: false,
      MaxHostsPerSubnet: 32,
      TimeoutMs: 3000,
      ProbePorts: [65000],
    },
    (evt) => events.push(evt)
  );
  assert.equal(startErr, null);
  assert.ok(started.ScanID);
  assert.ok(events.some((e) => e.Type === 'status'));

  // Stop is safe for known and unknown scan IDs.
  assert.deepEqual(Manager.Stop(started.ScanID), [null, true]);
  assert.deepEqual(Manager.Stop('unknown'), [null, true]);
  assert.equal(Manager.Stop('')[0], 'ScanID is required');
});
