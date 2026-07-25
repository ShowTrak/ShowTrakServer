const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises src/Modules/Server/sdk-namespace.ts — the `/sdk` Socket.IO namespace.
//
// This is the EXTERNAL integration surface: the published @showtrak/server-sdk
// package, the Companion module, and anything else an operator wires up connect
// here to drive a live show. That makes two things worth testing hard.
//
//   1. The handshake is the ONLY gate. Unlike the Web UI namespace there is no
//      second per-command capability check — once a socket is connected it can
//      send `system.shutdownForce`. So every path that reaches `next()` without
//      an error is a path that hands out full control of the instance.
//
//   2. The push allowlist and the command map ARE the published contract. A
//      renamed channel or a dropped command silently breaks every integration
//      out in the field, with no compiler to catch it — the SDK is a separate
//      package on a separate release cycle.
//
// Only the managers, ControlService and the renderer bus are stubbed. The REAL
// serializers run, and the real `PasscodeMatches` from webui-namespace performs
// the constant-time comparison.

const SDK_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'Server', 'sdk-namespace.js');

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

// Mutable state every mock reads, reset per test.
let state;

function freshState() {
  return {
    settings: { SDK_API_ENABLED: 1, SDK_API_KEY: 'a'.repeat(48) },
    settingsGetThrows: false,
    settingsSetThrows: false,
    settingsSet: [],
    clients: [null, [{ UUID: 'client-1', Nickname: 'FOH', Slug: 'foh', Online: true }]],
    groups: [null, [{ GroupID: 1, Title: 'Front', Weight: 0, Slug: 'front' }]],
    monitors: [null, [{ TargetID: 7, Nickname: 'UPS', Slug: 'ups', Online: true }]],
    dummies: [null, [{ UUID: 'd-1', DummyID: 'proj', Nickname: 'Projector' }]],
    tags: [{ TagID: 1, Slug: 'foh' }],
    scripts: [{ ID: 'restart', Name: 'Restart' }],
    mode: 'SHOW',
    alertsEnabled: true,
    monitorsThrow: false,
    dummiesThrow: false,
    tagsThrow: false,
    scriptsThrow: false,
    controlCalls: [],
    controlResult: { ok: true, detail: 'done' },
    controlThrows: false,
  };
}

function control(name) {
  return (...args) => {
    state.controlCalls.push([name, ...args]);
    if (state.controlThrows) throw new Error('control blew up');
    return state.controlResult;
  };
}

const CONTROL_METHODS = [
  'WakeAll',
  'WakeClient',
  'WakeGroup',
  'WakeTag',
  'RunScriptOnAll',
  'RunScriptOnClient',
  'RunScriptOnGroup',
  'RunScriptOnTag',
  'TriggerEventOnAll',
  'TriggerEventOnClient',
  'TriggerEventOnGroup',
  'TriggerEventOnTag',
  'SetAlertsEnabled',
  'ToggleAlerts',
  'SetMode',
  'ToggleMode',
  'OpenClientModal',
  'CloseModals',
  'SaveShow',
  'Shutdown',
  'ShutdownForce',
];

/**
 * Load a fresh copy of the namespace module.
 *
 * Reloading per test matters: the per-IP throttle lives in a module-level Map,
 * so a shared instance would leak lockouts between tests.
 */
