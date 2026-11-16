const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'clearcom-freespeak-ii.js'),
    {}
  );
}

// Shapes as Companion's companion-module-clearcom-freespeakii types them.
const DEVICE = { uptime: 93784, version: '4.1.2', label: 'FOH Base', state: 'running' };
const ROLES = [
  { id: 1, type: 'FSII-BP', label: 'Stage Manager' },
  { id: 2, type: 'FSII-BP', label: 'Camera 1' },
  { id: 3, type: 'FSII-BP', label: 'Spot Op' },
];
function endpoints() {
  return [
    {
      id: 101,
      device_id: 1,
      label: 'BP-101',
      type: 'FSII-BP',
      versionSW: '4.1.0',
      role: { id: 1, label: 'Stage Manager' },
      liveStatus: {
        status: 'online',
        role: 1,
        batteryLevel: 80,
        batteryType: 'Li-Ion',
        longevity: { hours: 6, minutes: 5 },
        RSSI: -52,
        linkQuality: 90,
      },
    },
    {
      id: 102,
      device_id: 1,
      label: 'BP-102',
      type: 'FSII-BP',
      role: { id: 2, label: 'Camera 1' },
      liveStatus: {
        status: 'online',
        role: 2,
        batteryLevel: 12,
        longevity: { hours: 0, minutes: 25 },
        RSSI: -80,
        linkQuality: 20,
      },
    },
    {
      id: 103,
      device_id: 1,
      label: 'BP-103',
      type: 'FSII-BP',
      role: { id: 3, label: 'Spot Op' },
      liveStatus: { status: 'offline', role: 65535 },
    },
    {
      id: 201,
      device_id: 1,
      label: 'Antenna 1',
      type: 'FSII-Antenna',
      liveStatus: { status: 'online' },
    },
  ];
}

function startBase({ device = DEVICE, eps = endpoints(), roles = ROLES, routes = {} } = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      const route = routes[req.url];
      if (route) return route(req, res);
      const send = (body, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.url === '/api/1/devices/1/liveStatus') return send(device);
      if (req.url === '/api/1/devices/1/endpoints') return send(eps);
      if (req.url === '/api/1/roles') return send(roles);
      send({ message: 'not found' }, 404);
    });
    server.on('error', () => {});
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('freespeak ii: healthy base with defaults flags only the low battery', async () => {
  const M = load();
  const { server, port, requests } = await startBase();
  try {
    const R = await M.Run(target(port));
    assert.equal(R.Success, true);
    assert.equal(R.Label, 'FOH Base');
    assert.equal(R.Firmware, '4.1.2');
    assert.equal(R.Uptime, 93784);
    assert.equal(R.BeltpacksTotal, 3);
    assert.equal(R.BeltpacksOnline, 2);
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Camera 1 \(BP-102\): battery 12%, 25 min left/);
    assert.doesNotMatch(R.DegradedReason, /Stage Manager/);
    // Link quality is opt-in.
    assert.doesNotMatch(R.DegradedReason, /link/);
    assert.ok(requests.every((r) => r.method === 'GET'));
    const Sm = R.Endpoints.find((e) => e.Id === '101');
    assert.equal(Sm.Role, 'Stage Manager');
    assert.equal(Sm.MinutesLeft, 365);
    assert.equal(Sm.Rssi, -52);
    const Antenna = R.Endpoints.find((e) => e.Id === '201');
    assert.equal(Antenna.Kind, 'Transceiver');
  } finally {
    server.close();
  }
});

test('freespeak ii: listed role offline and unknown entry are reasons', async () => {
  const M = load();
  const { server, port } = await startBase();
  try {
    const R = await M.Run(
      target(port, { Beltpacks: ['Stage Manager', 'Spot Op', 'Ghost'], CheckBattery: false })
    );
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Spot Op: offline/);
    assert.match(R.DegradedReason, /Ghost: not found on this base station/);
    assert.doesNotMatch(R.DegradedReason, /Stage Manager/);
    // Battery off: Camera 1 is not listed anyway.
    assert.doesNotMatch(R.DegradedReason, /Camera 1/);
  } finally {
    server.close();
  }
});

test('freespeak ii: matching by pack label and id, link quality threshold', async () => {
  const M = load();
  const { server, port } = await startBase();
  try {
    const R = await M.Run(
      target(port, {
        Beltpacks: ['bp-101', '102'],
        CheckBattery: false,
        CheckLinkQuality: true,
        MinLinkQuality: 50,
      })
    );
    assert.equal(R.Degraded, true);
    assert.equal(R.DegradedReason, 'Camera 1 (BP-102): link quality 20');
  } finally {
    server.close();
  }
});

test('freespeak ii: all healthy is not degraded', async () => {
  const M = load();
  const eps = endpoints().filter((e) => e.id !== 102);
  const { server, port } = await startBase({ eps });
  try {
    const R = await M.Run(target(port, { Beltpacks: ['Stage Manager'] }));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.equal(typeof R.LatencyMs, 'number');
  } finally {
    server.close();
  }
});

