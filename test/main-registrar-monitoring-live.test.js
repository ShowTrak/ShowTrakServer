const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// The live control channel: exactly one of a fader level or a mute, numbers
// that are numbers, and Final passed through for the audit log.

function load() {
  const handlers = {};
  const calls = [];
  const { register } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'main', 'registrars', 'monitoring-live.js'),
    {
      '../rpc': { RPC: { handle: (channel, fn) => (handlers[channel] = fn) } },
      '../monitoring-live': {
        OpenMonitorLiveLevels: () => null,
        CloseMonitorLiveLevels: () => undefined,
        OpenMonitorTileLevels: () => null,
        CloseMonitorTileLevels: () => undefined,
      },
      '../../Modules/MonitoringTargetManager': {
        Manager: {
          SetLiveLevel: async (...args) => {
            calls.push(args);
            return { Success: true, Detail: 'ok' };
          },
        },
      },
    }
  );
  register();
  return { set: handlers['MonitorLiveLevels:Set'], calls };
}

test('a fader level, −∞ or a mute is passed on with Final', async () => {
  const { set, calls } = load();
  assert.deepEqual(await set(null, 1, 2, 'in:3', { Fader: -6 }, true), {
    Success: true,
    Detail: 'ok',
  });
  await set(null, '1', '2', 'in:3', { Fader: null }, 'yes');
  await set(null, 1, 2, 'out:1', { Muted: true });
  assert.deepEqual(calls, [
    [1, 2, 'in:3', { Fader: -6 }, true],
    [1, 2, 'in:3', { Fader: null }, false],
    [1, 2, 'out:1', { Muted: true }, false],
  ]);
});

test('anything else is refused before reaching the device', async () => {
  const { set, calls } = load();
  for (const args of [
    [1, 2, 'in:3', { Fader: -6, Muted: true }],
    [1, 2, 'in:3', {}],
    [1, 2, 'in:3', { Fader: '-6' }],
    [1, 2, 'in:3', { Fader: Infinity }],
    [1, 2, 'in:3', { Muted: 'on' }],
    [1, 2, 'in:3', null],
    [1, 2, 3, { Muted: true }],
    [1, 2, 'x'.repeat(65), { Muted: true }],
    ['a', 2, 'in:3', { Muted: true }],
    [1, 2.5, 'in:3', { Muted: true }],
  ]) {
    assert.deepEqual(await set(null, ...args), {
      Success: false,
      Error: 'Invalid live control request',
    });
  }
  assert.equal(calls.length, 0);
});
