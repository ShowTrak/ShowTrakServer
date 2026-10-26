const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises src/Modules/BackupManager against a real working database: the
// version stamped into every show file, and the promise that a show file an
// older ShowTrak Server saved is backed up before this version writes to it,
// and is never written to at all until the operator agrees.

const CurrentVersion = require('../package.json').version;
const DBModulePath = path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js');

function loggerStub() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    database: noop,
    databaseError: noop,
  };
  return { CreateLogger: () => logger };
}

// A fresh BackupManager (and working database) rooted in its own temp folder.
// StateFilePath, when given, seeds the show file left open "last session".
function loadBackupManager(Root, { CurrentFilePath } = {}) {
  const Storage = path.join(Root, 'Storage');
  const Backups = path.join(Root, 'Backups');
  fs.mkdirSync(Storage, { recursive: true });
  const StatePath = path.join(Root, 'state.json');
  if (CurrentFilePath) fs.writeFileSync(StatePath, JSON.stringify({ CurrentFilePath }));
  const AppData = {
    Manager: {
      GetStorageDirectory: () => Storage,
      GetStateFilePath: () => StatePath,
      GetBackupsDirectory: () => Backups,
    },
  };
  const { Manager } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'BackupManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../AppData': AppData,
      '../Broadcast': { Manager: { emit() {} } },
    },
    { alsoEvict: [DBModulePath] }
  );
  const DB = require(DBModulePath).Manager;
  return { BackupManager: Manager, DB, Backups };
}

// Write a show file as an older ShowTrak Server would have: one group, saved
// with SavedVersion (or with no version at all when it is null).
async function writeOlderShowFile(DB, FilePath, SavedVersion) {
  await DB.Ready();
  await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Old Show Group', 1]);
  await DB.Run('DELETE FROM ShowFileInfo');
  if (SavedVersion) {
    await DB.Run("INSERT INTO ShowFileInfo (Key, Value) VALUES ('SavedWithVersion', ?)", [
      SavedVersion,
    ]);
  }
  const [Err] = await DB.SnapshotTo(FilePath);
  assert.equal(Err, null);
  await DB.ResetToEmpty();
}

async function groupTitles(DB) {
  const [, Rows] = await DB.All('SELECT Title FROM Groups ORDER BY Title');
  return (Rows || []).map((r) => r.Title);
}

function backupsIn(Dir) {
  return fs.existsSync(Dir) ? fs.readdirSync(Dir) : [];
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-backup-'));
}

test('saving stamps the show file with this version, and New records the creating version', async () => {
  const Root = tempRoot();
  const { BackupManager, DB } = loadBackupManager(Root);
  await DB.Ready();
  const ShowPath = path.join(Root, 'shows', 'New Show.ShowTrak');

  const [Err] = await BackupManager.New(ShowPath);
  assert.equal(Err, null);
  assert.equal(BackupManager.GetCurrentFilePath(), ShowPath);

  const [, Info] = await DB.ReadFileInfo(ShowPath);
  assert.deepEqual(Info, { CreatedWithVersion: CurrentVersion, SavedWithVersion: CurrentVersion });
  // Stamping is bookkeeping, not an edit.
  assert.equal(await DB.HasUnsavedChanges(), false);

  await DB.Shutdown();
});

test('a file this version saved opens straight away', async () => {
  const Root = tempRoot();
  const { BackupManager, DB, Backups } = loadBackupManager(Root);
  await DB.Ready();
  const ShowPath = path.join(Root, 'Current.ShowTrak');
  await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Current Group', 1]);
  await BackupManager.Save(ShowPath);
  await DB.ResetToEmpty();

  const [Err, Outcome] = await BackupManager.RequestOpen(ShowPath);
  assert.equal(Err, null);
  assert.deepEqual(Outcome, { Status: 'Opened', FilePath: ShowPath });
  assert.deepEqual(await groupTitles(DB), ['Current Group']);
  assert.deepEqual(backupsIn(Backups), []);

  await DB.Shutdown();
});

