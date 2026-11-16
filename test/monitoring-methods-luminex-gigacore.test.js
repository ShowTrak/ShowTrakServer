const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

// Luminex GigaCore Gen2 check. The fake switch speaks the REST shapes used by
// Luminex's own Q-SYS plugin and the Bitfocus Companion module: /api/device,
// /api/ports/port, /api/poe/capable, /api/poe/ports, PUT /api/identify and
// PUT /api/poe/ports/<n>/enabled, with HTTP Basic auth as admin.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// `https` is replaced by plain HTTP aimed at `httpsPort`, so the HTTP-then-HTTPS
// fallback can be exercised without certificates. Calls to it are recorded.
function load({ httpsPort = 1 } = {}) {
  const httpsCalls = [];
  const fakeHttps = {
    request(options) {
      httpsCalls.push(options);
      return http.request({ ...options, port: httpsPort });
    },
  };
  const method = loadWithMocks(methodPath('luminex-gigacore.js'), { https: fakeHttps });
  method._internal.Timing.PoeCycleOffMs = 20;
  method._internal.Schemes.clear();
  return { method, httpsCalls };
}

const DEVICE = {
  name: 'FOH Core',
  description: 'Stage left <rack>',
  serial: 'GC30I-0042',
  mac_address: '00:1b:2c:aa:bb:cc',
  model: 'GigaCore 30i',
};

function makePorts(overrides = {}) {
  const ports = [];
  for (let n = 1; n <= 10; n++) {
    ports.push({
      port_number: n,
      legend: `Port ${n}`,
      enabled: true,
      protected: false,
      link_state: n <= 6 ? '1gbps fdx' : 'down',
      member_of: { type: 'group', id: 1 },
      ...(overrides[n] || {}),
    });
  }
  return ports;
}

function makePoe(overrides = {}) {
  const ports = [];
  for (let n = 1; n <= 4; n++) {
    ports.push({ port_number: n, enabled: true, indication: 'sourcing', ...(overrides[n] || {}) });
  }
  return ports;
}

// A GigaCore. `password` turns on Basic auth; `state` is mutated by PUTs.
function gigacore({
  password = '',
  device = DEVICE,
  ports = makePorts(),
  poe = makePoe(),
  capable = true,
  onPut,
} = {}) {
  const state = { ports, poe, puts: [] };
  return (req, res) => {
    if (password) {
      const want = 'Basic ' + Buffer.from(`admin:${password}`).toString('base64');
      if (req.headers.authorization !== want) return sendJson(res, 401, { error: 'unauthorized' });
    }
    if (req.method === 'PUT') {
      state.puts.push({ url: req.url, json: req.json });
      if (onPut) return onPut(req, res, state);
      const match = /^\/api\/poe\/ports\/(\d+)\/enabled$/.exec(req.url);
      if (match) {
        const row = state.poe.find((p) => p.port_number === Number(match[1]));
        if (row) row.enabled = req.json;
      }
      return sendJson(res, 200, req.json === undefined ? {} : req.json);
    }
    if (req.url === '/api/device') return sendJson(res, 200, device);
    if (req.url === '/api/ports/port') return sendJson(res, 200, state.ports);
    if (req.url === '/api/poe/capable') return sendJson(res, 200, capable);
    if (req.url === '/api/poe/ports') return sendJson(res, 200, state.poe);
    return sendJson(res, 404, { error: 'not found' });
  };
}

function target(port, settings = {}) {
  return {
    Address: '127.0.0.1',
    Settings: { Protocol: 'http', Port: port, Timeout: 2000, ...settings },
  };
}

test('settings mark the password sensitive and the action params safely', () => {
  const { method } = load();
  const password = method.Settings.find((s) => s.Key === 'Password');
  assert.equal(password.Sensitive, true);
  const cycle = method.Actions.find((a) => a.ID === 'poe.cycle');
  assert.equal(cycle.Destructive, true);
  for (const p of cycle.Params) {
    assert.equal(p.Min, undefined);
    assert.equal(p.Max, undefined);
    assert.ok(p.Default === undefined || p.Default === '');
  }
  assert.ok(!method.Actions.find((a) => a.ID === 'identify').Destructive);
});

