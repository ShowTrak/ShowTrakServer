const test = require('node:test');
const assert = require('node:assert/strict');

const Utils = require('../src/Modules/Utils');
const { Config } = require('../src/Modules/Config');
const { Manager: UUID } = require('../src/Modules/UUID');
const { Manager: ModeManager } = require('../src/Modules/ModeManager');

test('Utils.Ok and Utils.Fail return stable tuple shapes', () => {
  assert.deepEqual(Utils.Ok('value'), [null, 'value']);
  assert.deepEqual(Utils.Fail('boom'), ['boom', null]);
  assert.deepEqual(Utils.Fail(null, 123), ['Unknown Error', 123]);
});

test('Utils.Wait resolves after at least the requested delay', async () => {
  const started = Date.now();
  await Utils.Wait(10);
  assert.ok(Date.now() - started >= 8);
});

test('Config exposes app metadata and shared version', () => {
  assert.equal(typeof Config.Application.Name, 'string');
  assert.equal(typeof Config.Application.Port, 'number');
  assert.equal(Config.Shared.Version, Config.Application.Version);
});

test('UUID.Generate returns a non-empty UUID string', () => {
  const generated = UUID.Generate();
  assert.equal(typeof generated, 'string');
  assert.match(generated, /^[0-9a-f-]{36}$/i);
});

test('ModeManager defaults to SHOW and emits updates only on changes', () => {
  const observed = [];
  ModeManager.on('ModeUpdated', (nextMode) => observed.push(nextMode));

  assert.equal(ModeManager.Get(), 'SHOW');
  assert.equal(ModeManager.Set('SHOW'), 'SHOW');
  assert.equal(ModeManager.Set('EDIT'), 'EDIT');
  assert.equal(ModeManager.Set('unknown-value'), 'SHOW');

  assert.deepEqual(observed, ['EDIT', 'SHOW']);
});
