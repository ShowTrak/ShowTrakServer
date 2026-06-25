const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function loggerStub() {
  const noop = () => {};
  return {
    CreateLogger: () => ({
      log: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      trace: noop,
      success: noop,
      database: noop,
      databaseError: noop,
    }),
  };
}

function methodPath(name) {
  return path.join(__dirname, '..', 'src', 'Modules', 'MonitoringMethods', name);
}

function loadHttpMethod(name) {
  // http.js / https.js / http-json.js pull in _http-shared which only needs
  // node core modules, so no mocks are required beyond loading fresh.
  return loadWithMocks(methodPath(name), {});
}

// Start an HTTP server bound to loopback and resolve with { port, close }.
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('tcp-port method succeeds against an open port and fails on a closed one', async () => {
  const tcp = loadWithMocks(methodPath('tcp-port.js'), {});
  assert.equal(tcp.ID, 'tcp-port');
  assert.ok(Array.isArray(tcp.Settings));

  // No address configured -> immediate failure.
  assert.deepEqual((await tcp.Run({})).Success, false);

  // Invalid port -> validation failure.
  const badPort = await tcp.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.equal(badPort.Success, false);
  assert.match(badPort.Error, /Invalid port/i);

  // Open a real listening socket and probe it.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const ok = await tcp.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000 } });
  assert.equal(ok.Success, true);
  assert.equal(typeof ok.LatencyMs, 'number');

  await new Promise((resolve) => server.close(resolve));

  // Now the port is closed -> connection error.
  const closed = await tcp.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(closed.Success, false);
});

test('http method validates status ranges and follows redirects', async () => {
  const httpMethod = loadHttpMethod('http.js');
  assert.equal(httpMethod.ID, 'http');

  const server = await startServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200);
      return res.end('hello');
    }
    if (req.url === '/teapot') {
      res.writeHead(418);
      return res.end('nope');
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/ok' });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const ok = await httpMethod.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Path: '/ok' },
    });
    assert.equal(ok.Success, true);

    const outOfRange = await httpMethod.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Path: '/teapot' },
    });
    assert.equal(outOfRange.Success, false);
    assert.match(outOfRange.Error, /HTTP 418/);

    // Without FollowRedirects the 302 is out of the 200-399 default range? 302 is in range -> success.
    const redirectNoFollow = await httpMethod.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        Path: '/redirect',
        ExpectedStatusMin: 200,
        ExpectedStatusMax: 299,
      },
    });
    assert.equal(redirectNoFollow.Success, false);

    const redirectFollow = await httpMethod.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Path: '/redirect', FollowRedirects: true },
    });
    assert.equal(redirectFollow.Success, true);

    // Invalid address and disallowed method.
    assert.equal((await httpMethod.Run({ Address: '' })).Success, false);
    const badMethod = await httpMethod.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Method: 'CONNECT' },
    });
    assert.equal(badMethod.Success, false);
    assert.match(badMethod.Error, /not allowed/i);
  } finally {
    await server.close();
  }
});

test('http-json method asserts JSON paths and substring matches', async () => {
  const httpJson = loadHttpMethod('http-json.js');
  assert.equal(httpJson.ID, 'http-json');

  const server = await startServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { status: 'green' } }));
    }
    if (req.url === '/text') {
      res.writeHead(200);
      return res.end('the system is healthy');
    }
    if (req.url === '/notjson') {
      res.writeHead(200);
      return res.end('<html>not json</html>');
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const base = { Address: '127.0.0.1', Settings: { Scheme: 'http', Port: server.port } };

    // JSON path match.
    const jsonOk = await httpJson.Run({
      ...base,
      Settings: {
        ...base.Settings,
        Path: '/json',
        JsonPath: 'data.status',
        ExpectedValue: 'green',
      },
    });
    assert.equal(jsonOk.Success, true);

    // JSON path mismatch.
    const jsonBad = await httpJson.Run({
      ...base,
      Settings: { ...base.Settings, Path: '/json', JsonPath: 'data.status', ExpectedValue: 'red' },
    });
    assert.equal(jsonBad.Success, false);

    // JSON path missing.
    const jsonMissing = await httpJson.Run({
      ...base,
      Settings: { ...base.Settings, Path: '/json', JsonPath: 'data.missing' },
    });
    assert.equal(jsonMissing.Success, false);
    assert.match(jsonMissing.Error, /not found/i);

    // Invalid JSON with a JSON path configured.
    const invalidJson = await httpJson.Run({
      ...base,
      Settings: { ...base.Settings, Path: '/notjson', JsonPath: 'data.status' },
    });
    assert.equal(invalidJson.Success, false);
    assert.match(invalidJson.Error, /not valid JSON/i);

    // Substring text match.
    const textOk = await httpJson.Run({
      ...base,
      Settings: { ...base.Settings, Path: '/text', ExpectedValue: 'healthy' },
    });
    assert.equal(textOk.Success, true);

    const textBad = await httpJson.Run({
      ...base,
      Settings: { ...base.Settings, Path: '/text', ExpectedValue: 'offline' },
    });
    assert.equal(textBad.Success, false);

    // No assertion configured -> status check only.
    const statusOnly = await httpJson.Run({
      ...base,
      Settings: { ...base.Settings, Path: '/text' },
    });
    assert.equal(statusOnly.Success, true);
  } finally {
    await server.close();
  }
});

