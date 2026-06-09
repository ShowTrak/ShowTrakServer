const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

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
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'src', 'Modules', 'DB', 'index.js'), {
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
    path.join(__dirname, '..', 'src', 'Modules', 'ClientManager', 'index.js'),
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

test('ClientManager updates system info, USB devices, and network interfaces', async () => {
  const { Manager, sounds } = await loadClientManager({
    AUDIO_ON_USB_DEVICE_CONNECT: true,
    AUDIO_ON_USB_DEVICE_DISCONNECT: true,
  });
  await Manager.Create('dev-1');

  const [siErr] = await Manager.SystemInfo(
    'dev-1',
    { Hostname: 'STAGE-PC', MacAddresses: { eth0: { ipv4: '10.0.0.7', mac: 'aa:bb' } } },
    '10.0.0.7'
  );
  assert.equal(siErr, null);
  const [, afterSI] = await Manager.Get('dev-1');
  assert.equal(afterSI.Hostname, 'STAGE-PC');
  assert.equal(afterSI.MacAddress, 'aa:bb');

  await Manager.SetUSBDeviceList('dev-1', [{ SerialNumber: 'S1' }]);
  await Manager.USBDeviceAdded('dev-1', { SerialNumber: 'S2' });
  let [, withUsb] = await Manager.Get('dev-1');
  assert.equal(withUsb.USBDeviceList.length, 2);

  await Manager.USBDeviceRemoved('dev-1', { SerialNumber: 'S2' });
  [, withUsb] = await Manager.Get('dev-1');
  assert.equal(withUsb.USBDeviceList.length, 1);

  // Connect + disconnect each trigger a sound when enabled.
  assert.ok(sounds.length >= 2);

  await Manager.SetNetworkInterfaces('dev-1', [
    { name: 'eth0', addresses: [{ family: 'IPv4', address: '10.0.0.7', mac: 'aa:bb' }] },
  ]);
  const [, withNics] = await Manager.Get('dev-1');
  assert.equal(withNics.NetworkInterfaces[0].name, 'eth0');

  // Operations against a missing client return errors.
  assert.match(String((await Manager.SetUSBDeviceList('missing', []))[0]), /not found/i);
  assert.match(String((await Manager.SystemInfo('missing', {}, '0'))[0]), /not found/i);
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
