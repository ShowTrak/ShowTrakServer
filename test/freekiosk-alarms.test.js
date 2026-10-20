// FreeKiosk threshold evaluation.
//
// The rule that matters most here: a STORED operator is the breach comparison.
// `below 20` fires under 20 and `is No` fires when the reading is No. The editor
// shows each one as its complement — the expectation, "Expected at least 20%" —
// but this engine only ever sees the breach. Getting the direction backwards
// for equality while leaving it forwards for thresholds would make every
// boolean alarm fire permanently, so each operator is asserted explicitly.
//
// Which is why every boolean METRIC in the registry arms `isNot` rather than
// `is`: a two-state metric draws no operator picker, so its lone Yes/No box has
// to mean the expected state — the only thing anyone reads it as. The operators
// below are still tested in both directions; it is the registry that chooses.
//
// The second rule: a metric with no reading never breaches. A tablet with no
// light sensor reports -1, which the registry maps to null; if that satisfied a
// "below" alarm, every such device would sit permanently degraded.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ParseAlarmSettings,
  EvaluateMetricAlarm,
  EvaluateAllAlarms,
  BuildDegradedReason,
} = require('../dist/Modules/FreeKiosk/alarms');
const {
  FREEKIOSK_METRICS_BY_KEY,
  AlarmFieldKeys,
  BuildDefaultAlarmSettings,
} = require('../dist/Modules/FreeKiosk/metrics');

const metric = (key) => FREEKIOSK_METRICS_BY_KEY.get(key);

function armed(key, operator, value, value2) {
  return { Key: key, Enabled: true, Operator: operator, Value: value, Value2: value2 };
}

function judge(key, operator, value, reading, previous = null, value2) {
  return EvaluateMetricAlarm(metric(key), armed(key, operator, value, value2), reading, previous);
}

// ---- Numeric operators ----------------------------------------------------

test('below fires under the threshold and not on it', () => {
  assert.equal(judge('battery_level', 'below', 20, 19).Breach, true);
  assert.equal(judge('battery_level', 'below', 20, 20).Breach, false);
  assert.equal(judge('battery_level', 'below', 20, 21).Breach, false);
});

test('above fires over the threshold and not on it', () => {
  assert.equal(judge('battery_temperature', 'above', 45, 45.1).Breach, true);
  assert.equal(judge('battery_temperature', 'above', 45, 45).Breach, false);
  assert.equal(judge('battery_temperature', 'above', 45, 20).Breach, false);
});

test('outside fires beyond either bound, inclusive of the bounds themselves', () => {
  assert.equal(judge('battery_level', 'outside', 20, 19, null, 80).Breach, true);
  assert.equal(judge('battery_level', 'outside', 20, 81, null, 80).Breach, true);
  assert.equal(judge('battery_level', 'outside', 20, 20, null, 80).Breach, false);
  assert.equal(judge('battery_level', 'outside', 20, 80, null, 80).Breach, false);
  assert.equal(judge('battery_level', 'outside', 20, 50, null, 80).Breach, false);
});

test('inside fires within the bounds', () => {
  assert.equal(judge('battery_level', 'inside', 20, 50, null, 80).Breach, true);
  assert.equal(judge('battery_level', 'inside', 20, 20, null, 80).Breach, true);
  assert.equal(judge('battery_level', 'inside', 20, 10, null, 80).Breach, false);
});

test('range bounds entered backwards still work', () => {
  // Rather than silently never firing because low > high.
  assert.equal(judge('battery_level', 'outside', 80, 19, null, 20).Breach, true);
  assert.equal(judge('battery_level', 'inside', 80, 50, null, 20).Breach, true);
});

test('a range alarm with no upper bound does not fire', () => {
  assert.equal(judge('battery_level', 'outside', 20, 5, null, null).Breach, false);
});

