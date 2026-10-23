const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'brompton-tessera.js'),
    {}
  );
}

// A Tessera 3.1-style tree, shaped as GET /api/ returns it ({"api": {...}}),
// with the system/temperature and system/fan keys newer firmware adds.
function tree(overrides = {}) {
  const api = {
    system: {
      'processor-name': 'Stage Left',
      'processor-type': 'sx40',
      'serial-number': 'SX40-0042',
      'software-version': '3.5.2',
      uptime: '01d 02h 03m 04s',
      temperature: { cpu: 52.5, fpga: '61', ethernet: { sfp: { a: 40 } } },
      fan: { case: { one: { speed: 2400, status: 'ok' } }, fpga: { speed: 3100, status: 'ok' } },
    },
    panels: { statistics: { 'online-count': 120, 'error-count': 0, 'associated-count': 120 } },
    override: {
      blackout: { enabled: false, 'fade-time': 1 },
      freeze: { enabled: false },
      'test-pattern': { enabled: false, format: 'from-input', type: 'smpte-bars' },
    },
    input: {
      active: {
        'refresh-rate': 50,
        resolution: { width: 3840, height: 2160 },
        source: { 'port-type': 'sdi', 'port-number': 1 },
      },
    },
    presets: {
      active: { name: 'Show', number: '3' },
      items: { 1: { name: 'Pre-show', status: false }, 3: { name: 'Show', status: true } },
    },
    output: {
      network: {
        failover: {
          settings: { enabled: true, role: 'primary' },
          state: { 'is-partner-present': true },
        },
        'cable-redundancy': { loops: { 1: { state: 'loop-found' }, 2: { state: 'loop-found' } } },
      },
    },
  };
  return { api: deepMerge(api, overrides) };
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
        ? deepMerge(base[k], v)
        : v;
  }
  return out;
}

async function withServer(body, fn, status = 200) {
  const server = await startMockServer((req, res) =>
    typeof body === 'function' ? body(req, res) : sendJson(res, status, body)
  );
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('brompton-tessera: ID and Name', () => {
  const M = load();
  assert.equal(M.ID, 'brompton-tessera');
  assert.equal(M.Name, 'Brompton Tessera');
  assert.ok(M.Settings.every((S) => S.Key && S.Label && S.Type));
});

test('brompton-tessera: healthy tree reads everything in one GET /api/', async () => {
  const M = load();
  await withServer(tree(), async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, 'GET');
    assert.equal(server.requests[0].url, '/api/');
    assert.equal(R.ProcessorName, 'Stage Left');
    assert.equal(R.ProcessorType, 'sx40');
    assert.equal(R.SoftwareVersion, '3.5.2');
    assert.equal(R.PanelsOnline, 120);
    assert.equal(R.InputWidth, 3840);
    assert.equal(R.InputRefreshRate, 50);
    assert.equal(R.InputPortType, 'sdi');
    assert.equal(R.PresetName, 'Show');
    assert.deepEqual(
      R.Temperatures.map((T) => [T.Name, T.Celsius]),
      [
        ['CPU', 52.5],
        ['FPGA', 61],
        ['Ethernet SFP A', 40],
      ]
    );
    assert.equal(R.Fans.length, 2);
    assert.equal(R.Fans[0].Name, 'Case One');
    assert.ok(typeof R.LatencyMs === 'number');
  });
});

test('brompton-tessera: missing panels against associated count and an explicit count', async () => {
  const M = load();
  const body = tree({ panels: { statistics: { 'online-count': 118, 'associated-count': 120 } } });
  await withServer(body, async (server) => {
    let R = await M.Run(target(server.port));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /118 of 120 panels online/);
    R = await M.Run(target(server.port, { ExpectedPanels: 100 }));
    assert.equal(R.Degraded, undefined);
    R = await M.Run(target(server.port, { CheckPanels: false }));
    assert.equal(R.Degraded, undefined);
  });
});

test('brompton-tessera: 3.4 devices/statistics naming is read too', async () => {
  const M = load();
  const body = tree();
  delete body.api.panels;
  body.api.devices = {
    statistics: { 'online-count': 10, 'error-count': 2, 'associated-count': 12 },
  };
  await withServer(body, async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /10 of 12 panels online/);
    assert.match(R.DegradedReason, /2 panels reporting errors/);
  });
});

test('brompton-tessera: overrides only flag when their toggle is on', async () => {
  const M = load();
  const body = tree({
    override: {
      blackout: { enabled: true },
      freeze: { enabled: true },
      'test-pattern': { enabled: true },
    },
  });
  await withServer(body, async (server) => {
    let R = await M.Run(target(server.port));
    assert.equal(R.Degraded, undefined);
    assert.equal(R.Blackout, true);
    R = await M.Run(
      target(server.port, { CheckBlackout: true, CheckFreeze: true, CheckTestPattern: true })
    );
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Blackout on/);
    assert.match(R.DegradedReason, /Output frozen/);
    assert.match(R.DegradedReason, /Test pattern on/);
  });
});