test('a healthy switch is online with its identity and link count', async (t) => {
  const server = await startMockServer(gigacore());
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port));
  assert.equal(r.Success, true);
  assert.ok(!r.Degraded);
  assert.equal(r.Model, 'GigaCore 30i');
  assert.equal(r.Serial, 'GC30I-0042');
  assert.equal(r.PortCount, 10);
  assert.equal(r.LinksUp, 6);
  assert.equal(r.Scheme, 'http');
  // Nothing monitored: only device and the port list are read.
  assert.deepEqual(
    server.requests.map((q) => q.url),
    ['/api/device', '/api/ports/port']
  );
});

test('monitored ports report disabled, linkless and missing ports', async (t) => {
  const server = await startMockServer(gigacore({ ports: makePorts({ 2: { enabled: false } }) }));
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(
    target(server.port, { CheckPorts: true, MonitoredPorts: ['1-2', '7', '42'] })
  );
  assert.equal(r.Success, true);
  assert.equal(r.Degraded, true);
  assert.equal(
    r.DegradedReason,
    'Port 2 disabled; Port 7 has no link; Port 42 not found on the switch'
  );
  assert.equal(r.PortStates.length, 4);
  assert.equal(r.PortStates[0].Problem, null);
});

test('link_state "unknown" is not a link (the Q-SYS plugin rule)', () => {
  const { method } = load();
  const { IsLinkUp } = method._internal;
  assert.equal(IsLinkUp('down'), false);
  assert.equal(IsLinkUp('unknown'), false);
  assert.equal(IsLinkUp(null), false);
  assert.equal(IsLinkUp('100mbps fdx'), true);
});

test('malformed Monitored ports entries are reported', async (t) => {
  const server = await startMockServer(gigacore());
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(
    target(server.port, { CheckPorts: true, MonitoredPorts: ['1', 'uplink', '9-3'] })
  );
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /'uplink' is not a port or range/);
  assert.match(r.DegradedReason, /'9-3' is not a port or range/);
});