test('negative-scale metrics compare correctly', () => {
  // RSSI is negative: -80 is weaker than -75, so "below -75" must fire on -80.
  assert.equal(judge('wifi_signalStrength', 'below', -75, -80).Breach, true);
  assert.equal(judge('wifi_signalStrength', 'below', -75, -50).Breach, false);
});

// ---- Boolean / enum / string operators ------------------------------------

test('is fires when the reading equals the armed value', () => {
  assert.equal(judge('screen_on', 'is', false, false).Breach, true);
  assert.equal(judge('screen_on', 'is', false, true).Breach, false);
  assert.equal(judge('memory_lowMemory', 'is', true, true).Breach, true);
});

test('brightness and volume can be expected at an exact level, within 1%', () => {
  for (const key of ['screen_brightness', 'audio_volume']) {
    assert.ok(metric(key).Operators.includes('isNot'), `${key} offers Is`);
    assert.equal(judge(key, 'isNot', 80, 80).Breach, false);
    assert.equal(judge(key, 'isNot', 80, 79).Breach, false);
    assert.equal(judge(key, 'isNot', 80, 81).Breach, false);
    assert.equal(judge(key, 'isNot', 80, 78).Breach, true);
    assert.equal(judge(key, 'isNot', 80, 82).Breach, true);
  }
  assert.equal(
    judge('screen_brightness', 'isNot', 80, 50).Reason,
    'Brightness is 50% (expected 80%)'
  );
});

test('a metric with no tolerance is still matched exactly', () => {
  assert.equal(judge('wifi_channel', 'isNot', 36, 37).Breach, true);
});

test('is accepts the string form a select stores', () => {
  // The value input is a <select>, so the setting round-trips as 'true'/'false'.
  assert.equal(judge('screen_on', 'is', 'false', false).Breach, true);
  assert.equal(judge('screen_on', 'is', 'true', false).Breach, false);
});

test('equality works on numeric metrics, not only on strings and booleans', () => {
  // These used to fall through to the range branch, find no upper bound and
  // return "not breaching" for ever — so `is` on rotation interval, API level,
  // the auto-brightness bounds and the Wi-Fi channel was silently dead.
  assert.equal(judge('wifi_channel', 'isNot', 36, 6).Breach, true);
  assert.equal(judge('wifi_channel', 'isNot', 36, 36).Breach, false);
  assert.equal(judge('rotation_interval', 'is', 30, 30).Breach, true);
  assert.equal(judge('rotation_interval', 'is', 30, 45).Breach, false);
  // The string form a number input round-trips as still compares numerically.
  assert.equal(judge('wifi_channel', 'isNot', '36', 36).Breach, false);
});

test('a channel alarm reports the channel it wanted', () => {
  const result = judge('wifi_channel', 'isNot', 36, 6);
  assert.equal(result.Reason, 'Wi-Fi Channel is 6 (expected 36)');
});

test('isNot fires when the reading differs from the armed value', () => {
  assert.equal(judge('battery_health', 'isNot', 'good', 'overheat').Breach, true);
  assert.equal(judge('battery_health', 'isNot', 'good', 'good').Breach, false);
});

test('string comparisons are case-insensitive', () => {
  assert.equal(judge('wifi_ssid', 'is', 'backstage', 'Backstage').Breach, true);
  assert.equal(judge('wifi_ssid', 'isNot', 'BACKSTAGE', 'Backstage').Breach, false);
});

test('contains and notContains work on substrings', () => {
  const url = 'https://example.com/board?x=1';
  assert.equal(judge('webview_currentUrl', 'contains', 'example.com', url).Breach, true);
  assert.equal(judge('webview_currentUrl', 'contains', 'other.com', url).Breach, false);
  assert.equal(judge('webview_currentUrl', 'notContains', 'example.com', url).Breach, false);
  assert.equal(judge('webview_currentUrl', 'notContains', 'other.com', url).Breach, true);
});

