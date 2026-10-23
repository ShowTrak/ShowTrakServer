const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

// A fresh load per test also gives each test an empty session cookie cache.
function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'analogway-livepremier.js'),
    {}
  );
}

// Shapes from the LivePremier REST API Programmer's Guide v4.0 / v4.01.
const SYSTEM = {
  type: 'AQL RS4',
  label: 'AQUILON',
  version: { major: 4, minor: 1, patch: 12, beta: false },
};
const INPUTS = {
  1: { isEnabled: true, capacity: 2, label: 'Cam PTZ', isValid: true, isFrozen: false },
  2: { isEnabled: true, capacity: 2, label: 'Laptop', isValid: false, isFrozen: false },
  3: { isEnabled: false, capacity: 0, label: 'Spare', isValid: false, isFrozen: false },
  4: { isEnabled: true, capacity: 2, label: 'Graphics', isValid: true, isFrozen: true },
};

function device({ password = null, system = SYSTEM } = {}) {
  const TOKEN = 'auth-jwt=eyJ.test.token';
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/auth/login') {
      if (req.method !== 'POST') return sendJson(res, 405, {});
      if (
        url.searchParams.get('identifier') === 'Admin' &&
        url.searchParams.get('password') === password
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': `${TOKEN}; Path=/; HttpOnly`,
        });
        return res.end('ok');
      }
      res.writeHead(401, { 'Content-Type': 'text/html' });
      return res.end('denied');
    }
    if (password && !(req.headers.cookie || '').includes(TOKEN))
      return sendJson(res, 401, { error: 'unauthorized' });
    // Actions (guide section 3): 204 on success, 404 for an unknown screen or memory.
    const load = url.pathname.match(/^\/api\/tpp\/v1\/screens\/(\d+)\/load-memory$/);
    const take = url.pathname.match(/^\/api\/tpp\/v1\/screens\/(\d+)\/take$/);
    if (load || take) {
      if (req.method !== 'POST') return sendJson(res, 405, {});
      if (Number((load || take)[1]) > 4) return sendJson(res, 404, { message: 'Unknown screen' });
      if (load && !(req.json && req.json.memoryId <= 500))
        return sendJson(res, 404, { message: 'Memory is empty' });
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'GET') return sendJson(res, 405, {});
    if (url.pathname === '/api/tpp/v1/system') return sendJson(res, 200, system);
    const m = url.pathname.match(/^\/api\/tpp\/v1\/inputs\/(\d+)$/);
    if (m && INPUTS[m[1]]) return sendJson(res, 200, INPUTS[m[1]]);
    return sendJson(res, 404, { error: 'Not Found' });
  };
}

async function withServer(handler, fn) {
  const server = await startMockServer(handler);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('analogway-livepremier: ID, Name and a Sensitive password', () => {
  const M = load();
  assert.equal(M.ID, 'analogway-livepremier');
  assert.equal(M.Name, 'Analog Way LivePremier');
  assert.equal(M.Settings.find((S) => S.Key === 'Password').Sensitive, true);
});

test('analogway-livepremier: healthy unit reads /system with one GET', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.equal(R.DeviceType, 'AQL RS4');
    assert.equal(R.DeviceLabel, 'AQUILON');
    assert.equal(R.Firmware, '4.1.12');
    assert.deepEqual(
      s.requests.map((r) => [r.method, r.url]),
      [['GET', '/api/tpp/v1/system']]
    );
  });
});

test('analogway-livepremier: input signal, disabled, missing and frozen', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    let R = await M.Run(target(s.port, { CheckInputs: true, Inputs: [1] }));
    assert.equal(R.Degraded, undefined);
    assert.equal(R.Inputs[0].Label, 'Cam PTZ');
    R = await M.Run(target(s.port, { CheckInputs: true, Inputs: ['1', '2', '3', '9', '4'] }));
    assert.equal(R.Degraded, true);
    assert.equal(
      R.DegradedReason,
      'Input 2 (Laptop): no valid signal; Input 3 (Spare): disabled; Input 9: not found'
    );
    R = await M.Run(target(s.port, { CheckInputs: true, CheckFrozen: true, Inputs: [4] }));
    assert.equal(R.DegradedReason, 'Input 4 (Graphics): frozen');
    // Inputs are only read when the check is enabled.
    const Before = s.requests.length;
    await M.Run(target(s.port, { CheckInputs: false, Inputs: [1, 2] }));
    assert.equal(s.requests.length, Before + 1);
    assert.ok(s.requests.every((r) => r.method === 'GET'));
  });
});

