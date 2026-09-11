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

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'AlertActions', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    './osc-trigger': actionA,
    './http-api': actionB,
    './discord-webhook': { Name: 'invalid-no-id' },
    './play-sound': { Name: 'invalid-no-id' },
    './play-custom-audio': { Name: 'invalid-no-id' },
    './showtrak-alert': { Name: 'invalid-no-id' },
    './slack-webhook': { Name: 'invalid-no-id' },
    './teams-webhook': { Name: 'invalid-no-id' },
    './telegram-bot': { Name: 'invalid-no-id' },
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

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'index.js');
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

  // A removed/unknown method surfaces as Degraded (not Offline) so a stale saved
  // check alerts the operator instead of reading as an outage.
  const missingResult = await Manager.Run('missing', {});
  assert.equal(missingResult.Success, true);
  assert.equal(missingResult.Degraded, true);
  assert.match(missingResult.DegradedReason, /Unknown method/i);
});

test('MonitoringMethods manager exposes, normalizes and dispatches check actions', async () => {
  const calls = [];
  const invalidated = [];
  const actionMethod = {
    ID: 'ping',
    Name: 'Projector',
    Settings: [],
    Actions: [
      { ID: 'power.on', Label: 'Power On', Icon: 'power', Group: 'Power' },
      {
        ID: 'input.set',
        Label: 'Set Input',
        Icon: 'box-arrow-in-right',
        Group: 'Input',
        Params: [{ Key: 'Input', Label: 'Input', Type: 'string', Default: '' }],
      },
      {
        ID: 'level.set',
        Label: 'Set Level',
        Icon: 'sliders',
        Group: 'Display',
        Params: [{ Key: 'Level', Label: 'Level', Type: 'number', Default: 50, Min: 0, Max: 100 }],
      },
    ],
    Run: async () => ({ Success: true, Inputs: ['11', '31'] }),
    RunAction: async (target, actionID, params) => {
      calls.push({ actionID, params, address: target.Address });
      if (actionID === 'power.on') return { Success: true, Detail: 'Power on sent' };
      return { Success: false, Error: 'refused' };
    },
    GetActionOptions: (result) => ({
      Input: (result.Inputs || []).map((code) => ({ value: code, label: code })),
    }),
    DescribeAction: (actionID, params) =>
      actionID === 'input.set' ? `Set Input - ${params.Input}` : null,
    InvalidateCaches: (target) => invalidated.push(target.Address),
  };
  // A method with no action surface at all: the registry must report an empty
  // list rather than undefined, and refuse to dispatch to it.
  const readOnlyMethod = {
    ID: 'dns',
    Name: 'DNS',
    Settings: [],
    Run: async () => ({ Success: true }),
  };
  // Declaring actions obliges a method to implement RunAction. One that forgets
  // is a coding error, and the registry has to say so rather than throw.
  const halfBuiltMethod = {
    ID: 'http',
    Name: 'Half Built',
    Settings: [],
    Actions: [{ ID: 'power.on', Label: 'Power On', Icon: 'power', Group: 'Power' }],
    Run: async () => ({ Success: true }),
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    './ping': actionMethod,
    './dns': readOnlyMethod,
    './http': halfBuiltMethod,
    './tcp-port': { Name: 'invalid-no-id' },
    './https': { Name: 'invalid-no-id' },
    './http-json': { Name: 'invalid-no-id' },
  });

  // The catalogue carries the actions, so the renderer draws its control panel
  // from the same payload it already loads for the editor.
  const published = Manager.GetAll().find((entry) => entry.ID === 'ping');
  assert.equal(published.Actions.length, 3);
  assert.deepEqual(Manager.GetAll().find((entry) => entry.ID === 'dns').Actions, []);

  assert.equal(Manager.GetAction('ping', 'power.on').Label, 'Power On');
  assert.equal(Manager.GetAction('ping', 'nope'), null);
  assert.equal(Manager.GetAction('dns', 'power.on'), null);

  // Parameters normalize against the ACTION's schema: unknown keys are dropped
  // rather than handed to the method, and numbers clamp to their declared range.
  assert.deepEqual(Manager.NormalizeActionParams('ping', 'input.set', { Input: '31', Evil: 'x' }), {
    Input: '31',
  });
  assert.deepEqual(Manager.NormalizeActionParams('ping', 'level.set', { Level: 900 }), {
    Level: 100,
  });
  assert.deepEqual(Manager.NormalizeActionParams('ping', 'power.on', { Input: '31' }), {});
  assert.deepEqual(Manager.NormalizeActionParams('ping', 'nope', {}), {});

  const target = { Address: '10.0.0.5', Settings: {} };
  const ran = await Manager.RunAction('ping', target, 'power.on', { Evil: 'x' });
  assert.equal(ran.Success, true);
  assert.deepEqual(calls, [{ actionID: 'power.on', params: {}, address: '10.0.0.5' }]);
  // A successful action means the device changed, so its cached reading is now
  // a lie and the method is told to drop it.
  assert.deepEqual(invalidated, ['10.0.0.5']);

  // A refusal is reported, and nothing is invalidated on the way out.
  const refused = await Manager.RunAction('ping', target, 'input.set', { Input: '31' });
  assert.equal(refused.Success, false);
  assert.equal(refused.Error, 'refused');
  assert.deepEqual(invalidated, ['10.0.0.5']);

  // Unknown method / unknown action / method that cannot act at all.
  assert.match(
    (await Manager.RunAction('missing', target, 'power.on', {})).Error,
    /Unknown method/
  );
  assert.match((await Manager.RunAction('ping', target, 'nope', {})).Error, /no action "nope"/);
  assert.match((await Manager.RunAction('dns', target, 'power.on', {})).Error, /no action/);
  assert.match(
    (await Manager.RunAction('http', target, 'power.on', {})).Error,
    /cannot perform actions/
  );

  // Dynamic parameter choices come from the probe result, so Set Input offers
  // the inputs this device reported rather than a fixed list.
  assert.deepEqual(Manager.GetActionOptions('ping', { Inputs: ['11', '31'] }).Input, [
    { value: '11', label: '11' },
    { value: '31', label: '31' },
  ]);
  assert.deepEqual(Manager.GetActionOptions('dns', {}), {});

  // Favourite labels bind the parameters; a method describing nothing falls
  // back to the plain action label, then to the raw id.
  assert.equal(Manager.DescribeAction('ping', 'input.set', { Input: '31' }), 'Set Input - 31');
  assert.equal(Manager.DescribeAction('ping', 'power.on', {}), 'Power On');
  assert.equal(Manager.DescribeAction('ping', 'nope', {}), 'nope');
});

