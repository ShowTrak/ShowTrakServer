const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { CLIENT_STARTUP_GRACE_MS } = require('../dist/Modules/Config/constants');

// Client health through the real ClientManager and a real (throwaway) SQLite
// database: monitored system checks (CPU, memory, uptime, power, thermal), reboots, sleep and wake, battery
// and temperatures, hung and unfocused applications, and the display / network
// / USB / version transitions — what each does to the client's state, and which
// `ClientHealthEvent`s reach the alert pipeline.

function loggerStub() {
  const noop = () => {};
  return { CreateLogger: () => new Proxy({}, { get: () => noop }) };
}

async function loadClientManager() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-health-db-'));
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'dist', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
  await dbModule.Manager.Ready();
  const events = [];
  const clientManager = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ClientManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../DB': dbModule,
      '../Broadcast': { Manager: { emit: (event, ...args) => events.push([event, ...args]) } },
      '../SettingsManager': { Manager: { GetValue: async () => undefined } },
    }
  );
  return { Manager: clientManager.Manager, DB: dbModule.Manager, events };
}

/** Online, and past its start-up window, so faults publish immediately. */
function markStarted(client) {
  client.SetOnline(true);
  client.OnlineSince = Date.now() - CLIENT_STARTUP_GRACE_MS - 1;
  client._refreshClientHealthState();
}

const healthEvents = (events) =>
  events.filter((e) => e[0] === 'ClientHealthEvent').map((e) => e[2]);
const triggersOf = (events) => healthEvents(events).flatMap((e) => e.TriggerTypes);

function vitals(cpu, ram = '40.00', uptimeSeconds = 3600) {
  return {
    CPU: { UsagePercentage: cpu },
    Ram: { Total: 16e9, Used: 6e9, UsagePercentage: ram },
    Uptime: { Formatted: '01:00:00', Seconds: uptimeSeconds },
  };
}

test.afterEach(() => mock.timers.reset());

// --- Threshold alarms ------------------------------------------------------------

test('nothing is judged until a check is monitored', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  client.SetVitals(vitals(99, '99.00', 999999));
  mock.timers.setTime(Date.now() + 120000);
  client.SetVitals(vitals(99, '99.00', 999999));
  await Manager.SetPowerStatus(
    'c1',
    power({ OnBattery: true, Battery: { Percent: 3, Charging: false } })
  );
  assert.deepEqual(client.ResourceAlarms, []);
  assert.equal(client.Degraded, false);
  assert.deepEqual(triggersOf(events), []);
});

test('sustained high CPU raises one alarm, degrades the client, and clears when it settles', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'cpu', MaxPercent: 90, SustainSeconds: 5 });
  const [, client] = await Manager.Get('c1');
  markStarted(client);

  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  client.SetVitals(vitals(97));
  mock.timers.setTime(Date.now() + 4000);
  client.SetVitals(vitals(97));
  assert.deepEqual(client.ResourceAlarms, [], 'not yet sustained');
  mock.timers.setTime(Date.now() + 1000);
  client.SetVitals(vitals(98));

  assert.equal(client.ResourceAlarms.length, 1);
  assert.equal(client.ResourceAlarms[0].Key, 'cpu');
  assert.ok(client.DegradedWarnings.includes('High CPU Usage'));
  assert.equal(client.Degraded, true);
  const Raised = healthEvents(events).find((e) => e.TriggerTypes.includes('CPU_USAGE_HIGH'));
  assert.deepEqual(Raised.Condition, { Key: 'resource:cpu', Active: true });
  assert.equal(Raised.Details.Value, 98);
  assert.equal(Raised.Details.Threshold, 90);

  // Still over: no second alarm.
  client.SetVitals(vitals(99));
  assert.equal(triggersOf(events).filter((t) => t === 'CPU_USAGE_HIGH').length, 1);

  // Back under for the sustain window clears it, quietly.
  client.SetVitals(vitals(20));
  mock.timers.setTime(Date.now() + 5000);
  client.SetVitals(vitals(20));
  assert.deepEqual(client.ResourceAlarms, []);
  assert.equal(client.Degraded, false);
  const Cleared = healthEvents(events).at(-1);
  assert.deepEqual(Cleared.Condition, { Key: 'resource:cpu', Active: false });
  assert.deepEqual(Cleared.TriggerTypes, []);
});