test('freespeak ii: offline when nothing listens', async () => {
  const M = load();
  const { server, port } = await startBase();
  await new Promise((r) => server.close(r));
  const R = await M.Run(target(port));
  assert.equal(R.Success, false);
  assert.match(R.Error, /ECONNREFUSED/);
});

test('freespeak ii: timeout is bounded by the budget', async () => {
  const M = load();
  const { server, port } = await startBase({ routes: { '/api/1/devices/1/liveStatus': () => {} } });
  try {
    const Started = Date.now();
    const R = await M.Run(target(port, { Timeout: 600 }));
    assert.equal(R.Success, false);
    assert.match(R.Error, /timed out/);
    assert.ok(Date.now() - Started < 2000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('freespeak ii: wrong device id / non-JSON / broken endpoint list', async () => {
  const M = load();
  const { server, port } = await startBase({
    routes: {
      '/api/1/devices/2/liveStatus': (_q, res) => {
        res.writeHead(200);
        res.end('<html>hello</html>');
      },
      '/api/1/devices/1/endpoints': (_q, res) => {
        res.writeHead(500);
        res.end('oops');
      },
    },
  });
  try {
    const NotFound = await M.Run(target(port, { DeviceId: 3 }));
    assert.equal(NotFound.Success, false);
    assert.match(NotFound.Error, /HTTP 404/);
    const Html = await M.Run(target(port, { DeviceId: 2 }));
    assert.equal(Html.Success, false);
    assert.match(Html.Error, /not FreeSpeak II status JSON/);
    const Broken = await M.Run(target(port));
    assert.equal(Broken.Success, true);
    assert.equal(Broken.Degraded, true);
    assert.match(Broken.DegradedReason, /beltpack list could not be read/);
  } finally {
    server.close();
  }
});

test('freespeak ii: malformed endpoint records are skipped, junk values read as unknown', async () => {
  const M = load();
  const eps = [
    null,
    'junk',
    { label: 'no id' },
    {
      id: 7,
      label: 'BP-7',
      type: 'FSII-BP',
      liveStatus: { status: 'online', batteryLevel: 'lots', longevity: 'soon', linkQuality: {} },
    },
  ];
  const { server, port } = await startBase({ eps, roles: 'nope' });
  try {
    const R = await M.Run(target(port, { CheckLinkQuality: true }));
    assert.equal(R.Success, true);
    assert.equal(R.Endpoints.length, 1);
    const E = R.Endpoints[0];
    assert.equal(E.BatteryPercent, null);
    assert.equal(E.MinutesLeft, null);
    assert.equal(E.LinkQuality, null);
    assert.equal(R.Degraded, undefined);
  } finally {
    server.close();
  }
});

test('freespeak ii: role resolution prefers the live role while online', () => {
  const M = load();
  const { FsiiRoleId } = M._internal;
  assert.equal(FsiiRoleId({ role: { id: 1 } }, { status: 'online', role: 2 }), 2);
  assert.equal(FsiiRoleId({ role: { id: 1 } }, { status: 'online', role: 65535 }), 1);
  assert.equal(FsiiRoleId({ role: { id: 1 } }, { status: 'offline', role: 2 }), 1);
  assert.equal(FsiiRoleId({ settings: { default_role: 4 } }, {}), 4);
  assert.equal(FsiiRoleId({}, {}), null);
});

test('freespeak ii: debug escapes every network-derived value', async () => {
  const M = load();
  const evil = '<img src=x onerror=alert(1)>';
  const eps = [
    {
      id: 1,
      label: evil,
      type: evil,
      versionSW: evil,
      role: { id: 9, label: evil },
      liveStatus: { status: 'online', batteryLevel: 5, batteryType: evil },
    },
  ];
  const { server, port } = await startBase({
    device: { ...DEVICE, label: evil, version: evil, state: evil },
    eps,
    roles: [{ id: 9, label: evil }],
  });
  try {
    const T = target(port, { Beltpacks: [evil, 'missing'] });
    const R = await M.Run(T);
    const Html = M.Debug(R, T);
    assert.ok(!Html.includes('<img'), Html);
    assert.ok(Html.includes('&lt;img'));
    const Off = M.Debug({ Success: false, Error: evil }, T);
    assert.ok(!Off.includes('<img'));
  } finally {
    server.close();
  }
});

test('freespeak ii: debug shows offline and empty states', () => {
  const M = load();
  const T = target(80);
  assert.match(M.Debug({ Success: false }, T), /Failed to reach the base station/);
  assert.match(M.Debug({ Success: true, Endpoints: [] }, T), /No beltpacks reported/);
});

test('freespeak ii: missing address', async () => {
  const M = load();
  const R = await M.Run({ Settings: {} });
  assert.equal(R.Success, false);
  assert.match(R.Error, /No address/);
});
