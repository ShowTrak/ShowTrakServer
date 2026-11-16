const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'clearcom-arcadia.js'),
    {}
  );
}

// Shapes as Companion's companion-module-clearcom-rest reads them.
const DEVICE = {
  device_id: 1,
  device_label: 'Arcadia FOH',
  deviceType_name: 'ARCADIA',
  versionSW: '4.2.0 build 17',
  uptime: 7200,
};
const ROLESETS = [
  { id: 11, name: 'Stage Manager' },
  { id: 12, name: 'LX Op' },
  { id: 13, name: 'Sound No1' },
];
function endpoints() {
  return [
    {
      id: 1,
      label: 'E-BP 1',
      type: 'E-BP',
      liveStatus: {
        status: 'online',
        batteryLevel: 64,
        rssi: -60,
        linkQuality: 85,
        association: { dpId: 11 },
      },
    },
    {
      id: 2,
      label: 'E-BP 2',
      type: 'E-BP',
      liveStatus: {
        status: 'online',
        batteryLevel: 9,
        rssi: -88,
        linkQuality: 12,
        association: { dpId: 12 },
      },
    },
    // Offline packs lose their association and live status.
    { id: 3, label: 'E-BP 3', type: 'E-BP', liveStatus: {} },
    {
      id: 50,
      label: 'E-TCVR 1',
      type: 'E-TCVR',
      isGateway: true,
      liveStatus: { status: 'online' },
    },
  ];
}

function startStation({
  password = 'secret',
  eps = endpoints(),
  device = DEVICE,
  rolesets = ROLESETS,
  expireAfter = Infinity,
  routes = {},
} = {}) {
  return new Promise((resolve) => {
    const state = { logins: 0, requests: [], tokens: new Map() };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        const send = (obj, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
        };
        const route = routes[req.url];
        if (route) return route(req, res, body);
        if (req.url === '/auth/local/login' && req.method === 'POST') {
          let parsed = {};
          try {
            parsed = JSON.parse(body);
          } catch {
            /* bad body */
          }
          if (parsed.logemail !== 'admin' || parsed.logpassword !== password) {
            return send({ message: 'Invalid credentials' }, 401);
          }
          state.logins++;
          const jwt = `tok${state.logins}`;
          state.tokens.set(jwt, 0);
          return send({ jwt });
        }
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!state.tokens.has(token)) return send({ message: 'Unauthorized' }, 401);
        const uses = state.tokens.get(token) + 1;
        state.tokens.set(token, uses);
        if (uses > expireAfter) return send({ message: 'Unauthorized' }, 401);
        if (req.url === '/api/1/devices/1') return send(device);
        if (req.url === '/api/1/devices/endpoints') return send(eps);
        if (req.url === '/api/2/rolesets') return send(rolesets);
        send({ message: 'not found' }, 404);
      });
    });
    server.on('error', () => {});
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function target(port, settings = {}) {
  return {
    Address: '127.0.0.1',
    Settings: { Port: port, Password: 'secret', Timeout: 2000, ...settings },
  };
}

test('arcadia: signs in, reads station and beltpacks, flags low battery', async () => {
  const M = load();
  M._internal.ResetTokens();
  const { server, port, state } = await startStation();
  try {
    const R = await M.Run(target(port));
    assert.equal(R.Success, true);
    assert.equal(R.Label, 'Arcadia FOH');
    assert.equal(R.Model, 'ARCADIA');
    assert.equal(R.Firmware, '4.2.0 build 17');
    assert.equal(R.BeltpacksOnline, 2);
    assert.equal(R.BeltpacksTotal, 3);
    assert.equal(R.Degraded, true);
    assert.equal(R.DegradedReason, 'LX Op (E-BP 2): battery 9%');
    const Sm = R.Endpoints.find((e) => e.Id === '1');
    assert.equal(Sm.Role, 'Stage Manager');
    assert.equal(Sm.Rssi, -60);
    assert.equal(R.Endpoints.find((e) => e.Id === '50').Kind, 'Transceiver');
    assert.equal(state.logins, 1);
    const Gets = state.requests.filter((r) => r.method === 'GET');
    assert.ok(Gets.every((r) => r.auth === 'Bearer tok1'));
    assert.ok(state.requests.every((r) => r.method === 'GET' || r.url === '/auth/local/login'));
  } finally {
    server.close();
  }
});

test('arcadia: token is reused across runs, and a lapsed token signs in again once', async () => {
  const M = load();
  M._internal.ResetTokens();
  const { server, port, state } = await startStation({ expireAfter: 3 });
  try {
    await M.Run(target(port));
    assert.equal(state.logins, 1);
    // Second run: the cached token answers 401 (it has been used 3 times).
    const R = await M.Run(target(port));
    assert.equal(R.Success, true);
    assert.equal(state.logins, 2);
  } finally {
    server.close();
  }
});

