const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  return { debug: () => {}, error: () => {}, log: () => {}, warn: () => {} };
}

// Builds an in-memory DB stub backed by a simple row array so the manager can
// persist/read DummyClients without a real database.
function createDbStub(rows = []) {
  return {
    rows,
    Manager: {
      All: async (sql) => {
        if (String(sql).includes('FROM DummyClients')) return [null, rows.map((r) => ({ ...r }))];
        return [null, []];
      },
      Run: async (sql, params) => {
        const text = String(sql);
        if (text.startsWith('INSERT INTO DummyClients')) {
          rows.push({
            UUID: params[0],
            DummyID: params[1],
            Nickname: params[2],
            Interval: params[3],
            GroupID: params[4],
            Weight: params[5],
            Timestamp: params[6],
          });
        } else if (text.startsWith('UPDATE DummyClients SET DummyID')) {
          const row = rows.find((r) => r.UUID === params[4]);
          if (row) {
            row.DummyID = params[0];
            row.Nickname = params[1];
            row.Interval = params[2];
            row.GroupID = params[3];
          }
        } else if (text.startsWith('UPDATE DummyClients SET GroupID')) {
          const row = rows.find((r) => r.UUID === params[2]);
          if (row) {
            row.GroupID = params[0];
            row.Weight = params[1];
          }
        } else if (text.startsWith('UPDATE DummyClients SET IP')) {
          const row = rows.find((r) => r.UUID === params[1]);
          if (row) row.IP = params[0];
        } else if (text.startsWith('DELETE FROM DummyClients')) {
          const idx = rows.findIndex((r) => r.UUID === params[0]);
          if (idx !== -1) rows.splice(idx, 1);
        }
        return [null, { changes: 1 }];
      },
    },
  };
}

function loadManager(dbStub, events) {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'DummyClientManager', 'index.js');
  return loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': dbStub,
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
    '../Utils': require('../src/Modules/Utils'),
  }).Manager;
}

test('DummyClientManager generates unique alphanumeric IDs with matching defaults', async () => {
  const db = createDbStub();
  const Manager = loadManager(db, []);
  await Manager.Init();

  const defaults = Manager.GenerateDefaults();
  assert.match(defaults.DummyID, /^DummyClient\d{6}$/);
  const suffix = defaults.DummyID.replace(/^DummyClient/, '');
  assert.equal(defaults.Nickname, `Dummy ${suffix}`);
  assert.equal(defaults.Interval, 30000);
});

test('DummyClientManager creates with defaults and enforces unique IDs', async () => {
  const db = createDbStub();
  const events = [];
  const Manager = loadManager(db, events);
  await Manager.Init();

  const [createErr, created] = await Manager.Create({});
  assert.equal(createErr, null);
  assert.match(created.DummyID, /^DummyClient\d{6}$/);
  assert.equal(created.State, 'IDLE');
  assert.equal(created.Online, false);
  assert.equal(created.Version, 'Dummy');

  // Re-using an existing ID must fail.
  const [dupErr] = await Manager.Create({ DummyID: created.DummyID });
  assert.match(String(dupErr), /already in use/);

  // An ID that sanitizes to empty (no alphanumeric characters) is rejected.
  const [badErr] = await Manager.Create({ DummyID: '!!!' });
  assert.match(String(badErr), /alphanumeric/);
});

test('DummyClientManager clamps interval to the 5s..5m range', async () => {
  const db = createDbStub();
  const Manager = loadManager(db, []);
  await Manager.Init();

  const [, tooSmall] = await Manager.Create({ DummyID: 'AAA', Interval: 1000 });
  assert.equal(tooSmall.Interval, 5000);

  const [, tooBig] = await Manager.Create({ DummyID: 'BBB', Interval: 99999999 });
  assert.equal(tooBig.Interval, 300000);
});

test('DummyClientManager heartbeat by DummyID brings the dummy Online', async () => {
  const db = createDbStub();
  const events = [];
  const Manager = loadManager(db, events);
  await Manager.Init();

  const [, created] = await Manager.Create({ DummyID: 'HEARTBEAT1' });

  const [unknownErr] = await Manager.Heartbeat('NOPE');
  assert.match(String(unknownErr), /Unknown Dummy ID/);

  const [hbErr] = await Manager.Heartbeat('HEARTBEAT1');
  assert.equal(hbErr, null);

  const [, after] = await Manager.Get(created.UUID);
  assert.equal(after.State, 'ONLINE');
  assert.equal(after.Online, true);
  assert.equal(after.Degraded, false);
  assert.ok(after.LastSeen);

  // A DummyClientUpdated event should have been emitted on heartbeat.
  assert.ok(events.some((e) => e[0] === 'DummyClientUpdated'));

  await Manager.Shutdown();
});

