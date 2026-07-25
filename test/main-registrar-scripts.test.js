const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/scripts.ts — script execution, catalog
// management, and local script file open/run.
//
// Three things here decide whether a crafted renderer message can run arbitrary
// code on the operator's own machine, so they get the bulk of the attention:
//
//   1. PATH CONTAINMENT. Scripts:OpenFile and Scripts:RunLocalFile resolve a
//      renderer-supplied ID + relative path under the scripts directory. A
//      traversal that escapes it means opening or EXECUTING an arbitrary file.
//   2. THE MAPPED-EXECUTABLE RESTRICTION. Scripts:RunLocalFile will only run the
//      file the script's config maps for this platform — not any file that
//      happens to sit in the folder.
//   3. WHITELIST CONTINUITY ACROSS A RENAME. Renaming a script changes its
//      folder ID; if the whitelist row did not follow, a script restricted to
//      three machines would silently revert to "all clients".
//
// Real path helpers and a real temp scripts directory are used (only the actual
// process spawn is stubbed), because the containment logic IS the thing tested.

const ScriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-scripts-'));
const ScriptFolder = path.join(ScriptsDir, 'my-script');
fs.mkdirSync(path.join(ScriptFolder, 'nested'), { recursive: true });
fs.writeFileSync(path.join(ScriptFolder, 'run.sh'), '#!/bin/sh\necho hi\n');
fs.writeFileSync(path.join(ScriptFolder, 'run.ps1'), 'Write-Host hi\n');
fs.writeFileSync(path.join(ScriptFolder, 'nested', 'deep.sh'), '#!/bin/sh\n');
fs.writeFileSync(path.join(ScriptsDir, 'outside.sh'), '#!/bin/sh\n');
test.after(() => fs.rmSync(ScriptsDir, { recursive: true, force: true }));

// The registrar picks the platform key at call time; mirror that here so the
// fixtures line up on whichever OS the suite runs on.
const PlatformKey =
  process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
const MappedFile = process.platform === 'win32' ? 'run.ps1' : 'run.sh';

const realLocalScripts = require('../dist/main/local-scripts');

const ran = [];
const opened = { paths: [], commands: [] };
const broadcasts = [];

const state = {
  scripts: [],
  script: { ID: 'my-script', Platforms: { [PlatformKey]: MappedFile }, Arguments: {} },
  editable: [null, { id: 'my-script', name: 'My Script' }],
  saveFields: [null, { id: 'my-script' }],
  setOrder: [null],
  del: [null],
  createBlank: [null, { id: 'script-2' }],
  sampleList: [{ id: 'sample-1' }],
  sampleListThrows: false,
  sample: { id: 'sample-1' },
  refresh: { ok: true },
  createFromTemplate: { ok: true, id: 'from-template' },
  scope: null,
  editor: 'System Default',
  runError: null,
};