test('monitored PoE ports report off, not sourcing and non-PoE ports', async (t) => {
  const server = await startMockServer(
    gigacore({
      poe: makePoe({ 2: { enabled: false, indication: 'disabled' }, 3: { indication: 'enabled' } }),
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(
    target(server.port, { CheckPoe: true, MonitoredPoePorts: ['1, 2, 3', '9'] })
  );
  assert.equal(r.Degraded, true);
  assert.equal(
    r.DegradedReason,
    'PoE off on port 2; Port 3 not sourcing PoE (enabled); Port 9 has no PoE'
  );
  assert.ok(server.requests.some((q) => q.url === '/api/poe/capable'));
});

test('a switch that is not PoE capable is degraded when PoE is monitored', async (t) => {
  const server = await startMockServer(gigacore({ capable: false }));
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port, { CheckPoe: true, MonitoredPoePorts: ['1'] }));
  assert.equal(r.DegradedReason, 'The switch is not PoE capable');
  assert.ok(!server.requests.some((q) => q.url === '/api/poe/ports'));
});

test('Basic auth: the right password works, a wrong or missing one degrades', async (t) => {
  const server = await startMockServer(gigacore({ password: 's3cret' }));
  t.after(() => server.close());
  const { method } = load();
  const ok = await method.Run(target(server.port, { Password: 's3cret' }));
  assert.equal(ok.Success, true);
  assert.ok(!ok.Degraded);
  assert.equal(
    server.requests[0].headers.authorization,
    'Basic ' + Buffer.from('admin:s3cret').toString('base64')
  );

  const wrong = await method.Run(target(server.port, { Password: 'nope' }));
  assert.deepEqual(
    [wrong.Success, wrong.Degraded, wrong.DegradedReason],
    [true, true, 'Password rejected']
  );
  const missing = await method.Run(target(server.port));
  assert.equal(missing.DegradedReason, 'The switch requires a password');
});

test('Automatic falls back to HTTPS when HTTP answers 400, and remembers it', async (t) => {
  const plain = await startMockServer((req, res) => sendJson(res, 400, 'use https'));
  const secure = await startMockServer(gigacore());
  t.after(() => Promise.all([plain.close(), secure.close()]));
  const { method, httpsCalls } = load({ httpsPort: secure.port });
  const settings = { Protocol: 'auto', Port: plain.port, Timeout: 2000 };
  const r1 = await method.Run({ Address: '127.0.0.1', Settings: settings });
  assert.equal(r1.Success, true);
  assert.equal(r1.Scheme, 'https');
  assert.equal(plain.requests.length, 1);
  assert.equal(httpsCalls[0].rejectUnauthorized, false);

  // Second probe goes straight to HTTPS.
  const r2 = await method.Run({ Address: '127.0.0.1', Settings: settings });
  assert.equal(r2.Scheme, 'https');
  assert.equal(plain.requests.length, 1);
});

test('IgnoreTlsErrors off keeps certificate checks on', async (t) => {
  const secure = await startMockServer(gigacore());
  t.after(() => secure.close());
  const { method, httpsCalls } = load({ httpsPort: secure.port });
  await method.Run({
    Address: '127.0.0.1',
    Settings: { Protocol: 'https', Port: 443, IgnoreTlsErrors: false, Timeout: 2000 },
  });
  assert.equal(httpsCalls[0].rejectUnauthorized, true);
});

test('offline: refused connection and a silent switch both fail within the timeout', async (t) => {
  const { method } = load();
  const refused = await method.Run(target(1));
  assert.equal(refused.Success, false);

  const silent = await startMockServer(() => {});
  t.after(() => silent.close());
  const started = Date.now();
  const r = await method.Run(target(silent.port, { Timeout: 600 }));
  assert.equal(r.Success, false);
  assert.match(r.Error, /No reply within/);
  assert.ok(Date.now() - started < 2000);
});

test('a device that is not a GigaCore Gen2 is offline', async (t) => {
  const server = await startMockServer((req, res) => sendJson(res, 200, { hello: 'world' }));
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port));
  assert.equal(r.Success, false);
  assert.match(r.Error, /did not answer as a GigaCore Gen2 switch/);

  const html = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>login</html>');
  });
  t.after(() => html.close());
  const r2 = await method.Run(target(html.port));
  assert.equal(r2.Success, false);
});

test('an unreadable port list degrades only when ports are monitored', async (t) => {
  const server = await startMockServer((req, res) =>
    req.url === '/api/device' ? sendJson(res, 200, DEVICE) : sendJson(res, 200, { nope: 1 })
  );
  t.after(() => server.close());
  const { method } = load();
  const plain = await method.Run(target(server.port));
  assert.equal(plain.Success, true);
  assert.ok(!plain.Degraded);
  assert.ok(plain.PortsError);
  const watched = await method.Run(
    target(server.port, { CheckPorts: true, MonitoredPorts: ['1'] })
  );
  assert.equal(watched.Degraded, true);
  assert.match(watched.DegradedReason, /Failed to read ports/);
});

test('Identify sends the documented PUT with the duration', async (t) => {
  const server = await startMockServer(gigacore({ password: 'pw' }));
  t.after(() => server.close());
  const { method } = load();
  const r = await method.RunAction(target(server.port, { Password: 'pw' }), 'identify', {
    Duration: 15,
  });
  assert.deepEqual(r, { Success: true, Detail: 'Identifying for 15 seconds' });
  const put = server.requests.find((q) => q.method === 'PUT');
  assert.equal(put.url, '/api/identify');
  assert.deepEqual(put.json, { duration: 15 });
  assert.ok(put.headers.authorization);
});

