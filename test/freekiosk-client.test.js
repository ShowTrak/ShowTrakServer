// The FreeKiosk protocol client, against a real HTTP server.
//
// The headline case is "a refused command still answers HTTP 200": FreeKiosk
// reports privilege failures as `success: true` with `data.executed: false`, so
// anything that trusts the status code reports a reboot that never happened.
// That behaviour is only reachable against a server that actually sends it,
// which is why these run over a socket rather than a stubbed http module.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GetStatus,
  SendCommand,
  FetchImage,
  GetCameraList,
  MAX_FREEKIOSK_IMAGE_BYTES,
} = require('../dist/Modules/FreeKiosk/client');
const {
  FREEKIOSK_COMMANDS_BY_ID,
  GetFreeKioskCommand,
} = require('../dist/Modules/FreeKiosk/commands');
const { startFreeKioskDevice, STATUS_HEALTHY } = require('./helpers/freekiosk-device');

async function withDevice(options, run) {
  const device = await startFreeKioskDevice(options);
  try {
    return await run(device, { Address: '127.0.0.1', Port: device.port, TimeoutMs: 2000 });
  } finally {
    await device.close();
  }
}

// ---- Reads ----------------------------------------------------------------

test('reads the full status in a single request', async () => {
  await withDevice({}, async (device, connection) => {
    const [err, reading] = await GetStatus(connection);
    assert.equal(err, null);
    assert.deepEqual(reading.Status, STATUS_HEALTHY);
    assert.ok(reading.LatencyMs >= 0);
    // One poll must cost one request: every individual read endpoint is a
    // subset of /api/status, and /api/health is redundant with it.
    assert.equal(device.requests.length, 1);
    assert.equal(device.requests[0].path, '/api/status');
  });
});

test('sends the API key as X-Api-Key when one is configured', async () => {
  await withDevice({ apiKey: 'secret-key' }, async (device, connection) => {
    const [err] = await GetStatus({ ...connection, ApiKey: 'secret-key' });
    assert.equal(err, null);
    assert.equal(device.requests[0].headers['x-api-key'], 'secret-key');
  });
});

test('a wrong or missing API key reports an auth failure, not a generic error', async () => {
  await withDevice({ apiKey: 'secret-key' }, async (_device, connection) => {
    const [err] = await GetStatus(connection);
    assert.match(err, /API key/i);
  });
});

test('lists the device cameras', async () => {
  await withDevice({}, async (_device, connection) => {
    const [err, cameras] = await GetCameraList(connection);
    assert.equal(err, null);
    assert.deepEqual(
      cameras.map((c) => c.facing),
      ['back', 'front']
    );
    assert.equal(cameras[0].maxWidth, 4032);
  });
});

// ---- Failure classification ----------------------------------------------

test('a stalled device is cut off by the timeout rather than hanging the poll', async () => {
  await withDevice({ stall: true }, async (_device, connection) => {
    const started = Date.now();
    const [err] = await GetStatus({ ...connection, TimeoutMs: 1000 });
    assert.match(err, /timed out/i);
    assert.ok(Date.now() - started < 5000, 'must not wait past its own timeout');
  });
});

test('a closed port reports a refused connection with a useful hint', async () => {
  const device = await startFreeKioskDevice({});
  const port = device.port;
  await device.close();
  const [err] = await GetStatus({ Address: '127.0.0.1', Port: port, TimeoutMs: 1500 });
  assert.match(err, /refused|unreachable|timed out/i);
});

test('a non-JSON body is reported as not being a FreeKiosk terminal', async () => {
  await withDevice({ rawBody: '<html>hello</html>' }, async (_device, connection) => {
    const [err] = await GetStatus(connection);
    assert.match(err, /unexpected response/i);
  });
});

test('a 404 suggests an older device build rather than a generic failure', async () => {
  await withDevice({ statusCode: 404 }, async (_device, connection) => {
    const [err] = await GetStatus(connection);
    assert.match(err, /not found|older/i);
  });
});

// ---- Commands: the two traps ---------------------------------------------

test('a command refused for lack of privileges is a failure, not a success', async () => {
  // THE TRAP: HTTP 200, success:true, executed:false. Reading the status code
  // or the envelope as the verdict reports a reboot that never happened.
  await withDevice({ refuseCommands: true }, async (_device, connection) => {
    const [err, outcome] = await SendCommand(connection, 'GET', '/api/reboot');
    assert.equal(outcome, null);
    assert.equal(err, 'Reboot requires Device Owner mode');
  });
});

test('a device with remote control disabled says so specifically', async () => {
  await withDevice({ allowControl: false }, async (_device, connection) => {
    const [err] = await SendCommand(connection, 'GET', '/api/screen/off');
    assert.match(err, /remote control is disabled/i);
  });
});

test('reads still work on a device with remote control disabled', async () => {
  // The 403 is a control kill switch, not an auth failure — polling must
  // continue so the terminal does not read as offline.
  await withDevice({ allowControl: false }, async (_device, connection) => {
    const [err, reading] = await GetStatus(connection);
    assert.equal(err, null);
    assert.ok(reading.Status.battery);
  });
});

test('an accepted command reports success and echoes what ran', async () => {
  await withDevice({}, async (device, connection) => {
    const [err, outcome] = await SendCommand(connection, 'GET', '/api/wake');
    assert.equal(err, null);
    assert.equal(outcome.Result.executed, true);
    assert.equal(device.requests[0].path, '/api/wake');
  });
});

