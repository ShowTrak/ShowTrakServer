// Exercises the list view's search (Ctrl/Cmd+F): the pure rules in
// src/UI/js/app/lib/list-filter.ts.
//
// What is at stake:
//   - every row type must be findable by name, tag, address and group name, or
//     an operator searching mid-show concludes the device is not in the show;
//   - the index must be keyed by each tile's own data-uuid, or the right rows
//     match and the wrong ones are hidden;
//   - each word must be allowed to match a different field, so "stage 10.0"
//     narrows instead of finding nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const Filter = require(path.join(APP, 'lib', 'list-filter.js'));

const Tag = (TagID, Slug, Scope) => ({
  TagID,
  Slug,
  Colour: 0,
  Icon: 'tag',
  Scope: { Workspace: false, Groups: [], Clients: [], Tags: [], ...Scope },
});

function Entities(Overrides = {}) {
  return {
    Groups: [
      { GroupID: 1, Title: 'Stage Left' },
      { GroupID: 2, Title: 'Front of House' },
      { GroupID: null, Title: 'No Group' },
    ],
    Tags: [
      Tag(1, 'projectors', { Clients: ['c-1', 'monitor:7'] }),
      Tag(2, 'audio', { Groups: [2] }),
    ],
    Clients: [
      { UUID: 'c-1', Nickname: 'Proj Left', Hostname: 'PROJ-01', IP: '10.0.1.11', GroupID: 1 },
      { UUID: 'c-2', Nickname: '', Hostname: 'QLAB-MAIN', IP: '10.0.2.20', GroupID: 2 },
    ],
    Monitors: [
      {
        TargetID: 7,
        Nickname: 'Barco',
        Address: '10.0.1.50',
        GroupID: 1,
        Checks: [{ CheckID: 3, Name: 'PJLink Power', Address: '10.0.1.51' }],
      },
    ],
    Dummies: [{ UUID: 'd-1', DummyID: 'spare-mac', Nickname: 'Spare', IP: null, GroupID: null }],
    Kiosks: [{ UUID: 'k-1', Nickname: 'Lobby Tablet', Address: '10.0.3.5', IP: null, GroupID: 2 }],
    Pending: [{ UUID: 'p-1', Hostname: 'NEW-MAC', IP: '10.0.9.9' }],
    ...Overrides,
  };
}

const Search = (Query, E = Entities()) =>
  [...Filter.MatchListSearch(Filter.BuildListSearchIndex(E), Filter.ParseListSearch(Query))].sort();

test('ParseListSearch: lower-cased words, nothing for blank or non-text input', () => {
  assert.deepEqual(Filter.ParseListSearch('  Stage   10.0 '), ['stage', '10.0']);
  assert.deepEqual(Filter.ParseListSearch('   '), []);
  assert.deepEqual(Filter.ParseListSearch(undefined), []);
});

test('MatchesListSearch: every word must match, each in any field', () => {
  assert.equal(Filter.MatchesListSearch(['Proj Left', '10.0.1.11'], ['left', '10.0.1']), true);
  assert.equal(Filter.MatchesListSearch(['Proj Left', '10.0.1.11'], ['left', '10.0.2']), false);
  assert.equal(Filter.MatchesListSearch([], []), true);
});

test('index is keyed by each tile data-uuid', () => {
  const Keys = [...Filter.BuildListSearchIndex(Entities()).keys()].sort();
  assert.deepEqual(Keys, ['c-1', 'c-2', 'dummy:d-1', 'kiosk:k-1', 'monitor:7', 'p-1']);
});

test('finds rows by name, hostname, slug-like id and address', () => {
  assert.deepEqual(Search('proj-01'), ['c-1']);
  // Every word matched somewhere: the Barco is tagged "projectors" in "Stage Left".
  assert.deepEqual(Search('proj left'), ['c-1', 'monitor:7']);
  assert.deepEqual(Search('qlab'), ['c-2']);
  assert.deepEqual(Search('spare-mac'), ['dummy:d-1']);
  assert.deepEqual(Search('10.0.3.5'), ['kiosk:k-1']);
  assert.deepEqual(Search('new-mac'), ['p-1']);
});

test('finds a monitor by its own and its checks names and addresses', () => {
  assert.deepEqual(Search('barco'), ['monitor:7']);
  assert.deepEqual(Search('pjlink'), ['monitor:7']);
  assert.deepEqual(Search('10.0.1.51'), ['monitor:7']);
});

test('finds rows by group name, including the No Group bucket', () => {
  assert.deepEqual(Search('stage left'), ['c-1', 'monitor:7']);
  assert.deepEqual(Search('front'), ['c-2', 'kiosk:k-1']);
  assert.deepEqual(Search('no group'), ['dummy:d-1']);
});

test('finds rows by tag, direct or through a group, with the scope ids tiles use', () => {
  assert.deepEqual(Search('projectors'), ['c-1', 'monitor:7']);
  assert.deepEqual(Search('audio'), ['c-2', 'kiosk:k-1']);
});

test('a hidden tag still finds its rows', () => {
  const E = Entities({ Tags: [{ ...Tag(9, 'secret', { Clients: ['c-2'] }), Display: 'hidden' }] });
  assert.deepEqual(Search('secret', E), ['c-2']);
});

test('words may match different fields', () => {
  assert.deepEqual(Search('stage 10.0.1.11'), ['c-1']);
  assert.deepEqual(Search('projectors barco'), ['monitor:7']);
  assert.deepEqual(Search('stage qlab'), []);
});

test('pending devices are not found by group or tag', () => {
  const E = Entities({ Tags: [Tag(1, 'everything', { Workspace: true })] });
  assert.ok(!Search('everything', E).includes('p-1'));
  assert.ok(!Search('no group', E).includes('p-1'));
});

test('no search keeps every row', () => {
  assert.equal(Search('').length, 6);
});