test('DummyClientManager records and persists the heartbeat source IP', async () => {
  const db = createDbStub();
  const Manager = loadManager(db, []);
  await Manager.Init();

  const [, created] = await Manager.Create({ DummyID: 'IPDUMMY1' });

  // IPv4-mapped IPv6 addresses are normalized to plain IPv4.
  const [hbErr] = await Manager.Heartbeat('IPDUMMY1', '::ffff:192.168.1.50');
  assert.equal(hbErr, null);

  const [, after] = await Manager.Get(created.UUID);
  assert.equal(after.IP, '192.168.1.50');

  // The IP is persisted to the backing store.
  const row = db.rows.find((r) => r.UUID === created.UUID);
  assert.equal(row.IP, '192.168.1.50');

  await Manager.Shutdown();
});

test('DummyClient state machine: Idle -> Online -> Degraded -> Offline', async () => {
  const { DummyClient } = require('../src/Modules/DummyClientManager/dummy');
  const dummy = new DummyClient({
    UUID: 'u',
    DummyID: 'D1',
    Nickname: 'Dummy 1',
    Interval: 5000,
    GroupID: null,
    Weight: 100,
    Timestamp: Date.now(),
  });

  assert.equal(dummy.State, 'IDLE');
  assert.equal(dummy.Online, false);

  dummy.Heartbeat();
  assert.equal(dummy.State, 'ONLINE');
  assert.equal(dummy.Online, true);
  assert.equal(dummy.Degraded, false);

  // First missed heartbeat -> Degraded (still online) with the expected reason.
  dummy._onWatchdog();
  assert.equal(dummy.State, 'DEGRADED');
  assert.equal(dummy.Online, true);
  assert.equal(dummy.Degraded, true);
  assert.deepEqual(dummy.DegradedWarnings, ['Missed Heartbeat']);

  // Second consecutive miss -> Offline.
  dummy._onWatchdog();
  assert.equal(dummy.State, 'OFFLINE');
  assert.equal(dummy.Online, false);
  assert.equal(dummy.Degraded, false);

  // A new heartbeat recovers the dummy back to Online.
  dummy.Heartbeat();
  assert.equal(dummy.State, 'ONLINE');
  assert.equal(dummy.Online, true);

  dummy.StopLoop();
});

test('DummyClientManager update renames and re-IDs, delete removes', async () => {
  const db = createDbStub();
  const events = [];
  const Manager = loadManager(db, events);
  await Manager.Init();

  const [, created] = await Manager.Create({ DummyID: 'ORIG1' });

  const [updErr, updated] = await Manager.Update(created.UUID, {
    DummyID: 'RENAMED1',
    Nickname: 'My Dummy',
    Interval: 10000,
  });
  assert.equal(updErr, null);
  assert.equal(updated.DummyID, 'RENAMED1');
  assert.equal(updated.Nickname, 'My Dummy');
  assert.equal(updated.Interval, 10000);

  // Heartbeat now routes via the new ID.
  const [hbErr] = await Manager.Heartbeat('RENAMED1');
  assert.equal(hbErr, null);

  const [delErr, ok] = await Manager.Delete(created.UUID);
  assert.equal(delErr, null);
  assert.equal(ok, true);

  const [, list] = await Manager.GetAll();
  assert.equal(list.length, 0);

  await Manager.Shutdown();
});

test('DummyClientManager SetGroupAndWeight updates placement', async () => {
  const db = createDbStub();
  const Manager = loadManager(db, []);
  await Manager.Init();

  const [, created] = await Manager.Create({ DummyID: 'GRP1' });
  const [err] = await Manager.SetGroupAndWeight(created.UUID, 7, 40);
  assert.equal(err, null);

  const [, after] = await Manager.Get(created.UUID);
  assert.equal(after.GroupID, 7);
  assert.equal(after.Weight, 40);

  await Manager.Shutdown();
});
