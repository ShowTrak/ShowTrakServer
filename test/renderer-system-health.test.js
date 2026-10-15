const test = require('node:test');
const assert = require('node:assert/strict');

// The health parts of the client info modal: the monitored system-check cards
// (CPU, memory, uptime, power, thermal), their alarms and conditions, and the
// live line each monitored check shows on the Status tab. lib/system-health.ts holds every decision and sentence, so it is
// tested directly.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/system-health.js');

function client(overrides = {}) {
  return {
    UUID: 'c1',
    Version: '3.22.0',
    Online: true,
    OperatingSystem: 'Windows',
    Vitals: {
      CPU: { UsagePercentage: 12 },
      Ram: { Total: 1, Used: 1, UsagePercentage: '50.00' },
      Uptime: { Formatted: '27:00:00', Seconds: 97200 },
    },
    BootTime: null,
    ...overrides,
  };
}

test('durations read in their two largest units', () => {
  assert.equal(Lib.FormatDuration(40), '40s');
  assert.equal(Lib.FormatDuration(125), '2m 5s');
  assert.equal(Lib.FormatDuration(3 * 3600 + 120), '3h 2m');
  assert.equal(Lib.FormatDuration(97200), '1d 3h');
  assert.equal(Lib.FormatDuration(-1), '');
  assert.equal(Lib.FormatDuration(null), '');
});

test('uptime comes from raw seconds, or the formatted string of an older client', () => {
  assert.equal(Lib.UptimeSecondsOf(client()), 97200);
  assert.equal(
    Lib.UptimeSecondsOf(client({ Vitals: { Uptime: { Formatted: '01:00:30' } } })),
    3630
  );
  assert.equal(Lib.UptimeSecondsOf(client({ Vitals: null })), null);
});

test('the uptime line is live while online and falls back to the last boot when offline', () => {
  assert.equal(Lib.UptimeText(client()), '1d 3h');
  assert.match(Lib.UptimeText(client({ BootTime: 1_700_000_000_000 })), /^1d 3h \(booted .+\)$/);
  assert.match(
    Lib.UptimeText(client({ Online: false, BootTime: 1_700_000_000_000 })),
    /^Offline — last booted /
  );
  assert.equal(Lib.UptimeText(client({ Online: false })), 'Unknown (offline)');
  assert.equal(Lib.UptimeText(client({ Vitals: null })), 'Waiting for the client');
});

test('an alarm reads as what, how much, against what, and for how long', () => {
  const Now = 1_000_000;
  assert.equal(
    Lib.ResourceAlarmText({ Key: 'cpu', Value: 97, Threshold: 90, Since: Now - 250000 }, Now),
    'High CPU usage — 97% (limit 90%) for 4m 10s'
  );
  assert.equal(
    Lib.ResourceAlarmText({ Key: 'battery', Value: 12, Threshold: 20, Since: Now }, Now),
    'Battery low — 12% (minimum 20%) for 0s'
  );
  assert.equal(
    Lib.ResourceAlarmText({ Key: 'thermal', Value: 'serious', Threshold: 'fair', Since: Now }, Now),
    'Throttling to cool down — Serious — throttling (allowed up to fair) for 0s'
  );
  assert.equal(
    Lib.ResourceAlarmText({ Key: 'uptime', Value: 8.5, Threshold: 7, Since: Now }, Now),
    'Restart overdue — 8d 12h (limit 7 days) for 0s'
  );
  assert.equal(
    Lib.ResourceAlarmText({ Key: 'power', Value: 'battery', Threshold: null, Since: Now }, Now),
    'Running on battery for 0s'
  );
});

test('power and temperature sections say why there is nothing to show', () => {
  assert.equal(Lib.GetPowerSectionState(client({ Version: '3.21.0' })), 'outdated');
  assert.equal(Lib.GetPowerSectionState(client({ Online: false })), 'offline');
  assert.equal(Lib.GetPowerSectionState(client()), 'waiting');
  const Unsupported = client({
    Temperatures: {
      SampledAt: 1,
      Status: { State: 'unsupported', Message: null, Platform: 'win32', Backend: null },
      Sensors: [],
      ThermalState: null,
    },
  });
  assert.equal(Lib.GetTemperatureSectionState(Unsupported), 'unsupported');
  assert.deepEqual(Lib.HealthSectionMessage('unsupported', Unsupported, 'temperature'), {
    Title: 'Temperatures Not Available',
    Body: 'Monitoring temperatures is not available on Windows.',
  });
  assert.match(
    Lib.HealthSectionMessage('outdated', client({ Version: '3.21.0' }), 'power').Body,
    /needs ShowTrak Client 3\.22\.0 or later — this client runs 3\.21\.0/
  );
});

