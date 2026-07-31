// The FreeKiosk metric registry.
//
// The registry is the single source of truth for the alarm schema, the view
// modal, the history series and threshold evaluation, so its invariants are
// worth pinning hard. Two in particular:
//
//   - Keys must be id-safe. The schema field renderer locates inputs with
//     $('#MON_DYN_' + Key) and only escapes quotes, so a dot in a key would
//     parse as an id-plus-class selector and conditional visibility would
//     silently never fire. A regex here is the cheapest guard against that.
//   - Every declared Path must actually resolve against a real /api/status
//     payload, otherwise a metric renders "no reading" forever and nobody
//     notices until a show.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FREEKIOSK_METRICS,
  FREEKIOSK_METRICS_BY_KEY,
  FREEKIOSK_SECTIONS,
  FREEKIOSK_METRIC_GROUPS,
  GroupFieldKey,
  IsMetricGroupEnabled,
  AlarmFieldKeys,
  BuildFreeKioskAlarmFields,
  BuildDefaultAlarmSettings,
  ExtractMetricValues,
  WifiChannelForFrequency,
  FormatMetricValue,
  FormatDuration,
  EDGE_OPERATORS,
} = require('../dist/Modules/FreeKiosk/metrics');
const { STATUS_HEALTHY } = require('./helpers/freekiosk-device');

test('every metric key is id-safe and unique', () => {
  const seen = new Set();
  for (const metric of FREEKIOSK_METRICS) {
    assert.match(
      metric.Key,
      /^[A-Za-z0-9_]+$/,
      `${metric.Key} must contain only [A-Za-z0-9_] — a dot breaks the #MON_DYN_ selector`
    );
    assert.ok(!seen.has(metric.Key), `duplicate metric key ${metric.Key}`);
    seen.add(metric.Key);
  }
  assert.equal(seen.size, FREEKIOSK_METRICS.length);
});

test('generated alarm field keys are id-safe too', () => {
  for (const field of BuildFreeKioskAlarmFields()) {
    assert.match(field.Key, /^[A-Za-z0-9_]+$/, `${field.Key} is not id-safe`);
  }
});

test('every metric declares a known section and chart kind', () => {
  for (const metric of FREEKIOSK_METRICS) {
    assert.ok(
      FREEKIOSK_SECTIONS.includes(metric.Section),
      `${metric.Key} has section ${metric.Section}, which is not in FREEKIOSK_SECTIONS`
    );
    assert.ok(['line', 'blocks', 'none'].includes(metric.Chart), `${metric.Key} chart kind`);
    // Only numeric metrics can be drawn as a line, and only non-numeric ones as
    // categorical blocks — the renderer dispatches on this.
    if (metric.Chart === 'line') assert.equal(metric.Type, 'number', `${metric.Key} line chart`);
    if (metric.Chart === 'blocks') {
      assert.notEqual(metric.Type, 'number', `${metric.Key} block timeline`);
    }
  }
});

test('every non-derived path resolves against a real /api/status payload', () => {
  const values = ExtractMetricValues(STATUS_HEALTHY, {
    poll_latencyMs: 42,
    control_enabled: true,
  });
  for (const metric of FREEKIOSK_METRICS) {
    if (metric.Derived && !metric.Path.length) continue;
    assert.notEqual(
      values[metric.Key],
      null,
      `${metric.Key} (path ${metric.Path.join('.')}) read nothing from a full status payload`
    );
  }
});

test('extracts representative readings with correct types and rounding', () => {
  const values = ExtractMetricValues(STATUS_HEALTHY);
  assert.equal(values.battery_level, 87);
  assert.equal(values.battery_charging, true);
  assert.equal(values.battery_plugged, 'ac');
  assert.equal(values.battery_temperature, 24.5);
  assert.equal(values.battery_voltage, 4.32);
  assert.equal(values.screen_brightness, 75);
  assert.equal(values.wifi_signalStrength, -52);
  assert.equal(values.device_uptime, 93600);
  assert.equal(values.storage_usedPercent, 53);
  assert.equal(values.memory_lowMemory, false);
  assert.equal(values.webview_currentUrl, 'https://example.com/board');
  // Decimals: 0 on a metric whose device value has a fraction.
  assert.equal(values.wifi_signalLevel, 78);
});

