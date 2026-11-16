const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

// Netgear AV Line check. The fake switch follows the M4300 ConfigAgent OpenAPI
// spec (2.0.0.59) and the Bitfocus Companion module: POST /api/v1/login for a
// bearer token, a resp envelope on every reply, and the firmware habit of
// reporting a dead token as a 200 with a failure envelope.

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// The API is HTTPS only; `https` is swapped for plain HTTP so the fake switch
// needs no certificate. Calls are recorded to check the TLS option.
function load() {
  const httpsCalls = [];
  const fakeHttps = {
    request(options) {
      httpsCalls.push(options);
      return http.request(options);
    },
  };
  const method = loadWithMocks(methodPath('netgear-av.js'), { https: fakeHttps });
  method._internal.Tokens.clear();
  return { method, httpsCalls };
}

const OK = { status: 'success', respCode: 0, respMsg: 'Operation success' };

function deviceInfo(overrides = {}) {
  return {
    name: 'AV Core 1',
    serialNumber: 'N1MN648000T',
    model: 'M4250-26G4XF-PoE+',
    swVer: '13.0.4.26',
    upTime: '00 Days 03 Hrs 32 Mins 08 Secs',
    numOfPorts: 30,
    numOfActivePorts: 8,
    fanState: [{ fan1: 'Operational' }],
    temperatureSensors: [{ sensorNum: 1, sensorDesc: 'MAC', sensorTemp: 48, sensorState: 1 }],
    adminPoePower: 480000,
    ...overrides,
  };
}

function portStats(overrides = {}) {
  const rows = [];
  for (let n = 1; n <= 8; n++) {
    rows.push({
      portId: n,
      status: n <= 6 ? 0 : 1,
      speed: n <= 6 ? 7 : 1,
      ...(overrides[n] || {}),
    });
  }
  return rows;
}

function poePorts(overrides = {}) {
  const rows = [];
  for (let n = 1; n <= 4; n++) {
    rows.push({
      portid: n,
      enable: true,
      powerLimitMode: 1,
      classification: 1,
      currentPower: 6500,
      powerLimit: 30000,
      status: 2,
      reset: false,
      ...(overrides[n] || {}),
    });
  }
  return rows;
}

// A switch. Options:
//   expires     token lifetime reported at login (seconds)
//   badToken    'http401' | 'envelope': how a rejected token is reported
//   rejectAll   reject every token (so re-login cannot help)
//   info/stats/poe/poeConfig/queriers  reply data
function netgear(options = {}) {
  const {
    username = 'admin',
    password = 'pw',
    expires = 600,
    badToken = 'envelope',
    info = deviceInfo(),
    stats = portStats(),
    poe = poePorts(),
    poeConfig = { pseMainOperationStatus: 'ON', totalPowerConsumedWatts: '120.5' },
    queriers = {},
    onPoeWrite,
  } = options;
  const state = { issued: [], valid: new Set(), logins: 0 };
  const handler = (req, res) => {
    if (req.url === '/api/v1/login' && req.method === 'POST') {
      state.logins++;
      const login = req.json && req.json.login;
      if (!login || login.username !== username || login.password !== password) {
        return sendJson(res, 200, {
          resp: { status: 'failure', respCode: 1, respMsg: 'Invalid username or password' },
        });
      }
      const token = `tok-${state.logins}`;
      state.issued.push(token);
      if (!options.rejectAll) state.valid.add(token);
      return sendJson(res, 200, { resp: OK, login: { token, expires } });
    }
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!state.valid.has(token)) {
      if (badToken === 'http401') return sendJson(res, 401, { resp: { status: 'failure' } });
      return sendJson(res, 200, {
        resp: { status: 'failure', respCode: 2, respMsg: 'Invalid token or session expired' },
      });
    }
    const url = req.url.replace(/^\/api\/v1\//, '');
    if (url === 'device_info') return sendJson(res, 200, { resp: OK, deviceInfo: info });
    if (url === 'sw_portstats?portid=ALL')
      return sendJson(res, 200, { resp: OK, switchStatsPort: stats });
    if (url === 'swcfg_poe?portid=ALL' && req.method === 'GET')
      return sendJson(res, 200, { resp: OK, poePortConfig: poe });
    if (url.startsWith('swcfg_poe?portid=') && req.method === 'POST') {
      if (onPoeWrite) return onPoeWrite(req, res);
      return sendJson(res, 200, { resp: OK });
    }
    if (url === 'poe_config') return sendJson(res, 200, { resp: OK, poe_config: poeConfig });
    const q = /^snooping_queriers\?family=igmp&vlanid=(\d+)$/.exec(url);
    if (q) {
      const entry = queriers[q[1]];
      if (!entry) {
        return sendJson(res, 200, { resp: { status: 'failure', respMsg: 'VLAN does not exist' } });
      }
      return sendJson(res, 200, { resp: OK, snooping_queriers: entry });
    }
    return sendJson(res, 200, { resp: { status: 'failure', respMsg: 'Unsupported endpoint' } });
  };
  handler.state = state;
  return handler;
}

