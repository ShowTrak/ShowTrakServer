const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function serverPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'Server', name);
}

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

// Minimal fake socket that records emitted events and exposes a trigger() to
// invoke registered handlers, mimicking the Socket.IO socket surface.
//
// IMPORTANT: inbound handlers are stored on `this` (`this._handlers`), NOT in a
// closure. Real Socket.IO's `socket.on` delegates to an EventEmitter that reads
// `this._events`, so calling `on` with `this` detached (e.g. `const register =
// socket.on; register(...)`) throws `Cannot read properties of undefined`. If
// the mock stored handlers in a closure it would silently accept such unbound
// calls and hide that whole class of regression (it did — see the `.bind(socket)`
// fix in client-namespace.ts). Keying off `this` reproduces the real crash so
// any unbound extraction fails the suite here instead of only in production.
function makeSocket(handshake) {
  const emitted = [];
  return {
    id: 'sock-1',
    handshake,
    joined: [],
    emitted,
    disconnected: null,
    _handlers: {},
    join(room) {
      this.joined.push(room);
    },
    emit(event, ...args) {
      emitted.push({ event, args });
    },
    disconnect(flag) {
      this.disconnected = flag;
    },
    on(event, handler) {
      // Throws if `this` is undefined/global — matching Socket.IO's `this._events`.
      this._handlers[event] = handler;
    },
    async trigger(event, ...args) {
      if (this._handlers[event]) return this._handlers[event](...args);
    },
    hasHandler(event) {
      return typeof this._handlers[event] === 'function';
    },
  };
}

test('makeSocket.on requires its `this` binding (models Socket.IO)', () => {
  // Guards the whole test file: if `on` ever accepts a detached call, an unbound
  // `socket.on` extraction in server code (the bug the `.bind(socket)` fix in
  // client-namespace.ts addresses) would slip past every wiring test below.
  const socket = makeSocket({ query: {}, address: '127.0.0.1', headers: {} });
  socket.on('Bound', () => {});
  assert.equal(socket.hasHandler('Bound'), true);

  const detached = socket.on;
  assert.throws(() => detached('Unbound', () => {}));
  assert.equal(socket.hasHandler('Unbound'), false);
});

test('Server client namespace rejects sockets without a UUID', async () => {
  const { SetupClientNamespace } = loadWithMocks(serverPath('client-namespace.js'), {
    '../Logger': loggerStub,
    '../AdoptionManager': { Manager: {} },
    '../ClientManager': { Manager: {} },
    '../ScriptManager': { Manager: {} },
    '../ScriptExecutionManager': { Manager: {} },
    '../ServerIdentity': { Manager: { GetIdentityToken: () => 'server-token-1' } },
  });

  let connectionHandler;
  SetupClientNamespace({ on: (_e, h) => (connectionHandler = h) });

  const socket = makeSocket({ query: {}, address: '127.0.0.1', headers: {} });
  await connectionHandler(socket);
  assert.equal(socket.disconnected, true);
});

test('Server client namespace wires telemetry handlers and disconnect cleanup', async () => {
  const calls = {
    heartbeat: 0,
    systemInfo: 0,
    usbList: 0,
    usbAdd: 0,
    usbRemove: 0,
    nics: 0,
    timeout: 0,
    removeAdopt: 0,
    complete: 0,
    adopt: 0,
  };

  const { SetupClientNamespace } = loadWithMocks(serverPath('client-namespace.js'), {
    '../Logger': loggerStub,
    '../AdoptionManager': {
      Manager: {
        AddClientPendingAdoption: async () => (calls.adopt += 1),
        RemoveClientPendingAdoption: () => (calls.removeAdopt += 1),
      },
    },
    '../ClientManager': {
      Manager: {
        Exists: async () => false, // adopted client missing -> triggers Unadopt
        Heartbeat: async () => {
          calls.heartbeat += 1;
          return [null, 'ok'];
        },
        SystemInfo: async () => {
          calls.systemInfo += 1;
          return [null];
        },
        Get: async (uuid) => [null, { UUID: uuid, Online: true, USBDeviceList: [] }],
        SetUSBDeviceList: async () => (calls.usbList += 1),
        USBDeviceAdded: async () => (calls.usbAdd += 1),
        USBDeviceRemoved: async () => (calls.usbRemove += 1),
        SetNetworkInterfaces: async () => (calls.nics += 1),
        Timeout: async () => (calls.timeout += 1),
      },
    },
    '../ScriptManager': { Manager: { GetScripts: async () => [{ ID: 's1' }] } },
    '../ScriptExecutionManager': { Manager: { Complete: async () => (calls.complete += 1) } },
    '../ServerIdentity': { Manager: { GetIdentityToken: () => 'server-token-1' } },
  });

  let connectionHandler;
  SetupClientNamespace({ on: (_e, h) => (connectionHandler = h) });

  const socket = makeSocket({
    query: { UUID: 'client-1', Adopted: 'true' },
    address: '::ffff:10.0.0.9',
    headers: {},
  });
  await connectionHandler(socket);

  // Joined a room keyed by UUID and stripped the IPv6 prefix.
  assert.deepEqual(socket.joined, ['client-1']);
  assert.equal(socket.IP, '10.0.0.9');
  // Adopted but not in DB -> server asked it to unadopt.
  assert.ok(socket.emitted.some((e) => e.event === 'Unadopt'));

  await socket.trigger('AdoptionHeartbeat', { Hostname: 'h' });
  await socket.trigger('Heartbeat', { Vitals: {} });
  await socket.trigger('SystemInfo', { Hostname: 'h' });
  await socket.trigger('USBDeviceList', [{}, {}]);
  await socket.trigger('USBDeviceConnected', { ManufacturerName: 'M', ProductName: 'P' });
  await socket.trigger('USBDeviceDisconnected', { ManufacturerName: 'M', ProductName: 'P' });
  await socket.trigger('NetworkInterfaces', [{ name: 'eth0' }]);

  let captured = null;
  await socket.trigger('GetScripts', (scripts) => (captured = scripts));
  assert.deepEqual(captured, [{ ID: 's1' }]);

  await socket.trigger('ScriptExecutionResponse', 'req-1', null, {});
  await socket.trigger('disconnect', 'transport close');

  assert.equal(calls.adopt, 0);
  assert.equal(calls.heartbeat, 1);
  assert.equal(calls.systemInfo, 1);
  assert.equal(calls.usbList, 1);
  assert.equal(calls.usbAdd, 1);
  assert.equal(calls.usbRemove, 1);
  assert.equal(calls.nics, 1);
  assert.equal(calls.complete, 1);
  assert.equal(calls.removeAdopt, 2);
  assert.equal(calls.timeout, 1);
});

