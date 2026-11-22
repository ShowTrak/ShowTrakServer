// Show files opened from the operating system (src/main/file-associations.ts
// and src/main/show-file-replace-prompt.ts). What is at stake: a double-click
// in Finder or Explorer swaps out the show every client is running against, so
// it must find the right file, never lose unsaved changes, and ask before it
// replaces a running show.
//
// Finding the file, holding the request and the Windows registry entries are
// @showtrak/protocol/electron-main's CreateShowFileAssociations, covered by the
// protocol's specs; the Server's part is its configuration and the prompt.
const test = require('node:test');
const assert = require('node:assert/strict');

const FA = require('../dist/main/file-associations');
const { ConfirmShowFileReplace } = require('../dist/main/show-file-replace-prompt');

// --- Configuration ------------------------------------------------------------

test('associates .showtrak files with ShowTrak Server, as forge.config.ts declares them', () => {
  assert.equal(FA.SHOW_FILE_EXTENSION, 'showtrak');
  assert.equal(FA.WINDOWS_PROG_ID, 'ShowTrak.ShowFile');
  assert.equal(FA.IsShowFilePath('/shows/Main Stage.ShowTrak'), true);
  assert.equal(FA.IsShowFilePath('/shows/timers.showtraktimers'), false);
  const Register = FA.WindowsAssociationCommands('register', 'C:\\ShowTrak\\showtrak-server.exe');
  assert.deepEqual(Register[0], [
    'add',
    'HKCU\\Software\\Classes\\.showtrak',
    '/ve',
    '/d',
    'ShowTrak.ShowFile',
    '/f',
  ]);
  assert.ok(Register.some((Args) => Args.includes('ShowTrak Show File')));
});

// --- Replacing the open show --------------------------------------------------

function Deps(Overrides = {}) {
  const Log = { Prompts: [], Saves: [] };
  const D = {
    GetCurrentFilePath: () => '/shows/current.showtrak',
    HasUnsavedChanges: async () => false,
    HasUnsavedWorkingData: async () => false,
    IsAutosaveEnabled: async () => false,
    Save: async (P) => (Log.Saves.push(P), [null, 'ok']),
    PickSavePath: async () => '/shows/picked.showtrak',
    ShowMessageBox: async (O) => (Log.Prompts.push(O), 0),
    ShowError: () => {},
    OnSaved: () => {},
    ...Overrides,
  };
  return { D, Log };
}
const Launch = { FilePath: '/shows/new.showtrak', Source: 'Launch' };
const Running = { FilePath: '/shows/new.showtrak', Source: 'Running' };

test('a launch with nothing to save opens without asking', async () => {
  const { D, Log } = Deps();
  assert.equal(await ConfirmShowFileReplace(Launch, D), true);
  assert.equal(Log.Prompts.length, 0);
});

test('while running it asks, and Cancel keeps the open show', async () => {
  const { D, Log } = Deps({ ShowMessageBox: async (O) => (Log.Prompts.push(O), 1) });
  assert.equal(await ConfirmShowFileReplace(Running, D), false);
  assert.match(Log.Prompts[0].detail, /current\.showtrak/);
});

test('with no show open there is nothing to ask about', async () => {
  const { D, Log } = Deps({ GetCurrentFilePath: () => null });
  assert.equal(await ConfirmShowFileReplace(Running, D), true);
  assert.equal(Log.Prompts.length, 0);
});

test("unsaved changes: Save saves, Don't Save does not, Cancel stops", async () => {
  for (const [Response, Expected, Saves] of [
    [0, true, 1],
    [1, true, 0],
    [2, false, 0],
  ]) {
    const { D, Log } = Deps({
      HasUnsavedChanges: async () => true,
      ShowMessageBox: async (O) => (Log.Prompts.push(O), Response),
    });
    assert.equal(await ConfirmShowFileReplace(Running, D), Expected);
    assert.equal(Log.Saves.length, Saves);
    assert.equal(Log.Prompts.length, 1, 'asked once, not again to replace');
  }
});

test('with autosave on, unsaved changes are saved without asking about them', async () => {
  const { D, Log } = Deps({
    HasUnsavedChanges: async () => true,
    IsAutosaveEnabled: async () => true,
  });
  assert.equal(await ConfirmShowFileReplace(Launch, D), true);
  assert.deepEqual(Log.Saves, ['/shows/current.showtrak']);
  assert.equal(Log.Prompts.length, 0);
});

test('a failed save keeps the open show', async () => {
  let Errors = 0;
  const { D } = Deps({
    HasUnsavedChanges: async () => true,
    IsAutosaveEnabled: async () => true,
    Save: async () => ['disk full', null],
    ShowError: () => Errors++,
  });
  assert.equal(await ConfirmShowFileReplace(Launch, D), false);
  assert.equal(Errors, 1);
});

test('data with no show file behind it is saved somewhere first', async () => {
  const { D, Log } = Deps({
    GetCurrentFilePath: () => null,
    HasUnsavedWorkingData: async () => true,
  });
  assert.equal(await ConfirmShowFileReplace(Launch, D), true);
  assert.deepEqual(Log.Saves, ['/shows/picked.showtrak']);
});