test('analogway-livepremier: input list is validated and capped', () => {
  const M = load();
  const { ParseInputIds, MAX_INPUTS } = M._internal;
  assert.deepEqual(ParseInputIds(['1', ' 2 ', 'x', '0', '257', '2', 3.5, 256]), [1, 2, 256]);
  const many = Array.from({ length: 300 }, (_, i) => i + 1);
  assert.equal(ParseInputIds(many).length, MAX_INPUTS);
});

test('analogway-livepremier: firmware assertion', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    let R = await M.Run(target(s.port, { CheckFirmware: true, ExpectedFirmware: 'v4.1.12' }));
    assert.equal(R.Degraded, undefined);
    R = await M.Run(target(s.port, { CheckFirmware: true, ExpectedFirmware: '4.2.0' }));
    assert.equal(R.DegradedReason, 'Firmware 4.1.12 (expected 4.2.0)');
  });
});

test('analogway-livepremier: password protected — login once, reuse the cookie', async () => {
  const M = load();
  await withServer(device({ password: 'secret' }), async (s) => {
    let R = await M.Run(target(s.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, true);
    assert.equal(R.AuthFailed, true);
    assert.match(R.DegradedReason, /password protected/);

    R = await M.Run(target(s.port, { Password: 'secret', CheckInputs: true, Inputs: [1] }));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.equal(R.DeviceType, 'AQL RS4');
    const logins = s.requests.filter((r) => r.url.startsWith('/auth/login'));
    assert.equal(logins.length, 1);
    assert.equal(logins[0].method, 'POST');

    R = await M.Run(target(s.port, { Password: 'secret' }));
    assert.equal(R.Degraded, undefined);
    assert.equal(
      s.requests.filter((r) => r.url.startsWith('/auth/login')).length,
      1,
      'cookie reused'
    );

    R = await M.Run(target(s.port, { Password: 'wrong' }));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /rejected/);
  });
});

test('analogway-livepremier: a rejected cached cookie triggers a fresh login', async () => {
  const M = load();
  await withServer(device({ password: 'secret' }), async (s) => {
    M._internal.Sessions.clear();
    await M.Run(target(s.port, { Password: 'secret' }));
    for (const Entry of M._internal.Sessions.values()) Entry.Cookie = 'auth-jwt=stale';
    const R = await M.Run(target(s.port, { Password: 'secret' }));
    assert.equal(R.Degraded, undefined);
    assert.equal(s.requests.filter((r) => r.url.startsWith('/auth/login')).length, 2);
  });
});

