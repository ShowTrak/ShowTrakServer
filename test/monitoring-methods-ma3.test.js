const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// A bare TCP listener standing in for the grandMA3 Web Remote port.
function startListener() {
  return new Promise((resolve) => {
    const sockets = new Set();
    let dataSeen = false;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('data', () => {
        dataSeen = true;
      });
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        sawData: () => dataSeen,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

test('ma3 is online when the Web Remote port accepts a connection', async () => {
  const ma3 = loadWithMocks(methodPath('ma3.js'), {});
  assert.equal(ma3.ID, 'ma3');
  const server = await startListener();
  try {
    const result = await ma3.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1000 },
    });
    assert.equal(result.Success, true);
    assert.equal(typeof result.LatencyMs, 'number');
    // The probe must never send data to a live console.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.sawData(), false);
  } finally {
    await server.close();
  }
});

test('ma3 is offline when the port is refused', async () => {
  const ma3 = loadWithMocks(methodPath('ma3.js'), {});
  const tmp = await startListener();
  const port = tmp.port;
  await tmp.close();
  const result = await ma3.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(result.Success, false);
});

test('ma3 validates address and port', async () => {
  const ma3 = loadWithMocks(methodPath('ma3.js'), {});
  assert.equal((await ma3.Run({})).Success, false);
  assert.equal((await ma3.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } })).Success, false);
});