test('Server client namespace re-adopts stale unadopted handshake without adding pending entry', async () => {
  const calls = {
    adopt: 0,
    removeAdopt: 0,
  };

  const { SetupClientNamespace } = loadWithMocks(serverPath('client-namespace.js'), {
    '../Logger': loggerStub,
    '../AdoptionManager': {
      Manager: {
        AddClientPendingAdoption: async () => (calls.adopt += 1),
        RemoveClientPendingAdoption: () => (calls.removeAdopt += 1),
      },
    },
    '../ClientManager': {
      Manager: {
        Exists: async () => true,
        Heartbeat: async () => [null, 'ok'],
        SystemInfo: async () => [null],
        SetUSBDeviceList: async () => {},
        USBDeviceAdded: async () => {},
        USBDeviceRemoved: async () => {},
        SetNetworkInterfaces: async () => {},
        SetRunningApplications: async () => {},
        SetIntegratedActions: async () => [null, []],
        SetIntegratedState: async () => [null, true],
        Timeout: async () => {},
      },
    },
    '../ScriptManager': { Manager: { GetScripts: async () => [] } },
    '../ScriptExecutionManager': { Manager: { Complete: async () => {} } },
    '../ServerIdentity': { Manager: { GetIdentityToken: () => 'server-token-1' } },
  });

  let connectionHandler;
  SetupClientNamespace({ on: (_e, h) => (connectionHandler = h) });

  const socket = makeSocket({
    query: { UUID: 'client-2', Adopted: 'false' },
    address: '::ffff:10.0.0.10',
    headers: {},
  });
  await connectionHandler(socket);

  await socket.trigger('AdoptionHeartbeat', { Hostname: 'h' });

  assert.equal(calls.adopt, 0);
  assert.equal(calls.removeAdopt, 1);
  assert.ok(socket.emitted.some((e) => e.event === 'Adopt'));
});

test('Server client namespace keeps unadopted clients visible for pending adoption across server identities', async () => {
  const calls = {
    adopt: 0,
    removeAdopt: 0,
  };

  const { SetupClientNamespace } = loadWithMocks(serverPath('client-namespace.js'), {
    '../Logger': loggerStub,
    '../AdoptionManager': {
      Manager: {
        AddClientPendingAdoption: async () => (calls.adopt += 1),
        RemoveClientPendingAdoption: () => (calls.removeAdopt += 1),
      },
    },
    '../ClientManager': {
      Manager: {
        Exists: async () => false,
        Heartbeat: async () => [null, 'ok'],
        SystemInfo: async () => [null],
        SetUSBDeviceList: async () => {},
        USBDeviceAdded: async () => {},
        USBDeviceRemoved: async () => {},
        SetNetworkInterfaces: async () => {},
        SetRunningApplications: async () => {},
        SetIntegratedActions: async () => [null, []],
        SetIntegratedState: async () => [null, true],
        Timeout: async () => {},
      },
    },
    '../ScriptManager': { Manager: { GetScripts: async () => [] } },
    '../ScriptExecutionManager': { Manager: { Complete: async () => {} } },
    '../ServerIdentity': { Manager: { GetIdentityToken: () => 'server-token-1' } },
  });

  let connectionHandler;
  SetupClientNamespace({ on: (_e, h) => (connectionHandler = h) });

  const socket = makeSocket({
    query: { UUID: 'client-3', Adopted: 'false', ExpectedServerIdentity: 'different-token' },
    address: '::ffff:10.0.0.11',
    headers: {},
  });
  await connectionHandler(socket);

  await socket.trigger('AdoptionHeartbeat', {
    Hostname: 'h',
    ExpectedServerIdentity: 'different-token',
  });

  assert.equal(calls.adopt, 1);
  assert.equal(calls.removeAdopt, 0);
});

// Helpers to drive the Web UI namespace.
// options: { mode: 'SHOW'|'EDIT', handlers: { [channel]: fn }, sinks: [] }
function loadWebUi(settings, options = {}) {
  const mode = options.mode || 'SHOW';
  const handlers = options.handlers || {};
  const sinks = options.sinks || [];
  // A fresh event bus per load so the namespace's `WebUiSettingsChanged`
  // listener is isolated from other tests (and controllable via `__broadcast`).
  const broadcast = options.broadcast || new EventEmitter();
  const managers = {
    '../Logger': loggerStub,
    '../Config': { Config: { Application: { Version: '9.9.9' } } },
    '../Broadcast': { Manager: broadcast },
    '../ClientManager': {
      Manager: {
        GetAll: async () => [null, [{ UUID: 'u1', Nickname: 'PC' }]],
        Get: async (uuid) =>
          uuid === 'u1' ? [null, { UUID: 'u1', MacAddress: 'aa:bb' }] : ['not_found', null],
      },
    },
    '../GroupManager': {
      Manager: { GetAll: async () => [null, [{ GroupID: 1, Title: 'G', Weight: 1 }]] },
    },
    '../MonitoringTargetManager': { Manager: { GetAll: async () => [null, []] } },
    '../DummyClientManager': { Manager: { GetAll: async () => [null, []] } },
    '../AlertsManager': { Manager: { GetAll: async () => [null, []] } },
    '../SettingsManager': { Manager: { GetValue: async (key) => settings[key] } },
    '../WOLManager': { Manager: { Wake: async () => [null, 'magic packet sent'] } },
    '../ScriptManager': {
      Manager: { GetScripts: async () => [{ ID: 's1', Name: 'Deploy', Weight: 1 }] },
    },
    // Mock the whitelist manager so the real one — which requires ../DB and opens
    // a live sqlite connection at module load — is never pulled in. Without this
    // the initial-state push touches the real DB, whose load-time async behavior
    // is environment-dependent and cancels these tests on CI (the event loop
    // drains mid-test). DecorateCatalog is identity here; scope decoration is
    // covered by the ScriptWhitelistManager suite.
    '../ScriptWhitelistManager': { Manager: { DecorateCatalog: async (scripts) => scripts } },
    '../ModeManager': { Manager: { Get: () => mode } },
    '../../main/renderer-bus': {
      RegisterRendererSink: (fn) => {
        sinks.push(fn);
        return () => {};
      },
      PushToRenderers: () => {},
    },
    '../../main/handler-registry': {
      GetHandler: (channel) => handlers[channel],
      HasHandler: (channel) => typeof handlers[channel] === 'function',
      RegisterHandler: () => {},
    },
  };
  const mod = loadWithMocks(serverPath('webui-namespace.js'), managers);
  mod.__broadcast = broadcast;
  return mod;
}

