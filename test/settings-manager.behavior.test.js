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

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'SettingsManager', 'index.js');
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

test('SettingsManager clamps INTEGER settings to Min/Max on read and write', async () => {
  const defaultSettings = [
    {
      Group: 'Layout',
      Key: 'COLUMN_COUNT',
      Title: 'Columns',
      Description: 'Column count',
      Type: 'INTEGER',
      DefaultValue: 2,
      Min: 2,
      Max: 6,
    },
  ];

  const persistedValues = new Map([['COLUMN_COUNT', { Value: '99' }]]);

  const dbMock = {
    Manager: {
      Ready: async () => {},
      Get: async (_sql, params) => [null, persistedValues.get(params[0]) || null],
      Run: async () => [null, { changes: 1 }],
    },
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'SettingsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ log: () => {}, error: () => {} }) },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../DB': dbMock,
    './DefaultSettings': {
      DefaultSettings: defaultSettings,
      Groups: [{ Name: 'Layout', Title: 'Layout' }],
    },
  });

  // Persisted out-of-range value is clamped to Max on read.
  assert.equal(await Manager.GetValue('COLUMN_COUNT'), 6);

  // Min/Max are surfaced to the UI.
  const [setting] = await Manager.GetAll();
  assert.equal(setting.Min, 2);
  assert.equal(setting.Max, 6);

  // Below-range writes clamp up to Min.
  const [belowErr, belowSetting] = await Manager.Set('COLUMN_COUNT', 0);
  assert.equal(belowErr, null);
  assert.equal(belowSetting.Value, 2);

  // Above-range writes clamp down to Max.
  const [aboveErr, aboveSetting] = await Manager.Set('COLUMN_COUNT', 42);
  assert.equal(aboveErr, null);
  assert.equal(aboveSetting.Value, 6);

  // In-range writes pass through untouched.
  const [inErr, inSetting] = await Manager.Set('COLUMN_COUNT', 4);
  assert.equal(inErr, null);
  assert.equal(inSetting.Value, 4);
});

test('SettingsManager keeps install-scoped settings out of the show database', async () => {
  // An install-scoped value must survive opening a different show file, so it
  // is read from and written to the install store and never touches the DB.
  const defaultSettings = [
    {
      Group: 'System',
      Key: 'SHOW_SETTING',
      Title: 'Show',
      Description: 'Per show file',
      Type: 'BOOLEAN',
      DefaultValue: false,
    },
    {
      Group: 'System',
      Key: 'INSTALL_SETTING',
      Title: 'Install',
      Description: 'Per install',
      Type: 'BOOLEAN',
      DefaultValue: false,
      Scope: 'INSTALL',
    },
  ];

  const dbReads = [];
  const dbWrites = [];
  const dbMock = {
    Manager: {
      Ready: async () => {},
      Get: async (_sql, params) => {
        dbReads.push(params[0]);
        return [null, null];
      },
      Run: async (_sql, params) => {
        dbWrites.push(params[0]);
        return [null, { changes: 1 }];
      },
    },
  };

  const installValues = new Map([['INSTALL_SETTING', '1']]);
  const installWrites = [];
  const installStore = {
    GetByKey: async (Key) =>
      installValues.has(Key) ? [null, { Key, Value: installValues.get(Key) }] : [null, null],
    Upsert: async (Key, Value) => {
      installWrites.push([Key, Value]);
      installValues.set(Key, Value);
      return [null, true];
    },
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'SettingsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ log: () => {}, error: () => {} }) },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../DB': dbMock,
    './install-settings': { CreateInstallSettingsStore: () => installStore },
    './DefaultSettings': {
      DefaultSettings: defaultSettings,
      Groups: [{ Name: 'System', Title: 'System' }],
    },
  });

  assert.equal(await Manager.GetValue('INSTALL_SETTING'), true);
  assert.deepEqual(dbReads, ['SHOW_SETTING']);

  await Manager.Set('INSTALL_SETTING', false);
  await Manager.Set('SHOW_SETTING', true);
  assert.deepEqual(installWrites, [['INSTALL_SETTING', false]]);
  assert.deepEqual(dbWrites, ['SHOW_SETTING']);

  // Reloading after a show swap re-reads the install value from the install store.
  await Manager.Reload();
  assert.equal(await Manager.GetValue('INSTALL_SETTING'), false);
});

test('an install-scoped setting adopts the open show value once, then ignores show files', async () => {
  // These settings used to be stored per show file. The first load copies the
  // open show's value (or the default) into the install store so nobody's
  // existing choice resets; after that, swapping shows must not re-seed it.
  const defaultSettings = [
    {
      Group: 'System',
      Key: 'MIGRATED',
      Title: 'Migrated',
      Description: 'Had a value in the show file',
      Type: 'BOOLEAN',
      DefaultValue: true,
      Scope: 'INSTALL',
    },
    {
      Group: 'System',
      Key: 'NEVER_SET',
      Title: 'Never set',
      Description: 'Had no value in the show file',
      Type: 'INTEGER',
      DefaultValue: 5,
      Scope: 'INSTALL',
    },
  ];

  let showValues = new Map([['MIGRATED', { Value: '0' }]]);
  const dbMock = {
    Manager: {
      Ready: async () => {},
      Get: async (_sql, params) => [null, showValues.get(params[0]) || null],
      Run: async () => [null, { changes: 1 }],
    },
  };

  const installValues = new Map();
  const installStore = {
    GetByKey: async (Key) =>
      installValues.has(Key) ? [null, { Key, Value: installValues.get(Key) }] : [null, null],
    Upsert: async (Key, Value) => {
      installValues.set(Key, Value);
      return [null, true];
    },
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'SettingsManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ log: () => {}, error: () => {} }) },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../DB': dbMock,
    './install-settings': { CreateInstallSettingsStore: () => installStore },
    './DefaultSettings': {
      DefaultSettings: defaultSettings,
      Groups: [{ Name: 'System', Title: 'System' }],
    },
  });

  assert.equal(await Manager.GetValue('MIGRATED'), false);
  assert.equal(await Manager.GetValue('NEVER_SET'), 5);
  assert.deepEqual(
    [...installValues],
    [
      ['MIGRATED', '0'],
      ['NEVER_SET', 5],
    ]
  );

  // Open a different show whose file says otherwise: the install value holds.
  showValues = new Map([
    ['MIGRATED', { Value: '1' }],
    ['NEVER_SET', { Value: '9' }],
  ]);
  await Manager.Reload();
  assert.equal(await Manager.GetValue('MIGRATED'), false);
  assert.equal(await Manager.GetValue('NEVER_SET'), 5);
});
