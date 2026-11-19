const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/show.ts: the ShowTrak file save/open/new flows
// reached from the File menu and the renderer.
//
// Highest-consequence registrar: every path here either writes a show file or
// tells the renderer which file is current. The property that matters most is
// that the renderer is only ever told "the show file changed" AFTER a write
// actually succeeded; a stale title bar convinces an operator their work is
// saved when it is not.
//
// Follows the pattern in main-registrar-groups.test.js: only the managers and
// Electron are stubbed; the real RPC wrapper and handler registry are used.

const state = {
  currentFilePath: '/shows/current.showtrak',
  saveResult: [null, { Saved: true }],
  openResult: [null, { Status: 'Opened', FilePath: '/shows/opened.showtrak' }],
  newResult: [null, { Created: true }],
  ensureResult: [null, { Missing: false }],
  checkResult: [null, null],
  acceptResult: [null, { FilePath: '/shows/old.showtrak', BackupPath: '/backups/old.showtrak' }],
  declineResult: [null, 'Upgrade declined'],
  hasUnsavedWorkingData: false,
  saveDialog: { canceled: false, filePath: '/shows/picked.showtrak' },
  openDialog: { canceled: false, filePaths: ['/shows/opened.showtrak'] },
  hasUnsavedChanges: false,
  autosave: false,
  promptResponse: 0,
};

const showFileUpdated = [];
const prompts = [];

const backupMgr = recordingManager({
  GetCurrentFilePath: () => state.currentFilePath,
  Save: () => state.saveResult,
  RequestOpen: () => state.openResult,
  New: () => state.newResult,
  EnsureCurrentFileExists: () => state.ensureResult,
  CheckCurrentFile: () => state.checkResult,
  AcceptUpgrade: () => state.acceptResult,
  DeclineUpgrade: () => state.declineResult,
  HasUnsavedWorkingData: () => state.hasUnsavedWorkingData,
  HasUnsavedChanges: () => state.hasUnsavedChanges,
});
const fileSelectorMgr = recordingManager({
  SaveDialog: () => state.saveDialog,
  OpenDialog: () => state.openDialog,
});

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  {
    match: matchesModule('../app-window'),
    value: { sendShowFileUpdated: (path) => showFileUpdated.push(path), getMainWindow: () => null },
  },
  { match: matchesModule('/Modules/BackupManager'), value: { Manager: backupMgr } },
  { match: matchesModule('/Modules/FileSelectorManager'), value: { Manager: fileSelectorMgr } },
  {
    match: matchesModule('/Modules/SettingsManager'),
    value: { Manager: { GetValue: async () => state.autosave } },
  },
  {
    match: (request) => request === 'electron',
    value: {
      dialog: {
        showMessageBox: async (...args) => {
          const Options = args[args.length - 1];
          prompts.push(Options);
          return { response: state.promptResponse };
        },
        showErrorBox: () => {},
      },
    },
  },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/show');
const FileAssociations = require('../dist/main/file-associations');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.currentFilePath = '/shows/current.showtrak';
  state.saveResult = [null, { Saved: true }];
  state.openResult = [null, { Status: 'Opened', FilePath: '/shows/opened.showtrak' }];
  state.newResult = [null, { Created: true }];
  state.ensureResult = [null, { Missing: false }];
  state.checkResult = [null, null];
  state.acceptResult = [
    null,
    { FilePath: '/shows/old.showtrak', BackupPath: '/backups/old.showtrak' },
  ];
  state.declineResult = [null, 'Upgrade declined'];
  state.hasUnsavedWorkingData = false;
  state.saveDialog = { canceled: false, filePath: '/shows/picked.showtrak' };
  state.openDialog = { canceled: false, filePaths: ['/shows/opened.showtrak'] };
  state.hasUnsavedChanges = false;
  state.autosave = false;
  state.promptResponse = 0;
  prompts.length = 0;
  FileAssociations.ResetShowFileRequestsForTests();
  showFileUpdated.length = 0;
  backupMgr.__calls.length = 0;
  fileSelectorMgr.__calls.length = 0;
});