function makeUiIo() {
  const ns = new EventEmitter();
  ns.middlewares = [];
  ns.use = (fn) => ns.middlewares.push(fn);
  ns._connection = null;
  ns.sockets = new Map();
  const realOn = ns.on.bind(ns);
  ns.on = (event, handler) => {
    if (event === 'connection') ns._connection = handler;
    return realOn(event, handler);
  };
  return { of: () => ns, _ns: ns };
}

// Connect a fake socket through the middleware + connection handler.
async function connectUiSocket(io) {
  const socket = makeSocket({ auth: {}, query: {}, address: '127.0.0.1' });
  io._ns.sockets.set(socket.id, socket);
  await new Promise((resolve) => io._ns.middlewares[0](socket, resolve));
  await io._ns._connection(socket);
  return socket;
}

test('Web UI namespace gates data behind authentication', async () => {
  const handlers = {
    GetClient: async (_e, uuid) => (uuid === 'u1' ? [null, { UUID: 'u1' }] : ['not_found', null]),
  };
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: true,
      WEBUI_PASSWORD: 'secret',
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: true,
      SYSTEM_ALLOW_WOL: true,
    },
    { handlers }
  );

  const io = makeUiIo();
  SetupWebUiNamespace(io, {});

  // Run the auth middleware with no token -> not authed.
  const socket = makeSocket({ auth: {}, query: {}, address: '127.0.0.1' });
  io._ns.sockets.set(socket.id, socket);
  await new Promise((resolve) => io._ns.middlewares[0](socket, resolve));
  assert.equal(socket.Authed, false);

  await io._ns._connection(socket);
  // hello is always emitted; initial state is withheld until authed.
  assert.ok(socket.emitted.some((e) => e.event === 'hello'));
  assert.equal(
    socket.emitted.some((e) => e.event === 'SetFullClientList'),
    false
  );

  // Unauthed rpc is rejected.
  let resp;
  await socket.trigger('rpc', 'GetClient', ['u1'], (r) => (resp = r));
  assert.deepEqual(resp, { error: 'unauthorized' });

  // Wrong password is rejected.
  await socket.trigger('auth:login', { password: 'nope' }, (r) => (resp = r));
  assert.deepEqual(resp, { error: 'invalid_password' });

  // Correct password authenticates and pushes initial state.
  await socket.trigger('auth:login', { password: 'secret' }, (r) => (resp = r));
  assert.equal(resp.ok, true);
  assert.equal(typeof resp.token, 'string');
  assert.ok(socket.emitted.some((e) => e.event === 'SetFullClientList'));

  // Now authed: a read rpc dispatches to the shared handler.
  await socket.trigger('rpc', 'GetClient', ['u1'], (r) => (resp = r));
  assert.deepEqual(resp, { result: [null, { UUID: 'u1' }] });

  // A channel outside the allowlist is denied.
  await socket.trigger('rpc', 'Mode:Set', ['EDIT'], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');

  // Logout clears the session.
  await socket.trigger('auth:logout', (r) => (resp = r));
  assert.deepEqual(resp, { ok: true });
});

// Regression: changing the passcode / protection / enabled settings must eject
// or re-prompt live sessions instead of leaving them silently authenticated.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test('Web UI namespace re-prompts live sessions when the passcode changes', async () => {
  const settings = {
    WEBUI_ENABLED: true,
    WEBUI_PASSWORD_PROTECTION_ENABLED: true,
    WEBUI_PASSWORD: 'secret',
  };
  const { SetupWebUiNamespace, __broadcast } = loadWebUi(settings);
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});

  // Establish an authenticated live session.
  const socket = await connectUiSocket(io);
  let resp;
  await socket.trigger('auth:login', { password: 'secret' }, (r) => (resp = r));
  assert.equal(resp.ok, true);
  assert.equal(socket.Authed, true);
  socket.emitted.length = 0;

  // Operator changes the passcode -> the settings-change event fires.
  settings.WEBUI_PASSWORD = '1234';
  __broadcast.emit('WebUiSettingsChanged');
  await flush();

  // The live session is dropped and re-greeted so the client re-prompts.
  assert.equal(socket.Authed, false);
  assert.equal(socket.SessionToken, null);
  const hello = socket.emitted.find((e) => e.event === 'hello');
  assert.ok(hello, 'socket was re-greeted with hello');
  assert.equal(hello.args[0].Authed, false);
  assert.equal(hello.args[0].PasswordProtection, true);

  // The previously-issued token is now worthless: reads are unauthorized, and
  // the stale (old) passcode is rejected on re-auth.
  await socket.trigger('rpc', 'GetClient', ['u1'], (r) => (resp = r));
  assert.deepEqual(resp, { error: 'unauthorized' });
  await socket.trigger('auth:login', { password: 'secret' }, (r) => (resp = r));
  assert.deepEqual(resp, { error: 'invalid_password' });
  await socket.trigger('auth:login', { password: '1234' }, (r) => (resp = r));
  assert.equal(resp.ok, true);
});

