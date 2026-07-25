const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/registrars/clients.ts — everything except the
// CreateUnassignedClients gate, which has its own file
// (main-registrar-unassigned-clients.test.js).
//
// Real IPCValidation, real RPC wrapper, real createTupleHandler; only the
// managers and Electron are stubbed.
//
// The four handlers with real logic here each carry consequence:
//   - WakeOnLan decides which machines get a magic packet and, just as
//     importantly, which get a visible task in the queue. Queueing a task for a
//     machine that will never be woken leaves a permanently-pending row in the
//     operator's face mid-show.
//   - AdoptDevice / ReplaceClient hand a physical machine over to this server.
//     ReplaceClient in particular rewrites an existing client's identity, so its
//     guards are the only thing standing between "swap the dead PC for the
//     spare" and "silently point an in-use client at the wrong machine".
//   - UnadoptClient tells the machine to let go BEFORE deleting the row, and the
//     ordering is what stops an orphaned client that still thinks it is adopted.

const state = {
  clients: new Map(),
  clientGetErr: null,
  createErr: null,
  deleteErr: null,
  replaceErr: null,
  pendingAdoption: [],
  wakeFailures: new Set(),
  requestIDs: null,
  requestIDCounter: 0,
};

/** A client as ClientManager.Get resolves it. */
function client({ UUID, Online = false, Macs = ['AA:BB:CC:DD:EE:FF'] } = {}) {
  return {
    UUID,
    Online,
    GetWakeableMacAddresses: () => Macs,
  };
}

const clientMgr = recordingManager({
  Get: (UUID) => {
    if (state.clientGetErr) return [state.clientGetErr, null];
    const Found = state.clients.get(UUID);
    return Found ? [null, Found] : [null, null];
  },
  Create: () => [state.createErr],
  Delete: () => [state.deleteErr],
  ReplaceClient: () => [state.replaceErr],
  Update: () => [null, true],
  MarkUSBDeviceCritical: () => [null, true],
  RemoveUSBDeviceCritical: () => [null, true],
  MarkUSBNameCritical: () => [null, true],
  RemoveUSBNameCritical: () => [null, true],
  MarkApplicationCritical: () => [null, true],
  RemoveApplicationCritical: () => [null, true],
  MarkDisplayCritical: () => [null, true],
  RemoveDisplayCritical: () => [null, true],
  AddMacAddress: () => [null, true],
  RemoveMacAddress: () => [null, true],
});

const adoptionMgr = recordingManager({
  GetClientsPendingAdoption: () => state.pendingAdoption,
  SetState: async () => {},
});
const serverMgr = recordingManager({ SendMessageByGroup: async () => {} });
const alertsMgr = recordingManager({ Reload: async () => {} });
const identifyMgr = recordingManager({ Identify: () => [null, true], Stop: () => [null, true] });
const wolMgr = recordingManager({
  Wake: (Mac) => (state.wakeFailures.has(Mac) ? [`no route to ${Mac}`] : [null]),
});
const execMgr = recordingManager({
  ClearQueue: async () => {},
  AddInternalTaskToQueue: async () => {
    if (state.requestIDs) return state.requestIDs.shift();
    state.requestIDCounter += 1;
    return `req-${state.requestIDCounter}`;
  },
  Complete: async () => {},
});
const settingsMgr = recordingManager({ GetValue: () => false });
const logger = recordingManager();
const electronStub = { ipcMain: { handle() {} } };

const deployments = [];
const listUpdates = [];

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: electronStub },
  { match: matchesModule('electron'), value: electronStub },
  {
    match: matchesModule('/Modules/Logger'),
    value: { CreateLogger: () => logger, configure: () => {} },
  },
  { match: matchesModule('/Modules/ClientManager'), value: { Manager: clientMgr } },
  { match: matchesModule('/Modules/AdoptionManager'), value: { Manager: adoptionMgr } },
  { match: matchesModule('/Modules/Server'), value: { Manager: serverMgr } },
  { match: matchesModule('/Modules/AlertsManager'), value: { Manager: alertsMgr } },
  { match: matchesModule('/Modules/IdentifyManager'), value: { Manager: identifyMgr } },
  { match: matchesModule('/Modules/WOLManager'), value: { Manager: wolMgr } },
  { match: matchesModule('/Modules/ScriptExecutionManager'), value: { Manager: execMgr } },
  { match: matchesModule('/Modules/SettingsManager'), value: { Manager: settingsMgr } },
  {
    match: matchesModule('../broadcast-bridge'),
    value: {
      UpdateFullClientList: async () => {
        listUpdates.push(Date.now());
      },
    },
  },
  {
    match: matchesModule('../deployment'),
    value: {
      TriggerScriptDeployment: async (Targets, Reason) => {
        deployments.push({ Targets, Reason });
      },
    },
  },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/clients');
