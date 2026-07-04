const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'src', 'Modules', 'MonitoringMethods', name);
}

function loadQlab() {
  return loadWithMocks(methodPath('qlab.js'), {});
}

// --- OSC framing helpers (mirror QLab's SLIP-framed TCP replies) ------------
const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;
function oscPad(len) {
  return (4 - (len % 4)) % 4;
}
function oscStr(s) {
  const body = Buffer.from(String(s), 'utf8');
  const withNull = Buffer.concat([body, Buffer.from([0])]);
  const pad = oscPad(withNull.length);
  return pad ? Buffer.concat([withNull, Buffer.alloc(pad)]) : withNull;
}
function slipFrame(packet) {
  const out = [SLIP_END];
  for (const b of packet) {
    if (b === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (b === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(b);
  }
  out.push(SLIP_END);
  return Buffer.from(out);
}
function buildWorkspacesReply(workspaces) {
  const json = JSON.stringify({ status: 'ok', address: '/workspaces', data: workspaces });
  const packet = Buffer.concat([oscStr('/reply/workspaces'), oscStr(',s'), oscStr(json)]);
  return slipFrame(packet);
}

// A QLab-like TCP server that replies to any request with the workspace list.
function startQlabServer(workspaces) {
  return new Promise((resolve) => {
    const sockets = new Set();
    let requestCount = 0;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => {
        requestCount += 1;
        socket.write(buildWorkspacesReply(workspaces));
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

// A server that accepts connections but never replies.
function startSilentServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      /* swallow all data, never reply */
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

const WORKSPACES = [
  { uniqueID: '63B4494C-CFA6-4EA0-8B60-53E7C7137A0D', displayName: 'Main Show', hasPasscode: false },
  { uniqueID: 'AA11BB22-0000-0000-0000-1234567890AB', displayName: 'Backup Show', hasPasscode: true },
];

test('qlab method reports online when the workspace name matches', async () => {
  const qlab = loadQlab();
  assert.equal(qlab.ID, 'qlab-workspace');
  assert.ok(Array.isArray(qlab.Settings));

  const server = await startQlabServer(WORKSPACES);
  try {
    const result = await qlab.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Main Show', Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
    assert.equal(typeof result.LatencyMs, 'number');
  } finally {
    await server.close();
  }
});

test('qlab method matches by unique ID and tolerates a .qlab5 filename', async () => {
  const qlab = loadQlab();
  const server = await startQlabServer(WORKSPACES);
  try {
    const byId = await qlab.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: '63B4494C-CFA6-4EA0-8B60-53E7C7137A0D' },
    });
    assert.equal(byId.Success, true);
    assert.ok(!byId.Degraded);

    const byFilename = await qlab.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Backup Show.qlab5' },
    });
    assert.equal(byFilename.Success, true);
    assert.ok(!byFilename.Degraded);
  } finally {
    await server.close();
  }
});

test('qlab method is degraded with "Incorrect Workspace" when no workspace matches', async () => {
  const qlab = loadQlab();
  const server = await startQlabServer(WORKSPACES);
  try {
    const result = await qlab.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Some Other Show', Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Incorrect Workspace');
  } finally {
    await server.close();
  }
});

test('qlab method reuses one workspace query for different workspace checks to same host/settings', async () => {
  const qlab = loadQlab();
  const server = await startQlabServer(WORKSPACES);
  try {
    const First = await qlab.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Main Show', Timeout: 2000 },
    });
    assert.equal(First.Success, true);
    assert.ok(!First.Degraded);

    const Second = await qlab.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Some Other Show', Timeout: 2000 },
    });
    assert.equal(Second.Success, true);
    assert.equal(Second.Degraded, true);
    assert.equal(Second.DegradedReason, 'Incorrect Workspace');

    assert.equal(server.getRequestCount(), 1);
  } finally {
    await server.close();
  }
});

test('qlab method is offline when QLab never replies', async () => {
  const qlab = loadQlab();
  const server = await startSilentServer();
  try {
    const result = await qlab.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: 'Main Show', Timeout: 500 },
    });
    assert.equal(result.Success, false);
    assert.match(result.Error, /no reply/i);
  } finally {
    await server.close();
  }
});

test('qlab method is offline when the connection is refused', async () => {
  const qlab = loadQlab();
  // Reserve a port then close it so the connection is refused.
  const tmp = await startSilentServer();
  const port = tmp.port;
  await tmp.close();

  const result = await qlab.Run({
    Address: '127.0.0.1',
    Settings: { Port: port, Workspace: 'Main Show', Timeout: 1000 },
  });
  assert.equal(result.Success, false);
});

test('qlab method validates address, port and workspace configuration', async () => {
  const qlab = loadQlab();

  assert.equal((await qlab.Run({})).Success, false);
  assert.equal(
    (await qlab.Run({ Address: '127.0.0.1', Settings: { Port: 70000, Workspace: 'x' } })).Success,
    false
  );
  assert.equal(
    (await qlab.Run({ Address: '127.0.0.1', Settings: { Port: 53000, Workspace: '' } })).Success,
    false
  );
});

test('qlab internal helpers encode requests and match workspaces correctly', () => {
  const qlab = loadQlab();
  const { EncodeOscMessageTcp, ExtractWorkspaceData, WorkspaceMatches, NormalizeWorkspace } =
    qlab._internal;

  // Encoded request is a SLIP-framed OSC /workspaces message.
  const framed = EncodeOscMessageTcp('/workspaces');
  assert.equal(framed[0], SLIP_END);
  assert.equal(framed[framed.length - 1], SLIP_END);
  const inner = framed.subarray(1, framed.length - 1);
  assert.ok(inner.toString('utf8').startsWith('/workspaces'));

  // Decoder pulls the data array back out of a framed reply.
  const reply = buildWorkspacesReply(WORKSPACES);
  const data = ExtractWorkspaceData(reply);
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 2);

  assert.equal(NormalizeWorkspace('My Show.qlab5'), 'my show');
  assert.equal(WorkspaceMatches(WORKSPACES[0], 'main show'), true);
  assert.equal(WorkspaceMatches(WORKSPACES[0], '63b4494c-cfa6-4ea0-8b60-53e7c7137a0d'), true);
  assert.equal(WorkspaceMatches(WORKSPACES[0], 'Nope'), false);
});