test('Web UI namespace ejects live sessions when the Web UI is disabled', async () => {
  const settings = {
    WEBUI_ENABLED: true,
    WEBUI_PASSWORD_PROTECTION_ENABLED: false,
  };
  const { SetupWebUiNamespace, __broadcast } = loadWebUi(settings);
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});

  // No passcode -> implicitly authed live session receiving pushes.
  const socket = await connectUiSocket(io);
  assert.equal(socket.Authed, true);
  socket.emitted.length = 0;

  // Operator disables the Web UI entirely.
  settings.WEBUI_ENABLED = false;
  __broadcast.emit('WebUiSettingsChanged');
  await flush();

  // The session is de-authed (so the renderer sink stops pushing to it) and
  // re-greeted with Enabled=false so the client shows the disabled notice.
  assert.equal(socket.Authed, false);
  const hello = socket.emitted.find((e) => e.event === 'hello');
  assert.ok(hello, 'socket was re-greeted with hello');
  assert.equal(hello.args[0].Enabled, false);

  // Nothing works while disabled, even reads.
  let resp;
  await socket.trigger('rpc', 'GetClient', ['u1'], (r) => (resp = r));
  assert.deepEqual(resp, { error: 'unauthorized' });
});

test('Web UI namespace dispatches script and WOL actions when permitted', async () => {
  const dispatched = [];
  const waked = [];
  const handlers = {
    ExecuteScript: async (_e, scriptId, targets) => {
      dispatched.push({ scriptId, targets });
      return [null, { queued: targets.length }];
    },
    WakeOnLan: async (_e, targets) => {
      waked.push(targets);
      return [null, 'ok'];
    },
  };
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: true,
      SYSTEM_ALLOW_WOL: true,
    },
    { handlers }
  );

  const io = makeUiIo();
  SetupWebUiNamespace(io, {});

  // No password required -> already authed, initial state sent.
  const socket = await connectUiSocket(io);
  assert.ok(socket.emitted.some((e) => e.event === 'SetFullClientList'));

  let resp;
  await socket.trigger('rpc', 'ExecuteScript', ['s1', ['u1'], true], (r) => (resp = r));
  assert.deepEqual(resp, { result: [null, { queued: 1 }] });
  assert.deepEqual(dispatched[0], { scriptId: 's1', targets: ['u1'] });

  await socket.trigger('rpc', 'WakeOnLan', [['u1']], (r) => (resp = r));
  assert.deepEqual(resp, { result: [null, 'ok'] });
  assert.deepEqual(waked[0], ['u1']);

  // config:get returns the public config.
  await socket.trigger('config:get', (r) => (resp = r));
  assert.equal(resp.data.Version, '9.9.9');
});

test('Web UI namespace blocks script + WOL actions when the settings forbid them', async () => {
  const handlers = { ExecuteScript: async () => [null, {}], WakeOnLan: async () => [null, 'ok'] };
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: false,
      SYSTEM_ALLOW_WOL: false,
    },
    { handlers }
  );
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  let resp;
  await socket.trigger('rpc', 'ExecuteScript', ['s1', ['u1']], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');
  await socket.trigger('rpc', 'WakeOnLan', [['u1']], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');
});

test('Web UI namespace dispatches integrated events when permitted', async () => {
  const triggered = [];
  const handlers = {
    TriggerIntegratedEvent: async (_e, eventId, targets) => {
      triggered.push({ eventId, targets });
      return [null, { failed: [] }];
    },
  };
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: true,
      SYSTEM_ALLOW_WOL: false,
    },
    { handlers }
  );

  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  const result = await new Promise((resolve) => {
    socket.trigger('rpc', 'TriggerIntegratedEvent', ['SetBoxBlue', ['u1']], resolve);
  });

  assert.deepEqual(result, { result: [null, { failed: [] }] });
  assert.deepEqual(triggered, [{ eventId: 'SetBoxBlue', targets: ['u1'] }]);
});

