const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/system.ts — config, Web UI addresses, mode,
// settings, external links and the package.json/LICENSE readers.
//
// The handler that matters most here is `OpenExternalUrl`. It hands a
// renderer-supplied string to shell.openExternal, which on every platform will
// happily launch a file:// path or a registered custom protocol. The http(s)
// restriction is the only thing standing between a crafted monitoring-method
// documentation link and arbitrary local execution, so it gets exhaustive
// negative coverage.
//
// `fs` and `path` are deliberately NOT stubbed: the two file readers are
// pointed at the repository's own real package.json and LICENSE, which exercises
// the real read/parse path and keeps the fixtures from drifting.

const REPO_ROOT = path.resolve(__dirname, '..');

const state = {
  appPath: REPO_ROOT,
  isPackaged: false,
  mode: 'EDIT',
  setMode: 'SHOW',
  settings: [{ Key: 'A', Value: 1 }],
  setSetting: [null, { Key: 'A', Value: 2 }],
  interfaces: [{ Address: '10.0.0.5' }, { Address: '192.168.1.9' }],
};

const opened = { external: [], paths: [] };
const initialStatePushes = [];

const shellStub = {
  openExternal: async (url) => opened.external.push(url),
  openPath: async (p) => opened.paths.push(p),
};
const appStub = {
  get isPackaged() {
    return state.isPackaged;
  },
  getAppPath: () => state.appPath,
};

const modeMgr = recordingManager({ Get: () => state.mode, Set: () => state.setMode });
const settingsMgr = recordingManager({
  GetAll: () => state.settings,
  Set: () => state.setSetting,
});
const appDataMgr = recordingManager({ GetLogsDirectory: () => '/appdata/Logs' });
const interfacesMgr = recordingManager({ List: () => state.interfaces });

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
  { match: matchesModule('electron/main'), value: { app: appStub, ipcMain: { handle() {} } } },
  { match: matchesModule('electron'), value: { app: appStub, shell: shellStub } },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  {
    match: matchesModule('../initial-state'),
    value: { PushInitialDesktopState: async () => initialStatePushes.push(true) },
  },
  {
    match: matchesModule('/Modules/Config'),
    value: { Config: { Application: { Port: 8080, Name: 'ShowTrak Server' } } },
  },
  { match: matchesModule('/Modules/ModeManager'), value: { Manager: modeMgr } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settingsMgr } },
  { match: matchesModule('/Modules/AppData'), value: { Manager: appDataMgr } },
  { match: matchesModule('/Modules/NetworkInterfaces'), value: { Manager: interfacesMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/system');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.appPath = REPO_ROOT;
  state.isPackaged = false;
  state.mode = 'EDIT';
  state.setMode = 'SHOW';
  state.settings = [{ Key: 'A', Value: 1 }];
  state.setSetting = [null, { Key: 'A', Value: 2 }];
  state.interfaces = [{ Address: '10.0.0.5' }, { Address: '192.168.1.9' }];
  opened.external.length = 0;
  opened.paths.length = 0;
  initialStatePushes.length = 0;
  for (const M of [modeMgr, settingsMgr, appDataMgr, interfacesMgr]) M.__calls.length = 0;
});

