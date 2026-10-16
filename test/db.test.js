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
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js');
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

test('DB records schema migration versions and keeps a fresh database clean', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  // Every declared migration is recorded (columns pre-exist on a fresh schema,
  // so the PRAGMA probe skips the ALTER but still records the version).
  const schema = require('../dist/Modules/DB/schema');
  const declared = (schema.Migrations || []).map((m) => m.Version).sort((a, b) => a - b);
  assert.ok(declared.length > 0, 'expected declared migrations');
  const [err, rows] = await DB.All('SELECT Version FROM SchemaMigrations ORDER BY Version');
  assert.equal(err, null);
  assert.deepEqual(
    rows.map((r) => r.Version),
    declared
  );

  // Migration bookkeeping must not mark a fresh database as having unsaved changes.
  assert.equal(await DB.HasUnsavedChanges(), false);

  // WithTransaction commits on success and rolls back on throw.
  const [txErr, txValue] = await DB.WithTransaction(async (run) => {
    const [insErr] = await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Tx', 1]);
    if (insErr) throw insErr;
    return 'committed';
  });
  assert.equal(txErr, null);
  assert.equal(txValue, 'committed');
  const [, committedRow] = await DB.Get('SELECT COUNT(*) AS N FROM Groups WHERE Title = ?', ['Tx']);
  assert.equal(committedRow.N, 1);

  const [rollbackErr] = await DB.WithTransaction(async (run) => {
    await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Doomed', 2]);
    throw new Error('boom');
  });
  assert.ok(rollbackErr instanceof Error);
  const [, doomedRow] = await DB.Get('SELECT COUNT(*) AS N FROM Groups WHERE Title = ?', [
    'Doomed',
  ]);
  assert.equal(doomedRow.N, 0);

  await DB.Shutdown();
});

// Swap the schema module InitializeSchema requires lazily (after the connection
// opens) for one whose migration list is replaced. Must be called synchronously
// right after loadDB, before the open callback fires.
function withMigrations(migrations) {
  const Module = require('node:module');
  const schemaPath = require.resolve('../dist/Modules/DB/schema');
  const real = require(schemaPath);
  const fake = [...real];
  fake.Migrations = migrations(real.Migrations || []);
  const stub = new Module(schemaPath);
  stub.filename = schemaPath;
  stub.exports = fake;
  stub.loaded = true;
  require.cache[schemaPath] = stub;
  return () => {
    delete require.cache[schemaPath];
  };
}

test('DB stops at the first failed migration so it is retried on the next open', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const schema = require('../dist/Modules/DB/schema');
  const top = Math.max(...schema.Migrations.map((m) => m.Version));

  // First open: top+1 fails, so top+2 must neither run nor be recorded.
  let DB = loadDB(storageDir).Manager;
  let restore = withMigrations((real) => [
    ...real,
    { Version: top + 1, SQL: 'NOT VALID SQL' },
    { Version: top + 2, SQL: 'CREATE TABLE IF NOT EXISTS `MigAfter` (X INTEGER)' },
  ]);
  try {
    await DB.Ready();
  } finally {
    restore();
  }
  let [, maxRow] = await DB.Get('SELECT MAX(Version) AS V FROM SchemaMigrations');
  assert.equal(maxRow.V, top);
  let [, afterTable] = await DB.Get("SELECT name FROM sqlite_master WHERE name = 'MigAfter'");
  assert.equal(afterTable, undefined, 'a migration after the failed one ran');
  await DB.Shutdown();

  // Second open with the migration fixed: both now apply, in order.
  DB = loadDB(storageDir).Manager;
  restore = withMigrations((real) => [
    ...real,
    { Version: top + 1, SQL: 'CREATE TABLE IF NOT EXISTS `MigRetried` (X INTEGER)' },
    { Version: top + 2, SQL: 'CREATE TABLE IF NOT EXISTS `MigAfter` (X INTEGER)' },
  ]);
  try {
    await DB.Ready();
  } finally {
    restore();
  }
  [, maxRow] = await DB.Get('SELECT MAX(Version) AS V FROM SchemaMigrations');
  assert.equal(maxRow.V, top + 2);
  const [, retried] = await DB.Get("SELECT name FROM sqlite_master WHERE name = 'MigRetried'");
  assert.equal(retried.name, 'MigRetried');
  [, afterTable] = await DB.Get("SELECT name FROM sqlite_master WHERE name = 'MigAfter'");
  assert.equal(afterTable.name, 'MigAfter');
  await DB.Shutdown();
});

test('every migration is a single SQL statement', () => {
  // Migrations run through sqlite3's Database#run, which executes only the FIRST
  // statement of a multi-statement string and silently drops the rest. A second
  // statement would look applied (the version is recorded) but never have run.
  const schema = require('../dist/Modules/DB/schema');
  const multi = schema.Migrations.filter(
    (m) =>
      String(m.SQL)
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean).length > 1
  ).map((m) => m.Version);
  assert.deepEqual(multi, [], 'split these into one migration per statement');
});

