const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loggerStub() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    child: () => logger,
  };
  return { CreateLogger: () => logger };
}

// Real OSC codec (SLIP framing) used to build QLab-shaped replies in the fake server.
const osc = require(methodPath('_osc-shared.js'));

// Load the method + shared module together so both share one connection-manager
// instance (the method's Run() uses the same singleton we drive/stop here).
function loadHealth() {
  const method = loadWithMocks(methodPath('qlab5.js'), {
    '../Logger': loggerStub(),
  });
  const shared = require(methodPath('_qlab-shared.js'));
  return { method, shared };
}

// --- Pure helpers: _qlab-shared ---------------------------------------------

test('ParseQLabReply decodes the JSON envelope and routes by address', () => {
  const { shared } = loadHealth();
  const envelope = JSON.stringify({
    workspace_id: 'WS',
    address: '/workspace/WS/showMode',
    status: 'ok',
    data: true,
  });
  const reply = shared._internal.ParseQLabReply({
    Address: '/reply/workspace/WS/showMode',
    Args: [envelope],
  });
  assert.deepEqual(reply, {
    Address: '/workspace/WS/showMode',
    Status: 'ok',
    Data: true,
    WorkspaceID: 'WS',
  });
  shared._internal.QLabConnectionManager.Stop();
});

test('ParseQLabReply rejects non-reply and non-JSON messages', () => {
  const { shared } = loadHealth();
  assert.equal(
    shared._internal.ParseQLabReply({ Address: '/update/workspace/WS', Args: [] }),
    null
  );
  assert.equal(shared._internal.ParseQLabReply({ Address: '/reply/x', Args: ['not json'] }), null);
  shared._internal.QLabConnectionManager.Stop();
});

test('WorkspaceMatches matches on unique ID and normalized display name', () => {
  const { shared } = loadHealth();
  const ws = { uniqueID: 'ABC-123', displayName: 'Hamlet.qlab5' };
  assert.equal(shared._internal.WorkspaceMatches(ws, 'abc-123'), true);
  assert.equal(shared._internal.WorkspaceMatches(ws, 'Hamlet'), true);
  assert.equal(shared._internal.WorkspaceMatches(ws, 'hamlet.qlab5'), true);
  assert.equal(shared._internal.WorkspaceMatches(ws, 'Macbeth'), false);
  shared._internal.QLabConnectionManager.Stop();
});

test('NormalizeCueList coerces QLab cue dictionaries to clean refs', () => {
  const { shared } = loadHealth();
  const out = shared._internal.NormalizeCueList([
    { uniqueID: 'u1', number: 5, name: 'Go', listName: 'Main' },
    'garbage',
    { number: '10' },
  ]);
  assert.deepEqual(out, [
    { uniqueID: 'u1', number: '5', name: 'Go', listName: 'Main' },
    { uniqueID: '', number: '10', name: '', listName: '' },
  ]);
  shared._internal.QLabConnectionManager.Stop();
});

// --- Pure evaluation: qlab5 ----------------------------------------

function baseSnapshot(overrides = {}) {
  return {
    Connected: true,
    Ready: true,
    Error: null,
    WorkspaceFound: true,
    WorkspaceID: 'WS',
    WorkspaceName: 'Hamlet',
    ShowMode: null,
    RunningCues: [],
    Overrides: {},
    LastContactAt: Date.now(),
    Stale: false,
    ...overrides,
  };
}

test('EvaluateHealth: workspace mode pass / fail / unknown', () => {
  const { method } = loadHealth();
  const { EvaluateHealth, ParseHealthOptions } = method._internal;
  const opts = ParseHealthOptions({ Settings: { CheckMode: true, ExpectedMode: 'show' } });

  const pass = EvaluateHealth(baseSnapshot({ ShowMode: true }), opts);
  assert.equal(pass[0].Ok, true);

  const fail = EvaluateHealth(baseSnapshot({ ShowMode: false }), opts);
  assert.equal(fail[0].Ok, false);
  assert.match(fail[0].Detail, /edit mode.*expected show/);

  const unknown = EvaluateHealth(baseSnapshot({ ShowMode: null }), opts);
  assert.equal(unknown[0].Ok, null);
});