const { GetHandler } = require('../dist/main/handler-registry');
register();

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const call = (Channel, ...Args) => GetHandler(Channel)({}, ...Args);

test.beforeEach(() => {
  state.clients = new Map();
  state.clientGetErr = null;
  state.createErr = null;
  state.deleteErr = null;
  state.replaceErr = null;
  state.pendingAdoption = [];
  state.wakeFailures = new Set();
  state.requestIDs = null;
  state.requestIDCounter = 0;
  for (const M of [
    clientMgr,
    adoptionMgr,
    serverMgr,
    alertsMgr,
    identifyMgr,
    wolMgr,
    execMgr,
    logger,
  ]) {
    M.__calls.length = 0;
  }
  deployments.length = 0;
  listUpdates.length = 0;
});

// --- Registration -----------------------------------------------------------

test('every client channel is registered', () => {
  for (const Channel of [
    'GetClient',
    'UpdateClient',
    'MarkClientUSBDeviceCritical',
    'RemoveClientUSBDeviceCritical',
    'MarkClientUSBNameCritical',
    'RemoveClientUSBNameCritical',
    'MarkClientApplicationCritical',
    'RemoveClientApplicationCritical',
    'MarkClientDisplayCritical',
    'RemoveClientDisplayCritical',
    'AddClientMacAddress',
    'RemoveClientMacAddress',
    'IdentifyClient',
    'StopIdentifyingClient',
    'AdoptDevice',
    'UnadoptClient',
    'CreateUnassignedClients',
    'ReplaceClient',
    'WakeOnLan',
  ]) {
    assert.equal(typeof GetHandler(Channel), 'function', `${Channel} is not registered`);
  }
});

// --- GetClient --------------------------------------------------------------

test('GetClient returns the client, or null for anything it cannot resolve', async () => {
  // A reader handler, not a tuple handler: the renderer reads the value straight
  // out, so an invalid UUID, a manager error and a genuinely absent client all
  // have to collapse to the same empty answer.
  state.clients.set(UUID_A, client({ UUID: UUID_A }));

  assert.equal((await call('GetClient', UUID_A)).UUID, UUID_A);
  assert.equal(await call('GetClient', UUID_B), null, 'unknown UUID');
  assert.equal(await call('GetClient', ''), null, 'empty UUID');
  assert.equal(await call('GetClient', undefined), null, 'missing UUID');

  state.clientGetErr = 'db is down';
  assert.equal(await call('GetClient', UUID_A), null, 'manager error');
});

test('GetClient never reaches the manager with an unvalidated UUID', async () => {
  await call('GetClient', { evil: true });
  assert.equal(clientMgr.__callsTo('Get').length, 0);
});

// --- Validation across the simple pass-through handlers --------------------

test('a malformed UUID is refused by every per-client handler', async () => {
  // These all take a UUID as their first argument and forward it to a manager
  // that will happily act on whatever it is given, so validation is the boundary.
  //
  // Note what "malformed" means here: IPCValidation.UUID is a non-empty string
  // check (2-128 chars), NOT a UUID-format check — client UUIDs are hardware
  // fingerprints, not RFC 4122 values. So the boundary rejects empty, oversized
  // and non-string identifiers, and nothing narrower.
  const Cases = [
    ['UpdateClient', { Nickname: 'x' }],
    ['MarkClientUSBDeviceCritical', { SerialNumber: 'S1', Name: 'Dongle' }],
    ['RemoveClientUSBDeviceCritical', 'S1'],
    ['MarkClientUSBNameCritical', { Name: 'Dongle' }],
    ['RemoveClientUSBNameCritical', { Name: 'Dongle' }],
    ['MarkClientApplicationCritical', { Name: 'qlab' }],
    ['RemoveClientApplicationCritical', 'qlab'],
    ['MarkClientDisplayCritical', { DisplayID: 'D1' }],
    ['RemoveClientDisplayCritical', 'D1'],
    ['AddClientMacAddress', 'AA:BB:CC:DD:EE:FF'],
    ['RemoveClientMacAddress', 'AA:BB:CC:DD:EE:FF'],
    ['IdentifyClient'],
    ['StopIdentifyingClient'],
  ];

  for (const [Channel, ...Rest] of Cases) {
    clientMgr.__calls.length = 0;
    identifyMgr.__calls.length = 0;
    const [Err] = await call(Channel, '', ...Rest);
    assert.ok(Err, `${Channel} accepted an empty UUID`);
    assert.equal(clientMgr.__calls.length, 0, `${Channel} reached ClientManager anyway`);
    assert.equal(identifyMgr.__calls.length, 0, `${Channel} reached IdentifyManager anyway`);
  }
});