function loadSdk() {
  const sinks = [];
  const ControlService = {};
  for (const Name of CONTROL_METHODS) ControlService[Name] = control(Name);

  const Mod = loadWithMocks(SDK_PATH, {
    '../Logger': loggerStub,
    '../../main/renderer-bus': { RegisterRendererSink: (fn) => sinks.push(fn) },
    // webui-namespace loads for real (we want its PasscodeMatches); these are
    // the extra siblings it pulls in.
    '../../main/handler-registry': { GetHandler: () => undefined },
    '../Broadcast': { Manager: { on: () => {}, emit: () => {} } },
    '../Config': { Config: { Production: false } },
    '../ControlService': { ControlService },
    '../SettingsManager': {
      Manager: {
        GetValue: async (Key) => {
          if (state.settingsGetThrows) throw new Error('settings unavailable');
          return state.settings[Key];
        },
        Set: async (Key, Value) => {
          state.settingsSet.push([Key, Value]);
          if (state.settingsSetThrows) throw new Error('settings are read-only');
          state.settings[Key] = Value;
        },
      },
    },
    '../ClientManager': { Manager: { GetAll: async () => state.clients } },
    '../GroupManager': { Manager: { GetAll: async () => state.groups } },
    '../MonitoringTargetManager': {
      Manager: {
        GetAll: async () => {
          if (state.monitorsThrow) throw new Error('monitors unavailable');
          return state.monitors;
        },
      },
    },
    '../DummyClientManager': {
      Manager: {
        GetAll: async () => {
          if (state.dummiesThrow) throw new Error('dummies unavailable');
          return state.dummies;
        },
      },
    },
    '../TagManager': {
      Manager: {
        GetAllViews: async () => {
          if (state.tagsThrow) throw new Error('tags unavailable');
          return state.tags;
        },
      },
    },
    '../ScriptManager': {
      Manager: {
        GetScripts: async () => {
          if (state.scriptsThrow) throw new Error('scripts unavailable');
          return state.scripts;
        },
      },
    },
    '../ScriptWhitelistManager': { Manager: { DecorateCatalog: async (C) => C } },
    '../ModeManager': { Manager: { Get: () => state.mode } },
    '../AlertsManager': { Manager: { GetActionsEnabled: () => state.alertsEnabled } },
  });

  return { Mod, sinks, ControlService };
}

/** A fake `/sdk` namespace, capturing what SetupSdkNamespace wires onto it. */
function fakeNamespace() {
  const NS = {
    middleware: null,
    connectionHandler: null,
    socketSet: new Set(),
    use(fn) {
      NS.middleware = fn;
    },
    on(event, fn) {
      if (event === 'connection') NS.connectionHandler = fn;
    },
    sockets: {
      values: () => NS.socketSet.values(),
    },
  };
  return NS;
}

function fakeSocket({ id = 'sock-1', address = '10.0.0.5', apiKey, emitThrows = false } = {}) {
  const Socket = {
    id,
    handshake: { address, auth: apiKey === undefined ? {} : { apiKey } },
    emitted: [],
    handlers: {},
    emit(event, ...args) {
      if (emitThrows) throw new Error('socket is dead');
      Socket.emitted.push([event, ...args]);
      return true;
    },
    on(event, fn) {
      Socket.handlers[event] = fn;
    },
  };
  return Socket;
}

/** Boot the namespace and hand back everything a test needs to drive it. */
function boot() {
  const { Mod, sinks, ControlService } = loadSdk();
  const NS = fakeNamespace();
  Mod.SetupSdkNamespace({ of: () => NS });
  return { Mod, NS, ControlService, push: (...args) => sinks.forEach((S) => S(...args)) };
}

/** Run the handshake middleware and resolve with the error it passed (or null). */
function handshake(NS, socket) {
  return new Promise((resolve) => {
    NS.middleware(socket, (err) => resolve(err || null));
  });
}

test.beforeEach(() => {
  state = freshState();
});

// --- The published push contract -------------------------------------------

test('the push allowlist is exactly the channels the SDK publishes', () => {
  // Pinned by name because the SDK package ships on its own release cycle:
  // removing a channel here breaks a deployed integration with nothing to catch
  // it at build time.
  const { Mod } = loadSdk();
  assert.deepEqual([...Mod.SDK_PUSH_ALLOWLIST].sort(), [
    'AlertActionsUpdated',
    'ClientUpdated',
    'DummyClientUpdated',
    'ModeUpdated',
    'MonitoringTargetUpdated',
    'Notify',
    'SetFullClientList',
    'SetFullDummyClientList',
    'SetFullMonitoringTargetList',
    'SetScriptList',
    'SetTagList',
    'UpdateScriptExecutions',
  ]);
});

test('a channel outside the allowlist is never forwarded', () => {
  // The bus carries the FULL main-process push stream, including channels that
  // expose internal state (settings, script file contents, update progress).
  // Deny-by-default is the only thing keeping those off the external wire.
  const { NS, push } = boot();
  const Socket = fakeSocket();
  NS.socketSet.add(Socket);

  for (const Channel of [
    'SetSettings',
    'ScriptFileContents',
    'UpdateDownloadProgress',
    'Anything',
  ]) {
    push(Channel, { secret: true });
  }
  assert.deepEqual(Socket.emitted, []);
});

