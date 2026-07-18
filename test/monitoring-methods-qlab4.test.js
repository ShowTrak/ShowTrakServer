const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const osc = require(methodPath('_osc-shared.js'));
const qlab4 = loadWithMocks(methodPath('qlab4.js'), {});

// A fake QLab 4 that answers a SLIP-framed `/workspaces` query with a JSON reply
// envelope. `workspaces` null => reply nothing (simulates a silent/hung QLab).
function startQLab4Server(workspaces) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { Messages, Rest } = osc.DecodeOscStream(buf, 'slip');
      buf = Rest;
      for (const msg of Messages) {
        if (msg.Address === '/workspaces' && workspaces) {
          const envelope = JSON.stringify({
            workspace_id: '',
            address: '/workspaces',
            status: 'ok',
            data: workspaces,
          });
          socket.write(osc.EncodeOscTcp('/reply/workspaces', [envelope], 'slip'));
        }
      }
    });
  });
  return new Promise((resolve) => {
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

test('qlab4 is online when the named workspace is open', async () => {
  const server = await startQLab4Server([{ uniqueID: 'WS', displayName: 'Hamlet.qlab4' }]);
  try {
    const r = await qlab4.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Hamlet' },
    });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded);
    assert.equal(r.Matched, true);
  } finally {
    await server.close();
  }
});

test('qlab4 is degraded ("Incorrect Workspace") when the named workspace is not open', async () => {
  const server = await startQLab4Server([{ uniqueID: 'WS', displayName: 'Macbeth' }]);
  try {
    const r = await qlab4.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Hamlet' },
    });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Incorrect Workspace/);
  } finally {
    await server.close();
  }
});

test('qlab4 with a blank workspace accepts any open workspace, degrades when none open', async () => {
  const withOne = await startQLab4Server([{ uniqueID: 'WS', displayName: 'Anything' }]);
  try {
    const r = await qlab4.Run({
      Address: '127.0.0.1',
      Settings: { Port: withOne.port, Workspace: '' },
    });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded);
  } finally {
    await withOne.close();
  }

  const withNone = await startQLab4Server([]);
  try {
    const r = await qlab4.Run({
      Address: '127.0.0.1',
      Settings: { Port: withNone.port, Workspace: '' },
    });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /No workspaces open/);
  } finally {
    await withNone.close();
  }
});

test('qlab4 is offline when QLab never replies', async () => {
  const server = await startQLab4Server(null); // never answers
  try {
    const r = await qlab4.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Hamlet', Timeout: 300 },
    });
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply/);
  } finally {
    await server.close();
  }
});

test('qlab4 validates address and port', async () => {
  assert.equal((await qlab4.Run({ Address: '', Settings: {} })).Success, false);
  const badPort = await qlab4.Run({ Address: '127.0.0.1', Settings: { Port: 999999 } });
  assert.equal(badPort.Success, false);
  assert.match(badPort.Error, /Invalid port/);
});

test('qlab4 Debug renders workspace cards and the no-reply branch', () => {
  const target = { Address: '10.0.0.5', Settings: { Port: 53000, Workspace: 'Main' } };
  const online = qlab4.Debug(
    {
      Success: true,
      LatencyMs: 12,
      Matched: true,
      Wanted: 'Main',
      Workspaces: [{ uniqueID: 'A1', displayName: 'Main', hasPasscode: true }],
    },
    target
  );
  assert.match(online, /Workspace open/);
  assert.match(online, /A1/);
  assert.match(online, /Passcode/);

  const offline = qlab4.Debug({ Success: false, Error: 'No reply from QLab' }, target);
  assert.match(offline, /No reply/);
  assert.match(offline, /Could not reach QLab/);
});
