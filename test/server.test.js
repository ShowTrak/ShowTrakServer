const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function serverPath(name) {
  return path.join(__dirname, '..', 'src', 'Modules', 'Server', name);
}

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
  }),
};

// Minimal fake socket that records emitted events and exposes a trigger() to
// invoke registered handlers, mimicking the Socket.IO socket surface.
function makeSocket(handshake) {
  const handlers = {};
  const emitted = [];
  return {
    id: 'sock-1',
    handshake,
    joined: [],
    emitted,
    disconnected: null,
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
      handlers[event] = handler;
    },
    async trigger(event, ...args) {
      if (handlers[event]) return handlers[event](...args);
    },
    hasHandler(event) {
      return typeof handlers[event] === 'function';
    },
  };
}

test('Server client namespace rejects sockets without a UUID', async () => {
  const { SetupClientNamespace } = loadWithMocks(serverPath('client-namespace.js'), {
    '../Logger': loggerStub,
    '../AdoptionManager': { Manager: {} },
    '../ClientManager': { Manager: {} },
    '../ScriptManager': { Manager: {} },
    '../ScriptExecutionManager': { Manager: {} },
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
        SetUSBDeviceList: async () => (calls.usbList += 1),
        USBDeviceAdded: async () => (calls.usbAdd += 1),
        USBDeviceRemoved: async () => (calls.usbRemove += 1),
        SetNetworkInterfaces: async () => (calls.nics += 1),
        Timeout: async () => (calls.timeout += 1),
      },
    },
    '../ScriptManager': { Manager: { GetScripts: async () => [{ ID: 's1' }] } },
    '../ScriptExecutionManager': { Manager: { Complete: async () => (calls.complete += 1) } },
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

  assert.equal(calls.adopt, 1);
  assert.equal(calls.heartbeat, 1);
  assert.equal(calls.systemInfo, 1);
  assert.equal(calls.usbList, 1);
  assert.equal(calls.usbAdd, 1);
  assert.equal(calls.usbRemove, 1);
  assert.equal(calls.nics, 1);
  assert.equal(calls.complete, 1);
  assert.equal(calls.removeAdopt, 1);
  assert.equal(calls.timeout, 1);
});

// Helpers to drive the Web UI namespace.
function loadWebUi(settings, broadcast) {
  const managers = {
    '../Logger': loggerStub,
    '../Config': { Config: { Application: { Version: '9.9.9' } } },
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
    '../SettingsManager': { Manager: { GetValue: async (key) => settings[key] } },
    '../WOLManager': { Manager: { Wake: async () => [null, 'magic packet sent'] } },
    '../ScriptManager': {
      Manager: { GetScripts: async () => [{ ID: 's1', Name: 'Deploy', Weight: 1 }] },
    },
    '../Broadcast': { Manager: broadcast },
  };
  return loadWithMocks(serverPath('webui-namespace.js'), managers);
}

function makeUiIo() {
  const ns = new EventEmitter();
  ns.middlewares = [];
  ns.use = (fn) => ns.middlewares.push(fn);
  ns._connection = null;
  const realOn = ns.on.bind(ns);
  ns.on = (event, handler) => {
    if (event === 'connection') ns._connection = handler;
    return realOn(event, handler);
  };
  return { of: () => ns, _ns: ns };
}

test('Web UI namespace gates data behind authentication', async () => {
  const broadcast = new EventEmitter();
  broadcast.off = broadcast.removeListener.bind(broadcast);
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: true,
      WEBUI_PASSWORD: 'secret',
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: true,
      SYSTEM_ALLOW_WOL: true,
    },
    broadcast
  );

  const ServerManager = { ExecuteScripts: async () => {} };
  const io = makeUiIo();
  SetupWebUiNamespace(io, ServerManager);

  // Run the auth middleware with no token -> not authed.
  const socket = makeSocket({ auth: {}, query: {}, address: '127.0.0.1' });
  await new Promise((resolve) => io._ns.middlewares[0](socket, resolve));
  assert.equal(socket.Authed, false);

  await io._ns._connection(socket);
  // hello is always emitted; bootstrap is withheld until authed.
  assert.ok(socket.emitted.some((e) => e.event === 'hello'));
  assert.equal(
    socket.emitted.some((e) => e.event === 'bootstrap'),
    false
  );

  // Unauthed data request is rejected.
  let resp;
  await socket.trigger('clients:get', (r) => (resp = r));
  assert.deepEqual(resp, { error: 'unauthorized' });

  // Wrong password is rejected.
  await socket.trigger('auth:login', { password: 'nope' }, (r) => (resp = r));
  assert.deepEqual(resp, { error: 'invalid_password' });

  // Correct password authenticates and returns a token + bootstrap.
  await socket.trigger('auth:login', { password: 'secret' }, (r) => (resp = r));
  assert.equal(resp.ok, true);
  assert.equal(typeof resp.token, 'string');
  assert.ok(socket.emitted.some((e) => e.event === 'bootstrap'));

  // Now authed: data requests succeed.
  await socket.trigger('clients:get', (r) => (resp = r));
  assert.equal(resp.data[0].UUID, 'u1');

  await socket.trigger('client:get', 'u1', (r) => (resp = r));
  assert.equal(resp.data.UUID, 'u1');
  await socket.trigger('client:get', 'missing', (r) => (resp = r));
  assert.equal(resp.error, 'not_found');

  // Logout clears the session.
  await socket.trigger('auth:logout', (r) => (resp = r));
  assert.deepEqual(resp, { ok: true });
});