test('a string alarm with nothing to compare against never fires', () => {
  // Otherwise a half-configured rule would alarm on every terminal at once.
  for (const op of ['is', 'isNot', 'contains', 'notContains']) {
    assert.equal(judge('wifi_ssid', op, '', 'Backstage').Breach, false, op);
    assert.equal(judge('wifi_ssid', op, '   ', 'Backstage').Breach, false, `${op} whitespace`);
  }
});

// ---- Edge operators -------------------------------------------------------

test('changes needs a previous reading to compare against', () => {
  assert.equal(judge('wifi_ssid', 'changes', null, 'Backstage', null).Breach, false);
  assert.equal(judge('wifi_ssid', 'changes', null, 'Backstage', 'Backstage').Breach, false);
  assert.equal(judge('wifi_ssid', 'changes', null, 'Guest', 'Backstage').Breach, true);
});

test('decreases catches uptime going backwards, which is the reboot signal', () => {
  assert.equal(judge('device_uptime', 'decreases', null, 30, 90000).Breach, true);
  assert.equal(judge('device_uptime', 'decreases', null, 90060, 90000).Breach, false);
  assert.equal(judge('device_uptime', 'decreases', null, 30, null).Breach, false);
});

// ---- Absence of data ------------------------------------------------------

test('a metric with no reading never breaches, whatever the operator', () => {
  const ops = ['below', 'above', 'outside', 'inside'];
  for (const op of ops) {
    assert.equal(judge('sensors_light', op, 100, null, null, 200).Breach, false, op);
  }
  assert.equal(judge('screen_on', 'is', false, null).Breach, false);
  assert.equal(judge('wifi_ssid', 'isNot', 'Backstage', null).Breach, false);
});

test('a disabled alarm never breaches even when the condition holds', () => {
  const config = { ...armed('battery_level', 'below', 20), Enabled: false };
  const result = EvaluateMetricAlarm(metric('battery_level'), config, 5);
  assert.equal(result.Breach, false);
  assert.equal(result.Reason, null);
});

// ---- Settings parsing -----------------------------------------------------

test('parses the flat settings record into per-metric configs', () => {
  const keys = AlarmFieldKeys('screen_brightness');
  const configs = ParseAlarmSettings({
    [keys.On]: true,
    [keys.Op]: 'above',
    [keys.V]: 80,
    [keys.V2]: 95,
  });
  const config = configs.get('screen_brightness');
  assert.equal(config.Enabled, true);
  assert.equal(config.Operator, 'above');
  assert.equal(config.Value, 80);
  assert.equal(config.Value2, 95);
});

test('an operator the metric no longer offers falls back to its default', () => {
  // A show file written before an operator was withdrawn must not evaluate as
  // something else entirely.
  const keys = AlarmFieldKeys('screen_on');
  const configs = ParseAlarmSettings({ [keys.On]: true, [keys.Op]: 'contains' });
  assert.equal(configs.get('screen_on').Operator, 'isNot');
});

test('a boolean arms isNot, so its stored value is the state the operator wants', () => {
  // Booleans draw no operator picker, which leaves the Yes/No box as the only
  // thing on screen — so it has to mean "expected", not "alert when". Arming
  // "expected Yes" must pass on Yes and fire on No, in that order.
  const keys = AlarmFieldKeys('webview_canGoBack');
  const settings = { [keys.On]: true, [keys.V]: 'true' };
  assert.equal(
    EvaluateAllAlarms({ webview_canGoBack: true }, settings).find(
      (r) => r.Key === 'webview_canGoBack'
    ).Breach,
    false
  );
  assert.equal(
    EvaluateAllAlarms({ webview_canGoBack: false }, settings).find(
      (r) => r.Key === 'webview_canGoBack'
    ).Breach,
    true
  );

  // And the other way round: "expected No" passes on No. This is the exact case
  // that used to read "No, expected No" and still show as degraded.
  const wantNo = { [keys.On]: true, [keys.V]: 'false' };
  assert.equal(
    EvaluateAllAlarms({ webview_canGoBack: false }, wantNo).find(
      (r) => r.Key === 'webview_canGoBack'
    ).Breach,
    false
  );
});

