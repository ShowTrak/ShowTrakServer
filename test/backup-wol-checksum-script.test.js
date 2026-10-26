const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  return {
    log: () => {},
    warn: () => {},
    error: () => {},
  };
}

test('BackupManager saves, opens, and creates new ShowTrak files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-backup-'));
  const savePath = path.join(tmpDir, 'nested', 'Show.ShowTrak');

  const events = [];
  const snapshotCalls = [];
  const replaceCalls = [];
  let resetCalls = 0;
  let hasUnsavedChanges = true;
  const stamps = [];
  const currentVersion = require('../package.json').version;
  const dbMock = {
    Manager: {
      // Version stamping into the ShowFileInfo table.
      Run: async (sql, params) => {
        stamps.push(params);
        return [null, { changes: 1, lastID: 0 }];
      },
      // Every file on disk here was saved by this version: no upgrade prompts.
      ReadFileInfo: async () => [
        null,
        { CreatedWithVersion: currentVersion, SavedWithVersion: currentVersion },
      ],
      // Emulate VACUUM INTO by writing a placeholder snapshot file.
      SnapshotTo: async (target) => {
        snapshotCalls.push(target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'SQLiteSnapshot');
        return [null, target];
      },
      ReplaceWithFile: async (source) => {
        replaceCalls.push(source);
        return [null, source];
      },
      ResetToEmpty: async () => {
        resetCalls += 1;
        return [null, 'db'];
      },
      HasData: async () => true,
      HasUnsavedChanges: async () => hasUnsavedChanges,
      MarkClean: () => {
        hasUnsavedChanges = false;
      },
    },
  };

  const statePath = path.join(tmpDir, 'state.json');
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'BackupManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': dbMock,
    '../AppData': { Manager: { GetStateFilePath: () => statePath } },
    '../Broadcast': { Manager: { emit: (event) => events.push(event) } },
  });

  // Save As: delegates to a full-database snapshot and reports success.
  const [saveErr, saveMsg] = await Manager.Save(savePath);
  assert.equal(saveErr, null);
  assert.match(saveMsg, /saved/i);
  assert.deepEqual(snapshotCalls, [savePath]);
  assert.equal(fs.existsSync(savePath), true);
  assert.deepEqual(stamps, [['SavedWithVersion', currentVersion]]);
  // The open file path is persisted so it survives a relaunch.
  assert.equal(Manager.GetCurrentFilePath(), savePath);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).CurrentFilePath, savePath);
  // With a file associated, working data is considered saved (not legacy).
  assert.equal(await Manager.HasUnsavedWorkingData(), false);
  assert.equal(await Manager.HasUnsavedChanges(), false);

  // The saved file exists on disk, so the boot-time integrity check is a no-op.
  const [, presentResult] = await Manager.EnsureCurrentFileExists();
  assert.equal(presentResult.Missing, false);
  assert.equal(Manager.GetCurrentFilePath(), savePath);

  // Open: swaps the working database and triggers a full re-hydration.
  const [openErr, openMsg] = await Manager.Open(savePath);
  assert.equal(openErr, null);
  assert.match(openMsg, /opened/i);
  assert.deepEqual(replaceCalls, [savePath]);
  assert.ok(events.includes('ReinitializeSystem'));

  // Opening a missing file fails before touching the database.
  const [missingErr] = await Manager.Open(path.join(tmpDir, 'does-not-exist.ShowTrak'));
  assert.match(String(missingErr), /does not exist/i);
  assert.equal(replaceCalls.length, 1);

  // New: resets the database to empty, then saves it straight away to the
  // chosen location, so the new show always has a file behind it.
  const newPath = path.join(tmpDir, 'New.ShowTrak');
  const resetBeforeNew = resetCalls;
  stamps.length = 0;
  const [newErr, newMsg] = await Manager.New(newPath);
  assert.equal(newErr, null);
  assert.match(newMsg, /new show/i);
  assert.equal(resetCalls, resetBeforeNew + 1);
  assert.deepEqual(stamps, [
    ['CreatedWithVersion', currentVersion],
    ['SavedWithVersion', currentVersion],
  ]);
  assert.equal(snapshotCalls.at(-1), newPath);
  assert.equal(Manager.GetCurrentFilePath(), newPath);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).CurrentFilePath, newPath);
  assert.equal(await Manager.HasUnsavedWorkingData(), false);
  assert.equal(await Manager.HasUnsavedChanges(), false);

  // Boot-time integrity check: re-associate a file then delete it from disk;
  // the next check wipes the working data and clears the pointer.
  await Manager.Save(savePath);
  assert.equal(Manager.GetCurrentFilePath(), savePath);
  fs.unlinkSync(savePath);
  const resetBeforeMissing = resetCalls;
  const [missingCheckErr, missingResult] = await Manager.EnsureCurrentFileExists();
  assert.equal(missingCheckErr, null);
  assert.equal(missingResult.Missing, true);
  assert.equal(missingResult.FilePath, savePath);
  assert.equal(resetCalls, resetBeforeMissing + 1);
  assert.equal(Manager.GetCurrentFilePath(), null);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).CurrentFilePath, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ChecksumFile returns the SHA-1 hex digest of the file contents', async () => {
  const crypto = require('node:crypto');
  // Lives in the shared submodule (@showtrak/protocol/runtime): the Server ships
  // these digests in the Script.json manifest and the Client compares against
  // them, so the two sides have to agree on the algorithm exactly. Requiring it
  // by package name also proves the `file:./shared` symlink resolves.
  const { ChecksumFile } = require('@showtrak/protocol/runtime');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-checksum-'));
  const filePath = path.join(tmpDir, 'file.txt');
  const contents = 'ShowTrak checksum test contents';
  fs.writeFileSync(filePath, contents);

  const expected = crypto.createHash('sha1').update(contents).digest('hex');
  assert.equal(await ChecksumFile(filePath), expected);

  // Unreadable path resolves null instead of rejecting or hanging, and can still
  // report why.
  const reported = [];
  assert.equal(await ChecksumFile(path.join(tmpDir, 'missing.txt'), (m) => reported.push(m)), null);
  assert.equal(reported.length, 1);
});