const serverMgr = recordingManager({
  ExecuteScripts: () => undefined,
  TriggerIntegratedEvent: () => undefined,
  ExecuteBulkRequest: () => undefined,
});
const scriptMgr = recordingManager({
  GetScripts: () => state.scripts,
  Get: () => state.script,
  GetEditable: () => state.editable,
  SaveFields: () => state.saveFields,
  SetOrder: () => state.setOrder,
  Delete: () => state.del,
  CreateBlank: () => state.createBlank,
  CreateFromTemplate: () => state.createFromTemplate,
});
const execMgr = recordingManager({ ClearSettled: () => undefined });
const whitelistMgr = recordingManager({
  GetScope: () => state.scope,
  SetScope: () => undefined,
  RenameScript: () => undefined,
  DeleteForScript: () => undefined,
});
const samplesMgr = recordingManager({
  GetSampleList: async () => {
    if (state.sampleListThrows) throw new Error('network down');
    return state.sampleList;
  },
  GetSample: () => state.sample,
  Refresh: () => state.refresh,
});
const settingsMgr = recordingManager({ GetValue: () => state.editor });
const appDataMgr = recordingManager({ GetScriptsDirectory: () => ScriptsDir });
const broadcastMgr = recordingManager({ emit: (...args) => broadcasts.push(args) });

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
  {
    match: matchesModule('electron'),
    value: {
      shell: {
        openPath: async (p) => {
          opened.paths.push(p);
          return '';
        },
      },
    },
  },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  { match: matchesModule('../deployment'), value: { TriggerScriptDeployment: () => undefined } },
  {
    // Keep the REAL path-containment and argument-parsing helpers; stub only the
    // call that would actually spawn a process.
    match: matchesModule('../local-scripts'),
    value: {
      ...realLocalScripts,
      runLocalScriptFile: async (file, args) => {
        ran.push({ file, args });
        return state.runError;
      },
    },
  },
  { match: matchesModule('/Modules/Server'), value: { Manager: serverMgr } },
  { match: matchesModule('/Modules/ScriptManager'), value: { Manager: scriptMgr } },
  { match: matchesModule('/Modules/ScriptExecutionManager'), value: { Manager: execMgr } },
  { match: matchesModule('/Modules/ScriptWhitelistManager'), value: { Manager: whitelistMgr } },
  { match: matchesModule('/Modules/SampleScripts'), value: { Manager: samplesMgr } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settingsMgr } },
  { match: matchesModule('/Modules/AppData'), value: { Manager: appDataMgr } },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: broadcastMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/scripts');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.script = { ID: 'my-script', Platforms: { [PlatformKey]: MappedFile }, Arguments: {} };
  state.saveFields = [null, { id: 'my-script' }];
  state.setOrder = [null];
  state.del = [null];
  state.createBlank = [null, { id: 'script-2' }];
  state.sampleListThrows = false;
  state.sample = { id: 'sample-1' };
  state.refresh = { ok: true };
  state.createFromTemplate = { ok: true, id: 'from-template' };
  state.scope = null;
  state.editor = 'System Default';
  state.runError = null;
  ran.length = 0;
  opened.paths.length = 0;
  opened.commands.length = 0;
  broadcasts.length = 0;
  for (const M of [
    serverMgr,
    scriptMgr,
    execMgr,
    whitelistMgr,
    samplesMgr,
    settingsMgr,
    appDataMgr,
    broadcastMgr,
  ]) {
    M.__calls.length = 0;
  }
});

