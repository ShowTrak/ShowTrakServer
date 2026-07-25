const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/show.ts — the ShowTrak file save/open/new flows
// reached from the File menu and the renderer.
//
// Highest-consequence registrar: every path here either writes a show file or
// tells the renderer which file is current. The property that matters most is
// that the renderer is only ever told "the show file changed" AFTER a write
// actually succeeded — a stale title bar convinces an operator their work is
// saved when it is not.
//
// Follows the pattern in main-registrar-groups.test.js: only the managers and
// Electron are stubbed; the real RPC wrapper and handler registry are used.

const state = {
  currentFilePath: '/shows/current.showtrak',
  saveResult: [null, { Saved: true }],
  openResult: [null, { Opened: true }],
  newResult: [null, { Created: true }],
  ensureResult: [null, { Missing: false }],
  hasUnsavedWorkingData: false,
  saveDialog: { canceled: false, filePath: '/shows/picked.showtrak' },
  openDialog: { canceled: false, filePaths: ['/shows/opened.showtrak'] },
};

const showFileUpdated = [];

const backupMgr = recordingManager({
  GetCurrentFilePath: () => state.currentFilePath,
  Save: () => state.saveResult,
  Open: () => state.openResult,
  New: () => state.newResult,
  EnsureCurrentFileExists: () => state.ensureResult,
  HasUnsavedWorkingData: () => state.hasUnsavedWorkingData,
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
    value: { sendShowFileUpdated: (path) => showFileUpdated.push(path) },
  },
  { match: matchesModule('/Modules/BackupManager'), value: { Manager: backupMgr } },
  { match: matchesModule('/Modules/FileSelectorManager'), value: { Manager: fileSelectorMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/show');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.currentFilePath = '/shows/current.showtrak';
  state.saveResult = [null, { Saved: true }];
  state.openResult = [null, { Opened: true }];
  state.newResult = [null, { Created: true }];
  state.ensureResult = [null, { Missing: false }];
  state.hasUnsavedWorkingData = false;
  state.saveDialog = { canceled: false, filePath: '/shows/picked.showtrak' };
  state.openDialog = { canceled: false, filePaths: ['/shows/opened.showtrak'] };
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
    'Show:New',
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
  assert.deepEqual(Result, [null, { Opened: true }]);
  assert.deepEqual(backupMgr.__callsTo('Open')[0].args, ['/shows/opened.showtrak']);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
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
    assert.equal(backupMgr.__callsTo('Open').length, 0);
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

// --- Show:New ---------------------------------------------------------------

test('Show:New resets the show and announces the new (empty) file', async () => {
  assert.deepEqual(await GetHandler('Show:New')(null), [null, { Created: true }]);
  assert.equal(backupMgr.__callsTo('New').length, 1);
  assert.deepEqual(showFileUpdated, ['/shows/current.showtrak']);
});

test('Show:New surfaces a failure without announcing an update', async () => {
  state.newResult = ['could not reset database', null];
  assert.deepEqual(await GetHandler('Show:New')(null), ['could not reset database', null]);
  assert.deepEqual(showFileUpdated, []);
});