test('analogway-livepremier: offline on refused, wrong device, garbage and REST disabled', async () => {
  const M = load();
  const server = await startMockServer((_req, res) => sendJson(res, 200, {}));
  const port = server.port;
  await server.close();
  let R = await M.Run(target(port));
  assert.equal(R.Success, false);

  await withServer(device({ system: { status: 'ok' } }), async (s) => {
    R = await M.Run(target(s.port));
    assert.equal(R.Success, false);
    assert.match(R.Error, /not with the LivePremier/);
  });
  await withServer(
    (_req, res) => sendJson(res, 200, '<html></html>'),
    async (s) => {
      R = await M.Run(target(s.port));
      assert.equal(R.Success, false);
    }
  );
  await withServer(
    (_req, res) => sendJson(res, 404, {}),
    async (s) => {
      R = await M.Run(target(s.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /HTTP 404/);
    }
  );
});

test('analogway-livepremier: the timeout bounds the whole probe', async () => {
  const M = load();
  const inner = device();
  await withServer(
    (req, res) => setTimeout(() => inner(req, res), 200),
    async (s) => {
      const Started = Date.now();
      const R = await M.Run(
        target(s.port, { Timeout: 500, CheckInputs: true, Inputs: [1, 2, 3, 4] })
      );
      assert.ok(Date.now() - Started < 900, 'capped near the budget');
      assert.equal(R.Success, true);
      assert.equal(R.Degraded, true);
      assert.match(R.DegradedReason, /timed out/i);
    }
  );
});

test('analogway-livepremier: Debug renders inputs and offline state, escaping values', async () => {
  const M = load();
  await withServer(device({ system: { ...SYSTEM, label: '<script>' } }), async (s) => {
    const R = await M.Run(target(s.port, { CheckInputs: true, Inputs: [1, 2] }));
    const Html = M.Debug(R, target(s.port));
    assert.match(Html, /AQL RS4/);
    assert.match(Html, /4\.1\.12/);
    assert.match(Html, /Input 1 \(Cam PTZ\)/);
    assert.match(Html, /No signal/);
    assert.match(Html, /&lt;script&gt;/);
    assert.doesNotMatch(Html, /<script>/);
  });
  const Off = M.Debug({ Success: false, Error: 'ECONNREFUSED' }, { Address: '10.0.0.3' });
  assert.match(Off, /ECONNREFUSED/);
  assert.match(Off, /Application Programming Interfaces/);
});

test('analogway-livepremier: the password never appears in a login failure or a result', async () => {
  const M = load();
  // A server that drops the login connection mid-request.
  const s = await startMockServer((req, res) => {
    if (req.url.startsWith('/auth/login')) return res.socket.destroy();
    return sendJson(res, 401, {});
  });
  try {
    const R = await M.Run(target(s.port, { Password: 'pa ss/wörd' }));
    assert.equal(R.Success, false);
    assert.match(R.Error, /^Login failed: /);
    const text = JSON.stringify(R) + M.Debug(R, target(s.port));
    assert.ok(!text.includes('pa ss') && !text.includes('pa%20ss'), text);
    for (const Key of M._internal.Sessions.keys()) assert.ok(!Key.includes('pa ss'));
    // The documented login form: password in the query string, URL-encoded.
    const login = s.requests.find((r) => r.url.startsWith('/auth/login'));
    assert.equal(new URL(login.url, 'http://x').searchParams.get('password'), 'pa ss/wörd');
  } finally {
    await s.close();
  }
});

// --- Actions -----------------------------------------------------------------

test('analogway-livepremier: action set and Destructive flags', () => {
  const M = load();
  const byId = Object.fromEntries(M.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['memory.preview', 'memory.program', 'transition.take']);
  assert.ok(!byId['memory.preview'].Destructive);
  assert.equal(byId['memory.program'].Destructive, true);
  assert.equal(byId['transition.take'].Destructive, true);
  for (const a of M.Actions) assert.ok(!a.AllowedWhileOffline, a.ID);
  for (const id of ['memory.preview', 'memory.program']) {
    assert.deepEqual(
      byId[id].Params.map((p) => p.Key),
      ['Memory', 'Screens'],
      id
    );
  }
  assert.equal(byId['transition.take'].Params[0].Key, 'Screen');
});

test('analogway-livepremier: Load Memory posts load-memory per screen', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    let r = await M.RunAction(target(s.port), 'memory.preview', { Memory: 30 });
    assert.deepEqual(r, { Success: true, Detail: 'Memory 30 loaded to Preview on screen 1' });
    r = await M.RunAction(target(s.port), 'memory.program', {
      Memory: '12',
      Screens: [2, 3, 2],
    });
    assert.deepEqual(r, {
      Success: true,
      Detail: 'Memory 12 loaded to Program on screens 2, 3',
    });
    assert.deepEqual(
      s.requests.map((q) => [q.method, q.url, q.headers['content-type'], q.json]),
      [
        [
          'POST',
          '/api/tpp/v1/screens/1/load-memory',
          'application/json',
          { memoryId: 30, target: 'preview' },
        ],
        [
          'POST',
          '/api/tpp/v1/screens/2/load-memory',
          'application/json',
          { memoryId: 12, target: 'program' },
        ],
        [
          'POST',
          '/api/tpp/v1/screens/3/load-memory',
          'application/json',
          { memoryId: 12, target: 'program' },
        ],
      ]
    );
  });
});