test('SetFullClientList is projected through the public serializers', () => {
  const { NS, push } = boot();
  const Socket = fakeSocket();
  NS.socketSet.add(Socket);

  push('SetFullClientList', state.clients[1], state.groups[1]);

  const [Event, Clients, Groups] = Socket.emitted[0];
  assert.equal(Event, 'SetFullClientList');
  assert.equal(Clients[0].Type, 'client');
  assert.equal(Clients[0].UUID, 'client-1');
  assert.equal(Groups[0].GroupID, 1);
});

test('a missing client or group argument becomes an empty array, not undefined', () => {
  // An integration iterating the payload would throw on undefined; the SDK's
  // own client code assumes both slots are always arrays.
  const { NS, push } = boot();
  const Socket = fakeSocket();
  NS.socketSet.add(Socket);

  push('SetFullClientList');
  assert.deepEqual(Socket.emitted[0], ['SetFullClientList', [], []]);
});

test('monitors and dummies reach the SDK as client-shaped views', () => {
  // The whole point of the projection: an integration addresses a UPS monitor
  // or a dummy exactly like a real client, distinguished only by Type.
  const { NS, push } = boot();
  const Socket = fakeSocket();
  NS.socketSet.add(Socket);

  push('SetFullMonitoringTargetList', state.monitors[1]);
  push('MonitoringTargetUpdated', state.monitors[1][0]);
  push('SetFullDummyClientList', state.dummies[1]);
  push('DummyClientUpdated', state.dummies[1][0]);

  const [, MonitorList] = Socket.emitted[0];
  assert.equal(MonitorList[0].Type, 'monitor');
  assert.equal(
    MonitorList[0].UUID,
    'monitor:7',
    'scoped id must match the slug-namespace convention'
  );

  assert.equal(Socket.emitted[1][1].Type, 'monitor');

  const [, DummyList] = Socket.emitted[2];
  assert.equal(DummyList[0].Type, 'dummy');
  assert.equal(DummyList[0].UUID, 'dummy:d-1');
  assert.equal(DummyList[0].Slug, 'proj', 'DummyID is the dummy’s slug');

  assert.equal(Socket.emitted[3][1].Type, 'dummy');
});

test('allowlisted channels with no projection pass through untouched', () => {
  const { NS, push } = boot();
  const Socket = fakeSocket();
  NS.socketSet.add(Socket);

  push('Notify', 'success', 'Saved');
  push('ModeUpdated', 'SHOW');
  push('UpdateScriptExecutions', [{ ID: 1 }]);

  assert.deepEqual(Socket.emitted, [
    ['Notify', 'success', 'Saved'],
    ['ModeUpdated', 'SHOW'],
    ['UpdateScriptExecutions', [{ ID: 1 }]],
  ]);
});

test('a payload the serializer cannot handle is dropped, not thrown', () => {
  // ToPublicClient reads properties off the argument; a null entry in the list
  // would throw inside the bus fan-out and — without this guard — take out
  // delivery to every OTHER renderer sink, including the desktop window.
  const { NS, push } = boot();
  const Socket = fakeSocket();
  NS.socketSet.add(Socket);

  assert.doesNotThrow(() => push('ClientUpdated', null));
  assert.deepEqual(Socket.emitted, []);
});

test('one dead socket does not block delivery to the others', () => {
  const { NS, push } = boot();
  const Dead = fakeSocket({ id: 'dead', emitThrows: true });
  const Alive = fakeSocket({ id: 'alive' });
  NS.socketSet.add(Dead);
  NS.socketSet.add(Alive);

  push('Notify', 'info', 'still here');
  assert.equal(Alive.emitted.length, 1);
});

test('a push with no connected sockets is a no-op', () => {
  const { push } = boot();
  assert.doesNotThrow(() => push('Notify', 'info', 'nobody listening'));
});

// --- The handshake gate -----------------------------------------------------

test('a correct API key is accepted', async () => {
  const { NS } = boot();
  const Err = await handshake(NS, fakeSocket({ apiKey: 'a'.repeat(48) }));
  assert.equal(Err, null);
});