test('EvaluateHealth: workspace name exact vs contains matching', () => {
  const { method } = loadHealth();
  const { EvaluateHealth, ParseHealthOptions } = method._internal;
  const snap = baseSnapshot({ WorkspaceName: 'Hamlet Act 1' });

  const exact = ParseHealthOptions({
    Settings: {
      CheckWorkspaceName: true,
      ExpectedWorkspaceName: 'Hamlet Act 1',
      WorkspaceNameMatch: 'exact',
    },
  });
  assert.equal(EvaluateHealth(snap, exact)[0].Ok, true);

  const exactMiss = ParseHealthOptions({
    Settings: {
      CheckWorkspaceName: true,
      ExpectedWorkspaceName: 'Hamlet',
      WorkspaceNameMatch: 'exact',
    },
  });
  const missRes = EvaluateHealth(snap, exactMiss)[0];
  assert.equal(missRes.Ok, false);
  assert.match(missRes.Detail, /expected/);

  const contains = ParseHealthOptions({
    Settings: {
      CheckWorkspaceName: true,
      ExpectedWorkspaceName: 'hamlet',
      WorkspaceNameMatch: 'contains',
    },
  });
  assert.equal(EvaluateHealth(snap, contains)[0].Ok, true); // case-insensitive

  // No expected name → unknown (never a failure).
  const noExpect = ParseHealthOptions({ Settings: { CheckWorkspaceName: true } });
  assert.equal(EvaluateHealth(snap, noExpect)[0].Ok, null);
});

test('EvaluateHealth: running cues all vs any matching', () => {
  const { method } = loadHealth();
  const { EvaluateHealth, ParseHealthOptions } = method._internal;
  const snap = baseSnapshot({
    RunningCues: [{ uniqueID: 'uX', number: '1', name: 'A', listName: 'Main' }],
  });

  const all = ParseHealthOptions({
    Settings: { CheckRunningCues: true, RunningCues: ['1', '2'], RunningCuesMatch: 'all' },
  });
  const allRes = EvaluateHealth(snap, all)[0];
  assert.equal(allRes.Ok, false);
  assert.match(allRes.Detail, /Not running: 2/);

  const any = ParseHealthOptions({
    Settings: { CheckRunningCues: true, RunningCues: ['1', '2'], RunningCuesMatch: 'any' },
  });
  assert.equal(EvaluateHealth(snap, any)[0].Ok, true);

  // Unique-ID matching also works.
  const byId = ParseHealthOptions({
    Settings: { CheckRunningCues: true, RunningCues: ['uX'], RunningCuesMatch: 'all' },
  });
  assert.equal(EvaluateHealth(snap, byId)[0].Ok, true);
});

test('EvaluateHealth: overrides flags any engaged (disabled) subsystem', () => {
  const { method } = loadHealth();
  const { EvaluateHealth, ParseHealthOptions } = method._internal;
  const opts = ParseHealthOptions({ Settings: { CheckOverrides: true } });

  const clean = EvaluateHealth(baseSnapshot({ Overrides: { midiInputEnabled: true } }), opts)[0];
  assert.equal(clean.Ok, true);

  const engaged = EvaluateHealth(
    baseSnapshot({ Overrides: { midiInputEnabled: true, timecodeOutputEnabled: false } }),
    opts
  )[0];
  assert.equal(engaged.Ok, false);
  assert.match(engaged.Detail, /Overridden/);

  const unknown = EvaluateHealth(baseSnapshot({ Overrides: {} }), opts)[0];
  assert.equal(unknown.Ok, null);
});

// --- Integration: real loopback QLab-shaped server --------------------------