test('derived metrics are computed, not read', () => {
  const values = ExtractMetricValues(STATUS_HEALTHY);
  assert.equal(values.content_displaying, true);
  assert.equal(values.rotation_urlCount, 2);
  assert.equal(values.rotation_urls, 'https://example.com/a, https://example.com/b');
});

test('the accelerometer is not a metric, even though the device reports one', () => {
  // Dropped as noise on a wall-mounted tablet. The device still sends
  // sensors.accelerometer; nothing reads it.
  const values = ExtractMetricValues(STATUS_HEALTHY);
  assert.ok(STATUS_HEALTHY.sensors.accelerometer, 'the fixture still carries one');
  for (const key of Object.keys(values)) assert.ok(!/accel/i.test(key), key);
});

test('the Wi-Fi channel is worked out from the frequency, per band', () => {
  // Each band numbers from its own base, so this is ranges rather than one
  // formula — and the two off-pattern channels are real hardware, not trivia.
  const cases = [
    [2412, 1],
    [2437, 6],
    [2447, 8], // what the Android emulator actually reports
    [2472, 13],
    [2484, 14], // 12 MHz above channel 13, not 5
    [5180, 36],
    [5745, 149],
    [5825, 165],
    [4910, 182], // 4.9 GHz (802.11j) numbers from 4000, so these run 182-196
    [4920, 184],
    [5935, 2], // 6 GHz channel 2, below its own band base
    [5955, 1], // 6 GHz channel 1
    [6175, 45],
  ];
  for (const [mhz, channel] of cases) {
    assert.equal(WifiChannelForFrequency(mhz), channel, `${mhz} MHz`);
  }
});

test('a frequency in no known band is no reading, not a plausible number', () => {
  // A made-up channel is worse than an em dash, because somebody would act on
  // it. Disconnected devices commonly report 0.
  for (const input of [0, -1, null, undefined, '', 'nope', NaN, 1000, 3000, 8000]) {
    assert.equal(WifiChannelForFrequency(input), null, String(input));
  }
});

test('the channel reads through the registry as a whole number', () => {
  const values = ExtractMetricValues(STATUS_HEALTHY);
  assert.equal(values.wifi_channel, 36);
  // Never a fraction: a channel is an identifier, and 36.4 would be nonsense.
  assert.ok(Number.isInteger(values.wifi_channel));
  assert.equal(ExtractMetricValues({ wifi: { frequency: 0 } }).wifi_channel, null);
});

test('readings with no meaningful shape over time are values, not charts', () => {
  // A chart is for a signal you read a trend off. A rotation index, a storage
  // figure that moves once a month or an uptime counter that only ever climbs
  // are all read as "what is it now" — a line under each is sixty columns of
  // furniture. They keep their alarms; they just lose the graph.
  const valueOnly = [
    'device_uptime',
    'rotation_urlCount',
    'rotation_currentIndex',
    'rotation_interval',
    'sensors_light',
    'sensors_proximity',
    'storage_usedPercent',
    'storage_usedMB',
    'storage_availableMB',
    'autoBrightness_currentLightLevel',
  ];
  for (const key of valueOnly) {
    assert.equal(FREEKIOSK_METRICS_BY_KEY.get(key).Chart, 'none', key);
  }
  // Storage still alarms — losing the chart must not lose the threshold.
  assert.ok(FREEKIOSK_METRICS_BY_KEY.get('storage_usedPercent').Operators.includes('above'));
  assert.ok(FREEKIOSK_METRICS_BY_KEY.get('device_uptime').Operators.includes('decreases'));
  // Things that genuinely do move are still charted.
  for (const key of [
    'battery_level',
    'screen_brightness',
    'wifi_signalStrength',
    'memory_usedPercent',
  ]) {
    assert.equal(FREEKIOSK_METRICS_BY_KEY.get(key).Chart, 'line', key);
  }
});