function target(port, settings = {}) {
  return {
    Address: '127.0.0.1',
    Settings: { Port: port, Username: 'admin', Password: 'pw', Timeout: 2000, ...settings },
  };
}

test('settings: password sensitive, destructive action params unclamped', () => {
  const { method } = load();
  assert.equal(method.Settings.find((s) => s.Key === 'Password').Sensitive, true);
  const cycle = method.Actions.find((a) => a.ID === 'poe.cycle');
  assert.equal(cycle.Destructive, true);
  for (const p of cycle.Params) {
    assert.equal(p.Min, undefined);
    assert.equal(p.Max, undefined);
    assert.ok(p.Default === undefined || p.Default === '');
  }
});

test('logs in, reads device_info and reports identity', async (t) => {
  const sw = netgear();
  const server = await startMockServer(sw);
  t.after(() => server.close());
  const { method, httpsCalls } = load();
  const r = await method.Run(target(server.port));
  assert.equal(r.Success, true, r.Error);
  assert.ok(!r.Degraded, r.DegradedReason);
  assert.equal(r.Model, 'M4250-26G4XF-PoE+');
  assert.equal(r.Firmware, '13.0.4.26');
  assert.equal(r.FanState, 'Operational');
  assert.deepEqual(server.requests[0].json, { login: { username: 'admin', password: 'pw' } });
  assert.equal(server.requests[1].headers.authorization, 'Bearer tok-1');
  assert.equal(httpsCalls[0].rejectUnauthorized, false);
});

test('the token is reused across probes rather than logging in each time', async (t) => {
  const sw = netgear();
  const server = await startMockServer(sw);
  t.after(() => server.close());
  const { method } = load();
  await method.Run(target(server.port));
  await method.Run(target(server.port));
  await method.Run(target(server.port));
  assert.equal(sw.state.logins, 1);
});

test('a token the switch dropped is replaced with one re-login (envelope and 401)', async (t) => {
  for (const badToken of ['envelope', 'http401']) {
    const sw = netgear({ badToken });
    const server = await startMockServer(sw);
    t.after(() => server.close());
    const { method } = load();
    await method.Run(target(server.port));
    sw.state.valid.clear(); // switch rebooted, or someone logged in elsewhere
    const r = await method.Run(target(server.port));
    assert.equal(r.Success, true, `${badToken}: ${r.Error}`);
    assert.ok(!r.Degraded);
    assert.equal(sw.state.logins, 2);
  }
});

test('a token about to expire is renewed before use', async (t) => {
  const sw = netgear({ expires: 1 });
  const server = await startMockServer(sw);
  t.after(() => server.close());
  const { method } = load();
  await method.Run(target(server.port));
  // Lifetime 1 s: within half the lifetime of expiry, so the next probe logs in.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await method.Run(target(server.port));
  assert.equal(sw.state.logins, 2);
  assert.equal(
    method._internal.TokenIsStale({ ExpiresAt: null, LifetimeMs: 0 }, Date.now()),
    false
  );
});

test('a token that is refused straight after login does not loop', async (t) => {
  const sw = netgear({ rejectAll: true });
  const server = await startMockServer(sw);
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port));
  assert.equal(r.Success, true);
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /rejected the login token/);
  assert.equal(sw.state.logins, 1);
});

test('wrong credentials degrade with the switch’s message; none configured is offline', async (t) => {
  const server = await startMockServer(netgear());
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port, { Password: 'wrong' }));
  assert.deepEqual(
    [r.Success, r.Degraded, r.DegradedReason],
    [true, true, 'Login rejected: Invalid username or password']
  );
  const none = await method.Run(target(server.port, { Password: '' }));
  assert.equal(none.Success, false);
  assert.equal(none.Error, 'No password configured');
});

test('a changed password never reuses the old token', async (t) => {
  const sw = netgear();
  const server = await startMockServer(sw);
  t.after(() => server.close());
  const { method } = load();
  await method.Run(target(server.port));
  const r = await method.Run(target(server.port, { Password: 'other' }));
  assert.equal(r.Degraded, true);
  assert.equal(sw.state.logins, 2);
});

