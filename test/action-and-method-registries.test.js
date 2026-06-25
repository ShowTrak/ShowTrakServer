const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  return {
    warn: () => {},
    info: () => {},
    error: () => {},
    child: () => createLoggerStub(),
  };
}

test('AlertActions manager normalizes, validates, and executes actions', async () => {
  const actionA = {
    ID: 'alpha',
    Name: 'Alpha',
    Settings: [{ Key: 'Count', Type: 'number', Default: 5, Min: 1, Max: 10 }],
    Execute: async (config) => ({ Success: true, got: config.Settings.Count }),
  };
  const actionB = {
    ID: 'beta',
    Name: 'Beta',
    NormalizeSettings: (input) => ({ Hooked: !!(input && input.Hooked) }),
    ValidateSettings: (normalized) => {
      if (!normalized.Hooked) throw new Error('Hooked must be true');
    },
    Execute: async () => ({ Success: true }),
  };

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'AlertActions', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    './osc-trigger': actionA,
    './http-api': actionB,
    './discord-webhook': { Name: 'invalid-no-id' },
    './play-sound': { Name: 'invalid-no-id' },
    './play-custom-audio': { Name: 'invalid-no-id' },
    './showtrak-alert': { Name: 'invalid-no-id' },
  });

  assert.equal(Manager.Has('alpha'), true);
  assert.equal(Manager.Has('beta'), true);
  assert.equal(Manager.Has('missing'), false);

  const publicList = Manager.GetAll();
  assert.equal(publicList.length, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(publicList[0], 'Execute'));

  const normalizedAlpha = Manager.NormalizeSettings('alpha', { Count: 999 });
  assert.deepEqual(normalizedAlpha, { Count: 10 });

  const resultAlpha = await Manager.Execute({ Type: 'alpha', Settings: { Count: 2 } }, {});
  assert.deepEqual(resultAlpha, { Success: true, got: 2 });

  const resultBetaFail = await Manager.Execute({ Type: 'beta', Settings: { Hooked: false } }, {});
  assert.equal(resultBetaFail.Success, false);
  assert.match(resultBetaFail.Error, /Hooked must be true/i);

  const missing = await Manager.Execute({ Type: 'missing', Settings: {} }, {});
  assert.equal(missing.Success, false);
  assert.match(missing.Error, /Unknown alert action/i);
});

test('MonitoringMethods manager normalizes and wraps execution errors', async () => {
  const pingMethod = {
    ID: 'ping',
    Name: 'Ping',
    Description: 'desc',
    DefaultInterval: 15000,
    Settings: [{ Key: 'Timeout', Type: 'number', Default: 1000, Min: 500, Max: 5000 }],
    Run: async (target) => ({ Success: true, Address: target.Address }),
  };
  const brokenMethod = {
    ID: 'broken',
    Name: 'Broken',
    Settings: [{ Key: 'Enabled', Type: 'boolean', Default: false }],
    Run: async () => {
      throw new Error('kaboom');
    },
  };

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'MonitoringMethods', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    './ping': pingMethod,
    './tcp-port': brokenMethod,
    './http': { ID: 'http', Name: 'HTTP', Settings: [], Run: async () => ({ Success: true }) },
    './https': { ID: 'https', Name: 'HTTPS', Settings: [], Run: async () => ({ Success: true }) },
    './http-json': { Name: 'invalid-no-id' },
    './dns': { ID: 'dns', Name: 'DNS', Settings: [], Run: async () => ({ Success: true }) },
  });

  assert.equal(Manager.Has('ping'), true);
  assert.equal(Manager.Get('missing'), null);

  const normalized = Manager.NormalizeSettings('ping', { Timeout: 99999 });
  assert.deepEqual(normalized, { Timeout: 5000 });

  const fallbackNormalized = Manager.NormalizeSettings('missing', { x: 1 });
  assert.deepEqual(fallbackNormalized, {});

  const okResult = await Manager.Run('ping', { Address: '127.0.0.1' });
  assert.equal(okResult.Success, true);

  const failResult = await Manager.Run('broken', {});
  assert.equal(failResult.Success, false);
  assert.match(failResult.Error, /kaboom/i);

  const missingResult = await Manager.Run('missing', {});
  assert.equal(missingResult.Success, false);
  assert.match(missingResult.Error, /Unknown monitoring method/i);
});
