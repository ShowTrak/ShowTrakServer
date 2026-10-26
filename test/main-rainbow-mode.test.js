const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Covers src/main/rainbow-mode.ts: the console's easter egg. One in-memory flag
// shared by every surface: it must start off on every boot (nothing persists
// it), and only a real change may be pushed.

function load() {
  const pushes = [];
  const Mod = loadWithMocks(path.join(__dirname, '..', 'dist', 'main', 'rainbow-mode'), {
    './renderer-bus': { PushToRenderers: (...args) => pushes.push(args) },
  });
  return { Mod, pushes };
}

test('starts off', () => {
  const { Mod, pushes } = load();
  assert.equal(Mod.GetRainbowMode(), false);
  assert.deepEqual(pushes, []);
});

test('turning it on and off pushes each change to every surface once', () => {
  const { Mod, pushes } = load();
  assert.equal(Mod.SetRainbowMode(true), true);
  assert.equal(Mod.SetRainbowMode(true), true);
  assert.equal(Mod.GetRainbowMode(), true);
  assert.equal(Mod.SetRainbowMode(false), false);
  assert.deepEqual(pushes, [
    ['RainbowModeUpdated', true],
    ['RainbowModeUpdated', false],
  ]);
});

test('only a literal true turns it on', () => {
  const { Mod, pushes } = load();
  for (const Value of ['true', 1, {}, null, undefined]) {
    assert.equal(Mod.SetRainbowMode(Value), false);
  }
  assert.deepEqual(pushes, []);
});