test('a wrong API key is refused', async () => {
  const { NS } = boot();
  const Err = await handshake(NS, fakeSocket({ apiKey: 'b'.repeat(48) }));
  assert.match(String(Err.message), /Unauthorized/);
});

test('a key of the wrong LENGTH is refused rather than crashing the compare', async () => {
  // timingSafeEqual throws on mismatched buffer lengths. PasscodeMatches hashes
  // both sides first so the lengths always agree — if that ever changes, every
  // handshake with a short key would fall into the catch and return
  // 'Auth failed' instead of a clean rejection.
  const { NS } = boot();
  const Err = await handshake(NS, fakeSocket({ apiKey: 'short' }));
  assert.match(String(Err.message), /Unauthorized/);
});

test('a missing or empty key is refused', async () => {
  for (const Key of [undefined, '', null]) {
    const { NS } = boot();
    const Err = await handshake(NS, fakeSocket({ apiKey: Key }));
    assert.ok(Err, `key ${JSON.stringify(Key)} was accepted`);
  }
});

test('a key that could not be generated refuses every connection', async () => {
  // Fail closed: no usable key must never mean "no auth required". Reached when
  // the first-boot generation cannot persist (locked or read-only settings), so
  // the write failure is what the mock models.
  state = freshState();
  state.settings.SDK_API_KEY = '';
  state.settingsSetThrows = true;
  const { NS } = boot();
  const Err = await handshake(NS, fakeSocket({ apiKey: '' }));
  assert.match(String(Err.message), /not configured/i);
});

test('a whitespace-only configured key counts as not configured', async () => {
  state = freshState();
  state.settings.SDK_API_KEY = '   ';
  state.settingsSetThrows = true;
  const { NS } = boot();
  const Err = await handshake(NS, fakeSocket({ apiKey: '   ' }));
  assert.match(String(Err.message), /not configured/i);
});

test('the feature switch refuses connections even with the right key', async () => {
  state = freshState();
  state.settings.SDK_API_ENABLED = 0;
  const { NS } = boot();
  const Err = await handshake(NS, fakeSocket({ apiKey: 'a'.repeat(48) }));
  assert.match(String(Err.message), /disabled/i);
});

test('an unset enabled flag defaults to ON', async () => {
  // Existing installs have no SDK_API_ENABLED row; they must keep working.
  state = freshState();
  delete state.settings.SDK_API_ENABLED;
  const { NS } = boot();
  assert.equal(await handshake(NS, fakeSocket({ apiKey: 'a'.repeat(48) })), null);
});

test('settings being unreadable refuses the connection instead of opening it', async () => {
  // GetSdkConfig swallows the error and falls back to Enabled:true with an EMPTY
  // key — which then trips the not-configured guard. Verifying the fallback is
  // closed, not open.
  state = freshState();
  state.settingsGetThrows = true;
  const { NS } = boot();
  const Err = await handshake(NS, fakeSocket({ apiKey: 'a'.repeat(48) }));
  assert.ok(Err);
});

test('a socket with no handshake address is still handled', async () => {
  const { NS } = boot();
  const Socket = fakeSocket({ apiKey: 'a'.repeat(48) });
  Socket.handshake.address = '';
  assert.equal(await handshake(NS, Socket), null);
});

// --- Throttle ---------------------------------------------------------------

test('sustained failures from one IP eventually arm a lockout', async () => {
  const { NS } = boot();

  // The threshold is deliberately generous (the key is 192-bit, so this is an
  // abuse backstop, not a brute-force defence).
  let Locked = null;
  for (let i = 0; i < 120 && !Locked; i++) {
    const Err = await handshake(NS, fakeSocket({ apiKey: 'wrong' }));
    if (/Try again in/.test(String(Err.message))) Locked = Err;
  }

  assert.ok(Locked, 'the throttle never engaged');
  assert.match(String(Locked.message), /Try again in \d+s/);
});

test('the lockout is per IP, not global', async () => {
  // A misconfigured integration on one machine must not lock the operator's
  // Companion box out of the show.
  const { NS } = boot();
  for (let i = 0; i < 120; i++) {
    await handshake(NS, fakeSocket({ address: '10.0.0.5', apiKey: 'wrong' }));
  }

  const Err = await handshake(NS, fakeSocket({ address: '10.0.0.6', apiKey: 'a'.repeat(48) }));
  assert.equal(Err, null, 'a second IP was caught by the first IP’s lockout');
});

