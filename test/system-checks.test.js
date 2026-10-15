const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Monitored system checks (Modules/ClientManager/system-checks.ts): what a
// first Monitor press guards, how an edit merges into what is saved, and the
// verdict each condition reaches from a reading. Pure, so tested directly.

const Checks = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'system-checks.js')
);

function power(overrides = {}) {
  return {
    SampledAt: 1,
    Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'pmset' },
    Battery: { Percent: 80, Charging: true, TimeRemainingMinutes: null },
    OnBattery: false,
    LastSuspendAt: null,
    LastResumeAt: null,
    ...overrides,
  };
}

function temperatures(sensors, thermal = null, state = 'ok') {
  return {
    SampledAt: 1,
    Status: { State: state, Message: null, Platform: 'win32', Backend: 'lhm' },
    Sensors: sensors,
    ThermalState: thermal,
  };
}

// --- Defaults and edits ------------------------------------------------------------

test('a first monitor ticks the usual limits', () => {
  assert.deepEqual(Checks.DefaultSystemCheck('cpu', null, null), {
    MaxPercent: 90,
    SustainSeconds: 60,
  });
  assert.deepEqual(Checks.DefaultSystemCheck('uptime', null, null), { MaxDays: 1 });
  assert.deepEqual(Checks.DefaultSystemCheck('power', null, null), {
    RequireMains: true,
    MinBatteryPercent: 20,
    ChargingBelowPercent: null,
  });
});

test('a first monitor guards only what the machine reports', () => {
  // A Mac: a thermal state, no readable sensors.
  assert.deepEqual(Checks.DefaultSystemCheck('thermal', null, temperatures([], 'nominal')), {
    MaxCelsius: null,
    MaxThermalState: 'fair',
  });
  // A PC: sensors, no thermal state.
  const Pc = temperatures([{ Name: 'CPU', Kind: 'cpu', Celsius: 50 }]);
  assert.deepEqual(Checks.DefaultSystemCheck('thermal', null, Pc), {
    MaxCelsius: 85,
    MaxThermalState: null,
  });
  // A desktop: no battery to hold a level on.
  assert.equal(
    Checks.DefaultSystemCheck('power', power({ Battery: null }), null).MinBatteryPercent,
    null
  );
  // Nothing readable at all: keep everything rather than guard nothing.
  assert.deepEqual(Checks.DefaultSystemCheck('thermal', null, temperatures([], null)), {
    MaxCelsius: 85,
    MaxThermalState: 'fair',
  });
});

test('an edit keeps what it does not mention, and null stops guarding', () => {
  const Existing = { MaxPercent: 90, SustainSeconds: 60 };
  assert.deepEqual(
    Checks.resolveSystemCheck('cpu', { Key: 'cpu', MaxPercent: 75 }, Existing, null, null),
    { MaxPercent: 75, SustainSeconds: 60 }
  );
  assert.deepEqual(
    Checks.resolveSystemCheck('cpu', { Key: 'cpu', MaxPercent: null }, Existing, null, null),
    { MaxPercent: null, SustainSeconds: 60 }
  );
  // A field of another check is ignored.
  assert.deepEqual(
    Checks.resolveSystemCheck('uptime', { Key: 'uptime', MaxPercent: 5 }, null, null, null),
    { MaxDays: 1 }
  );
});

test('a stored row round-trips to the check it describes', () => {
  const Row = Checks.SystemCheckToRow(
    'c1',
    'power',
    { RequireMains: true, MinBatteryPercent: 30, ChargingBelowPercent: 95 },
    123
  );
  assert.equal(Row.RequireMains, 1);
  assert.equal(Row.MaxPercent, null);
  assert.deepEqual(Checks.normalizeSystemCheckRow(Row), {
    Key: 'power',
    Check: { RequireMains: true, MinBatteryPercent: 30, ChargingBelowPercent: 95 },
  });
  assert.equal(Checks.normalizeSystemCheckRow({ CheckKey: 'gpu' }), null);
});

test('stored limits are clamped to their ranges', () => {
  assert.deepEqual(Checks.normalizeSystemCheck('ram', { MaxPercent: 150, SustainSeconds: -3 }), {
    MaxPercent: 100,
    SustainSeconds: 0,
  });
  assert.deepEqual(Checks.normalizeSystemCheck('thermal', { MaxThermalState: 'critical' }), {
    MaxCelsius: null,
    MaxThermalState: null,
  });
});

// --- Verdicts ---------------------------------------------------------------------------

test('usage and uptime breach only above their limit', () => {
  const Cpu = { MaxPercent: 90, SustainSeconds: 0 };
  assert.equal(Checks.UsageBreach(Cpu, 90), false);
  assert.equal(Checks.UsageBreach(Cpu, 90.5), true);
  assert.equal(Checks.UsageBreach(Cpu, null), null, 'no reading');
  assert.equal(Checks.UsageBreach({ MaxPercent: null, SustainSeconds: 0 }, 99), null, 'unticked');
  assert.equal(Checks.UsageBreach(null, 99), null, 'not monitored');
  assert.equal(Checks.UptimeBreach({ MaxDays: 2 }, 2 * 86400), false);
  assert.equal(Checks.UptimeBreach({ MaxDays: 2 }, 2 * 86400 + 1), true);
});