test('a monitored check persists, and an unticked condition is not judged', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Create('c1');
  const [FirstErr, First] = await Manager.MarkSystemCheck('c1', { Key: 'ram' });
  assert.equal(FirstErr, null);
  assert.equal(First, true, 'a first monitor');
  const [, client] = await Manager.Get('c1');
  assert.deepEqual(client.SystemChecks.Ram, { MaxPercent: 90, SustainSeconds: 60 });

  await Manager.MarkSystemCheck('c1', { Key: 'ram', MaxPercent: null, SustainSeconds: 5 });
  assert.deepEqual(client.SystemChecks.Ram, { MaxPercent: null, SustainSeconds: 5 });
  const [, Row] = await DB.Get(
    'SELECT MaxPercent, SustainSeconds FROM CriticalSystemChecks WHERE UUID = ? AND CheckKey = ?',
    ['c1', 'ram']
  );
  assert.deepEqual({ ...Row }, { MaxPercent: null, SustainSeconds: 5 });

  markStarted(client);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  client.SetVitals(vitals(10, '99.00'));
  mock.timers.setTime(Date.now() + 10000);
  client.SetVitals(vitals(10, '99.00'));
  assert.deepEqual(client.ResourceAlarms, [], 'memory is not judged on this client');
});

test('stopping a check clears its alarm and its row', async () => {
  const { Manager, DB } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'uptime', MaxDays: 1 });
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  client.SetVitals(vitals(5, '40.00', 86401));
  assert.equal(client.ResourceAlarms[0].Key, 'uptime');
  assert.ok(client.DegradedWarnings.includes('Restart Overdue'));

  await Manager.RemoveSystemCheck('c1', 'uptime');
  assert.equal(client.SystemChecks.Uptime, null);
  assert.deepEqual(client.ResourceAlarms, []);
  assert.equal(client.Degraded, false);
  const [, Row] = await DB.Get('SELECT COUNT(*) AS n FROM CriticalSystemChecks WHERE UUID = ?', [
    'c1',
  ]);
  assert.equal(Row.n, 0);
});

test('uptime over its limit asks for a restart, and the restart clears it', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'uptime', MaxDays: 7 });
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  client.SetVitals(vitals(5, '40.00', 7 * 86400));
  assert.deepEqual(client.ResourceAlarms, []);
  client.SetVitals(vitals(5, '40.00', 7 * 86400 + 30));
  const Raised = healthEvents(events).find((e) => e.TriggerTypes.includes('UPTIME_HIGH'));
  assert.equal(Raised.Details.Threshold, 7);
  assert.equal(Raised.Details.Value, 7);
  client.SetVitals(vitals(5, '40.00', 60));
  assert.deepEqual(client.ResourceAlarms, []);
  assert.ok(triggersOf(events).includes('CLIENT_REBOOTED'));
});

test('going offline stands the alarms down', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'cpu', MaxPercent: 90, SustainSeconds: 5 });
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  client.SetVitals(vitals(99));
  mock.timers.setTime(Date.now() + 5000);
  client.SetVitals(vitals(99));
  assert.equal(client.ResourceAlarms.length, 1);

  client.SetOnline(false);
  assert.deepEqual(client.ResourceAlarms, []);
  assert.deepEqual(healthEvents(events).at(-1).Condition, { Key: 'resource:cpu', Active: false });
});

// --- Uptime, reboot and version ---------------------------------------------------