test('arcadia: wrong password is a degraded failure, and no token is cached', async () => {
  const M = load();
  M._internal.ResetTokens();
  const { server, port } = await startStation();
  try {
    const R = await M.Run(target(port, { Password: 'nope' }));
    assert.equal(R.Success, false);
    assert.equal(R.Degraded, true);
    assert.match(R.Error, /refused the admin password/);
    assert.equal(M._internal.Tokens.size, 0);
  } finally {
    server.close();
  }
});

test('arcadia: missing password is refused before any request', async () => {
  const M = load();
  const R = await M.Run(target(1, { Password: '' }));
  assert.equal(R.Success, false);
  assert.match(R.Error, /No admin password/);
});

test('arcadia: login reply without a token', async () => {
  const M = load();
  M._internal.ResetTokens();
  const { server, port } = await startStation({
    routes: {
      '/auth/local/login': (_q, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>login page</html>');
      },
    },
  });
  try {
    const R = await M.Run(target(port));
    assert.equal(R.Success, false);
    assert.match(R.Error, /no token/);
  } finally {
    server.close();
  }
});

test('arcadia: listed roles and conditions', async () => {
  const M = load();
  M._internal.ResetTokens();
  const { server, port } = await startStation();
  try {
    const R = await M.Run(
      target(port, {
        Beltpacks: ['Stage Manager', 'Sound No1', 'E-BP 3', 'Nobody'],
        CheckBattery: false,
        CheckLinkQuality: true,
        MinLinkQuality: 50,
      })
    );
    assert.equal(R.Degraded, true);
    // Offline packs lose their role, so a listed role reads as unheld.
    assert.match(R.DegradedReason, /Sound No1: no beltpack online with this role/);
    assert.match(R.DegradedReason, /E-BP 3: offline/);
    assert.match(R.DegradedReason, /Nobody: not found on this base station/);
    // LX Op is not listed, so its poor link is not judged.
    assert.doesNotMatch(R.DegradedReason, /LX Op/);
    assert.doesNotMatch(R.DegradedReason, /Stage Manager/);
  } finally {
    server.close();
  }
});

test('arcadia: offline and timeout', async () => {
  const M = load();
  M._internal.ResetTokens();
  const { server, port } = await startStation();
  await new Promise((r) => server.close(r));
  const Off = await M.Run(target(port));
  assert.equal(Off.Success, false);
  assert.match(Off.Error, /ECONNREFUSED/);

  const Slow = await startStation({ routes: { '/auth/local/login': () => {} } });
  try {
    const Started = Date.now();
    const R = await M.Run(target(Slow.port, { Timeout: 600 }));
    assert.equal(R.Success, false);
    assert.match(R.Error, /timed out/);
    assert.ok(Date.now() - Started < 2000);
  } finally {
    Slow.server.closeAllConnections();
    Slow.server.close();
  }
});

test('arcadia: malformed device info and endpoint list', async () => {
  const M = load();
  M._internal.ResetTokens();
  const A = await startStation({ device: 'not json' });
  try {
    const R = await M.Run(target(A.port));
    assert.equal(R.Success, false);
    assert.match(R.Error, /not Clear-Com device JSON/);
  } finally {
    A.server.close();
  }
  M._internal.ResetTokens();
  const B = await startStation({ eps: { endpoints: 'nope' } });
  try {
    const R = await M.Run(target(B.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /endpoint list could not be read/);
  } finally {
    B.server.close();
  }
});

test('arcadia: token key changes with the password', () => {
  const M = load();
  const Base = new URL('http://10.0.0.5/');
  assert.notEqual(M._internal.TokenKey(Base, 'a'), M._internal.TokenKey(Base, 'b'));
  assert.ok(!M._internal.TokenKey(Base, 'hunter2').includes('hunter2'));
});

test('arcadia: debug escapes every network-derived value', async () => {
  const M = load();
  M._internal.ResetTokens();
  const evil = '"><script>alert(1)</script>';
  const { server, port } = await startStation({
    device: { device_label: evil, deviceType_name: evil, versionSW: evil, uptime: 5 },
    eps: [
      {
        id: evil,
        label: evil,
        type: evil,
        liveStatus: { status: 'online', batteryLevel: 3, association: { dpId: 1 } },
      },
      { id: 9, label: evil, isGateway: true, liveStatus: {} },
    ],
    rolesets: [{ id: 1, name: evil }],
  });
  try {
    const T = target(port, { Beltpacks: [evil] });
    const R = await M.Run(T);
    const Html = M.Debug(R, T);
    assert.ok(!Html.includes('<script>'), Html);
    assert.ok(Html.includes('&lt;script&gt;'));
    assert.ok(!M.Debug({ Success: false, Error: evil }, T).includes('<script>'));
  } finally {
    server.close();
  }
});

test('arcadia: settings mark the password sensitive and required', () => {
  const M = load();
  const Pw = M.Settings.find((s) => s.Key === 'Password');
  assert.equal(Pw.Sensitive, true);
  assert.equal(Pw.Required, true);
  assert.equal(M.Settings.find((s) => s.Key === 'IgnoreTlsErrors').Default, true);
});