test('Web UI namespace enforces edit-mode and never allows mode/alert toggles', async () => {
  const handlers = {
    CreateGroup: async (_e, title) => [null, { GroupID: 2, Title: title }],
    'Mode:Set': async () => 'EDIT',
    'AlertActionsEnabled:Set': async () => false,
  };

  // SHOW mode: edit mutations are blocked; mode/alert toggles are never allowed.
  const showIo = makeUiIo();
  const { SetupWebUiNamespace: SetupShow } = loadWebUi(
    { WEBUI_ENABLED: true, WEBUI_PASSWORD_PROTECTION_ENABLED: false },
    { mode: 'SHOW', handlers }
  );
  SetupShow(showIo, {});
  const s1 = await connectUiSocket(showIo);

  let resp;
  await s1.trigger('rpc', 'CreateGroup', ['G'], (r) => (resp = r));
  assert.equal(resp.error, 'edit_mode_required');
  await s1.trigger('rpc', 'Mode:Set', ['EDIT'], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');
  await s1.trigger('rpc', 'AlertActionsEnabled:Set', [false], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');

  // EDIT mode: the same mutation is now permitted.
  const editIo = makeUiIo();
  const { SetupWebUiNamespace: SetupEdit } = loadWebUi(
    { WEBUI_ENABLED: true, WEBUI_PASSWORD_PROTECTION_ENABLED: false },
    { mode: 'EDIT', handlers }
  );
  SetupEdit(editIo, {});
  const s2 = await connectUiSocket(editIo);
  await s2.trigger('rpc', 'CreateGroup', ['G'], (r) => (resp = r));
  assert.deepEqual(resp, { result: [null, { GroupID: 2, Title: 'G' }] });
});

test('Web UI namespace allows Identify in SHOW mode', async () => {
  const handlers = {
    IdentifyClient: async (_e, uuid) => [null, { UUID: uuid }],
    StopIdentifyingClient: async (_e, uuid) => [null, { UUID: uuid }],
  };
  const { SetupWebUiNamespace } = loadWebUi(
    { WEBUI_ENABLED: true, WEBUI_PASSWORD_PROTECTION_ENABLED: false },
    { mode: 'SHOW', handlers }
  );
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  let resp;
  await socket.trigger('rpc', 'IdentifyClient', ['u1'], (r) => (resp = r));
  assert.deepEqual(resp, { result: [null, { UUID: 'u1' }] });
  await socket.trigger('rpc', 'StopIdentifyingClient', ['u1'], (r) => (resp = r));
  assert.deepEqual(resp, { result: [null, { UUID: 'u1' }] });
});

test('Web UI namespace denies a management category when its permission is off', async () => {
  const handlers = { CreateGroup: async (_e, title) => [null, { GroupID: 2, Title: title }] };
  // EDIT mode satisfies the master gate, but group management is explicitly denied.
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_GROUP_MANAGEMENT: false,
    },
    { mode: 'EDIT', handlers }
  );
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  let resp;
  await socket.trigger('rpc', 'CreateGroup', ['G'], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');
});

test('Web UI namespace denies Identify when the identify permission is off', async () => {
  const handlers = { IdentifyClient: async (_e, uuid) => [null, { UUID: uuid }] };
  const { SetupWebUiNamespace } = loadWebUi(
    { WEBUI_ENABLED: true, WEBUI_PASSWORD_PROTECTION_ENABLED: false, WEBUI_ALLOW_IDENTIFY: false },
    { mode: 'SHOW', handlers }
  );
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  let resp;
  await socket.trigger('rpc', 'IdentifyClient', ['u1'], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');
});

test('Web UI namespace gates WOL on the dedicated Web UI WOL permission', async () => {
  const handlers = { WakeOnLan: async () => [null, 'ok'] };
  // Global WOL is on and scripts are OFF: WOL must still be allowed because it no
  // longer depends on script execution, only on the dedicated Web UI WOL toggle.
  const allowed = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: false,
      SYSTEM_ALLOW_WOL: true,
      WEBUI_ALLOW_WOL: true,
    },
    { handlers }
  );
  const io1 = makeUiIo();
  allowed.SetupWebUiNamespace(io1, {});
  const s1 = await connectUiSocket(io1);
  let resp;
  await s1.trigger('rpc', 'WakeOnLan', [['u1']], (r) => (resp = r));
  assert.deepEqual(resp, { result: [null, 'ok'] });

  // Web UI WOL permission off: denied even though the global feature is enabled.
  const denied = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      SYSTEM_ALLOW_WOL: true,
      WEBUI_ALLOW_WOL: false,
    },
    { handlers }
  );
  const io2 = makeUiIo();
  denied.SetupWebUiNamespace(io2, {});
  const s2 = await connectUiSocket(io2);
  await s2.trigger('rpc', 'WakeOnLan', [['u1']], (r) => (resp = r));
  assert.equal(resp.error, 'forbidden');
});

test('Web UI namespace gates unassigned client creation on mode, feature and permission', async () => {
  const handlers = { CreateUnassignedClients: async () => [null, 2] };
  const Base = { WEBUI_ENABLED: true, WEBUI_PASSWORD_PROTECTION_ENABLED: false };
  const Call = async (settings, opts) => {
    const io = makeUiIo();
    loadWebUi({ ...Base, ...settings }, { handlers, ...opts }).SetupWebUiNamespace(io, {});
    const socket = await connectUiSocket(io);
    let resp;
    await socket.trigger('rpc', 'CreateUnassignedClients', [{ Name: 'S', Count: 2 }], (r) => {
      resp = r;
    });
    return resp;
  };

  // EDIT mode + global feature + Web UI permission: allowed.
  assert.deepEqual(
    await Call(
      { SYSTEM_ALLOW_UNASSIGNED_CLIENTS: true, WEBUI_ALLOW_UNASSIGNED_CLIENTS: true },
      { mode: 'EDIT' }
    ),
    { result: [null, 2] }
  );

  // Web UI permission off: denied even though the global feature is on.
  assert.equal(
    (
      await Call(
        { SYSTEM_ALLOW_UNASSIGNED_CLIENTS: true, WEBUI_ALLOW_UNASSIGNED_CLIENTS: false },
        { mode: 'EDIT' }
      )
    ).error,
    'forbidden'
  );

  // Global feature off: denied even though the Web UI permission is on.
  assert.equal(
    (
      await Call(
        { SYSTEM_ALLOW_UNASSIGNED_CLIENTS: false, WEBUI_ALLOW_UNASSIGNED_CLIENTS: true },
        { mode: 'EDIT' }
      )
    ).error,
    'forbidden'
  );

  // SHOW mode: creating slots is a management mutation, so the mode gate applies.
  assert.equal(
    (
      await Call(
        { SYSTEM_ALLOW_UNASSIGNED_CLIENTS: true, WEBUI_ALLOW_UNASSIGNED_CLIENTS: true },
        { mode: 'SHOW' }
      )
    ).error,
    'edit_mode_required'
  );
});