test('a valid call reaches its manager with the validated arguments', async () => {
  await call('AddClientMacAddress', UUID_A, 'aa:bb:cc:dd:ee:ff');
  const [Added] = clientMgr.__callsTo('AddMacAddress');
  assert.equal(Added.args[0], UUID_A);
  assert.deepEqual(Added.args[2], { Source: 'Manual' }, 'a manual MAC must be recorded as manual');

  await call('IdentifyClient', UUID_A);
  assert.deepEqual(identifyMgr.__callsTo('Identify')[0].args, [UUID_A]);

  await call('StopIdentifyingClient', UUID_A);
  assert.deepEqual(identifyMgr.__callsTo('Stop')[0].args, [UUID_A]);
});

test('each critical-entity channel calls its own manager method', async () => {
  // These twelve handlers are near-identical copy-paste blocks, so the realistic
  // failure is a mis-wired pair: "remove" calling the mark method, or the USB
  // serial channel calling the USB name one. That would silently mark a device
  // critical when the operator asked to un-mark it — and a critical entity
  // showing as missing degrades the client.
  const Cases = [
    ['UpdateClient', { Nickname: 'FOH' }, 'Update'],
    [
      'MarkClientUSBDeviceCritical',
      { SerialNumber: 'S1', Name: 'Dongle' },
      'MarkUSBDeviceCritical',
    ],
    ['RemoveClientUSBDeviceCritical', 'S1', 'RemoveUSBDeviceCritical'],
    ['MarkClientUSBNameCritical', { Name: 'Dongle' }, 'MarkUSBNameCritical'],
    ['RemoveClientUSBNameCritical', { Name: 'Dongle' }, 'RemoveUSBNameCritical'],
    ['MarkClientApplicationCritical', { Name: 'qlab' }, 'MarkApplicationCritical'],
    ['RemoveClientApplicationCritical', 'qlab', 'RemoveApplicationCritical'],
    ['MarkClientDisplayCritical', { DisplayID: 'D1', Name: 'Main' }, 'MarkDisplayCritical'],
    ['RemoveClientDisplayCritical', 'D1', 'RemoveDisplayCritical'],
    ['RemoveClientMacAddress', 'aa:bb:cc:dd:ee:ff', 'RemoveMacAddress'],
  ];

  for (const [Channel, Arg, Method] of Cases) {
    clientMgr.__calls.length = 0;
    const [Err, Result] = await call(Channel, UUID_A, Arg);

    assert.equal(Err, null, `${Channel}: ${Err}`);
    assert.equal(Result, true);
    assert.deepEqual(
      clientMgr.__calls.map((C) => C.method),
      [Method],
      `${Channel} called the wrong manager method`
    );
    assert.equal(clientMgr.__calls[0].args[0], UUID_A);
  }
});

test('a malformed MAC address is refused', async () => {
  for (const Mac of ['', 'ZZ:ZZ:ZZ:ZZ:ZZ:ZZ', 'aa:bb:cc', 42, null]) {
    clientMgr.__calls.length = 0;
    const [Err] = await call('AddClientMacAddress', UUID_A, Mac);
    assert.ok(Err, `MAC ${JSON.stringify(Mac)} was accepted`);
    assert.equal(clientMgr.__calls.length, 0);
  }
});

// --- AdoptDevice ------------------------------------------------------------

test('adopting runs create, state, message and deployment in order', async () => {
  const [Err, Result] = await call('AdoptDevice', UUID_A);

  assert.equal(Err, null);
  assert.equal(Result, true);
  assert.deepEqual(clientMgr.__callsTo('Create')[0].args, [UUID_A]);
  assert.deepEqual(adoptionMgr.__callsTo('SetState')[0].args, [UUID_A, 'Adopting']);
  assert.deepEqual(serverMgr.__callsTo('SendMessageByGroup')[0].args, [UUID_A, 'Adopt']);
  assert.deepEqual(deployments, [{ Targets: [UUID_A], Reason: 'client-adopted' }]);
});

