const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');
const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');

// Critical displays through the real ClientManager and a real (throwaway)
// SQLite database: per-condition marking, persistence, re-keying a weak id, and
// the migration that carries displays marked before conditions existed.

function loggerStub() {
  const noop = () => {};
  return { CreateLogger: () => new Proxy({}, { get: () => noop }) };
}

async function loadClientManager(
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-disp-db-'))
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
  return { Manager: clientManager.Manager, DB: dbModule.Manager, storageDir };
}

function markStarted(client) {
  client.SetOnline(true);
  client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  client._refreshClientHealthState();
}

function display(overrides = {}) {
  return {
    SessionID: '1',
    ScreenNumber: 1,
    DisplayID: 'edid:DEL:1234:SER1',
    IdentitySource: 'edid',
    Label: 'Stage Left',
    Width: 1920,
    Height: 1080,
    ScaleFactor: 1,
    RefreshRate: 60,
    Rotation: 0,
    Primary: true,
    Bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    ...overrides,
  };
}

test('only the ticked conditions are alerted on, and they persist', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetDisplayList('c1', [display()]);

  assert.deepEqual(await Manager.MarkDisplayCritical('c1', { DisplayID: 'edid:DEL:1234:SER1' }), [
    null,
    true,
  ]);
  // Stop guarding the resolution, start guarding rotation.
  assert.deepEqual(
    await Manager.MarkDisplayCritical('c1', {
      DisplayID: 'edid:DEL:1234:SER1',
      CheckResolution: false,
      CheckRotation: true,
    }),
    [null, false]
  );

  await Manager.SetDisplayList('c1', [display({ Width: 1280, Height: 720 })]);
  assert.equal(client.Degraded, false, 'an unticked resolution change is not a fault');

  await Manager.SetDisplayList('c1', [display({ Rotation: 90 })]);
  assert.equal(client.Degraded, true);
  assert.deepEqual(client.DegradedWarnings, ['Display Configuration Changed']);
  assert.deepEqual(
    client.DisplayList[0].Issues.map((Issue) => Issue.Kind),
    ['rotation']
  );

  // Re-hydrating from the database reads the conditions back.
  await Manager.ClearCache();
  await Manager.Init();
  const [, again] = await Manager.Get('c1');
  const entry = again.CriticalDisplays[0];
  assert.equal(entry.Width, null);
  assert.equal(entry.Rotation, 0);
  assert.equal(entry.RefreshRate, 60);
  assert.equal(entry.RequirePresent, true);
});

test('a monitored display cannot be allowed to be absent, even when asked', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c2');
  const [, client] = await Manager.Get('c2');
  markStarted(client);
  await Manager.SetDisplayList('c2', [display()]);
  await Manager.MarkDisplayCritical('c2', {
    DisplayID: 'edid:DEL:1234:SER1',
    RequirePresent: false,
  });
  await Manager.SetDisplayList('c2', []);
  assert.equal(client.Degraded, true);
  assert.equal(client.MissingCriticalDisplays.length, 1);
  assert.equal(client.DisplayList[0].IsConnected, false);
});

test('an entry marked under a weak id takes the durable id when next edited', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c3');
  const [, client] = await Manager.Get('c3');
  markStarted(client);
  // The client could not fingerprint the panel when it was marked.
  await Manager.SetDisplayList('c3', [
    display({ DisplayID: 'attr:::1920x1080@60:e', IdentitySource: 'attributes' }),
  ]);
  await Manager.MarkDisplayCritical('c3', { DisplayID: 'attr:::1920x1080@60:e' });

  // Next session it can; the entry is still recognised (by name)...
  await Manager.SetDisplayList('c3', [display()]);
  assert.equal(client.Degraded, false);
  assert.equal(client.DisplayList[0].Critical.DisplayID, 'attr:::1920x1080@60:e');

  // ...and editing it (by either id) moves it onto the fingerprint.
  assert.deepEqual(
    await Manager.MarkDisplayCritical('c3', { DisplayID: 'edid:DEL:1234:SER1', CheckScale: true }),
    [null, false]
  );
  assert.deepEqual(
    client.CriticalDisplays.map((Entry) => Entry.DisplayID),
    ['edid:DEL:1234:SER1']
  );
  assert.equal(client.CriticalDisplays[0].ScaleFactor, 1);
  assert.deepEqual(await Manager.IsDisplayCritical('c3', 'attr:::1920x1080@60:e'), [null, false]);
  assert.deepEqual(await Manager.IsDisplayCritical('c3', 'edid:DEL:1234:SER1'), [null, true]);

  // Removing by the live id finds the entry too.
  assert.deepEqual(await Manager.RemoveDisplayCritical('c3', 'edid:DEL:1234:SER1'), [null, true]);
  assert.equal(client.CriticalDisplays.length, 0);
});

