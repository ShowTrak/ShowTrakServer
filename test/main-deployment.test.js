const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises src/main/deployment.ts — the script-deployment state machine.
//
// Deployments are triggered from several directions at once (catalog change,
// client-online transition, adoption, manual request), so the whole point of
// this module is that overlapping triggers COALESCE rather than stampede the
// execution queue. The states worth pinning:
//
//   - a fresh deployment resets the queue (resetQueue: true);
//   - a second trigger for the SAME fingerprint dispatches only the targets not
//     already in flight, and does NOT reset the queue — resetting would wipe the
//     deployment already running;
//   - a duplicate trigger with no new targets is dropped entirely;
//   - a trigger with a DIFFERENT fingerprint is queued until the current session
//     drains, then flushed exactly once.
//
// Also pinned: integrated clients never receive script deployments (they run
// event actions instead), offline and up-to-date clients are filtered out, and
// an invalid Script.json fails the targets loudly instead of deploying garbage.
//
// The module keeps its session state in module-level `let`s, so every test
// re-requires it from a cleared cache.

const logs = { warns: [], errors: [] };

const state = {
  serverFingerprint: 'fp-server',
  clients: new Map(),
  allClients: [null, []],
  scripts: [{ ID: 'a', isValid: true }],
  addTaskId: 1,
  clientGetThrows: false,
};

/** Register a client the deployment resolver will see. */
function client(UUID, { Online = true, ScriptsFingerprint = 'fp-old', Integrated = false } = {}) {
  state.clients.set(UUID, { UUID, Online, ScriptsFingerprint, Integrated });
  return UUID;
}

const scriptMgr = recordingManager({
  GetDeploymentFingerprint: () => state.serverFingerprint,
  GetScripts: () => state.scripts,
});
const clientMgr = recordingManager({
  GetAll: () => state.allClients,
  Get: (UUID) => {
    if (state.clientGetThrows) throw new Error('db exploded');
    return state.clients.has(UUID) ? [null, state.clients.get(UUID)] : ['not found', null];
  },
});
const serverMgr = recordingManager({ ExecuteBulkRequest: async () => undefined });
const execMgr = recordingManager({
  ClearQueue: async () => undefined,
  AddInternalTaskToQueue: async () => `req-${state.addTaskId++}`,
  Complete: async () => undefined,
});

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: (...args) => logs.warns.push(args),
    error: (...args) => logs.errors.push(args),
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: {} },
  { match: matchesModule('/Modules/Logger'), value: loggerStub },
  {
    match: matchesModule('/Modules/Config/constants'),
    value: { SCRIPT_DEPLOY_DEBOUNCE_MS: 2000 },
  },
  { match: matchesModule('/Modules/ScriptManager'), value: { Manager: scriptMgr } },
  { match: matchesModule('/Modules/ClientManager'), value: { Manager: clientMgr } },
  { match: matchesModule('/Modules/Server'), value: { Manager: serverMgr } },
  { match: matchesModule('/Modules/ScriptExecutionManager'), value: { Manager: execMgr } },
]);
test.after(() => restore());

/** Re-require deployment.ts so its in-flight session state starts empty. */
function freshDeployment() {
  state.serverFingerprint = 'fp-server';
  state.clients = new Map();
  state.allClients = [null, []];
  state.scripts = [{ ID: 'a', isValid: true }];
  state.addTaskId = 1;
  state.clientGetThrows = false;
  logs.warns.length = 0;
  logs.errors.length = 0;
  for (const M of [scriptMgr, clientMgr, serverMgr, execMgr]) M.__calls.length = 0;

  const Resolved = require.resolve('../dist/main/deployment');
  delete require.cache[Resolved];
  return require(Resolved);
}

/** The [command, targets, label, options] of each dispatched bulk request. */
const dispatches = () => serverMgr.__callsTo('ExecuteBulkRequest').map((C) => C.args);

// --- Target resolution ------------------------------------------------------

test('a deployment dispatches only out-of-date online clients', async () => {
  const D = freshDeployment();
  client('online-stale', { Online: true, ScriptsFingerprint: 'fp-old' });
  client('online-current', { Online: true, ScriptsFingerprint: 'fp-server' });
  client('offline-stale', { Online: false, ScriptsFingerprint: 'fp-old' });

  await D.TriggerScriptDeployment(['online-stale', 'online-current', 'offline-stale']);

  assert.equal(dispatches().length, 1);
  assert.deepEqual(dispatches()[0][1], ['online-stale']);
});

test('a client that has never reported a fingerprint counts as out of date', async () => {
  const D = freshDeployment();
  client('never-deployed', { ScriptsFingerprint: '' });
  client('whitespace-only', { ScriptsFingerprint: '   ' });

  await D.TriggerScriptDeployment(['never-deployed', 'whitespace-only']);
  assert.deepEqual(dispatches()[0][1].sort(), ['never-deployed', 'whitespace-only']);
});