test('dns method validates record types and resolver IPs', async () => {
  // Mock the dns module so no real network lookups are performed.
  const fakeRecords = ['93.184.216.34'];
  const dnsMock = {
    promises: {
      resolve: async () => fakeRecords,
      Resolver: class {
        setServers() {}
        resolve() {
          return Promise.resolve(fakeRecords);
        }
      },
    },
    isIP: (value) => (/^\d+\.\d+\.\d+\.\d+$/.test(value) ? 4 : 0),
  };
  const dnsMethod = loadWithMocks(methodPath('dns.js'), { dns: dnsMock });
  assert.equal(dnsMethod.ID, 'dns');

  // Missing hostname.
  assert.equal((await dnsMethod.Run({})).Success, false);

  // Unsupported record type.
  const badType = await dnsMethod.Run({ Address: 'example.com', Settings: { RecordType: 'ZZZ' } });
  assert.equal(badType.Success, false);
  assert.match(badType.Error, /Unsupported record type/i);

  // Happy path with system resolver.
  const ok = await dnsMethod.Run({ Address: 'example.com', Settings: { RecordType: 'A' } });
  assert.equal(ok.Success, true);

  // Expected value match / mismatch.
  const matched = await dnsMethod.Run({
    Address: 'example.com',
    Settings: { RecordType: 'A', ExpectedValue: '93.184' },
  });
  assert.equal(matched.Success, true);
  const mismatched = await dnsMethod.Run({
    Address: 'example.com',
    Settings: { RecordType: 'A', ExpectedValue: '10.0.0.1' },
  });
  assert.equal(mismatched.Success, false);

  // Non-IP resolver is rejected.
  const badResolver = await dnsMethod.Run({
    Address: 'example.com',
    Settings: { RecordType: 'A', Resolver: 'not-an-ip' },
  });
  assert.equal(badResolver.Success, false);
  assert.match(badResolver.Error, /must be an IP/i);

  // Custom resolver IP path.
  const customResolver = await dnsMethod.Run({
    Address: 'example.com',
    Settings: { RecordType: 'A', Resolver: '1.1.1.1', ResolverPort: 53 },
  });
  assert.equal(customResolver.Success, true);
});

test('ping method reports success or failure via the spawned process', async () => {
  function loadPingWithSpawn(spawnImpl) {
    return loadWithMocks(methodPath('ping.js'), {
      child_process: { spawn: spawnImpl },
      os: { platform: () => 'darwin' },
    });
  }

  function spawnWith({ exitCode, stdout }) {
    return () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', exitCode);
      });
      return child;
    };
  }

  const pingOk = loadPingWithSpawn(spawnWith({ exitCode: 0, stdout: '64 bytes time=7.25 ms' }));
  assert.equal(pingOk.ID, 'ping');
  assert.equal((await pingOk.Run({})).Success, false);

  const ok = await pingOk.Run({ Address: '127.0.0.1', Settings: { Timeout: 3000 } });
  assert.equal(ok.Success, true);
  assert.equal(ok.LatencyMs, 7.25);

  const pingFail = loadPingWithSpawn(spawnWith({ exitCode: 1, stdout: '' }));
  const fail = await pingFail.Run({ Address: '192.0.2.1', Settings: { Timeout: 1000 } });
  assert.equal(fail.Success, false);
});

test('https method returns an invalid-address result without a network call', async () => {
  const httpsMethod = loadHttpMethod('https.js');
  assert.equal(httpsMethod.ID, 'https');
  // Empty address short-circuits before any TLS connection is attempted.
  const result = await httpsMethod.Run({ Address: '' });
  assert.equal(result.Success, false);
  assert.match(result.Error, /Invalid address/i);
});

test('http method reports connection errors against a closed port', async () => {
  const httpMethod = loadHttpMethod('http.js');
  const result = await httpMethod.Run({
    Address: '127.0.0.1',
    Settings: { Port: 1, Timeout: 800 },
  });
  assert.equal(result.Success, false);
});

test('MonitoringMethods registry exposes public shapes and normalizes settings', () => {
  const { Manager } = loadWithMocks(methodPath('index.js'), { '../Logger': loggerStub() });

  const all = Manager.GetAll();
  const ids = all.map((m) => m.ID).sort();
  assert.deepEqual(ids, ['dns', 'http', 'http-json', 'https', 'ping', 'tcp-port']);
  // Public shape strips Run().
  assert.equal(typeof all[0].Run, 'undefined');

  assert.equal(Manager.Has('ping'), true);
  assert.equal(Manager.Has('nope'), false);
  assert.equal(Manager.Get('nope'), null);

  // Normalize applies defaults and clamps numbers.
  const normalized = Manager.NormalizeSettings('tcp-port', { Port: 999999, Timeout: '' });
  assert.equal(normalized.Port, 65535);
  assert.equal(normalized.Timeout, 3000);

  // Unknown method -> empty object.
  assert.deepEqual(Manager.NormalizeSettings('nope', {}), {});
});