test('Web UI hello advertises unassigned clients only when feature and permission are both on', async () => {
  // The browser cannot read settings, so this hint is the only thing that lets
  // it decide whether to show the "Create Unassigned Client" entry.
  const Hint = async (settings) => {
    const io = makeUiIo();
    loadWebUi({
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      ...settings,
    }).SetupWebUiNamespace(io, {});
    const socket = await connectUiSocket(io);
    return socket.emitted.find((e) => e.event === 'hello').args[0].UnassignedClientsEnabled;
  };

  assert.equal(
    await Hint({ SYSTEM_ALLOW_UNASSIGNED_CLIENTS: true, WEBUI_ALLOW_UNASSIGNED_CLIENTS: true }),
    true
  );
  assert.equal(
    await Hint({ SYSTEM_ALLOW_UNASSIGNED_CLIENTS: true, WEBUI_ALLOW_UNASSIGNED_CLIENTS: false }),
    false
  );
  assert.equal(
    await Hint({ SYSTEM_ALLOW_UNASSIGNED_CLIENTS: false, WEBUI_ALLOW_UNASSIGNED_CLIENTS: true }),
    false
  );
  // Feature off by default -> hidden unless deliberately enabled.
  assert.equal(await Hint({}), false);
});

test('Web UI namespace forwards allowlisted pushes with serialization, dropping the rest', async () => {
  const sinks = [];
  const { SetupWebUiNamespace } = loadWebUi(
    { WEBUI_ENABLED: true, WEBUI_PASSWORD_PROTECTION_ENABLED: false },
    { sinks }
  );
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);
  assert.equal(typeof sinks[0], 'function');

  // A client-bearing push is serialized via ToPublicClient before delivery.
  socket.emitted.length = 0;
  sinks[0]('ClientUpdated', { UUID: 'u1', Nickname: 'PC' });
  const pushed = socket.emitted.find((e) => e.event === 'ClientUpdated');
  assert.ok(pushed);
  assert.equal(pushed.args[0].UUID, 'u1');

  // A non-allowlisted (desktop-only / secret-bearing) push is dropped.
  socket.emitted.length = 0;
  sinks[0]('UpdateSettings', { WEBUI_PASSWORD: 'secret' });
  assert.equal(socket.emitted.length, 0);
});

test('Web UI namespace disables access when the master toggle is off', async () => {
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: false,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: true,
      SYSTEM_ALLOW_WOL: true,
    },
    {}
  );

  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  const hello = socket.emitted.find((e) => e.event === 'hello');
  assert.equal(hello.args[0].Enabled, false);
  assert.equal(
    socket.emitted.some((e) => e.event === 'SetFullClientList'),
    false
  );

  let resp;
  await socket.trigger('auth:login', { password: '1234' }, (r) => (resp = r));
  assert.deepEqual(resp, { error: 'disabled' });

  await socket.trigger('rpc', 'GetClient', ['u1'], (r) => (resp = r));
  assert.deepEqual(resp, { error: 'unauthorized' });
});

test('Server Manager dispatches scripts, bulk requests, and group messages', async () => {
  const emits = [];
  const queue = [];
  const getRoutes = [];
  const postRoutes = [];
  const getHandlers = {};
  const ioMock = {
    to: (room) => ({ emit: (event, ...args) => emits.push({ room, event, args }) }),
    on: () => {},
    of: () => ({ use: () => {}, on: () => {} }),
  };

  const { Manager } = loadWithMocks(serverPath('index.js'), {
    '../Logger': loggerStub,
    http: { createServer: () => ({ on: () => {}, listen: (_p, cb) => cb && cb() }) },
    'socket.io': {
      Server: class {
        constructor() {
          return ioMock;
        }
      },
    },
    express: Object.assign(
      () => {
        const app = () => {};
        app.use = () => {};
        app.get = (routePath, handler) => {
          getRoutes.push(routePath);
          if (typeof handler === 'function') getHandlers[routePath] = handler;
        };
        app.post = (routePath) => postRoutes.push(routePath);
        return app;
      },
      { static: () => () => {} }
    ),
    '../OSC': {
      OSC: {
        GetRoutes: () => [
          { Path: '/API/Shutdown', Title: 'Shutdown', Callback: async () => ({ ok: true }) },
          {
            Path: '/API/Client/:UUID/Select',
            Title: 'Client Select',
            Callback: async () => ({ ok: true }),
          },
          {
            Path: '/API/All/Select',
            Title: 'All Select',
            Callback: async () => ({ ok: true }),
          },
        ],
      },
    },
    '../Config': { Config: { Application: { Port: 0, Version: '1.0' } } },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => '/tmp/scripts',
        GetStorageDirectory: () => '/tmp',
      },
    },
    '../UpdateManager': { Manager: { RegisterRoutes: () => {} } },
    // Server/index.js requires the whitelist manager directly; mock it so the
    // real ../DB (opened at module load) is never pulled into this unit test.
    // GetScope returns null (no whitelist row) so scripts stay unrestricted,
    // matching the empty-DB behavior these tests were written against.
    '../ScriptWhitelistManager': {
      Manager: { DecorateCatalog: async (scripts) => scripts, GetScope: async () => null },
    },
    '../ClientManager': {
      Manager: {
        GetAll: async () => [
          null,
          [
            { UUID: 'r1', GroupID: 1, OperatingSystem: 'Windows', Online: true, Degraded: false },
            { UUID: 'r2', GroupID: 2, OperatingSystem: 'Linux', Online: false, Degraded: false },
          ],
        ],
        Get: async (uuid) => [null, { UUID: uuid, Online: true }],
      },
    },
    '../MonitoringTargetManager': {
      Manager: {
        GetAll: async () => [
          null,
          [
            {
              TargetID: 10,
              GroupID: 1,
              Online: true,
              Degraded: true,
              Type: 'monitor',
              Nickname: 'Web Monitor',
            },
          ],
        ],
      },
    },
    '../DummyClientManager': {
      Manager: {
        GetAll: async () => [
          null,
          [
            {
              UUID: 'd1',
              GroupID: 1,
              Online: false,
              Degraded: false,
              State: 'IDLE',
              Type: 'dummy',
            },
          ],
        ],
        Heartbeat: async () => [null],
      },
    },
    '../ScriptExecutionManager': {
      Manager: {
        ClearQueue: async () => queue.push('clear'),
        AddToQueue: async (uuid, scriptId) => `req-${uuid}-${scriptId}`,
        AddInternalTaskToQueue: async (uuid, name) => `req-${uuid}-${name}`,
      },
    },
    '../Utils': { Wait: async () => {} },
    './client-namespace': { SetupClientNamespace: () => {} },
    './webui-namespace': { SetupWebUiNamespace: () => {} },
  });

  assert.ok(getRoutes.includes('/API/Shutdown'));
  assert.ok(postRoutes.includes('/API/Shutdown'));
  assert.ok(getRoutes.includes('/API/Client/:UUID/Select'));
  assert.ok(postRoutes.includes('/API/Client/:UUID/Select'));
  assert.ok(getRoutes.includes('/API/All/Select'));
  assert.ok(postRoutes.includes('/API/All/Select'));
  assert.ok(!getRoutes.includes('/API/Dummy/:id/Heartbeat'));
  assert.ok(!postRoutes.includes('/API/Dummy/:id/Heartbeat'));
  assert.ok(getRoutes.includes('/API/Clients'));

  const listClients = getHandlers['/API/Clients'];
  assert.equal(typeof listClients, 'function');

  let statusCode = 200;
  let payload = null;
  const makeRes = () => ({
    locals: {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  });

  statusCode = 200;
  payload = null;
  await listClients({ query: { Type: 'Dummy', Status: 'IDLE' } }, makeRes());
  assert.equal(statusCode, 200);
  assert.equal(payload.Error, false);
  assert.equal(payload.Response.Count, 1);
  assert.equal(payload.Response.Data[0].Type, 'Dummy');
  assert.equal(payload.Response.Data[0].Status, 'IDLE');

  statusCode = 200;
  payload = null;
  await listClients(
    { query: { Type: 'Remote', GroupID: '1', OperatingSystem: 'windows' } },
    makeRes()
  );
  assert.equal(statusCode, 200);
  assert.equal(payload.Error, false);
  assert.equal(payload.Response.Count, 1);
  assert.equal(payload.Response.Data[0].UUID, 'r1');

  statusCode = 200;
  payload = null;
  await listClients({ query: { Status: 'BROKEN' } }, makeRes());
  assert.equal(statusCode, 400);
  assert.equal(payload.Error, true);
  assert.equal(payload.Code, 'INVALID_QUERY_STATUS');
  assert.equal(payload.Message, 'Invalid Status query');

  await Manager.ExecuteScripts('deploy', ['a', 'b'], true);
  assert.equal(queue.includes('clear'), true);
  assert.ok(emits.some((e) => e.room === 'a' && e.event === 'ExecuteScript'));
  assert.ok(emits.some((e) => e.room === 'b' && e.event === 'ExecuteScript'));

  emits.length = 0;
  await Manager.ExecuteBulkRequest('WOL', ['a'], 'Wake On LAN');
  assert.ok(emits.some((e) => e.room === 'a' && e.event === 'WOL'));

  emits.length = 0;
  await Manager.SendMessageByGroup('group-1', 'Notify', { text: 'hi' });
  assert.deepEqual(emits[0], { room: 'group-1', event: 'Notify', args: [{ text: 'hi' }] });
});

