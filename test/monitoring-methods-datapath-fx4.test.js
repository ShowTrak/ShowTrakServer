const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { startMockServer, sendJson } = require('../test-support/video-processor-http-mock');

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'datapath-fx4.js'),
    {}
  );
}

const TIMINGS_1080P = {
  HorFrequency: 67432,
  VerFrequency: 59939,
  PixelClock: 148351478,
  Flags: 0,
  HorAddrTime: 1920,
  VerAddrTime: 1080,
  ColourSpace: 'RGB 709',
  ColourRange: 'Full',
  Subsampling: '4:4:4',
};

// A healthy Fx4 built from the doc's example bodies. Override any path's reply
// (keyed by path + query) with a value, or a function of the request.
function fx4(overrides = {}) {
  const replies = {
    '/SerialNumber.cgx': { SerialNumber: '123456789000DA' },
    '/SystemInfo.cgx': {
      FirmwareVersion: 261,
      ConfigVersion: 256,
      HardwareVersion: 1,
      FPGAVersion: 5,
      ApplicationBuildDate: 'Apr 20 2016',
      ApplicationBuildTime: '13:12:50',
      BootloaderBuildDate: 'Apr 20 2016',
      BootloaderBuildTime: '14:55:01',
    },
    '/FriendlyName.cgx': { FriendlyName: 'Stage Wall' },
    '/SystemHealth.cgx': {
      PowerSupply: { IO: true, '1.8V': true, '1.2V': true },
      Temperature: { Average: 34.312, Maximum: 39, Minimum: 23 },
    },
    '/PreferredInput.cgx': { Input: 0 },
    '/ActiveInput.cgx': { Input: 0 },
    '/InputCurrentTimings.cgx?input=0': TIMINGS_1080P,
    '/InputHDCPStatus.cgx?input=0': { Status: 'Unencrypted' },
  };
  for (let n = 0; n < 4; n++) {
    replies[`/OutputEnable.cgx?output=${n}`] = { Enable: true };
    replies[`/OutputImageSource.cgx?output=${n}`] = { Source: 'InputCapture' };
    replies[`/OutputCurrentTimings.cgx?output=${n}`] = TIMINGS_1080P;
    replies[`/OutputHDCPStatus.cgx?output=${n}`] = { Status: 'Unencrypted' };
  }
  Object.assign(replies, overrides);
  return (req, res) => {
    if (req.method === 'POST') return sendJson(res, 200, { Success: true });
    const reply = replies[req.url];
    if (reply === undefined) {
      return sendJson(res, 200, { Success: false, ErrorMessage: 'Invalid input', ErrorCode: -9 });
    }
    return typeof reply === 'function' ? reply(req, res) : sendJson(res, 200, reply);
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

test('datapath-fx4: ID, Name and settings shape', () => {
  const M = load();
  assert.equal(M.ID, 'datapath-fx4');
  assert.equal(M.Name, 'Datapath Fx4');
  assert.ok(M.Settings.every((S) => S.Key && S.Label && S.Type));
  assert.equal(M.Settings.find((S) => S.Key === 'Password').Sensitive, true);
  const defaults = Object.fromEntries(M.Settings.map((S) => [S.Key, S.Default]));
  assert.equal(defaults.CheckSignal, true);
  assert.equal(defaults.CheckPower, true);
  assert.equal(defaults.CheckHdcp, true);
  assert.equal(defaults.CheckPreferredInput, false);
  assert.equal(defaults.CheckInputFormat, false);
  assert.equal(defaults.CheckOutputsEnabled, false);
  assert.equal(defaults.CheckTestPattern, false);
  assert.equal(defaults.CheckTemperature, false);
});

test('datapath-fx4: healthy controller reads everything with GETs only', async () => {
  const M = load();
  await withServer(fx4(), async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.ok(server.requests.every((r) => r.method === 'GET'));
    assert.equal(server.requests.length, 8 + 4 * 4);
    assert.equal(server.requests[0].url, '/SerialNumber.cgx');
    assert.equal(R.Serial, '123456789000DA');
    assert.equal(R.FriendlyName, 'Stage Wall');
    assert.equal(R.FirmwareVersion, 261);
    assert.equal(R.FpgaVersion, 5);
    assert.equal(R.BuildDate, 'Apr 20 2016 13:12:50');
    assert.equal(R.ActiveInput, 1);
    assert.equal(R.PreferredInput, 1);
    assert.equal(R.InputFormat.Width, 1920);
    assert.equal(R.InputFormat.Height, 1080);
    assert.equal(R.InputFormat.RefreshHz, 59.94);
    assert.equal(R.TemperatureMaximum, 39);
    assert.equal(R.PowerRails.length, 3);
    assert.equal(R.Outputs.length, 4);
    assert.deepEqual(
      R.Outputs.map((o) => [o.Output, o.Enabled, o.ImageSource]),
      [
        [1, true, 'InputCapture'],
        [2, true, 'InputCapture'],
        [3, true, 'InputCapture'],
        [4, true, 'InputCapture'],
      ]
    );
    assert.ok(typeof R.LatencyMs === 'number');
  });
});

test('datapath-fx4: Outputs setting limits the outputs read; HDCP off skips HDCP reads', async () => {
  const M = load();
  await withServer(fx4(), async (server) => {
    const R = await M.Run(target(server.port, { Outputs: 2, CheckHdcp: false }));
    assert.equal(R.Success, true);
    assert.equal(R.Outputs.length, 2);
    assert.ok(!server.requests.some((r) => /HDCP/.test(r.url)));
    assert.ok(!server.requests.some((r) => /output=2/.test(r.url)));
  });
});

test('datapath-fx4: no active input is degraded by default and skips input reads', async () => {
  const M = load();
  await withServer(fx4({ '/ActiveInput.cgx': { Input: null } }), async (server) => {
    let R = await M.Run(target(server.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /No input has a signal/);
    assert.equal(R.ActiveInput, null);
    assert.ok(!server.requests.some((r) => r.url.startsWith('/InputCurrentTimings')));
    R = await M.Run(target(server.port, { CheckSignal: false }));
    assert.equal(R.Degraded, undefined);
  });
});

test('datapath-fx4: fallback from the preferred input only flags when enabled', async () => {
  const M = load();
  const handler = fx4({
    '/ActiveInput.cgx': { Input: 2 },
    '/InputCurrentTimings.cgx?input=2': TIMINGS_1080P,
  });
  await withServer(handler, async (server) => {
    let R = await M.Run(target(server.port));
    assert.equal(R.Degraded, undefined);
    assert.equal(R.ActiveInput, 3);
    R = await M.Run(target(server.port, { CheckPreferredInput: true }));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Running on input 3, not the preferred input 1/);
  });
  // No preferred input set: nothing to fall back from.
  await withServer(fx4({ '/PreferredInput.cgx': { Input: null } }), async (server) => {
    const R = await M.Run(target(server.port, { CheckPreferredInput: true }));
    assert.equal(R.Degraded, undefined);
    assert.equal(R.PreferredInput, null);
  });
});

test('datapath-fx4: input format assertion', async () => {
  const M = load();
  await withServer(fx4(), async (server) => {
    let R = await M.Run(
      target(server.port, {
        CheckInputFormat: true,
        ExpectedResolution: '1920x1080',
        ExpectedRefreshRate: 59.94,
      })
    );
    assert.equal(R.Degraded, undefined);
    R = await M.Run(
      target(server.port, {
        CheckInputFormat: true,
        ExpectedResolution: '3840x2160',
        ExpectedRefreshRate: 50,
      })
    );
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Input 1920x1080 \(expected 3840x2160\)/);
    assert.match(R.DegradedReason, /Input 59.94 Hz \(expected 50 Hz\)/);
  });
  // Timings refused while an input is active: format not reported.
  await withServer(fx4({ '/InputCurrentTimings.cgx?input=0': undefined }), async (server) => {
    const R = await M.Run(target(server.port, { CheckInputFormat: true }));
    assert.equal(R.Success, true);
    assert.match(R.DegradedReason, /Input format not reported/);
  });
});