test('a successful handshake clears that IP’s failure record', async () => {
  // A client that had the wrong key in its config and then got it right must not
  // stay part-way to a lockout.
  const { NS } = boot();
  for (let i = 0; i < 90; i++) {
    await handshake(NS, fakeSocket({ apiKey: 'wrong' }));
  }
  assert.equal(await handshake(NS, fakeSocket({ apiKey: 'a'.repeat(48) })), null);

  // Another 90 failures must therefore still be under the threshold.
  let Locked = false;
  for (let i = 0; i < 90; i++) {
    const Err = await handshake(NS, fakeSocket({ apiKey: 'wrong' }));
    if (/Try again in/.test(String(Err.message))) Locked = true;
  }
  assert.equal(Locked, false, 'the counter was not reset by the successful handshake');
});

test('a lockout expires on its own and the IP is let back in', async () => {
  // No timer sits behind the throttle — the map is swept lazily on each
  // handshake, which is also what keeps it bounded to currently-active IPs on a
  // long-running server. Time is faked because the cool-off is five minutes.
  const { NS } = boot();

  let Locked = false;
  for (let i = 0; i < 150 && !Locked; i++) {
    const Err = await handshake(NS, fakeSocket({ apiKey: 'wrong' }));
    Locked = /Try again in/.test(String(Err.message));
  }
  assert.ok(Locked);

  // Past both the 5-minute cool-off and the 60s counting window, so the record
  // is evicted rather than merely ignored. Seeded from the real clock, since the
  // lockout that was just armed is stamped in real epoch time.
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 6 * 60 * 1000 });
  try {
    assert.equal(
      await handshake(NS, fakeSocket({ apiKey: 'a'.repeat(48) })),
      null,
      'the lockout outlived its cool-off'
    );
  } finally {
    mock.timers.reset();
  }
});

test('a refused connection never runs the throttle for a disabled or unconfigured API', async () => {
  // Neither is the caller's fault, so neither should count toward a lockout —
  // otherwise turning the feature on would leave clients locked out.
  state = freshState();
  state.settings.SDK_API_KEY = '';
  state.settingsSetThrows = true;
  const { NS } = boot();
  for (let i = 0; i < 150; i++) {
    const Err = await handshake(NS, fakeSocket({ apiKey: 'anything' }));
    assert.match(String(Err.message), /not configured/i);
  }
});

// --- Key generation ---------------------------------------------------------

test('a key is generated and persisted on first boot', async () => {
  state = freshState();
  state.settings.SDK_API_KEY = '';
  boot();
  await new Promise((R) => setImmediate(R));

  assert.equal(state.settingsSet.length, 1);
  const [Key, Value] = state.settingsSet[0];
  assert.equal(Key, 'SDK_API_KEY');
  assert.match(Value, /^[0-9a-f]{48}$/, '24 random bytes, hex encoded');
});

test('an existing key is never regenerated', async () => {
  // Regenerating would silently break every deployed integration.
  boot();
  await new Promise((R) => setImmediate(R));
  assert.deepEqual(state.settingsSet, []);
});

test('a settings failure during key generation does not stop the namespace booting', async () => {
  state = freshState();
  state.settingsGetThrows = true;
  const { NS } = boot();
  await new Promise((R) => setImmediate(R));
  assert.equal(typeof NS.middleware, 'function');
  assert.equal(typeof NS.connectionHandler, 'function');
});

// --- Initial state ----------------------------------------------------------

test('a connecting socket is sent the full current state', async () => {
  const { NS } = boot();
  const Socket = fakeSocket();
  await NS.connectionHandler(Socket);

  const Channels = Socket.emitted.map((E) => E[0]);
  assert.deepEqual(Channels, [
    'SetFullClientList',
    'SetFullMonitoringTargetList',
    'SetFullDummyClientList',
    'SetTagList',
    'SetScriptList',
    'ModeUpdated',
    'AlertActionsUpdated',
  ]);
  assert.equal(Socket.emitted[5][1], 'SHOW');
  assert.equal(Socket.emitted[6][1], true);
});

