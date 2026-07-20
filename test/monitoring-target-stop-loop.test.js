const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const modulePath = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'MonitoringTargetManager',
  'target.js'
);

// A check run we can hold open, so a Tick can be caught mid-flight the way a
// real network probe would be when the user deletes its target.
function createDeferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function loadTarget({ onEmit, runImpl, onError }) {
  return loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({
        error: (...args) => {
          if (onError) onError(...args);
        },
      }),
    },
    '../DB': { Manager: { Run: async () => [null, { changes: 1 }] } },
    '../DB/repositories/monitoring-checks': {
      CreateMonitoringChecksRepository: () => ({
        SetLastSuccessAt: async () => [null, { changes: 1 }],
      }),
    },
    '../Broadcast': { Manager: { emit: (...args) => onEmit(...args) } },
    '../MonitoringMethods': {
      Manager: {
        Run: runImpl || (async () => ({ Success: true, LatencyMs: 10 })),
        BuildDebug: () => '<div>debug</div>',
      },
    },
  }).MonitoringTarget;
}

function buildTarget(MonitoringTarget) {
  return new MonitoringTarget(
    {
      TargetID: 1,
      Nickname: 'Test Target',
      Interval: 30000,
      GroupID: null,
      Weight: 100,
      Timestamp: 1700000000000,
    },
    [
      {
        CheckID: 11,
        TargetID: 1,
        Name: 'HTTP Health',
        Address: 'a.local',
        Method: 'http',
        Settings: '{}',
        DegradedThresholdMs: 1000,
        Weight: 100,
        LastSuccessAt: null,
      },
    ]
  );
}

test('A Tick already in flight when StopLoop lands does not broadcast or re-arm', async () => {
  const emitted = [];
  const errors = [];
  const gate = createDeferred();
  const MonitoringTarget = loadTarget({
    onEmit: (event, payload) => emitted.push({ event, payload }),
    onError: (...args) => errors.push(args.join(' ')),
    runImpl: () => gate.promise.then(() => ({ Success: true, LatencyMs: 10 })),
  });

  const target = buildTarget(MonitoringTarget);
  const tick = target.Tick();

  // The tick is now parked on the check's network call, exactly where a delete
  // would catch it. StopLoop cannot cancel it — it can only mark it doomed.
  target.StopLoop();
  gate.resolve();
  await tick;

  // Tick swallows check failures into the logger, so an incomplete mock would
  // otherwise look identical to a correctly suppressed broadcast.
  assert.deepEqual(errors, [], 'the tick must run cleanly for this assertion to mean anything');
  assert.equal(
    emitted.length,
    0,
    'a stopped target must not broadcast MonitoringTargetUpdated — that is what resurrects a deleted tile in the UI'
  );
  assert.equal(target._timer, null, 'a stopped target must not re-arm its poll timer');
});

test('Tick is a no-op once the target is stopped', async () => {
  const emitted = [];
  const errors = [];
  const MonitoringTarget = loadTarget({
    onEmit: (event) => emitted.push(event),
    onError: (...args) => errors.push(args.join(' ')),
  });

  const target = buildTarget(MonitoringTarget);
  target.StopLoop();
  await target.Tick();

  assert.deepEqual(errors, []);
  assert.equal(emitted.length, 0);
  assert.equal(target._timer, null);
});

test('A live Tick still broadcasts and re-arms', async () => {
  const emitted = [];
  const errors = [];
  const MonitoringTarget = loadTarget({
    onEmit: (event) => emitted.push(event),
    onError: (...args) => errors.push(args.join(' ')),
  });

  const target = buildTarget(MonitoringTarget);
  await target.Tick();

  assert.deepEqual(errors, []);
  assert.deepEqual(emitted, ['MonitoringTargetUpdated']);
  assert.ok(target._timer, 'a running target must keep polling');
  target.StopLoop();
});

test('A Tick in flight when StartLoop lands retires instead of re-arming a second chain', async () => {
  const emitted = [];
  const errors = [];
  const gate = createDeferred();
  const MonitoringTarget = loadTarget({
    onEmit: (event, payload) => emitted.push({ event, payload }),
    onError: (...args) => errors.push(args.join(' ')),
    runImpl: () => gate.promise.then(() => ({ Success: true, LatencyMs: 10 })),
  });

  const target = buildTarget(MonitoringTarget);
  const tick = target.Tick();

  // This is the rename path: Update() mutates the target and calls StartLoop()
  // while the previous tick is still parked on its probe.
  target.Nickname = 'Renamed Target';
  target.StartLoop();
  const revived = target._timer;

  gate.resolve();
  await tick;

  assert.deepEqual(errors, [], 'the tick must run cleanly for this assertion to mean anything');
  assert.equal(
    emitted.length,
    0,
    'the superseded tick must not broadcast — its snapshot predates the update'
  );
  assert.equal(
    target._timer,
    revived,
    'the superseded tick must not overwrite the timer StartLoop armed — two live chains means duplicate broadcasts per interval'
  );
  target.StopLoop();
});

test('StartLoop revives a target that was previously stopped', async () => {
  const emitted = [];
  const errors = [];
  const MonitoringTarget = loadTarget({
    onEmit: (event) => emitted.push(event),
    onError: (...args) => errors.push(args.join(' ')),
  });

  const target = buildTarget(MonitoringTarget);
  target.StopLoop();
  target.StartLoop();

  assert.equal(target._stopped, false);
  await target.Tick();

  assert.deepEqual(errors, []);
  assert.deepEqual(emitted, ['MonitoringTargetUpdated']);
  assert.ok(target._timer);
  target.StopLoop();
});
