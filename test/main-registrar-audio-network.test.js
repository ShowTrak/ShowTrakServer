const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/audio.ts and src/main/registrars/network.ts.
//
// Grouped because both are small and both share the pattern of pushing a
// broadcast/callback to the renderers as a side effect of a mutation — the
// property worth pinning is that the push happens ONLY on success, so the
// renderer never refetches on the strength of a failed write.
//
// Real IPCValidation runs; only the managers and Electron are stubbed.

const pushes = [];

const state = {
  // audio
  getAll: [null, [{ ID: 'asset-1' }]],
  getDataURL: [null, { DataURL: 'data:audio/wav;base64,AAA' }],
  audioDialog: { canceled: false, filePaths: ['/clips/a.wav', '/clips/b.wav'] },
  import: [null, { ID: 'asset-9' }],
  update: [null, { ID: 'asset-1' }],
  del: [null, true],
  openFolder: 'opened',
  // network
  hasWindow: true,
  startResult: [null, { ScanID: 'scan-0001' }],
  stopResult: [null, true],
};

const audioMgr = recordingManager({
  GetAll: () => state.getAll,
  GetDataURL: () => state.getDataURL,
  InspectCandidate: (p) => ({ SourcePath: p, Inspected: true }),
  Import: () => state.import,
  Update: () => state.update,
  Delete: () => state.del,
});
const fileSelectorMgr = recordingManager({ OpenAudioDialog: () => state.audioDialog });
const appDataMgr = recordingManager({
  GetAudioDirectory: () => '/appdata/Audio',
  OpenFolder: () => state.openFolder,
});
const discoveryMgr = recordingManager({
  Start: () => state.startResult,
  Stop: () => state.stopResult,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  {
    match: matchesModule('../renderer-bus'),
    value: { PushToRenderers: (...args) => pushes.push(args) },
  },
  { match: matchesModule('../app-window'), value: { hasMainWindow: () => state.hasWindow } },
  { match: matchesModule('/Modules/AudioAssetManager'), value: { Manager: audioMgr } },
  { match: matchesModule('/Modules/FileSelectorManager'), value: { Manager: fileSelectorMgr } },
  { match: matchesModule('/Modules/AppData'), value: { Manager: appDataMgr } },
  { match: matchesModule('/Modules/NetworkDiscovery'), value: { Manager: discoveryMgr } },
]);
test.after(() => restore());

const { register: registerAudio } = require('../dist/main/registrars/audio');
const { register: registerNetwork } = require('../dist/main/registrars/network');
const { GetHandler } = require('../dist/main/handler-registry');
registerAudio();
registerNetwork();

test.beforeEach(() => {
  state.getAll = [null, [{ ID: 'asset-1' }]];
  state.getDataURL = [null, { DataURL: 'data:audio/wav;base64,AAA' }];
  state.audioDialog = { canceled: false, filePaths: ['/clips/a.wav', '/clips/b.wav'] };
  state.import = [null, { ID: 'asset-9' }];
  state.update = [null, { ID: 'asset-1' }];
  state.del = [null, true];
  state.hasWindow = true;
  state.startResult = [null, { ScanID: 'scan-0001' }];
  state.stopResult = [null, true];
  pushes.length = 0;
  for (const M of [audioMgr, fileSelectorMgr, appDataMgr, discoveryMgr]) M.__calls.length = 0;
});

