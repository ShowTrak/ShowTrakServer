const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

// Exercises src/Modules/MonitoringMethods/unifi-network.ts against a local HTTP
// server shaped like the official UniFi Network API (developer.ui.com,
// openapi.json v11.0.97): /proxy/network/integration/v1/info, /v1/sites,
// /v1/sites/{id}/devices and /v1/sites/{id}/clients, paged as
// { offset, limit, count, totalCount, data }. The address carries an http://
// scheme so no TLS is needed; the scheme on a pasted address wins.

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'unifi-network.js'),
    {}
  );
}

const KEY = 'test-key-123';
const SITE_ID = '88f7af54-98f8-306a-a1c7-c9349722b1f6';
const BASE = '/proxy/network/integration';

function device(name, state, features, extra = {}) {
  return {
    id: `id-${name}`,
    name,
    model: 'USW-Pro-24',
    macAddress: extra.macAddress || '94:2a:6f:26:c6:ca',
    ipAddress: '10.0.0.2',
    state,
    supported: true,
    firmwareVersion: '7.1.26',
    firmwareUpdatable: false,
    features,
    interfaces: ['ports'],
    ...extra,
  };
}

function page(data, total = data.length, offset = 0) {
  return { offset, limit: 200, count: data.length, totalCount: total, data };
}

function defaultDevices() {
  return [
    device('Core Switch', 'ONLINE', ['switching'], { macAddress: '00:11:22:33:44:55' }),
    device('FOH AP', 'ONLINE', ['accessPoint'], { macAddress: '00:11:22:33:44:66' }),
    device('Stage AP', 'ONLINE', ['accessPoint'], { macAddress: '00:11:22:33:44:77' }),
    device('Gateway', 'ONLINE', ['gateway', 'switching'], { macAddress: '00:11:22:33:44:88' }),
  ];
}

function api(options = {}) {
  const {
    devices = defaultDevices(),
    sites = [{ id: SITE_ID, internalReference: 'default', name: 'Default' }],
    clients = 12,
    info = { applicationVersion: '9.1.120' },
  } = options;
  return (req, res) => {
    if (req.headers['x-api-key'] !== KEY) {
      return sendJson(res, 401, {
        statusCode: 401,
        statusName: 'UNAUTHORIZED',
        code: 'api.authentication.missing-credentials',
        message: 'Missing credentials',
      });
    }
    const url = new URL(req.url, 'http://x');
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 25);
    if (url.pathname === `${BASE}/v1/info`) return sendJson(res, 200, info);
    if (url.pathname === `${BASE}/v1/sites`) return sendJson(res, 200, page(sites));
    if (url.pathname === `${BASE}/v1/sites/${SITE_ID}/devices`) {
      const slice = devices.slice(offset, offset + limit);
      return sendJson(res, 200, page(slice, devices.length, offset));
    }
    if (url.pathname === `${BASE}/v1/sites/${SITE_ID}/clients`) {
      return sendJson(res, 200, page([], clients));
    }
    return sendJson(res, 404, { statusCode: 404, message: 'Not found' });
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
  return {
    Address: 'http://127.0.0.1',
    Settings: { Port: port, ApiKey: KEY, Timeout: 2000, ...settings },
  };
}

// --- Happy path ------------------------------------------------------------

test('a healthy site is Online with version, site and counts', async () => {
  const M = load();
  await withServer(api(), async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.equal(R.Version, '9.1.120');
    assert.equal(R.SiteName, 'Default');
    assert.equal(R.Counts.Total, 4);
    assert.equal(R.Counts.Online, 4);
    assert.equal(R.Counts.AccessPointsOnline, 2);
    assert.equal(R.Counts.Switches, 2);
    assert.equal(R.Counts.Gateways, 1);
    assert.equal(R.ClientCount, null, 'clients are not read without a minimum');
    // The key travels in the X-API-KEY header and every request is a GET.
    assert.ok(server.requests.every((r) => r.method === 'GET'));
    assert.ok(server.requests.every((r) => r.headers['x-api-key'] === KEY));
    assert.ok(server.requests.some((r) => r.url.startsWith(`${BASE}/v1/sites?offset=0&limit=200`)));
  });
});

test('devices are read across pages until totalCount', async () => {
  const M = load();
  const devices = [];
  for (let i = 0; i < 450; i++) devices.push(device(`Dev ${i}`, 'ONLINE', ['switching']));
  await withServer(api({ devices }), async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.Success, true);
    assert.equal(R.Counts.Total, 450);
    const pages = server.requests.filter((r) => r.url.includes('/devices'));
    assert.equal(pages.length, 3);
  });
});

// --- Degraded conditions ------------------------------------------------------

