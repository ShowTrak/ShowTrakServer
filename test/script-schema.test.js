const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLATFORM_KEYS,
  SCRIPT_COLOURS,
  NormalizeScriptConfig,
} = require('../src/Modules/ScriptManager/schema');

test('NormalizeScriptConfig fills in every required key with defaults', () => {
  const { config, changed, errors } = NormalizeScriptConfig({}, 'MyScript');
  assert.equal(changed, true);
  assert.equal(config.Name, 'MyScript');
  assert.equal(config.Type, undefined);
  assert.equal(config.Description, '');
  assert.equal(typeof config.Colour, 'number');
  assert.ok(config.Colour >= 0 && config.Colour < SCRIPT_COLOURS.length);
  assert.equal(config.Style, undefined);
  assert.equal(config.LabelStyle, undefined);
  assert.equal(config.Weight, 0);
  assert.equal(config.Confirmation, false);
  assert.equal(config.Enabled, false);
  assert.deepEqual(Object.keys(config.Platforms), PLATFORM_KEYS);
  for (const key of PLATFORM_KEYS) assert.equal(config.Platforms[key], '');
  assert.ok(errors.length > 0);
});

test('NormalizeScriptConfig migrates legacy .sh to macOS/Linux only', () => {
  const { config, changed } = NormalizeScriptConfig(
    { Name: 'Deploy', Path: 'run.sh', Enabled: true },
    'Deploy'
  );
  assert.equal(changed, true);
  assert.equal(config.Path, undefined);
  assert.equal(config.Platforms.Windows, '');
  assert.equal(config.Platforms.macOS, 'run.sh');
  assert.equal(config.Platforms.Linux, 'run.sh');
  assert.equal(config.Enabled, true);
});

test('NormalizeScriptConfig migrates legacy .bat to Windows only', () => {
  const { config, changed } = NormalizeScriptConfig(
    { Name: 'Deploy', Path: 'run.bat', Enabled: true },
    'Deploy'
  );
  assert.equal(changed, true);
  assert.equal(config.Platforms.Windows, 'run.bat');
  assert.equal(config.Platforms.macOS, '');
  assert.equal(config.Platforms.Linux, '');
});

test('NormalizeScriptConfig repairs invalid values', () => {
  const { config } = NormalizeScriptConfig(
    {
      Name: '',
      Weight: '5',
      Colour: 99,
      Confirmation: 'yes',
      Platforms: { Windows: 12, macOS: 'mac.sh' },
    },
    'Fix'
  );
  assert.equal(config.Name, 'Fix');
  assert.equal(config.Weight, 5);
  // 99 is out of range — should fall back to default
  assert.equal(config.Colour, 6);
  assert.equal(config.Confirmation, false);
  assert.equal(config.Platforms.Windows, '');
  assert.equal(config.Platforms.macOS, 'mac.sh');
});

test('NormalizeScriptConfig strips leading ./ and backslashes from platform paths', () => {
  const { config, changed } = NormalizeScriptConfig(
    {
      Name: 'Deploy',
      Colour: 4,
      Platforms: { Windows: './run.bat', macOS: '.\\mac.sh', Linux: 'sub/run.sh' },
    },
    'Deploy'
  );
  assert.equal(changed, true);
  assert.equal(config.Platforms.Windows, 'run.bat');
  assert.equal(config.Platforms.macOS, 'mac.sh');
  assert.equal(config.Platforms.Linux, 'sub/run.sh');
});

test('NormalizeScriptConfig migrates a legacy ./Path with normalization', () => {
  const { config } = NormalizeScriptConfig(
    { Name: 'Deploy', Path: './run.bat', Enabled: true },
    'Deploy'
  );
  assert.equal(config.Platforms.Windows, 'run.bat');
  assert.equal(config.Platforms.macOS, '');
  assert.equal(config.Platforms.Linux, '');
});

test('NormalizeScriptConfig migrates legacy LabelStyle to Colour index', () => {
  const { config } = NormalizeScriptConfig(
    { Name: 'Deploy', LabelStyle: 'danger', Platforms: { Linux: 'run.sh' } },
    'Deploy'
  );
  assert.equal(config.Colour, 0); // danger -> red (index 0)
  assert.equal(config.Style, undefined);
  assert.equal(config.LabelStyle, undefined);
});

test('NormalizeScriptConfig migrates legacy Style string to Colour index', () => {
  const { config } = NormalizeScriptConfig(
    { Name: 'Deploy', Style: 'success', Platforms: { Linux: 'run.sh' } },
    'Deploy'
  );
  assert.equal(config.Colour, 3); // success -> green (index 3)
  assert.equal(config.Style, undefined);
});

test('NormalizeScriptConfig folds legacy Platforms.RPM into Linux', () => {
  const { config } = NormalizeScriptConfig(
    {
      Name: 'Deploy',
      Type: 'Action',
      LabelStyle: 'light',
      Weight: 0,
      Confirmation: false,
      Enabled: true,
      Platforms: { Windows: '', macOS: '', Linux: '', RPM: 'rpm.sh' },
    },
    'Deploy'
  );
  assert.equal(config.Platforms.Linux, 'rpm.sh');
  assert.equal(config.Platforms.Windows, '');
  assert.equal(config.Platforms.macOS, '');
});

test('NormalizeScriptConfig leaves an already-valid config untouched', () => {
  const valid = {
    Name: 'Deploy',
    Description: '',
    Colour: 3,
    Weight: 0,
    Confirmation: false,
    Enabled: false,
    Platforms: { Windows: 'win.bat', macOS: '', Linux: '' },
  };
  const { changed, errors } = NormalizeScriptConfig(valid, 'Deploy');
  assert.equal(changed, false);
  assert.equal(errors.length, 0);
});

test('NormalizeScriptConfig handles a non-object root', () => {
  const { config, changed } = NormalizeScriptConfig('not json object', 'X');
  assert.equal(changed, true);
  assert.equal(config.Name, 'X');
  assert.deepEqual(Object.keys(config.Platforms), PLATFORM_KEYS);
});