test('remote control is reported but never alarmed on', () => {
  // It records how the LAST control command went rather than reading anything
  // from the device, so it cannot change while a terminal is merely watched. An
  // alarm would fire long after the operator had already been told — a refused
  // command reports inline, in the moment, in the device's own words.
  const control = FREEKIOSK_METRICS_BY_KEY.get('control_enabled');
  assert.deepEqual(control.Operators, []);
  assert.equal(control.Chart, 'none');
  // And so it contributes nothing to the editor's alarm schema at all.
  const fields = BuildFreeKioskAlarmFields();
  for (const key of Object.values(AlarmFieldKeys('control_enabled'))) {
    assert.equal(
      fields.find((f) => f.Key === key),
      undefined,
      key
    );
  }
});

test('the raw frequency is shown beside the channel, but not charted or alarmed', () => {
  // Both readings are visible; only one is monitorable. They are the same signal
  // at different scales, so a second chart would draw the same line twice and a
  // second alarm would be a rival way of saying "the channel changed".
  const values = ExtractMetricValues(STATUS_HEALTHY);
  assert.equal(values.wifi_frequency, 5180);
  assert.equal(values.wifi_channel, 36);

  const frequency = FREEKIOSK_METRICS_BY_KEY.get('wifi_frequency');
  assert.equal(frequency.Unit, 'MHz');
  assert.equal(frequency.Chart, 'none');
  assert.deepEqual(frequency.Operators, []);
  assert.equal(FREEKIOSK_METRICS_BY_KEY.get('wifi_channel').Chart, 'line');
});

test('a metric compared only for inequality asks for the expected value', () => {
  // The channel is numeric but armed with isNot, so labelling its input
  // "Threshold" would describe a comparison the engine never makes.
  const fields = BuildFreeKioskAlarmFields();
  assert.equal(
    fields.find((f) => f.Key === AlarmFieldKeys('wifi_channel').V).Label,
    'Expected value'
  );
  // A genuine threshold still says so.
  assert.match(fields.find((f) => f.Key === AlarmFieldKeys('battery_level').V).Label, /^Threshold/);
});

test('content_displaying is false when the screensaver covers a lit screen', () => {
  const values = ExtractMetricValues({
    screen: { on: true, screensaverActive: true },
  });
  assert.equal(values.screen_on, true);
  assert.equal(values.content_displaying, false);
});

test('content_displaying is unknown, not false, when the screen is not reported', () => {
  // Reporting false here would arm the default alarm on no evidence at all.
  const values = ExtractMetricValues({ battery: { level: 50 } });
  assert.equal(values.content_displaying, null);
});

test('sensor sentinel -1 records no reading rather than a real value', () => {
  const values = ExtractMetricValues({
    sensors: { light: -1, proximity: -1, accelerometer: { x: 0, y: 0, z: 0 } },
  });
  assert.equal(values.sensors_light, null);
  assert.equal(values.sensors_proximity, null);
});

test('a missing or malformed payload yields nulls, never throws', () => {
  for (const input of [null, undefined, 42, 'nope', {}, { battery: null }, { screen: 5 }]) {
    const values = ExtractMetricValues(input);
    assert.equal(values.battery_level, null);
    assert.equal(values.screen_on, null);
    assert.equal(Object.keys(values).length, FREEKIOSK_METRICS.length);
  }
});

test('overrides supply the metrics ShowTrak measures itself', () => {
  const values = ExtractMetricValues(STATUS_HEALTHY, {
    poll_latencyMs: 137,
    control_enabled: false,
  });
  assert.equal(values.poll_latencyMs, 137);
  assert.equal(values.control_enabled, false);
});