test('re-adopting an existing client is not an error', async () => {
  // Re-adoption is a normal recovery action — a client that lost its profile
  // reappears as pending while its row still exists. Treating the duplicate as a
  // failure would leave it stuck in that state.
  state.createErr = 'Client already exists';

  const [Err, Result] = await call('AdoptDevice', UUID_A);

  assert.equal(Err, null);
  assert.equal(Result, true);
  assert.equal(
    serverMgr.__callsTo('SendMessageByGroup').length,
    1,
    'the Adopt message was skipped'
  );
});

test('a real create failure stops the adoption before anything is told to adopt', async () => {
  state.createErr = 'disk is full';

  const [Err, Result] = await call('AdoptDevice', UUID_A);

  assert.equal(Err, 'disk is full');
  assert.equal(Result, null);
  assert.equal(adoptionMgr.__callsTo('SetState').length, 0);
  assert.equal(serverMgr.__callsTo('SendMessageByGroup').length, 0);
  assert.deepEqual(deployments, [], 'scripts were deployed to a client that was never created');
});

test('AdoptDevice pairs an invalid UUID with false, matching its siblings', async () => {
  const [Err, Result] = await call('AdoptDevice', '');
  assert.ok(Err);
  assert.equal(Result, false);
  assert.equal(clientMgr.__callsTo('Create').length, 0);
});

// --- UnadoptClient ----------------------------------------------------------

test('unadopting tells the client to let go BEFORE deleting its row', async () => {
  // Order matters: deleting first would leave a machine that still believes it
  // is adopted, reconnecting to a server that no longer knows it — an orphan
  // that has to be found and reset by hand.
  const [Err, Result] = await call('UnadoptClient', UUID_A);

  assert.equal(Err, null);
  assert.equal(Result, true);
  assert.deepEqual(serverMgr.__callsTo('SendMessageByGroup')[0].args, [UUID_A, 'Unadopt']);
  assert.equal(clientMgr.__callsTo('Delete').length, 1);
  assert.equal(listUpdates.length, 1, 'the renderer was not told the client is gone');
});

test('a failed delete does not claim the client was unadopted', async () => {
  state.deleteErr = 'row is locked';

  const [Err, Result] = await call('UnadoptClient', UUID_A);

  assert.equal(Err, 'row is locked');
  assert.equal(Result, null);
  assert.equal(listUpdates.length, 0, 'the client list was refreshed after a failed delete');
});

test('UnadoptClient refuses a malformed UUID without messaging anyone', async () => {
  const [Err, Result] = await call('UnadoptClient', '');
  assert.ok(Err);
  assert.equal(Result, false);
  assert.equal(serverMgr.__calls.length, 0);
});

// --- ReplaceClient ----------------------------------------------------------

test('replacing swaps identity, reloads alerts and adopts the replacement', async () => {
  state.pendingAdoption = [{ UUID: UUID_B }];

  const [Err, Result] = await call('ReplaceClient', UUID_A, UUID_B);

  assert.equal(Err, null);
  assert.equal(Result, true);
  assert.deepEqual(clientMgr.__callsTo('ReplaceClient')[0].args, [UUID_A, UUID_B]);
  // Alert rules are bound to the client, so they have to be re-read against the
  // new identity or they keep watching the machine that was just retired.
  assert.equal(alertsMgr.__callsTo('Reload').length, 1);
  assert.deepEqual(adoptionMgr.__callsTo('SetState')[0].args, [UUID_B, 'Adopting']);
  assert.deepEqual(serverMgr.__callsTo('SendMessageByGroup')[0].args, [UUID_B, 'Adopt']);
  assert.deepEqual(deployments, [{ Targets: [UUID_B], Reason: 'client-replaced' }]);
});

test('a client cannot be replaced by itself', async () => {
  state.pendingAdoption = [{ UUID: UUID_A }];

  const [Err, Result] = await call('ReplaceClient', UUID_A, UUID_A);

  assert.match(Err, /must be different/);
  assert.equal(Result, null);
  assert.equal(clientMgr.__callsTo('ReplaceClient').length, 0);
});