test('datapath-fx4: power rail fault is degraded by default', async () => {
  const M = load();
  const handler = fx4({
    '/SystemHealth.cgx': {
      PowerSupply: { IO: true, '1.8V': false, '1.2V': true },
      Temperature: { Average: 30, Maximum: 31, Minimum: 29 },
    },
  });
  await withServer(handler, async (server) => {
    let R = await M.Run(target(server.port));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Power supply fault on 1\.8V/);
    R = await M.Run(target(server.port, { CheckPower: false }));
    assert.equal(R.Degraded, undefined);
  });
});

test('datapath-fx4: HDCP failure on the input or an output', async () => {
  const M = load();
  const handler = fx4({
    '/InputHDCPStatus.cgx?input=0': { Status: 'Failure' },
    '/OutputHDCPStatus.cgx?output=3': { Status: 'Error' },
  });
  await withServer(handler, async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /HDCP failure on input 1/);
    assert.match(R.DegradedReason, /HDCP error on output 4/);
  });
  await withServer(fx4({ '/InputHDCPStatus.cgx?input=0': { Status: 'Encrypted' } }), async (s) => {
    const R = await M.Run(target(s.port));
    assert.equal(R.Degraded, undefined);
  });
});

test('datapath-fx4: outputs switched off and test patterns flag only when enabled', async () => {
  const M = load();
  const handler = fx4({
    '/OutputEnable.cgx?output=1': { Enable: false },
    '/OutputImageSource.cgx?output=2': { Source: 'MovingColourbars' },
  });
  await withServer(handler, async (server) => {
    let R = await M.Run(target(server.port));
    assert.equal(R.Degraded, undefined);
    R = await M.Run(target(server.port, { CheckOutputsEnabled: true, CheckTestPattern: true }));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Output 2 off/);
    assert.match(R.DegradedReason, /Output 3 showing moving colour bars/);
    // An output outside the watched range is ignored.
    R = await M.Run(
      target(server.port, { CheckOutputsEnabled: true, CheckTestPattern: true, Outputs: 1 })
    );
    assert.equal(R.Degraded, undefined);
  });
});

