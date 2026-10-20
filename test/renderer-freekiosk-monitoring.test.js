// Exercises src/UI/js/app/lib/freekiosk-monitoring.ts — the section cards a
// FreeKiosk terminal's monitoring is set on (a Monitor toggle per section, then
// a conditions table of its readings).
//
// Driven by the server's REAL registry and alarm schema rather than a fixture,
// because the thing that can go wrong is drift: a row that saves a key the
// manager drops, or a value of the wrong type, would render and tick perfectly
// and then never fire. The round-trip tests run what a row saves through the
// server's own alarm engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Lib = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', 'freekiosk-monitoring.js')
);
const Metrics = require(path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'metrics.js'));
const { EvaluateAllAlarms } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'alarms.js')
);

// The catalogue as the FreeKiosk:GetMetrics handler builds it.
const Catalogue = {
  Metrics: Metrics.FREEKIOSK_METRICS.map((Metric) => ({ ...Metric })),
  AlarmFields: Metrics.BuildFreeKioskAlarmFields(),
  Sections: Metrics.FREEKIOSK_SECTIONS.slice(),
  Groups: Metrics.FREEKIOSK_METRIC_GROUPS.map((Group) => ({ ...Group })),
};
const AlarmKeys = new Set(Catalogue.AlarmFields.map((Field) => Field.Key));
const metric = (Key) => Catalogue.Metrics.find((Metric) => Metric.Key === Key);

const terminal = (overrides = {}) => ({
  Settings: Metrics.BuildDefaultAlarmSettings(),
  Metrics: {},
  Alarms: [],
  Online: true,
  ...overrides,
});

test('group and display-mode rules agree with the server', () => {
  const Cases = [
    undefined,
    {},
    { G_Battery_On: false },
    { G_Battery_On: 'false' },
    { G_Battery_On: '0' },
    { G_Battery_On: true },
    { G_Battery_On: '' },
    { G_Poll_On: false },
    { DisplayMode: 'external_app' },
    { DisplayMode: 'nonsense' },
  ];
  for (const Settings of Cases) {
    for (const Section of Catalogue.Sections) {
      assert.equal(
        Lib.IsGroupEnabled(Catalogue.Groups, Settings, Section),
        Metrics.IsMetricGroupEnabled(Settings, Section),
        `${Section} ${JSON.stringify(Settings)}`
      );
    }
    assert.equal(Lib.DisplayModeOf(Settings), Metrics.GetDisplayMode(Settings));
  }
});

test('a section that is not monitored still shows every current value, unjudged', () => {
  const Card = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({
      Settings: { G_Battery_On: false, A_battery_level_On: true },
      Metrics: { battery_level: 12 },
      Alarms: [{ Key: 'battery_level' }],
    }),
    'Battery'
  );
  assert.equal(Card.Monitored, false);
  assert.equal(Card.Badge.Label, 'Monitor');
  assert.equal(Card.Badge.State, 'plain');
  assert.equal(Card.Summary, 'Not monitored');
  const BatteryMetrics = Catalogue.Metrics.filter((Metric) => Metric.Section === 'Battery');
  assert.equal(Card.Rows.length, BatteryMetrics.length);
  const Level = Card.Rows.find((Row) => Row.Key === 'battery_level');
  assert.equal(Level.ValueText, '12%');
  // The stored tick is not shown as armed while the section is off.
  assert.equal(Level.Checked, false);
  assert.equal(Level.Breaching, false);
});