test('the replacement must still be pending adoption', async () => {
  // The guard against replacing with a machine that is already an adopted
  // client — that would give two client rows the same identity.
  for (const Pending of [[], [{ UUID: UUID_A }], null, undefined, 'not an array']) {
    clientMgr.__calls.length = 0;
    state.pendingAdoption = Pending;

    const [Err, Result] = await call('ReplaceClient', UUID_A, UUID_B);

    assert.match(Err, /no longer pending adoption/, `pending: ${JSON.stringify(Pending)}`);
    assert.equal(Result, null);
    assert.equal(clientMgr.__callsTo('ReplaceClient').length, 0);
  }
});

test('a pending entry with no UUID never matches', async () => {
  state.pendingAdoption = [null, {}, { UUID: null }];
  const [Err] = await call('ReplaceClient', UUID_A, UUID_B);
  assert.match(Err, /no longer pending adoption/);
});

test('a failed replace does not adopt the replacement anyway', async () => {
  // The dangerous half-state: the replacement gets told to adopt while the
  // client row still points at the old machine.
  state.pendingAdoption = [{ UUID: UUID_B }];
  state.replaceErr = 'constraint failed';

  const [Err, Result] = await call('ReplaceClient', UUID_A, UUID_B);

  assert.equal(Err, 'constraint failed');
  assert.equal(Result, null);
  assert.equal(alertsMgr.__callsTo('Reload').length, 0);
  assert.equal(serverMgr.__calls.length, 0);
  assert.deepEqual(deployments, []);
});

test('both UUIDs are validated, and the error names which one failed', async () => {
  state.pendingAdoption = [{ UUID: UUID_B }];

  const [ErrA, ResultA] = await call('ReplaceClient', '', UUID_B);
  assert.match(String(ErrA), /CurrentUUID/);
  assert.equal(ResultA, false);

  const [ErrB] = await call('ReplaceClient', UUID_A, '');
  assert.match(String(ErrB), /ReplacementUUID/);

  assert.equal(clientMgr.__callsTo('ReplaceClient').length, 0);
});

// --- WakeOnLan --------------------------------------------------------------

test('a wake sends a packet to every known MAC of an offline client', async () => {
  // A machine with several NICs can only be reached through whichever one the
  // server shares a network with, and the server cannot know which — so all of
  // them get a packet.
  state.clients.set(UUID_A, client({ UUID: UUID_A, Macs: ['AA:AA', 'BB:BB', 'CC:CC'] }));

  const [Err, Result] = await call('WakeOnLan', [UUID_A]);

  assert.equal(Err, null);
  assert.equal(Result, true);
  assert.deepEqual(
    wolMgr.__callsTo('Wake').map((C) => C.args[0]),
    ['AA:AA', 'BB:BB', 'CC:CC']
  );
  assert.equal(execMgr.__callsTo('ClearQueue').length, 1);
  assert.deepEqual(execMgr.__callsTo('Complete')[0].args, ['req-1', null]);
});

test('an already-online client is skipped silently, with no task queued', async () => {
  // The point of the pre-check: a queued task the operator can see, for a
  // machine that was never going to be woken, is noise mid-show.
  state.clients.set(UUID_A, client({ UUID: UUID_A, Online: true }));

  await call('WakeOnLan', [UUID_A]);

  assert.equal(wolMgr.__callsTo('Wake').length, 0);
  assert.equal(execMgr.__callsTo('AddInternalTaskToQueue').length, 0);
});

test('a client with no MAC on record is skipped silently', async () => {
  state.clients.set(UUID_A, client({ UUID: UUID_A, Macs: [] }));

  await call('WakeOnLan', [UUID_A]);

  assert.equal(wolMgr.__callsTo('Wake').length, 0);
  assert.equal(execMgr.__callsTo('AddInternalTaskToQueue').length, 0);
});

test('a client that vanished between validation and the wake is skipped', async () => {
  await call('WakeOnLan', [UUID_A]); // never added to the map
  assert.equal(execMgr.__callsTo('AddInternalTaskToQueue').length, 0);

  state.clientGetErr = 'db is down';
  state.clients.set(UUID_A, client({ UUID: UUID_A }));
  await call('WakeOnLan', [UUID_A]);
  assert.equal(execMgr.__callsTo('AddInternalTaskToQueue').length, 0);
});