test('alarm schema emits an enable toggle for every alarmable metric', () => {
  const fields = BuildFreeKioskAlarmFields();
  const alarmable = FREEKIOSK_METRICS.filter((m) => m.Operators.length);
  // A_ only: the section master switches are G_ and are counted separately.
  const toggles = fields.filter((f) => f.Key.startsWith('A_') && f.Key.endsWith('_On'));
  assert.equal(toggles.length, alarmable.length);
  for (const metric of alarmable) {
    const keys = AlarmFieldKeys(metric.Key);
    const toggle = fields.find((f) => f.Key === keys.On);
    assert.ok(toggle, `${metric.Key} has no enable toggle`);
    assert.equal(toggle.Type, 'boolean');
    assert.equal(toggle.Label, metric.Label);
    assert.equal(toggle.MetricKey, metric.Key);
  }
});

test('view-only metrics contribute no alarm fields at all', () => {
  const fields = BuildFreeKioskAlarmFields();
  for (const metric of FREEKIOSK_METRICS) {
    if (metric.Operators.length) continue;
    const keys = AlarmFieldKeys(metric.Key);
    for (const key of Object.values(keys)) {
      assert.equal(
        fields.find((f) => f.Key === key),
        undefined,
        `${metric.Key} is view-only but emitted ${key}`
      );
    }
  }
});

test('operator picker and value inputs are gated behind the enable toggle', () => {
  const fields = BuildFreeKioskAlarmFields();
  const keys = AlarmFieldKeys('battery_level');

  const gates = (field) =>
    Array.isArray(field.VisibleWhen) ? field.VisibleWhen : [field.VisibleWhen];

  const op = fields.find((f) => f.Key === keys.Op);
  assert.ok(gates(op).some((c) => c.Key === keys.On && c.Equals === true));

  const value = fields.find((f) => f.Key === keys.V);
  assert.ok(gates(value).some((c) => c.Key === keys.On && c.Equals === true));
});

test("every field in a section is gated on that section's master switch", () => {
  // Not just the enable toggle. Conditional visibility is evaluated against the
  // DOM, and a hidden checkbox still reports itself as checked — so gating only
  // the toggle would leave its operator and threshold on screen underneath a
  // section that had been switched off.
  const fields = BuildFreeKioskAlarmFields();
  const gates = (field) =>
    Array.isArray(field.VisibleWhen)
      ? field.VisibleWhen
      : field.VisibleWhen
        ? [field.VisibleWhen]
        : [];

  for (const field of fields) {
    if (!field.Key.startsWith('A_')) continue;
    const group = FREEKIOSK_METRIC_GROUPS.find((g) => g.Key === field.MetricSection);
    if (!group || group.Fixed) continue;
    assert.ok(
      gates(field).some((c) => c.Key === GroupFieldKey(group.Key) && c.Equals === true),
      `${field.Key} is not gated on ${GroupFieldKey(group.Key)}`
    );
  }
});

test('a fixed group offers no switch, so nothing in it can be gated away', () => {
  // Poll latency is measured by ShowTrak, costs the device nothing, and is the
  // series behind the status timeline. Letting it be switched off would blank
  // that timeline for no saving at all.
  const fields = BuildFreeKioskAlarmFields();
  assert.equal(
    fields.find((f) => f.Key === GroupFieldKey('Poll')),
    undefined
  );
  const latency = fields.find((f) => f.Key === AlarmFieldKeys('poll_latencyMs').On);
  assert.equal(latency.VisibleWhen, undefined);
});

test('a section switch is emitted per group, ahead of the checks it governs', () => {
  const fields = BuildFreeKioskAlarmFields();
  for (const group of FREEKIOSK_METRIC_GROUPS) {
    const index = fields.findIndex((f) => f.Key === GroupFieldKey(group.Key));
    if (group.Fixed) {
      assert.equal(index, -1, `${group.Key} is fixed and must offer no switch`);
      continue;
    }
    assert.ok(index >= 0, `${group.Key} has no switch`);
    const firstCheck = fields.findIndex(
      (f) => f.Key.startsWith('A_') && f.MetricSection === group.Key
    );
    assert.ok(index < firstCheck, `${group.Key}'s switch must precede its checks`);
    // Never Advanced: a switch collapsed inside a panel would leave a whole
    // section unexplained.
    assert.ok(!fields[index].Advanced);
  }
});