test('registers a handler for every show channel', () => {
  for (const Channel of [
    'Show:Save',
    'Show:SaveAs',
    'Show:Open',
    'Show:GetCurrentFile',
    'Show:HasUnsavedData',
    'Show:EnsureFileExists',
    'Show:CheckUpgrade',
    'Show:ResolveUpgrade',
    'Show:New',
    'Show:OpenRequested',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- Show:Save --------------------------------------------------------------

test('Show:Save writes straight to the open file without prompting', async () => {
  const Result = await GetHandler('Show:Save')(null);
  assert.deepEqual(Result, [null, { Saved: true }]);
  assert.deepEqual(backupMgr.__callsTo('Save')[0].args, ['/shows/current.showtrak']);
  assert.equal(fileSelectorMgr.__callsTo('SaveDialog').length, 0);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
});

test('Show:Save falls back to Save As when no file has been opened yet', async () => {
  state.currentFilePath = null;
  const Result = await GetHandler('Show:Save')(null);

  assert.deepEqual(Result, [null, { Saved: true }]);
  assert.equal(fileSelectorMgr.__callsTo('SaveDialog').length, 1);
  assert.deepEqual(backupMgr.__callsTo('Save')[0].args, ['/shows/picked.showtrak']);
});

test('Show:Save reports cancellation when the user dismisses the Save As dialog', async () => {
  state.currentFilePath = null;
  state.saveDialog = { canceled: true, filePath: null };

  assert.deepEqual(await GetHandler('Show:Save')(null), ['Cancelled By User', null]);
  assert.equal(backupMgr.__callsTo('Save').length, 0);
  assert.deepEqual(showFileUpdated, []);
});

test('Show:Save treats a dialog that returns no path as a cancellation', async () => {
  state.currentFilePath = null;
  state.saveDialog = { canceled: false, filePath: '' };

  assert.deepEqual(await GetHandler('Show:Save')(null), ['Cancelled By User', null]);
  assert.equal(backupMgr.__callsTo('Save').length, 0);
});

test('Show:Save surfaces a write failure and does NOT claim the file was updated', async () => {
  // The critical negative: telling the renderer the show file changed after a
  // failed write leaves the operator believing their work is safe.
  state.saveResult = ['disk full', null];

  assert.deepEqual(await GetHandler('Show:Save')(null), ['disk full', null]);
  assert.deepEqual(showFileUpdated, []);
});

// --- Show:SaveAs ------------------------------------------------------------

test('Show:SaveAs always prompts, even when a file is already open', async () => {
  const Result = await GetHandler('Show:SaveAs')(null);
  assert.deepEqual(Result, [null, { Saved: true }]);
  assert.equal(fileSelectorMgr.__callsTo('SaveDialog').length, 1);
  assert.deepEqual(backupMgr.__callsTo('Save')[0].args, ['/shows/picked.showtrak']);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
});

test('Show:SaveAs reports cancellation without writing', async () => {
  state.saveDialog = { canceled: true, filePath: null };
  assert.deepEqual(await GetHandler('Show:SaveAs')(null), ['Cancelled By User', null]);
  assert.equal(backupMgr.__callsTo('Save').length, 0);
});

test('Show:SaveAs surfaces a write failure without announcing an update', async () => {
  state.saveResult = ['permission denied', null];
  assert.deepEqual(await GetHandler('Show:SaveAs')(null), ['permission denied', null]);
  assert.deepEqual(showFileUpdated, []);
});

// --- Show:Open --------------------------------------------------------------

test('Show:Open loads the first selected path and announces the change', async () => {
  const Result = await GetHandler('Show:Open')(null);
  assert.deepEqual(Result, [null, { Status: 'Opened', FilePath: '/shows/opened.showtrak' }]);
  assert.deepEqual(backupMgr.__callsTo('RequestOpen')[0].args, ['/shows/opened.showtrak']);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
});

test('Show:Open hands an older file back for confirmation without announcing a change', async () => {
  // Nothing has been opened yet: the title bar must keep naming the old show
  // until the operator agrees to the upgrade.
  const Upgrade = {
    FilePath: '/shows/opened.showtrak',
    FileName: 'opened.showtrak',
    FileVersion: '3.28.0',
    CurrentVersion: '3.29.3',
  };
  state.openResult = [null, { Status: 'UpgradeRequired', Upgrade }];

  assert.deepEqual(await GetHandler('Show:Open')(null), [
    null,
    { Status: 'UpgradeRequired', Upgrade },
  ]);
  assert.deepEqual(showFileUpdated, []);
});

test('Show:Open reports cancellation for a dismissed or empty selection', async () => {
  for (const Dialog of [
    { canceled: true, filePaths: [] },
    { canceled: false, filePaths: [] },
    { canceled: false, filePaths: null },
  ]) {
    backupMgr.__calls.length = 0;
    state.openDialog = Dialog;
    assert.deepEqual(await GetHandler('Show:Open')(null), ['Cancelled By User', null]);
    assert.equal(backupMgr.__callsTo('RequestOpen').length, 0);
  }
});

test('Show:Open surfaces a load failure without announcing an update', async () => {
  state.openResult = ['not a ShowTrak file', null];
  assert.deepEqual(await GetHandler('Show:Open')(null), ['not a ShowTrak file', null]);
  assert.deepEqual(showFileUpdated, []);
});

// --- Readers ----------------------------------------------------------------

test('Show:GetCurrentFile returns the raw path, not a tuple', async () => {
  // Reader contract: the renderer consumes the value directly.
  assert.equal(await GetHandler('Show:GetCurrentFile')(null), '/shows/current.showtrak');
  state.currentFilePath = null;
  assert.equal(await GetHandler('Show:GetCurrentFile')(null), null);
});

test('Show:HasUnsavedData returns the raw boolean', async () => {
  state.hasUnsavedWorkingData = true;
  assert.equal(await GetHandler('Show:HasUnsavedData')(null), true);
  state.hasUnsavedWorkingData = false;
  assert.equal(await GetHandler('Show:HasUnsavedData')(null), false);
});

// --- Show:EnsureFileExists --------------------------------------------------

test('Show:EnsureFileExists stays quiet when the file is still present', async () => {
  assert.deepEqual(await GetHandler('Show:EnsureFileExists')(null), [null, { Missing: false }]);
  assert.deepEqual(showFileUpdated, []);
});

test('Show:EnsureFileExists tells the renderer when the file went missing', async () => {
  // The show file was deleted or its drive unmounted underneath us; the renderer
  // needs to drop back to an unsaved state rather than keep showing the path.
  state.ensureResult = [null, { Missing: true }];
  assert.deepEqual(await GetHandler('Show:EnsureFileExists')(null), [null, { Missing: true }]);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
});

test('Show:EnsureFileExists passes an error through untouched', async () => {
  state.ensureResult = ['stat failed', null];
  assert.deepEqual(await GetHandler('Show:EnsureFileExists')(null), ['stat failed', null]);
  assert.deepEqual(showFileUpdated, []);
});

// --- Show:CheckUpgrade / Show:ResolveUpgrade ----------------------------------

test('Show:CheckUpgrade passes the pending upgrade through', async () => {
  assert.deepEqual(await GetHandler('Show:CheckUpgrade')(null), [null, null]);
  const Upgrade = { FilePath: '/shows/current.showtrak', FileVersion: null };
  state.checkResult = [null, Upgrade];
  assert.deepEqual(await GetHandler('Show:CheckUpgrade')(null), [null, Upgrade]);
});

test('Show:ResolveUpgrade(true) backs up and upgrades, then announces the file', async () => {
  const Result = await GetHandler('Show:ResolveUpgrade')(null, true);
  assert.deepEqual(Result, [
    null,
    { FilePath: '/shows/old.showtrak', BackupPath: '/backups/old.showtrak' },
  ]);
  assert.equal(backupMgr.__callsTo('AcceptUpgrade').length, 1);
  assert.equal(backupMgr.__callsTo('DeclineUpgrade').length, 0);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
});

test('Show:ResolveUpgrade(false) declines and announces the cleared show', async () => {
  state.currentFilePath = null;
  assert.deepEqual(await GetHandler('Show:ResolveUpgrade')(null, false), [
    null,
    'Upgrade declined',
  ]);
  assert.equal(backupMgr.__callsTo('DeclineUpgrade').length, 1);
  assert.equal(backupMgr.__callsTo('AcceptUpgrade').length, 0);
  assert.deepEqual(showFileUpdated, [null]);
});

test('Show:ResolveUpgrade rejects a non-boolean answer without acting on it', async () => {
  // Declining wipes the working data, so a malformed answer must never be
  // read as "no".
  for (const Answer of [undefined, null, 'false', 0]) {
    const [Err] = await GetHandler('Show:ResolveUpgrade')(null, Answer);
    assert.match(String(Err), /must be a boolean/);
  }
  assert.equal(backupMgr.__callsTo('AcceptUpgrade').length, 0);
  assert.equal(backupMgr.__callsTo('DeclineUpgrade').length, 0);
});

test('Show:ResolveUpgrade surfaces a failed backup without announcing an update', async () => {
  state.acceptResult = ['Failed to back up the show file: EACCES', null];
  assert.deepEqual(await GetHandler('Show:ResolveUpgrade')(null, true), [
    'Failed to back up the show file: EACCES',
    null,
  ]);
  assert.deepEqual(showFileUpdated, []);
});

// --- Show:New ---------------------------------------------------------------

test('Show:New saves the new show where the operator chose and announces it', async () => {
  assert.deepEqual(await GetHandler('Show:New')(null), [null, { Created: true }]);
  assert.equal(fileSelectorMgr.__callsTo('SaveDialog').length, 1);
  assert.deepEqual(backupMgr.__callsTo('New')[0].args, ['/shows/picked.showtrak']);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
});

test('Show:New does nothing when the operator cancels choosing a location', async () => {
  // A new show always has a file behind it: no location, no new show, and the
  // current working data is left alone.
  for (const Dialog of [
    { canceled: true, filePath: null },
    { canceled: false, filePath: '' },
  ]) {
    state.saveDialog = Dialog;
    assert.deepEqual(await GetHandler('Show:New')(null), ['Cancelled By User', null]);
  }
  assert.equal(backupMgr.__callsTo('New').length, 0);
  assert.deepEqual(showFileUpdated, []);
});

test('Show:New surfaces a failure without announcing an update', async () => {
  state.newResult = ['could not reset database', null];
  assert.deepEqual(await GetHandler('Show:New')(null), ['could not reset database', null]);
  assert.deepEqual(showFileUpdated, []);
});

// --- Show:OpenRequested -----------------------------------------------------
// A show file double-clicked in Finder/Explorer. The request is held by
// main/file-associations until the renderer takes it here.

test('Show:OpenRequested with nothing waiting does nothing', async () => {
  const Result = await GetHandler('Show:OpenRequested')(null);
  assert.deepEqual(Result, [null, null]);
  assert.equal(backupMgr.__callsTo('RequestOpen').length, 0);
});

test('Show:OpenRequested opens a file that launched the app without asking', async () => {
  FileAssociations.RequestShowFileOpen('/shows/opened.showtrak');
  const Result = await GetHandler('Show:OpenRequested')(null);
  assert.deepEqual(Result, [null, { Status: 'Opened', FilePath: '/shows/opened.showtrak' }]);
  assert.deepEqual(backupMgr.__callsTo('RequestOpen')[0].args, ['/shows/opened.showtrak']);
  assert.equal(prompts.length, 0);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
  // Taken: a second call finds nothing.
  assert.deepEqual(await GetHandler('Show:OpenRequested')(null), [null, null]);
});

test('Show:OpenRequested asks before a file opened while running replaces the show', async () => {
  await GetHandler('Show:OpenRequested')(null); // the renderer has started
  FileAssociations.RequestShowFileOpen('/shows/opened.showtrak');
  state.promptResponse = 1; // Cancel
  const Result = await GetHandler('Show:OpenRequested')(null);
  assert.deepEqual(Result, ['Cancelled By User', null]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /Open opened\.showtrak\?/);
  assert.equal(backupMgr.__callsTo('RequestOpen').length, 0);
});

test('Show:OpenRequested leaves the file that is already open alone', async () => {
  FileAssociations.RequestShowFileOpen('/shows/current.showtrak');
  assert.deepEqual(await GetHandler('Show:OpenRequested')(null), [null, null]);
  assert.equal(backupMgr.__callsTo('RequestOpen').length, 0);
});

test('Show:OpenRequested saves unsaved changes first when the operator says Save', async () => {
  state.hasUnsavedChanges = true;
  state.promptResponse = 0; // Save
  FileAssociations.RequestShowFileOpen('/shows/opened.showtrak');
  const Result = await GetHandler('Show:OpenRequested')(null);
  assert.equal(Result[1].Status, 'Opened');
  assert.deepEqual(backupMgr.__callsTo('Save')[0].args, ['/shows/current.showtrak']);
  const Order = backupMgr.__calls
    .map((c) => c.method)
    .filter((m) => m === 'Save' || m === 'RequestOpen');
  assert.deepEqual(Order, ['Save', 'RequestOpen'], 'saved before the new file replaced it');
});

test('Show:OpenRequested passes an upgrade back for the renderer to ask about', async () => {
  const Upgrade = {
    FilePath: '/shows/old.showtrak',
    FileName: 'old.showtrak',
    FileVersion: '3.0.0',
    CurrentVersion: '3.32.1',
  };
  state.openResult = [null, { Status: 'UpgradeRequired', Upgrade }];
  FileAssociations.RequestShowFileOpen('/shows/old.showtrak');
  const Result = await GetHandler('Show:OpenRequested')(null);
  assert.deepEqual(Result, [null, { Status: 'UpgradeRequired', Upgrade }]);
  assert.deepEqual(showFileUpdated, [], 'nothing opened yet');
});
