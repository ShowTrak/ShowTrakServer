// The FreeKiosk polling loop and snapshot.
//
// The loop's hazards are all about a poll that is already awaiting the network:
// it cannot be cancelled, so it has to notice on landing that it has been
// retired. Without the generation counter a restarted loop leaves two live timer
// chains racing; without the overlap guard a device slower than the interval
// stacks up requests. Both are asserted directly rather than assumed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  return { debug: () => {}, error: () => {}, log: () => {}, warn: () => {} };
}

// Load the terminal with a stubbed protocol client so a poll's timing is under
// the test's control rather than the network's.
function loadTerminal({ events, getStatus }) {
  const modulePath = path.join(
    __dirname,
    '..',
    'dist',
    'Modules',
    'FreeKioskManager',
    'terminal.js'
  );
  return loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
    '../FreeKiosk/client': { GetStatus: getStatus },
  }).FreeKioskTerminal;
}

const ROW = {
  UUID: 'uuid-1',
  Nickname: 'Lobby Kiosk',
  Address: '10.0.0.5',
  Port: 8080,
  ApiKey: 'secret-key',
  Interval: 5000,
  TimeoutMs: 5000,
  Settings: '{}',
  GroupID: null,
  Weight: 100,
  Slug: 'lobby-kiosk',
  Timestamp: 1,
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const okStatus =
  (status = {}) =>
  async () => [null, { Status: status, LatencyMs: 12 }];

// ---- The snapshot ---------------------------------------------------------

test('the snapshot is plain data and survives a structured clone', async () => {
  // It crosses Electron's IPC by structured clone and is stringified into alert
  // history. A timer handle in it is circular (stringify throws) and uncloneable
  // (the IPC send fails), so this is a real crash, not a style point.
  const events = [];
  const Terminal = loadTerminal({ events, getStatus: okStatus() });
  const terminal = new Terminal(ROW);
  terminal.StartLoop();
  try {
    const snapshot = terminal.ToJSON();
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
    assert.deepEqual(structuredClone(snapshot), snapshot);
  } finally {
    terminal.StopLoop();
  }
});

test('the API key is never in the snapshot', async () => {
  const events = [];
  const Terminal = loadTerminal({ events, getStatus: okStatus() });
  const snapshot = new Terminal(ROW).ToJSON();
  assert.equal(snapshot.HasApiKey, true);
  assert.equal('ApiKey' in snapshot, false);
  assert.ok(!JSON.stringify(snapshot).includes('secret-key'));
});

test('a terminal reads as unknown before its first poll', () => {
  const events = [];
  const Terminal = loadTerminal({ events, getStatus: okStatus() });
  const snapshot = new Terminal(ROW).ToJSON();
  assert.equal(snapshot.State, 'IDLE');
  assert.equal(snapshot.LastChecked, null);
  assert.equal(snapshot.ControlEnabled, null);
  // A tile must have something to show before anything has been read.
  assert.equal(snapshot.Hostname, '10.0.0.5');
});

// ---- Concurrency ----------------------------------------------------------

test('a poll still in flight cannot broadcast after its loop is stopped', async () => {
  const gate = deferred();
  const events = [];
  let polled = 0;
  const Terminal = loadTerminal({
    events,
    getStatus: async () => {
      polled += 1;
      await gate.promise;
      return [null, { Status: {}, LatencyMs: 5 }];
    },
  });
  const terminal = new Terminal(ROW);

  terminal.StartLoop();
  const tick = terminal.Tick(); // Poll now in flight, awaiting the device.
  terminal.StopLoop(); // Retires it.
  gate.resolve();
  await tick;

  assert.equal(polled, 1, 'the poll must actually have run, or this proves nothing');
  assert.equal(
    events.filter(([name]) => name === 'FreeKioskTerminalUpdated').length,
    0,
    'a retired poll must not push state for a terminal that is no longer running'
  );
});

test('restarting the loop leaves only one live timer chain', async () => {
  // Without the generation counter, a StartLoop landing while a poll is awaiting
  // the network leaves two chains: the timer StartLoop armed, plus the one the
  // in-flight poll re-arms from its finally block. Both then poll forever.
  const gate = deferred();
  let polls = 0;
  const events = [];
  const Terminal = loadTerminal({
    events,
    getStatus: async () => {
      polls += 1;
      await gate.promise;
      return [null, { Status: {}, LatencyMs: 5 }];
    },
  });
  const terminal = new Terminal(ROW);

  terminal.StartLoop();
  const first = terminal.Tick(); // In flight under the current generation.
  terminal.StartLoop(); // Bumps the generation; the in-flight tick is now stale.
  const armed = terminal._timer;

  gate.resolve();
  await first; // The stale tick lands and runs its finally block.

  try {
    assert.equal(polls, 1, 'exactly one poll should have been issued');
    // The live chain's timer must be untouched. If the retired tick re-armed,
    // _timer would now be ITS handle and two chains would be polling forever.
    assert.equal(terminal._timer, armed, 'a retired tick must not re-arm a second chain');
  } finally {
    terminal.StopLoop();
  }
});

test('a device slower than the interval does not stack up requests', async () => {
  const gate = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  const events = [];
  const Terminal = loadTerminal({
    events,
    getStatus: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight -= 1;
      return [null, { Status: {}, LatencyMs: 5 }];
    },
  });
  const terminal = new Terminal({ ...ROW, Interval: 5000 });
  terminal._stopped = false;

  const first = terminal.Tick();
  // A second tick arriving while the first is still awaiting the device must
  // re-arm and bail, not issue a parallel request.
  await terminal.Tick();
  assert.equal(maxInFlight, 1);

  gate.resolve();
  await first;
  terminal.StopLoop();
});