// A fake QLab that speaks SLIP-framed OSC over TCP: answers /workspaces, then the
// core attribute queries, letting us drive the persistent connection manager for real.
function startQLabServer(state) {
  const sockets = new Set();
  const reply = (socket, address, data) => {
    const envelope = JSON.stringify({ workspace_id: 'WS', address, status: 'ok', data });
    socket.write(osc.EncodeOscTcp('/reply' + address, [envelope], 'slip'));
  };
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
        const a = msg.Address;
        if (a === '/workspaces') {
          reply(socket, '/workspaces', [{ uniqueID: 'WS', displayName: state.name }]);
        } else if (a.endsWith('/showMode')) {
          reply(socket, a, state.showMode);
        } else if (a.endsWith('/runningOrPausedCues')) {
          reply(socket, a, state.running);
        } else {
          const ov = /\/overrides\/([A-Za-z]+)$/.exec(a);
          if (ov && state.overrides[ov[1]] !== undefined) reply(socket, a, state.overrides[ov[1]]);
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

function waitFor(fn, { timeout = 4000, interval = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let value;
      try {
        value = fn();
      } catch (e) {
        return reject(e);
      }
      if (value) return resolve(value);
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(tick, interval);
    };
    tick();
  });
}

test('integration: persistent connection resolves the workspace and evaluates toggles', async () => {
  const { method, shared } = loadHealth();
  const server = await startQLabServer({
    name: 'Hamlet',
    showMode: true,
    running: [{ uniqueID: 'u1', number: '5', name: 'Go', listName: 'Main' }],
    overrides: { timecodeInputEnabled: true, midiInputEnabled: true },
  });
  const target = {
    Address: '127.0.0.1',
    Settings: {
      Port: server.port,
      Workspace: 'Hamlet',
      CheckMode: true,
      ExpectedMode: 'show',
      CheckRunningCues: true,
      RunningCues: ['5'],
      RunningCuesMatch: 'all',
      CheckOverrides: true,
    },
  };

  try {
    // First Run kicks off Observe(); poll until the snapshot is populated —
    // including the GLOBAL /overrides/{key} replies (regression: these were
    // previously queried workspace-scoped and never landed → "unknown").
    method.Run(target);
    const result = await waitFor(() => {
      const r = method.Run(target);
      return r.Success && r.ShowMode === true && Object.keys(r.Overrides || {}).length ? r : null;
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, `expected healthy, got: ${result.DegradedReason}`);
    assert.equal(result.Overrides.timecodeInputEnabled, true);
    assert.equal(result.WorkspaceName, 'Hamlet');
    assert.equal(result.RunningCues.length, 1);

    // Now assert a failing toggle produces Degraded.
    const badTarget = {
      ...target,
      Settings: { ...target.Settings, ExpectedMode: 'edit' },
    };
    const degraded = method.Run(badTarget);
    assert.equal(degraded.Success, true);
    assert.equal(degraded.Degraded, true);
    assert.match(degraded.DegradedReason, /edit/);
  } finally {
    shared._internal.QLabConnectionManager.Stop();
    await server.close();
  }
});

test('integration: blank workspace targets whichever workspace is open', async () => {
  const { method, shared } = loadHealth();
  const server = await startQLabServer({
    name: 'Hamlet',
    showMode: false,
    running: [],
    overrides: {},
  });
  // No Workspace configured; assert the open workspace's name contains "aml".
  const target = {
    Address: '127.0.0.1',
    Settings: {
      Port: server.port,
      CheckWorkspaceName: true,
      ExpectedWorkspaceName: 'aml',
      WorkspaceNameMatch: 'contains',
    },
  };
  try {
    method.Run(target);
    const result = await waitFor(() => {
      const r = method.Run(target);
      return r.Success && r.WorkspaceName ? r : null;
    });
    assert.equal(result.WorkspaceName, 'Hamlet');
    assert.ok(!result.Degraded, `expected healthy, got: ${result.DegradedReason}`);

    // A name that isn't contained → Degraded.
    const bad = method.Run({
      ...target,
      Settings: { ...target.Settings, ExpectedWorkspaceName: 'Macbeth' },
    });
    assert.equal(bad.Degraded, true);
  } finally {
    shared._internal.QLabConnectionManager.Stop();
    await server.close();
  }
});

test('integration: unresolved workspace reports offline while connecting', async () => {
  const { method, shared } = loadHealth();
  // Point at a closed port so no connection establishes.
  const target = { Address: '127.0.0.1', Settings: { Port: 59, Workspace: 'Hamlet' } };
  try {
    const r = method.Run(target);
    assert.equal(r.Success, false);
    assert.ok(/Connecting to QLab|No address|Invalid|response/.test(r.Error));
  } finally {
    shared._internal.QLabConnectionManager.Stop();
  }
});