test('boot time is derived from uptime, and uptime falling back is a restart', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);

  client.SetVitals(vitals(5, '40.00', 86400));
  assert.equal(client.UptimeSeconds, 86400);
  assert.ok(Math.abs(client.BootTime - (Date.now() - 86400 * 1000)) <= 60000);
  assert.deepEqual(triggersOf(events), [], 'the first reading is a baseline');

  client.SetVitals(vitals(5, '40.00', 86401));
  client.SetVitals(vitals(5, '40.00', 45));
  const Reboot = healthEvents(events).find((e) => e.TriggerTypes.includes('CLIENT_REBOOTED'));
  assert.ok(Reboot);
  assert.equal(Reboot.Details.PreviousUptimeSeconds, 86401);
  assert.equal(Reboot.Details.UptimeSeconds, 45);
});

test('an older client sending only the formatted uptime still gets a boot time', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  client.SetVitals({ CPU: {}, Ram: {}, Uptime: { Formatted: '02:00:00' } });
  assert.equal(client.UptimeSeconds, 7200);
  assert.ok(client.BootTime > 0);
});

test('a version change is announced, a first version is not', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  // A freshly adopted client carries a placeholder until its first heartbeat.
  assert.equal(client.Version, 'X.X.X');
  await client.SetVersion('3.21.0');
  assert.deepEqual(triggersOf(events), []);
  await client.SetVersion('3.22.0');
  const Changed = healthEvents(events).find((e) =>
    e.TriggerTypes.includes('CLIENT_VERSION_CHANGED')
  );
  assert.deepEqual(Changed.Details, { PreviousVersion: '3.21.0', Version: '3.22.0' });
});

// --- Power ------------------------------------------------------------------------

function power(overrides = {}) {
  return {
    SampledAt: Date.now(),
    Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'pmset' },
    Battery: { Percent: 80, Charging: true, TimeRemainingMinutes: null },
    OnBattery: false,
    LastSuspendAt: null,
    LastResumeAt: null,
    ...overrides,
  };
}

test('sleep and wake are read from the client timestamps, after a baseline', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);

  await Manager.SetPowerStatus('c1', power({ LastSuspendAt: 100, LastResumeAt: 200 }));
  assert.deepEqual(triggersOf(events), [], 'an old wake is not news');

  await Manager.SetPowerStatus('c1', power({ LastSuspendAt: 1000, LastResumeAt: 200 }));
  assert.deepEqual(triggersOf(events), ['CLIENT_SLEEPING']);

  await Manager.SetPowerStatus('c1', power({ LastSuspendAt: 1000, LastResumeAt: 61000 }));
  const Woke = healthEvents(events).at(-1);
  assert.deepEqual(Woke.TriggerTypes, ['CLIENT_RESUMED']);
  assert.equal(Woke.Details.AsleepSeconds, 60);
});

test('a sleep the client never got to report is folded into the wake', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetPowerStatus('c1', power());
  await Manager.SetPowerStatus('c1', power({ LastSuspendAt: 5000, LastResumeAt: 9000 }));
  assert.deepEqual(triggersOf(events), ['CLIENT_RESUMED']);
});

test('losing mains, a low battery while draining it, and mains returning', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'power' });
  const [, client] = await Manager.Get('c1');
  markStarted(client);

  await Manager.SetPowerStatus('c1', power());
  await Manager.SetPowerStatus(
    'c1',
    power({ OnBattery: true, Battery: { Percent: 50, Charging: false, TimeRemainingMinutes: 90 } })
  );
  // The transition every client announces, and the monitored condition.
  assert.deepEqual(triggersOf(events), ['POWER_ON_BATTERY', 'CRITICAL_POWER_ON_BATTERY']);
  assert.ok(client.DegradedWarnings.includes('Running On Battery'));

  await Manager.SetPowerStatus(
    'c1',
    power({ OnBattery: true, Battery: { Percent: 18, Charging: false, TimeRemainingMinutes: 20 } })
  );
  assert.ok(triggersOf(events).includes('BATTERY_LOW'));
  assert.ok(client.DegradedWarnings.includes('Battery Low'));

  await Manager.SetPowerStatus(
    'c1',
    power({
      OnBattery: false,
      Battery: { Percent: 18, Charging: true, TimeRemainingMinutes: null },
    })
  );
  assert.ok(triggersOf(events).includes('POWER_RESTORED'));
  assert.equal(client.DegradedWarnings.includes('Battery Low'), false, 'charging again');
  assert.equal(client.Degraded, false);
});