test('the upper bound only shows for range operators', () => {
  const keys = AlarmFieldKeys('battery_level');
  const fields = BuildFreeKioskAlarmFields();
  const upper = fields.find((f) => f.Key === keys.V2);
  assert.ok(upper, 'battery_level offers outside/inside so it needs an upper bound');
  assert.ok(Array.isArray(upper.VisibleWhen), 'a two-condition gate must be an array');
  const opGate = upper.VisibleWhen.find((c) => c.Key === keys.Op);
  assert.deepEqual(opGate.In.slice().sort(), ['inside', 'outside']);

  // A metric with no range operator must not emit one.
  const screenKeys = AlarmFieldKeys('screen_on');
  assert.equal(
    fields.find((f) => f.Key === screenKeys.V2),
    undefined
  );
});

test('the threshold input is hidden for value-less edge operators', () => {
  const fields = BuildFreeKioskAlarmFields();
  const keys = AlarmFieldKeys('device_uptime');
  const value = fields.find((f) => f.Key === keys.V);
  const conditions = Array.isArray(value.VisibleWhen) ? value.VisibleWhen : [value.VisibleWhen];
  const opGate = conditions.find((c) => c.Key === keys.Op);
  assert.ok(opGate, 'uptime offers "goes backwards", so the value must be operator-gated');
  for (const edge of EDGE_OPERATORS) {
    assert.ok(!opGate.In.includes(edge), `${edge} takes no value but was left visible`);
  }
});

test('a single-operator metric renders no redundant picker', () => {
  const fields = BuildFreeKioskAlarmFields();
  const keys = AlarmFieldKeys('screen_on');
  assert.equal(
    fields.find((f) => f.Key === keys.Op),
    undefined,
    'screen_on offers one operator, so a picker would be noise'
  );
  assert.ok(fields.find((f) => f.Key === keys.V));
});

test('boolean and enum value inputs are selects over the right domain', () => {
  const fields = BuildFreeKioskAlarmFields();
  const bool = fields.find((f) => f.Key === AlarmFieldKeys('screen_on').V);
  assert.equal(bool.Type, 'select');
  assert.deepEqual(
    bool.Options.map((o) => o.value),
    ['true', 'false']
  );

  const enumField = fields.find((f) => f.Key === AlarmFieldKeys('battery_health').V);
  assert.equal(enumField.Type, 'select');
  assert.deepEqual(enumField.Options, [
    'good',
    'overheat',
    'dead',
    'over_voltage',
    'failure',
    'cold',
    'unknown',
  ]);
});

test('every operator offered by a metric appears in its picker', () => {
  const fields = BuildFreeKioskAlarmFields();
  for (const metric of FREEKIOSK_METRICS) {
    if (metric.Operators.length < 2) continue;
    const op = fields.find((f) => f.Key === AlarmFieldKeys(metric.Key).Op);
    assert.deepEqual(
      op.Options.map((o) => o.value),
      metric.Operators.slice(),
      `${metric.Key} picker options`
    );
    assert.ok(
      metric.Operators.includes(op.Default),
      `${metric.Key} default operator ${op.Default} is not one it offers`
    );
  }
});

test('defaults arm exactly one alarm out of the box', () => {
  const settings = BuildDefaultAlarmSettings();
  const on = Object.entries(settings).filter(
    ([key, value]) => key.startsWith('A_') && key.endsWith('_On') && value === true
  );
  assert.deepEqual(
    on.map(([key]) => key),
    [AlarmFieldKeys('content_displaying').On],
    'only "not displaying content" should alarm before the operator configures anything'
  );
});

test('a new terminal starts with the core sections monitored and the rest off', () => {
  const settings = BuildDefaultAlarmSettings();
  const on = FREEKIOSK_METRIC_GROUPS.filter(
    (g) => !g.Fixed && settings[GroupFieldKey(g.Key)] === true
  ).map((g) => g.Key);
  assert.deepEqual(on, ['Content', 'Screen', 'Battery', 'Network']);
  // The default-armed alarm has to live in a section that is on, or the shipped
  // "stopped displaying content" alarm would be force-disabled at birth.
  assert.equal(settings[GroupFieldKey('Content')], true);
});

