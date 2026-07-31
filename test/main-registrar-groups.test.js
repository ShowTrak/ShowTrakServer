const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises the groups registrar end-to-end through the REAL rpc wrapper, the
// REAL IPCValidation, and the REAL createTupleHandler — only the sqlite-backed
// domain managers and Electron are stubbed. This is what the plan's Phase 4.1
// "registrar/rpc tests" asks for: proof that a registrar wires the right
// channels, validates input, and delegates/routes correctly.

// Mutable behavior for the stubbed managers, controlled per-test.
const state = {
  groupGetAll: [null, []],
  setOrder: { ok: true },
};

const groupMgr = recordingManager({
  GetAll: () => state.groupGetAll,
  Create: (title) => [null, { GroupID: 7, Title: title }],
  SetOrder: () => state.setOrder,
  SetGroupOrderWithWeights: () => true,
});
const monitorMgr = recordingManager({ SetGroupAndWeight: () => true });
const dummyMgr = recordingManager({ SetGroupAndWeight: () => true });
const clientMgr = recordingManager({ SetGroupOrderWithWeights: () => true });
const broadcastMgr = recordingManager({ emit: () => {} });
const electronStub = { ipcMain: { handle() {} } };

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: electronStub },
  { match: matchesModule('electron'), value: electronStub },
  { match: matchesModule('/Modules/GroupManager'), value: { Manager: groupMgr } },
  { match: matchesModule('/Modules/MonitoringTargetManager'), value: { Manager: monitorMgr } },
  // See the note in main-broadcast-bridge.test.js. This registrar reorders
  // terminals alongside the other types, so it calls SetGroupAndWeight.
  {
    match: matchesModule('/Modules/FreeKioskManager'),
    value: { Manager: { SetGroupAndWeight: async () => [null, true] } },
  },
  { match: matchesModule('/Modules/DummyClientManager'), value: { Manager: dummyMgr } },
  { match: matchesModule('/Modules/ClientManager'), value: { Manager: clientMgr } },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: broadcastMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/groups');
const { GetHandler } = require('../dist/main/handler-registry');
register();

function resetCalls() {
  for (const m of [groupMgr, monitorMgr, dummyMgr, clientMgr, broadcastMgr]) m.__calls.length = 0;
}

test('registers a handler for every groups channel', () => {
  const channels = [
    'GetAllGroups',
    'CreateGroup',
    'RenameGroup',
    'DeleteGroup',
    'Groups:SetFullWidth',
    'Groups:SetKeyBind',
    'Groups:SetOrder',
    'SetGroupOrder',
  ];
  for (const channel of channels) {
    assert.equal(typeof GetHandler(channel), 'function', `missing handler for ${channel}`);
  }
});

test('GetAllGroups returns the list on success and [] on error/empty', async () => {
  const handler = GetHandler('GetAllGroups');

  state.groupGetAll = [null, [{ GroupID: 1, Title: 'A' }]];
  assert.deepEqual(await handler(null), [{ GroupID: 1, Title: 'A' }]);

  state.groupGetAll = ['db exploded', null];
  assert.deepEqual(await handler(null), []);

  state.groupGetAll = [null, null];
  assert.deepEqual(await handler(null), []);
});

test('CreateGroup validates the title then delegates to GroupManager.Create', async () => {
  const handler = GetHandler('CreateGroup');
  resetCalls();

  const ok = await handler(null, 'Front Of House');
  assert.deepEqual(ok, [null, { GroupID: 7, Title: 'Front Of House' }]);
  assert.deepEqual(groupMgr.__callsTo('Create'), [{ method: 'Create', args: ['Front Of House'] }]);
});

test('CreateGroup returns an error tuple and skips the manager on invalid input', async () => {
  const handler = GetHandler('CreateGroup');
  resetCalls();

  const [Err, Data] = await handler(null, 'ab'); // below the 3-char minimum
  assert.equal(typeof Err, 'string');
  assert.ok(Err.length > 0);
  assert.equal(Data, null);
  assert.equal(groupMgr.__callsTo('Create').length, 0);
});

test('Groups:SetOrder rejects a non-array before touching the manager', async () => {
  const handler = GetHandler('Groups:SetOrder');
  resetCalls();

  assert.deepEqual(await handler(null, 'not-an-array'), ['Invalid order', null]);
  assert.equal(groupMgr.__callsTo('SetOrder').length, 0);
});

test('Groups:SetOrder dedupes/drops nulls and reports manager failure', async () => {
  const handler = GetHandler('Groups:SetOrder');

  state.setOrder = { ok: true };
  resetCalls();
  assert.deepEqual(await handler(null, [1, 2, 2, null, '3']), [null, true]);
  const call = groupMgr.__callsTo('SetOrder')[0];
  assert.deepEqual(call.args[0], [1, 2, 3]); // deduped, nulls removed, string coerced

  state.setOrder = { ok: false, errors: ['nope'] };
  resetCalls();
  assert.deepEqual(await handler(null, [1]), ['nope', null]);
});

test('SetGroupOrder routes monitor:/dummy:/client entries with a shared weight scale', async () => {
  const handler = GetHandler('SetGroupOrder');
  resetCalls();

  const result = await handler(null, '5', ['monitor:2', 'dummy:abc', 'clientX']);
  assert.equal(result, true);

  // Weights are assigned 10, 20, 30 in list order regardless of entity type.
  assert.deepEqual(monitorMgr.__callsTo('SetGroupAndWeight'), [
    { method: 'SetGroupAndWeight', args: [2, 5, 10] },
  ]);
  assert.deepEqual(dummyMgr.__callsTo('SetGroupAndWeight'), [
    { method: 'SetGroupAndWeight', args: ['abc', 5, 20] },
  ]);
  assert.deepEqual(clientMgr.__callsTo('SetGroupOrderWithWeights'), [
    { method: 'SetGroupOrderWithWeights', args: [5, ['clientX'], [30]] },
  ]);

  // Both coalesced refresh broadcasts fire (monitors + dummies were touched).
  const emitted = broadcastMgr.__callsTo('emit').map((c) => c.args[0]);
  assert.deepEqual(emitted.sort(), ['DummyClientListChanged', 'MonitoringTargetListChanged']);
});

test('SetGroupOrder skips broadcasts when only clients move', async () => {
  const handler = GetHandler('SetGroupOrder');
  resetCalls();

  await handler(null, '5', ['clientA', 'clientB']);
  assert.equal(clientMgr.__callsTo('SetGroupOrderWithWeights').length, 1);
  assert.equal(broadcastMgr.__callsTo('emit').length, 0);
  assert.equal(monitorMgr.__callsTo('SetGroupAndWeight').length, 0);
});