test('analogway-livepremier: Take posts to the screen with no body', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    const r = await M.RunAction(target(s.port), 'transition.take', { Screen: 2 });
    assert.deepEqual(r, { Success: true, Detail: 'Take on screen 2' });
    assert.deepEqual(
      s.requests.map((q) => [q.method, q.url, q.body]),
      [['POST', '/api/tpp/v1/screens/2/take', '']]
    );
  });
});

test('analogway-livepremier: actions log in on a protected unit and reuse the cookie', async () => {
  const M = load();
  await withServer(device({ password: 'secret' }), async (s) => {
    let r = await M.RunAction(target(s.port), 'transition.take', { Screen: 1 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /password protected/);

    r = await M.RunAction(target(s.port, { Password: 'secret' }), 'transition.take', {
      Screen: 1,
    });
    assert.equal(r.Success, true);
    r = await M.RunAction(target(s.port, { Password: 'secret' }), 'memory.preview', {
      Memory: 1,
    });
    assert.equal(r.Success, true);
    assert.equal(s.requests.filter((q) => q.url.startsWith('/auth/login')).length, 1);

    r = await M.RunAction(target(s.port, { Password: 'nope' }), 'transition.take', {
      Screen: 1,
    });
    assert.equal(r.Success, false);
    assert.match(r.Error, /password was rejected/);
  });
});

test('analogway-livepremier: bad params never reach the unit', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    const t = target(s.port);
    const cases = [
      ['memory.preview', { Memory: 0 }, /Memory must be a whole number from 1 to 1000/],
      ['memory.preview', { Memory: 1001 }, /Memory must be/],
      ['memory.preview', { Memory: '' }, /Memory must be/],
      ['memory.preview', { Memory: 1, Screens: [] }, /Screens must be/],
      ['memory.preview', { Memory: 1, Screens: [1, 25] }, /Screens must be/],
      ['transition.take', { Screen: 0 }, /Screen must be a whole number from 1 to 24/],
      ['transition.take', { Screen: 1.5 }, /Screen must be/],
      ['transition.go', {}, /Unknown LivePremier action/],
    ];
    for (const [id, params, re] of cases) {
      const r = await M.RunAction(t, id, params);
      assert.equal(r.Success, false, `${id} ${JSON.stringify(params)}`);
      assert.match(r.Error, re);
    }
    assert.equal(s.requests.length, 0);
  });
});

test('analogway-livepremier: device refusals name the screen and memory', async () => {
  const M = load();
  await withServer(device(), async (s) => {
    let r = await M.RunAction(target(s.port), 'memory.program', { Memory: 900 });
    assert.deepEqual(r, {
      Success: false,
      Error:
        'Memory 900 not loaded on screen 1: Screen 1 or memory 900 does not exist on this unit (Memory is empty)',
    });
    r = await M.RunAction(target(s.port), 'memory.preview', { Memory: 5, Screens: [1, 9] });
    assert.equal(r.Success, false);
    assert.match(r.Error, /^Memory 5 loaded on screen 1, but not on screen 9: /);
    r = await M.RunAction(target(s.port), 'transition.take', { Screen: 7 });
    assert.match(r.Error, /^Take on screen 7 failed: Screen 7 does not exist/);
  });
  const conflict = (req, res) => sendJson(res, 409, { message: 'Screen is locked' });
  await withServer(conflict, async (s) => {
    const r = await M.RunAction(target(s.port), 'transition.take', { Screen: 1 });
    assert.equal(
      r.Error,
      'Take on screen 1 failed: The unit refused it (HTTP 409): Screen is locked'
    );
  });
});

test('analogway-livepremier: DescribeAction binds memory, screens and destination', () => {
  const M = load();
  assert.equal(
    M.DescribeAction('memory.program', { Memory: 30, Screens: [1, 2] }),
    'Load Memory 30 — Screens 1, 2 (Program)'
  );
  assert.equal(
    M.DescribeAction('memory.preview', { Memory: 4 }),
    'Load Memory 4 — Screen 1 (Preview)'
  );
  assert.equal(M.DescribeAction('transition.take', { Screen: 3 }), 'Take — Screen 3');
  assert.equal(M.DescribeAction('memory.program', { Memory: 0 }), null);
  assert.equal(M.DescribeAction('other', {}), null);
});
