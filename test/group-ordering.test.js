const test = require('node:test');
const assert = require('node:assert/strict');

const { createGroupOrdering } = require('../src/Modules/Shared/group-ordering');

function makeHarness(entities) {
  const runCalls = [];
  const events = [];
  const DB = {
    Run: async (sql, params) => {
      runCalls.push([sql, params]);
      return [null, { changes: 1 }];
    },
  };
  const BroadcastManager = { emit: (event) => events.push(event) };
  return { runCalls, events, DB, BroadcastManager, list: entities };
}

function buildOrdering(harness, overrides = {}) {
  return createGroupOrdering({
    DB: harness.DB,
    BroadcastManager: harness.BroadcastManager,
    table: 'Widgets',
    keyColumn: 'ID',
    getList: () => harness.list,
    getKey: (entity) => entity.ID,
    normalizeKey: (raw) => Number(raw),
    listChangedEvent: 'WidgetListChanged',
    labels: {
      notFound: 'Widget not found',
      update: 'Failed to update widget',
      move: 'Failed to move widgets to no group',
      reconcile: 'Failed to reconcile orphaned widgets',
    },
    ...overrides,
  });
}

test('SetGroupAndWeight updates the matching entity and persists', async () => {
  const harness = makeHarness([{ ID: 1, GroupID: 5, Weight: 100 }]);
  const ordering = buildOrdering(harness);

  const [err, result] = await ordering.SetGroupAndWeight('1', 9, 30);
  assert.equal(err, null);
  assert.equal(result, true);
  assert.deepEqual(harness.runCalls[0], [
    'UPDATE Widgets SET GroupID = ?, Weight = ? WHERE ID = ?',
    [9, 30, 1],
  ]);
  assert.equal(harness.list[0].GroupID, 9);
  assert.equal(harness.list[0].Weight, 30);
});

test('SetGroupAndWeight returns notFound when the key is missing', async () => {
  const harness = makeHarness([{ ID: 1, GroupID: 5, Weight: 100 }]);
  const ordering = buildOrdering(harness);
  const [err] = await ordering.SetGroupAndWeight('999', 9, 30);
  assert.equal(err, 'Widget not found');
});

test('SetGroupAndWeight clears group when GroupID is null and defaults weight', async () => {
  const harness = makeHarness([{ ID: 2, GroupID: 5, Weight: 100 }]);
  const ordering = buildOrdering(harness);
  await ordering.SetGroupAndWeight('2', null, 'not-a-number');
  assert.deepEqual(harness.runCalls[0][1], [null, 100, 2]);
});

test('MoveGroupToNoGroup clears only matching members and emits once', async () => {
  const harness = makeHarness([
    { ID: 1, GroupID: 3 },
    { ID: 2, GroupID: 99 },
    { ID: 3, GroupID: 3 },
    { ID: 4, GroupID: null },
  ]);
  const ordering = buildOrdering(harness);

  const [err, changed] = await ordering.MoveGroupToNoGroup(3);
  assert.equal(err, null);
  assert.equal(changed, 2);
  assert.equal(harness.runCalls.length, 2);
  assert.deepEqual(harness.events, ['WidgetListChanged']);
  assert.equal(harness.list[0].GroupID, null);
  assert.equal(harness.list[2].GroupID, null);
  assert.equal(harness.list[1].GroupID, 99);
});

test('MoveGroupToNoGroup rejects a non-numeric GroupID', async () => {
  const harness = makeHarness([{ ID: 1, GroupID: 3 }]);
  const ordering = buildOrdering(harness);
  const [err] = await ordering.MoveGroupToNoGroup('abc');
  assert.equal(err, 'Invalid GroupID');
});

test('ReconcileOrphanedGroups clears entities whose group is not valid', async () => {
  const harness = makeHarness([
    { ID: 1, GroupID: 3 },
    { ID: 2, GroupID: 99 },
  ]);
  const ordering = buildOrdering(harness);

  const [err, changed] = await ordering.ReconcileOrphanedGroups([3]);
  assert.equal(err, null);
  assert.equal(changed, 1);
  assert.equal(harness.list[0].GroupID, 3);
  assert.equal(harness.list[1].GroupID, null);
  assert.deepEqual(harness.events, ['WidgetListChanged']);
});

test('ensureInitialized is awaited before mutating', async () => {
  const harness = makeHarness([{ ID: 1, GroupID: 3 }]);
  const order = [];
  const ordering = buildOrdering(harness, {
    ensureInitialized: async () => {
      order.push('init');
    },
  });
  harness.DB.Run = async () => {
    order.push('run');
    return [null, { changes: 1 }];
  };
  await ordering.MoveGroupToNoGroup(3);
  assert.deepEqual(order, ['init', 'run']);
});