test('integrated clients never receive a script deployment', async () => {
  // Integrated (SDK) entities execute event actions; a script-catalog task would
  // sit in their queue forever.
  const D = freshDeployment();
  client('sdk-flag', { Integrated: true });
  client('sdk-os', { Integrated: false });
  state.clients.get('sdk-os').OperatingSystem = 'Integrated';
  client('real-pc');

  await D.TriggerScriptDeployment(['sdk-flag', 'sdk-os', 'real-pc']);
  assert.deepEqual(dispatches()[0][1], ['real-pc']);
});

test('a deployment is skipped entirely when nothing is out of date', async () => {
  const D = freshDeployment();
  client('current', { ScriptsFingerprint: 'fp-server' });
  await D.TriggerScriptDeployment(['current']);
  assert.deepEqual(dispatches(), []);
});

test('unknown and malformed target UUIDs are dropped', async () => {
  const D = freshDeployment();
  client('real-pc');
  await D.TriggerScriptDeployment(['real-pc', 'ghost', '', '   ', null, 42, undefined]);
  assert.deepEqual(dispatches()[0][1], ['real-pc']);
});

test('duplicate target UUIDs are collapsed before dispatch', async () => {
  const D = freshDeployment();
  client('real-pc');
  await D.TriggerScriptDeployment(['real-pc', 'real-pc', 'real-pc']);
  assert.deepEqual(dispatches()[0][1], ['real-pc']);
});

test('an empty or non-array target list is a no-op', async () => {
  const D = freshDeployment();
  for (const Empty of [[], null, undefined, 'real-pc', {}]) {
    await D.TriggerScriptDeployment(Empty);
  }
  assert.deepEqual(dispatches(), []);
  // Not even the fingerprint is read — it bails on the empty list first.
  assert.equal(scriptMgr.__callsTo('GetDeploymentFingerprint').length, 0);
});

// --- Invalid script catalog -------------------------------------------------

test('an invalid Script.json fails the targets instead of deploying', async () => {
  // Deploying a catalog that will not parse leaves every client broken; better
  // to surface the parse error against each target.
  const D = freshDeployment();
  client('real-pc');
  state.scripts = [
    { ID: 'good', isValid: true },
    { ID: 'broken', isValid: false, ParseError: 'unexpected token' },
  ];

  await D.TriggerScriptDeployment(['real-pc']);

  assert.deepEqual(dispatches(), [], 'nothing should be deployed');
  assert.equal(execMgr.__callsTo('ClearQueue').length, 1);
  assert.equal(execMgr.__callsTo('AddInternalTaskToQueue').length, 1);

  const [, Message] = execMgr.__callsTo('Complete')[0].args;
  assert.match(Message, /Invalid command JSON/);
  assert.match(Message, /broken \(unexpected token\)/);
  assert.equal(logs.warns.length, 1);
});

test('an invalid script with no parse error still names the script', async () => {
  const D = freshDeployment();
  client('real-pc');
  state.scripts = [{ ID: 'broken', isValid: false }];

  await D.TriggerScriptDeployment(['real-pc']);
  const [, Message] = execMgr.__callsTo('Complete')[0].args;
  assert.match(Message, /broken/);
  assert.doesNotMatch(Message, /undefined/);
});

test('a null entry in the catalog is treated as invalid', async () => {
  const D = freshDeployment();
  client('real-pc');
  state.scripts = [null];

  await D.TriggerScriptDeployment(['real-pc']);
  assert.deepEqual(dispatches(), []);
  const [, Message] = execMgr.__callsTo('Complete')[0].args;
  assert.match(Message, /Unknown Script/);
});

test('a null catalog is treated as empty and valid', async () => {
  const D = freshDeployment();
  client('real-pc');
  state.scripts = null;

  await D.TriggerScriptDeployment(['real-pc']);
  assert.equal(dispatches().length, 1);
});

// --- The in-flight coalescing state machine ---------------------------------

test('a fresh deployment resets the execution queue', async () => {
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);

  const [Command, Targets, Label, Options] = dispatches()[0];
  assert.equal(Command, 'UpdateScripts');
  assert.deepEqual(Targets, ['pc-1']);
  assert.equal(Label, 'Deploying Scripts');
  assert.deepEqual(Options, { resetQueue: true });
});

test('a same-fingerprint retrigger dispatches only the NEW targets, without resetting', async () => {
  // Resetting here would wipe the deployment already in flight for pc-1.
  const D = freshDeployment();
  client('pc-1');
  client('pc-2');

  await D.TriggerScriptDeployment(['pc-1']);
  await D.TriggerScriptDeployment(['pc-1', 'pc-2']);

  assert.equal(dispatches().length, 2);
  assert.deepEqual(dispatches()[1][1], ['pc-2'], 'pc-1 was already in flight');
  assert.deepEqual(dispatches()[1][3], { resetQueue: false });
});

test('a duplicate trigger with no new targets is dropped', async () => {
  const D = freshDeployment();
  client('pc-1');

  await D.TriggerScriptDeployment(['pc-1']);
  await D.TriggerScriptDeployment(['pc-1']);
  await D.TriggerScriptDeployment(['pc-1']);

  assert.equal(dispatches().length, 1);
});