test('brompton-tessera: input format assertion', async () => {
  const M = load();
  await withServer(tree(), async (server) => {
    let R = await M.Run(
      target(server.port, {
        CheckInput: true,
        ExpectedResolution: '3840x2160',
        ExpectedRefreshRate: 50,
      })
    );
    assert.equal(R.Degraded, undefined);
    R = await M.Run(
      target(server.port, {
        CheckInput: true,
        ExpectedResolution: '1920x1080',
        ExpectedRefreshRate: 59.94,
      })
    );
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Input 3840x2160 \(expected 1920x1080\)/);
    assert.match(R.DegradedReason, /Input 50 Hz \(expected 59.94 Hz\)/);
  });
  const noSignal = tree();
  delete noSignal.api.input.active.resolution;
  delete noSignal.api.input.active['refresh-rate'];
  await withServer(noSignal, async (server) => {
    const R = await M.Run(target(server.port, { CheckInput: true }));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /No input signal/);
  });
});

test('brompton-tessera: 3.4 per-port meta-data supplies the active format', async () => {
  const M = load();
  const body = tree();
  delete body.api.input.active.resolution;
  delete body.api.input.active['refresh-rate'];
  body.api.input.ports = {
    sdi: {
      1: { 'meta-data': { 'refresh-rate': 59.94, resolution: { width: 1920, height: 1080 } } },
    },
  };
  await withServer(body, async (server) => {
    const R = await M.Run(
      target(server.port, { CheckInput: true, ExpectedResolution: '1920x1080' })
    );
    assert.equal(R.Degraded, undefined);
    assert.equal(R.InputHeight, 1080);
    assert.equal(R.InputRefreshRate, 59.94);
  });
});

test('brompton-tessera: temperature, failover and cable loop assertions', async () => {
  const M = load();
  const body = tree({
    system: { temperature: { cpu: 82 } },
    output: {
      network: {
        failover: { state: { 'is-partner-present': false } },
        'cable-redundancy': { loops: { 2: { state: 'no-loop-found' } } },
      },
    },
  });
  await withServer(body, async (server) => {
    let R = await M.Run(target(server.port));
    assert.equal(R.Degraded, undefined);
    R = await M.Run(
      target(server.port, {
        CheckTemperature: true,
        MaxTemperature: 75,
        CheckFailover: true,
        CheckCableRedundancy: true,
      })
    );
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /CPU 82 °C \(limit 75 °C\)/);
    assert.match(R.DegradedReason, /Failover partner not detected/);
    assert.match(R.DegradedReason, /Cable loop 2: no-loop-found/);
    assert.doesNotMatch(R.DegradedReason, /Cable loop 1/);
  });
});