test('a manager error yields an empty list rather than a missing channel', async () => {
  // An integration waits for each channel before it considers itself in sync;
  // silently skipping one leaves it waiting forever.
  state = freshState();
  state.monitorsThrow = true;
  state.dummiesThrow = true;
  state.tagsThrow = true;
  state.scriptsThrow = true;

  const { NS } = boot();
  const Socket = fakeSocket();
  await NS.connectionHandler(Socket);

  const By = Object.fromEntries(Socket.emitted.map(([C, ...A]) => [C, A]));
  assert.deepEqual(By.SetFullMonitoringTargetList, [[]]);
  assert.deepEqual(By.SetFullDummyClientList, [[]]);
  assert.deepEqual(By.SetTagList, [[]]);
  assert.deepEqual(By.SetScriptList, [[]]);
});

test('a client-manager error still sends an empty client list', async () => {
  state = freshState();
  state.clients = ['db is down', null];
  state.groups = ['db is down', null];

  const { NS } = boot();
  const Socket = fakeSocket();
  await NS.connectionHandler(Socket);
  assert.deepEqual(Socket.emitted[0], ['SetFullClientList', [], []]);
});

test('a socket that dies mid-handshake does not throw out of the connection handler', async () => {
  const { NS } = boot();
  const Socket = fakeSocket({ emitThrows: true });
  await assert.doesNotReject(() => NS.connectionHandler(Socket));
});

// --- Command dispatch -------------------------------------------------------

test('every published command maps to its ControlService call', async () => {
  const { Mod } = loadSdk();

  const Cases = [
    ['wol.all', {}, ['WakeAll']],
    ['wol.client', { slug: 'foh' }, ['WakeClient', 'foh']],
    ['wol.group', { slug: 'front' }, ['WakeGroup', 'front']],
    ['wol.tag', { slug: 'critical' }, ['WakeTag', 'critical']],
    ['script.all', { scriptSlug: 'restart' }, ['RunScriptOnAll', 'restart']],
    [
      'script.client',
      { slug: 'foh', scriptSlug: 'restart' },
      ['RunScriptOnClient', 'foh', 'restart'],
    ],
    [
      'script.group',
      { slug: 'front', scriptSlug: 'restart' },
      ['RunScriptOnGroup', 'front', 'restart'],
    ],
    [
      'script.tag',
      { slug: 'critical', scriptSlug: 'restart' },
      ['RunScriptOnTag', 'critical', 'restart'],
    ],
    ['event.all', { eventSlug: 'go' }, ['TriggerEventOnAll', 'go']],
    ['event.client', { slug: 'foh', eventSlug: 'go' }, ['TriggerEventOnClient', 'foh', 'go']],
    ['event.group', { slug: 'front', eventSlug: 'go' }, ['TriggerEventOnGroup', 'front', 'go']],
    ['event.tag', { slug: 'critical', eventSlug: 'go' }, ['TriggerEventOnTag', 'critical', 'go']],
    ['alerts.set', { enabled: true }, ['SetAlertsEnabled', true]],
    ['alerts.toggle', {}, ['ToggleAlerts']],
    ['mode.set', { mode: 'EDIT' }, ['SetMode', 'EDIT']],
    ['mode.toggle', {}, ['ToggleMode']],
    ['modal.openClient', { slug: 'foh' }, ['OpenClientModal', 'foh']],
    ['modal.closeAll', {}, ['CloseModals']],
    ['show.save', {}, ['SaveShow']],
    ['system.shutdown', {}, ['Shutdown']],
    ['system.shutdownForce', {}, ['ShutdownForce']],
  ];

  for (const [Name, Args, Expected] of Cases) {
    state.controlCalls = [];
    await Mod.DispatchCommand(Name, Args);
    assert.deepEqual(state.controlCalls, [Expected], `command "${Name}" dispatched wrongly`);
  }

  // Every ControlService method the namespace can reach is covered above; if one
  // is added without a command, this fails.
  assert.equal(new Set(Cases.map((C) => C[2][0])).size, CONTROL_METHODS.length);
});