test('Power Cycle PoE switches the port off, then back on', async (t) => {
  const handler = gigacore();
  const server = await startMockServer(handler);
  t.after(() => server.close());
  const { method } = load();
  const r = await method.RunAction(target(server.port), 'poe.cycle', { Port: '3' });
  assert.deepEqual(r, { Success: true, Detail: 'PoE power cycled on port 3' });
  const puts = server.requests.filter((q) => q.method === 'PUT');
  assert.deepEqual(
    puts.map((q) => [q.url, q.body]),
    [
      ['/api/poe/ports/3/enabled', 'false'],
      ['/api/poe/ports/3/enabled', 'true'],
    ]
  );
});

test('Power Cycle PoE refuses protected, PoE-off, non-PoE and unknown ports', async (t) => {
  const server = await startMockServer(
    gigacore({
      ports: makePorts({ 1: { protected: true } }),
      poe: makePoe({ 2: { enabled: false, indication: 'disabled' } }),
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const run = (Port) => method.RunAction(target(server.port), 'poe.cycle', { Port });
  assert.match((await run('1')).Error, /protected/);
  assert.match((await run('2')).Error, /PoE is off on port 2/);
  assert.match((await run('8')).Error, /Port 8 has no PoE/);
  assert.match((await run('77')).Error, /does not exist/);
  assert.match((await run('')).Error, /Enter a port number/);
  assert.match((await run('3; reboot')).Error, /Enter a port number/);
  assert.equal(server.requests.filter((q) => q.method === 'PUT').length, 0);
});

test('Power Cycle PoE says so when the port fails to come back on', async (t) => {
  const server = await startMockServer(
    gigacore({
      onPut: (req, res, state) =>
        state.puts.length === 1 ? sendJson(res, 200, false) : sendJson(res, 500, { error: 'x' }),
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.RunAction(target(server.port), 'poe.cycle', { Port: '4' });
  assert.equal(r.Success, false);
  assert.match(r.Error, /switched off but did not come back on/);
  assert.match(r.Error, /GigaCore web interface/);
});

test('a refused PoE off write leaves the port alone', async (t) => {
  const server = await startMockServer(
    gigacore({ onPut: (req, res) => sendJson(res, 403, { error: 'forbidden' }) })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.RunAction(target(server.port), 'poe.cycle', { Port: '1' });
  assert.equal(r.Success, false);
  assert.match(r.Error, /refused to switch PoE off/);
  assert.equal(server.requests.filter((q) => q.method === 'PUT').length, 1);
});

test('DescribeAction labels a starred power cycle with its port', () => {
  const { method } = load();
  assert.equal(method.DescribeAction('poe.cycle', { Port: '7' }), 'Power Cycle PoE - Port 7');
  assert.equal(method.DescribeAction('poe.cycle', { Port: '' }), null);
  assert.equal(method.DescribeAction('identify', {}), null);
});

test('Debug escapes every value the switch sends', async (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  const server = await startMockServer(
    gigacore({
      device: { ...DEVICE, name: evil, model: evil },
      ports: makePorts({ 1: { legend: evil, link_state: evil } }),
      poe: makePoe({ 1: { indication: evil } }),
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const t1 = target(server.port, {
    CheckPorts: true,
    MonitoredPorts: ['1'],
    CheckPoe: true,
    MonitoredPoePorts: ['1'],
  });
  const r = await method.Run(t1);
  const html = method.Debug(r, t1);
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'));

  const offline = method.Debug({ Success: false, Error: evil }, t1);
  assert.ok(!offline.includes('<img'));
});

test('port lists accept ranges, spaces and commas', () => {
  const { ParsePortList, DescribePorts } = require(methodPath('_switch-shared.js'));
  assert.deepEqual(ParsePortList(['1-3', '5, 7', '9 - 10', 12]).Ports, [1, 2, 3, 5, 7, 9, 10, 12]);
  assert.deepEqual(ParsePortList(['0', 'x', '1-9999']).Invalid, ['0', 'x', '1-9999']);
  assert.equal(DescribePorts([1, 2, 3, 5, 9, 10]), '1-3, 5, 9-10');
});
