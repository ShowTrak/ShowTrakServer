const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/guards.ts, the renderer's copy of the main process's
// type guards (src/Modules/Utils/guards.ts, covered by test/guards.test.js) plus
// ArrayOrEmpty. Loaded from dist-test/ like the other renderer modules.
const { IsArray, IsObject, ArrayOrEmpty } = require('../dist-test/UI/js/app/lib/guards.js');
const MainGuards = require('../dist/Modules/Utils/guards');

const SAMPLES = [
  [],
  [1, 2],
  {},
  { length: 1 },
  null,
  undefined,
  0,
  1,
  '',
  'text',
  true,
  false,
  () => {},
  new Map(),
  new Uint8Array(1),
];

test('the renderer guards answer exactly as the main-process ones', () => {
  for (const value of SAMPLES) {
    assert.equal(IsArray(value), MainGuards.IsArray(value));
    assert.equal(IsObject(value), MainGuards.IsObject(value));
  }
});

test('IsArray is Array.isArray; IsObject is any non-null object', () => {
  for (const value of SAMPLES) {
    assert.equal(IsArray(value), Array.isArray(value));
    assert.equal(IsObject(value), typeof value === 'object' && value !== null);
  }
});

test('ArrayOrEmpty hands back the very array it was given', () => {
  const list = [{ ts: 1 }, { ts: 2 }];
  assert.equal(ArrayOrEmpty(list), list);
  const frozen = Object.freeze(['a']);
  assert.equal(ArrayOrEmpty(frozen), frozen);
});

test('ArrayOrEmpty turns anything that is not an array into an empty one', () => {
  for (const value of [null, undefined, {}, { length: 2, 0: 'a', 1: 'b' }, 'ab', 0, new Set([1])]) {
    const out = ArrayOrEmpty(value);
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 0);
  }
});