test('a Monitored device that is offline or missing is Degraded', async () => {
  const M = load();
  const devices = defaultDevices();
  devices[1].state = 'OFFLINE';
  await withServer(api({ devices }), async (server) => {
    const R = await M.Run(
      target(server.port, {
        MonitoredDevices: ['foh ap', '00-11-22-33-44-55', 'Missing Switch'],
        CheckAllDevices: false,
      })
    );
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /FOH AP: Offline/);
    assert.match(R.DegradedReason, /Missing Switch: not adopted on this site/);
    assert.doesNotMatch(R.DegradedReason, /Core Switch/);
    const core = R.Monitored.find((m) => m.Entry === '00-11-22-33-44-55');
    assert.equal(core.Ok, true);
    assert.equal(core.Name, 'Core Switch');
  });
});

test('any device not online is Degraded unless turned off', async () => {
  const M = load();
  const devices = defaultDevices();
  devices[0].state = 'UPDATING';
  await withServer(api({ devices }), async (server) => {
    const On = await M.Run(target(server.port));
    assert.equal(On.Degraded, true);
    assert.match(On.DegradedReason, /Core Switch: Updating/);
    assert.equal(On.Counts.Transitional, 1);
    const Off = await M.Run(target(server.port, { CheckAllDevices: false }));
    assert.equal(Off.Degraded, undefined);
  });
});

test('a device named in Monitored is reported once, not twice', async () => {
  const M = load();
  const devices = defaultDevices();
  devices[0].state = 'OFFLINE';
  await withServer(api({ devices }), async (server) => {
    const R = await M.Run(target(server.port, { MonitoredDevices: ['Core Switch'] }));
    assert.equal(R.DegradedReason, 'Core Switch: Offline');
  });
});

test('access point and client minimums', async () => {
  const M = load();
  await withServer(api({ clients: 3 }), async (server) => {
    const R = await M.Run(target(server.port, { MinAccessPoints: 3, MinClients: 5 }));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /2 access points online \(expected at least 3\)/);
    assert.match(R.DegradedReason, /3 clients connected \(expected at least 5\)/);
    assert.equal(R.ClientCount, 3);
    const Ok = await M.Run(target(server.port, { MinAccessPoints: 2, MinClients: 3 }));
    assert.equal(Ok.Degraded, undefined);
  });
});

// --- Sites -------------------------------------------------------------------

test('site selection by name, internal reference, default and ambiguity', () => {
  const { SelectSite } = load()._internal;
  const A = { Id: 'a', Name: 'Main Hall', InternalReference: 'abc123' };
  const B = { Id: 'b', Name: 'Default', InternalReference: 'default' };
  assert.equal(SelectSite([A, B], 'main hall').Site, A);
  assert.equal(SelectSite([A, B], 'ABC123').Site, A);
  assert.equal(SelectSite([A, B], '').Site, B);
  assert.equal(SelectSite([A], '').Site, A);
  assert.match(SelectSite([A, { ...B, InternalReference: 'x' }], '').Error, /Several sites/);
  assert.match(SelectSite([A, B], 'Nope').Error, /No site named "Nope"/);
  assert.match(SelectSite([], '').Error, /no sites/);
});

test('an unknown site is Offline with the site list', async () => {
  const M = load();
  await withServer(api(), async (server) => {
    const R = await M.Run(target(server.port, { Site: 'Arena' }));
    assert.equal(R.Success, false);
    assert.match(R.Error, /No site named "Arena". Sites: Default/);
  });
});

// --- Offline ------------------------------------------------------------------

test('a refused key is Offline with the controller message', async () => {
  const M = load();
  await withServer(api(), async (server) => {
    const R = await M.Run(target(server.port, { ApiKey: 'wrong' }));
    assert.equal(R.Success, false);
    assert.match(R.Error, /API key refused \(HTTP 401\): Missing credentials/);
  });
});

test('a controller without the API at the path is Offline', async () => {
  const M = load();
  await withServer(api(), async (server) => {
    const R = await M.Run(target(server.port, { BasePath: 'elsewhere/' }));
    assert.equal(R.Success, false);
    assert.match(R.Error, /HTTP 404 .*does not serve the official Network API/);
    assert.equal(server.requests[0].url, '/elsewhere/v1/info');
  });
});