test('registers a handler for every scripts channel', () => {
  for (const Channel of [
    'ExecuteScript',
    'TriggerIntegratedEvent',
    'Scripts:ClearSettledExecutions',
    'DeleteScripts',
    'UpdateScripts',
    'Scripts:GetManagerList',
    'Scripts:GetConfig',
    'Scripts:SaveConfig',
    'Scripts:GetWhitelist',
    'Scripts:SetWhitelist',
    'Scripts:SetOrder',
    'Scripts:Delete',
    'Scripts:Create',
    'Scripts:GetSampleList',
    'Scripts:RefreshSamples',
    'Scripts:CreateFromTemplate',
    'OpenScriptsFolder',
    'Scripts:OpenFolder',
    'Scripts:OpenFile',
    'Scripts:RunLocalFile',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- 1. Path containment ----------------------------------------------------

test('Scripts:OpenFile opens a file inside the script folder', async () => {
  assert.deepEqual(await GetHandler('Scripts:OpenFile')(null, 'my-script', MappedFile), [
    null,
    true,
  ]);
  assert.deepEqual(opened.paths, [path.join(ScriptFolder, MappedFile)]);
});

test('Scripts:OpenFile allows a nested path that stays inside the folder', async () => {
  const [Err] = await GetHandler('Scripts:OpenFile')(null, 'my-script', 'nested/deep.sh');
  assert.equal(Err, null);
  assert.deepEqual(opened.paths, [path.join(ScriptFolder, 'nested', 'deep.sh')]);
});

test('Scripts:OpenFile refuses traversal out of the script folder', async () => {
  // Each of these resolves outside the folder; opening them would hand the
  // renderer an arbitrary-file-open primitive.
  const Handler = GetHandler('Scripts:OpenFile');
  for (const Escape of [
    '../outside.sh',
    '../../etc/passwd',
    'nested/../../outside.sh',
    './../outside.sh',
  ]) {
    const [Err, Data] = await Handler(null, 'my-script', Escape);
    assert.equal(Err, 'Invalid file path', `traversal not blocked: ${Escape}`);
    assert.equal(Data, null);
  }
  assert.deepEqual(opened.paths, []);
});

test('Scripts:OpenFile refuses an absolute path', async () => {
  const Handler = GetHandler('Scripts:OpenFile');
  const Absolute = process.platform === 'win32' ? 'C:\\Windows\\notepad.exe' : '/etc/passwd';
  assert.deepEqual(await Handler(null, 'my-script', Absolute), ['Invalid file path', null]);
  assert.deepEqual(opened.paths, []);
});

test('Scripts:OpenFile refuses a script ID containing separators or dot-dot', async () => {
  const Handler = GetHandler('Scripts:OpenFile');
  for (const BadID of ['..', '../other', 'a/b', 'a\\b', '', '   ']) {
    const [Err] = await Handler(null, BadID, 'run.sh');
    assert.equal(Err, 'Invalid script ID', `bad ID not blocked: ${JSON.stringify(BadID)}`);
  }
  assert.deepEqual(opened.paths, []);
});

test('Scripts:OpenFile rejects a non-string ID or path', async () => {
  const Handler = GetHandler('Scripts:OpenFile');
  assert.deepEqual(await Handler(null, null, 'run.sh'), ['Invalid script ID', null]);
  assert.deepEqual(await Handler(null, 'my-script', null), ['Invalid file path', null]);
  assert.deepEqual(await Handler(null, 'my-script', 42), ['Invalid file path', null]);
});

test('Scripts:OpenFile reports a missing file and a directory distinctly', async () => {
  const Handler = GetHandler('Scripts:OpenFile');
  assert.deepEqual(await Handler(null, 'my-script', 'does-not-exist.sh'), ['File not found', null]);
  assert.deepEqual(await Handler(null, 'my-script', 'nested'), ['Path is not a file', null]);
  assert.deepEqual(opened.paths, []);
});

test('Scripts:OpenFolder ignores an ID that could escape the scripts directory', async () => {
  const Handler = GetHandler('Scripts:OpenFolder');
  await Handler(null, 'my-script');
  assert.deepEqual(opened.paths, [path.join(ScriptsDir, 'my-script')]);

  opened.paths.length = 0;
  for (const BadID of ['../..', 'a/b', '', null]) await Handler(null, BadID);
  assert.deepEqual(opened.paths, [], 'a traversal ID reached shell.openPath');
});

test('OpenScriptsFolder opens the configured scripts directory', async () => {
  await GetHandler('OpenScriptsFolder')(null);
  assert.deepEqual(opened.paths, [ScriptsDir]);
});

// --- 2. The mapped-executable restriction -----------------------------------

test('Scripts:RunLocalFile runs the mapped platform executable', async () => {
  assert.deepEqual(await GetHandler('Scripts:RunLocalFile')(null, 'my-script', MappedFile), [
    null,
    true,
  ]);
  assert.deepEqual(ran, [{ file: path.join(ScriptFolder, MappedFile), args: [] }]);
});

test('Scripts:RunLocalFile refuses any file other than the mapped one', async () => {
  // The folder contains other real, existing, executable-looking files. Only
  // the one the script config maps for this platform may run.
  const Other = MappedFile === 'run.sh' ? 'run.ps1' : 'run.sh';
  const [Err, Data] = await GetHandler('Scripts:RunLocalFile')(null, 'my-script', Other);
  assert.match(Err, /Only the mapped .* executable can be run locally/);
  assert.equal(Data, null);
  assert.deepEqual(ran, []);
});

test('Scripts:RunLocalFile refuses traversal even before the mapping check', async () => {
  const [Err] = await GetHandler('Scripts:RunLocalFile')(null, 'my-script', '../outside.sh');
  assert.equal(Err, 'Invalid file path');
  assert.deepEqual(ran, []);
});

test('Scripts:RunLocalFile reports when no executable is mapped for this platform', async () => {
  state.script = { ID: 'my-script', Platforms: {}, Arguments: {} };
  const [Err] = await GetHandler('Scripts:RunLocalFile')(null, 'my-script', MappedFile);
  assert.match(Err, /No .* executable is configured for this script/);
  assert.deepEqual(ran, []);
});

test('Scripts:RunLocalFile reports an unknown script', async () => {
  state.script = null;
  assert.deepEqual(await GetHandler('Scripts:RunLocalFile')(null, 'my-script', MappedFile), [
    'Script not found',
    null,
  ]);
  assert.deepEqual(ran, []);
});

test('Scripts:RunLocalFile compares the mapping ignoring ./ and backslashes', async () => {
  // Config files are authored by hand and on Windows, so "./run.sh" and
  // ".\\run.sh" must match "run.sh" rather than being refused.
  state.script = { ID: 'my-script', Platforms: { [PlatformKey]: `./${MappedFile}` } };
  const [Err] = await GetHandler('Scripts:RunLocalFile')(null, 'my-script', MappedFile);
  assert.equal(Err, null);
});

test('Scripts:RunLocalFile passes the platform argument string as parsed argv', async () => {
  state.script = {
    ID: 'my-script',
    Platforms: { [PlatformKey]: MappedFile },
    Arguments: { [PlatformKey]: '--flag "quoted value" plain' },
  };
  await GetHandler('Scripts:RunLocalFile')(null, 'my-script', MappedFile);
  assert.deepEqual(ran[0].args, ['--flag', 'quoted value', 'plain']);
});

test('Scripts:RunLocalFile surfaces a run failure', async () => {
  state.runError = 'exited with code 1';
  assert.deepEqual(await GetHandler('Scripts:RunLocalFile')(null, 'my-script', MappedFile), [
    'exited with code 1',
    null,
  ]);
});

test('Scripts:RunLocalFile refuses a mapped file that is missing or a directory', async () => {
  state.script = { ID: 'my-script', Platforms: { [PlatformKey]: 'nested' } };
  assert.deepEqual(await GetHandler('Scripts:RunLocalFile')(null, 'my-script', 'nested'), [
    'Path is not a file',
    null,
  ]);

  state.script = { ID: 'my-script', Platforms: { [PlatformKey]: 'ghost.sh' } };
  assert.deepEqual(await GetHandler('Scripts:RunLocalFile')(null, 'my-script', 'ghost.sh'), [
    'File not found',
    null,
  ]);
  assert.deepEqual(ran, []);
});

// --- 3. Whitelist continuity ------------------------------------------------

test('Scripts:SaveConfig carries the whitelist across a rename', async () => {
  // Without this a script restricted to three machines silently becomes
  // runnable on every client the moment it is renamed.
  state.saveFields = [null, { id: 'renamed-script' }];
  const [Err, Data] = await GetHandler('Scripts:SaveConfig')(null, 'my-script', {
    name: 'Renamed',
  });

  assert.equal(Err, null);
  assert.deepEqual(Data, { id: 'renamed-script' });
  assert.deepEqual(whitelistMgr.__callsTo('RenameScript')[0].args, ['my-script', 'renamed-script']);
});

test('Scripts:SaveConfig does not touch the whitelist when the ID is unchanged', async () => {
  await GetHandler('Scripts:SaveConfig')(null, 'my-script', { name: 'Same ID' });
  assert.equal(whitelistMgr.__callsTo('RenameScript').length, 0);
});

test('Scripts:SaveConfig rejects an invalid ID or payload before saving', async () => {
  const Handler = GetHandler('Scripts:SaveConfig');
  const [IDErr] = await Handler(null, '../escape', { name: 'x' });
  assert.equal(typeof IDErr, 'string');

  const [FieldsErr] = await Handler(null, 'my-script', 'not-an-object');
  assert.equal(typeof FieldsErr, 'string');

  assert.equal(scriptMgr.__callsTo('SaveFields').length, 0);
});

test('Scripts:SaveConfig surfaces a save failure without renaming the whitelist', async () => {
  state.saveFields = ['disk full', null];
  assert.deepEqual(await GetHandler('Scripts:SaveConfig')(null, 'my-script', { name: 'x' }), [
    'disk full',
    null,
  ]);
  assert.equal(whitelistMgr.__callsTo('RenameScript').length, 0);
});

test('Scripts:Delete removes the script then drops its whitelist row', async () => {
  assert.deepEqual(await GetHandler('Scripts:Delete')(null, 'my-script'), [null, true]);
  assert.deepEqual(whitelistMgr.__callsTo('DeleteForScript')[0].args, ['my-script']);
});

test('Scripts:Delete leaves the whitelist alone when the delete fails', async () => {
  state.del = ['in use'];
  assert.deepEqual(await GetHandler('Scripts:Delete')(null, 'my-script'), ['in use', null]);
  assert.equal(whitelistMgr.__callsTo('DeleteForScript').length, 0);
});

test('Scripts:GetWhitelist returns null when the script is unrestricted', async () => {
  assert.deepEqual(await GetHandler('Scripts:GetWhitelist')(null, 'my-script'), [null, null]);

  state.scope = { Workspace: false, Groups: [], Clients: ['uuid-a'] };
  assert.deepEqual(await GetHandler('Scripts:GetWhitelist')(null, 'my-script'), [
    null,
    state.scope,
  ]);
});

test('Scripts:SetWhitelist persists the scope and re-pushes the catalog', async () => {
  // The broadcast is what makes the restriction visible in every open UI
  // immediately rather than after the next reload.
  const [Err] = await GetHandler('Scripts:SetWhitelist')(null, 'my-script', {
    Workspace: false,
    Groups: [1],
    Clients: ['uuid-a'],
  });
  assert.equal(Err, null);
  assert.equal(whitelistMgr.__callsTo('SetScope').length, 1);
  assert.deepEqual(broadcasts, [['ScriptsUpdated']]);
});

test('Scripts:SetWhitelist rejects a malformed scope without broadcasting', async () => {
  const [Err] = await GetHandler('Scripts:SetWhitelist')(null, 'my-script', 'everything');
  assert.equal(typeof Err, 'string');
  assert.equal(whitelistMgr.__callsTo('SetScope').length, 0);
  assert.deepEqual(broadcasts, []);
});

// --- Execution dispatch -----------------------------------------------------

test('ExecuteScript validates the script, targets and reset flag', async () => {
  assert.deepEqual(
    await GetHandler('ExecuteScript')(null, 'my-script', ['uuid-a', 'uuid-b'], true),
    [null, true]
  );
  assert.deepEqual(serverMgr.__callsTo('ExecuteScripts')[0].args, [
    'my-script',
    ['uuid-a', 'uuid-b'],
    true,
  ]);
});

test('ExecuteScript rejects bad input before dispatching anything', async () => {
  const Handler = GetHandler('ExecuteScript');

  const [ScriptErr] = await Handler(null, '', ['uuid-a'], true);
  assert.equal(typeof ScriptErr, 'string');

  const [TargetErr] = await Handler(null, 'my-script', [''], true);
  assert.equal(typeof TargetErr, 'string');

  const [FlagErr] = await Handler(null, 'my-script', ['uuid-a'], 'maybe');
  assert.equal(typeof FlagErr, 'string');

  assert.equal(serverMgr.__callsTo('ExecuteScripts').length, 0);
});

test('ExecuteScript refuses to dispatch with no targets', async () => {
  // The `Targets || []` in the handler only normalizes null into an array for
  // the validator — which then rejects it, because running a script against
  // zero clients is a no-op the operator almost certainly did not intend.
  const Handler = GetHandler('ExecuteScript');
  for (const Empty of [null, undefined, []]) {
    const [Err, Data] = await Handler(null, 'my-script', Empty, false);
    assert.match(Err, /cannot be empty/i, `expected rejection for ${JSON.stringify(Empty)}`);
    assert.equal(Data, null);
  }
  assert.equal(serverMgr.__callsTo('ExecuteScripts').length, 0);
});

test('TriggerIntegratedEvent validates the event id and targets', async () => {
  const Handler = GetHandler('TriggerIntegratedEvent');
  assert.deepEqual(await Handler(null, 'event-1', ['uuid-a']), [null, true]);
  assert.deepEqual(serverMgr.__callsTo('TriggerIntegratedEvent')[0].args, ['event-1', ['uuid-a']]);

  serverMgr.__calls.length = 0;
  const [Err] = await Handler(null, '', ['uuid-a']);
  assert.equal(typeof Err, 'string');
  assert.equal(serverMgr.__callsTo('TriggerIntegratedEvent').length, 0);
});

test('Scripts:ClearSettledExecutions clears only settled rows', async () => {
  assert.deepEqual(await GetHandler('Scripts:ClearSettledExecutions')(null), [null, true]);
  assert.equal(execMgr.__callsTo('ClearSettled').length, 1);
});

test('DeleteScripts and UpdateScripts validate their target lists', async () => {
  assert.equal(await GetHandler('DeleteScripts')(null, ['uuid-a']), undefined);
  assert.deepEqual(serverMgr.__callsTo('ExecuteBulkRequest')[0].args, [
    'DeleteScripts',
    ['uuid-a'],
    'Delete Scripts',
  ]);

  const [Err] = await GetHandler('DeleteScripts')(null, ['']);
  assert.equal(typeof Err, 'string');

  assert.deepEqual(await GetHandler('UpdateScripts')(null, ['uuid-a']), [null, true]);
  const [UpdateErr] = await GetHandler('UpdateScripts')(null, ['']);
  assert.equal(typeof UpdateErr, 'string');
});

// --- Catalog projection -----------------------------------------------------

test('Scripts:GetManagerList projects each script with defaults filled in', async () => {
  state.scripts = [{ ID: 'a', Name: 'A' }];
  const [Row] = await GetHandler('Scripts:GetManagerList')(null);

  assert.equal(Row.id, 'a');
  assert.equal(Row.description, '');
  assert.equal(Row.colour, 6);
  assert.equal(Row.icon, 'terminal');
  assert.equal(Row.weight, 0);
  assert.equal(Row.confirm, false);
  assert.equal(typeof Row.timeoutMs, 'number');
  assert.equal(Row.enabled, false);
  assert.equal(Row.valid, false);
  assert.equal(Row.parseError, null);
  assert.deepEqual(Row.platforms, {});
  assert.deepEqual(Row.issues, []);
});

test('Scripts:GetManagerList keeps supplied values and includes invalid scripts', async () => {
  // Invalid scripts MUST appear — the manager is where they get fixed.
  state.scripts = [
    {
      ID: 'b',
      Name: 'B',
      Description: 'desc',
      Colour: 2,
      Icon: 'gear',
      Weight: 5,
      Confirmation: true,
      Timeout: 1234,
      isEnabled: true,
      isValid: false,
      ParseError: 'bad yaml',
      ValidationErrors: ['missing platform'],
    },
  ];
  const [Row] = await GetHandler('Scripts:GetManagerList')(null);
  assert.equal(Row.colour, 2);
  assert.equal(Row.icon, 'gear');
  assert.equal(Row.timeoutMs, 1234);
  assert.equal(Row.valid, false);
  assert.equal(Row.parseError, 'bad yaml');
  assert.deepEqual(Row.issues, ['missing platform']);
});

test('Scripts:GetManagerList tolerates a null catalog', async () => {
  state.scripts = null;
  assert.deepEqual(await GetHandler('Scripts:GetManagerList')(null), []);
});

test('Scripts:GetConfig validates the id and passes errors through', async () => {
  assert.deepEqual(await GetHandler('Scripts:GetConfig')(null, 'my-script'), [
    null,
    { id: 'my-script', name: 'My Script' },
  ]);

  const [IDErr] = await GetHandler('Scripts:GetConfig')(null, '../escape');
  assert.equal(typeof IDErr, 'string');

  state.editable = ['not found', null];
  assert.deepEqual(await GetHandler('Scripts:GetConfig')(null, 'my-script'), ['not found', null]);
  state.editable = [null, { id: 'my-script', name: 'My Script' }];
});

test('Scripts:SetOrder validates the list and reports failure', async () => {
  const Handler = GetHandler('Scripts:SetOrder');
  assert.deepEqual(await Handler(null, ['a', 'b']), [null, true]);

  const [Err] = await Handler(null, 'not-a-list');
  assert.equal(typeof Err, 'string');

  state.setOrder = ['write failed'];
  assert.deepEqual(await Handler(null, ['a']), ['write failed', null]);
});

test('Scripts:Create returns the new script id', async () => {
  assert.deepEqual(await GetHandler('Scripts:Create')(null), [null, { id: 'script-2' }]);

  state.createBlank = ['disk full', null];
  assert.deepEqual(await GetHandler('Scripts:Create')(null), ['disk full', null]);

  // Defensive: success with no data.
  state.createBlank = [null, null];
  assert.deepEqual(await GetHandler('Scripts:Create')(null), ['Failed to create script', null]);
});

// --- Sample templates -------------------------------------------------------

test('Scripts:GetSampleList returns the catalog and degrades on a network error', async () => {
  assert.deepEqual(await GetHandler('Scripts:GetSampleList')(null), [null, [{ id: 'sample-1' }]]);

  state.sampleListThrows = true;
  assert.deepEqual(await GetHandler('Scripts:GetSampleList')(null), [
    'Failed to load sample scripts',
    null,
  ]);
});

test('Scripts:RefreshSamples refreshes then re-lists', async () => {
  assert.deepEqual(await GetHandler('Scripts:RefreshSamples')(null), [null, [{ id: 'sample-1' }]]);
  assert.equal(samplesMgr.__callsTo('Refresh').length, 1);

  state.refresh = { ok: false, error: 'github unreachable' };
  assert.deepEqual(await GetHandler('Scripts:RefreshSamples')(null), ['github unreachable', null]);

  state.refresh = { ok: false };
  assert.deepEqual(await GetHandler('Scripts:RefreshSamples')(null), [
    'Failed to refresh sample scripts',
    null,
  ]);
});

test('Scripts:CreateFromTemplate creates from a known sample', async () => {
  const [Err, Data] = await GetHandler('Scripts:CreateFromTemplate')(null, 'sample-1', 'my-new-id');
  assert.equal(Err, null);
  assert.deepEqual(Data, { ok: true, id: 'from-template' });
  assert.deepEqual(scriptMgr.__callsTo('CreateFromTemplate')[0].args, [
    { id: 'sample-1' },
    'my-new-id',
  ]);
});

test('Scripts:CreateFromTemplate reports an unknown template', async () => {
  state.sample = null;
  assert.deepEqual(await GetHandler('Scripts:CreateFromTemplate')(null, 'sample-9', 'my-new-id'), [
    'Template not found',
    null,
  ]);
  assert.equal(scriptMgr.__callsTo('CreateFromTemplate').length, 0);
});

test('Scripts:CreateFromTemplate surfaces the first creation error with the result', async () => {
  // The result is returned ALONGSIDE the error so the renderer can show the
  // per-field validation detail rather than just a message.
  state.createFromTemplate = { ok: false, errors: ['ID already exists', 'and another'] };
  const [Err, Data] = await GetHandler('Scripts:CreateFromTemplate')(null, 'sample-1', 'dupe');
  assert.equal(Err, 'ID already exists');
  assert.deepEqual(Data, state.createFromTemplate);

  state.createFromTemplate = { ok: false };
  const [FallbackErr] = await GetHandler('Scripts:CreateFromTemplate')(null, 'sample-1', 'dupe');
  assert.equal(FallbackErr, 'Failed to create script');
});

test('Scripts:CreateFromTemplate rejects a malformed sample id', async () => {
  const [Err] = await GetHandler('Scripts:CreateFromTemplate')(null, '', 'my-new-id');
  assert.equal(typeof Err, 'string');
  assert.equal(samplesMgr.__callsTo('GetSample').length, 0);
});