test('a throwing action implementation is reported, never propagated', async () => {
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    './ping': {
      ID: 'ping',
      Name: 'Ping',
      Settings: [],
      Actions: [{ ID: 'boom', Label: 'Boom', Icon: 'x', Group: 'Power' }],
      Run: async () => ({ Success: true }),
      RunAction: async () => {
        throw new Error('socket exploded');
      },
      // A method whose optional hooks throw must not take the caller down with
      // them: the operator still needs the panel and the verdict.
      GetActionOptions: () => {
        throw new Error('bad options');
      },
      DescribeAction: () => {
        throw new Error('bad label');
      },
      InvalidateCaches: () => {
        throw new Error('bad invalidate');
      },
    },
    './tcp-port': { Name: 'invalid-no-id' },
    './http': { Name: 'invalid-no-id' },
    './https': { Name: 'invalid-no-id' },
    './http-json': { Name: 'invalid-no-id' },
    './dns': { Name: 'invalid-no-id' },
  });

  const result = await Manager.RunAction('ping', { Address: 'x', Settings: {} }, 'boom', {});
  assert.equal(result.Success, false);
  assert.match(result.Error, /socket exploded/);
  assert.deepEqual(Manager.GetActionOptions('ping', {}), {});
  assert.equal(Manager.DescribeAction('ping', 'boom', {}), 'Boom');
  assert.doesNotThrow(() => Manager.InvalidateRun('ping', { Address: 'x', Settings: {} }));
});
