const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/tags.ts — the Tags:* channels.
//
// Tags are cross-cutting colour+icon collections whose membership is a dynamic
// scope ({ Workspace, Groups[], Clients[] }). The scope entries are scoped-ID
// strings (a bare UUID, or a prefixed "monitor:12" / "check:3"), so the
// validation boundary here is what stops a malformed scope reaching the
// manager and silently matching nothing — or everything.
//
// Real IPCValidation runs; only the managers and Electron are stubbed.

const state = {
  views: [{ TagID: 1, Slug: 'foh' }],
  create: [null, { ToView: () => ({ TagID: 5, Slug: 'tag-5' }) }],
  setSlug: [null, true],
  setColour: [null, true],
  setIcon: [null, true],
  setScope: [null, true],
  setOrder: { ok: true },
  del: [null, true],
};

const tagMgr = recordingManager({
  GetAllViews: () => state.views,
  Create: () => state.create,
  SetSlug: () => state.setSlug,
  SetColour: () => state.setColour,
  SetIcon: () => state.setIcon,
  SetScope: () => state.setScope,
  SetOrder: () => state.setOrder,
  Delete: () => state.del,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/TagManager'), value: { Manager: tagMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/tags');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.views = [{ TagID: 1, Slug: 'foh' }];
  state.create = [null, { ToView: () => ({ TagID: 5, Slug: 'tag-5' }) }];
  state.setSlug = [null, true];
  state.setColour = [null, true];
  state.setIcon = [null, true];
  state.setScope = [null, true];
  state.setOrder = { ok: true };
  state.del = [null, true];
  tagMgr.__calls.length = 0;
});