test('Server Manager integrated event queue reports mixed target outcomes', async () => {
  const emits = [];
  const queueEntries = [];
  const completions = [];

  const clients = {
    good: {
      UUID: 'good',
      Online: true,
      IntegratedActions: [{ ID: 'SetBoxBlue', Label: 'Set Box Blue', HasFeedback: false }],
    },
    missing: {
      UUID: 'missing',
      Online: true,
      IntegratedActions: [],
    },
  };

  const { Manager } = loadWithMocks(serverPath('index.js'), {
    '../Logger': loggerStub,
    '../Config': { Config: { Application: { Version: '9.9.9' } } },
    '../AppData': { Manager: { GetScriptsDirectory: () => __dirname } },
    '../ScriptExecutionManager': {
      Manager: {
        AddToQueue: async () => 'req-script',
        ShouldDispatch: async () => true,
        GetExecution: async () => null,
        Complete: async (requestId, err) => completions.push({ requestId, err }),
        ClearQueue: async () => {},
        AddInternalTaskToQueue: async (_uuid, taskName) => {
          const id = `req-${queueEntries.length + 1}`;
          queueEntries.push({ id, taskName });
          return id;
        },
      },
    },
    '../ClientManager': {
      Manager: {
        Get: async (uuid) => [null, clients[uuid] || null],
      },
    },
    '../UpdateManager': { Manager: { RegisterRoutes: () => {} } },
    // Server/index.js requires the whitelist manager directly; mock it so the
    // real ../DB (opened at module load) is never pulled into this unit test.
    // GetScope returns null (no whitelist row) so scripts stay unrestricted,
    // matching the empty-DB behavior these tests were written against.
    '../ScriptWhitelistManager': {
      Manager: { DecorateCatalog: async (scripts) => scripts, GetScope: async () => null },
    },
    '../DummyClientManager': { Manager: {} },
    '../MonitoringTargetManager': { Manager: {} },
    '../OSC': { OSC: { GetRoutes: () => [] } },
    express: Object.assign(
      function () {
        return {
          use: () => {},
          get: () => {},
          post: () => {},
        };
      },
      { static: () => (_req, _res, next) => next && next() }
    ),
    'socket.io': {
      Server: function FakeServer() {
        return {
          on: () => {},
          of: () => ({ use: () => {}, on: () => {} }),
          to: (room) => ({ emit: (event, ...args) => emits.push({ room, event, args }) }),
        };
      },
    },
    './client-namespace': { SetupClientNamespace: () => {} },
    './webui-namespace': { SetupWebUiNamespace: () => {} },
    '../Utils': { Wait: async () => {} },
    http: {
      createServer: () => ({
        on: () => {},
        listen: (_port, cb) => {
          if (typeof cb === 'function') cb();
        },
        close: () => {},
        address: () => ({ port: 0 }),
      }),
    },
    path: require('path'),
  });

  const summary = await Manager.TriggerIntegratedEvent('SetBoxBlue', ['good', 'missing']);

  assert.equal(summary.queued, 2);
  assert.equal(summary.dispatched, 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].UUID, 'missing');
  assert.equal(queueEntries.length, 2);
  assert.ok(queueEntries.every((entry) => entry.taskName === 'Integrated Event: SetBoxBlue'));
  assert.ok(
    emits.some((entry) => entry.event === 'TriggerIntegratedEvent' && entry.room === 'good')
  );
  assert.ok(
    completions.some(
      (entry) =>
        entry.requestId === queueEntries[1].id &&
        /not available on client/.test(String(entry.err || ''))
    )
  );
});