test('malformed replies are Offline', async () => {
  const M = load();
  await withServer(
    (req, res) => sendJson(res, 200, '<html>login</html>'),
    async (server) => {
      const R = await M.Run(target(server.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /not with the UniFi Network API/);
    }
  );
  await withServer(
    (req, res) =>
      req.url.includes('/v1/info')
        ? sendJson(res, 200, { applicationVersion: '9.0.0' })
        : sendJson(res, 200, { data: 'nope' }),
    async (server) => {
      const R = await M.Run(target(server.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /site list reply was not the documented JSON page/);
    }
  );
});

test('a controller that never answers times out within the budget', async () => {
  const M = load();
  await withServer(
    () => new Promise(() => {}),
    async (server) => {
      const Started = Date.now();
      const R = await M.Run(target(server.port, { Timeout: 600 }));
      assert.equal(R.Success, false);
      assert.match(R.Error, /timed out/);
      assert.ok(Date.now() - Started < 2000);
    }
  );
});

test('connection refused is Offline', async () => {
  const M = load();
  const server = await startMockServer(() => {});
  const port = server.port;
  await server.close();
  const R = await M.Run(target(port));
  assert.equal(R.Success, false);
  assert.ok(R.Error);
});

test('missing settings are refused before any request', async () => {
  const M = load();
  assert.match((await M.Run({ Address: '', Settings: {} })).Error, /No address/);
  assert.match((await M.Run({ Address: '10.0.0.1', Settings: {} })).Error, /No API key/);
  assert.match(
    (await M.Run({ Address: '10.0.0.1', Settings: { ApiKey: 'k', Port: 70000 } })).Error,
    /Invalid port/
  );
});

test('defaults: port 443, TLS errors ignored, UniFi OS base path', () => {
  const M = load();
  const C = M._internal.ParseConfig({ Address: '10.0.0.1', Settings: {} });
  assert.equal(C.Port, 443);
  assert.equal(C.IgnoreTlsErrors, true);
  assert.equal(C.BasePath, '/proxy/network/integration');
  assert.equal(C.CheckAllDevices, true);
  const Fields = Object.fromEntries(M.Settings.map((F) => [F.Key, F]));
  assert.equal(Fields.ApiKey.Sensitive, true);
});

// --- Debug ---------------------------------------------------------------------

test('Debug escapes every controller-derived value and never shows the key', async () => {
  const M = load();
  const evil = '<img src=x onerror=alert(1)>';
  const devices = defaultDevices();
  devices[0].name = evil;
  devices[0].state = 'OFFLINE';
  devices[0].model = `<b>${evil}</b>`;
  const sites = [{ id: SITE_ID, internalReference: 'default', name: `<script>x</script>` }];
  await withServer(
    api({ devices, sites, info: { applicationVersion: '<i>9</i>' } }),
    async (server) => {
      const T = target(server.port, { MonitoredDevices: [evil, '<u>gone</u>'] });
      const R = await M.Run(T);
      const Html = M.Debug(R, T);
      assert.ok(!Html.includes('<img'), Html);
      assert.ok(!Html.includes('<script>'));
      assert.ok(!Html.includes('<i>9'));
      assert.ok(!Html.includes('<u>gone'));
      assert.ok(!Html.includes('<b>'));
      assert.ok(Html.includes('&lt;img'));
      assert.ok(!Html.includes(KEY));
    }
  );
  const Offline = M.Debug({ Success: false, Error: '<svg onload=1>' }, target(1));
  assert.ok(!Offline.includes('<svg'));
  assert.match(Offline, /Failed to read the site/);
});

// --- Device checklist (FromDevice) -------------------------------------------

test('the site devices are offered as checkboxes for Monitored devices, by MAC', async () => {
  const M = load();
  const field = M.Settings.find((f) => f.Key === 'MonitoredDevices');
  assert.equal(field.FromDevice, true);
  const devices = defaultDevices();
  devices.push(device('Truss AP', 'OFFLINE', ['accessPoint'], { macAddress: '00:11:22:33:44:99' }));
  await withServer(api({ devices }), async (server) => {
    const R = await M.Run(target(server.port));
    const options = M.GetSettingOptions(R);
    assert.deepEqual(Object.keys(options), ['MonitoredDevices']);
    const list = options.MonitoredDevices;
    // Sorted by name; the MAC is the stored value and the name an alias, so a
    // list typed by name before still shows those devices as ticked.
    assert.deepEqual(
      list.map((o) => o.label),
      ['Core Switch', 'FOH AP', 'Gateway', 'Stage AP', 'Truss AP']
    );
    const gateway = list.find((o) => o.label === 'Gateway');
    assert.equal(gateway.value, '00:11:22:33:44:88');
    assert.deepEqual(gateway.aliases, ['Gateway']);
    assert.equal(gateway.detail, 'USW-Pro-24 · Gateway, Switch · 00:11:22:33:44:88');
    // A device that is not online says so.
    assert.match(list.find((o) => o.label === 'Truss AP').detail, /Offline/);
  });
});

test('no site devices in a result means an empty checklist, and junk is skipped', () => {
  const M = load();
  assert.deepEqual(M.GetSettingOptions({ Success: false }), { MonitoredDevices: [] });
  const options = M.GetSettingOptions({
    Success: true,
    SiteDevices: [null, 'x', { Name: '', Mac: '' }, { Name: 'Unnamed', Mac: '' }],
  });
  assert.deepEqual(options.MonitoredDevices, [{ value: 'Unnamed', label: 'Unnamed' }]);
});