test('a POST command sends its parameters as a JSON body', async () => {
  await withDevice({}, async (device, connection) => {
    const [err] = await SendCommand(connection, 'POST', '/api/brightness', { value: 40 });
    assert.equal(err, null);
    assert.equal(device.requests[0].method, 'POST');
    assert.equal(device.requests[0].headers['content-type'], 'application/json');
  });
});

// ---- Captures -------------------------------------------------------------

test('a screenshot comes back as a data URL, ready for an <img>', async () => {
  await withDevice({ imageBytes: 256 }, async (_device, connection) => {
    const [err, image] = await FetchImage(connection, 'screenshot');
    assert.equal(err, null);
    assert.equal(image.Mime, 'image/png');
    assert.equal(image.Bytes, 256);
    assert.match(image.DataUrl, /^data:image\/png;base64,/);
    assert.ok(image.CapturedAt > 0);
  });
});

test('a camera capture passes the requested camera and quality through', async () => {
  await withDevice({ imageContentType: 'image/jpeg' }, async (device, connection) => {
    const [err, image] = await FetchImage(connection, 'camera', { Camera: 'front', Quality: 60 });
    assert.equal(err, null);
    assert.equal(image.Mime, 'image/jpeg');
    assert.deepEqual(device.requests[0].query, { camera: 'front', quality: '60' });
  });
});

test('camera quality is clamped and the facing defaults to back', async () => {
  await withDevice({}, async (device, connection) => {
    await FetchImage(connection, 'camera', { Quality: 5000 });
    assert.deepEqual(device.requests[0].query, { camera: 'back', quality: '100' });
  });
});

test('an unavailable camera surfaces the device its own explanation', async () => {
  // "in use by another app" is diagnostic information worth keeping, so the
  // device's message is passed through rather than replaced.
  await withDevice({ cameraUnavailable: true }, async (_device, connection) => {
    const [err] = await FetchImage(connection, 'camera');
    assert.match(err, /camera permission and hardware/i);
  });
});

test('a non-image response is rejected instead of being wrapped as a data URL', async () => {
  await withDevice({ imageContentType: 'text/html' }, async (_device, connection) => {
    const [err, image] = await FetchImage(connection, 'screenshot');
    assert.equal(image, null);
    assert.ok(err);
  });
});

test('an oversized capture with no declared length is aborted mid-stream', async () => {
  // Content-Length is a claim, not a guarantee, and a chunked response makes no
  // claim at all. Without a running total the client would buffer an unbounded
  // body straight into main-process memory.
  await withDevice(
    { imageBytes: MAX_FREEKIOSK_IMAGE_BYTES + 512 * 1024, omitLength: true },
    async (_device, connection) => {
      const [err, image] = await FetchImage(connection, 'screenshot');
      assert.equal(image, null);
      assert.match(err, /too large/i);
    }
  );
});

test('an honestly oversized capture is rejected before a byte is read', async () => {
  await withDevice(
    { imageBytes: MAX_FREEKIOSK_IMAGE_BYTES + 1024 },
    async (_device, connection) => {
      const [err] = await FetchImage(connection, 'screenshot');
      assert.match(err, /too large/i);
    }
  );
});

// ---- The command allowlist ------------------------------------------------

test('arbitrary JavaScript execution is not reachable', async () => {
  // /api/js evaluates arbitrary code inside the kiosk WebView. Its absence from
  // the command map IS the control: the validator resolves against this map, so
  // there is no blocklist to keep current.
  assert.equal(GetFreeKioskCommand('js'), null);
  for (const command of FREEKIOSK_COMMANDS_BY_ID.values()) {
    assert.ok(
      !/\/api\/js\b/.test(command.Path),
      `${command.ID} routes to the JavaScript evaluation endpoint`
    );
  }
});

test('every command declares a well-formed route and unique id', () => {
  const seen = new Set();
  for (const command of FREEKIOSK_COMMANDS_BY_ID.values()) {
    assert.ok(!seen.has(command.ID), `duplicate command ${command.ID}`);
    seen.add(command.ID);
    assert.match(command.Path, /^\/api\//, `${command.ID} path`);
    assert.ok(['GET', 'POST'].includes(command.Method), `${command.ID} method`);
    assert.ok(command.Label && command.Icon, `${command.ID} needs a label and icon`);
    // A POST route needs a body from somewhere, or it sends an empty one for no
    // reason. Either the caller supplies it (Params) or the terminal's own
    // stored configuration does (FromSettings) — and never both, because a
    // FromSettings command must stay parameterless for the view modal to fire it
    // as a plain button and for a bulk selection to mean "each on its own setup".
    if (command.Method === 'POST') {
      assert.ok(
        (command.Params && command.Params.length) || command.FromSettings,
        `${command.ID} POSTs with no body source`
      );
    }
    if (command.FromSettings) {
      assert.ok(!command.Params, `${command.ID} is FromSettings and must take no params`);
    }
  }
});

test('sliders name the metric they write so the UI can reconcile them', () => {
  for (const command of FREEKIOSK_COMMANDS_BY_ID.values()) {
    if (command.Control !== 'slider') continue;
    assert.ok(command.Metric, `${command.ID} is a slider but names no metric`);
  }
});

test('destructive commands are flagged so the UI can confirm them', () => {
  for (const id of ['reboot', 'lock', 'clearCache', 'restart-ui']) {
    assert.equal(GetFreeKioskCommand(id).Destructive, true, `${id} must require confirmation`);
  }
});

test('an unknown command resolves to null rather than being trusted', () => {
  for (const id of ['', 'nope', '../api/js', null, undefined, 42, {}]) {
    assert.equal(GetFreeKioskCommand(id), null);
  }
});