test('a battery that stops charging on mains is a fault, a full one is not', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', {
    Key: 'power',
    RequireMains: false,
    MinBatteryPercent: null,
    ChargingBelowPercent: 95,
  });
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetPowerStatus('c1', power({ Battery: { Percent: 100, Charging: false } }));
  assert.deepEqual(client.ResourceAlarms, []);
  await Manager.SetPowerStatus('c1', power({ Battery: { Percent: 70, Charging: false } }));
  assert.ok(triggersOf(events).includes('BATTERY_NOT_CHARGING'));
  assert.ok(client.DegradedWarnings.includes('Battery Not Charging'));
});

test('a desktop without a battery is never judged on it', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'power', RequireMains: false });
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetPowerStatus('c1', power({ Battery: null }));
  await Manager.SetPowerStatus('c1', power({ Battery: null }));
  assert.deepEqual(triggersOf(events), []);
  assert.equal(client.PowerStatus.Battery, null);
  assert.equal(client.Degraded, false);
});

// --- Temperatures ---------------------------------------------------------------------

function temperatures(sensors, thermal = null, state = 'ok') {
  return {
    SampledAt: Date.now(),
    Status: { State: state, Message: null, Platform: 'win32', Backend: 'librehardwaremonitor' },
    Sensors: sensors,
    ThermalState: thermal,
  };
}

test('the hottest sensor over the threshold raises the temperature alarm', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'thermal', MaxCelsius: 85, MaxThermalState: null });
  const [, client] = await Manager.Get('c1');
  markStarted(client);

  await Manager.SetTemperatures(
    'c1',
    temperatures([{ Name: 'CPU Package', Kind: 'cpu', Celsius: 70 }])
  );
  assert.deepEqual(triggersOf(events), []);
  await Manager.SetTemperatures(
    'c1',
    temperatures([
      { Name: 'CPU Package', Kind: 'cpu', Celsius: 91 },
      { Name: 'GPU 0', Kind: 'gpu', Celsius: 60 },
    ])
  );
  const Hot = healthEvents(events).find((e) => e.TriggerTypes.includes('TEMPERATURE_HIGH'));
  assert.equal(Hot.Details.Value, 91);
  assert.equal(Hot.Details.Sensor, 'CPU Package');
  assert.ok(client.DegradedWarnings.includes('High Temperature'));
});

test('macOS throttling raises the thermal alarm with no sensors at all', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetTemperatures('c1', temperatures([], 'nominal'));
  // Monitored after a report: only the thermal state is guarded on a Mac.
  await Manager.MarkSystemCheck('c1', { Key: 'thermal' });
  assert.deepEqual(client.SystemChecks.Thermal, { MaxCelsius: null, MaxThermalState: 'fair' });
  assert.deepEqual(client.ResourceAlarms, []);
  await Manager.SetTemperatures('c1', temperatures([], 'critical'));
  assert.equal(client.ResourceAlarms[0].Key, 'thermal');
  assert.equal(client.ResourceAlarms[0].Value, 'critical');
  assert.ok(triggersOf(events).includes('THERMAL_STATE_HIGH'));
  assert.ok(client.DegradedWarnings.includes('Thermal Throttling'));
});

test('an unsupported temperature collector is never a fault', async () => {
  const { Manager } = await loadClientManager();
  await Manager.Create('c1');
  await Manager.MarkSystemCheck('c1', { Key: 'thermal' });
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetTemperatures('c1', temperatures([], null, 'unsupported'));
  assert.equal(client.Temperatures.Status.State, 'unsupported');
  assert.deepEqual(client.ResourceAlarms, []);
  assert.equal(client.Degraded, false);
});

// --- Applications ---------------------------------------------------------------------

function apps(items, extra = {}) {
  return {
    SampledAt: Date.now(),
    TotalCount: items.length,
    Truncated: false,
    Items: items,
    Status: { State: 'ok', Message: null, Platform: 'win32' },
    Capabilities: { Responding: true, Foreground: true },
    ...extra,
  };
}