test('a section that is switched off is written out explicitly, not omitted', () => {
  // Absence means "enabled" for backwards compatibility, so a new terminal has
  // to state the off ones or it would come up with everything monitored.
  const settings = BuildDefaultAlarmSettings();
  for (const group of FREEKIOSK_METRIC_GROUPS) {
    if (group.Fixed) continue;
    assert.equal(typeof settings[GroupFieldKey(group.Key)], 'boolean', group.Key);
  }
});

test('an absent section switch reads as enabled, so an old show file is untouched', () => {
  // A terminal configured before this feature existed has no G_ keys at all.
  // Reading those as the new lean defaults would silently stop monitoring
  // sections the operator had armed alarms in.
  for (const group of FREEKIOSK_METRIC_GROUPS) {
    assert.equal(IsMetricGroupEnabled({}, group.Key), true, group.Key);
  }
  assert.equal(IsMetricGroupEnabled({ G_Sensors_On: false }, 'Sensors'), false);
  assert.equal(IsMetricGroupEnabled({ G_Sensors_On: 'false' }, 'Sensors'), false);
  // A fixed group ignores the setting entirely.
  assert.equal(IsMetricGroupEnabled({ G_Poll_On: false }, 'Poll'), true);
});

test('a metric with a default operator that takes a value also declares one', () => {
  for (const metric of FREEKIOSK_METRICS) {
    if (!metric.Operators.length) continue;
    const op = metric.DefaultOperator || metric.Operators[0];
    if (EDGE_OPERATORS.includes(op)) continue;
    if (metric.Type !== 'number') continue;
    // Numeric metrics without a sensible universal threshold legitimately have
    // none; assert only that when one is given it is inside any declared range.
    if (metric.DefaultValue == null) continue;
    if (metric.Min != null) assert.ok(metric.DefaultValue >= metric.Min, `${metric.Key} min`);
    if (metric.Max != null) assert.ok(metric.DefaultValue <= metric.Max, `${metric.Key} max`);
  }
});

test('lookup map matches the array', () => {
  assert.equal(FREEKIOSK_METRICS_BY_KEY.size, FREEKIOSK_METRICS.length);
  for (const metric of FREEKIOSK_METRICS) {
    assert.equal(FREEKIOSK_METRICS_BY_KEY.get(metric.Key), metric);
  }
});

test('formats values the way an operator reads them', () => {
  const get = (key) => FREEKIOSK_METRICS_BY_KEY.get(key);
  assert.equal(FormatMetricValue(get('battery_level'), 87), '87%');
  assert.equal(FormatMetricValue(get('battery_temperature'), 24.53), '24.5 °C');
  assert.equal(FormatMetricValue(get('wifi_signalStrength'), -52), '-52 dBm');
  assert.equal(FormatMetricValue(get('screen_on'), false), 'No');
  assert.equal(FormatMetricValue(get('battery_health'), 'overheat'), 'overheat');
  assert.equal(FormatMetricValue(get('device_uptime'), 93600), '1d 2h');
  assert.equal(FormatMetricValue(get('storage_availableMB'), 15000), '14.6 GB');
  assert.equal(FormatMetricValue(get('storage_availableMB'), 512), '512 MB');
  assert.equal(FormatMetricValue(get('battery_level'), null), 'no reading');
});

test('formats durations across every magnitude', () => {
  assert.equal(FormatDuration(0), '0s');
  assert.equal(FormatDuration(45), '45s');
  assert.equal(FormatDuration(90), '1m 30s');
  assert.equal(FormatDuration(3661), '1h 1m');
  assert.equal(FormatDuration(90000), '1d 1h');
});

test('long URLs are truncated so they fit a tile', () => {
  const metric = FREEKIOSK_METRICS_BY_KEY.get('webview_currentUrl');
  const long = `https://example.com/${'a'.repeat(200)}`;
  const shown = FormatMetricValue(metric, long);
  assert.ok(shown.length <= 60);
  assert.ok(shown.endsWith('...'));
});