test('a migration and its version record commit or roll back together', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const schema = require('../dist/Modules/DB/schema');
  const top = Math.max(...schema.Migrations.map((m) => m.Version));

  // A migration whose statement succeeds but whose version then cannot be
  // recorded: it drops the very table the record goes into. Applied separately,
  // the drop would stick and the record would fail; atomically, the failed
  // record rolls the drop back with it.
  const DB = loadDB(storageDir).Manager;
  const restore = withMigrations((real) => [
    ...real,
    { Version: top + 1, SQL: 'DROP TABLE SchemaMigrations' },
  ]);
  try {
    await DB.Ready();
  } finally {
    restore();
  }
  const [, table] = await DB.Get("SELECT name FROM sqlite_master WHERE name = 'SchemaMigrations'");
  assert.equal(table && table.name, 'SchemaMigrations', 'the failed migration was not rolled back');
  const [, maxRow] = await DB.Get('SELECT MAX(Version) AS V FROM SchemaMigrations');
  assert.equal(maxRow.V, top);
  await DB.Shutdown();
});

test('a migration triggered by opening a show file does not deadlock the swap', async () => {
  // ReplaceWithFile holds the exclusive section while it reopens the connection,
  // and reopening runs migrations in transactions. Those must not queue for the
  // section the swap already owns.
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const schema = require('../dist/Modules/DB/schema');
  const top = Math.max(...schema.Migrations.map((m) => m.Version));
  const DB = loadDB(storageDir).Manager;
  await DB.Ready();

  const snapshotPath = path.join(storageDir, 'snap', 'Show.ShowTrak');
  const [snapErr] = await DB.SnapshotTo(snapshotPath);
  assert.equal(snapErr, null);

  const restore = withMigrations((real) => [
    ...real,
    { Version: top + 1, SQL: 'CREATE TABLE IF NOT EXISTS `MigOnSwap` (X INTEGER)' },
  ]);
  try {
    const timedOut = Symbol('timed out');
    let timer;
    const outcome = await Promise.race([
      DB.ReplaceWithFile(snapshotPath),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), 5000);
      }),
    ]);
    clearTimeout(timer);
    assert.notEqual(outcome, timedOut, 'ReplaceWithFile deadlocked on a pending migration');
    assert.equal(outcome[0], null);
  } finally {
    restore();
  }
  const [, created] = await DB.Get("SELECT name FROM sqlite_master WHERE name = 'MigOnSwap'");
  assert.equal(created.name, 'MigOnSwap');
  const [, maxRow] = await DB.Get('SELECT MAX(Version) AS V FROM SchemaMigrations');
  assert.equal(maxRow.V, top + 1);
  await DB.Shutdown();
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function countGroups(DB, title) {
  const [, row] = await DB.Get('SELECT COUNT(*) AS N FROM Groups WHERE Title = ?', [title]);
  return row.N;
}

test('DB runs overlapping transactions one at a time instead of failing on BEGIN', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  const order = [];
  const holdFirst = deferred();
  const first = DB.WithTransaction(async (run) => {
    order.push('first:start');
    const [err] = await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['First', 1]);
    if (err) throw err;
    await holdFirst.promise;
    order.push('first:end');
    return 'first';
  });
  const second = DB.WithTransaction(async (run) => {
    order.push('second:start');
    const [err] = await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Second', 2]);
    if (err) throw err;
    return 'second';
  });

  await tick();
  assert.deepEqual(order, ['first:start'], 'the second transaction did not wait its turn');
  holdFirst.resolve();

  assert.deepEqual(await first, [null, 'first']);
  assert.deepEqual(await second, [null, 'second']);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  assert.equal(await countGroups(DB, 'First'), 1);
  assert.equal(await countGroups(DB, 'Second'), 1);

  await DB.Shutdown();
});

test('DB keeps an outside write out of a transaction that rolls back', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  const inserted = deferred();
  const holdTx = deferred();
  const tx = DB.WithTransaction(async (run) => {
    await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Doomed', 1]);
    inserted.resolve();
    await holdTx.promise;
    throw new Error('boom');
  });
  await inserted.promise;

  // Issued while the transaction is open: it must wait, not join it.
  let outsideSettled = false;
  const outside = DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Outsider', 2]).then(
    (result) => {
      outsideSettled = true;
      return result;
    }
  );
  await tick();
  assert.equal(outsideSettled, false, 'the outside write ran inside the open transaction');

  holdTx.resolve();
  const [txErr] = await tx;
  assert.ok(txErr instanceof Error);
  const [outsideErr] = await outside;
  assert.equal(outsideErr, null);

  assert.equal(await countGroups(DB, 'Doomed'), 0);
  assert.equal(await countGroups(DB, 'Outsider'), 1);

  await DB.Shutdown();
});