test('offline when unreachable or silent, within the timeout', async (t) => {
  const { method } = load();
  const refused = await method.Run(target(1));
  assert.equal(refused.Success, false);

  const silent = await startMockServer(() => {});
  t.after(() => silent.close());
  const started = Date.now();
  const r = await method.Run(target(silent.port, { Timeout: 1000 }));
  assert.equal(r.Success, false);
  assert.match(r.Error, /No reply within/);
  assert.ok(Date.now() - started < 2500);
});

test('not this API: HTML, or a login reply with no token, is offline', async (t) => {
  const html = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html></html>');
  });
  t.after(() => html.close());
  const { method } = load();
  const r = await method.Run(target(html.port));
  assert.equal(r.Success, false);
  assert.match(r.Error, /no token/);

  const odd = await startMockServer((req, res) =>
    req.url === '/api/v1/login'
      ? sendJson(res, 200, { resp: OK, login: { token: 't', expires: 600 } })
      : sendJson(res, 200, { resp: OK, something: 'else' })
  );
  t.after(() => odd.close());
  const r2 = await method.Run(target(odd.port));
  assert.equal(r2.Success, false);
  assert.match(r2.Error, /did not answer as a Netgear AV Line switch/);
});

test('monitored ports: no link, below minimum speed, and missing', async (t) => {
  const server = await startMockServer(netgear({ stats: portStats({ 3: { speed: 3 } }) }));
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(
    target(server.port, {
      CheckPorts: true,
      MonitoredPorts: ['1-3', '7', '40'],
      MinimumSpeed: '1000',
    })
  );
  assert.equal(r.Degraded, true);
  assert.equal(
    r.DegradedReason,
    'Port 3 at 100 Mb/s (minimum 1 Gb/s); Port 7 has no link; Port 40 not found on the switch'
  );
});

test('monitored PoE ports: off, fault, overload and searching', async (t) => {
  const server = await startMockServer(
    netgear({
      poe: poePorts({
        1: { enable: false, status: 0 },
        2: { status: 4 },
        3: { status: 7 },
        4: { status: 1 },
      }),
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port, { CheckPoe: true, MonitoredPoePorts: ['1-4'] }));
  assert.equal(r.Degraded, true);
  assert.equal(
    r.DegradedReason,
    'PoE off on port 1; Port 2 PoE fault; Port 3 PoE overload; Port 4 PoE searching'
  );
});

test('PoE budget: over the alert share, and PoE off switch-wide', async (t) => {
  const server = await startMockServer(
    netgear({ poeConfig: { pseMainOperationStatus: 'OFF', totalPowerConsumedWatts: '450.0' } })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port, { CheckPoeBudget: true, PoeBudgetPercent: 90 }));
  assert.equal(r.Degraded, true);
  assert.equal(
    r.DegradedReason,
    'PoE is off for the whole switch; PoE draw 450 W is 94% of the 480 W budget (alert above 90%)'
  );

  const fine = await startMockServer(netgear());
  t.after(() => fine.close());
  const ok = await method.Run(target(fine.port, { CheckPoeBudget: true, PoeBudgetPercent: 90 }));
  assert.ok(!ok.Degraded, ok.DegradedReason);
  assert.equal(ok.PoeUsedPercent, 25.1);
});

