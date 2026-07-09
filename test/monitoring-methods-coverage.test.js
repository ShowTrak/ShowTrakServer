const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Targets branches the existing monitoring-methods suites leave uncovered:
// platform-specific ping args and its failure paths, the http protocol
// migration, the https/qlab debug renderers, tcp-port timeout/throw handling,
// and the registry's normalization/error branches.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loggerStub() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    child: () => logger,
  };
  return { CreateLogger: () => logger };
}

// --- ping --------------------------------------------------------------------

function loadPing(platform, spawnImpl) {
  return loadWithMocks(methodPath('ping.js'), {
    child_process: { spawn: spawnImpl },
    os: { platform: () => platform },
  });
}

// Emits a close event (optionally with stdout) on the next tick.
function closingSpawn(capture, { code = 0, stdout = '' } = {}) {
  return (_cmd, args) => {
    capture.args = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };
}

test('ping BuildArgs uses Windows flags and millisecond timeout on win32', async () => {
  const capture = {};
  const ping = loadPing('win32', closingSpawn(capture, { code: 0, stdout: 'time=3 ms' }));
  await ping.Run({ Address: 'host.win', Settings: { Timeout: 2500 } });
  assert.deepEqual(capture.args, ['-n', '1', '-w', '2500', 'host.win']);
});

test('ping BuildArgs uses -c/-W seconds (rounded up) on linux', async () => {
  const capture = {};
  const ping = loadPing('linux', closingSpawn(capture, { code: 0, stdout: 'time=3 ms' }));
  await ping.Run({ Address: 'host.lin', Settings: { Timeout: 2500 } });
  // 2500ms -> ceil(2.5) = 3 seconds.
  assert.deepEqual(capture.args, ['-c', '1', '-W', '3', 'host.lin']);
});

test('ping falls back to wall-clock latency when stdout has no time= field', async () => {
  const capture = {};
  const ping = loadPing('darwin', closingSpawn(capture, { code: 0, stdout: 'no timing here' }));
  const result = await ping.Run({ Address: '127.0.0.1' });
  assert.equal(result.Success, true);
  assert.equal(typeof result.LatencyMs, 'number');
  assert.ok(result.LatencyMs >= 0);
});

test('ping reports a spawn failure when child_process.spawn throws', async () => {
  const ping = loadPing('darwin', () => {
    throw new Error('EACCES');
  });
  const result = await ping.Run({ Address: '127.0.0.1' });
  assert.equal(result.Success, false);
  assert.match(result.Error, /Failed to spawn ping: EACCES/);
});

test('ping resolves a failure when the child emits an error event', async () => {
  const ping = loadPing('darwin', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  });
  const result = await ping.Run({ Address: '127.0.0.1' });
  assert.equal(result.Success, false);
  assert.match(result.Error, /spawn ENOENT/);
});

// --- http protocol migration -------------------------------------------------

test('http NormalizeSettings rewrites an invalid protocol to https and preserves valid ones', () => {
  const http = loadWithMocks(methodPath('http.js'), {});
  // Unknown protocol -> forced to https while keeping the other fields.
  const migrated = http.NormalizeSettings({ Protocol: 'ftp', Port: 8080, Path: '/x' });
  assert.equal(migrated.Protocol, 'https');
  assert.equal(migrated.Port, 8080);
  assert.equal(migrated.Path, '/x');
  // Valid protocols pass through untouched (same object reference).
  const httpCfg = { Protocol: 'http', Port: 80 };
  assert.equal(http.NormalizeSettings(httpCfg), httpCfg);
  const httpsCfg = { Protocol: 'HTTPS' };
  assert.equal(http.NormalizeSettings(httpsCfg), httpsCfg);
});

// --- https debug renderer ----------------------------------------------------

test('https Debug renders the status code and error branch', () => {
  const https = loadWithMocks(methodPath('https.js'), {});
  const ok = https.Debug(
    { Success: true, LatencyMs: 40, Status: 200 },
    { Address: 'secure.example', Settings: { Path: '/', Method: 'GET' } }
  );
  assert.equal(typeof ok, 'string');
  assert.match(ok, /HTTP 200/);

  const down = https.Debug(
    { Success: false, Error: 'certificate expired' },
    { Address: 'secure.example', Settings: {} }
  );
  assert.match(down, /certificate expired/);
});

// --- tcp-port timeout & synchronous connect failure --------------------------

// Builds a net mock whose Socket behaviour is driven by `onConnect`.
function tcpNetMock(onConnect) {
  return {
    Socket: class extends EventEmitter {
      setTimeout() {}
      destroy() {}
      connect(port, address) {
        onConnect(this, port, address);
      }
    },
  };
}