test('registers a handler for every tags channel', () => {
  for (const Channel of [
    'Tags:GetAll',
    'Tags:Create',
    'Tags:SetSlug',
    'Tags:SetColour',
    'Tags:SetIcon',
    'Tags:SetScope',
    'Tags:SetOrder',
    'Tags:Delete',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- Tags:GetAll / Tags:Create ---------------------------------------------

test('Tags:GetAll returns the serialized views', async () => {
  assert.deepEqual(await GetHandler('Tags:GetAll')(null), [{ TagID: 1, Slug: 'foh' }]);
});

test('Tags:Create returns the created view so the editor can open it', async () => {
  const Result = await GetHandler('Tags:Create')(null, 'Front Of House');
  assert.deepEqual(Result, [null, { TagID: 5, Slug: 'tag-5' }]);
  assert.deepEqual(tagMgr.__callsTo('Create')[0].args, ['Front Of House']);
});

test('Tags:Create passes undefined for a non-string label so the manager defaults', async () => {
  for (const Bad of [null, undefined, 42, {}]) {
    tagMgr.__calls.length = 0;
    await GetHandler('Tags:Create')(null, Bad);
    assert.deepEqual(tagMgr.__callsTo('Create')[0].args, [undefined]);
  }
});

test('Tags:Create reports a failure, including a null tag with no error', async () => {
  const Handler = GetHandler('Tags:Create');

  state.create = ['slug collision', null];
  assert.deepEqual(await Handler(null, 'x'), ['slug collision', null]);

  // Defensive: manager returned success but no tag.
  state.create = [null, null];
  assert.deepEqual(await Handler(null, 'x'), ['Failed to create tag', null]);
});

// --- Field setters ----------------------------------------------------------

test('Tags:SetSlug validates the id and the slug', async () => {
  const Handler = GetHandler('Tags:SetSlug');

  assert.deepEqual(await Handler(null, 1, 'front-of-house'), [null, true]);
  assert.deepEqual(tagMgr.__callsTo('SetSlug')[0].args, [1, 'front-of-house']);

  tagMgr.__calls.length = 0;
  const [Err] = await Handler(null, 1, 'has space');
  assert.equal(typeof Err, 'string');
  assert.equal(tagMgr.__callsTo('SetSlug').length, 0);
});

test('Tags:SetSlug accepts a numeric-string tag id from a data attribute', async () => {
  await GetHandler('Tags:SetSlug')(null, '12', 'foh');
  assert.equal(tagMgr.__callsTo('SetSlug')[0].args[0], 12);
});

test('Tags:SetSlug rejects a non-positive or non-numeric tag id', async () => {
  const Handler = GetHandler('Tags:SetSlug');
  for (const Bad of [0, -1, 1.5, 'abc', null, undefined, {}]) {
    const [Err] = await Handler(null, Bad, 'foh');
    assert.equal(typeof Err, 'string', `expected rejection for ${JSON.stringify(Bad)}`);
  }
  assert.equal(tagMgr.__callsTo('SetSlug').length, 0);
});

test('Tags:SetColour requires a non-negative integer palette index', async () => {
  const Handler = GetHandler('Tags:SetColour');

  assert.deepEqual(await Handler(null, 1, 3), [null, true]);
  assert.deepEqual(tagMgr.__callsTo('SetColour')[0].args, [1, 3]);

  // Zero is a valid palette index, not a falsy rejection.
  tagMgr.__calls.length = 0;
  assert.deepEqual(await Handler(null, 1, 0), [null, true]);
  assert.deepEqual(tagMgr.__callsTo('SetColour')[0].args, [1, 0]);

  // Numeric strings coerce.
  tagMgr.__calls.length = 0;
  await Handler(null, 1, ' 4 ');
  assert.deepEqual(tagMgr.__callsTo('SetColour')[0].args, [1, 4]);

  tagMgr.__calls.length = 0;
  for (const Bad of [-1, 1.5, 'red', null]) {
    const [Err] = await Handler(null, 1, Bad);
    assert.equal(typeof Err, 'string', `expected rejection for ${JSON.stringify(Bad)}`);
  }
  assert.equal(tagMgr.__callsTo('SetColour').length, 0);
});

test('Tags:SetIcon coerces a non-string icon to empty and lets the manager default', async () => {
  const Handler = GetHandler('Tags:SetIcon');

  await Handler(null, 1, 'bi-star');
  assert.deepEqual(tagMgr.__callsTo('SetIcon')[0].args, [1, 'bi-star']);

  tagMgr.__calls.length = 0;
  await Handler(null, 1, null);
  assert.deepEqual(tagMgr.__callsTo('SetIcon')[0].args, [1, '']);
});

// --- Tags:SetScope ----------------------------------------------------------

test('Tags:SetScope normalizes the scope and dedupes its members', async () => {
  const [Err] = await GetHandler('Tags:SetScope')(null, 1, {
    Workspace: 1,
    Groups: [2, 2, '3'],
    Clients: ['uuid-a', 'uuid-a', 'monitor:12', 'check:3'],
  });
  assert.equal(Err, null);

  assert.deepEqual(tagMgr.__callsTo('SetScope')[0].args[1], {
    Workspace: true, // coerced from 1
    Groups: [2, 3], // deduped, numeric string coerced
    Clients: ['uuid-a', 'monitor:12', 'check:3'],
  });
});

test('Tags:SetScope defaults absent Groups/Clients to empty arrays', async () => {
  await GetHandler('Tags:SetScope')(null, 1, { Workspace: false });
  assert.deepEqual(tagMgr.__callsTo('SetScope')[0].args[1], {
    Workspace: false,
    Groups: [],
    Clients: [],
  });
});

test('Tags:SetScope drops blank client entries but rejects malformed ones', async () => {
  const Handler = GetHandler('Tags:SetScope');

  // Whitespace-only entries are skipped rather than failing the whole save.
  await Handler(null, 1, { Clients: ['uuid-a', '   ', ''] });
  assert.deepEqual(tagMgr.__callsTo('SetScope')[0].args[1].Clients, ['uuid-a']);

  tagMgr.__calls.length = 0;
  // Characters outside the scoped-ID charset are a hard error.
  const [SlashErr] = await Handler(null, 1, { Clients: ['bad/entry'] });
  assert.match(SlashErr, /client entry is invalid/i);

  const [TypeErr] = await Handler(null, 1, { Clients: [42] });
  assert.match(TypeErr, /must be strings/i);

  assert.equal(tagMgr.__callsTo('SetScope').length, 0);
});

test('Tags:SetScope rejects a non-object scope', async () => {
  const [Err] = await GetHandler('Tags:SetScope')(null, 1, 'everything');
  assert.match(Err, /must be an object/i);
  assert.equal(tagMgr.__callsTo('SetScope').length, 0);
});

// --- Tags:SetOrder ----------------------------------------------------------

test('Tags:SetOrder rejects a non-array before touching the manager', async () => {
  assert.deepEqual(await GetHandler('Tags:SetOrder')(null, 'not-an-array'), [
    'Invalid order',
    null,
  ]);
  assert.equal(tagMgr.__callsTo('SetOrder').length, 0);
});

test('Tags:SetOrder dedupes ids and coerces numeric strings', async () => {
  assert.deepEqual(await GetHandler('Tags:SetOrder')(null, [1, '2', 2, 3]), [null, true]);
  assert.deepEqual(tagMgr.__callsTo('SetOrder')[0].args[0], [1, 2, 3]);
});

test('Tags:SetOrder pairs an invalid id with the false fallback', async () => {
  const [Err, Data] = await GetHandler('Tags:SetOrder')(null, [1, 'nope']);
  assert.equal(typeof Err, 'string');
  assert.equal(Data, false);
  assert.equal(tagMgr.__callsTo('SetOrder').length, 0);
});

test('Tags:SetOrder surfaces the first manager error', async () => {
  state.setOrder = { ok: false, errors: ['tag 3 no longer exists', 'and another'] };
  assert.deepEqual(await GetHandler('Tags:SetOrder')(null, [1]), ['tag 3 no longer exists', null]);
});

test('Tags:SetOrder falls back to a generic message when none is supplied', async () => {
  state.setOrder = { ok: false };
  assert.deepEqual(await GetHandler('Tags:SetOrder')(null, [1]), ['Failed to reorder tags', null]);

  state.setOrder = { ok: false, errors: [] };
  assert.deepEqual(await GetHandler('Tags:SetOrder')(null, [1]), ['Failed to reorder tags', null]);
});

test('Tags:SetOrder accepts an empty list', async () => {
  assert.deepEqual(await GetHandler('Tags:SetOrder')(null, []), [null, true]);
  assert.deepEqual(tagMgr.__callsTo('SetOrder')[0].args[0], []);
});

// --- Tags:Delete ------------------------------------------------------------

test('Tags:Delete validates the id and reports failure', async () => {
  const Handler = GetHandler('Tags:Delete');
  assert.deepEqual(await Handler(null, 1), [null, true]);

  state.del = ['tag is in use', null];
  assert.deepEqual(await Handler(null, 1), ['tag is in use', null]);
});

test('Tags:Delete pairs an invalid id with the false fallback', async () => {
  const [Err, Data] = await GetHandler('Tags:Delete')(null, 'nope');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, false);
  assert.equal(tagMgr.__callsTo('Delete').length, 0);
});
