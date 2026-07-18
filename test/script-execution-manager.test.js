const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function load(mocks) {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ScriptExecutionManager', 'index.js'),
    mocks
  );
}

const noopLogger = { CreateLogger: () => ({ error: () => {}, warn: () => {}, log: () => {} }) };

function baseMocks(overrides = {}) {
  let counter = 0;
  return {
    '../Logger': noopLogger,
    '../ScriptManager': {
      Manager: {
        Get: async (id) => ({
          ID: id,
          Name: id,
          Timeout: 5000,
          Platforms: { Windows: 'windows.bat', macOS: '', Linux: '' },
          CompatiblePlatforms: ['Windows'],
        }),
      },
    },
    '../ClientManager': {
      Manager: {
        Get: async (uuid) => [null, { UUID: uuid, OperatingSystem: 'Windows', Online: true }],
      },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../UUID': { Manager: { Generate: () => `req-${++counter}` } },
    ...overrides,
  };
}

test("ScriptExecutionManager appends and runs each client's scripts sequentially", async () => {
  const emitted = [];
  const dispatched = [];
  const mocks = baseMocks({
    '../Broadcast': { Manager: { emit: (event, data) => emitted.push({ event, data }) } },
  });
  const { Manager, SetDispatchHandler } = load(mocks);
  // The manager dispatches the next script for an idle client through this seam.
  SetDispatchHandler((uuid, requestId, scriptId) => dispatched.push({ uuid, requestId, scriptId }));

  assert.deepEqual(await Manager.GetAllExecutions(), []);

  const firstId = await Manager.AddToQueue('uuid-1', 'script-a');
  assert.ok(firstId);
  let all = await Manager.GetAllExecutions();
  assert.equal(all.length, 1);
  assert.equal(all[0].Status, 'Pending');
  assert.equal(all[0].Client.UUID, 'uuid-1');
  // The client was idle, so script-a dispatched immediately.
  assert.deepEqual(
    dispatched.map((d) => d.scriptId),
    ['script-a']
  );

  // Re-queuing the SAME client APPENDS a second row that waits its turn — it is
  // not dispatched while script-a is still running.
  const secondId = await Manager.AddToQueue('uuid-1', 'script-b');
  all = await Manager.GetAllExecutions();
  assert.equal(all.length, 2);
  assert.equal(all[1].RequestID, secondId);
  assert.deepEqual(
    dispatched.map((d) => d.scriptId),
    ['script-a']
  );

  // Completing script-a records its duration and frees the client to dispatch
  // the next queued script (script-b).
  await Manager.Complete(firstId, null);
  all = await Manager.GetAllExecutions();
  const completedFirst = all.find((e) => e.RequestID === firstId);
  assert.equal(completedFirst.Status, 'Completed');
  assert.equal(typeof completedFirst.Timer.Duration, 'number');
  assert.deepEqual(
    dispatched.map((d) => d.scriptId),
    ['script-a', 'script-b']
  );
  await Manager.Complete(secondId, null);

  // A different client runs in parallel; error completion marks failure.
  const thirdId = await Manager.AddToQueue('uuid-2', 'script-c');
  await Manager.Complete(thirdId, new Error('script blew up'));
  all = await Manager.GetAllExecutions();
  const failed = all.find((e) => e.RequestID === thirdId);
  assert.equal(failed.Status, 'Failed');
  assert.match(failed.Error, /blew up/);

  // ClearQueue empties the list and notifies the UI.
  await Manager.ClearQueue();
  assert.deepEqual(await Manager.GetAllExecutions(), []);
  assert.ok(emitted.some((e) => e.event === 'ScriptExecutionUpdated'));
});

test('ScriptExecutionManager ClearSettled preserves queued and running executions', async () => {
  const { Manager, SetDispatchHandler } = load(baseMocks());
  SetDispatchHandler(() => {});

  const runningId = await Manager.AddToQueue('uuid-1', 'script-a'); // dispatched, running
  const queuedId = await Manager.AddToQueue('uuid-1', 'script-b'); // waiting its turn
  const doneId = await Manager.AddToQueue('uuid-2', 'script-c');
  await Manager.Complete(doneId, null); // settled

  await Manager.ClearSettled();
  const remaining = await Manager.GetAllExecutions();
  const ids = remaining.map((e) => e.RequestID).sort();
  assert.deepEqual(ids, [runningId, queuedId].sort());
});

test('ScriptExecutionManager fails a queued script if its client goes offline before its turn', async () => {
  const dispatched = [];
  const { Manager, SetDispatchHandler } = load(baseMocks());
  SetDispatchHandler((uuid, requestId, scriptId) => dispatched.push({ uuid, requestId, scriptId }));

  const runningId = await Manager.AddToQueue('uuid-1', 'script-a'); // dispatched, running
  const queuedId = await Manager.AddToQueue('uuid-1', 'script-b'); // waiting its turn
  // Only script-a has been dispatched so far.
  assert.deepEqual(
    dispatched.map((d) => d.scriptId),
    ['script-a']
  );

  // The client disconnects while script-b waits. The stored Client is the live
  // instance the manager captured at enqueue, so flipping Online here mirrors
  // ClientManager marking the client offline mid-session.
  const all = await Manager.GetAllExecutions();
  const queued = all.find((e) => e.RequestID === queuedId);
  queued.Client.Online = false;

  // script-a finishes and frees the client. PumpClient must NOT dispatch script-b
  // into the void — it should fail it as offline and leave the client idle.
  await Manager.Complete(runningId, null);

  const settled = (await Manager.GetAllExecutions()).find((e) => e.RequestID === queuedId);
  assert.equal(settled.Status, 'Failed');
  assert.match(settled.Error, /offline/i);
  assert.deepEqual(
    dispatched.map((d) => d.scriptId),
    ['script-a'] // script-b was never dispatched
  );
});

test('ScriptExecutionManager ignores unknown scripts and clients', async () => {
  const { Manager } = load(
    baseMocks({
      '../ScriptManager': { Manager: { Get: async () => null } },
    })
  );
  const result = await Manager.AddToQueue('uuid-1', 'missing-script');
  assert.equal(result, undefined);
  assert.deepEqual(await Manager.GetAllExecutions(), []);

  const { Manager: Manager2 } = load(
    baseMocks({
      '../ClientManager': { Manager: { Get: async () => ['not found', null] } },
    })
  );
  assert.equal(await Manager2.AddToQueue('uuid-x', 'script-a'), undefined);
});

test('ScriptExecutionManager enqueues internal tasks', async () => {
  const { Manager } = load(baseMocks());
  const id = await Manager.AddInternalTaskToQueue('uuid-9', 'WakeOnLAN');
  assert.ok(id);
  const all = await Manager.GetAllExecutions();
  const task = all.find((e) => e.RequestID === id);
  assert.equal(task.Internal, true);
  assert.equal(task.Script.Name, 'WakeOnLAN');

  // Internal task for an unknown client is ignored.
  const { Manager: Manager2 } = load(
    baseMocks({ '../ClientManager': { Manager: { Get: async () => ['nope', null] } } })
  );
  assert.equal(await Manager2.AddInternalTaskToQueue('uuid-x', 'WOL'), undefined);
});

test('ScriptExecutionManager times out pending executions', async () => {
  const emitted = [];
  const { Manager } = load(
    baseMocks({
      '../Broadcast': { Manager: { emit: (event, data) => emitted.push({ event, data }) } },
      '../ScriptManager': {
        Manager: {
          Get: async (id) => ({
            ID: id,
            Name: id,
            Timeout: 20,
            Platforms: { Windows: 'windows.bat', macOS: '', Linux: '' },
            CompatiblePlatforms: ['Windows'],
          }),
        },
      },
    })
  );

  const id = await Manager.AddToQueue('uuid-timeout', 'slow-script');
  await new Promise((r) => setTimeout(r, 60));
  const all = await Manager.GetAllExecutions();
  const entry = all.find((e) => e.RequestID === id);
  assert.equal(entry.Status, 'Failed');
  assert.match(entry.Error, /timed out/i);
});

test('ScriptExecutionManager fails early when no script exists for client OS', async () => {
  const { Manager } = load(
    baseMocks({
      '../ClientManager': {
        Manager: {
          Get: async (uuid) => [null, { UUID: uuid, OperatingSystem: 'macOS', Online: true }],
        },
      },
      '../ScriptManager': {
        Manager: {
          Get: async (id) => ({
            ID: id,
            Name: id,
            Timeout: 5000,
            Platforms: { Windows: 'windows.bat', macOS: '', Linux: '' },
            CompatiblePlatforms: ['Windows'],
          }),
        },
      },
    })
  );

  const id = await Manager.AddToQueue('uuid-macos', 'script-windows-only');
  assert.ok(id);
  const all = await Manager.GetAllExecutions();
  const entry = all.find((e) => e.RequestID === id);
  assert.equal(entry.Status, 'Failed');
  assert.match(entry.Error, /(not sent|no\s+macos\s+script\s+is\s+configured)/i);
});

// Regression: pushing raw executions to a renderer crashed with "Failed to
// serialize arguments" because each entry carries a Client CLASS INSTANCE (has
// methods) and a live Node timer handle — neither survives structured clone.
test('ToPublicScriptExecution yields a renderer-safe (structured-clone-able) projection', async () => {
  const { Manager, ToPublicScriptExecution } = load(
    baseMocks({
      '../ClientManager': {
        Manager: {
          // Model the real Client instance: plain fields plus a method.
          Get: async (uuid) => [
            null,
            {
              UUID: uuid,
              Nickname: 'Booth PC',
              Hostname: 'booth-01',
              OperatingSystem: 'Windows',
              GroupID: 3,
              IP: '10.0.0.5',
              SetOnline() {},
            },
          ],
        },
      },
    })
  );

  // AddInternalTaskToQueue arms a timeout watchdog, so the raw entry also carries
  // a live TimeoutHandle.
  await Manager.AddInternalTaskToQueue('uuid-1', 'Wake On LAN');
  const [raw] = await Manager.GetAllExecutions();

  // The raw entry is exactly what used to be pushed — and it is not cloneable.
  assert.throws(() => structuredClone(raw));

  const pub = ToPublicScriptExecution(raw);
  // The projection survives the same structured clone the Electron/web push uses.
  assert.doesNotThrow(() => structuredClone(pub));

  assert.equal(pub.Client.UUID, 'uuid-1');
  assert.equal(pub.Client.Nickname, 'Booth PC');
  assert.equal(pub.Client.Hostname, 'booth-01');
  assert.equal(pub.Script.Name, 'Wake On LAN');
  assert.equal(pub.Status, 'Pending');
  // The non-cloneable fields must not leak into the projection.
  assert.equal('TimeoutHandle' in pub, false);
  assert.equal(typeof pub.Client.SetOnline, 'undefined');

  await Manager.ClearQueue();
});