test('the power details add time remaining and sleep/wake to what the conditions show', () => {
  const Rows = Lib.PowerDetailRows(
    {
      SampledAt: 1,
      Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'pmset' },
      Battery: { Percent: 15, Charging: false, TimeRemainingMinutes: 42 },
      OnBattery: true,
      LastSuspendAt: null,
      LastResumeAt: null,
    },
    1_000_000
  );
  assert.deepEqual(
    Rows.map((R) => [R.Label, R.Value]),
    [
      ['Time Remaining', '42m 0s'],
      ['Last Sleep', 'Not since the client started'],
      ['Last Wake', 'Not since the client started'],
    ]
  );
});

test('temperature rows list CPU first and flag anything over the limit', () => {
  const Rows = Lib.TemperatureRows(
    {
      SampledAt: 1,
      Status: { State: 'ok', Message: null, Platform: 'win32', Backend: 'librehardwaremonitor' },
      Sensors: [
        { Name: 'NVMe', Kind: 'storage', Celsius: 41 },
        { Name: 'GPU 0', Kind: 'gpu', Celsius: 85 },
        { Name: 'CPU Package', Kind: 'cpu', Celsius: 72.5 },
      ],
      ThermalState: null,
    },
    85
  );
  assert.equal(
    Lib.TemperatureRows(
      {
        SampledAt: 1,
        Status: { State: 'ok', Message: null, Platform: 'win32', Backend: 'lhm' },
        Sensors: [{ Name: 'GPU 0', Kind: 'gpu', Celsius: 86 }],
        ThermalState: null,
      },
      85
    )[0].Tone,
    'bad'
  );
  assert.deepEqual(
    Rows.map((R) => [R.Label, R.Value, R.Tone]),
    [
      ['CPU Package', '72.5°C', ''],
      ['GPU 0', '85°C', ''],
      ['NVMe', '41°C', ''],
    ]
  );
});

// --- System check cards -----------------------------------------------------------

const MacPower = {
  SampledAt: 1,
  Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'pmset' },
  Battery: { Percent: 54, Charging: true, TimeRemainingMinutes: null },
  OnBattery: false,
  LastSuspendAt: null,
  LastResumeAt: null,
};

test('an unmonitored card offers Monitor and no conditions', () => {
  const Card = Lib.SystemCheckCardFor(client(), 'cpu');
  assert.equal(Card.Title, 'CPU');
  assert.equal(Card.Summary, '12% used');
  assert.equal(Card.Monitored, false);
  assert.deepEqual(Card.Badge, {
    State: 'plain',
    Label: 'Monitor',
    Icon: 'bi-check-circle',
    Title: 'Monitor CPU usage',
  });
  assert.deepEqual(Card.Rows, []);
});

test('a monitored usage card shows its limit and a sustain time without a tick', () => {
  const Card = Lib.SystemCheckCardFor(
    client({
      SystemChecks: {
        Cpu: null,
        Ram: { MaxPercent: 80, SustainSeconds: 30 },
        Uptime: null,
        Power: null,
        Thermal: null,
      },
      ResourceAlarms: [{ Key: 'ram', Value: 91, Threshold: 80, Since: Date.now() }],
      Vitals: {
        CPU: { UsagePercentage: 12 },
        Ram: { Total: 16 * 1024 ** 3, Used: 8 * 1024 ** 3, UsagePercentage: '50.00' },
        Uptime: { Formatted: '01:00:00', Seconds: 3600 },
      },
    }),
    'ram'
  );
  assert.equal(Card.Summary, '50% used · 8.0 GB of 16 GB');
  assert.equal(Card.Badge.State, 'issue');
  assert.equal(Card.Issues.length, 1);
  assert.deepEqual(
    Card.Rows.map((R) => [R.Field, R.Checked, R.Tickable, R.Input.Value, !!R.Failing]),
    [
      ['MaxPercent', true, true, '80', true],
      ['SustainSeconds', true, false, '30', false],
    ]
  );
});

test('power conditions the machine cannot report read as unsupported', () => {
  const Desktop = client({
    PowerStatus: { ...MacPower, Battery: null },
    SystemChecks: {
      Cpu: null,
      Ram: null,
      Uptime: null,
      Power: { RequireMains: true, MinBatteryPercent: null, ChargingBelowPercent: null },
      Thermal: null,
    },
  });
  const Card = Lib.SystemCheckCardFor(Desktop, 'power');
  assert.equal(Card.Summary, 'Mains · No battery');
  assert.deepEqual(
    Card.Rows.map((R) => [R.Field, R.Supported, R.Value]),
    [
      ['RequireMains', true, 'Yes'],
      ['MinBatteryPercent', false, 'Unsupported'],
      ['ChargingBelowPercent', false, 'Unsupported'],
    ]
  );
});