test('opening an older file asks first and leaves the file and working data alone', async () => {
  const Root = tempRoot();
  const { BackupManager, DB, Backups } = loadBackupManager(Root);
  const OldPath = path.join(Root, 'Old Show.ShowTrak');
  await writeOlderShowFile(DB, OldPath, '3.0.0');
  const Original = fs.readFileSync(OldPath);

  const [Err, Outcome] = await BackupManager.RequestOpen(OldPath);
  assert.equal(Err, null);
  assert.deepEqual(Outcome, {
    Status: 'UpgradeRequired',
    Upgrade: {
      FilePath: OldPath,
      FileName: 'Old Show.ShowTrak',
      FileVersion: '3.0.0',
      CurrentVersion,
    },
  });
  assert.equal(BackupManager.GetCurrentFilePath(), null);
  assert.deepEqual(await groupTitles(DB), []);

  // Nothing, not even autosave, may write to it while the question is open.
  const [SaveErr] = await BackupManager.Save(OldPath);
  assert.match(String(SaveErr), /confirm the show file upgrade/i);
  assert.ok(fs.readFileSync(OldPath).equals(Original));
  assert.deepEqual(backupsIn(Backups), []);

  await DB.Shutdown();
});

test('accepting the upgrade backs up the original before opening and upgrading it', async () => {
  const Root = tempRoot();
  const { BackupManager, DB, Backups } = loadBackupManager(Root);
  const OldPath = path.join(Root, 'Old Show.ShowTrak');
  await writeOlderShowFile(DB, OldPath, '3.0.0');
  const Original = fs.readFileSync(OldPath);
  await BackupManager.RequestOpen(OldPath);

  const [Err, Result] = await BackupManager.AcceptUpgrade();
  assert.equal(Err, null);
  assert.equal(Result.FilePath, OldPath);

  const Copies = backupsIn(Backups);
  assert.equal(Copies.length, 1);
  assert.match(Copies[0], /^Old Show \(v3\.0\.0\) \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.ShowTrak$/);
  assert.equal(Result.BackupPath, path.join(Backups, Copies[0]));
  assert.ok(
    fs.readFileSync(Result.BackupPath).equals(Original),
    'backup is the untouched original'
  );

  assert.equal(BackupManager.GetCurrentFilePath(), OldPath);
  assert.deepEqual(await groupTitles(DB), ['Old Show Group']);
  const [, Info] = await DB.ReadFileInfo(OldPath);
  assert.equal(Info.SavedWithVersion, CurrentVersion, 'the file itself is upgraded');
  assert.equal(BackupManager.GetPendingUpgrade(), null);

  // Later saves to the upgraded file need no further backup.
  await BackupManager.Save(OldPath);
  assert.equal(backupsIn(Backups).length, 1);

  await DB.Shutdown();
});

test('declining the upgrade leaves the file untouched and clears to an empty state', async () => {
  const Root = tempRoot();
  const { BackupManager, DB, Backups } = loadBackupManager(Root);
  const ShowPath = path.join(Root, 'Previous.ShowTrak');
  await DB.Ready();
  await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Previous Group', 1]);
  await BackupManager.Save(ShowPath);
  const OldPath = path.join(Root, 'Old Show.ShowTrak');
  // writeOlderShowFile resets the working data; re-open the previous show.
  await writeOlderShowFile(DB, OldPath, null);
  await BackupManager.Open(ShowPath);
  const Original = fs.readFileSync(OldPath);

  const [, Outcome] = await BackupManager.RequestOpen(OldPath);
  assert.equal(Outcome.Upgrade.FileVersion, null, 'a file from before version stamping');

  const [Err] = await BackupManager.DeclineUpgrade();
  assert.equal(Err, null);
  assert.equal(BackupManager.GetCurrentFilePath(), null);
  assert.deepEqual(await groupTitles(DB), []);
  assert.ok(fs.readFileSync(OldPath).equals(Original));
  assert.deepEqual(backupsIn(Backups), []);

  await DB.Shutdown();
});