test('datapath-fx4: temperature limit', async () => {
  const M = load();
  await withServer(fx4(), async (server) => {
    let R = await M.Run(target(server.port, { CheckTemperature: true, MaxTemperature: 35 }));
    assert.equal(R.Degraded, true);
    assert.match(R.DegradedReason, /Temperature 39 °C \(limit 35 °C\)/);
    R = await M.Run(target(server.port, { CheckTemperature: true, MaxTemperature: 70 }));
    assert.equal(R.Degraded, undefined);
  });
});

test('datapath-fx4: tolerates trailing commas like the doc examples', async () => {
  const M = load();
  const handler = fx4({
    '/InputHDCPStatus.cgx?input=0': (_req, res) => sendJson(res, 200, '{"Status":"Failure",}'),
  });
  await withServer(handler, async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.InputHdcp, 'Failure');
  });
});

test('datapath-fx4: unsupported optional calls leave readings empty, not offline', async () => {
  const M = load();
  const handler = fx4({
    '/SystemInfo.cgx': undefined,
    '/SystemHealth.cgx': undefined,
    '/OutputHDCPStatus.cgx?output=0': undefined,
  });
  await withServer(handler, async (server) => {
    const R = await M.Run(target(server.port));
    assert.equal(R.Success, true);
    assert.equal(R.Degraded, undefined);
    assert.equal(R.FirmwareVersion, null);
    assert.deepEqual(R.PowerRails, []);
    assert.equal(R.Outputs[0].Hdcp, null);
  });
});

test('datapath-fx4: offline and wrong-device cases', async () => {
  const M = load();
  // Nothing listening.
  const closed = await startMockServer(() => {});
  const port = closed.port;
  await closed.close();
  let R = await M.Run(target(port));
  assert.equal(R.Success, false);
  assert.ok(R.Error);

  // A web server that is not an Fx4.
  await withServer(
    (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html>nope</html>');
    },
    async (server) => {
      R = await M.Run(target(server.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /HTTP 404: not the Datapath Fx4 REST API/);
    }
  );

  // HTML with a 200.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>router</html>');
    },
    async (server) => {
      R = await M.Run(target(server.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /not the Datapath Fx4 REST API/);
    }
  );

  // JSON without a serial number.
  await withServer(
    (_req, res) => sendJson(res, 200, { hello: 'world' }),
    async (server) => {
      R = await M.Run(target(server.port));
      assert.equal(R.Success, false);
      assert.match(R.Error, /not as a Datapath Fx4/);
    }
  );

  // No active input call at all.
  await withServer(fx4({ '/ActiveInput.cgx': undefined }), async (server) => {
    R = await M.Run(target(server.port));
    assert.equal(R.Success, false);
    assert.match(R.Error, /did not report its active input/);
  });

  // No address.
  R = await M.Run({ Address: '', Settings: {} });
  assert.equal(R.Success, false);
  assert.match(R.Error, /No address/);
});

