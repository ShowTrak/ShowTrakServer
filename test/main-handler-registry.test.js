const test = require('node:test');
const assert = require('node:assert/strict');

// handler-registry is dependency-free (no Electron, no managers), so it loads
// directly. It backs the desktop<->WebUI unification: every RPC.handle call
// records its handler here so the /ui namespace can dispatch to the same fn.
const { RegisterHandler, GetHandler, HasHandler } = require('../dist/main/handler-registry');

test('GetHandler/HasHandler report an unregistered channel as absent', () => {
  const channel = 'HandlerRegistryTest:Absent';
  assert.equal(HasHandler(channel), false);
  assert.equal(GetHandler(channel), undefined);
});

test('RegisterHandler stores the exact function for later lookup', () => {
  const channel = 'HandlerRegistryTest:Basic';
  const fn = async () => [null, 'ok'];
  RegisterHandler(channel, fn);
  assert.equal(HasHandler(channel), true);
  assert.equal(GetHandler(channel), fn);
});

test('RegisterHandler overwrites a prior handler for the same channel', () => {
  const channel = 'HandlerRegistryTest:Overwrite';
  const first = async () => [null, 1];
  const second = async () => [null, 2];
  RegisterHandler(channel, first);
  RegisterHandler(channel, second);
  assert.equal(GetHandler(channel), second);
});