test('power: on battery, a low charge while not charging, and charging on mains', () => {
  const Check = { RequireMains: true, MinBatteryPercent: 20, ChargingBelowPercent: 95 };
  assert.deepEqual(Checks.PowerBreaches(Check, power()), {
    power: false,
    battery: false,
    charging: false,
  });
  // Unplugged and draining: the source and the level speak; charging is not judged.
  assert.deepEqual(
    Checks.PowerBreaches(
      Check,
      power({ OnBattery: true, Battery: { Percent: 10, Charging: false, TimeRemainingMinutes: 9 } })
    ),
    { power: true, battery: true, charging: false }
  );
  // Plugged in but not charging, below the level it should charge from.
  assert.deepEqual(
    Checks.PowerBreaches(Check, power({ Battery: { Percent: 60, Charging: false } })),
    { power: false, battery: false, charging: true }
  );
  // Full (or held by battery care) reads "not charging" and is fine.
  assert.equal(
    Checks.PowerBreaches(Check, power({ Battery: { Percent: 100, Charging: false } })).charging,
    false
  );
  // A low charge on mains is recovering, not a fault.
  assert.equal(
    Checks.PowerBreaches(Check, power({ Battery: { Percent: 5, Charging: true } })).battery,
    false
  );
  // A desktop has no battery to judge.
  assert.deepEqual(Checks.PowerBreaches(Check, power({ Battery: null })), {
    power: false,
    battery: null,
    charging: null,
  });
  // A collector that cannot report is never a fault.
  assert.deepEqual(
    Checks.PowerBreaches(
      Check,
      power({ Status: { State: 'unsupported', Message: null, Platform: 'linux', Backend: null } })
    ),
    { power: null, battery: null, charging: null }
  );
});

test('thermal: the hottest sensor, and a thermal state beyond the one allowed', () => {
  const Check = { MaxCelsius: 85, MaxThermalState: 'fair' };
  const Hot = temperatures([
    { Name: 'CPU', Kind: 'cpu', Celsius: 70 },
    { Name: 'GPU', Kind: 'gpu', Celsius: 88 },
  ]);
  assert.deepEqual(Checks.ThermalBreaches(Check, Hot), { temperature: true, thermal: null });
  assert.deepEqual(Checks.HottestSensor(Hot), { Name: 'GPU', Kind: 'gpu', Celsius: 88 });
  assert.deepEqual(Checks.ThermalBreaches(Check, temperatures([], 'fair')), {
    temperature: null,
    thermal: false,
  });
  assert.deepEqual(Checks.ThermalBreaches(Check, temperatures([], 'serious')), {
    temperature: null,
    thermal: true,
  });
  assert.equal(
    Checks.ThermalBreaches(
      { MaxCelsius: null, MaxThermalState: 'nominal' },
      temperatures([], 'fair')
    ).thermal,
    true
  );
});

// --- The request boundary ---------------------------------------------------------------

const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');

test('a system-check request carries only its own check fields, in range', () => {
  assert.deepEqual(IPCValidation.ClientSystemCheckPayload({ Key: 'cpu' }), { Key: 'cpu' });
  assert.deepEqual(
    IPCValidation.ClientSystemCheckPayload({
      Key: 'thermal',
      MaxCelsius: null,
      MaxThermalState: 'serious',
    }),
    { Key: 'thermal', MaxCelsius: null, MaxThermalState: 'serious' }
  );
  assert.throws(() => IPCValidation.ClientSystemCheckPayload({ Key: 'gpu' }), /Key must be/);
  assert.throws(
    () => IPCValidation.ClientSystemCheckPayload({ Key: 'uptime', MaxPercent: 50 }),
    /does not apply to the uptime check/
  );
  assert.throws(
    () => IPCValidation.ClientSystemCheckPayload({ Key: 'cpu', MaxPercent: 101 }),
    /from 1 to 100/
  );
  assert.throws(
    () => IPCValidation.ClientSystemCheckPayload({ Key: 'cpu', SustainSeconds: null }),
    /SustainSeconds/
  );
  assert.throws(
    () => IPCValidation.ClientSystemCheckPayload({ Key: 'power', RequireMains: 'yes' }),
    /RequireMains/
  );
  assert.throws(
    () => IPCValidation.ClientSystemCheckPayload({ Key: 'thermal', MaxThermalState: 'critical' }),
    /MaxThermalState/
  );
});

// --- CPU / memory history for the charts ------------------------------------------------

const Vitals = require('../dist/main/client-vitals-history');

