const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// A fake Titan WebAPI: answers the two read-only /titan/get endpoints with JSON.
function startTitanServer({ version = '17.0.0.42', show = 'My Show' } = {}) {
  return new Promise((resolve) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount += 1;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/titan/get/System/SoftwareVersion') {
        res.statusCode = 200;
        res.end(JSON.stringify(version));
      } else if (req.url === '/titan/get/Show/ShowName') {
        res.statusCode = 200;
        res.end(JSON.stringify(show));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        getRequestCount: () => requestCount,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('avolites health is online and reports the Titan version', async () => {
  const av = loadWithMocks(methodPath('avolites.js'), {});
  assert.equal(av.ID, 'avolites');
  const server = await startTitanServer({ version: '17.0.0.42' });
  try {
    const result = await av.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
    assert.equal(result.TitanVersion, '17.0.0.42');
  } finally {
    await server.close();
  }
});

test('avolites health degrades on an unexpected version', async () => {
  const av = loadWithMocks(methodPath('avolites.js'), {});
  const server = await startTitanServer({ version: '16.2.0.0' });
  try {
    const result = await av.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500, ExpectedVersion: '17' },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /expected 17/);
  } finally {
    await server.close();
  }
});

test('avolites is offline (with an enable hint) when the WebAPI port is refused', async () => {
  const av = loadWithMocks(methodPath('avolites.js'), {});
  const tmp = await startTitanServer();
  const port = tmp.port;
  await tmp.close();
  const result = await av.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(result.Success, false);
  assert.match(String(result.Error), /WebAPI/i);
});

test('avolites-show confirms the expected show and degrades on a mismatch', async () => {
  const avShow = loadWithMocks(methodPath('avolites-show.js'), {});
  assert.equal(avShow.ID, 'avolites-show');
  const server = await startTitanServer({ show: 'Panto 2026' });
  try {
    const ok = await avShow.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500, ExpectedShow: 'Panto 2026' },
    });
    assert.equal(ok.Success, true);
    assert.ok(!ok.Degraded);

    const wrong = await avShow.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500, ExpectedShow: 'Different Show' },
    });
    assert.equal(wrong.Success, true);
    assert.equal(wrong.Degraded, true);
    assert.match(wrong.DegradedReason, /expected "Different Show"/);
  } finally {
    await server.close();
  }
});

test('avolites ExtractTitanValue tolerates envelope variations', () => {
  const shared = loadWithMocks(methodPath('_avolites-shared.js'), {});
  const { ExtractTitanValue } = shared._internal;
  assert.equal(ExtractTitanValue('"17.0.0"'), '17.0.0');
  assert.equal(ExtractTitanValue('17.0.0'), '17.0.0');
  assert.equal(ExtractTitanValue(JSON.stringify({ value: '3.1' })), '3.1');
  assert.equal(ExtractTitanValue(JSON.stringify({ result: 'Show A' })), 'Show A');
  assert.equal(ExtractTitanValue(''), null);
});
