const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

// Blackmagic camera check against a local mock of the Camera Control REST API,
// shaped from "REST API for Blackmagic Cameras" (August 2025).

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'blackmagic-camera.js'),
    {}
  );
}

const API = '/control/api/v1';

// A healthy URSA Broadcast G2: recording to CFast slot 1, SD slot 2 empty.
function routes(overrides = {}) {
  return {
    '/system/product': {
      deviceName: 'Cam 1',
      productName: 'Blackmagic URSA Broadcast G2',
      softwareVersion: '9.2',
    },
    '/system': {
      codecFormat: { codec: 'BRaw:Q0', container: 'BRaw' },
      videoFormat: {
        name: '1080p25',
        frameRate: '25',
        width: 1920,
        height: 1080,
        interlaced: false,
      },
    },
    '/transports/0': { mode: 'InputRecord' },
    '/transports/0/record': { recording: true },
    '/transports/0/timecode': { display: '10:00:00:00', timeline: '00:00:00:00' },
    '/media/workingset': {
      size: 2,
      workingset: [
        {
          volume: 'CFAST-A',
          deviceName: 'cfast1',
          remainingRecordTime: 3600,
          totalSpace: 256e9,
          remainingSpace: 128e9,
          clipCount: 4,
        },
        null,
      ],
    },
    '/media/active': { workingsetIndex: 0, deviceName: 'cfast1' },
    '/camera/power': {
      source: 'AC',
      milliVolt: 12000,
      batteries: [],
    },
    '/camera/tallyStatus': { status: 'Program' },
    '/camera/timingReferenceLock': { locked: true },
    ...overrides,
  };
}

// Serves routes(); a value of a number is sent as that bare status, a
// function is called as a handler.
async function withCamera(table, fn) {
  const server = await startMockServer((req, res) => {
    const key = req.url.startsWith(API) ? req.url.slice(API.length) : null;
    const value =
      key != null && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 404;
    if (typeof value === 'function') return value(req, res);
    if (typeof value === 'number') {
      res.writeHead(value);
      return res.end();
    }
    return sendJson(res, 200, value);
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('a healthy camera reads every documented field', async () => {
  const cam = load();
  await withCamera(routes(), async (server) => {
    const r = await cam.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined);
    assert.equal(r.ProductName, 'Blackmagic URSA Broadcast G2');
    assert.equal(r.DeviceName, 'Cam 1');
    assert.equal(r.SoftwareVersion, '9.2');
    assert.equal(r.VideoFormat, '1080p25');
    assert.equal(r.Codec, 'BRaw:Q0');
    assert.equal(r.Recording, true);
    assert.equal(r.TransportMode, 'InputRecord');
    assert.equal(r.Timecode, '10:00:00:00');
    assert.equal(r.ActiveSlot, 1);
    assert.equal(r.Slots.length, 2);
    assert.equal(r.Slots[0].Present, true);
    assert.equal(r.Slots[0].RemainingRecordSec, 3600);
    assert.equal(r.Slots[1].Present, false);
    assert.equal(r.Tally, 'Program');
    assert.equal(r.ReferenceLocked, true);
    assert.equal(r.PowerSource, 'AC');
    // Every read is a GET under the API root.
    assert.ok(server.requests.every((q) => q.method === 'GET' && q.url.startsWith(API)));
  });
});

test('no media inserted is degraded by default', async () => {
  const cam = load();
  const table = routes({
    '/media/workingset': { size: 2, workingset: [null, null] },
    '/media/active': 204,
  });
  await withCamera(table, async (server) => {
    const r = await cam.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /No media inserted/);
  });
});

test('media present but none active is degraded', async () => {
  const cam = load();
  await withCamera(routes({ '/media/active': 204 }), async (server) => {
    const r = await cam.Run(target(server.port));
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'No active media slot');
  });
});

test('Require media off accepts an empty camera', async () => {
  const cam = load();
  const table = routes({
    '/media/workingset': { size: 1, workingset: [null] },
    '/media/active': 204,
  });
  await withCamera(table, async (server) => {
    const r = await cam.Run(target(server.port, { RequireMedia: false }));
    assert.equal(r.Degraded, undefined);
  });
});

test('Check recording flags a camera that is not rolling', async () => {
  const cam = load();
  const table = routes({
    '/transports/0': { mode: 'InputPreview' },
    '/transports/0/record': { recording: false },
  });
  await withCamera(table, async (server) => {
    const quiet = await cam.Run(target(server.port));
    assert.equal(quiet.Degraded, undefined, 'recording is not checked by default');
    const r = await cam.Run(target(server.port, { CheckRecording: true }));
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Not recording');
  });
});

