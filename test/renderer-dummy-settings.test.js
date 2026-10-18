const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/dummy-settings.ts: the payload both the Add Dummy
// Client modal and a dummy's Settings tab save.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  BuildDummyPayload,
  DummySettingsDraftChanged,
} = require('../dist-test/UI/js/app/lib/dummy-settings.js');

const DRAFT = {
  DummyID: 'DummyClient3',
  Nickname: 'Lobby Screen',
  GroupID: '2',
  Interval: '15000',
};

test('a draft becomes the payload the dummy editor always sent', () => {
  assert.deepEqual(BuildDummyPayload(DRAFT), {
    Payload: { DummyID: 'DummyClient3', Nickname: 'Lobby Screen', Interval: 15000, GroupID: 2 },
    Error: null,
  });
});

test('No Group is null', () => {
  assert.equal(BuildDummyPayload({ ...DRAFT, GroupID: 'null' }).Payload.GroupID, null);
  assert.equal(BuildDummyPayload({ ...DRAFT, GroupID: '' }).Payload.GroupID, null);
});

test('an empty title falls back to "Dummy <n>" from the ID', () => {
  assert.equal(BuildDummyPayload({ ...DRAFT, Nickname: '  ' }).Payload.Nickname, 'Dummy 3');
  assert.equal(
    BuildDummyPayload({ ...DRAFT, DummyID: 'lobby', Nickname: '' }).Payload.Nickname,
    'Dummy lobby'
  );
});

test('the ID is required and, being the slug, has no spaces or symbols', () => {
  assert.equal(BuildDummyPayload({ ...DRAFT, DummyID: ' ' }).Error, 'Please enter an ID.');
  assert.match(BuildDummyPayload({ ...DRAFT, DummyID: 'lobby screen' }).Error, /only contain/);
  assert.match(BuildDummyPayload({ ...DRAFT, DummyID: 'lobby/1' }).Error, /only contain/);
  assert.equal(
    BuildDummyPayload({ ...DRAFT, DummyID: ' lobby_1-a ' }).Payload.DummyID,
    'lobby_1-a'
  );
});

test('Save is offered only once the form differs from what it was filled with', () => {
  assert.equal(DummySettingsDraftChanged(DRAFT, { ...DRAFT }), false);
  assert.equal(DummySettingsDraftChanged(DRAFT, { ...DRAFT, Interval: '20000' }), true);
  assert.equal(DummySettingsDraftChanged(null, DRAFT), false);
});