test('a hung application is announced, degrades a critical one, and recovers', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.MarkApplicationCritical('c1', { Name: 'Resolume Arena' });

  await Manager.SetRunningApplications(
    'c1',
    apps([{ Name: 'Resolume Arena', Count: 1, Responding: true }], { Foreground: 'Resolume Arena' })
  );
  await Manager.SetRunningApplications(
    'c1',
    apps([{ Name: 'Resolume Arena', Count: 1, Responding: false }], {
      Foreground: 'Resolume Arena',
    })
  );
  const Hung = healthEvents(events).find((e) =>
    e.TriggerTypes.includes('APPLICATION_NOT_RESPONDING')
  );
  assert.deepEqual(Hung.TriggerTypes, [
    'APPLICATION_NOT_RESPONDING',
    'CRITICAL_APPLICATION_NOT_RESPONDING',
  ]);
  assert.deepEqual(Hung.Condition, { Key: 'app-hung:resolume arena', Active: true });
  assert.ok(client.DegradedWarnings.includes('Application Not Responding'));
  const Item = client.RunningApplications.Items.find((i) => i.Name === 'Resolume Arena');
  assert.equal(Item.Responding, false);

  await Manager.SetRunningApplications(
    'c1',
    apps([{ Name: 'Resolume Arena', Count: 1, Responding: true }], { Foreground: 'Resolume Arena' })
  );
  const Back = healthEvents(events).at(-1);
  assert.deepEqual(Back.TriggerTypes, ['APPLICATION_RESPONDING']);
  assert.deepEqual(Back.Condition, { Key: 'app-hung:resolume arena', Active: false });
  assert.equal(client.Degraded, false);
});

test('application conditions persist, and an unticked one is not judged', async () => {
  const { Manager, DB, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.MarkApplicationCritical('c1', { Name: 'Resolume Arena' });
  const [, First] = await DB.Get(
    'SELECT RequireResponding, RequireForeground FROM CriticalApplications WHERE UUID = ?',
    ['c1']
  );
  assert.deepEqual({ ...First }, { RequireResponding: 1, RequireForeground: 0 });

  await Manager.MarkApplicationCritical('c1', {
    Name: 'Resolume Arena',
    RequireResponding: false,
  });
  const [, Row] = await DB.Get(
    'SELECT RequireResponding, RequireForeground FROM CriticalApplications WHERE UUID = ?',
    ['c1']
  );
  assert.deepEqual({ ...Row }, { RequireResponding: 0, RequireForeground: 0 });

  // Hung, but responding is not required: announced as any app's hang, no fault.
  await Manager.SetRunningApplications(
    'c1',
    apps([{ Name: 'Resolume Arena', Count: 1, Responding: true }])
  );
  await Manager.SetRunningApplications(
    'c1',
    apps([{ Name: 'Resolume Arena', Count: 1, Responding: false }])
  );
  const Hung = healthEvents(events).find((e) =>
    e.TriggerTypes.includes('APPLICATION_NOT_RESPONDING')
  );
  assert.deepEqual(Hung.TriggerTypes, ['APPLICATION_NOT_RESPONDING']);
  assert.equal(client.Degraded, false);
});

test('a hang is reported even when the application set is unchanged (keepalive path)', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetRunningApplications('c1', apps([{ Name: 'QLab', Count: 1, Responding: true }]));
  // A delta carrying only the change to one application.
  await Manager.ApplyApplicationDelta('c1', {
    Started: [],
    Stopped: [],
    Changed: [{ Name: 'QLab', Count: 1, Responding: false }],
    SampledAt: Date.now(),
    TotalCount: 1,
    Truncated: false,
    Status: { State: 'ok', Message: null, Platform: 'darwin' },
    Capabilities: { Responding: true, Foreground: true },
  });
  assert.ok(triggersOf(events).includes('APPLICATION_NOT_RESPONDING'));
  assert.equal(triggersOf(events).includes('CRITICAL_APPLICATION_NOT_RESPONDING'), false);
});