test('a task that could not be queued is not completed', async () => {
  // Completing a RequestID that was never created would either throw or mark an
  // unrelated task done.
  state.clients.set(UUID_A, client({ UUID: UUID_A }));
  state.requestIDs = [null];

  await call('WakeOnLan', [UUID_A]);

  assert.equal(wolMgr.__callsTo('Wake').length, 0, 'packets were sent for an unqueued task');
  assert.equal(execMgr.__callsTo('Complete').length, 0);
});

test('a partial failure across NICs is treated as a success', async () => {
  // A retired NIC's MAC failing is expected. If any address got a packet out the
  // machine has been woken as well as we can manage, and reporting an error
  // would train the operator to ignore the notification.
  state.clients.set(UUID_A, client({ UUID: UUID_A, Macs: ['AA:AA', 'BB:BB'] }));
  state.wakeFailures = new Set(['AA:AA']);

  await call('WakeOnLan', [UUID_A]);

  assert.deepEqual(execMgr.__callsTo('Complete')[0].args, ['req-1', null]);
});

test('a total failure IS reported, naming every address that failed', async () => {
  state.clients.set(UUID_A, client({ UUID: UUID_A, Macs: ['AA:AA', 'BB:BB'] }));
  state.wakeFailures = new Set(['AA:AA', 'BB:BB']);

  await call('WakeOnLan', [UUID_A]);

  const [, Reported] = execMgr.__callsTo('Complete')[0].args;
  assert.match(Reported, /AA:AA: no route/);
  assert.match(Reported, /BB:BB: no route/);
});

test('a mixed target list wakes only the eligible clients', async () => {
  state.clients.set(UUID_A, client({ UUID: UUID_A, Macs: ['AA:AA'] }));
  state.clients.set(UUID_B, client({ UUID: UUID_B, Online: true }));

  await call('WakeOnLan', [UUID_A, UUID_B]);

  assert.deepEqual(
    wolMgr.__callsTo('Wake').map((C) => C.args[0]),
    ['AA:AA']
  );
  assert.equal(execMgr.__callsTo('AddInternalTaskToQueue').length, 1);
});

test('the queue is cleared before waking, so stale tasks do not mask the new ones', async () => {
  state.clients.set(UUID_A, client({ UUID: UUID_A }));
  await call('WakeOnLan', [UUID_A]);

  const First = execMgr.__calls.findIndex((C) => C.method === 'ClearQueue');
  const Queued = execMgr.__calls.findIndex((C) => C.method === 'AddInternalTaskToQueue');
  assert.ok(First >= 0 && First < Queued);
});

test('an invalid target list is refused before the queue is touched', async () => {
  for (const List of ['not a list', [123], [{}], [''], [UUID_A, '']]) {
    execMgr.__calls.length = 0;
    const [Err, Result] = await call('WakeOnLan', List);
    assert.ok(Err, `${JSON.stringify(List)} was accepted`);
    assert.equal(Result, null);
    assert.equal(execMgr.__calls.length, 0, 'the queue was cleared for an invalid request');
  }
});

test('an empty target list is rejected rather than clearing the queue for nothing', async () => {
  // `List || []` normalizes null/undefined to an empty array, which UUIDList
  // then refuses. Worth pinning: the alternative — treating empty as a silent
  // success — would still have run ClearQueue, wiping in-flight script tasks in
  // response to a request that was going to wake nothing.
  for (const List of [[], null, undefined]) {
    execMgr.__calls.length = 0;
    const [Err, Result] = await call('WakeOnLan', List);
    assert.match(String(Err), /cannot be empty/, `${JSON.stringify(List)} was accepted`);
    assert.equal(Result, null);
    assert.equal(execMgr.__calls.length, 0, 'the queue was cleared for an empty request');
  }
});

test('one client failing to wake does not abandon the rest', async () => {
  // The wakes run concurrently under Promise.allSettled; a throw from one must
  // not leave the others unprocessed.
  const Exploding = client({ UUID: UUID_B });
  Exploding.GetWakeableMacAddresses = () => {
    throw new Error('client state is corrupt');
  };
  state.clients.set(UUID_A, client({ UUID: UUID_A, Macs: ['AA:AA'] }));
  state.clients.set(UUID_B, Exploding);

  const [Err, Result] = await call('WakeOnLan', [UUID_B, UUID_A]);

  assert.equal(Err, null);
  assert.equal(Result, true);
  assert.deepEqual(
    wolMgr.__callsTo('Wake').map((C) => C.args[0]),
    ['AA:AA']
  );
});
