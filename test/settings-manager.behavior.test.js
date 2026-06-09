const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

test('SettingsManager coerces values, persists updates, and emits events', async () => {
  const runCalls = [];
  const events = [];

  const defaultSettings = [
    {
      Group: 'Test',
      Key: 'BOOL_SETTING',
      Title: 'Bool',
      Description: 'Bool setting',
      Type: 'BOOLEAN',
      DefaultValue: true,
      OnUpdateEvent: 'BoolSettingChanged',
    },
    {
      Group: 'Test',
      Key: 'INT_SETTING',
      Title: 'Int',
      Description: 'Int setting',
      Type: 'INTEGER',
      DefaultValue: 7,
    },
    {
      Group: 'Test',
      Key: 'STRING_SETTING',
      Title: 'String',
      Description: 'String setting',
      Type: 'STRING',
      DefaultValue: 'abc',
    },
    {
      Group: 'Web UI',
      Key: 'WEBUI_PASSWORD',
      Title: 'Password (4 Digit Numeric)',
      Description: 'Web UI passcode',
      Type: 'STRING',
      DefaultValue: '',
    },
    {
      Group: 'Test',
      Key: 'OPTION_SETTING',
      Title: 'Option',
      Description: 'Option setting',
      Type: 'OPTION',
      DefaultValue: 'Medium',
      Options: ['Low', 'Medium', 'High'],
    },
  ];

  const persistedValues = new Map([
    ['BOOL_SETTING', { Value: '0' }],
    ['INT_SETTING', { Value: '42' }],
    ['STRING_SETTING', { Value: 1001 }],
    ['WEBUI_PASSWORD', { Value: '12ab34' }],
    ['OPTION_SETTING', { Value: 'InvalidValue' }],
  ]);

  const dbMock = {
    Manager: {
      Ready: async () => {},
      Get: async (_sql, params) => [null, persistedValues.get(params[0]) || null],
      Run: async (sql, params) => {
        runCalls.push([sql, params]);
        return [null, { changes: 1 }];
      },
    },
  };

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'SettingsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ log: () => {}, error: () => {} }) },
    '../Broadcast': { Manager: { emit: (event) => events.push(event) } },
    '../DB': dbMock,
    './DefaultSettings': {
      DefaultSettings: defaultSettings,
      Groups: [{ Name: 'Test', Title: 'Test' }],
    },
  });

  const all = await Manager.GetAll();
  assert.equal(all.length, 5);

  assert.equal(await Manager.GetValue('BOOL_SETTING'), false);
  assert.equal(await Manager.GetValue('INT_SETTING'), 42);
  assert.equal(await Manager.GetValue('STRING_SETTING'), '1001');
  assert.equal(await Manager.GetValue('WEBUI_PASSWORD'), '1234');
  assert.equal(await Manager.GetValue('OPTION_SETTING'), 'Medium');
  assert.equal(await Manager.GetValue('UNKNOWN_SETTING'), null);

  const [invalidErr, invalidSetting] = await Manager.Set('UNKNOWN_SETTING', true);
  assert.match(invalidErr, /Invalid Setting Key/i);
  assert.equal(invalidSetting, null);

  const beforeRuns = runCalls.length;
  const [sameErr, sameSetting] = await Manager.Set('INT_SETTING', '42');
  assert.equal(sameErr, null);
  assert.equal(sameSetting.Value, 42);
  assert.equal(runCalls.length, beforeRuns);

  const [setBoolErr, boolSetting] = await Manager.Set('BOOL_SETTING', 'true');
  assert.equal(setBoolErr, null);
  assert.equal(boolSetting.Value, true);

  const [setOptionErr, optionSetting] = await Manager.Set('OPTION_SETTING', 'NotInList');
  assert.equal(setOptionErr, null);
  assert.equal(optionSetting.Value, 'Medium');

  const [setPasswordErr, passwordSetting] = await Manager.Set('WEBUI_PASSWORD', '9x8y7z6');
  assert.equal(setPasswordErr, null);
  assert.equal(passwordSetting.Value, '9876');

  const [clearPasswordErr, clearedPasswordSetting] = await Manager.Set('WEBUI_PASSWORD', '');
  assert.equal(clearPasswordErr, null);
  assert.equal(clearedPasswordSetting.Value, '');

  const groups = await Manager.GetGroups();
  assert.deepEqual(groups, [{ Name: 'Test', Title: 'Test' }]);

  assert.ok(runCalls.length >= 1);
  assert.ok(events.includes('SettingsUpdated'));
  assert.ok(events.includes('BoolSettingChanged'));
});