test('datapath-fx4: the timeout is a budget for the whole probe', async () => {
  const M = load();
  // Every reply takes 150 ms; 24 requests would take 3.6 s, the budget is 1 s.
  const slow = fx4();
  const handler = (req, res) => setTimeout(() => slow(req, res), 150);
  await withServer(handler, async (server) => {
    const Started = Date.now();
    const R = await M.Run(target(server.port, { Timeout: 1000 }));
    const Took = Date.now() - Started;
    assert.equal(R.Success, false);
    assert.match(R.Error, /stopped answering|timed out/);
    assert.ok(Took < 1600, `took ${Took} ms`);
  });
});

// --- Actions ----------------------------------------------------------------

test('datapath-fx4: action definitions and destructive flags', () => {
  const M = load();
  const byId = Object.fromEntries(M.Actions.map((A) => [A.ID, A]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'input.preferred',
    'output.disable',
    'output.enable',
    'output.live',
    'output.pattern',
  ]);
  assert.equal(byId['input.preferred'].Destructive, true);
  assert.equal(byId['output.pattern'].Destructive, true);
  assert.equal(byId['output.disable'].Destructive, true);
  assert.ok(!byId['output.live'].Destructive);
  assert.ok(!byId['output.enable'].Destructive);
  for (const A of M.Actions) {
    assert.ok(!A.AllowedWhileOffline);
    assert.match(A.ID, /^[a-z]+(\.[a-z]+)*$/);
    // No param may carry a default or a select that could turn bad input into a command.
    for (const P of A.Params || []) {
      assert.equal(P.Type, 'string');
      assert.equal(P.Default, undefined);
    }
  }
  // The first param (the OSC trailing value) is the most useful one.
  assert.equal(byId['output.pattern'].Params[0].Key, 'Output');
  assert.equal(byId['input.preferred'].Params[0].Key, 'Input');
});

test('datapath-fx4: input.preferred posts the 0-based input, with the password', async () => {
  const M = load();
  await withServer(fx4(), async (server) => {
    let A = await M.RunAction(target(server.port, { Password: 'secret' }), 'input.preferred', {
      Input: '2',
    });
    assert.equal(A.Success, true);
    assert.equal(A.Detail, 'Preferred input set to input 2');
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, 'POST');
    assert.equal(server.requests[0].url, '/PreferredInput.cgx');
    assert.equal(server.requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(server.requests[0].json, { Input: 1, Password: 'secret' });

    A = await M.RunAction(target(server.port), 'input.preferred', { Input: 'Auto' });
    assert.equal(A.Success, true);
    assert.equal(A.Detail, 'Preferred input cleared');
    assert.deepEqual(server.requests[1].json, { Input: null });
  });
});

test('datapath-fx4: bad parameters are refused before anything is sent', async () => {
  const M = load();
  await withServer(fx4(), async (server) => {
    const t = target(server.port);
    for (const Input of ['', '0', '4', 'hdmi', undefined, '1.5']) {
      const A = await M.RunAction(t, 'input.preferred', { Input });
      assert.equal(A.Success, false);
      assert.match(A.Error, /Choose an input/);
    }
    for (const Output of ['', '0', '5', 'every', undefined]) {
      const A = await M.RunAction(t, 'output.disable', { Output });
      assert.equal(A.Success, false);
      assert.match(A.Error, /Choose an output/);
    }
    let A = await M.RunAction(t, 'output.pattern', { Output: '1', Pattern: 'FlatColour' });
    assert.match(A.Error, /Choose a pattern/);
    A = await M.RunAction(t, 'output.pattern', { Output: '9', Pattern: 'Colourbars' });
    assert.match(A.Error, /Choose an output/);
    A = await M.RunAction(t, 'nope', {});
    assert.match(A.Error, /Unknown Datapath Fx4 action/);
    assert.equal(server.requests.length, 0);
  });
});

test('datapath-fx4: output actions post the documented bodies', async () => {
  const M = load();
  await withServer(fx4(), async (server) => {
    const t = target(server.port);
    let A = await M.RunAction(t, 'output.pattern', { Output: '3', Pattern: 'moving colourbars' });
    assert.equal(A.Success, true);
    assert.equal(A.Detail, 'Output 3 showing moving colour bars');
    assert.equal(server.requests[0].url, '/OutputImageSource.cgx');
    assert.deepEqual(server.requests[0].json, { Output: 2, Source: 'MovingColourbars' });

    A = await M.RunAction(t, 'output.live', { Output: '3' });
    assert.equal(A.Detail, 'Output 3 back on the live input');
    assert.deepEqual(server.requests[1].json, { Output: 2, Source: 'InputCapture' });

    A = await M.RunAction(t, 'output.disable', { Output: '1' });
    assert.equal(A.Detail, 'Output 1 switched off');
    assert.equal(server.requests[2].url, '/OutputEnable.cgx');
    assert.deepEqual(server.requests[2].json, { Output: 0, Enable: false });

    A = await M.RunAction(t, 'output.enable', { Output: 'all' });
    assert.equal(A.Detail, 'All outputs switched on');
    assert.deepEqual(
      server.requests.slice(3).map((r) => r.json),
      [0, 1, 2, 3].map((Output) => ({ Output, Enable: true }))
    );
    // Never saves to flash.
    assert.ok(!server.requests.some((r) => /SaveSettings/.test(r.url)));
  });
});