test('DB lets a transaction read through the manager directly without deadlocking', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  // ReplaceClientUUID reads AlertRules with DB.All inside its transaction. That
  // read belongs to the transaction, so it must bypass the gate (and sees the
  // transaction's own uncommitted write).
  const [err, seen] = await DB.WithTransaction(async (run) => {
    await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Inner', 1]);
    const [, row] = await DB.Get('SELECT COUNT(*) AS N FROM Groups WHERE Title = ?', ['Inner']);
    const [, rows] = await DB.All('SELECT Title FROM Groups WHERE Title = ?', ['Inner']);
    return [row.N, rows.length];
  });
  assert.equal(err, null);
  assert.deepEqual(seen, [1, 1]);

  // A nested transaction fails fast rather than queueing behind itself.
  const [outerErr, innerResult] = await DB.WithTransaction(async () =>
    DB.WithTransaction(async () => 'never')
  );
  assert.equal(outerErr, null);
  assert.ok(innerResult[0] instanceof Error);

  await DB.Shutdown();
});

test('DB.Shutdown lets an open transaction commit before closing', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  const inserted = deferred();
  const holdTx = deferred();
  const tx = DB.WithTransaction(async (run) => {
    await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Survivor', 1]);
    inserted.resolve();
    await holdTx.promise;
    const [err] = await run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Late', 2]);
    if (err) throw err;
  });
  await inserted.promise;

  const shutdown = DB.Shutdown();
  // New outside work is refused straight away...
  const [refusedErr] = await DB.Get('SELECT 1');
  assert.match(String(refusedErr && refusedErr.message), /closing/i);
  // ...but the open transaction may still finish and commit.
  holdTx.resolve();
  const [txErr] = await tx;
  assert.equal(txErr, null);
  await shutdown;

  // A queued transaction reaching the front after shutdown is refused.
  const [lateErr] = await DB.WithTransaction(async () => 'never');
  assert.match(String(lateErr && lateErr.message), /closing/i);

  const { Manager: Reopened } = loadDB(storageDir);
  await Reopened.Ready();
  assert.equal(await countGroups(Reopened, 'Survivor'), 1);
  assert.equal(await countGroups(Reopened, 'Late'), 1);
  await Reopened.Shutdown();
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

test('DB applies the WAL pragma and the declared indexes on open', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  // Connection tuning: WAL is set on every open.
  const [modeErr, modeRow] = await DB.Get('PRAGMA journal_mode');
  assert.equal(modeErr, null);
  assert.equal(String(modeRow.journal_mode).toLowerCase(), 'wal');

  // The performance indexes are created by the migrations.
  const [idxErr, indexes] = await DB.All("SELECT name FROM sqlite_master WHERE type = 'index'");
  assert.equal(idxErr, null);
  const idxNames = new Set(indexes.map((r) => r.name));
  for (const expected of [
    'idx_clients_groupid',
    'idx_monitoringchecks_targetid',
    'idx_alerthistory_ruleid',
    'idx_alerthistory_timestamp',
  ]) {
    assert.equal(idxNames.has(expected), true, `expected index ${expected}`);
  }

  await DB.Shutdown();
});

test('AlertHistory repository prunes to the newest N rows', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-db-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  const { CreateAlertHistoryRepository } = require('../dist/Modules/DB/repositories/alert-history');
  const repo = CreateAlertHistoryRepository(DB);

  for (let i = 0; i < 5; i++) {
    const [err] = await repo.Insert({
      RuleID: 1,
      TriggerType: 'CLIENT_OFFLINE',
      TriggerSource: 'client',
      Context: JSON.stringify({ n: i }),
      Result: JSON.stringify({ Actions: [] }),
      Timestamp: 1000 + i,
    });
    assert.equal(err, null);
  }

  let countRow;
  [, countRow] = await DB.Get('SELECT COUNT(*) AS N FROM AlertHistory');
  assert.equal(countRow.N, 5);

  const [pruneErr] = await repo.PruneToMaxRows(2);
  assert.equal(pruneErr, null);

  [, countRow] = await DB.Get('SELECT COUNT(*) AS N FROM AlertHistory');
  assert.equal(countRow.N, 2);

  // The survivors are the two newest inserts (highest HistoryID).
  const [, rows] = await DB.All('SELECT Context FROM AlertHistory ORDER BY HistoryID');
  assert.deepEqual(
    rows.map((r) => JSON.parse(r.Context).n),
    [3, 4]
  );

  // Pruning is inert once the table already fits under the cap.
  const [prune2Err] = await repo.PruneToMaxRows(10);
  assert.equal(prune2Err, null);
  [, countRow] = await DB.Get('SELECT COUNT(*) AS N FROM AlertHistory');
  assert.equal(countRow.N, 2);

  await DB.Shutdown();
});
