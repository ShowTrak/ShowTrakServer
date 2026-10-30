const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/Modules/Server/rejection-backoff.ts. Clients adopted by another
// server identity restart straight back after `Unadopt`, so without this a
// single such client reconnected ~80 times a second, forever.

const { RejectionBackoff, RESET_MS, MAX_TRACKED } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'Server', 'rejection-backoff.js')
);

test('the first rejection is immediate, repeats back off exponentially to a cap', () => {
  const B = new RejectionBackoff();
  const Delays = [];
  for (let I = 0; I < 9; I++) Delays.push(B.NextDelayMs('u1', 1000 + I));
  assert.deepEqual(Delays, [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('clients are tracked independently', () => {
  const B = new RejectionBackoff();
  B.NextDelayMs('u1', 0);
  B.NextDelayMs('u1', 1);
  assert.equal(B.NextDelayMs('u2', 2), 0);
});

test('a client quiet for the reset window starts again from immediate', () => {
  const B = new RejectionBackoff();
  B.NextDelayMs('u1', 0);
  assert.equal(B.NextDelayMs('u1', 10), 1000);
  assert.equal(B.NextDelayMs('u1', 10 + RESET_MS + 1), 0);
});

test('the tracked set stays bounded', () => {
  const B = new RejectionBackoff();
  for (let I = 0; I < MAX_TRACKED * 3; I++) B.NextDelayMs(`u${I}`, I);
  // The newest client is still tracked; the oldest were evicted.
  assert.equal(B.Count(`u${MAX_TRACKED * 3 - 1}`), 1);
  assert.equal(B.Count('u0'), 0);
});