test('a switched-off section force-disables the alarms inside it', () => {
  // The whole point: a threshold left armed from when the section WAS monitored
  // must not keep firing after it is switched off. The editor hides those
  // fields, so an alert from one would be unattributable.
  const keys = AlarmFieldKeys('memory_lowMemory');
  const armedSettings = { [keys.On]: true, [keys.V]: 'false' };

  const on = ParseAlarmSettings({ ...armedSettings, G_Memory_On: true });
  assert.equal(on.get('memory_lowMemory').Enabled, true);

  const off = ParseAlarmSettings({ ...armedSettings, G_Memory_On: false });
  assert.equal(off.get('memory_lowMemory').Enabled, false);

  // And it really does not breach, not merely "is not enabled".
  const breaching = EvaluateAllAlarms(
    { memory_lowMemory: true },
    { ...armedSettings, G_Memory_On: false }
  );
  assert.deepEqual(
    breaching.filter((r) => r.Breach),
    []
  );
});

test('a section left unset keeps evaluating, so an upgrade changes nothing', () => {
  const keys = AlarmFieldKeys('memory_lowMemory');
  const configs = ParseAlarmSettings({ [keys.On]: true, [keys.V]: 'false' });
  assert.equal(configs.get('memory_lowMemory').Enabled, true);
});

test('missing, null and junk settings parse to everything disabled', () => {
  for (const input of [null, undefined, 'nope', 42, {}]) {
    const configs = ParseAlarmSettings(input);
    assert.ok(configs.size > 0);
    for (const config of configs.values()) assert.equal(config.Enabled, false);
  }
});

test('unknown keys in stored settings are dropped, not carried', () => {
  const configs = ParseAlarmSettings({ A_metric_that_went_away_On: true });
  assert.equal(configs.has('metric_that_went_away'), false);
});

// ---- Whole-terminal evaluation -------------------------------------------

test('the shipped defaults degrade a terminal that stops displaying content', () => {
  const settings = BuildDefaultAlarmSettings();
  const healthy = EvaluateAllAlarms({ content_displaying: true }, settings);
  assert.deepEqual(
    healthy.filter((r) => r.Breach),
    []
  );

  const blank = EvaluateAllAlarms({ content_displaying: false }, settings);
  const breaches = blank.filter((r) => r.Breach);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].Key, 'content_displaying');
  assert.equal(breaches[0].Reason, 'Displaying Content is No (expected Yes)');
});

test('turning the default alarm off is all it takes to override it', () => {
  const settings = BuildDefaultAlarmSettings();
  settings[AlarmFieldKeys('content_displaying').On] = false;
  const results = EvaluateAllAlarms({ content_displaying: false }, settings);
  assert.deepEqual(
    results.filter((r) => r.Breach),
    []
  );
});

test('only armed metrics are evaluated at all', () => {
  const keys = AlarmFieldKeys('battery_level');
  const results = EvaluateAllAlarms(
    { battery_level: 5, screen_on: false },
    { [keys.On]: true, [keys.Op]: 'below', [keys.V]: 20 }
  );
  assert.deepEqual(
    results.map((r) => r.Key),
    ['battery_level']
  );
});

test('previous readings are threaded through to the edge operators', () => {
  const keys = AlarmFieldKeys('wifi_channel');
  const settings = { G_Network_On: true, [keys.On]: true, [keys.Op]: 'changes' };
  const channel = (results) => results.find((r) => r.Key === 'wifi_channel');
  assert.equal(channel(EvaluateAllAlarms({ wifi_channel: 36 }, settings, null)).Breach, false);
  assert.equal(
    channel(EvaluateAllAlarms({ wifi_channel: 36 }, settings, { wifi_channel: 40 })).Breach,
    true
  );
});

