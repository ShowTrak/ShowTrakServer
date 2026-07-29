const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/alerts.ts — alert rule CRUD plus the global
// alert-actions kill switch.
//
// The kill switch is the interesting one: it is what an operator hits to stop
// alert actions firing mid-show, so it must coerce anything the renderer sends
// into a real boolean rather than passing a truthy string through.
//
// Real IPCValidation runs; only the managers and Electron are stubbed.

const state = {
  triggers: [{ Type: 'CLIENT_OFFLINE' }],
  actionTypes: [{ Type: 'SOUND' }],
  getAll: [null, [{ AlertRuleID: 1 }]],
  get: [null, { AlertRuleID: 1, Label: 'Offline' }],
  create: [null, { AlertRuleID: 9 }],
  update: [null, true],
  del: [null, true],
  setEnabled: [null, true],
  actionsEnabled: true,
};

const alertsMgr = recordingManager({
  GetTriggers: () => state.triggers,
  GetActionTypes: () => state.actionTypes,
  GetAll: () => state.getAll,
  Get: () => state.get,
  Create: () => state.create,
  Update: () => state.update,
  Delete: () => state.del,
  SetEnabled: () => state.setEnabled,
  GetActionsEnabled: () => state.actionsEnabled,
  SetActionsEnabled: (v) => v,
});

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: { ipcMain: { handle() {} } } },
  { match: matchesModule('/Modules/AlertsManager'), value: { Manager: alertsMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/alerts');
const { GetHandler } = require('../dist/main/handler-registry');
register();

test.beforeEach(() => {
  state.getAll = [null, [{ AlertRuleID: 1 }]];
  state.get = [null, { AlertRuleID: 1, Label: 'Offline' }];
  state.create = [null, { AlertRuleID: 9 }];
  state.update = [null, true];
  state.del = [null, true];
  state.setEnabled = [null, true];
  state.actionsEnabled = true;
  alertsMgr.__calls.length = 0;
});

test('registers a handler for every alerts channel', () => {
  for (const Channel of [
    'GetAlertTriggers',
    'GetAlertActionTypes',
    'GetAllAlertRules',
    'GetAlertRule',
    'CreateAlertRule',
    'UpdateAlertRule',
    'DeleteAlertRule',
    'SetAlertRuleEnabled',
    'AlertActionsEnabled:Get',
    'AlertActionsEnabled:Set',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `missing handler for ${Channel}`);
  }
});

// --- Readers ----------------------------------------------------------------

test('GetAlertTriggers and GetAlertActionTypes pass catalogues straight through', async () => {
  assert.deepEqual(await GetHandler('GetAlertTriggers')(null), [{ Type: 'CLIENT_OFFLINE' }]);
  assert.deepEqual(await GetHandler('GetAlertActionTypes')(null), [{ Type: 'SOUND' }]);
});

test('GetAllAlertRules returns the list, and [] on error or empty', async () => {
  const Handler = GetHandler('GetAllAlertRules');
  assert.deepEqual(await Handler(null), [{ AlertRuleID: 1 }]);

  state.getAll = ['db exploded', null];
  assert.deepEqual(await Handler(null), []);

  state.getAll = [null, null];
  assert.deepEqual(await Handler(null), []);
});

test('GetAlertRule returns the rule for a valid id', async () => {
  assert.deepEqual(await GetHandler('GetAlertRule')(null, 1), {
    AlertRuleID: 1,
    Label: 'Offline',
  });
});

test('GetAlertRule coerces a numeric string id', async () => {
  // The renderer reads ids out of data attributes, so they arrive as strings.
  await GetHandler('GetAlertRule')(null, '7');
  assert.deepEqual(alertsMgr.__callsTo('Get')[0].args, [7]);
});

test('GetAlertRule returns null for an invalid id or a manager error', async () => {
  const Handler = GetHandler('GetAlertRule');

  for (const Bad of [null, undefined, 'abc', 0, -1, 1.5, {}]) {
    assert.equal(await Handler(null, Bad), null, `expected null for ${JSON.stringify(Bad)}`);
  }
  assert.equal(alertsMgr.__callsTo('Get').length, 0);

  state.get = ['not found', null];
  assert.equal(await Handler(null, 1), null);
});

// --- Mutations --------------------------------------------------------------

/** The minimum payload AlertRuleCreatePayload accepts. */
function validRulePayload(overrides = {}) {
  return {
    Title: 'Offline alarm',
    Scope: { Workspace: true },
    TriggerType: 'CLIENT_OFFLINE',
    Actions: [],
    ...overrides,
  };
}

test('CreateAlertRule normalizes the payload then delegates', async () => {
  const Result = await GetHandler('CreateAlertRule')(null, validRulePayload());
  assert.equal(Result[0], null);
  assert.deepEqual(Result[1], { AlertRuleID: 9 });

  // The manager receives the NORMALIZED payload, not the raw renderer input:
  // the singular TriggerType has become a TriggerTypes array and Enabled has
  // been defaulted.
  const Sent = alertsMgr.__callsTo('Create')[0].args[0];
  assert.deepEqual(Sent.TriggerTypes, ['CLIENT_OFFLINE']);
  assert.equal(Sent.Enabled, true);
  assert.deepEqual(Sent.Scope, { Workspace: true, Groups: [], Clients: [], Tags: [] });
});

test('CreateAlertRule rejects a non-object payload before the manager', async () => {
  const [Err, Data] = await GetHandler('CreateAlertRule')(null, 'nope');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, null);
  assert.equal(alertsMgr.__callsTo('Create').length, 0);
});

test('CreateAlertRule requires a title and a scope', async () => {
  const Handler = GetHandler('CreateAlertRule');

  const [NoTitle] = await Handler(null, validRulePayload({ Title: '' }));
  assert.match(NoTitle, /Title/i);

  const [ShortTitle] = await Handler(null, validRulePayload({ Title: 'a' }));
  assert.match(ShortTitle, /Title/i);

  const [NoScope] = await Handler(null, validRulePayload({ Scope: undefined }));
  assert.match(NoScope, /Scope/i);

  assert.equal(alertsMgr.__callsTo('Create').length, 0);
});

test('CreateAlertRule enforces the trigger-type allowlist', async () => {
  // The renderer must not be able to invent a trigger type; an unknown one
  // would be persisted and then never fire, silently.
  const Handler = GetHandler('CreateAlertRule');

  const [Err] = await Handler(null, validRulePayload({ TriggerType: 'MADE_UP_TRIGGER' }));
  assert.match(Err, /Unsupported TriggerType/i);

  const [NoneErr] = await Handler(null, validRulePayload({ TriggerType: null }));
  assert.match(NoneErr, /At least one TriggerType/i);

  assert.equal(alertsMgr.__callsTo('Create').length, 0);
});

test('CreateAlertRule dedupes repeated trigger types', async () => {
  await GetHandler('CreateAlertRule')(
    null,
    validRulePayload({ TriggerTypes: ['CLIENT_OFFLINE', 'CLIENT_ONLINE', 'CLIENT_OFFLINE'] })
  );
  assert.deepEqual(alertsMgr.__callsTo('Create')[0].args[0].TriggerTypes, [
    'CLIENT_OFFLINE',
    'CLIENT_ONLINE',
  ]);
});

test('CreateAlertRule reports a manager failure as an error tuple', async () => {
  state.create = ['duplicate title', null];
  const [Err, Data] = await GetHandler('CreateAlertRule')(null, validRulePayload());
  assert.equal(Err, 'duplicate title');
  assert.equal(Data, null);
});

test('UpdateAlertRule validates the id and the payload', async () => {
  const Handler = GetHandler('UpdateAlertRule');

  const Ok = await Handler(null, 1, { Title: 'Renamed' });
  assert.equal(Ok[0], null);
  assert.equal(alertsMgr.__callsTo('Update')[0].args[0], 1);

  alertsMgr.__calls.length = 0;
  const [Err] = await Handler(null, 'not-a-number', { Title: 'Renamed' });
  assert.equal(typeof Err, 'string');
  assert.equal(alertsMgr.__callsTo('Update').length, 0);
});

test('UpdateAlertRule is a partial update — absent keys are not sent', async () => {
  // The editor saves one field at a time; carrying absent keys through as
  // undefined would blank the rest of the rule.
  await GetHandler('UpdateAlertRule')(null, 1, { Title: 'Renamed' });
  const Sent = alertsMgr.__callsTo('Update')[0].args[1];
  assert.deepEqual(Object.keys(Sent), ['Title']);
});

test('DeleteAlertRule pairs an invalid id with the false fallback', async () => {
  // invalidFallback:false here — the renderer reads the payload slot as a
  // boolean success flag.
  const [Err, Data] = await GetHandler('DeleteAlertRule')(null, 'nope');
  assert.equal(typeof Err, 'string');
  assert.equal(Data, false);
  assert.equal(alertsMgr.__callsTo('Delete').length, 0);
});

test('DeleteAlertRule delegates and reports failure', async () => {
  const Handler = GetHandler('DeleteAlertRule');
  assert.deepEqual(await Handler(null, 1), [null, true]);

  state.del = ['still referenced', null];
  assert.deepEqual(await Handler(null, 1), ['still referenced', null]);
});

test('SetAlertRuleEnabled coerces the flag to a real boolean', async () => {
  const Handler = GetHandler('SetAlertRuleEnabled');

  await Handler(null, 1, 'yes');
  assert.deepEqual(alertsMgr.__callsTo('SetEnabled')[0].args, [1, true]);

  alertsMgr.__calls.length = 0;
  await Handler(null, 1, 0);
  assert.deepEqual(alertsMgr.__callsTo('SetEnabled')[0].args, [1, false]);

  alertsMgr.__calls.length = 0;
  await Handler(null, 1, undefined);
  assert.deepEqual(alertsMgr.__callsTo('SetEnabled')[0].args, [1, false]);
});

test('SetAlertRuleEnabled rejects an invalid rule id', async () => {
  const [Err] = await GetHandler('SetAlertRuleEnabled')(null, 0, true);
  assert.equal(typeof Err, 'string');
  assert.equal(alertsMgr.__callsTo('SetEnabled').length, 0);
});

// --- Global alert-actions kill switch --------------------------------------

test('AlertActionsEnabled:Get reports the current state', async () => {
  assert.equal(await GetHandler('AlertActionsEnabled:Get')(null), true);
  state.actionsEnabled = false;
  assert.equal(await GetHandler('AlertActionsEnabled:Get')(null), false);
});

test('AlertActionsEnabled:Set coerces anything the renderer sends to a boolean', async () => {
  // This is the mid-show kill switch. A truthy string reaching the manager as
  // a string could be persisted and later read back as "on" when the operator
  // meant "off", so the coercion is the whole point.
  const Handler = GetHandler('AlertActionsEnabled:Set');

  assert.equal(await Handler(null, true), true);
  assert.equal(await Handler(null, 'false'), true); // non-empty string is truthy
  assert.equal(await Handler(null, 1), true);
  assert.equal(await Handler(null, false), false);
  assert.equal(await Handler(null, 0), false);
  assert.equal(await Handler(null, ''), false);
  assert.equal(await Handler(null, null), false);
  assert.equal(await Handler(null, undefined), false);

  for (const Call of alertsMgr.__callsTo('SetActionsEnabled')) {
    assert.equal(typeof Call.args[0], 'boolean', 'the manager must never see a non-boolean');
  }
});
