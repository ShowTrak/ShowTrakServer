const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function load(mocks) {
  return loadWithMocks(
    path.join(__dirname, '..', 'src', 'Modules', 'ScriptExecutionManager', 'index.js'),
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
      Manager: { Get: async (uuid) => [null, { UUID: uuid, OperatingSystem: 'Windows' }] },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../UUID': { Manager: { Generate: () => `req-${++counter}` } },
    ...overrides,
  };
}

test('ScriptExecutionManager queues, replaces, and completes script executions', async () => {
  const emitted = [];
  const mocks = baseMocks({
    '../Broadcast': { Manager: { emit: (event, data) => emitted.push({ event, data }) } },
  });
  const { Manager } = load(mocks);

  assert.deepEqual(await Manager.GetAllExecutions(), []);

  const requestId = await Manager.AddToQueue('uuid-1', 'script-a');
  assert.ok(requestId);
  let all = await Manager.GetAllExecutions();
  assert.equal(all.length, 1);
  assert.equal(all[0].Status, 'Pending');
  assert.equal(all[0].Client.UUID, 'uuid-1');

  // Re-queuing the same client replaces the existing entry (still one row).
  const secondId = await Manager.AddToQueue('uuid-1', 'script-b');
  all = await Manager.GetAllExecutions();
  assert.equal(all.length, 1);
  assert.equal(all[0].RequestID, secondId);

  // Completing marks the entry as completed and records duration.
  await Manager.Complete(secondId, null);
  all = await Manager.GetAllExecutions();
  assert.equal(all[0].Status, 'Completed');
  assert.equal(typeof all[0].Timer.Duration, 'number');

  // Completing with an error marks failure.
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
        Manager: { Get: async (uuid) => [null, { UUID: uuid, OperatingSystem: 'macOS' }] },
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