test('an old client cannot be monitored on power, and says why', () => {
  const Card = Lib.SystemCheckCardFor(client({ Version: '3.21.0' }), 'power');
  assert.equal(Card.CanMonitor, false);
  assert.match(Card.Note.Body, /needs ShowTrak Client 3\.22\.0/);
});

test('the thermal card offers a thermal-state picker on a Mac', () => {
  const Mac = client({
    Temperatures: {
      SampledAt: 1,
      Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'pmset' },
      Sensors: [],
      ThermalState: 'nominal',
    },
    SystemChecks: {
      Cpu: null,
      Ram: null,
      Uptime: null,
      Power: null,
      Thermal: { MaxCelsius: null, MaxThermalState: 'fair' },
    },
  });
  const Card = Lib.SystemCheckCardFor(Mac, 'thermal');
  assert.equal(Card.Summary, 'Thermal state Normal');
  const [Celsius, State] = Card.Rows;
  assert.equal(Celsius.Supported, false);
  assert.equal(State.Input.Kind, 'select');
  assert.equal(State.Input.Value, 'fair');
});

test('a conditions table reads back into a request, and bad limits are refused', () => {
  assert.deepEqual(Lib.ParseSystemCheckFields('cpu', { MaxPercent: '85', SustainSeconds: '30' }), {
    Payload: { Key: 'cpu', MaxPercent: 85, SustainSeconds: 30 },
  });
  assert.deepEqual(Lib.ParseSystemCheckFields('cpu', { MaxPercent: '', SustainSeconds: '' }), {
    Payload: { Key: 'cpu', MaxPercent: null },
  });
  assert.deepEqual(
    Lib.ParseSystemCheckFields('power', { RequireMains: true, MinBatteryPercent: '' }),
    { Payload: { Key: 'power', RequireMains: true, MinBatteryPercent: null } }
  );
  assert.deepEqual(Lib.ParseSystemCheckFields('thermal', { MaxThermalState: 'serious' }), {
    Payload: { Key: 'thermal', MaxThermalState: 'serious' },
  });
  assert.match(Lib.ParseSystemCheckFields('cpu', { MaxPercent: '150' }).Error, /1 to 100%/);
  assert.match(Lib.ParseSystemCheckFields('uptime', { MaxDays: '2.5' }).Error, /whole number/);
});

test('a monitored check reads idle, failing or healthy on the Status tab', () => {
  const Monitored = client({
    SystemChecks: {
      Cpu: { MaxPercent: 90, SustainSeconds: 60 },
      Ram: null,
      Uptime: null,
      Power: null,
      Thermal: null,
    },
  });
  assert.deepEqual(Lib.SystemCheckLiveState(Monitored, Lib.SystemCheckCardFor(Monitored, 'cpu')), {
    State: 'ONLINE',
    Label: '12% used',
  });
  const Failing = {
    ...Monitored,
    ResourceAlarms: [{ Key: 'cpu', Value: 97, Threshold: 90, Since: Date.now() }],
  };
  assert.deepEqual(Lib.SystemCheckLiveState(Failing, Lib.SystemCheckCardFor(Failing, 'cpu')), {
    State: 'DEGRADED',
    Label: 'High CPU usage — 97%',
  });
  const Offline = { ...Monitored, Online: false };
  assert.deepEqual(Lib.SystemCheckLiveState(Offline, Lib.SystemCheckCardFor(Offline, 'cpu')), {
    State: 'IDLE',
    Label: 'Offline',
  });
  assert.deepEqual(Lib.SYSTEM_CHECK_ORDER, ['cpu', 'ram', 'uptime', 'power', 'thermal']);
});

test('the uptime limit is set in days', () => {
  const Card = Lib.SystemCheckCardFor(
    client({
      SystemChecks: { Cpu: null, Ram: null, Uptime: { MaxDays: 7 }, Power: null, Thermal: null },
    }),
    'uptime'
  );
  assert.deepEqual(
    Card.Rows.map((R) => [R.Field, R.Label, R.Input.Value, R.Input.Unit]),
    [['MaxDays', 'Maximum uptime', '7', 'days']]
  );
  assert.deepEqual(Lib.ParseSystemCheckFields('uptime', { MaxDays: '14' }), {
    Payload: { Key: 'uptime', MaxDays: 14 },
  });
  assert.match(Lib.ParseSystemCheckFields('uptime', { MaxDays: '400' }).Error, /1 to 366 days/);
});