// --- Web UI auth hardening -------------------------------------------------

test('Web UI login rate-limits an IP after repeated failures and blocks even a correct passcode', async () => {
  const { SetupWebUiNamespace, LOGIN_MAX_FAILURES } = loadWebUi({
    WEBUI_ENABLED: true,
    WEBUI_PASSWORD_PROTECTION_ENABLED: true,
    WEBUI_PASSWORD: '1234',
  });
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  // Exhaust the failure budget; every attempt is a wrong passcode.
  let resp;
  for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
    await socket.trigger('auth:login', { password: '0000' }, (r) => (resp = r));
    assert.equal(
      resp.error,
      'invalid_password',
      `attempt ${i + 1} should still be a normal reject`
    );
  }

  // The next attempt is locked out — and crucially, even the CORRECT passcode is
  // refused while the lockout is active (the limiter gates before the compare).
  await socket.trigger('auth:login', { password: '1234' }, (r) => (resp = r));
  assert.equal(resp.error, 'rate_limited');
  assert.ok(resp.retryAfterMs > 0, 'a rate-limited response advertises a retry delay');
  assert.equal(socket.Authed, false, 'a rate-limited login must not authenticate');
});

test('Web UI login lockout is per-IP: a successful login before the threshold clears the count', async () => {
  const { SetupWebUiNamespace, LOGIN_MAX_FAILURES } = loadWebUi({
    WEBUI_ENABLED: true,
    WEBUI_PASSWORD_PROTECTION_ENABLED: true,
    WEBUI_PASSWORD: '1234',
  });
  const io = makeUiIo();
  SetupWebUiNamespace(io, {});
  const socket = await connectUiSocket(io);

  let resp;
  // One shy of the threshold, then a correct login clears the record.
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
    await socket.trigger('auth:login', { password: '0000' }, (r) => (resp = r));
  }
  await socket.trigger('auth:login', { password: '1234' }, (r) => (resp = r));
  assert.equal(resp.ok, true);

  // Because the count reset, a fresh batch of failures is judged from zero rather
  // than immediately tripping the lockout.
  await socket.trigger('auth:login', { password: '0000' }, (r) => (resp = r));
  assert.equal(resp.error, 'invalid_password');
});

test('Web UI session tokens expire after their TTL (sliding) and are swept', () => {
  const mod = loadWebUi({ WEBUI_ENABLED: true });
  const { IssueToken, IsValidToken, SweepExpiredSessions, SESSION_TTL_MS } = mod;

  const t0 = 1_000_000;
  const token = IssueToken(t0);

  // Valid within its lifetime; validating renews it (sliding expiry).
  assert.equal(IsValidToken(token, t0 + SESSION_TTL_MS - 1), true);
  // Renewed at t0 + TTL - 1, so it now survives until (t0 + TTL - 1) + TTL.
  assert.equal(IsValidToken(token, t0 + SESSION_TTL_MS + 1), true);

  // Fresh token left untouched past its TTL is invalid and gets evicted.
  const stale = IssueToken(t0);
  assert.equal(IsValidToken(stale, t0 + SESSION_TTL_MS + 1), false);
  assert.equal(
    IsValidToken(stale, t0 + 1),
    false,
    'an expired token is evicted, not merely lapsed'
  );

  // Sweep removes lapsed tokens without touching live ones.
  const live = IssueToken(t0 + SESSION_TTL_MS);
  const dead = IssueToken(t0);
  SweepExpiredSessions(t0 + SESSION_TTL_MS + 5);
  assert.equal(IsValidToken(live, t0 + SESSION_TTL_MS + 6), true);
  assert.equal(IsValidToken(dead, t0 + SESSION_TTL_MS + 6), false);
});

test('Web UI passcode comparison is length-agnostic and correct', () => {
  const { PasscodeMatches } = loadWebUi({ WEBUI_ENABLED: true });
  assert.equal(PasscodeMatches('1234', '1234'), true);
  assert.equal(PasscodeMatches('1234', '1235'), false);
  // Differing lengths must return false, not throw (timingSafeEqual would throw
  // on unequal buffers — the hash step guards against that).
  assert.equal(PasscodeMatches('1', '123456'), false);
  assert.equal(PasscodeMatches('', ''), true);
});

test('Web UI login lockout releases after the cooldown elapses', () => {
  const {
    LoginRetryAfterMs,
    RecordLoginFailure,
    ClearLoginFailures,
    LOGIN_MAX_FAILURES,
    LOGIN_LOCKOUT_MS,
  } = loadWebUi({ WEBUI_ENABLED: true });

  const t0 = 5_000_000;
  const ip = '10.0.0.9';
  for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) RecordLoginFailure(ip, t0);

  assert.ok(LoginRetryAfterMs(ip, t0) > 0, 'locked immediately after the threshold');
  assert.equal(
    LoginRetryAfterMs(ip, t0 + LOGIN_LOCKOUT_MS + 1),
    0,
    'unlocked once the cooldown elapses'
  );

  // A different IP is unaffected, and clearing resets the offender.
  assert.equal(LoginRetryAfterMs('10.0.0.10', t0), 0);
  for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) RecordLoginFailure(ip, t0 + LOGIN_LOCKOUT_MS + 2);
  ClearLoginFailures(ip);
  assert.equal(LoginRetryAfterMs(ip, t0 + LOGIN_LOCKOUT_MS + 2), 0);
});