test('brompton-tessera: offline on refused, non-200, wrong device and garbage', async () => {
  const M = load();
  const server = await startMockServer((_req, res) => sendJson(res, 200, {}));
  const port = server.port;
  await server.close();
  let R = await M.Run(target(port));
  assert.equal(R.Success, false);
  assert.ok(R.Error);

  await withServer(
    { error: 'nope' },
    async (s) => {
      R = await M.Run(target(s.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /HTTP 404/);
    },
    404
  );
  await withServer({ hello: 'world' }, async (s) => {
    R = await M.Run(target(s.port));
    assert.equal(R.Success, false);
    assert.match(R.Error, /not with the Tessera/);
  });
  await withServer('<html>router</html>', async (s) => {
    R = await M.Run(target(s.port));
    assert.equal(R.Success, false);
  });
  R = await M.Run({ Address: '', Settings: {} });
  assert.equal(R.Success, false);
  assert.match(R.Error, /No address/);
});

test('brompton-tessera: the timeout bounds the probe', async () => {
  const M = load();
  await withServer(
    () => {
      /* never answers */
    },
    async (s) => {
      const Started = Date.now();
      const R = await M.Run(target(s.port, { Timeout: 500 }));
      assert.equal(R.Success, false);
      assert.match(R.Error, /timed out/i);
      assert.ok(Date.now() - Started < 1500);
    }
  );
});

test('brompton-tessera: Debug renders reachable and offline results, escaping values', async () => {
  const M = load();
  const body = tree({ system: { 'processor-name': '<b>x</b>' } });
  await withServer(body, async (s) => {
    const R = await M.Run(target(s.port, { CheckCableRedundancy: true }));
    const Html = M.Debug(R, target(s.port));
    assert.match(Html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(Html, /<b>x<\/b>/);
    assert.match(Html, /SX40/);
    assert.match(Html, /3840x2160 @ 50 Hz/);
    assert.match(Html, /Cable loop 1/);
    assert.match(Html, /CPU/);
  });
  const Off = M.Debug({ Success: false, Error: 'ECONNREFUSED' }, { Address: '10.0.0.1' });
  assert.match(Off, /ECONNREFUSED/);
  assert.match(Off, /Live Control/);
});

// --- Actions -----------------------------------------------------------------

test('brompton-tessera: action set and Destructive flags', () => {
  const M = load();
  const byId = Object.fromEntries(M.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), [
    'blackout.on',
    'blackout.off',
    'freeze.on',
    'freeze.off',
    'testpattern.off',
    'preset.recall',
  ]);
  for (const id of ['blackout.on', 'freeze.on', 'preset.recall']) {
    assert.equal(byId[id].Destructive, true, id);
  }
  for (const id of ['blackout.off', 'freeze.off', 'testpattern.off']) {
    assert.ok(!byId[id].Destructive, id);
  }
  for (const a of M.Actions) assert.ok(!a.AllowedWhileOffline, a.ID);
  assert.equal(byId['preset.recall'].Params[0].Key, 'Preset');
});

test('brompton-tessera: each action sets one endpoint with GET ?set=', async () => {
  const M = load();
  await withServer(
    (req, res) => sendJson(res, 200, { enabled: true }),
    async (s) => {
      const t = target(s.port);
      const expect = {
        'blackout.on': ['/api/override/blackout/enabled?set=true', 'Blackout on'],
        'blackout.off': ['/api/override/blackout/enabled?set=false', 'Blackout off'],
        'freeze.on': ['/api/override/freeze/enabled?set=true', 'Output frozen'],
        'freeze.off': ['/api/override/freeze/enabled?set=false', 'Output unfrozen'],
        'testpattern.off': ['/api/override/test-pattern/enabled?set=false', 'Test pattern off'],
      };
      for (const [id, [, detail]] of Object.entries(expect)) {
        assert.deepEqual(await M.RunAction(t, id, {}), { Success: true, Detail: detail });
      }
      assert.deepEqual(await M.RunAction(t, 'preset.recall', { Preset: 3 }), {
        Success: true,
        Detail: 'Preset 3 recalled',
      });
      assert.deepEqual(
        s.requests.map((r) => [r.method, r.url]),
        [
          ...Object.values(expect).map(([url]) => ['GET', url]),
          ['GET', '/api/presets/active/number?set=3'],
        ]
      );
    }
  );
});

test('brompton-tessera: bad preset numbers never reach the processor', async () => {
  const M = load();
  await withServer({}, async (s) => {
    for (const Preset of ['', 0, 129, 2.5, 'three']) {
      const r = await M.RunAction(target(s.port), 'preset.recall', { Preset });
      assert.deepEqual(r, {
        Success: false,
        Error: 'Preset must be a whole number from 1 to 128',
      });
    }
    const r = await M.RunAction(target(s.port), 'blackout.toggle', {});
    assert.match(r.Error, /Unknown Brompton Tessera action/);
    assert.equal(s.requests.length, 0);
  });
});

test('brompton-tessera: a refusal reports the processor error message', async () => {
  const M = load();
  await withServer(
    (req, res) =>
      sendJson(res, 400, {
        'error-messages': ['Object not found'],
        'response-code': 'ObjectNotFound',
      }),
    async (s) => {
      const r = await M.RunAction(target(s.port), 'preset.recall', { Preset: 99 });
      assert.deepEqual(r, {
        Success: false,
        Error: 'The processor refused the change (HTTP 400): Object not found',
      });
    }
  );
  const s = await startMockServer(() => {});
  const port = s.port;
  await s.close();
  const r = await M.RunAction(target(port), 'blackout.on', {});
  assert.equal(r.Success, false);
  assert.ok(r.Error);
  assert.deepEqual(await M.RunAction({ Address: '' }, 'blackout.on', {}), {
    Success: false,
    Error: 'No address configured',
  });
});

test('brompton-tessera: preset choices come from presets/items in the same GET', async () => {
  const M = load();
  await withServer(tree(), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(s.requests.length, 1);
    assert.deepEqual(R.Presets, [
      { Number: 1, Name: 'Pre-show' },
      { Number: 3, Name: 'Show' },
    ]);
    assert.deepEqual(M.GetActionOptions(R), {
      Preset: [
        { value: '1', label: '1 · Pre-show' },
        { value: '3', label: '3 · Show' },
      ],
    });
  });
  assert.deepEqual(M.GetActionOptions({ Success: false }), {});
  assert.equal(M.DescribeAction('preset.recall', { Preset: '7' }), 'Recall Preset 7');
  assert.equal(M.DescribeAction('preset.recall', { Preset: 'x' }), null);
  assert.equal(M.DescribeAction('blackout.on', {}), null);
});
