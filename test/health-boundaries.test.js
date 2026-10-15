const test = require('node:test');
const assert = require('node:assert/strict');

// The socket boundary for client health telemetry (client 3.27.0+): uptime in
// seconds, hung and foreground applications, and the PowerStatus and
// Temperatures snapshots. Shape and bounds are enforced here; meaning is decided
// by ClientManager. What matters most is that ABSENT stays absent — an older
// client that cannot report a field must never read as reporting "false".

const { Manager: SocketValidation } = require('../dist/Modules/SocketValidation/index');

test('uptime seconds pass through, and stay absent for an older client', () => {
  const New = SocketValidation.Heartbeat({
    Version: '3.22.0',
    Vitals: { Uptime: { Formatted: '01:00:00', Seconds: 3600.7 } },
  });
  assert.deepEqual(New.Vitals.Uptime, { Formatted: '01:00:00', Seconds: 3600 });
  const Old = SocketValidation.Heartbeat({
    Version: '3.21.0',
    Vitals: { Uptime: { Formatted: '01:00:00' } },
  });
  assert.deepEqual(Old.Vitals.Uptime, { Formatted: '01:00:00' });
});

test('a bad uptime is dropped without costing the heartbeat', () => {
  const Warnings = [];
  const Result = SocketValidation.Heartbeat(
    { Version: '3.22.0', Vitals: { Uptime: { Formatted: '01:00:00', Seconds: 'soon' } } },
    (Message) => Warnings.push(Message)
  );
  assert.deepEqual(Result.Vitals.Uptime, { Formatted: '01:00:00' });
  assert.equal(Warnings.length, 1);
});

test('application responsiveness and the foreground are kept only when sent', () => {
  const Snapshot = SocketValidation.RunningApplications({
    SampledAt: 1,
    TotalCount: 2,
    Items: [
      { Name: 'QLab', Count: 1, Responding: false },
      { Name: 'Finder', Count: 1, Responding: 'maybe' },
      { Name: 'Old', Count: 1 },
    ],
    Status: { State: 'ok' },
    Foreground: 'QLab',
    Capabilities: { Responding: true, Foreground: 'yes' },
  });
  assert.deepEqual(Snapshot.Items, [
    { Name: 'QLab', Count: 1, Responding: false },
    { Name: 'Finder', Count: 1, Responding: null },
    { Name: 'Old', Count: 1 },
  ]);
  assert.equal(Snapshot.Foreground, 'QLab');
  assert.deepEqual(Snapshot.Capabilities, { Responding: true, Foreground: false });

  const Older = SocketValidation.RunningApplications({ Items: [], Status: { State: 'ok' } });
  assert.equal('Foreground' in Older, false);
  assert.equal('Capabilities' in Older, false);
  const Unfocused = SocketValidation.RunningApplications({ Items: [], Foreground: null });
  assert.equal(Unfocused.Foreground, null);
});

test('application deltas carry responsiveness, the foreground and capabilities', () => {
  const Delta = SocketValidation.ApplicationDelta({
    Started: [],
    Stopped: [],
    Changed: [{ Name: 'Chrome', Count: 1, Responding: true }],
    Foreground: 'Chrome',
    Capabilities: { Responding: true, Foreground: true },
  });
  assert.deepEqual(Delta.Changed, [{ Name: 'Chrome', Count: 1, Responding: true }]);
  assert.equal(Delta.Foreground, 'Chrome');
  assert.deepEqual(Delta.Capabilities, { Responding: true, Foreground: true });
});

test('a power snapshot is bounded and a missing battery stays null', () => {
  const Power = SocketValidation.PowerStatus({
    SampledAt: 5,
    Status: { State: 'ok', Message: null, Platform: 'win32', Backend: 'wmi' },
    Battery: { Percent: 50, Charging: 'yes', TimeRemainingMinutes: 30 },
    OnBattery: true,
    LastSuspendAt: 1,
    LastResumeAt: 2,
  });
  assert.deepEqual(Power.Battery, { Percent: 50, Charging: null, TimeRemainingMinutes: 30 });
  assert.equal(Power.OnBattery, true);
  const Desktop = SocketValidation.PowerStatus({ Status: { State: 'ok' }, Battery: null });
  assert.equal(Desktop.Battery, null);
  assert.equal(Desktop.OnBattery, null);
  assert.throws(() => SocketValidation.PowerStatus('nope'), /PowerStatus payload/);
  assert.throws(() => SocketValidation.PowerStatus({ Battery: 7 }), /Battery must be an object/);
});

test('a temperature snapshot drops unusable sensors and is capped', () => {
  const Snapshot = SocketValidation.Temperatures({
    Status: { State: 'ok' },
    Sensors: [
      { Name: 'CPU', Kind: 'cpu', Celsius: 55 },
      { Name: '', Kind: 'cpu', Celsius: 40 },
      { Name: 'GPU', Kind: 'gpu', Celsius: null },
    ],
    ThermalState: 'nominal',
  });
  assert.deepEqual(Snapshot.Sensors, [{ Name: 'CPU', Kind: 'cpu', Celsius: 55 }]);
  assert.equal(Snapshot.ThermalState, 'nominal');
  assert.throws(
    () =>
      SocketValidation.Temperatures({
        Sensors: Array.from({ length: 65 }, (_, i) => ({ Name: `S${i}`, Celsius: 40 })),
      }),
    /Sensors/
  );
});
