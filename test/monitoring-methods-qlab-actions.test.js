const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// QLab 4 and QLab 5 actions against a fake QLab that behaves like one with
// /alwaysReply on: every message is acknowledged, setters carry no data, and a
// command can be made to come back 'denied' or 'error'. Every workspace
// command must arrive workspace-scoped — unscoped, QLab 5 would run it in
// every open workspace.

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
    child: () => logger,
  };
  return { CreateLogger: () => logger };
}

const osc = require(methodPath('_osc-shared.js'));

function startQLab(state) {
  const received = [];
  const sockets = new Set();
  const reply = (socket, address, status, data) => {
    const body = { workspace_id: 'WS', address, status };
    if (data !== undefined) body.data = data;
    socket.write(osc.EncodeOscTcp('/reply' + address, [JSON.stringify(body)], 'slip'));
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
        const args = msg.Args || [];
        received.push({ Address: a, Args: args });
        if (a === '/alwaysReply') continue;
        if (a === '/workspaces') {
          reply(socket, a, 'ok', state.workspaces ?? [{ uniqueID: 'WS', displayName: 'Hamlet' }]);
          continue;
        }
        const suffix = a.replace(/^\/workspace\/[^/]+/, '');
        if (suffix === '/connect') {
          reply(socket, a, 'ok', args[0] === state.passcode ? 'ok' : 'badpass');
          continue;
        }
        if (state.refuse && state.refuse[suffix]) {
          reply(socket, a, state.refuse[suffix]);
          continue;
        }
        if (suffix === '/showMode') {
          if (args.length) {
            state.showMode = args[0] === true || args[0] === 1;
            reply(socket, a, 'ok');
          } else reply(socket, a, 'ok', state.showMode);
          continue;
        }
        if (suffix === '/runningOrPausedCues') {
          reply(socket, a, 'ok', []);
          continue;
        }
        const ov = /^\/overrides\/([A-Za-z]+)$/.exec(suffix);
        if (ov) {
          if (args.length) {
            state.overrides[ov[1]] = args[0];
            reply(socket, a, 'ok');
          } else if (state.overrides[ov[1]] !== undefined) {
            reply(socket, a, 'ok', state.overrides[ov[1]]);
          } else {
            reply(socket, a, 'error');
          }
          continue;
        }
        // Anything else (go, stop, panic, ...) is a command: acknowledge it.
        reply(socket, a, 'ok');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        commands: () =>
          received.filter((m) => m.Address.startsWith('/workspace/') || m.Args.length),
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

function waitFor(fn, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = fn();
      if (value) return resolve(value);
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function loadQLab5() {
  const method = loadWithMocks(methodPath('qlab5.js'), { '../Logger': loggerStub() });
  const shared = require(methodPath('_qlab-shared.js'));
  return { method, shared };
}

// Start a QLab 5 check and wait for its persistent connection to come up.
async function connectedQLab5(state) {
  const { method, shared } = loadQLab5();
  const server = await startQLab(state);
  const target = {
    Address: '127.0.0.1',
    Settings: { Port: server.port, Workspace: 'Hamlet', CheckMode: true, CheckOverrides: true },
  };
  await waitFor(() => {
    const r = method.Run(target);
    return r.Success && r.ShowMode !== null && Object.keys(r.Overrides || {}).length;
  });
  const done = async () => {
    shared.QLabConnectionManager.Stop();
    await server.close();
  };
  return { method, server, target, done };
}

const sent = (server, suffix) =>
  server.received.filter((m) => m.Address.replace(/^\/workspace\/[^/]+/, '') === suffix);

// --- Pure -------------------------------------------------------------------

test('BuildQLabCommand maps each shared action to its workspace message', () => {
  const { BuildQLabCommand } = require(methodPath('_qlab-shared.js'));
  assert.deepEqual(BuildQLabCommand('go', {}, 5), { Address: '/go', Args: [], Detail: 'GO sent' });
  // A cue number always travels as a string: QLab ignores `/go 53`.
  assert.deepEqual(BuildQLabCommand('go.cue', { Cue: ' 12 ' }, 5).Args, ['12']);
  assert.match(BuildQLabCommand('go.cue', { Cue: '' }, 5).Error, /cue number/);
  assert.equal(BuildQLabCommand('stop.hard', {}, 5).Address, '/hardStop');
  // QLab 5 takes a boolean for show mode, QLab 4 a number.
  assert.deepEqual(BuildQLabCommand('mode.show', {}, 5).Args, [true]);
  assert.deepEqual(BuildQLabCommand('mode.edit', {}, 4).Args, [{ Int: 0 }]);
  assert.match(BuildQLabCommand('nope', {}, 5).Error, /Unknown QLab action/);
});

test('the actions that cut a running show short ask first; GO does not', () => {
  const { method } = loadQLab5();
  const byId = Object.fromEntries(method.Actions.map((Action) => [Action.ID, Action]));
  for (const id of ['stop', 'panic', 'stop.hard', 'reset', 'override.disable']) {
    assert.equal(byId[id].Destructive, true, id);
  }
  for (const id of ['go', 'go.cue', 'pause', 'resume', 'mode.show', 'overrides.restore']) {
    assert.ok(!byId[id].Destructive, id);
  }
  assert.equal(method.DescribeAction('go.cue', { Cue: '12' }), 'GO Cue — 12');
  assert.equal(
    method.DescribeAction('override.enable', { Override: 'midiInputEnabled' }),
    'Enable MIDI Input'
  );
});

// --- QLab 5 -----------------------------------------------------------------

test('qlab5 GO is sent workspace-scoped over the existing connection', async () => {
  const q = await connectedQLab5({ showMode: true, overrides: { midiInputEnabled: true } });
  try {
    const r = await q.method.RunAction(q.target, 'go', {});
    assert.deepEqual(r, { Success: true, Detail: 'GO sent' });
    const go = sent(q.server, '/go');
    assert.equal(go.length, 1);
    assert.equal(go[0].Address, '/workspace/WS/go');

    const cue = await q.method.RunAction(q.target, 'go.cue', { Cue: '12' });
    assert.equal(cue.Detail, 'GO sent to cue 12');
    assert.deepEqual(sent(q.server, '/go')[1].Args, ['12']);
  } finally {
    await q.done();
  }
});

test('qlab5 Show Mode lands in the snapshot before the action returns', async () => {
  const q = await connectedQLab5({ showMode: false, overrides: { midiInputEnabled: true } });
  try {
    assert.equal(q.method.Run(q.target).Degraded, true);
    const r = await q.method.RunAction(q.target, 'mode.show', {});
    assert.equal(r.Success, true);
    // The re-probe fired straight after an action must already see show mode.
    const after = q.method.Run(q.target);
    assert.equal(after.ShowMode, true);
    assert.ok(!after.Degraded);
  } finally {
    await q.done();
  }
});

test('qlab5 Enable All I/O switches back on only what QLab reported off', async () => {
  const q = await connectedQLab5({
    showMode: true,
    overrides: { midiInputEnabled: false, dmxOutputEnabled: false, timecodeInputEnabled: true },
  });
  try {
    const r = await q.method.RunAction(q.target, 'overrides.restore', {});
    assert.deepEqual(r, { Success: true, Detail: 'DMX Output, MIDI Input enabled' });
    const sets = q.server.received.filter(
      (m) => m.Address.startsWith('/overrides/') && m.Args.length
    );
    assert.deepEqual(
      sets.map((m) => [m.Address, m.Args[0]]),
      [
        ['/overrides/dmxOutputEnabled', true],
        ['/overrides/midiInputEnabled', true],
      ]
    );
    assert.ok(!q.method.Run(q.target).Degraded);

    const again = await q.method.RunAction(q.target, 'overrides.restore', {});
    assert.equal(again.Detail, 'Every input and output is already enabled');
  } finally {
    await q.done();
  }
});

test('qlab5 Disable I/O takes the chosen override and rejects anything else', async () => {
  const q = await connectedQLab5({ showMode: true, overrides: { midiInputEnabled: true } });
  try {
    const r = await q.method.RunAction(q.target, 'override.disable', {
      Override: 'midiInputEnabled',
    });
    assert.deepEqual(r, { Success: true, Detail: 'MIDI Input disabled' });
    const bad = await q.method.RunAction(q.target, 'override.disable', { Override: 'reset' });
    assert.equal(bad.Success, false);
  } finally {
    await q.done();
  }
});

test('qlab5 reports a denied command as a passcode/permission problem', async () => {
  const q = await connectedQLab5({
    showMode: true,
    overrides: { midiInputEnabled: true },
    refuse: { '/go': 'denied', '/panic': 'error' },
  });
  try {
    const denied = await q.method.RunAction(q.target, 'go', {});
    assert.equal(denied.Success, false);
    assert.match(denied.Error, /passcode/);
    const failed = await q.method.RunAction(q.target, 'panic', {});
    assert.equal(failed.Success, false);
    assert.match(failed.Error, /could not carry out/);
  } finally {
    await q.done();
  }
});

test('qlab5 refuses an action while it has no connection to send it on', async () => {
  const { method, shared } = loadQLab5();
  try {
    // Nothing listens here; the connection is still being attempted.
    const r = await method.RunAction(
      { Address: '127.0.0.1', Settings: { Port: 1, Workspace: '' } },
      'go',
      {}
    );
    assert.equal(r.Success, false);
  } finally {
    shared.QLabConnectionManager.Stop();
  }
});

// --- QLab 4 -----------------------------------------------------------------

const qlab4 = loadWithMocks(methodPath('qlab4.js'), {});

test('qlab4 resolves the workspace then sends the command to it', async () => {
  const server = await startQLab({ overrides: {} });
  try {
    const r = await qlab4.RunAction(
      { Address: '127.0.0.1', Settings: { Port: server.port, Workspace: 'Hamlet' } },
      'mode.show',
      {}
    );
    assert.deepEqual(r, { Success: true, Detail: 'Switched to show mode' });
    const mode = sent(server, '/showMode');
    assert.equal(mode[0].Address, '/workspace/WS/showMode');
    assert.deepEqual(mode[0].Args, [1]);
    // /alwaysReply goes first, or QLab 4 would not acknowledge the command.
    assert.equal(server.received[0].Address, '/alwaysReply');
  } finally {
    await server.close();
  }
});

test('qlab4 sends the passcode first and stops on a wrong one', async () => {
  const server = await startQLab({ overrides: {}, passcode: '1234' });
  try {
    const target = (Passcode) => ({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Workspace: '', Passcode },
    });
    const ok = await qlab4.RunAction(target('1234'), 'go', {});
    assert.equal(ok.Success, true);
    const bad = await qlab4.RunAction(target('9999'), 'go', {});
    assert.equal(bad.Success, false);
    assert.match(bad.Error, /passcode/);
    assert.equal(sent(server, '/go').length, 1);
  } finally {
    await server.close();
  }
});

test('qlab4 refuses when the workspace is not open, and on a denied command', async () => {
  const server = await startQLab({ overrides: {}, refuse: { '/stop': 'denied' } });
  try {
    const missing = await qlab4.RunAction(
      { Address: '127.0.0.1', Settings: { Port: server.port, Workspace: 'Macbeth' } },
      'go',
      {}
    );
    assert.equal(missing.Success, false);
    assert.match(missing.Error, /Workspace not open/);

    const denied = await qlab4.RunAction(
      { Address: '127.0.0.1', Settings: { Port: server.port, Workspace: 'Hamlet' } },
      'stop',
      {}
    );
    assert.equal(denied.Success, false);
    assert.match(denied.Error, /denied/);
  } finally {
    await server.close();
  }
});

test('qlab4 times out cleanly against a QLab that never answers', async () => {
  const server = net.createServer((socket) => socket.on('error', () => {}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await qlab4.RunAction(
      { Address: '127.0.0.1', Settings: { Port: server.address().port, Timeout: 300 } },
      'go',
      {}
    );
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply from QLab after 300ms/);
  } finally {
    server.close();
  }
});