test('recording time left below the minimum is degraded, per scope', async () => {
  const cam = load();
  const table = routes({
    '/media/workingset': {
      size: 2,
      workingset: [
        { volume: 'A', deviceName: 'a', remainingRecordTime: 600 },
        { volume: 'B', deviceName: 'b', remainingRecordTime: 1200 },
      ],
    },
  });
  await withCamera(table, async (server) => {
    const active = await cam.Run(
      target(server.port, { CheckRecordTime: true, MinRecordMinutes: 15 })
    );
    assert.equal(active.Degraded, true);
    assert.equal(active.DegradedReason, 'Slot 1: 10 min recording time left (minimum 15)');
    assert.equal(active.RecordTimeLeftSec, 600);

    const all = await cam.Run(
      target(server.port, { CheckRecordTime: true, MinRecordMinutes: 15, RecordTimeScope: 'all' })
    );
    assert.equal(all.Degraded, undefined);
    assert.equal(all.RecordTimeLeftSec, 1800);
  });
});

test('format and codec assertions compare without regard to case', async () => {
  const cam = load();
  await withCamera(routes(), async (server) => {
    const ok = await cam.Run(
      target(server.port, {
        CheckFormat: true,
        ExpectedVideoFormat: '1080P25',
        ExpectedCodec: 'braw:q0',
      })
    );
    assert.equal(ok.Degraded, undefined);
    const bad = await cam.Run(
      target(server.port, { CheckFormat: true, ExpectedVideoFormat: '2160p50' })
    );
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'Format 1080p25 (expected 2160p50)');
  });
});

test('Check power flags low batteries and an unexpected source', async () => {
  const cam = load();
  const table = routes({
    '/camera/power': {
      source: 'Battery',
      milliVolt: 14200,
      batteries: [
        { milliVolt: 14200, chargeRemainingPercent: 12, statusFlags: ['Battery Is Present'] },
        {
          milliVolt: 13000,
          chargeRemainingPercent: 50,
          statusFlags: ['Battery Is Present', 'Battery Is Critically Low'],
        },
      ],
    },
  });
  await withCamera(table, async (server) => {
    const r = await cam.Run(
      target(server.port, { CheckPower: true, MinBatteryPercent: 20, ExpectedPowerSource: 'AC' })
    );
    assert.equal(r.Degraded, true);
    assert.equal(
      r.DegradedReason,
      'Power source Battery (expected AC); Battery 1 at 12% (minimum 20%); Battery 2 critically low'
    );
  });
});

test('older firmware without the power or reference API is skipped unless asked for', async () => {
  const cam = load();
  const table = routes({ '/camera/power': 404, '/camera/timingReferenceLock': 404 });
  await withCamera(table, async (server) => {
    const r = await cam.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined);
    assert.equal(r.Batteries, null);
    const asked = await cam.Run(
      target(server.port, { CheckPower: true, CheckReferenceLock: true })
    );
    assert.equal(asked.DegradedReason, 'Power status not reported; Reference lock not reported');
  });
});

test('lost reference lock is degraded when checked', async () => {
  const cam = load();
  await withCamera(routes({ '/camera/timingReferenceLock': { locked: false } }), async (server) => {
    const r = await cam.Run(target(server.port, { CheckReferenceLock: true }));
    assert.equal(r.DegradedReason, 'Not locked to reference');
  });
});

test('a 404 at the API root (Web Media Manager off) is offline with a hint', async () => {
  const cam = load();
  await withCamera({}, async (server) => {
    const r = await cam.Run(target(server.port));
    assert.equal(r.Success, false);
    assert.match(r.Error, /HTTP 404/);
    assert.match(r.Error, /Web Media Manager/);
  });
});

test('a product reply that is not JSON is offline', async () => {
  const cam = load();
  const table = routes({
    '/system/product': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>router login</html>');
    },
  });
  await withCamera(table, async (server) => {
    const r = await cam.Run(target(server.port));
    assert.equal(r.Success, false);
    assert.match(r.Error, /not as the Blackmagic camera REST API/);
  });
});

test('a 501 for the product call still reads the camera', async () => {
  const cam = load();
  await withCamera(routes({ '/system/product': 501 }), async (server) => {
    const r = await cam.Run(target(server.port));
    assert.equal(r.Success, true);
    assert.equal(r.ProductName, null);
  });
});

test('malformed working set and record replies degrade rather than crash', async () => {
  const cam = load();
  const table = routes({
    '/media/workingset': { size: 'two', workingset: 'nope' },
    '/transports/0/record': ['not', 'an', 'object'],
  });
  await withCamera(table, async (server) => {
    const r = await cam.Run(target(server.port, { CheckRecording: true }));
    assert.equal(r.Success, true);
    assert.equal(r.DegradedReason, 'Failed to read media status; Failed to read recording state');
  });
});

test('a camera that stops answering mid-probe is offline within the budget', async () => {
  const cam = load();
  const table = routes({ '/media/workingset': () => {} });
  await withCamera(table, async (server) => {
    const started = Date.now();
    const r = await cam.Run(target(server.port, { Timeout: 600 }));
    assert.equal(r.Success, false);
    assert.match(r.Error, /stopped answering/);
    assert.ok(Date.now() - started < 1500);
  });
});

test('nothing listening is offline', async () => {
  const cam = load();
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const r = await cam.Run(target(port));
  assert.equal(r.Success, false);
  assert.match(r.Error, /ECONNREFUSED/);
});

test('no address is reported, not thrown', async () => {
  const r = await load().Run({ Address: '', Settings: {} });
  assert.deepEqual(r, { Success: false, Error: 'No address configured' });
});

