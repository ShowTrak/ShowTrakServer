// Disconnect grace period: a ShowTrak client whose socket drops stays online for
// its grace period (per-client override, else CLIENT_OFFLINE_GRACE_SECONDS) and
// is only marked offline if it has not heartbeated again by the end of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');

const ClientManagerDir = path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager');

function createLoggerStub() {
  return { debug: () => {}, error: () => {}, log: () => {}, warn: () => {}, success: () => {} };
}

// Load a fresh ClientManager over a single client row, and hand back the
// offline-grace instance it was wired to (siblings are re-loaded per call, so
// the module-level default and pending timers start clean every time).
function loadManager(rowOverrides = {}) {
  const runs = [];
  const row = {
    UUID: 'client-1',
    Hostname: 'Stage PC',
    OperatingSystem: null,
    Version: null,
    IP: null,
    MacAddress: null,
    GroupID: null,
    Weight: 100,
    OfflineGraceSeconds: null,
    Timestamp: Date.now(),
    ...rowOverrides,
  };
  const { Manager } = loadWithMocks(path.join(ClientManagerDir, 'index.js'), {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': {
      Manager: {
        Get: async (sql, params) => {
          if (String(sql).includes('FROM Clients WHERE UUID = ?') && params[0] === row.UUID) {
            return [null, { ...row }];
          }
          return [null, null];
        },
        Run: async (sql, params) => {
          runs.push([sql, params]);
          return [null, { changes: 1 }];
        },
        RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
        All: async () => [null, []],
        WithTransaction: async (fn) => {
          await fn(async () => [null, { changes: 1 }]);
          return [null];
        },
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../SettingsManager': { Manager: { GetValue: async () => false } },
    '../Utils': require('../dist/Modules/Utils'),
  });
  const Grace = require(path.join(ClientManagerDir, 'offline-grace.js'));
  return { Manager, Grace, runs };
}

async function connect(Manager) {
  const [Err] = await Manager.Heartbeat('client-1', { Vitals: {} }, '10.0.0.5');
  assert.equal(Err, null);
  const [, Client] = await Manager.Get('client-1');
  assert.equal(Client.Online, true);
  return Client;
}

// Let the async Timeout chain (Exists -> Get -> SetOnline) settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('offline-grace clamps to whole seconds from 0 to 10 and inherits on null', () => {
  const Grace = require(path.join(ClientManagerDir, 'offline-grace.js'));
  assert.equal(Grace.ClampOfflineGraceSeconds(null), null);
  assert.equal(Grace.ClampOfflineGraceSeconds(''), null);
  assert.equal(Grace.ClampOfflineGraceSeconds('soon'), null);
  assert.equal(Grace.ClampOfflineGraceSeconds(-4), 0);
  assert.equal(Grace.ClampOfflineGraceSeconds(2.6), 3);
  assert.equal(Grace.ClampOfflineGraceSeconds(60), 10);

  Grace.SetDefaultOfflineGraceSeconds(4);
  assert.equal(Grace.ResolveOfflineGraceSeconds(null), 4);
  assert.equal(Grace.ResolveOfflineGraceSeconds(0), 0, 'an explicit 0 overrides the default');
  assert.equal(Grace.ResolveOfflineGraceSeconds(7), 7);
  Grace.SetDefaultOfflineGraceSeconds('garbage');
  assert.equal(Grace.GetDefaultOfflineGraceSeconds(), 4, 'an unreadable value is ignored');
  Grace.SetDefaultOfflineGraceSeconds(0);
});

test('with no grace period a disconnect marks the client offline immediately', async () => {
  const { Manager } = loadManager();
  const Client = await connect(Manager);
  await Manager.Disconnected('client-1');
  assert.equal(Client.Online, false);
});

test('a global grace period holds the client online until it expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { Manager, Grace } = loadManager();
  Grace.SetDefaultOfflineGraceSeconds(3);
  const Client = await connect(Manager);

  await Manager.Disconnected('client-1');
  assert.equal(Client.Online, true);
  assert.equal(Grace.HasPendingTimeout('client-1'), true);

  t.mock.timers.tick(2999);
  await settle();
  assert.equal(Client.Online, true);

  t.mock.timers.tick(1);
  await settle();
  assert.equal(Client.Online, false);
  assert.equal(Grace.HasPendingTimeout('client-1'), false);
});