test('a monitored section lists every reading, ticked where an alarm is armed', () => {
  const Settings = { G_Battery_On: true, A_battery_level_On: true, A_battery_level_V: 15 };
  const Card = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({ Settings, Metrics: { battery_level: 54 } }),
    'Battery'
  );
  const BatteryMetrics = Catalogue.Metrics.filter((Metric) => Metric.Section === 'Battery');
  assert.equal(Card.Rows.length, BatteryMetrics.length);
  assert.equal(Card.Badge.State, 'healthy');

  const Level = Card.Rows.find((Row) => Row.Key === 'battery_level');
  assert.equal(Level.Checked, true);
  assert.equal(Level.ValueText, '54%');
  assert.equal(Level.Input.Kind, 'number');
  assert.equal(Level.Input.Value, '15');
  assert.equal(Level.Unit, '%');
  // Battery level only ever has one sensible expectation.
  assert.equal(Level.Operators.length, 0);
  assert.equal(Level.OperatorText, 'Expected at least');
  const Plugged = Card.Rows.find((Row) => Row.Key === 'battery_plugged');
  assert.equal(Plugged.OperatorText, 'Expected', 'a picker is still prefixed');
  assert.deepEqual(
    Plugged.Operators.map((Option) => Option.Label),
    ['Is', 'Is not']
  );
  assert.equal(Plugged.Operator, 'isNot');
  assert.equal(Plugged.Input.Value, 'ac');

  // Shown but not alertable: no tick.
  const Technology = Card.Rows.find((Row) => Row.Key === 'battery_technology');
  assert.equal(Technology.Alarmable, false);
  assert.equal(Technology.Checked, false);
  assert.equal(
    Card.Summary,
    `1 of ${Card.Rows.filter((Row) => Row.Alarmable).length} conditions monitored`
  );
});

test('a lone "is not" reads as the expected state; edge operators hide the value', () => {
  const Card = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({ Settings: { G_Device_On: true, A_device_uptime_Op: 'decreases' } }),
    'Device'
  );
  const Kiosk = Card.Rows.find((Row) => Row.Key === 'device_kioskMode');
  assert.equal(Kiosk.Operators.length, 0);
  assert.equal(Kiosk.OperatorText, 'Expected');
  assert.equal(Kiosk.Input.Kind, 'select');
  assert.deepEqual(
    Kiosk.Input.Options.map((Option) => Option.Value),
    ['true', 'false']
  );

  // Uptime is typed in days, whatever the reading is reported in.
  const Uptime = Card.Rows.find((Row) => Row.Key === 'device_uptime');
  assert.equal(Uptime.Operator, 'above');
  assert.equal(Uptime.OperatorText, 'Expected at most');
  assert.equal(Uptime.Unit, 'days');
  assert.equal(Uptime.Input.Value, '7');

  const Version = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({ Settings: { G_Device_On: true, A_device_version_Op: 'changes' } }),
    'Device'
  ).Rows.find((Row) => Row.Key === 'device_version');
  assert.equal(Version.ShowInput, false, 'an edge operator hides the value');
});

test('range operators reveal the upper bound', () => {
  const Card = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({ Settings: { A_screen_brightness_Op: 'outside', A_screen_brightness_V2: 90 } }),
    'Screen'
  );
  const Brightness = Card.Rows.find((Row) => Row.Key === 'screen_brightness');
  assert.equal(Brightness.ShowInput2, true);
  assert.equal(Brightness.Input2.Value, '90');
});

test('a breaching reading marks its row and turns the toggle to Alarm, but only while online', () => {
  const Settings = { A_battery_level_On: true };
  const Online = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({ Settings, Alarms: [{ Key: 'battery_level' }] }),
    'Battery'
  );
  assert.equal(Online.Badge.State, 'issue');
  assert.equal(Online.Rows.find((Row) => Row.Key === 'battery_level').Breaching, true);

  const Offline = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({ Settings, Alarms: [{ Key: 'battery_level' }], Online: false }),
    'Battery'
  );
  assert.equal(Offline.Badge.State, 'healthy');
});

test('the WebView readings drop out in another display mode, and say so', () => {
  const Card = Lib.BuildFreeKioskMonitorCard(
    Catalogue,
    terminal({ Settings: { DisplayMode: 'external_app' } }),
    'Content'
  );
  assert.ok(Card.HiddenByMode > 0);
  assert.ok(!Card.Rows.some((Row) => Row.Key === 'webview_currentUrl'));
  assert.ok(Card.Rows.some((Row) => Row.Key === 'content_displaying'));
});