test('a different-fingerprint trigger is queued instead of dispatched', async () => {
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);
  assert.equal(dispatches().length, 1);

  // The catalog changed mid-deployment.
  state.serverFingerprint = 'fp-server-v2';
  client('pc-2');
  await D.TriggerScriptDeployment(['pc-2']);

  assert.equal(dispatches().length, 1, 'the new fingerprint must wait for the current session');
});

// --- Draining the session ---------------------------------------------------

test('the session clears once no Deploying Scripts task is pending', async () => {
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);

  // Still pending: the session stays in flight, so a retrigger is suppressed.
  D.ReconcileDeploymentQueueAfterExecutions([
    { Script: { Name: 'Deploying Scripts' }, Status: 'Pending' },
  ]);
  await D.TriggerScriptDeployment(['pc-1']);
  assert.equal(dispatches().length, 1);

  // Completed: the session clears, so the same target can deploy again.
  D.ReconcileDeploymentQueueAfterExecutions([
    { Script: { Name: 'Deploying Scripts' }, Status: 'Completed' },
  ]);
  await D.TriggerScriptDeployment(['pc-1']);
  assert.equal(dispatches().length, 2);
  assert.deepEqual(dispatches()[1][3], { resetQueue: true }, 'a new session resets again');
});

test('unrelated pending executions do not hold the session open', async () => {
  // Only 'Deploying Scripts' tasks count; a long-running user script must not
  // block the next deployment forever.
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);

  D.ReconcileDeploymentQueueAfterExecutions([{ Script: { Name: 'Reboot' }, Status: 'Pending' }]);
  await D.TriggerScriptDeployment(['pc-1']);
  assert.equal(dispatches().length, 2);
});

test('an empty or missing execution list clears the session', async () => {
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);

  D.ReconcileDeploymentQueueAfterExecutions(null);
  await D.TriggerScriptDeployment(['pc-1']);
  assert.equal(dispatches().length, 2);
});

test('a queued deployment is flushed exactly once when the session drains', async () => {
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);

  state.serverFingerprint = 'fp-server-v2';
  client('pc-2');
  await D.TriggerScriptDeployment(['pc-2']);
  assert.equal(dispatches().length, 1);

  D.ReconcileDeploymentQueueAfterExecutions([]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dispatches().length, 2, 'the queued deployment should flush');
  assert.deepEqual(dispatches()[1][1], ['pc-2']);

  // Draining again must not re-flush an already-emptied queue.
  D.ReconcileDeploymentQueueAfterExecutions([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatches().length, 2);
});

test('multiple queued triggers coalesce into one flush', async () => {
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);

  state.serverFingerprint = 'fp-server-v2';
  client('pc-2');
  client('pc-3');
  await D.TriggerScriptDeployment(['pc-2']);
  await D.TriggerScriptDeployment(['pc-3']);
  await D.TriggerScriptDeployment(['pc-2']); // duplicate
  assert.equal(dispatches().length, 1);

  D.ReconcileDeploymentQueueAfterExecutions([]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dispatches().length, 2, 'three queued triggers should flush as one dispatch');
  assert.deepEqual(dispatches()[1][1].sort(), ['pc-2', 'pc-3']);
});

test('a failing queued flush is caught and logged', async () => {
  const D = freshDeployment();
  client('pc-1');
  await D.TriggerScriptDeployment(['pc-1']);

  state.serverFingerprint = 'fp-server-v2';
  client('pc-2');
  await D.TriggerScriptDeployment(['pc-2']);

  // The flush is fire-and-forget; without its .catch this is an unhandled
  // rejection.
  state.clientGetThrows = true;
  D.ReconcileDeploymentQueueAfterExecutions([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.errors.length >= 1);
});

// --- The debounce timer -----------------------------------------------------

test('a catalog change debounces into a single deployment of all adopted clients', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const D = freshDeployment();
    client('pc-1');
    client('pc-2');
    state.allClients = [null, [{ UUID: 'pc-1' }, { UUID: 'pc-2' }]];

    // Filesystem watchers fire repeatedly for one logical save.
    D.ScheduleScriptChangeDeployment();
    D.ScheduleScriptChangeDeployment();
    D.ScheduleScriptChangeDeployment();

    mock.timers.tick(1999);
    assert.deepEqual(dispatches(), [], 'fired before the debounce elapsed');

    mock.timers.tick(1);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(dispatches().length, 1, 'three schedules should collapse into one deployment');
    assert.deepEqual(dispatches()[0][1].sort(), ['pc-1', 'pc-2']);
  } finally {
    mock.timers.reset();
  }
});

test('the debounced deployment survives a failed client lookup', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const D = freshDeployment();
    state.allClients = ['db exploded', null];

    D.ScheduleScriptChangeDeployment();
    mock.timers.tick(2000);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

    // No clients resolved means nothing to deploy, not a crash.
    assert.deepEqual(dispatches(), []);
  } finally {
    mock.timers.reset();
  }
});
