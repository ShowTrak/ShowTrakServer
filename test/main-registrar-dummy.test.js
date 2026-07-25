const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/dummy.ts — the dummy (placeholder) client CRUD
// channels.
//
// This registrar shows BOTH main-process handler contracts side by side, so the
// tests pin the difference: readers return a raw value (or its empty fallback)
// while mutations return an [Err, Result] tuple. Confusing the two silently
// breaks the renderer, which unpacks one or the other without checking.
//
// The real IPCValidation runs (only the managers and Electron are stubbed), so
// these also cover the validation boundary for untrusted renderer input.

const state = {
  getAll: [null, [{ UUID: 'dummy-1' }]],
  get: [null, { UUID: 'dummy-1', DummyID: 'foh-pc' }],
  defaults: { DummyID: 'dummy-1', Nickname: 'Dummy 1' },
  create: [null, { UUID: 'new-dummy' }],
  update: [null, true],
  del: [null, true],
  resetToIdle: [null, true],
};

const dummyMgr = recordingManager({
  GetAll: () => state.getAll,
  Get: () => state.get,
  GenerateDefaults: () => state.defaults,
  Create: () => state.create,
  Update: () => state.update,
  Delete: () => state.del,
  ResetToIdle: () => state.resetToIdle,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/DummyClientManager'), value: { Manager: dummyMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/dummy');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.getAll = [null, [{ UUID: 'dummy-1' }]];
  state.get = [null, { UUID: 'dummy-1', DummyID: 'foh-pc' }];
  state.create = [null, { UUID: 'new-dummy' }];
  state.update = [null, true];
  state.del = [null, true];
  state.resetToIdle = [null, true];
  dummyMgr.__calls.length = 0;
});