test('ShowTrak Poll is always monitored and offers no switch', () => {
  const Card = Lib.BuildFreeKioskMonitorCard(Catalogue, terminal(), 'Poll');
  assert.equal(Card.Fixed, true);
  assert.equal(Card.Monitored, true);
  assert.equal(Card.Badge.State, 'locked');
  assert.deepEqual(Lib.BuildGroupSettings(Catalogue, 'Poll', false), {});
  assert.deepEqual(Lib.BuildGroupSettings(Catalogue, 'Battery', false), { G_Battery_On: false });
});

test('every alertable row saves only keys the server keeps, typed as the old form wrote them', () => {
  for (const Metric of Catalogue.Metrics) {
    if (!Metric.Operators.length) continue;
    const Row = Lib.BuildConditionRow(Catalogue, terminal(), Metric);
    const Saved = Lib.BuildRowSettings(Catalogue, Metric, {
      On: true,
      Op: Row.Operator,
      V: Row.Input ? Row.Input.Value : undefined,
      V2: Row.Input2 ? Row.Input2.Value : undefined,
    });
    for (const Key of Object.keys(Saved)) assert.ok(AlarmKeys.has(Key), `${Metric.Key}: ${Key}`);
    assert.equal(Saved[`A_${Metric.Key}_On`], true);
    const V = Saved[`A_${Metric.Key}_V`];
    if (Metric.Type === 'number' && V !== undefined) assert.equal(typeof V, 'number', Metric.Key);
    if (Metric.Type === 'boolean') assert.equal(typeof V, 'string', Metric.Key);
  }
});

test('a blank or out-of-range threshold falls back to the default or the bound', () => {
  const Level = metric('battery_level');
  const Blank = Lib.BuildRowSettings(Catalogue, Level, { On: true, Op: 'below', V: '' });
  const Field = Catalogue.AlarmFields.find((Entry) => Entry.Key === 'A_battery_level_V');
  assert.equal(Blank.A_battery_level_V, Number(Field.Default));
  const High = Lib.BuildRowSettings(Catalogue, Level, { On: true, Op: 'below', V: '250' });
  assert.equal(High.A_battery_level_V, 100);
  const Brightness = metric('screen_brightness');
  const Junk = Lib.BuildRowSettings(Catalogue, Brightness, { On: true, Op: 'nonsense', V: '5' });
  assert.equal(Junk.A_screen_brightness_Op, Brightness.DefaultOperator);
});

test('what a row saves is what the server alarms on', () => {
  const Level = metric('battery_level');
  const Settings = {
    ...Metrics.BuildDefaultAlarmSettings(),
    ...Lib.BuildRowSettings(Catalogue, Level, { On: true, Op: 'below', V: '20' }),
  };
  const Low = EvaluateAllAlarms({ battery_level: 12 }, Settings).find(
    (Result) => Result.Key === 'battery_level'
  );
  assert.equal(Low.Breach, true);
  const Fine = EvaluateAllAlarms({ battery_level: 80 }, Settings).find(
    (Result) => Result.Key === 'battery_level'
  );
  assert.equal(Fine.Breach, false);

  // A boolean saved as "expected Yes" fires when the reading is No.
  const Screen = metric('screen_on');
  const ScreenSettings = Lib.BuildRowSettings(Catalogue, Screen, { On: true, V: 'true' });
  const Off = EvaluateAllAlarms({ screen_on: false }, ScreenSettings).find(
    (Result) => Result.Key === 'screen_on'
  );
  assert.equal(Off.Breach, true);

  // Unticking keeps the threshold but stops the alarm.
  const Unticked = Lib.BuildRowSettings(Catalogue, Level, { On: false, Op: 'below', V: '20' });
  assert.equal(Unticked.A_battery_level_V, 20);
  assert.equal(
    EvaluateAllAlarms({ battery_level: 12 }, { ...Settings, ...Unticked }).some(
      (Result) => Result.Key === 'battery_level'
    ),
    false
  );
});