test('datapath-fx4: device refusal becomes a specific error', async () => {
  const M = load();
  const refuse = (req, res) =>
    sendJson(res, 200, { Success: false, ErrorMessage: 'Invalid password', ErrorCode: -12 });
  await withServer(refuse, async (server) => {
    const A = await M.RunAction(target(server.port), 'input.preferred', { Input: '1' });
    assert.equal(A.Success, false);
    assert.match(A.Error, /The controller refused: Invalid password \(code -12\)/);
    assert.match(A.Error, /Check the Device password setting/);
  });
  // Partial success across All outputs: say which changed.
  let count = 0;
  const third = (req, res) =>
    ++count === 3
      ? sendJson(res, 200, { Success: false, ErrorMessage: 'Invalid input', ErrorCode: -9 })
      : sendJson(res, 200, { Success: true });
  await withServer(third, async (server) => {
    const A = await M.RunAction(target(server.port), 'output.disable', { Output: 'All' });
    assert.equal(A.Success, false);
    assert.match(A.Error, /Outputs 1, 2 switched off, but output 3 failed/);
    assert.equal(server.requests.length, 3);
  });
  // Unreachable.
  const closed = await startMockServer(() => {});
  const port = closed.port;
  await closed.close();
  const A = await M.RunAction(target(port), 'output.live', { Output: '1' });
  assert.equal(A.Success, false);
  assert.ok(A.Error);
});

test('datapath-fx4: DescribeAction binds params', () => {
  const M = load();
  assert.equal(M.DescribeAction('input.preferred', { Input: '3' }), 'Preferred Input 3');
  assert.equal(M.DescribeAction('input.preferred', { Input: 'auto' }), 'Clear Preferred Input');
  assert.equal(M.DescribeAction('input.preferred', { Input: 'x' }), null);
  assert.equal(
    M.DescribeAction('output.pattern', { Output: '2', Pattern: 'Greyscale' }),
    'Greyscale on Output 2'
  );
  assert.equal(M.DescribeAction('output.live', { Output: 'all' }), 'Live Input on All outputs');
  assert.equal(M.DescribeAction('output.disable', { Output: '4' }), 'Switch Off Output 4');
  assert.equal(M.DescribeAction('output.enable', { Output: '' }), null);
});

// --- Debug ------------------------------------------------------------------

test('datapath-fx4: Debug renders healthy, degraded and offline results', async () => {
  const M = load();
  await withServer(
    fx4({
      '/OutputImageSource.cgx?output=1': { Source: 'Colourbars' },
      '/FriendlyName.cgx': { FriendlyName: '<b>Wall</b>' },
    }),
    async (server) => {
      const t = target(server.port);
      const R = await M.Run(t);
      const html = M.Debug(R, t);
      assert.match(html, /Healthy/);
      assert.match(html, /123456789000DA/);
      assert.match(html, /Input 1: 1920x1080 @ 59.94 Hz/);
      assert.match(html, /Output 2/);
      assert.match(html, /Colour bars/);
      assert.match(html, /All rails good/);
      assert.ok(!html.includes('<b>Wall</b>'));
      assert.ok(html.includes('&lt;b&gt;Wall&lt;/b&gt;'));
    }
  );
  const off = M.Debug({ Success: false, Error: 'connect ECONNREFUSED' }, { Address: '10.0.0.5' });
  assert.match(off, /Offline/);
  assert.match(off, /ECONNREFUSED/);
  const noSignal = M.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: 'No input has a signal',
      ActiveInput: null,
      PowerRails: [{ Name: 'IO', Ok: false }],
      Outputs: [],
    },
    { Address: '10.0.0.5' }
  );
  assert.match(noSignal, /No signal/);
  assert.match(noSignal, /Fault: IO/);
});