test('ScriptManager loads script folders and computes file checksums', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-scripts-'));
  const scriptDir = path.join(tmpDir, 'MyScript');
  const invalidDotFolderDir = path.join(tmpDir, '.github');
  const invalidSpacedFolderDir = path.join(tmpDir, 'Bad Script');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(invalidDotFolderDir, { recursive: true });
  fs.mkdirSync(invalidSpacedFolderDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptDir, 'Script.json'),
    JSON.stringify({ Name: 'My Script', Type: 'Action', Path: 'run.sh', Enabled: true }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(invalidDotFolderDir, 'Script.json'),
    JSON.stringify({ Name: 'Ignored Dot' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(invalidSpacedFolderDir, 'Script.json'),
    JSON.stringify({ Name: 'Ignored Spaced' }),
    'utf8'
  );
  fs.writeFileSync(path.join(scriptDir, 'run.sh'), 'echo test', 'utf8');

  const events = [];

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../AppData': { Manager: { GetScriptsDirectory: () => tmpDir } },
    '@showtrak/protocol/runtime': { ChecksumFile: async () => 'sum123' },
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
  });

  const scripts = await Manager.GetScripts();
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].ID, 'MyScript');
  assert.equal(
    scripts[0].Files.some((f) => f.Path === 'run.sh' && f.Checksum === 'sum123'),
    true
  );

  const script = await Manager.Get('MyScript');
  assert.equal(script.Name, 'My Script');
  assert.equal(await Manager.Get('.github'), null);
  assert.equal(await Manager.Get('Bad Script'), null);

  assert.equal(events.length, 0);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ScriptManager round-trips the confirmation level through Script.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-scripts-'));
  const scriptDir = path.join(tmpDir, 'Shutdown');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptDir, 'Script.json'),
    JSON.stringify({ Name: 'Shutdown', Confirmation: true, Platforms: { macOS: 'run.sh' } }),
    'utf8'
  );
  fs.writeFileSync(path.join(scriptDir, 'run.sh'), 'echo test', 'utf8');

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../AppData': { Manager: { GetScriptsDirectory: () => tmpDir } },
    '@showtrak/protocol/runtime': { ChecksumFile: async () => 'sum123' },
    '../Broadcast': { Manager: { emit: () => {} } },
  });
  const ReadJson = () => JSON.parse(fs.readFileSync(path.join(scriptDir, 'Script.json'), 'utf8'));

  // A legacy boolean reads as a standard confirmation.
  assert.equal((await Manager.Get('Shutdown')).ConfirmationLevel, 'Standard');
  let [, Editable] = await Manager.GetEditable('Shutdown');
  assert.equal(Editable.confirmation, 'Standard');

  // Critical keeps the boolean (for older clients/SDKs) and adds the style.
  await Manager.SaveFields('Shutdown', { ...Editable, confirmation: 'Critical' });
  assert.equal(ReadJson().Confirmation, true);
  assert.equal(ReadJson().ConfirmationStyle, 'Critical');
  assert.equal((await Manager.Get('Shutdown')).ConfirmationLevel, 'Critical');
  [, Editable] = await Manager.GetEditable('Shutdown');
  assert.equal(Editable.confirmation, 'Critical');

  // None clears both.
  await Manager.SaveFields('Shutdown', { ...Editable, confirmation: 'None' });
  assert.equal(ReadJson().Confirmation, false);
  assert.equal('ConfirmationStyle' in ReadJson(), false);
  assert.equal((await Manager.Get('Shutdown')).ConfirmationLevel, 'None');

  // The legacy boolean field is still honoured when no level is sent.
  await Manager.SaveFields('Shutdown', { name: 'Shutdown', confirm: true });
  assert.equal((await Manager.Get('Shutdown')).ConfirmationLevel, 'Standard');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