test('registers a handler for every audio and network channel', () => {
  for (const Channel of [
    'Audio:GetAll',
    'Audio:GetData',
    'Audio:Select',
    'Audio:Import',
    'Audio:Update',
    'Audio:Delete',
    'Audio:OpenFolder',
    'NetworkDiscovery:Start',
    'NetworkDiscovery:Stop',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- Audio readers ----------------------------------------------------------

test('Audio:GetAll returns the list, and [] on error or empty', async () => {
  const Handler = GetHandler('Audio:GetAll');
  assert.deepEqual(await Handler(null), [{ ID: 'asset-1' }]);

  state.getAll = ['db exploded', null];
  assert.deepEqual(await Handler(null), []);

  state.getAll = [null, null];
  assert.deepEqual(await Handler(null), []);
});

test('Audio:GetData returns the payload tuple for a valid id', async () => {
  assert.deepEqual(await GetHandler('Audio:GetData')(null, 'asset-1'), [
    null,
    { DataURL: 'data:audio/wav;base64,AAA' },
  ]);
});

test('Audio:GetData returns a validation tuple for a bad id', async () => {
  // Unlike the other readers this one returns a TUPLE, so a bad id must not
  // collapse to null — the renderer shows the message.
  const [Err, Data] = await GetHandler('Audio:GetData')(null, '   ');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, null);
  assert.equal(audioMgr.__callsTo('GetDataURL').length, 0);
});

// --- Audio:Select -----------------------------------------------------------

test('Audio:Select inspects every chosen file so the renderer can check duration', async () => {
  const [Err, Candidates] = await GetHandler('Audio:Select')(null);
  assert.equal(Err, null);
  assert.deepEqual(Candidates, [
    { SourcePath: '/clips/a.wav', Inspected: true },
    { SourcePath: '/clips/b.wav', Inspected: true },
  ]);
});

test('Audio:Select returns an empty list when the picker is dismissed', async () => {
  for (const Dialog of [
    { canceled: true, filePaths: ['/clips/a.wav'] },
    { canceled: false, filePaths: [] },
    { canceled: false, filePaths: null },
  ]) {
    state.audioDialog = Dialog;
    assert.deepEqual(await GetHandler('Audio:Select')(null), [null, []]);
  }
  assert.equal(audioMgr.__callsTo('InspectCandidate').length, 0);
});

// --- Audio mutations: broadcast only on success ----------------------------

test('Audio:Import notifies the renderers after a successful import', async () => {
  const Result = await GetHandler('Audio:Import')(null, { SourcePath: '/clips/a.wav' });
  assert.deepEqual(Result, [null, { ID: 'asset-9' }]);
  assert.deepEqual(pushes, [['AudioAssetsUpdated']]);
});

test('Audio:Import does not notify when the import fails', async () => {
  state.import = ['unsupported format', null];
  assert.deepEqual(await GetHandler('Audio:Import')(null, { SourcePath: '/clips/a.wav' }), [
    'unsupported format',
    null,
  ]);
  assert.deepEqual(pushes, []);
});

test('Audio:Import rejects a malformed payload before the manager', async () => {
  const Handler = GetHandler('Audio:Import');
  for (const Bad of [null, 'nope', {}]) {
    const [Err] = await Handler(null, Bad);
    assert.equal(typeof Err, 'string', `expected rejection for ${JSON.stringify(Bad)}`);
  }
  assert.equal(audioMgr.__callsTo('Import').length, 0);
  assert.deepEqual(pushes, []);
});

test('Audio:Update validates both arguments and notifies only on success', async () => {
  const Handler = GetHandler('Audio:Update');

  assert.deepEqual(await Handler(null, 'asset-1', { Label: 'Renamed' }), [null, { ID: 'asset-1' }]);
  assert.deepEqual(pushes, [['AudioAssetsUpdated']]);

  pushes.length = 0;
  state.update = ['not found', null];
  assert.deepEqual(await Handler(null, 'asset-1', { Label: 'Renamed' }), ['not found', null]);
  assert.deepEqual(pushes, []);

  pushes.length = 0;
  audioMgr.__calls.length = 0;
  const [Err] = await Handler(null, '', { Label: 'Renamed' });
  assert.equal(typeof Err, 'string');
  assert.equal(audioMgr.__callsTo('Update').length, 0);
  assert.deepEqual(pushes, []);
});

test('Audio:Delete notifies only on success', async () => {
  const Handler = GetHandler('Audio:Delete');

  assert.deepEqual(await Handler(null, 'asset-1'), [null, true]);
  assert.deepEqual(pushes, [['AudioAssetsUpdated']]);

  pushes.length = 0;
  state.del = ['still referenced by an alert action', null];
  assert.deepEqual(await Handler(null, 'asset-1'), ['still referenced by an alert action', null]);
  assert.deepEqual(pushes, []);
});

test('Audio:OpenFolder opens the configured audio directory', async () => {
  assert.equal(await GetHandler('Audio:OpenFolder')(null), 'opened');
  assert.deepEqual(appDataMgr.__callsTo('OpenFolder')[0].args, ['/appdata/Audio']);
});

// --- NetworkDiscovery -------------------------------------------------------

test('NetworkDiscovery:Start validates options and returns the scan handle', async () => {
  const [Err, Result] = await GetHandler('NetworkDiscovery:Start')(null, {});
  assert.equal(Err, null);
  assert.deepEqual(Result, { ScanID: 'scan-0001' });
  assert.equal(discoveryMgr.__callsTo('Start').length, 1);
});

test('NetworkDiscovery:Start rejects malformed options before starting a scan', async () => {
  const [Err, Data] = await GetHandler('NetworkDiscovery:Start')(null, 'not-an-object');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, null);
  assert.equal(discoveryMgr.__callsTo('Start').length, 0);
});

test('NetworkDiscovery:Start forwards scan events to the renderers', async () => {
  await GetHandler('NetworkDiscovery:Start')(null, {});
  // The manager is handed a progress callback; invoke it as the scanner would.
  const OnEvent = discoveryMgr.__callsTo('Start')[0].args[1];
  OnEvent({ Host: '10.0.0.5' });
  assert.deepEqual(pushes, [['NetworkDeviceScanEvent', { Host: '10.0.0.5' }]]);
});

test('NetworkDiscovery:Start drops scan events when there is no window to receive them', async () => {
  // A scan can outlive the window it was started from; pushing then would throw
  // on a destroyed WebContents.
  await GetHandler('NetworkDiscovery:Start')(null, {});
  const OnEvent = discoveryMgr.__callsTo('Start')[0].args[1];
  state.hasWindow = false;
  OnEvent({ Host: '10.0.0.5' });
  assert.deepEqual(pushes, []);
});

test('NetworkDiscovery:Start surfaces a manager failure', async () => {
  state.startResult = ['a scan is already running', null];
  assert.deepEqual(await GetHandler('NetworkDiscovery:Start')(null, {}), [
    'a scan is already running',
    null,
  ]);
});

test('NetworkDiscovery:Stop validates the scan id', async () => {
  const Handler = GetHandler('NetworkDiscovery:Stop');

  assert.deepEqual(await Handler(null, 'scan-0001'), [null, true]);
  assert.deepEqual(discoveryMgr.__callsTo('Stop')[0].args, ['scan-0001']);

  discoveryMgr.__calls.length = 0;
  const [Err, Data] = await Handler(null, '');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, false); // validationErrorTuple(error, false)
  assert.equal(discoveryMgr.__callsTo('Stop').length, 0);
});

test('NetworkDiscovery:Stop surfaces a manager failure', async () => {
  state.stopResult = ['no such scan', null];
  assert.deepEqual(await GetHandler('NetworkDiscovery:Stop')(null, 'scan-0001'), [
    'no such scan',
    null,
  ]);
});