// --- Actions -------------------------------------------------------------------

test('Stop Recording is the destructive action and neither takes params', () => {
  const cam = load();
  const byId = Object.fromEntries(cam.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['record.start', 'record.stop']);
  assert.equal(byId['record.stop'].Destructive, true);
  assert.ok(!byId['record.start'].Destructive);
  for (const a of cam.Actions) assert.equal(a.Params, undefined);
});

test('Start Recording POSTs to the record endpoint', async () => {
  const cam = load();
  const table = routes({
    '/transports/0/record': (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { recording: false });
      res.writeHead(req.method === 'POST' ? 204 : 400);
      res.end();
    },
  });
  await withCamera(table, async (server) => {
    const r = await cam.RunAction(target(server.port), 'record.start', {});
    assert.deepEqual(r, { Success: true, Detail: 'Recording started' });
    assert.deepEqual(
      server.requests.map((q) => `${q.method} ${q.url}`),
      [`GET ${API}/transports/0/record`, `POST ${API}/transports/0/record`]
    );
  });
});

test('Start Recording falls back to the deprecated PUT on older firmware', async () => {
  const cam = load();
  const table = routes({
    '/transports/0/record': (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { recording: false });
      res.writeHead(req.method === 'PUT' ? 204 : 405);
      res.end();
    },
  });
  await withCamera(table, async (server) => {
    const r = await cam.RunAction(target(server.port), 'record.start', {});
    assert.equal(r.Success, true);
    const put = server.requests.find((q) => q.method === 'PUT');
    assert.deepEqual(put.json, { recording: true });
  });
});

test('Stop Recording POSTs transport stop, falling back to PUT recording false', async () => {
  const cam = load();
  const table = routes({
    '/transports/0/record': (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { recording: true });
      res.writeHead(204);
      res.end();
    },
    '/transports/0/stop': 404,
  });
  await withCamera(table, async (server) => {
    const r = await cam.RunAction(target(server.port), 'record.stop', {});
    assert.deepEqual(r, { Success: true, Detail: 'Recording stopped' });
    assert.deepEqual(
      server.requests.map((q) => `${q.method} ${q.url}`),
      [
        `GET ${API}/transports/0/record`,
        `POST ${API}/transports/0/stop`,
        `PUT ${API}/transports/0/record`,
      ]
    );
    assert.deepEqual(server.requests[2].json, { recording: false });
  });
});

test('Stop Recording on a camera that is not recording sends nothing', async () => {
  const cam = load();
  const table = routes({ '/transports/0/record': { recording: false } });
  await withCamera(table, async (server) => {
    const r = await cam.RunAction(target(server.port), 'record.stop', {});
    assert.deepEqual(r, { Success: true, Detail: 'Not recording' });
    assert.equal(server.requests.length, 1);
  });
});

test('a refused start is reported with the reason', async () => {
  const cam = load();
  const table = routes({
    '/transports/0/record': (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { recording: false });
      res.writeHead(400);
      res.end();
    },
  });
  await withCamera(table, async (server) => {
    const r = await cam.RunAction(target(server.port), 'record.start', {});
    assert.equal(r.Success, false);
    assert.match(r.Error, /refused to start recording/);
  });
});

test('an unknown action is refused', async () => {
  const r = await load().RunAction({ Address: '127.0.0.1', Settings: {} }, 'format.card', {});
  assert.equal(r.Success, false);
  assert.match(r.Error, /Unknown Blackmagic camera action/);
});

// --- Debug ---------------------------------------------------------------------

test('Debug escapes every value the camera sent', async () => {
  const cam = load();
  const evil = '<img src=x onerror=alert(1)>';
  const table = routes({
    '/system/product': { deviceName: evil, productName: evil, softwareVersion: evil },
    '/system': { codecFormat: { codec: evil }, videoFormat: { name: evil } },
    '/transports/0/timecode': { display: evil },
    '/media/workingset': { size: 1, workingset: [{ volume: evil, remainingRecordTime: 60 }] },
    '/camera/power': { source: evil, batteries: [{ statusFlags: [evil] }] },
    '/camera/tallyStatus': { status: evil },
  });
  await withCamera(table, async (server) => {
    const t = target(server.port, { CheckPower: true });
    const r = await cam.Run(t);
    const html = cam.Debug(r, t);
    assert.ok(!html.includes('<img'), 'raw markup must not reach the panel');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
  const offline = cam.Debug({ Success: false, Error: '<b>boom</b>' }, { Address: '<x>' });
  assert.ok(!offline.includes('<b>boom'));
  assert.ok(offline.includes('&lt;b&gt;boom'));
});

test('Debug lists the slots and marks the active one', async () => {
  const cam = load();
  await withCamera(routes(), async (server) => {
    const t = target(server.port, { CheckRecordTime: true });
    const html = cam.Debug(await cam.Run(t), t);
    assert.match(html, /Slot 1 · CFAST-A \(active\)/);
    assert.match(html, /1 h 0 min recording time left/);
    assert.match(html, /Slot 2/);
    assert.match(html, /Recording/);
  });
});