test('a platform that cannot tell leaves Responding absent and judges nothing', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  const Unsupported = { Capabilities: { Responding: false, Foreground: false } };
  await Manager.SetRunningApplications('c1', apps([{ Name: 'QLab', Count: 1 }], Unsupported));
  await Manager.SetRunningApplications('c1', apps([{ Name: 'QLab', Count: 1 }], Unsupported));
  const Item = client.RunningApplications.Items[0];
  assert.equal('Responding' in Item, false);
  assert.equal(client.RunningApplications.Foreground, undefined);
  assert.deepEqual(client.RunningApplications.Capabilities, {
    Responding: false,
    Foreground: false,
  });
  assert.deepEqual(triggersOf(events), []);
});

test('a critical application required in the foreground degrades the client when it loses it', async () => {
  const { Manager, events, DB } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.MarkApplicationCritical('c1', { Name: 'Chrome' });
  await Manager.MarkApplicationCritical('c1', { Name: 'Chrome', RequireForeground: true });

  const [, Row] = await DB.Get(
    'SELECT RequireForeground FROM CriticalApplications WHERE UUID = ? AND ApplicationKey = ?',
    ['c1', 'chrome']
  );
  assert.equal(Row.RequireForeground, 1);

  const Items = [
    { Name: 'Chrome', Count: 1, Responding: true },
    { Name: 'Explorer', Count: 1, Responding: true },
  ];
  await Manager.SetRunningApplications('c1', apps(Items, { Foreground: 'Chrome' }));
  assert.equal(client.Degraded, false);
  assert.equal(
    client.RunningApplications.Items.find((i) => i.Name === 'Chrome').IsForeground,
    true
  );

  await Manager.SetRunningApplications('c1', apps(Items, { Foreground: 'Explorer' }));
  assert.ok(client.DegradedWarnings.includes('Application Not In Foreground'));
  assert.ok(triggersOf(events).includes('FOREGROUND_APPLICATION_CHANGED'));
  const Lost = healthEvents(events).find((e) =>
    e.TriggerTypes.includes('CRITICAL_APPLICATION_LOST_FOREGROUND')
  );
  assert.equal(Lost.Details.Foreground, 'Explorer');

  // A lock screen or an unreadable owner is not evidence the show lost focus.
  await Manager.SetRunningApplications('c1', apps(Items, { Foreground: null }));
  assert.equal(client.DegradedWarnings.includes('Application Not In Foreground'), false);

  // Re-marking without mentioning the foreground keeps the condition.
  await Manager.MarkApplicationCritical('c1', { Name: 'Chrome' });
  assert.equal(client.CriticalApplications.find((a) => a.Key === 'chrome').RequireForeground, true);
});

test('a critical application gaining a second instance is announced', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.MarkApplicationCritical('c1', { Name: 'Watchout' });
  await Manager.SetRunningApplications('c1', apps([{ Name: 'Watchout', Count: 1 }]));
  await Manager.SetRunningApplications('c1', apps([{ Name: 'Watchout', Count: 2 }]));
  assert.deepEqual(triggersOf(events), ['CRITICAL_APPLICATION_MULTIPLE_INSTANCES']);
});

// --- Displays, network, USB, audio ------------------------------------------------------------

function display(overrides = {}) {
  return {
    SessionID: '1',
    ScreenNumber: 1,
    DisplayID: 'edid:AAA:1:1',
    HardwareID: 'AAA',
    IsStableIdentity: true,
    IdentitySource: 'edid',
    Label: 'Projector',
    Width: 1920,
    Height: 1080,
    ScaleFactor: 1,
    RefreshRate: 60,
    Rotation: 0,
    Internal: false,
    Primary: true,
    Bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    ...overrides,
  };
}