test('Web UI namespace dispatches script and WOL actions when permitted', async () => {
  const broadcast = new EventEmitter();
  broadcast.off = broadcast.removeListener.bind(broadcast);
  const dispatched = [];
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: true,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: true,
      SYSTEM_ALLOW_WOL: true,
    },
    broadcast
  );

  const ServerManager = {
    ExecuteScripts: async (scriptId, targets) => dispatched.push({ scriptId, targets }),
  };
  const io = makeUiIo();
  SetupWebUiNamespace(io, ServerManager);

  const socket = makeSocket({ auth: {}, query: {}, address: '127.0.0.1' });
  await new Promise((resolve) => io._ns.middlewares[0](socket, resolve));
  await io._ns._connection(socket);
  // No password required -> already authed, bootstrap sent.
  assert.ok(socket.emitted.some((e) => e.event === 'bootstrap'));

  let resp;
  await socket.trigger('scripts:run', { uuid: 'u1', scriptId: 's1' }, (r) => (resp = r));
  assert.deepEqual(resp, { ok: true });
  assert.deepEqual(dispatched[0], { scriptId: 's1', targets: ['u1'] });

  // Invalid args.
  await socket.trigger('scripts:run', {}, (r) => (resp = r));
  assert.deepEqual(resp, { error: 'invalid_args' });

  // WOL wake succeeds for a client with a MAC.
  await socket.trigger('wol:wake', { uuid: 'u1' }, (r) => (resp = r));
  assert.equal(resp.ok, true);
  assert.match(resp.message, /magic packet/);

  // config:get returns the public config.
  await socket.trigger('config:get', (r) => (resp = r));
  assert.equal(resp.data.Version, '9.9.9');

  // Live push wiring reacts to broadcast events without throwing.
  broadcast.emit('ClientListChanged');
  broadcast.emit('GroupListChanged');
  broadcast.emit('SettingsUpdated');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(socket.emitted.some((e) => e.event === 'clients:list'));

  // Disconnect detaches broadcast listeners.
  await socket.trigger('disconnect');
  assert.equal(broadcast.listenerCount('ClientListChanged'), 0);
});

test('Web UI namespace disables access when the master toggle is off', async () => {
  const broadcast = new EventEmitter();
  broadcast.off = broadcast.removeListener.bind(broadcast);
  const { SetupWebUiNamespace } = loadWebUi(
    {
      WEBUI_ENABLED: false,
      WEBUI_PASSWORD_PROTECTION_ENABLED: false,
      WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION: true,
      SYSTEM_ALLOW_WOL: true,
    },
    broadcast
  );

  const ServerManager = { ExecuteScripts: async () => {} };
  const io = makeUiIo();
  SetupWebUiNamespace(io, ServerManager);

  const socket = makeSocket({ auth: {}, query: {}, address: '127.0.0.1' });
  await new Promise((resolve) => io._ns.middlewares[0](socket, resolve));
  await io._ns._connection(socket);

  const hello = socket.emitted.find((e) => e.event === 'hello');
  assert.equal(hello.args[0].Enabled, false);
  assert.equal(
    socket.emitted.some((e) => e.event === 'bootstrap'),
    false
  );

  let resp;
  await socket.trigger('auth:login', { password: '1234' }, (r) => (resp = r));
  assert.deepEqual(resp, { error: 'disabled' });

  await socket.trigger('clients:get', (r) => (resp = r));
  assert.deepEqual(resp, { error: 'unauthorized' });
});

test('Server Manager dispatches scripts, bulk requests, and group messages', async () => {
  const emits = [];
  const queue = [];
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
        app.get = () => {};
        app.post = () => {};
        return app;
      },
      { static: () => () => {} }
    ),
    '../Config': { Config: { Application: { Port: 0, Version: '1.0' } } },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => '/tmp/scripts',
        GetStorageDirectory: () => '/tmp',
      },
    },
    '../UpdateManager': { Manager: { RegisterRoutes: () => {} } },
    '../ClientManager': {
      Manager: {
        Get: async (uuid) => [null, { UUID: uuid, Online: true }],
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