test('an attribute-identified display whose resolution changed is not missing', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c4');
  const [, client] = await Manager.Get('c4');
  markStarted(client);
  await Manager.SetDisplayList('c4', [
    display({ DisplayID: 'attr:::1920x1080@60:e', Label: null, IdentitySource: 'attributes' }),
  ]);
  await Manager.MarkDisplayCritical('c4', {
    DisplayID: 'attr:::1920x1080@60:e',
    CheckResolution: false,
  });
  // The id bakes in the mode, so the client now reports it under another id.
  await Manager.SetDisplayList('c4', [
    display({
      DisplayID: 'attr:::1280x720@60:e',
      Label: null,
      IdentitySource: 'attributes',
      Width: 1280,
      Height: 720,
    }),
  ]);
  assert.equal(client.Degraded, false);
  assert.equal(client.DisplayList.length, 1);
  assert.equal(client.DisplayList[0].IsCritical, true);
});

test('displays marked before conditions existed migrate to the same guard, in pixels', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-disp-mig-'));
  const file = path.join(storageDir, 'DB.sqlite');
  // The table as 3.26.0 left it, at schema version 35.
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file);
    db.serialize(() => {
      db.run(
        'CREATE TABLE CriticalDisplays (UUID TEXT NOT NULL, DisplayID TEXT NOT NULL, Label TEXT, Width INTEGER, Height INTEGER, RefreshRate INTEGER, ScaleFactor REAL, Timestamp BIGINT(11) NOT NULL, PRIMARY KEY (UUID, DisplayID))'
      );
      db.run(
        'CREATE TABLE SchemaMigrations (Version INTEGER PRIMARY KEY, AppliedAt BIGINT(11) NOT NULL)'
      );
      db.run('INSERT INTO SchemaMigrations VALUES (35, 0)');
      db.run(
        "INSERT INTO CriticalDisplays VALUES ('m1', 'mac:610:a050:SER', 'Retina', 1512, 982, 120, 2, 7)"
      );
      db.run(
        "INSERT INTO CriticalDisplays VALUES ('m1', 'attr:::1920x1080@60:e', NULL, 1920, 1080, 60, 1, 8)"
      );
      db.run(
        "INSERT INTO CriticalDisplays VALUES ('m1', 'session:4', 'Odd', NULL, NULL, NULL, 1.5, 9)",
        (err) => (err ? reject(err) : db.close(resolve))
      );
    });
  });

  const { Manager } = await loadClientManager(storageDir);
  await Manager.Create('m1');
  await Manager.ClearCache();
  await Manager.Init();
  const [, client] = await Manager.Get('m1');
  const byID = Object.fromEntries(client.CriticalDisplays.map((Entry) => [Entry.DisplayID, Entry]));

  assert.deepEqual(byID['mac:610:a050:SER'], {
    DisplayID: 'mac:610:a050:SER',
    Label: 'Retina',
    RequirePresent: true,
    Width: 3024,
    Height: 1964,
    RefreshRate: 120,
    ScaleFactor: null,
    Rotation: null,
    RequirePrimary: false,
    PositionX: null,
    PositionY: null,
    Timestamp: 7,
  });
  assert.equal(byID['attr:::1920x1080@60:e'].Width, 1920);
  assert.equal(byID['attr:::1920x1080@60:e'].ScaleFactor, null);
  assert.equal(byID['session:4'].Width, null);
  assert.equal(byID['session:4'].ScaleFactor, null);

  // And it judges exactly as before: the same mode in points is no fault.
  markStarted(client);
  await Manager.SetDisplayList('m1', [
    display({
      DisplayID: 'mac:610:a050:SER',
      Label: 'Retina',
      Width: 1512,
      Height: 982,
      ScaleFactor: 2,
      RefreshRate: 120,
    }),
    display({ DisplayID: 'attr:::1920x1080@60:e', Label: null, SessionID: '2', Primary: false }),
  ]);
  assert.equal(client.DisplayList.filter((Entry) => Entry.Mismatch).length, 0);
  assert.deepEqual(client.DegradedWarnings, ['Missing Display']); // session:4 is gone
});

test('CriticalDisplayPayload keeps only the conditions that were sent', () => {
  assert.deepEqual(IPCValidation.CriticalDisplayPayload({ DisplayID: ' d1 ' }), {
    DisplayID: 'd1',
  });
  assert.deepEqual(
    IPCValidation.CriticalDisplayPayload({
      DisplayID: 'd1',
      RequirePresent: false,
      CheckRotation: true,
      // An older caller's baseline fields are ignored, not rejected.
      Width: 1920,
      Label: 'Main',
    }),
    { DisplayID: 'd1', RequirePresent: false, CheckRotation: true }
  );
  assert.throws(
    () => IPCValidation.CriticalDisplayPayload({ DisplayID: 'd1', CheckScale: 'yes' }),
    /CheckScale must be true or false/
  );
  assert.throws(() => IPCValidation.CriticalDisplayPayload(null), /must be an object/);
});
