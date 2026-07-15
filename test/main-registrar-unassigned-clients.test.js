const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises the CreateUnassignedClients channel through the REAL rpc wrapper,
// REAL IPCValidation and REAL createTupleHandler, stubbing only the sqlite-backed
// managers and Electron.
//
// The setting gate is the point of these tests: the renderer hides the entry
// point when SYSTEM_ALLOW_UNASSIGNED_CLIENTS is off, but this handler is the only
// authority, so it must refuse on its own — including when the setting cannot be
// read at all.

const state = {
  allowed: false,
  createResult: null,
  settingThrows: false,
};

const clientMgr = recordingManager({
  CreateUnassigned: (Name, Count) =>
    state.createResult ?? [
      null,
      Array.from({ length: Count }, (_, i) => ({
        UUID: `uuid-${i}`,
        Nickname: `${Name} ${i + 1}`,
      })),
    ],
});

const settingsMgr = recordingManager({
  GetValue: (key) => {
    if (state.settingThrows) throw new Error('db exploded');
    return key === 'SYSTEM_ALLOW_UNASSIGNED_CLIENTS' ? state.allowed : null;
  },
});

const inertMgr = recordingManager({ GetClientsPendingAdoption: () => [] });
const electronStub = { ipcMain: { handle() {} } };

// The fails-closed test drives a throw through the registrar's real catch block,
// which logs it. Against the real logger that prints an ERROR and a stack trace
// partway through the run, which reads like the suite crashing. Capturing it
// keeps the output clean and turns the log into something we can assert on.
const logger = recordingManager();

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: electronStub },
  { match: matchesModule('electron'), value: electronStub },
  {
    match: matchesModule('/Modules/Logger'),
    value: { CreateLogger: () => logger, configure: () => {} },
  },
  { match: matchesModule('/Modules/ClientManager'), value: { Manager: clientMgr } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settingsMgr } },
  { match: matchesModule('/Modules/AdoptionManager'), value: { Manager: inertMgr } },
  { match: matchesModule('/Modules/Server'), value: { Manager: inertMgr } },
  { match: matchesModule('/Modules/AlertsManager'), value: { Manager: inertMgr } },
  { match: matchesModule('/Modules/IdentifyManager'), value: { Manager: inertMgr } },
  { match: matchesModule('/Modules/WOLManager'), value: { Manager: inertMgr } },
  { match: matchesModule('/Modules/ScriptExecutionManager'), value: { Manager: inertMgr } },
  { match: matchesModule('../broadcast-bridge'), value: { UpdateFullClientList: async () => {} } },
  { match: matchesModule('../deployment'), value: { TriggerScriptDeployment: async () => {} } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/clients');
const { GetHandler } = require('../dist/main/handler-registry');
register();

function resetState() {
  state.allowed = true;
  state.createResult = null;
  state.settingThrows = false;
  clientMgr.__calls.length = 0;
  logger.__calls.length = 0;
}

test('registers the CreateUnassignedClients channel', () => {
  assert.equal(typeof GetHandler('CreateUnassignedClients'), 'function');
});

test('refuses to create slots while the setting is disabled', async () => {
  resetState();
  state.allowed = false;

  const [Err, Result] = await GetHandler('CreateUnassignedClients')({}, { Name: 'Rig', Count: 2 });

  assert.equal(Err, 'Unassigned clients are disabled');
  assert.equal(Result, null);
  // The payload was valid, so only the gate can have stopped it.
  assert.equal(clientMgr.__callsTo('CreateUnassigned').length, 0);
});

test('creates slots and reports the count once the setting is enabled', async () => {
  resetState();

  const [Err, Created] = await GetHandler('CreateUnassignedClients')({}, { Name: 'Rig', Count: 3 });

  assert.equal(Err, null);
  assert.equal(Created, 3);
  assert.deepEqual(clientMgr.__callsTo('CreateUnassigned')[0].args, ['Rig', 3]);
});

test('fails closed when the setting cannot be read', async () => {
  resetState();
  state.settingThrows = true;

  const [Err, Result] = await GetHandler('CreateUnassignedClients')({}, { Name: 'Rig', Count: 1 });

  assert.equal(Err, 'Unable to verify that unassigned clients are enabled');
  assert.equal(Result, null);
  assert.equal(clientMgr.__callsTo('CreateUnassigned').length, 0);
  // Failing closed silently would leave an operator with no idea why slots
  // stopped being created, so the cause has to reach the log.
  const [logged] = logger.__callsTo('error');
  assert.equal(logged.args[0], 'Failed to read unassigned client setting');
  assert.match(String(logged.args[1]), /db exploded/);
});

test('surfaces a manager failure rather than reporting success', async () => {
  resetState();
  state.createResult = ['Failed to create unassigned clients', null];

  const [Err, Result] = await GetHandler('CreateUnassignedClients')({}, { Name: 'Rig', Count: 1 });

  assert.equal(Err, 'Failed to create unassigned clients');
  assert.equal(Result, null);
});

test('rejects invalid payloads before consulting the manager', async () => {
  const handler = GetHandler('CreateUnassignedClients');

  const cases = [
    ['count below one', { Name: 'Rig', Count: 0 }],
    ['non-integer count', { Name: 'Rig', Count: 2.5 }],
    ['count over the per-request cap', { Name: 'Rig', Count: 999 }],
    ['blank name', { Name: '   ', Count: 1 }],
    ['name over 64 chars', { Name: 'x'.repeat(65), Count: 1 }],
    ['missing payload', undefined],
    ['non-object payload', 'nope'],
  ];

  for (const [label, payload] of cases) {
    resetState();
    const [Err, Result] = await handler({}, payload);
    assert.ok(Err, `${label} should be rejected`);
    assert.equal(Result, null, `${label} should not return a result`);
    assert.equal(
      clientMgr.__callsTo('CreateUnassigned').length,
      0,
      `${label} should not reach the manager`
    );
  }
});