test('tcp-port reports a timeout when the socket emits timeout', async () => {
  const netMock = tcpNetMock((socket) => {
    process.nextTick(() => socket.emit('timeout'));
  });
  const tcp = loadWithMocks(methodPath('tcp-port.js'), { net: netMock });
  const result = await tcp.Run({ Address: '10.0.0.9', Settings: { Port: 3389, Timeout: 500 } });
  assert.equal(result.Success, false);
  assert.match(result.Error, /timed out after 500ms/);
});

test('tcp-port marks ECONNREFUSED as degraded via the error handler', async () => {
  const netMock = tcpNetMock((socket) => {
    process.nextTick(() => socket.emit('error', new Error('connect ECONNREFUSED 10.0.0.9:3389')));
  });
  const tcp = loadWithMocks(methodPath('tcp-port.js'), { net: netMock });
  const result = await tcp.Run({ Address: '10.0.0.9', Settings: { Port: 3389 } });
  assert.equal(result.Success, false);
  assert.equal(result.Degraded, true);
});

test('tcp-port handles a synchronous throw from Socket.connect', async () => {
  const netMock = tcpNetMock(() => {
    throw new Error('ECONNRESET immediate');
  });
  const tcp = loadWithMocks(methodPath('tcp-port.js'), { net: netMock });
  const result = await tcp.Run({ Address: '10.0.0.9', Settings: { Port: 3389 } });
  assert.equal(result.Success, false);
  assert.equal(result.Degraded, true); // ECONNRESET -> degraded
  assert.match(result.Error, /ECONNRESET immediate/);
});

// --- qlab debug branches -----------------------------------------------------

test('qlab Debug renders the unreachable and not-found branches', () => {
  const qlab = loadWithMocks(methodPath('qlab-workspace.js'), {});
  const target = { Address: '10.0.0.5', Settings: { Port: 53000, Workspace: 'Main Show' } };

  const unreachable = qlab.Debug({ Success: false, Error: 'No reply from QLab' }, target);
  assert.match(unreachable, /No reply/);
  assert.match(unreachable, /Could not reach QLab/);

  const notFound = qlab.Debug({ Success: true, Matched: false, Workspaces: [] }, target);
  assert.match(notFound, /Not found/);
  assert.match(notFound, /QLab reported no open workspaces/);
});

// --- registry (index.ts) branches -------------------------------------------

test('registry NormalizeSettings handles select and boolean field types', () => {
  const { Manager } = loadWithMocks(methodPath('index.js'), { '../Logger': loggerStub() });

  // Invalid select value falls back to the default; booleans are coerced.
  const normalized = Manager.NormalizeSettings('http', {
    Protocol: 'gopher',
    FollowRedirects: 1,
    IgnoreTlsErrors: 0,
  });
  assert.equal(normalized.Protocol, 'https'); // invalid select -> default
  assert.equal(normalized.FollowRedirects, true); // boolean coercion
  assert.equal(normalized.IgnoreTlsErrors, false);

  // A valid select value is preserved.
  assert.equal(Manager.NormalizeSettings('http', { Protocol: 'http' }).Protocol, 'http');
});

test('registry Run returns a failure result when the method throws', async () => {
  const throwingMethod = {
    ID: 'ping',
    Name: 'Ping',
    Settings: [],
    Run: async () => {
      throw new Error('method exploded');
    },
  };
  const { Manager } = loadWithMocks(methodPath('index.js'), {
    '../Logger': loggerStub(),
    './ping': throwingMethod,
  });

  const result = await Manager.Run('ping', { Address: 'x.local', Settings: {} });
  assert.equal(result.Success, false);
  assert.match(result.Error, /method exploded/);

  // Unknown method id -> descriptive failure.
  const unknown = await Manager.Run('nope', { Address: 'x' });
  assert.equal(unknown.Success, false);
  assert.match(unknown.Error, /Unknown monitoring method/);
});

test('registry BuildDebug swallows a throwing Debug renderer and returns null', () => {
  const badDebug = {
    ID: 'ping',
    Name: 'Ping',
    Settings: [],
    Run: async () => ({ Success: true }),
    Debug: () => {
      throw new Error('render boom');
    },
  };
  const { Manager } = loadWithMocks(methodPath('index.js'), {
    '../Logger': loggerStub(),
    './ping': badDebug,
  });

  assert.equal(Manager.BuildDebug('ping', {}, {}), null);
  // A method returning an empty string is also normalized to null.
  const emptyDebug = {
    ID: 'tcp-port',
    Name: 'TCP',
    Settings: [],
    Run: async () => ({ Success: true }),
    Debug: () => '',
  };
  const { Manager: M2 } = loadWithMocks(methodPath('index.js'), {
    '../Logger': loggerStub(),
    './tcp-port': emptyDebug,
  });
  assert.equal(M2.BuildDebug('tcp-port', {}, {}), null);
});