test('after an update, the show file left open is held until the operator answers', async () => {
  const Root = tempRoot();
  const OldPath = path.join(Root, 'Old Show.ShowTrak');
  {
    const { DB } = loadBackupManager(tempRoot());
    await writeOlderShowFile(DB, OldPath, '3.0.0');
    await DB.Shutdown();
  }
  const { BackupManager, DB, Backups } = loadBackupManager(Root, { CurrentFilePath: OldPath });
  await DB.Ready();
  // The working data carried over from last session, possibly with changes not
  // yet saved to the file.
  await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Working Group', 1]);
  const Original = fs.readFileSync(OldPath);

  // Autosave firing before the operator has been asked must not write to it.
  const [EarlySaveErr] = await BackupManager.Save(OldPath);
  assert.match(String(EarlySaveErr), /confirm the show file upgrade/i);

  const [Err, Upgrade] = await BackupManager.CheckCurrentFile();
  assert.equal(Err, null);
  assert.equal(Upgrade.FilePath, OldPath);
  assert.equal(Upgrade.FileVersion, '3.0.0');
  assert.ok(fs.readFileSync(OldPath).equals(Original));

  const [AcceptErr] = await BackupManager.AcceptUpgrade();
  assert.equal(AcceptErr, null);
  assert.equal(backupsIn(Backups).length, 1);
  // The working data is kept as it was rather than reloaded from the file.
  assert.deepEqual(await groupTitles(DB), ['Working Group']);

  const [SaveErr] = await BackupManager.Save(OldPath);
  assert.equal(SaveErr, null);
  const [, Info] = await DB.ReadFileInfo(OldPath);
  assert.equal(Info.SavedWithVersion, CurrentVersion);
  assert.equal(backupsIn(Backups).length, 1);

  await DB.Shutdown();
});

test('the show file left open is not held when this version saved it', async () => {
  const Root = tempRoot();
  const ShowPath = path.join(Root, 'Current.ShowTrak');
  {
    const { BackupManager, DB } = loadBackupManager(tempRoot());
    await DB.Ready();
    await BackupManager.Save(ShowPath);
    await DB.Shutdown();
  }
  const { BackupManager, DB } = loadBackupManager(Root, { CurrentFilePath: ShowPath });
  await DB.Ready();
  assert.deepEqual(await BackupManager.CheckCurrentFile(), [null, null]);
  assert.equal((await BackupManager.Save(ShowPath))[0], null);
  await DB.Shutdown();
});

test('Save As over a different older show file backs it up first', async () => {
  const Root = tempRoot();
  const { BackupManager, DB, Backups } = loadBackupManager(Root);
  const OldPath = path.join(Root, 'Old Show.ShowTrak');
  await writeOlderShowFile(DB, OldPath, '2.9.0');
  const Original = fs.readFileSync(OldPath);

  await DB.Run('INSERT INTO Groups (Title, Weight) VALUES (?, ?)', ['Replacement', 1]);
  const [Err] = await BackupManager.Save(OldPath);
  assert.equal(Err, null);

  const Copies = backupsIn(Backups);
  assert.equal(Copies.length, 1);
  assert.match(Copies[0], /^Old Show \(v2\.9\.0\) /);
  assert.ok(fs.readFileSync(path.join(Backups, Copies[0])).equals(Original));

  await DB.Shutdown();
});

test('opening a file that is not a show file fails without asking to upgrade it', async () => {
  const Root = tempRoot();
  const { BackupManager, DB } = loadBackupManager(Root);
  await DB.Ready();
  const Bogus = path.join(Root, 'notes.ShowTrak');
  fs.writeFileSync(Bogus, 'plain text, not a show');

  const [Err, Outcome] = await BackupManager.RequestOpen(Bogus);
  assert.match(String(Err), /not a valid ShowTrak file/i);
  assert.equal(Outcome, null);
  assert.equal(BackupManager.GetPendingUpgrade(), null);

  await DB.Shutdown();
});