test('displays connecting, disconnecting and changing mode are announced after the first list', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  await Manager.SetDisplayList('c1', [display()]);
  assert.deepEqual(triggersOf(events), []);
  await Manager.MarkDisplayCritical('c1', { DisplayID: 'edid:AAA:1:1' });

  await Manager.SetDisplayList('c1', [
    display({ Width: 1280, Height: 720 }),
    display({ DisplayID: 'edid:BBB:1:1', Label: 'Monitor', Primary: false }),
  ]);
  assert.deepEqual(triggersOf(events).sort(), [
    'DISPLAY_CONFIGURATION_CHANGED',
    'DISPLAY_CONNECTED',
  ]);

  await Manager.SetDisplayList('c1', [
    display({ DisplayID: 'edid:BBB:1:1', Label: 'Monitor', Primary: false }),
  ]);
  const Gone = healthEvents(events).at(-1);
  assert.deepEqual(Gone.TriggerTypes, ['DISPLAY_DISCONNECTED', 'CRITICAL_DISPLAY_DISCONNECTED']);
  assert.equal(Gone.Details.IsCritical, true);
});

test('network interfaces going down or changing router are announced', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  const ethernet = (address, gateway) => ({
    name: 'Ethernet',
    addresses: [
      {
        family: 'IPv4',
        address,
        netmask: '255.255.255.0',
        cidr: null,
        mac: 'AA',
        internal: false,
        scopeid: null,
      },
    ],
    gateway,
  });
  await Manager.SetNetworkInterfaces('c1', [ethernet('10.0.0.5', '10.0.0.1')]);
  await Manager.SetNetworkInterfaces('c1', [ethernet('10.0.0.5', '10.0.0.254')]);
  assert.deepEqual(triggersOf(events), ['NETWORK_GATEWAY_CHANGED']);
  await Manager.ApplyNetworkInterfaceDelta('c1', { Added: [], Changed: [], Removed: ['Ethernet'] });
  assert.deepEqual(triggersOf(events), ['NETWORK_GATEWAY_CHANGED', 'NETWORK_INTERFACE_DOWN']);
});

test('a USB device moved to another port is announced', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  const device = (Location) => ({
    VendorID: 1,
    ProductID: 2,
    ManufacturerName: 'Acme',
    ProductName: 'Buttons',
    SerialNumber: 'SN-9',
    Location,
    FirmwareVersion: '1.0',
  });
  await Manager.SetUSBDeviceList('c1', [device('1-2')]);
  await Manager.USBDeviceRemoved('c1', device('1-2'));
  await Manager.USBDeviceAdded('c1', device('1-3'));
  assert.deepEqual(triggersOf(events), ['USB_DEVICE_MOVED']);
});

test('a critical audio level leaving its range is a condition, returning ends it', async () => {
  const { Manager, events } = await loadClientManager();
  await Manager.Create('c1');
  const [, client] = await Manager.Get('c1');
  markStarted(client);
  const out = (Volume) => ({
    SampledAt: Date.now(),
    Endpoints: [
      {
        EndpointID: 'out-1',
        Direction: 'output',
        Name: 'Main',
        Manufacturer: null,
        Transport: null,
        Channels: 2,
        SampleRate: 48000,
        IsDefault: true,
        Volume,
        Muted: false,
      },
    ],
    Status: { State: 'ok', Message: null, Platform: 'win32', Backend: 'wasapi' },
    Capabilities: {
      DefaultDevice: true,
      Channels: true,
      SampleRate: true,
      Transport: false,
      InputVolume: 'device',
      OutputVolume: 'device',
      InputMute: 'device',
      OutputMute: 'device',
    },
  });
  await Manager.SetAudioDevices('c1', out(80));
  await Manager.MarkAudioDeviceCritical('c1', {
    EndpointID: 'out-1',
    MinVolume: 70,
    MaxVolume: 90,
  });
  await Manager.SetAudioDevices('c1', out(30));
  const Out = healthEvents(events).find((e) =>
    e.TriggerTypes.includes('AUDIO_VOLUME_OUT_OF_RANGE')
  );
  assert.deepEqual(Out.Condition, { Key: 'audio-volume:out-1', Active: true });
  await Manager.SetAudioDevices('c1', out(80));
  assert.deepEqual(healthEvents(events).at(-1).Condition, {
    Key: 'audio-volume:out-1',
    Active: false,
  });
});
