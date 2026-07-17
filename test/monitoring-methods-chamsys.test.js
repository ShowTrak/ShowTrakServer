const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function startServer(body, status = 200) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/html');
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const MAGICQ_PAGE =
  '<html><head><title>MagicQ</title></head><body>ChamSys MagicQ v1.9.4.0 &mdash; Console</body></html>';

test('chamsys is online and reports the MagicQ version', async () => {
  const cq = loadWithMocks(methodPath('chamsys.js'), {});
  assert.equal(cq.ID, 'chamsys');
  const server = await startServer(MAGICQ_PAGE);
  try {
    const result = await cq.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
    assert.equal(result.MagicQVersion, '1.9.4.0');
  } finally {
    await server.close();
  }
});

test('chamsys degrades on an unexpected version prefix', async () => {
  const cq = loadWithMocks(methodPath('chamsys.js'), {});
  const server = await startServer(MAGICQ_PAGE);
  try {
    const result = await cq.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500, ExpectedVersion: '1.8' },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /expected 1\.8/);
  } finally {
    await server.close();
  }
});

test('chamsys degrades when the server does not look like MagicQ', async () => {
  const cq = loadWithMocks(methodPath('chamsys.js'), {});
  const server = await startServer('<html><body>nginx welcome</body></html>');
  try {
    const result = await cq.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /MagicQ/);
  } finally {
    await server.close();
  }
});

test('chamsys is offline (with an enable hint) when the web server is refused', async () => {
  const cq = loadWithMocks(methodPath('chamsys.js'), {});
  const tmp = await startServer(MAGICQ_PAGE);
  const port = tmp.port;
  await tmp.close();
  const result = await cq.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(result.Success, false);
  assert.match(String(result.Error), /web server/i);
});

test('chamsys internal helpers fingerprint and parse the version', () => {
  const cq = loadWithMocks(methodPath('chamsys.js'), {});
  const { IsMagicQBody, ExtractMagicQVersion } = cq._internal;
  assert.equal(IsMagicQBody(MAGICQ_PAGE), true);
  assert.equal(IsMagicQBody('<html>apache</html>'), false);
  assert.equal(ExtractMagicQVersion('MagicQ v1.9.4.0'), '1.9.4.0');
  assert.equal(ExtractMagicQVersion('no version here'), null);
});