// ---- Uptime -----------------------------------------------------------------

test('uptime is only judged as too long without a restart, set in days', () => {
  // Read in seconds, typed in days: "Expected at most 7 days".
  const uptime = FREEKIOSK_METRICS_BY_KEY.get('device_uptime');
  assert.deepEqual(uptime.Operators, ['above']);
  const keys = AlarmFieldKeys('device_uptime');
  const settings = { G_Device_On: true, [keys.On]: true, [keys.V]: 7 };
  const judged = (seconds) =>
    EvaluateAllAlarms({ device_uptime: seconds }, settings).find((r) => r.Key === 'device_uptime');
  assert.equal(judged(6 * 86400).Breach, false);
  assert.equal(judged(7 * 86400).Breach, false, 'exactly the limit is still within it');
  const over = judged(9 * 86400 + 3600);
  assert.equal(over.Breach, true);
  assert.equal(over.Reason, 'Uptime is 9d 1h (expected at most 7 days)');
  assert.equal(
    EvaluateAllAlarms({ device_uptime: 2 * 86400 }, { ...settings, [keys.V]: 1 })[0].Reason,
    'Uptime is 2d 0h (expected at most 1 day)'
  );
});

test('Power Source is expected to be ac out of the box, so ac is healthy', () => {
  const keys = AlarmFieldKeys('battery_plugged');
  const settings = { ...BuildDefaultAlarmSettings(), [keys.On]: true };
  const plugged = (value) =>
    EvaluateAllAlarms({ battery_plugged: value }, settings).find(
      (r) => r.Key === 'battery_plugged'
    );
  assert.equal(plugged('ac').Breach, false);
  assert.equal(plugged('none').Breach, true);
  assert.equal(plugged('usb').Reason, 'Power Source is usb (expected ac)');
});

// ---- Reason wording -------------------------------------------------------

test('reasons read as a human sentence with the value in them', () => {
  // Every reason names the reading and the expectation it broke.
  assert.equal(
    judge('battery_level', 'below', 20, 12).Reason,
    'Battery Level is 12% (expected at least 20%)'
  );
  assert.equal(
    judge('battery_temperature', 'above', 45, 51.2).Reason,
    'Battery Temperature is 51.2 °C (expected at most 45 °C)'
  );
  assert.equal(
    judge('battery_health', 'isNot', 'good', 'overheat').Reason,
    'Battery Health is overheat (expected good)'
  );
  assert.equal(
    judge('battery_plugged', 'isNot', 'ac', 'usb').Reason,
    'Power Source is usb (expected ac)'
  );
  assert.equal(
    judge('battery_plugged', 'is', 'none', 'none').Reason,
    'Power Source is none (expected anything but none)'
  );
  assert.equal(
    judge('battery_level', 'outside', 20, 95, null, 80).Reason,
    'Battery Level is 95% (expected 20%–80%)'
  );
  assert.equal(
    judge('webview_currentUrl', 'notContains', 'dashboard', 'https://x/error').Reason,
    'Current URL does not contain "dashboard" (expected it to)'
  );
  assert.equal(
    judge('wifi_ssid', 'changes', null, 'Guest', 'Backstage').Reason,
    'SSID changed (Backstage → Guest)'
  );
  assert.match(judge('device_uptime', 'decreases', null, 30, 90000).Reason, /device restarted/);
});

test('degraded summary lists the first three then counts the rest', () => {
  const results = [
    { Breach: true, Reason: 'A' },
    { Breach: true, Reason: 'B' },
    { Breach: false, Reason: null },
    { Breach: true, Reason: 'C' },
    { Breach: true, Reason: 'D' },
    { Breach: true, Reason: 'E' },
  ];
  assert.equal(BuildDegradedReason(results), 'A · B · C · +2 more');
  assert.equal(BuildDegradedReason(results.slice(0, 3)), 'A · B');
  assert.equal(BuildDegradedReason([]), '');
});
