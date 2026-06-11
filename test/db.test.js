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
      child: () => loggerStub().CreateLogger(),
    }),
  };
}

function loadDB(storageDir) {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'DB', 'index.js');
  return loadWithMocks(modulePath, {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
}

test('DB initializes schema, runs queries, and tracks dirty state', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  // Schema tables exist after initialization.
  const [tablesErr, tables] = await DB.All(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  );
  assert.equal(tablesErr, null);
  const names = new Set(tables.map((t) => t.name));
  for (const required of [
    'Groups',
    'Clients',
    'Settings',
    'MonitoringTargets',
    'AlertRules',
    'AlertHistory',
    'CriticalUSBDevices',
    'CriticalApplications',
  ]) {
    assert.equal(names.has(required), true, `expected table ${required}`);
  }

  // A fresh database has no user data and no unsaved changes.
  assert.equal(await DB.HasData(), false);
  assert.equal(await DB.HasUnsavedChanges(), false);

  // A write marks the database dirty and is persisted.
  const [insErr, insStmt] = await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', [
    'Alpha',
    10,
  ]);
  assert.equal(insErr, null);
  assert.equal(insStmt.changes, 1);
  assert.equal(await DB.HasUnsavedChanges(), true);
  assert.equal(await DB.HasData(), true);

  const [getErr, row] = await DB.Get('SELECT Title FROM Groups WHERE Title = ?', ['Alpha']);
  assert.equal(getErr, null);
  assert.equal(row.Title, 'Alpha');

  // MarkClean resets the unsaved flag.
  DB.MarkClean();
  assert.equal(await DB.HasUnsavedChanges(), false);

  // RunWithoutDirtyTracking does not flip the unsaved flag.
  const [silentErr] = await DB.RunWithoutDirtyTracking(
    'UPDATE Groups SET Weight = ? WHERE Title = ?',
    [99, 'Alpha']
  );
  assert.equal(silentErr, null);
  assert.equal(await DB.HasUnsavedChanges(), false);

  await DB.Shutdown();
});

test('DB.Get and DB.All surface SQL errors as tuples', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  const [getErr] = await DB.Get('SELECT * FROM TableThatDoesNotExist');
  assert.ok(getErr instanceof Error);
  const [allErr] = await DB.All('SELECT * FROM TableThatDoesNotExist');
  assert.ok(allErr instanceof Error);
  const [runErr] = await DB.Run('NOT VALID SQL');
  assert.ok(runErr instanceof Error);

  await DB.Shutdown();
});

test('DB.SnapshotTo creates a portable file that ReplaceWithFile can open', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Saved', 5]);

  const snapshotPath = path.join(storageDir, 'snap', 'Show.ShowTrak');
  const [snapErr, snapTarget] = await DB.SnapshotTo(snapshotPath);
  assert.equal(snapErr, null);
  assert.equal(snapTarget, snapshotPath);
  assert.equal(fs.existsSync(snapshotPath), true);

  // Mutate the working database, then re-open the snapshot to confirm the swap.
  await DB.Run('DELETE FROM Groups');
  assert.equal(await DB.HasData(), false);

  const [replaceErr, replacePath] = await DB.ReplaceWithFile(snapshotPath);
  assert.equal(replaceErr, null);
  assert.ok(String(replacePath).endsWith('DB.sqlite'));
  await DB.Ready();

  const [, rows] = await DB.All('SELECT Title FROM Groups');
  assert.deepEqual(
    rows.map((r) => r.Title),
    ['Saved']
  );

  await DB.Shutdown();
});

test('DB.ReplaceWithFile rejects files that are not ShowTrak databases', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  const bogus = path.join(storageDir, 'not-a-db.ShowTrak');
  fs.writeFileSync(bogus, 'this is plain text, not sqlite');

  const [err] = await DB.ReplaceWithFile(bogus);
  assert.ok(err instanceof Error);
  assert.match(String(err.message), /not a valid ShowTrak file/i);

  // The working database is still usable after a rejected open.
  await DB.Ready();
  const [, rows] = await DB.All('SELECT * FROM Groups');
  assert.deepEqual(rows, []);

  await DB.Shutdown();
});

test('DB.ResetToEmpty wipes the working database', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Temp', 1]);
  assert.equal(await DB.HasData(), true);

  const [resetErr] = await DB.ResetToEmpty();
  assert.equal(resetErr, null);
  await DB.Ready();

  assert.equal(await DB.HasData(), false);
  assert.equal(await DB.HasUnsavedChanges(), false);

  await DB.Shutdown();
});

test('DB rejects queries once shutdown has begun', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  await DB.Shutdown();

  const [err] = await DB.Get('SELECT 1');
  assert.ok(err instanceof Error);
  assert.match(String(err.message), /closing/i);

  // Shutdown is idempotent.
  await DB.Shutdown();
});
