const test = require('node:test');
const assert = require('node:assert/strict');

const { createTupleHandler, validationErrorTuple } = require('../src/main/ipc/create-handler');

test('validationErrorTuple extracts message and applies fallback', () => {
  assert.deepEqual(validationErrorTuple(new Error('bad')), ['bad', null]);
  assert.deepEqual(validationErrorTuple('plain'), ['plain', null]);
  assert.deepEqual(validationErrorTuple(null), ['Invalid request', null]);
  assert.deepEqual(validationErrorTuple(new Error('bad'), false), ['bad', false]);
});

test('createTupleHandler passes normalized args to run and returns success tuple', async () => {
  const handler = createTupleHandler(
    (a, b) => [Number(a), Number(b)],
    async (a, b) => [null, a + b]
  );
  const result = await handler({}, '2', '3');
  assert.deepEqual(result, [null, 5]);
});

test('createTupleHandler wraps a single non-array normalized value', async () => {
  const seen = [];
  const handler = createTupleHandler(
    (a) => `norm:${a}`,
    async (a) => {
      seen.push(a);
      return [null, a];
    }
  );
  const result = await handler({}, 'x');
  assert.deepEqual(result, [null, 'norm:x']);
  assert.deepEqual(seen, ['norm:x']);
});

test('createTupleHandler returns validation error tuple when validate throws', async () => {
  const handler = createTupleHandler(
    () => {
      throw new Error('nope');
    },
    async () => [null, 'unreachable']
  );
  assert.deepEqual(await handler({}, 1), ['nope', null]);
});

test('createTupleHandler honors invalidFallback option', async () => {
  const handler = createTupleHandler(
    () => {
      throw new Error('nope');
    },
    async () => [null, true],
    { invalidFallback: false }
  );
  assert.deepEqual(await handler({}, 1), ['nope', false]);
});

test('createTupleHandler normalizes manager error to [Err, null]', async () => {
  const handler = createTupleHandler(null, async () => ['boom', { partial: true }]);
  assert.deepEqual(await handler({}), ['boom', null]);
});

test('createTupleHandler passes raw args through when no validator is given', async () => {
  const handler = createTupleHandler(null, async (a, b) => [null, [a, b]]);
  assert.deepEqual(await handler({}, 'a', 'b'), [null, ['a', 'b']]);
});
