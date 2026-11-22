const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Covers src/Modules/Utils/guards.ts, the type guards the main process uses to
// narrow values of unknown type (parsed JSON, socket and IPC payloads) instead
// of letting them through as `any`. Their runtime answers must match the checks
// they replaced exactly: Array.isArray, and `value && typeof value === 'object'`.
const { IsArray, IsObject } = require('../dist/Modules/Utils/guards');

test('IsArray answers exactly as Array.isArray', () => {
  const values = [
    [],
    [1, 'two', null],
    new Array(3),
    vm.runInNewContext('[]'), // an array from another realm is still an array
    {},
    { length: 0 },
    'abc',
    '',
    0,
    null,
    undefined,
    new Set([1]),
    new Uint8Array(2),
    Object.create(Array.prototype),
  ];
  for (const value of values) {
    assert.equal(IsArray(value), Array.isArray(value), String(value));
  }
});

test('IsObject accepts every object, arrays included, and nothing else', () => {
  for (const value of [{}, [], new Map(), new Date(0), Object.create(null), new String('x')]) {
    assert.equal(IsObject(value), true);
  }
  for (const value of [
    null,
    undefined,
    0,
    1,
    '',
    'text',
    true,
    false,
    Symbol('s'),
    10n,
    () => {},
  ]) {
    assert.equal(IsObject(value), false, String(value));
  }
});

test('IsObject matches the `value && typeof value === "object"` checks it replaced', () => {
  const values = [{}, [], null, undefined, 0, 7, '', 'x', true, false, () => {}, new Error('e')];
  for (const value of values) {
    assert.equal(IsObject(value), Boolean(value && typeof value === 'object'), String(value));
  }
});