test('stopping the loop clears its pending timer', async () => {
  const events = [];
  const Terminal = loadTerminal({ events, getStatus: okStatus() });
  const terminal = new Terminal(ROW);
  terminal.StartLoop();
  assert.ok(terminal._timer, 'StartLoop arms a timer');
  terminal.StopLoop();
  assert.equal(terminal._timer, null);
});

// ---- Reading a poll -------------------------------------------------------

test('a successful poll fills in readings, latency and the success timestamp', async () => {
  const events = [];
  const Terminal = loadTerminal({
    events,
    getStatus: okStatus({ battery: { level: 42 }, screen: { on: true } }),
  });
  const terminal = new Terminal(ROW);
  assert.equal(await terminal.Run(), true);
  assert.equal(terminal.Online, true);
  assert.equal(terminal.Metrics.battery_level, 42);
  assert.equal(terminal.LastLatencyMs, 12);
  assert.equal(terminal.LastError, null);
  assert.ok(terminal.LastSuccessAt > 0);
  // Poll latency is a metric in its own right, supplied by ShowTrak rather than
  // read from the device.
  assert.equal(terminal.Metrics.poll_latencyMs, 12);
});

test('a failed poll goes offline and records why', async () => {
  const events = [];
  const Terminal = loadTerminal({
    events,
    getStatus: async () => ['Connection refused', null],
  });
  const terminal = new Terminal(ROW);
  assert.equal(await terminal.Run(), false);
  assert.equal(terminal.Online, false);
  assert.equal(terminal.Degraded, false);
  assert.equal(terminal.LastError, 'Connection refused');
  assert.equal(terminal.LastLatencyMs, null);
  assert.equal(terminal.LastSuccessAt, null);
});

test('an outage resets the edge comparison so it cannot fire on stale data', async () => {
  // "Uptime went backwards" must mean the device rebooted, not that ShowTrak
  // compared a fresh reading against one from before an outage of unknown length.
  const events = [];
  let uptime = 90000;
  let fail = false;
  const Terminal = loadTerminal({
    events,
    getStatus: async () =>
      fail ? ['down', null] : [null, { Status: { device: { uptime } }, LatencyMs: 1 }],
  });
  const terminal = new Terminal({
    ...ROW,
    Settings: JSON.stringify({ A_device_uptime_On: true, A_device_uptime_Op: 'decreases' }),
  });

  await terminal.Run();
  assert.equal(terminal.Degraded, false);

  fail = true;
  await terminal.Run();

  fail = false;
  uptime = 30; // Looks like a reboot, but there is nothing trustworthy to compare to.
  await terminal.Run();
  assert.equal(terminal.Degraded, false, 'no alarm without a comparable previous poll');

  uptime = 10; // Now there is a real, uninterrupted decrease.
  await terminal.Run();
  assert.equal(terminal.Degraded, true);
});

test('changing the interval restarts a running loop but not a stopped one', async () => {
  const events = [];
  const Terminal = loadTerminal({ events, getStatus: okStatus() });
  const terminal = new Terminal(ROW);

  terminal.SetInterval(60000);
  assert.equal(terminal.Interval, 60000);
  assert.equal(terminal._timer, null, 'a stopped terminal must not start polling on an edit');

  terminal.StartLoop();
  terminal.SetInterval(45000);
  assert.equal(terminal.Interval, 45000);
  assert.ok(terminal._timer);
  terminal.StopLoop();
});

test('an out-of-range interval is clamped rather than accepted', () => {
  const events = [];
  const Terminal = loadTerminal({ events, getStatus: okStatus() });
  const terminal = new Terminal(ROW);
  terminal.SetInterval(1);
  assert.equal(terminal.Interval, 5000);
  terminal.SetInterval(10 ** 9);
  assert.equal(terminal.Interval, 300000);
});

test('an on-demand poll pushes the result straight away', async () => {
  const events = [];
  const Terminal = loadTerminal({ events, getStatus: okStatus({ battery: { level: 10 } }) });
  const terminal = new Terminal(ROW);
  terminal.StartLoop();
  try {
    events.length = 0;
    assert.equal(await terminal.RunNow(), true);
    const pushed = events.filter(([name]) => name === 'FreeKioskTerminalUpdated');
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0][1].Metrics.battery_level, 10);
  } finally {
    terminal.StopLoop();
  }
});
