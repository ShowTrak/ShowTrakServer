const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const osc = loadWithMocks(methodPath('_osc-shared.js'), {})._internal;

// A fake Eos console: on the first request it replies (in OSC 1.0 length framing)
// with a ping echo, the version, and the cue-list / patch counts.
function startEosServer({ version = '3.2.1.4', cuelists = 5, patch = 240, echoPing = true } = {}) {
  return new Promise((resolve) => {
    const sockets = new Set();
    let requestCount = 0;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      let replied = false;
      socket.on('data', () => {
        requestCount += 1;
        if (replied) return;
        replied = true;
        const parts = [];
        if (echoPing) parts.push(osc.EncodeOscTcp('/eos/out/ping', ['showtrak'], 'length'));
        parts.push(osc.EncodeOscTcp('/eos/out/get/version', [version], 'length'));
        parts.push(osc.EncodeOscTcp('/eos/out/get/cuelist/count', [{ Int: cuelists }], 'length'));
        parts.push(osc.EncodeOscTcp('/eos/out/get/patch/count', [{ Int: patch }], 'length'));
        socket.write(Buffer.concat(parts));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        getRequestCount: () => requestCount,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

function startSilentServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

test('eos health is online and reports the version when the console answers', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  assert.equal(eos.ID, 'eos');
  const server = await startEosServer({ version: '3.2.1.4' });
  try {
    const result = await eos.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Framing: 'length', Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
    assert.equal(result.EosVersion, '3.2.1.4');
    assert.equal(typeof result.LatencyMs, 'number');
  } finally {
    await server.close();
  }
});

test('eos health degrades on an unexpected version prefix', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  const server = await startEosServer({ version: '3.1.0.0' });
  try {
    const result = await eos.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        Framing: 'length',
        Timeout: 1500,
        CheckVersion: true,
        ExpectedVersion: '3.2',
      },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /expected 3\.2/);
  } finally {
    await server.close();
  }
});

test('eos health is offline when the console never replies', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  const server = await startSilentServer();
  try {
    const result = await eos.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Framing: 'length', Timeout: 500 },
    });
    assert.equal(result.Success, false);
  } finally {
    await server.close();
  }
});

test('eos health is offline when the connection is refused', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  const tmp = await startSilentServer();
  const port = tmp.port;
  await tmp.close();
  const result = await eos.Run({
    Address: '127.0.0.1',
    Settings: { Port: port, Framing: 'length', Timeout: 1000 },
  });
  assert.equal(result.Success, false);
});

test('eos CheckShow is online when cue lists and patch are present', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  const server = await startEosServer({ cuelists: 3, patch: 96 });
  try {
    const result = await eos.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        Framing: 'length',
        Timeout: 1500,
        CheckShow: true,
        MinCueLists: 1,
        MinPatch: 1,
      },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
    assert.equal(result.CuelistCount, 3);
    assert.equal(result.PatchCount, 96);
  } finally {
    await server.close();
  }
});

test('eos CheckShow degrades on an empty / default show', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  const server = await startEosServer({ cuelists: 0, patch: 0 });
  try {
    const result = await eos.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        Framing: 'length',
        Timeout: 1500,
        CheckShow: true,
        MinCueLists: 1,
        MinPatch: 1,
      },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /No cue lists|Nothing patched/);
  } finally {
    await server.close();
  }
});

test('eos CheckShow off ignores an empty show', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  const server = await startEosServer({ cuelists: 0, patch: 0 });
  try {
    const result = await eos.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Framing: 'length', Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, 'show is not judged unless CheckShow is enabled');
  } finally {
    await server.close();
  }
});

test('eos validates address and port', async () => {
  const eos = loadWithMocks(methodPath('eos.js'), {});
  assert.equal((await eos.Run({})).Success, false);
  assert.equal((await eos.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } })).Success, false);
});
