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
  return loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
}

// CreateScriptWhitelistRepository receives the DB manager as an argument (it does
// not require DB itself), so the compiled repo can be required directly and
// handed the loaded DB.
const { CreateScriptWhitelistRepository } = require(
  path.join('..', 'dist', 'Modules', 'DB', 'repositories', 'script-whitelists.js')
);

test('ScriptWhitelists table exists and the repository round-trips rows', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-swl-'));
  const { Manager: DB } = loadDB(storageDir);
  await DB.Ready();

  const [tableErr, table] = await DB.Get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='ScriptWhitelists'"
  );
  assert.equal(tableErr, null);
  assert.ok(table, 'ScriptWhitelists table was created by InitializeSchema');

  const Repo = CreateScriptWhitelistRepository(DB);

  // Absent row (DB.Get yields no row → nullish).
  const [getMissErr, missing] = await Repo.Get('nope');
  assert.equal(getMissErr, null);
  assert.ok(missing == null, 'missing row is nullish');

  // Insert.
  const scope = JSON.stringify({ Workspace: false, Groups: [3], Clients: ['u1'] });
  const [setErr] = await Repo.Set('scriptA', scope, 1000);
  assert.equal(setErr, null);

  const [getErr, row] = await Repo.Get('scriptA');
  assert.equal(getErr, null);
  assert.equal(row.ScriptID, 'scriptA');
  assert.equal(row.Scope, scope);
  assert.equal(row.UpdatedAt, 1000);

  // Upsert (INSERT OR REPLACE) on the same primary key.
  const scope2 = JSON.stringify({ Workspace: false, Groups: [], Clients: ['u2'] });
  await Repo.Set('scriptA', scope2, 2000);
  const [, row2] = await Repo.Get('scriptA');
  assert.equal(row2.Scope, scope2);
  assert.equal(row2.UpdatedAt, 2000);

  // LoadAll.
  await Repo.Set('scriptB', scope, 3000);
  const [allErr, all] = await Repo.LoadAll();
  assert.equal(allErr, null);
  assert.equal(all.length, 2);

  // Rename carries the row to a new ID.
  await Repo.Rename('scriptA', 'scriptRenamed');
  const [, renamed] = await Repo.Get('scriptRenamed');
  assert.ok(renamed, 'row moved to the new ID');
  const [, oldGone] = await Repo.Get('scriptA');
  assert.ok(oldGone == null, 'old ID no longer present');

  // Delete.
  await Repo.Delete('scriptRenamed');
  const [, afterDelete] = await Repo.Get('scriptRenamed');
  assert.ok(afterDelete == null);

  // Release the sqlite file before removing the directory — Windows refuses to
  // delete a file that still has an open handle (EPERM).
  await DB.Shutdown();
  fs.rmSync(storageDir, { recursive: true, force: true });
});