function reading(cpu, ram, extra = {}) {
  return {
    UUID: 'v1',
    Online: true,
    Vitals: { CPU: { UsagePercentage: cpu }, Ram: { UsagePercentage: String(ram) } },
    ResourceAlarms: [],
    ...extra,
  };
}

test('heartbeats are averaged into ten-second points, the latest still showing', () => {
  Vitals._internal.Store.clear();
  const T0 = 1_000_000;
  Vitals.recordClientVitalsSample(reading(10, 40), T0);
  Vitals.recordClientVitalsSample(reading(30, 60), T0 + 5000);
  // Mid-interval: the averaging point is returned provisionally.
  let History = Vitals.getClientVitalsHistory('v1', T0 + 6000);
  assert.deepEqual(
    History.Cpu.map((S) => S.n),
    [20]
  );
  Vitals.recordClientVitalsSample(
    reading(50, 80, { ResourceAlarms: [{ Key: 'cpu' }] }),
    T0 + Vitals.VITALS_POINT_INTERVAL_MS
  );
  History = Vitals.getClientVitalsHistory('v1', T0 + Vitals.VITALS_POINT_INTERVAL_MS);
  assert.deepEqual(
    History.Cpu.map((S) => [S.n, S.breach]),
    [[30, true]]
  );
  assert.deepEqual(
    History.Ram.map((S) => [S.n, S.breach]),
    [[60, false]]
  );
});

test('going offline breaks the line, and old points age out', () => {
  Vitals._internal.Store.clear();
  const T0 = 2_000_000;
  Vitals.recordClientVitalsSample(reading(10, 40), T0);
  Vitals.recordClientVitalsSample({ UUID: 'v1', Online: false }, T0 + 1000);
  const History = Vitals.getClientVitalsHistory('v1', T0 + 1000);
  assert.deepEqual(
    History.Cpu.map((S) => S.ok),
    [true, false]
  );
  const Later = T0 + Vitals.VITALS_HISTORY_WINDOW_MS + 5000;
  Vitals.pruneClientVitalsHistory(Later);
  assert.deepEqual(Vitals.getClientVitalsHistory('v1', Later), { Cpu: [], Ram: [] });
  assert.equal(Vitals._internal.Store.size, 0);
});

test('a client removed from the list is forgotten', () => {
  Vitals._internal.Store.clear();
  Vitals.recordClientVitalsSample(reading(10, 40), 1);
  Vitals.syncClientVitalsHistory([{ UUID: 'other' }]);
  assert.equal(Vitals._internal.Store.size, 0);
});

// --- Status-tab history -----------------------------------------------------------------

const History = require('../dist/main/monitoring-history');

test('each monitored system check records healthy or failing, and nothing it cannot judge', () => {
  const Client = {
    UUID: 'h1',
    Online: true,
    SystemChecks: {
      Cpu: { MaxPercent: 90, SustainSeconds: 60 },
      Ram: null,
      Uptime: { MaxDays: 7 },
      Power: { RequireMains: true, MinBatteryPercent: 20, ChargingBelowPercent: null },
      Thermal: { MaxCelsius: 85, MaxThermalState: null },
    },
    ResourceAlarms: [{ Key: 'battery', Value: 10, Threshold: 20, Since: 1 }],
    UptimeSeconds: 100,
    PowerStatus: power(),
    // A collector that cannot report leaves a gap rather than a verdict.
    Temperatures: temperatures([], null, 'unsupported'),
  };
  History.recordClientSystemCheckHistorySamples(Client);
  const Series = History.getClientSystemCheckHistorySamples('h1');
  assert.deepEqual(
    Series.map((S) => [S.CheckKey, S.samples.at(-1).online, S.samples.at(-1).degraded]),
    [
      ['cpu', true, false],
      ['uptime', true, false],
      ['power', true, true],
    ]
  );
});

test('a monitored application breaking a condition records as degraded, a closed one as offline', () => {
  const Apps = (Items, Foreground = 'Chrome') => ({
    UUID: 'h2',
    Online: true,
    RunningApplications: {
      Status: { State: 'ok' },
      Foreground,
      Capabilities: { Responding: true, Foreground: true },
      Items,
    },
  });
  History.recordClientApplicationHistorySamples(
    Apps([
      {
        Name: 'QLab',
        Key: 'qlab',
        IsCritical: true,
        IsRunning: true,
        RequireForeground: true,
        IsForeground: false,
      },
      { Name: 'Resolume', Key: 'resolume', IsCritical: true, IsRunning: true, Responding: false },
      { Name: 'Notes', Key: 'notes', IsCritical: true, IsRunning: false },
    ])
  );
  const Series = History.getClientApplicationHistorySamples('h2');
  assert.deepEqual(
    Series.map((S) => [S.Key, S.samples.at(-1).online, S.samples.at(-1).degraded]),
    [
      ['qlab', true, true],
      ['resolume', true, true],
      ['notes', false, false],
    ]
  );
});