test('a heartbeat inside the grace period cancels the offline mark', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { Manager, Grace } = loadManager();
  Grace.SetDefaultOfflineGraceSeconds(5);
  const Client = await connect(Manager);
  const OnlineSince = Client.OnlineSince;

  await Manager.Disconnected('client-1');
  t.mock.timers.tick(2000);
  await connect(Manager);
  assert.equal(Grace.HasPendingTimeout('client-1'), false);

  t.mock.timers.tick(10000);
  await settle();
  assert.equal(Client.Online, true);
  // A blip is not a new session: the start-up window is not re-entered.
  assert.equal(Client.OnlineSince, OnlineSince);
});

test('a repeat disconnect keeps the original deadline rather than extending it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { Manager, Grace } = loadManager();
  Grace.SetDefaultOfflineGraceSeconds(4);
  const Client = await connect(Manager);

  await Manager.Disconnected('client-1');
  t.mock.timers.tick(3000);
  await Manager.Disconnected('client-1');
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(Client.Online, false);
});

test("a client's own grace period overrides the global one, in either direction", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const Immediate = loadManager({ OfflineGraceSeconds: 0 });
  Immediate.Grace.SetDefaultOfflineGraceSeconds(8);
  const ImmediateClient = await connect(Immediate.Manager);
  await Immediate.Manager.Disconnected('client-1');
  assert.equal(ImmediateClient.Online, false);

  const Patient = loadManager({ OfflineGraceSeconds: 6 });
  const PatientClient = await connect(Patient.Manager);
  await Patient.Manager.Disconnected('client-1');
  t.mock.timers.tick(5999);
  await settle();
  assert.equal(PatientClient.Online, true);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(PatientClient.Online, false);
});

test('deleting a client cancels its pending offline mark', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { Manager, Grace } = loadManager({ OfflineGraceSeconds: 5 });
  await connect(Manager);
  await Manager.Disconnected('client-1');
  assert.equal(Grace.HasPendingTimeout('client-1'), true);
  await Manager.Delete('client-1');
  assert.equal(Grace.HasPendingTimeout('client-1'), false);
});

test('Update persists a per-client grace period and null returns it to inheriting', async () => {
  const { Manager, runs } = loadManager();
  const [Err, Client] = await Manager.Update('client-1', { OfflineGraceSeconds: 4 });
  assert.equal(Err, null);
  assert.equal(Client.OfflineGraceSeconds, 4);
  await Manager.Update('client-1', { OfflineGraceSeconds: null });
  assert.equal(Client.OfflineGraceSeconds, null);
  assert.deepEqual(
    runs
      .filter(([sql]) => sql.includes('OfflineGraceSeconds'))
      .map(([sql, params]) => [sql, params[0]]),
    [
      ['UPDATE Clients SET OfflineGraceSeconds = ? WHERE UUID = ?', 4],
      ['UPDATE Clients SET OfflineGraceSeconds = ? WHERE UUID = ?', null],
    ]
  );
});

test('IPCValidation.ClientUpdatePayload accepts 0-10 whole seconds or inherit', () => {
  assert.equal(
    IPCValidation.ClientUpdatePayload({ OfflineGraceSeconds: 0 }).OfflineGraceSeconds,
    0
  );
  assert.equal(
    IPCValidation.ClientUpdatePayload({ OfflineGraceSeconds: '10' }).OfflineGraceSeconds,
    10
  );
  assert.equal(
    IPCValidation.ClientUpdatePayload({ OfflineGraceSeconds: null }).OfflineGraceSeconds,
    null
  );
  assert.equal(
    IPCValidation.ClientUpdatePayload({ OfflineGraceSeconds: '' }).OfflineGraceSeconds,
    null
  );
  for (const Bad of [11, -1, 2.5, 'soon']) {
    assert.throws(
      () => IPCValidation.ClientUpdatePayload({ OfflineGraceSeconds: Bad }),
      /Offline grace period/
    );
  }
});
