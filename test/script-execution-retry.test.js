const test = require('node:test');
const assert = require('node:assert/strict');

// Exercises src/Modules/ScriptExecutionManager/retry.ts: which failed
// executions the panel may retry, and how they are grouped for re-dispatch.
// Retrying something the row cannot faithfully describe (a bulk shutdown, a
// deployment) would send the wrong command, so those must never qualify.
const {
  GetRetryTarget,
  PlanRetries,
  INTEGRATED_EVENT_PREFIX,
} = require('../dist/Modules/ScriptExecutionManager/retry');

const row = (RequestID, UUID, Script, extra = {}) => ({
  RequestID,
  Internal: false,
  Status: 'Failed',
  Client: { UUID },
  Script,
  ...extra,
});

test('a failed script is retried by its script ID', () => {
  assert.deepEqual(GetRetryTarget(row('r1', 'a', { ID: 'start', Name: 'Start Show' })), {
    Kind: 'script',
    ID: 'start',
  });
});

test('a failed integrated event is retried by the event ID in its name', () => {
  const Name = `${INTEGRATED_EVENT_PREFIX}power-on`;
  assert.deepEqual(GetRetryTarget(row('r1', 'a', { ID: Name, Name }, { Internal: true })), {
    Kind: 'event',
    ID: 'power-on',
  });
});

test('nothing else is retryable', () => {
  // Not failed.
  assert.equal(GetRetryTarget(row('r1', 'a', { ID: 'start' }, { Status: 'Completed' })), null);
  assert.equal(GetRetryTarget(row('r1', 'a', { ID: 'start' }, { Status: 'Pending' })), null);
  // Internal actions other than integrated events.
  for (const Name of [
    'Wake on LAN',
    'Deploying Scripts',
    'Restart',
    'Shutdown',
    'Integrated Event: ',
  ])
    assert.equal(
      GetRetryTarget(row('r1', 'a', { ID: Name, Name }, { Internal: true })),
      null,
      Name
    );
  // Missing pieces.
  assert.equal(GetRetryTarget(row('r1', null, { ID: 'start' })), null);
  assert.equal(GetRetryTarget(row('r1', 'a', null)), null);
  assert.equal(GetRetryTarget(null), null);
});

test('PlanRetries groups by action and lists each client once', () => {
  const Plan = PlanRetries([
    row('r1', 'a', { ID: 'start' }),
    row('r2', 'b', { ID: 'start' }),
    row('r3', 'a', { ID: 'start' }), // same client failed twice
    row('r4', 'a', { ID: 'stop' }),
    row('r5', 'c', { ID: 'Restart', Name: 'Restart' }, { Internal: true }),
    null,
  ]);
  assert.deepEqual(Plan, [
    { Kind: 'script', ID: 'start', Targets: ['a', 'b'], RequestIDs: ['r1', 'r2', 'r3'] },
    { Kind: 'script', ID: 'stop', Targets: ['a'], RequestIDs: ['r4'] },
  ]);
});
