const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// src/main/first-paint.ts gates showing the main window at startup on the
// renderer having its initial data, instead of a fixed 800 ms after load. A
// renderer that never initialises must still get its window shown.

function fresh() {
  const Resolved = require.resolve(path.join(__dirname, '..', 'dist', 'main', 'first-paint.js'));
  delete require.cache[Resolved];
  return require(Resolved);
}

test('waiters are released by the first delivery', async () => {
  const FP = fresh();
  let Done = false;
  const Waiting = FP.whenInitialStateDelivered(60_000).then(() => (Done = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(Done, false);
  FP.markInitialStateDelivered();
  await Waiting;
  assert.equal(Done, true);
  // Later waits resolve at once; repeat marks are harmless.
  FP.markInitialStateDelivered();
  await FP.whenInitialStateDelivered(60_000);
});

test('a renderer that never reports in is shown after the timeout anyway', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const FP = fresh();
  let Done = false;
  const Waiting = FP.whenInitialStateDelivered(5000).then(() => (Done = true));
  t.mock.timers.tick(4999);
  await new Promise((r) => setImmediate(r));
  assert.equal(Done, false);
  t.mock.timers.tick(1);
  await Waiting;
  assert.equal(Done, true);
});
