const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises src/Modules/MonitoringMethods/_probe-limiter.ts and the start
// stagger on MonitoringTarget. Monitors used to all start together and probe in
// one burst per interval with no cap on how many ran at once; these pin the cap,
// its ordering, and that it can never wedge monitoring.

const { ProbeLimiter } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', '_probe-limiter.js')
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

test('no more than the global limit run at once, and waiters run in arrival order', async () => {
  const Limiter = new ProbeLimiter(2);
  const Gates = [deferred(), deferred(), deferred(), deferred()];
  const Started = [];
  const Runs = Gates.map((G, I) =>
    Limiter.Run('tcp-port', async () => {
      Started.push(I);
      return G.promise;
    })
  );
  await tick();
  assert.deepEqual(Started, [0, 1]);

  Gates[1].resolve('b');
  await tick();
  assert.deepEqual(Started, [0, 1, 2]);
  Gates[0].resolve('a');
  await tick();
  assert.deepEqual(Started, [0, 1, 2, 3]);
  Gates[2].resolve('c');
  Gates[3].resolve('d');
  assert.deepEqual(await Promise.all(Runs), ['a', 'b', 'c', 'd']);
  assert.deepEqual(Limiter.Stats(), { InUse: 0, Queued: 0 });
});

test('a method with its own cap is held to it without blocking other methods', async () => {
  const Limiter = new ProbeLimiter(10, { ping: 1 });
  const PingGate = deferred();
  const Started = [];
  const P1 = Limiter.Run('ping', async () => {
    Started.push('ping1');
    return PingGate.promise;
  });
  const P2 = Limiter.Run('ping', async () => Started.push('ping2'));
  const H = Limiter.Run('http', async () => Started.push('http'));
  await tick();
  assert.deepEqual([...Started].sort(), ['http', 'ping1']);
  // The queued ping holds no global slot while it waits.
  assert.equal(Limiter.Stats().InUse, 1);
  PingGate.resolve();
  await Promise.all([P1, P2, H]);
  assert.equal(Started[2], 'ping2', 'the second ping only ran once the first finished');
});

test('a probe that throws (sync or async) gives its slot back', async () => {
  const Limiter = new ProbeLimiter(1);
  await assert.rejects(
    Limiter.Run('x', () => {
      throw new Error('sync boom');
    }),
    /sync boom/
  );
  await assert.rejects(
    Limiter.Run('x', async () => {
      throw new Error('async boom');
    }),
    /async boom/
  );
  assert.equal(await Limiter.Run('x', async () => 'ok'), 'ok');
  assert.deepEqual(Limiter.Stats(), { InUse: 0, Queued: 0 });
});

test('a probe that never settles releases its slot after the hold deadline', async () => {
  const Limiter = new ProbeLimiter(1, {}, 20);
  const Hung = Limiter.Run('x', () => new Promise(() => {}));
  void Hung;
  const Started = Date.now();
  assert.equal(await Limiter.Run('x', async () => 'next'), 'next');
  assert.ok(Date.now() - Started >= 15, 'waited for the hold deadline');
});

test('a slot freed by the deadline is not freed twice when the probe finally settles', async () => {
  const Limiter = new ProbeLimiter(1, {}, 20);
  const Late = deferred();
  const First = Limiter.Run('x', () => Late.promise);
  await new Promise((r) => setTimeout(r, 40));
  // The deadline has handed the slot back; take it and keep it.
  const Holder = deferred();
  const Second = Limiter.Run('x', () => Holder.promise);
  await tick();
  Late.resolve('late');
  assert.equal(await First, 'late');
  // Had the late settle released again, this third probe would start now.
  let ThirdStarted = false;
  const Third = Limiter.Run('x', async () => {
    ThirdStarted = true;
  });
  await tick();
  assert.equal(ThirdStarted, false);
  Holder.resolve();
  await Promise.all([Second, Third]);
  assert.equal(ThirdStarted, true);
});

// --- Start stagger -----------------------------------------------------------

function loadTarget() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringTargetManager', 'target.js'),
    {
      '../Logger': { CreateLogger: () => ({ error: () => {} }) },
      '../DB': { Manager: {} },
      '../DB/repositories/monitoring-checks': {
        CreateMonitoringChecksRepository: () => ({ SetLastSuccessAt: async () => [null] }),
      },
      '../Broadcast': { Manager: { emit: () => {} } },
      '../MonitoringMethods': { Manager: {} },
    }
  ).MonitoringTarget;
}

const makeTarget = (MonitoringTarget, TargetID, Interval = 30000) =>
  new MonitoringTarget({ TargetID, Interval, Timestamp: 0 }, []);

test('start offsets are stable, inside the window and spread across it', () => {
  const MonitoringTarget = loadTarget();
  const Offsets = [];
  for (let Id = 1; Id <= 200; Id++) {
    const T = makeTarget(MonitoringTarget, Id);
    const Offset = T.StartOffsetMs();
    assert.equal(Offset, makeTarget(MonitoringTarget, Id).StartOffsetMs(), 'stable per id');
    assert.ok(Offset >= 0 && Offset < 10000, `offset ${Offset} inside the window`);
    Offsets.push(Offset);
  }
  // Spread: every one-second bucket of the window gets some monitors.
  const Buckets = new Set(Offsets.map((O) => Math.floor(O / 1000)));
  assert.equal(Buckets.size, 10);
});

test('the start offset never exceeds a short interval', () => {
  const MonitoringTarget = loadTarget();
  for (let Id = 1; Id <= 50; Id++) {
    assert.ok(makeTarget(MonitoringTarget, Id, 3000).StartOffsetMs() < 3000);
  }
});

test('StartLoop only staggers when asked to', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const MonitoringTarget = loadTarget();
  const T = makeTarget(MonitoringTarget, 7);
  let Ticks = 0;
  T.Tick = () => {
    Ticks++;
  };

  T.StartLoop();
  t.mock.timers.tick(1500);
  assert.equal(Ticks, 1, 'an edited monitor checks straight away');

  T.StartLoop({ Spread: true });
  t.mock.timers.tick(1500 + T.StartOffsetMs() - 1);
  assert.equal(Ticks, 1);
  t.mock.timers.tick(1);
  assert.equal(Ticks, 2);
  T.StopLoop();
});