test('registers a handler for every dummy channel', () => {
  for (const Channel of [
    'GetAllDummyClients',
    'GetDummyClient',
    'GenerateDummyClientDefaults',
    'CreateDummyClient',
    'UpdateDummyClient',
    'DeleteDummyClient',
    'ResetDummyClientToIdle',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- Readers: raw value, empty fallback on failure -------------------------

test('GetAllDummyClients returns the list, and [] on error or empty', async () => {
  const Handler = GetHandler('GetAllDummyClients');

  assert.deepEqual(await Handler(null), [{ UUID: 'dummy-1' }]);

  state.getAll = ['db exploded', null];
  assert.deepEqual(await Handler(null), []);

  state.getAll = [null, null];
  assert.deepEqual(await Handler(null), []);
});

test('GetDummyClient returns the record for a valid UUID', async () => {
  const Result = await GetHandler('GetDummyClient')(null, 'dummy-1');
  assert.deepEqual(Result, { UUID: 'dummy-1', DummyID: 'foh-pc' });
  assert.deepEqual(dummyMgr.__callsTo('Get')[0].args, ['dummy-1']);
});

test('GetDummyClient returns null (not a tuple) for invalid input or a miss', async () => {
  const Handler = GetHandler('GetDummyClient');

  // Invalid UUID: rejected before the manager is consulted.
  assert.equal(await Handler(null, ''), null);
  assert.equal(await Handler(null, null), null);
  assert.equal(await Handler(null, 42), null);
  assert.equal(dummyMgr.__callsTo('Get').length, 0);

  // Valid UUID, manager error: still the reader's null fallback.
  state.get = ['not found', null];
  assert.equal(await Handler(null, 'dummy-1'), null);
});

test('GenerateDummyClientDefaults passes the manager value straight through', async () => {
  assert.deepEqual(await GetHandler('GenerateDummyClientDefaults')(null), {
    DummyID: 'dummy-1',
    Nickname: 'Dummy 1',
  });
});

// --- Mutations: [Err, Result] tuples ---------------------------------------

test('CreateDummyClient validates the payload then delegates', async () => {
  const Result = await GetHandler('CreateDummyClient')(null, { DummyID: 'foh-pc' });
  assert.deepEqual(Result, [null, { UUID: 'new-dummy' }]);
  assert.deepEqual(dummyMgr.__callsTo('Create')[0].args, [{ DummyID: 'foh-pc' }]);
});

test('CreateDummyClient accepts an omitted payload as an empty one', async () => {
  // The renderer's "add dummy" button sends nothing and expects defaults.
  assert.deepEqual(await GetHandler('CreateDummyClient')(null, undefined), [
    null,
    { UUID: 'new-dummy' },
  ]);
  assert.deepEqual(dummyMgr.__callsTo('Create')[0].args, [{}]);
});

test('CreateDummyClient rejects a DummyID with characters that break the OSC route', async () => {
  // DummyID doubles as the slug in /API/Dummy/:ID, so spaces and slashes must
  // never reach the manager.
  const Handler = GetHandler('CreateDummyClient');
  for (const Bad of ['has space', 'has/slash', 'has:colon', '']) {
    const [Err, Data] = await Handler(null, { DummyID: Bad });
    assert.equal(typeof Err, 'string', `expected rejection for ${JSON.stringify(Bad)}`);
    assert.ok(Err.length > 0);
    assert.equal(Data, null);
  }
  assert.equal(dummyMgr.__callsTo('Create').length, 0);
});

test('CreateDummyClient rejects a non-object payload', async () => {
  const [Err] = await GetHandler('CreateDummyClient')(null, 'not-an-object');
  assert.match(Err, /must be an object/i);
  assert.equal(dummyMgr.__callsTo('Create').length, 0);
});

test('CreateDummyClient reports a manager failure as an error tuple', async () => {
  state.create = ['DummyID already in use', null];
  assert.deepEqual(await GetHandler('CreateDummyClient')(null, { DummyID: 'foh-pc' }), [
    'DummyID already in use',
    null,
  ]);
});

test('UpdateDummyClient validates both the UUID and the payload', async () => {
  const Handler = GetHandler('UpdateDummyClient');

  assert.deepEqual(await Handler(null, 'dummy-1', { Nickname: 'Front of House' }), [null, true]);
  assert.deepEqual(dummyMgr.__callsTo('Update')[0].args, [
    'dummy-1',
    { Nickname: 'Front of House' },
  ]);

  dummyMgr.__calls.length = 0;
  const [Err] = await Handler(null, '', { Nickname: 'x' });
  assert.equal(typeof Err, 'string');
  assert.equal(dummyMgr.__callsTo('Update').length, 0);
});

test('DeleteDummyClient delegates and reports failure', async () => {
  const Handler = GetHandler('DeleteDummyClient');
  assert.deepEqual(await Handler(null, 'dummy-1'), [null, true]);

  state.del = ['in use', null];
  assert.deepEqual(await Handler(null, 'dummy-1'), ['in use', null]);
});

test('DeleteDummyClient pairs an invalid UUID with the false fallback', async () => {
  // invalidFallback:false, matching every other Delete/* handler (alerts, tags,
  // clients, fog): the renderer reads the payload slot as a boolean success
  // flag. This handler originally omitted the option — harmlessly, since its
  // only caller destructures `const [Err]` — and was brought into line with the
  // convention create-handler.ts documents.
  const [Err, Data] = await GetHandler('DeleteDummyClient')(null, null);
  assert.equal(typeof Err, 'string');
  assert.equal(Data, false);
  assert.equal(dummyMgr.__callsTo('Delete').length, 0);
});

test('ResetDummyClientToIdle validates the UUID then delegates', async () => {
  const Handler = GetHandler('ResetDummyClientToIdle');
  assert.deepEqual(await Handler(null, 'dummy-1'), [null, true]);
  assert.deepEqual(dummyMgr.__callsTo('ResetToIdle')[0].args, ['dummy-1']);

  dummyMgr.__calls.length = 0;
  const [Err, Data] = await Handler(null, 'x'); // below the 2-char minimum
  assert.equal(typeof Err, 'string');
  assert.equal(Data, null);
  assert.equal(dummyMgr.__callsTo('ResetToIdle').length, 0);
});