test('an unknown command is reported, not silently ignored', async () => {
  const { Mod } = loadSdk();
  const Result = await Mod.DispatchCommand('system.rm-rf', {});
  assert.equal(Result.ok, false);
  assert.match(Result.detail, /Unknown command "system\.rm-rf"/);
  assert.deepEqual(state.controlCalls, []);
});

test('a non-object args payload does not crash the dispatcher', async () => {
  // The wire is untrusted: a caller can send anything in the args slot.
  const { Mod } = loadSdk();
  for (const Args of [null, undefined, 'string', 42, true, []]) {
    state.controlCalls = [];
    await Mod.DispatchCommand('wol.client', Args);
    assert.deepEqual(state.controlCalls, [['WakeClient', '']], `args ${JSON.stringify(Args)}`);
  }
});

test('missing slug fields become empty strings for the resolver to reject', async () => {
  // ControlService validates the slug; the dispatcher's job is only to make sure
  // it always receives a string, never undefined.
  const { Mod } = loadSdk();
  await Mod.DispatchCommand('script.client', {});
  assert.deepEqual(state.controlCalls, [['RunScriptOnClient', '', '']]);
});

test('alerts.set coerces any truthy value to a real boolean', async () => {
  // The mid-show alert kill switch — a string 'false' must not read as enabled.
  const { Mod } = loadSdk();
  for (const [Input, Expected] of [
    [true, true],
    [1, true],
    ['yes', true],
    [false, false],
    [0, false],
    [undefined, false],
    [null, false],
  ]) {
    state.controlCalls = [];
    await Mod.DispatchCommand('alerts.set', { enabled: Input });
    assert.equal(state.controlCalls[0][1], Expected, `enabled: ${JSON.stringify(Input)}`);
  }
});

test('mode.set defaults to SHOW when no mode is supplied', async () => {
  // The safe direction: SHOW is the locked-down mode, EDIT is the permissive one.
  const { Mod } = loadSdk();
  await Mod.DispatchCommand('mode.set', {});
  assert.deepEqual(state.controlCalls, [['SetMode', 'SHOW']]);
});

// --- The command event ------------------------------------------------------

async function connectAndCommand(NS, name, args, { withAck = true } = {}) {
  const Socket = fakeSocket();
  await NS.connectionHandler(Socket);

  const Acked = [];
  const Ack = withAck ? (R) => Acked.push(R) : undefined;
  Socket.handlers.command(name, args, Ack);
  await new Promise((R) => setImmediate(R));
  return { Socket, Acked };
}

test('a command is acknowledged with its result', async () => {
  const { NS } = boot();
  const { Acked } = await connectAndCommand(NS, 'wol.all', {});
  assert.deepEqual(Acked, [{ ok: true, detail: 'done' }]);
});

test('a failing command acknowledges a failure rather than hanging the caller', async () => {
  // The SDK awaits the ack; without one, an integration's await never settles.
  state = freshState();
  state.controlThrows = true;
  const { NS } = boot();
  const { Acked } = await connectAndCommand(NS, 'wol.all', {});
  assert.deepEqual(Acked, [{ ok: false, detail: 'Command failed' }]);
});

test('the internal error detail is not leaked to the caller', async () => {
  state = freshState();
  state.controlThrows = true;
  const { NS } = boot();
  const { Acked } = await connectAndCommand(NS, 'wol.all', {});
  assert.doesNotMatch(String(Acked[0].detail), /blew up/);
});

test('a command sent without an ack callback does not throw', async () => {
  // Socket.IO omits the ack argument entirely when the caller used emit().
  const { NS } = boot();
  await assert.doesNotReject(() => connectAndCommand(NS, 'wol.all', {}, { withAck: false }));
  assert.deepEqual(state.controlCalls, [['WakeAll']]);
});

test('SetupSdkNamespace wires the namespace it returns', () => {
  const { Mod, NS } = (() => {
    const Loaded = loadSdk();
    const Namespace = fakeNamespace();
    const Returned = Loaded.Mod.SetupSdkNamespace({ of: () => Namespace });
    return { Mod: Returned, NS: Namespace };
  })();

  assert.equal(Mod, NS);
  assert.equal(typeof NS.middleware, 'function');
  assert.equal(typeof NS.connectionHandler, 'function');
});