test('registers a handler for every system channel', () => {
  for (const Channel of [
    'Config:Get',
    'WebUI:GetAddresses',
    'Mode:Get',
    'Mode:Set',
    'Settings:Get',
    'Loaded',
    'OpenLogsFolder',
    'OpenDiscordInviteLinkInBrowser',
    'OpenShowTrakWebsiteInBrowser',
    'OpenShowTrakGithubInBrowser',
    'OpenExternalUrl',
    'OpenNpmPackageInBrowser',
    'GetProjectDependencies',
    'GetLicense',
    'SetSetting',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- OpenExternalUrl: the security boundary --------------------------------

test('OpenExternalUrl opens http and https URLs', async () => {
  const Handler = GetHandler('OpenExternalUrl');
  await Handler(null, 'https://showtrak.co.uk/docs');
  await Handler(null, 'http://10.0.0.5:8080/');
  await Handler(null, '  https://example.com/padded  ');

  assert.deepEqual(opened.external, [
    'https://showtrak.co.uk/docs',
    'http://10.0.0.5:8080/',
    'https://example.com/padded',
  ]);
});

test('OpenExternalUrl refuses every non-http(s) scheme', async () => {
  // shell.openExternal will launch these for real on a user's machine. This is
  // the whole reason the allowlist exists.
  const Handler = GetHandler('OpenExternalUrl');
  for (const Hostile of [
    'file:///etc/passwd',
    'file://C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
    'smb://attacker/share',
    'ftp://example.com/x',
    'showtrak://do-something',
    'FILE:///etc/passwd',
  ]) {
    await Handler(null, Hostile);
  }
  assert.deepEqual(opened.external, [], 'a non-http(s) URL reached the shell');
});

test('OpenExternalUrl ignores empty and malformed input without throwing', async () => {
  const Handler = GetHandler('OpenExternalUrl');
  for (const Bad of ['', '   ', null, undefined, 'not a url', '://missing-scheme', {}]) {
    await assert.doesNotReject(() => Handler(null, Bad));
  }
  assert.deepEqual(opened.external, []);
});

test('OpenExternalUrl forwards the parsed href, not the raw string', async () => {
  // Normalizing through the URL parser is what makes the protocol check
  // authoritative rather than a prefix match on the raw text.
  await GetHandler('OpenExternalUrl')(null, 'https://showtrak.co.uk');
  assert.equal(opened.external[0], 'https://showtrak.co.uk/');
});

// --- The fixed-destination link handlers ------------------------------------

test('the fixed link handlers open their own hard-coded destinations', async () => {
  // Each ignores any argument the renderer supplies — the destination is not
  // renderer-controlled.
  await GetHandler('OpenDiscordInviteLinkInBrowser')(null, 'https://evil.example');
  await GetHandler('OpenShowTrakWebsiteInBrowser')(null);
  await GetHandler('OpenShowTrakGithubInBrowser')(null);

  assert.deepEqual(opened.external, [
    'https://discord.gg/DACmwsbSGW',
    'https://showtrak.co.uk',
    'https://github.com/ShowTrak/ShowTrakServer',
  ]);
});

test('OpenNpmPackageInBrowser percent-encodes the package name', async () => {
  const Handler = GetHandler('OpenNpmPackageInBrowser');
  await Handler(null, 'socket.io');
  await Handler(null, '@showtrak/server-sdk');

  assert.deepEqual(opened.external, [
    'https://www.npmjs.com/package/socket.io',
    // The scope slash must be encoded so it cannot escape the package path.
    'https://www.npmjs.com/package/%40showtrak%2Fserver-sdk',
  ]);
});

test('OpenNpmPackageInBrowser ignores an empty package name', async () => {
  const Handler = GetHandler('OpenNpmPackageInBrowser');
  for (const Bad of ['', '   ', null, undefined]) await Handler(null, Bad);
  assert.deepEqual(opened.external, []);
});

test('OpenLogsFolder opens the resolved logs directory', async () => {
  await GetHandler('OpenLogsFolder')(null);
  assert.deepEqual(opened.paths, ['/appdata/Logs']);
});

// --- Config / mode / settings ----------------------------------------------

test('Config:Get surfaces the packaged flag alongside the config', async () => {
  // Dev-only UI keys off this, so it must reflect app.isPackaged live rather
  // than a value baked in at module load.
  const Dev = await GetHandler('Config:Get')(null);
  assert.equal(Dev.Application.IsPackaged, false);
  assert.equal(Dev.Application.Name, 'ShowTrak Server');

  state.isPackaged = true;
  const Packaged = await GetHandler('Config:Get')(null);
  assert.equal(Packaged.Application.IsPackaged, true);
});

test('Mode:Get and Mode:Set delegate to the mode manager', async () => {
  assert.equal(await GetHandler('Mode:Get')(null), 'EDIT');
  assert.equal(await GetHandler('Mode:Set')(null, 'SHOW'), 'SHOW');
  assert.deepEqual(modeMgr.__callsTo('Set')[0].args, ['SHOW']);
});

test('Settings:Get returns the settings list', async () => {
  assert.deepEqual(await GetHandler('Settings:Get')(null), [{ Key: 'A', Value: 1 }]);
});

test('Loaded re-pushes the authoritative state after a renderer reload', async () => {
  // A hot reload wipes the renderer's caches; without this the UI would sit
  // empty until the next incremental push.
  assert.equal(await GetHandler('Loaded')(null), undefined);
  assert.equal(initialStatePushes.length, 1);
});

test('SetSetting validates the key and value then persists', async () => {
  const Handler = GetHandler('SetSetting');

  assert.deepEqual(await Handler(null, 'SYSTEM_AUTOSAVE_ENABLED', true), [
    null,
    { Key: 'A', Value: 2 },
  ]);
  assert.deepEqual(settingsMgr.__callsTo('Set')[0].args, ['SYSTEM_AUTOSAVE_ENABLED', true]);
});

test('SetSetting rejects a bad key or an unsupported value type', async () => {
  const Handler = GetHandler('SetSetting');

  const [KeyErr] = await Handler(null, 'x', true); // below the 2-char minimum
  assert.equal(typeof KeyErr, 'string');

  for (const Bad of [null, undefined, {}, [], Infinity, NaN]) {
    const [Err] = await Handler(null, 'SOME_KEY', Bad);
    assert.equal(typeof Err, 'string', `expected rejection for ${JSON.stringify(Bad)}`);
  }
  assert.equal(settingsMgr.__callsTo('Set').length, 0);
});

test('SetSetting normalizes the Web UI passcode to four digits', async () => {
  const Handler = GetHandler('SetSetting');

  await Handler(null, 'WEBUI_PASSWORD', '1234');
  assert.deepEqual(settingsMgr.__callsTo('Set')[0].args, ['WEBUI_PASSWORD', '1234']);

  // Non-digits are stripped and the result truncated to four.
  settingsMgr.__calls.length = 0;
  await Handler(null, 'WEBUI_PASSWORD', '12-34-56');
  assert.deepEqual(settingsMgr.__callsTo('Set')[0].args, ['WEBUI_PASSWORD', '1234']);

  // Empty clears the passcode rather than failing.
  settingsMgr.__calls.length = 0;
  await Handler(null, 'WEBUI_PASSWORD', '');
  assert.deepEqual(settingsMgr.__callsTo('Set')[0].args, ['WEBUI_PASSWORD', '']);
});

test('SetSetting surfaces a persistence failure', async () => {
  state.setSetting = ['db locked', null];
  assert.deepEqual(await GetHandler('SetSetting')(null, 'SOME_KEY', 'value'), ['db locked', null]);
});

// --- WebUI:GetAddresses -----------------------------------------------------

test('WebUI:GetAddresses lists loopback, hostname and every live interface', async () => {
  const Result = await GetHandler('WebUI:GetAddresses')(null);

  assert.equal(Result.port, 8080);
  assert.equal(Result.hostname, os.hostname());

  const Hosts = Result.urls.map((U) => U.host);
  assert.ok(Hosts.includes('localhost'));
  assert.ok(Hosts.includes('127.0.0.1'));
  assert.ok(Hosts.includes('10.0.0.5'));
  assert.ok(Hosts.includes('192.168.1.9'));

  for (const Entry of Result.urls) {
    assert.equal(Entry.url, `http://${Entry.host}:8080/`);
  }
});

test('WebUI:GetAddresses reads interfaces live and de-duplicates hosts', async () => {
  // List(false) is called per request, so an interface added since boot shows
  // up without a restart.
  state.interfaces = [{ Address: '10.0.0.5' }, { Address: '10.0.0.5' }, { Address: null }];
  const Result = await GetHandler('WebUI:GetAddresses')(null);

  const Hosts = Result.urls.map((U) => U.host);
  assert.equal(Hosts.filter((H) => H === '10.0.0.5').length, 1);
  assert.ok(!Hosts.includes(null));
  assert.ok(!Hosts.includes(''));
  assert.deepEqual(interfacesMgr.__callsTo('List')[0].args, [false]);
});

test('WebUI:GetAddresses degrades to localhost when interface enumeration throws', async () => {
  // The QR/address modal must still show something usable.
  interfacesMgr.__calls.length = 0;
  state.interfaces = null; // makes the for..of throw
  const Result = await GetHandler('WebUI:GetAddresses')(null);
  assert.deepEqual(Result.urls, [{ host: 'localhost', url: 'http://localhost:8080/' }]);
  assert.equal(Result.port, 8080);
});

// --- GetProjectDependencies / GetLicense ------------------------------------

test('GetProjectDependencies reads the real package.json, sorted and filtered', async () => {
  const [Err, Data] = await GetHandler('GetProjectDependencies')(null);
  assert.equal(Err, null);
  assert.ok(Array.isArray(Data.dependencies));
  assert.ok(Data.dependencies.length > 0);

  // Every entry is {name, version}...
  for (const Dep of Data.dependencies) {
    assert.equal(typeof Dep.name, 'string');
    assert.equal(typeof Dep.version, 'string');
  }
  // ...sorted by name...
  const Names = Data.dependencies.map((D) => D.name);
  assert.deepEqual(
    Names,
    [...Names].sort((a, b) => a.localeCompare(b))
  );
  // ...and the Electron bootstrap shim is filtered out as an implementation
  // detail rather than a project dependency.
  assert.ok(!Names.includes('electron-squirrel-startup'));
  // Sanity: a known real dependency is present.
  assert.ok(Names.includes('socket.io'));
});

test('GetProjectDependencies reports when package.json cannot be found', async () => {
  state.appPath = path.join(REPO_ROOT, 'does-not-exist', 'nested');
  assert.deepEqual(await GetHandler('GetProjectDependencies')(null), [
    'Could not locate package.json',
    null,
  ]);
});

test('GetLicense reads the real LICENSE file', async () => {
  const [Err, Data] = await GetHandler('GetLicense')(null);
  assert.equal(Err, null);
  assert.equal(typeof Data.license, 'string');
  assert.match(Data.license, /GNU AFFERO GENERAL PUBLIC LICENSE/i);
});

test('GetLicense reports when the LICENSE file cannot be found', async () => {
  state.appPath = path.join(REPO_ROOT, 'does-not-exist', 'nested');
  assert.deepEqual(await GetHandler('GetLicense')(null), ['Could not locate LICENSE file', null]);
});
