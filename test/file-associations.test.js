// Show files opened from the operating system (src/main/file-associations.ts
// and src/main/show-file-replace-prompt.ts). What is at stake: a double-click
// in Finder or Explorer swaps out the show every client is running against, so
// it must find the right file, never lose unsaved changes, and ask before it
// replaces a running show.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FA = require('../dist/main/file-associations');
const { ConfirmShowFileReplace } = require('../dist/main/show-file-replace-prompt');

test.beforeEach(() => FA.ResetShowFileRequestsForTests());

// --- Command line -------------------------------------------------------------

test('finds an existing show file on the command line, in any letter case', (t) => {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-assoc-'));
  t.after(() => fs.rmSync(Dir, { recursive: true, force: true }));
  const File = path.join(Dir, 'Main Stage.ShowTrak');
  fs.writeFileSync(File, '');
  assert.equal(FA.ShowFileFromArgv(['--squirrel-firstrun', File]), File);
  assert.equal(
    FA.ShowFileFromArgv(['Main Stage.ShowTrak'], Dir),
    File,
    'relative to the cwd given'
  );
});

test('ignores switches, other files and show files that do not exist', (t) => {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-assoc-'));
  t.after(() => fs.rmSync(Dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(Dir, 'notes.txt'), '');
  assert.equal(
    FA.ShowFileFromArgv(['.', '--allow-file-access-from-files', 'notes.txt', 'gone.showtrak'], Dir),
    null
  );
  assert.equal(FA.IsShowFilePath('--x.showtrak'), false);
});

// --- Requests -----------------------------------------------------------------

test('a request before the renderer starts is part of the launch, and is not announced', () => {
  let Announced = 0;
  FA.OnShowFileRequest(() => Announced++);
  FA.RequestShowFileOpen('/a.showtrak');
  assert.equal(Announced, 0);
  assert.deepEqual(FA.TakeShowFileRequest(), { FilePath: '/a.showtrak', Source: 'Launch' });
  assert.equal(FA.TakeShowFileRequest(), null, 'taken once');
});

test('once the renderer has started, a request is announced and asks first', () => {
  let Announced = 0;
  FA.OnShowFileRequest(() => Announced++);
  FA.TakeShowFileRequest();
  FA.RequestShowFileOpen('/a.showtrak');
  FA.RequestShowFileOpen('/b.showtrak');
  assert.equal(Announced, 2);
  assert.deepEqual(FA.TakeShowFileRequest(), { FilePath: '/b.showtrak', Source: 'Running' });
});

// --- Windows registry ---------------------------------------------------------

test('Squirrel install and update register the association against the stub exe', () => {
  const ExecPath =
    'C:\\Users\\op\\AppData\\Local\\showtrak_server\\app-3.33.0\\showtrak-server.exe';
  for (const Event of ['--squirrel-install', '--squirrel-updated']) {
    const Calls = [];
    const Action = FA.HandleSquirrelFileAssociations(['exe', Event, '3.33.0'], {
      Platform: 'win32',
      ExecPath: ExecPath.replace(/\\/g, '/'),
      Run: (Args) => (Calls.push(Args), { status: 0 }),
    });
    assert.equal(Action, 'register');
    const Command = Calls.find((A) => A[1].endsWith('\\shell\\open\\command'));
    assert.ok(Command, 'writes the open command');
    assert.match(Command[4], /showtrak_server[\\/]showtrak-server\.exe" "%1"$/);
    assert.doesNotMatch(Command[4], /app-3\.33\.0/, 'not the versioned folder Squirrel deletes');
    assert.ok(
      Calls.some(
        (A) => A[1] === 'HKCU\\Software\\Classes\\.showtrak' && A.includes('ShowTrak.ShowFile')
      )
    );
  }
});

test('Squirrel uninstall removes the association, and .showtrak only while it is still ours', () => {
  const Run = (Default) => {
    const Calls = [];
    FA.HandleSquirrelFileAssociations(['exe', '--squirrel-uninstall'], {
      Platform: 'win32',
      ExecPath: '/root/app-1.0.0/showtrak-server.exe',
      Run: (Args) => {
        Calls.push(Args);
        return Args[0] === 'query'
          ? { status: 0, stdout: `(Default) REG_SZ ${Default}` }
          : { status: 0 };
      },
    });
    return Calls;
  };
  const DeletesExtension = (Calls) =>
    Calls.some(
      (A) => A[0] === 'delete' && A[1] === 'HKCU\\Software\\Classes\\.showtrak' && A.includes('/ve')
    );
  assert.ok(
    Run('ShowTrak.ShowFile').some((A) => A[0] === 'delete' && A[1].endsWith('\\ShowTrak.ShowFile'))
  );
  assert.equal(DeletesExtension(Run('ShowTrak.ShowFile')), true);
  assert.equal(DeletesExtension(Run('SomeOtherApp.File')), false);
});

test('nothing happens outside Windows or without a Squirrel event', () => {
  const Run = () => assert.fail('must not touch the registry');
  assert.equal(
    FA.HandleSquirrelFileAssociations(['exe', '--squirrel-install'], { Platform: 'darwin', Run }),
    null
  );
  assert.equal(
    FA.HandleSquirrelFileAssociations(['exe', 'show.showtrak'], { Platform: 'win32', Run }),
    null
  );
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