test('temperature: warning and critical sensors degrade; one bare object is accepted', async (t) => {
  const server = await startMockServer(
    netgear({
      info: deviceInfo({
        temperatureSensors: [
          { sensorNum: 1, sensorDesc: 'MAC', sensorTemp: 71, sensorState: 2 },
          { sensorNum: 2, sensorDesc: 'PHY', sensorTemp: 90, sensorState: 3 },
          { sensorNum: 3, sensorDesc: 'CPU', sensorTemp: 40, sensorState: 1 },
        ],
      }),
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port, { CheckTemperature: true }));
  assert.equal(r.DegradedReason, 'MAC warning (71 °C); PHY critical (90 °C)');

  const parsed = method._internal.ParseDeviceInfo({
    deviceInfo: {
      temperatureSensors: { sensorNum: 1, sensorTemp: 50, sensorState: 1 },
      fanState: 'active',
    },
  });
  assert.equal(parsed.Sensors.length, 1);
  assert.equal(parsed.FanState, 'active');
});

test('IGMP querier per VLAN: active, absent and unreadable', async (t) => {
  const server = await startMockServer(
    netgear({
      queriers: {
        1: { operState: 'querier', lastQuerierAddress: '0.0.0.0', adminMode: 'enabled' },
        20: { operState: 'non-querier', lastQuerierAddress: '10.20.0.1', adminMode: 'enabled' },
        30: { operState: 'disabled', lastQuerierAddress: '0.0.0.0', adminMode: 'disabled' },
      },
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(
    target(server.port, { CheckQuerier: true, QuerierVlans: [1, '20', 30, 99] })
  );
  assert.equal(r.Degraded, true);
  assert.equal(
    r.DegradedReason,
    'No IGMP querier on VLAN 30; Failed to read the querier on VLAN 99: snooping_queriers?family=igmp&vlanid=99 failed: VLAN does not exist'
  );
  assert.deepEqual(
    r.Queriers.map((q) => q.Active),
    [true, true, false, false]
  );
});

test('an unsupported endpoint degrades with the switch’s message, not a re-login', async (t) => {
  const sw = netgear();
  const server = await startMockServer((req, res) =>
    req.url.startsWith('/api/v1/sw_portstats')
      ? sendJson(res, 200, { resp: { status: 'failure', respMsg: 'Invalid portid' } })
      : sw(req, res)
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.Run(target(server.port, { CheckPorts: true, MonitoredPorts: ['1'] }));
  assert.equal(r.Degraded, true);
  assert.match(r.DegradedReason, /Failed to read ports: .*Invalid portid/);
  assert.equal(sw.state.logins, 1);
});

test('Power Cycle PoE writes the port’s whole config back with reset: true', async (t) => {
  const sw = netgear();
  const server = await startMockServer(sw);
  t.after(() => server.close());
  const { method } = load();
  const r = await method.RunAction(target(server.port), 'poe.cycle', { Port: '2' });
  assert.deepEqual(r, { Success: true, Detail: 'PoE power cycled on port 2' });
  const write = server.requests.find((q) => q.method === 'POST' && q.url.includes('swcfg_poe'));
  assert.equal(write.url, '/api/v1/swcfg_poe?portid=2');
  assert.deepEqual(write.json, {
    poePortConfig: {
      enable: true,
      powerLimitMode: 1,
      classification: 1,
      currentPower: 6500,
      powerLimit: 30000,
      status: 2,
      reset: true,
    },
  });
});

test('Power Cycle PoE refuses PoE-off and non-PoE ports, and bad input', async (t) => {
  const server = await startMockServer(netgear({ poe: poePorts({ 1: { enable: false } }) }));
  t.after(() => server.close());
  const { method } = load();
  const run = (Port) => method.RunAction(target(server.port), 'poe.cycle', { Port });
  assert.match((await run('1')).Error, /PoE is off on port 1/);
  assert.match((await run('9')).Error, /Port 9 has no PoE/);
  assert.match((await run('ALL')).Error, /Enter a port number/);
  assert.equal(
    server.requests.filter((q) => q.method === 'POST' && q.url.includes('swcfg_poe')).length,
    0
  );
});

test('Power Cycle PoE reports the switch’s refusal', async (t) => {
  const server = await startMockServer(
    netgear({
      onPoeWrite: (req, res) =>
        sendJson(res, 200, { resp: { status: 'failure', respMsg: 'Permission denied' } }),
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const r = await method.RunAction(target(server.port), 'poe.cycle', { Port: '2' });
  assert.equal(r.Success, false);
  assert.match(r.Error, /Permission denied/);
});

test('Debug escapes every value the switch sends', async (t) => {
  const evil = '<script>alert(1)</script>';
  const server = await startMockServer(
    netgear({
      info: deviceInfo({
        name: evil,
        model: evil,
        swVer: evil,
        fanState: evil,
        temperatureSensors: [{ sensorNum: 1, sensorDesc: evil, sensorTemp: 40, sensorState: 1 }],
      }),
      queriers: { 1: { operState: evil, lastQuerierAddress: evil } },
    })
  );
  t.after(() => server.close());
  const { method } = load();
  const t1 = target(server.port, {
    CheckPorts: true,
    MonitoredPorts: ['1'],
    CheckPoe: true,
    MonitoredPoePorts: ['1'],
    CheckQuerier: true,
    QuerierVlans: [1],
  });
  const r = await method.Run(t1);
  const html = method.Debug(r, t1);
  assert.ok(!html.includes('<script'), html);
  assert.ok(html.includes('&lt;script'));
  assert.ok(!method.Debug({ Success: false, Error: evil }, t1).includes('<script'));
});
