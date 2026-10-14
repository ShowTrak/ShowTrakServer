const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');

// Critical network interfaces through the real ClientManager and a real
// (throwaway) SQLite database: marking, persistence, re-hydration, and what a
// broken condition does to the client's health.

function loggerStub() {
  const noop = () => {};
  return { CreateLogger: () => new Proxy({}, { get: () => noop }) };
}

async function loadClientManager() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-net-db-'));
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

function interfaces({ address = '10.0.0.5', gateway = '10.0.0.1', withEn0 = true } = {}) {
  const list = [
    {
      name: 'lo0',
      addresses: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
      gateway: null,
    },
  ];
  if (withEn0) {
    list.push({
      name: 'en0',
      addresses: [
        {
          family: 'IPv4',
          address,
          netmask: '255.255.255.0',
          cidr: `${address}/24`,
          mac: 'AA:BB:CC:DD:EE:FF',
          internal: false,
        },
      ],
      gateway,
    });
  }
  return list;
}

test('marking an interface captures its baseline, persists it and survives a restart', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetNetworkInterfaces('c1', interfaces());

  assert.deepEqual(await Manager.MarkNetworkInterfaceCritical('c1', { Name: 'en0' }), [null, true]);
  const entry = client.CriticalNetworkInterfaces[0];
  assert.equal(entry.Address, '10.0.0.5');
  assert.equal(entry.Netmask, '255.255.255.0');
  assert.equal(entry.Gateway, '10.0.0.1');
  assert.equal(client.Degraded, false);

  // Updating is not a new mark.
  assert.deepEqual(
    await Manager.MarkNetworkInterfaceCritical('c1', { Name: 'en0', Gateway: null }),
    [null, false]
  );

  await Manager.ClearCache();
  await Manager.Init();
  const [, again] = await Manager.Get('c1');
  assert.equal(again.CriticalNetworkInterfaces.length, 1);
  assert.equal(again.CriticalNetworkInterfaces[0].Address, '10.0.0.5');
  assert.equal(again.CriticalNetworkInterfaces[0].Gateway, null);
});

test('a broken condition degrades the client; a missing interface does too', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetNetworkInterfaces('c1', interfaces());
  await Manager.MarkNetworkInterfaceCritical('c1', { Name: 'en0' });

  await Manager.SetNetworkInterfaces('c1', interfaces({ address: '10.0.0.77' }));
  assert.equal(client.Degraded, true);
  assert.deepEqual(client.DegradedWarnings, ['Network Address Changed']);

  await Manager.ApplyNetworkInterfaceDelta('c1', { Added: [], Changed: [], Removed: ['en0'] });
  assert.deepEqual(client.DegradedWarnings, ['Missing Network Interface']);
  assert.equal(client.NetworkStatus.Interfaces.find((i) => i.Name === 'en0').Missing, true);

  await Manager.SetNetworkInterfaces('c1', interfaces());
  assert.equal(client.Degraded, false);
});

test('nothing is judged before the client reports on this connection', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetNetworkInterfaces('c1', interfaces());
  await Manager.MarkNetworkInterfaceCritical('c1', { Name: 'en0' });

  client.SetOnline(false);
  markStarted(client);
  assert.equal(client.HasNetworkTelemetry, false);
  assert.equal(client.Degraded, false);
  assert.equal(client.NetworkStatus.SampledAt, null);
});

test('internal interfaces and unknown ones cannot be marked', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetNetworkInterfaces('c1', interfaces());

  const [internalErr] = await Manager.MarkNetworkInterfaceCritical('c1', { Name: 'lo0' });
  assert.match(internalErr, /Internal network interfaces cannot be monitored/);
  const [unknownErr] = await Manager.MarkNetworkInterfaceCritical('c1', { Name: 'en9' });
  assert.match(unknownErr, /not connected/);
  assert.deepEqual(client.CriticalNetworkInterfaces, []);
});

test('unmarking removes the guard and its fault', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetNetworkInterfaces('c1', interfaces());
  await Manager.MarkNetworkInterfaceCritical('c1', { Name: 'en0' });
  await Manager.SetNetworkInterfaces('c1', interfaces({ withEn0: false }));
  assert.equal(client.Degraded, true);

  assert.deepEqual(await Manager.RemoveNetworkInterfaceCritical('c1', 'en0'), [null, true]);
  assert.equal(client.Degraded, false);
  assert.equal(client.IsNetworkInterfaceCritical('en0'), false);
});
