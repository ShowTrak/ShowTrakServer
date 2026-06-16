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
  const dbMock = {
    Manager: {
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
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'BackupManager', 'index.js');
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

  // New: resets the database to empty and clears the current file pointer.
  const resetBeforeNew = resetCalls;
  const [newErr, newMsg] = await Manager.New();
  assert.equal(newErr, null);
  assert.match(newMsg, /new show/i);
  assert.equal(resetCalls, resetBeforeNew + 1);
  assert.equal(Manager.GetCurrentFilePath(), null);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).CurrentFilePath, null);
  // With no file associated but data present, it reports unsaved legacy data.
  assert.equal(await Manager.HasUnsavedWorkingData(), true);
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
  assert.equal(resetCalls, resetBeforeMissing + 1);
  assert.equal(Manager.GetCurrentFilePath(), null);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).CurrentFilePath, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('WOLManager returns success and error tuples from wakeonlan', async () => {
  const wolModulePath = path.join(__dirname, '..', 'src', 'Modules', 'WOLManager', 'index.js');

  const { Manager: SuccessManager } = loadWithMocks(wolModulePath, {
    wakeonlan: () => Promise.resolve(),
  });
  const [okErr, okMsg] = await SuccessManager.Wake('aa:bb:cc:dd:ee:ff', 2, 5);
  assert.equal(okErr, null);
  assert.match(okMsg, /successfully/i);

  const { Manager: ErrorManager } = loadWithMocks(wolModulePath, {
    wakeonlan: () => Promise.reject(new Error('network down')),
  });
  const [failErr, failMsg] = await ErrorManager.Wake('aa:bb:cc:dd:ee:ff');
  assert.equal(failMsg, null);
  assert.match(String(failErr), /network down/i);
});

test('ChecksumManager delegates to checksum.file and returns the digest', async () => {
  const checksumModulePath = path.join(
    __dirname,
    '..',
    'src',
    'Modules',
    'ChecksumManager',
    'index.js'
  );
  const { Manager } = loadWithMocks(checksumModulePath, {
    checksum: {
      file: (_filePath, cb) => cb(null, 'deadbeef'),
    },
  });

  const result = await Manager.Checksum('/tmp/file.txt');
  assert.equal(result, 'deadbeef');
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
  fs.writeFileSync(path.join(invalidDotFolderDir, 'Script.json'), JSON.stringify({ Name: 'Ignored Dot' }), 'utf8');
  fs.writeFileSync(
    path.join(invalidSpacedFolderDir, 'Script.json'),
    JSON.stringify({ Name: 'Ignored Spaced' }),
    'utf8'
  );
  fs.writeFileSync(path.join(scriptDir, 'run.sh'), 'echo test', 'utf8');

  const events = [];

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ScriptManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../AppData': { Manager: { GetScriptsDirectory: () => tmpDir } },
    '../ChecksumManager': { Manager: { Checksum: async () => 'sum123' } },
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
