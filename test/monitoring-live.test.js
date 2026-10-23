const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// The live levels hub (src/main/monitoring-live.ts): streams run only while a
// viewer watches their monitor, restart when a check's settings change, and
// stop when the last viewer leaves.

function load() {
  const broadcast = new EventEmitter();
  // TargetID → checks with live levels on.
  const targets = new Map();
  // Checks drawn as a 'levels' tile widget.
  const tiles = [];
  const started = [];
  const events = [];
  const hub = loadWithMocks(path.join(__dirname, '..', 'dist', 'main', 'monitoring-live.js'), {
    '../Modules/Broadcast': { Manager: broadcast },
    '../Modules/MonitoringTargetManager': {
      Manager: {
        GetLiveLevelChecks: (id) => targets.get(Number(id)) || [],
        GetTileLevelChecks: () => tiles,
      },
    },
    '../Modules/MonitoringMethods': {
      stableStringify: (v) => JSON.stringify(v),
      Manager: {
        StartLiveLevels: (method, check, onFrame) => {
          const stream = { method, check, onFrame, stopped: false };
          started.push(stream);
          events.push(`start ${started.length - 1}`);
          const index = started.length - 1;
          return () => {
            stream.stopped = true;
            events.push(`stop ${index}`);
          };
        },
      },
    },
  });
  return { hub, broadcast, targets, tiles, started, events };
}

function check(id, settings = { ReadLevels: true }) {
  return {
    CheckID: id,
    Name: `Check ${id}`,
    Method: 'tascam-mx8a',
    Check: { Address: '10.0.0.5', Settings: settings },
  };
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('opening starts each live check once, frames are batched to the viewer, closing stops', async () => {
  const { hub, broadcast, targets, started } = load();
  targets.set(1, [check(11), check(12)]);
  const got = [];
  const first = hub.OpenMonitorLiveLevels('desktop:1', 1, (s) => got.push(s));
  assert.deepEqual(
    first.Checks.map((c) => [c.CheckID, c.State]),
    [
      [11, 'connecting'],
      [12, 'connecting'],
    ]
  );
  assert.equal(started.length, 2);

  // A second viewer of the same monitor shares the streams.
  hub.OpenMonitorLiveLevels('web:a', 1, () => undefined);
  assert.equal(started.length, 2);

  started[0].onFrame({
    State: 'live',
    Message: null,
    Channels: [{ ID: 'in:1', Group: 'Inputs', Label: 'Input 1', Db: -6, View: true }],
  });
  started[0].onFrame({
    State: 'live',
    Message: null,
    Channels: [
      { ID: 'in:1', Group: 'Inputs', Label: 'Input 1', Db: -3, View: true },
      // Tile-only: never in the view's snapshot.
      { ID: 'mix:1', Group: 'Mixes', Label: 'Mix 1', Db: -9, Tile: true },
    ],
  });
  await tick();
  const last = got[got.length - 1];
  assert.equal(last.TargetID, 1);
  assert.deepEqual(last.Checks[0], {
    CheckID: 11,
    Name: 'Check 11',
    State: 'live',
    Message: null,
    Channels: [{ ID: 'in:1', Group: 'Inputs', Label: 'Input 1', Db: -3, View: true }],
  });
  // Both frames landed inside one flush.
  assert.equal(got.length, 1);
  assert.equal(broadcast.listenerCount('MonitoringTargetUpdated'), 1);

  hub.CloseMonitorLiveLevels('desktop:1');
  assert.equal(started[0].stopped, false);
  hub.CloseMonitorLiveLevels('web:a');
  assert.ok(started.every((s) => s.stopped));
  assert.equal(broadcast.listenerCount('MonitoringTargetUpdated'), 0);
  hub.CloseMonitorLiveLevels('nobody');
});

test('a settings change or the toggle going off is picked up from the target push', async () => {
  const { hub, broadcast, targets, started, events } = load();
  targets.set(1, [check(11)]);
  const got = [];
  hub.OpenMonitorLiveLevels('desktop:1', 1, (s) => got.push(s));
  assert.equal(started.length, 1);

  targets.set(1, [check(11, { ReadLevels: true, Password: 'new' })]);
  broadcast.emit('MonitoringTargetUpdated', {});
  assert.equal(started[0].stopped, true);
  assert.equal(started.length, 2);
  // The successor starts first, so it can take over the device connection.
  assert.deepEqual(events, ['start 0', 'start 1', 'stop 0']);

  targets.set(1, []);
  broadcast.emit('MonitoringTargetUpdated', {});
  assert.equal(started[1].stopped, true);
  await tick();
  assert.deepEqual(got[got.length - 1], { TargetID: 1, Checks: [] });
  hub.CloseMonitorLiveLevels('desktop:1');
});

test('switching monitors moves the viewer; a dead viewer is dropped', async () => {
  const { hub, targets, started } = load();
  targets.set(1, [check(11)]);
  targets.set(2, [check(21)]);
  hub.OpenMonitorLiveLevels('desktop:1', 1, () => {
    throw new Error('window gone');
  });
  hub.OpenMonitorLiveLevels('desktop:2', 2, () => undefined);
  hub.OpenMonitorLiveLevels('desktop:2', 1, () => undefined);
  assert.equal(started.find((s) => s.check === targets.get(2)[0].Check).stopped, true);

  started[0].onFrame({ State: 'live', Message: null, Channels: [] });
  await tick();
  // desktop:1 threw and was dropped; desktop:2 still watches monitor 1.
  assert.equal(started[0].stopped, false);
  hub.CloseMonitorLiveLevels('desktop:2');
  assert.equal(started[0].stopped, true);
});

test('a bad target id watches nothing', () => {
  const { hub, started } = load();
  assert.deepEqual(hub.OpenMonitorLiveLevels('desktop:1', 'x', () => undefined).Checks, []);
  assert.equal(started.length, 0);
});

// --- Tiles ------------------------------------------------------------------

const tick2 = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test('a dashboard gets only the tile channels of every levels tile', async () => {
  const { hub, broadcast, tiles, started } = load();
  tiles.push({ TargetID: 5, ...check(51) });
  const got = [];
  const first = hub.OpenMonitorTileLevels('desktop:1', (s) => got.push(s));
  assert.deepEqual(first, {
    Tiles: [{ TargetID: 5, CheckID: 51, State: 'connecting', Message: null, Channels: [] }],
  });
  assert.equal(started.length, 1);
  started[0].onFrame({
    State: 'live',
    Message: null,
    Channels: [
      { Group: 'Inputs', Label: 'Mic', Db: -20 },
      { Group: 'Outputs', Label: 'Main L', Db: -6, Tile: true },
    ],
  });
  await tick2();
  assert.deepEqual(got[got.length - 1].Tiles[0].Channels, [{ Label: 'Main L', Db: -6 }]);

  // A second dashboard shares the stream; the last one closing stops it.
  hub.OpenMonitorTileLevels('web:x', () => undefined);
  assert.equal(started.length, 1);
  hub.CloseMonitorTileLevels('desktop:1');
  assert.equal(started[0].stopped, false);
  hub.CloseMonitorTileLevels('web:x');
  assert.equal(started[0].stopped, true);
  assert.equal(broadcast.listenerCount('MonitoringTargetUpdated'), 0);
});

test('one stream serves a monitor view and its tile; each sees only its own', async () => {
  const { hub, targets, tiles, started } = load();
  targets.set(5, [check(51)]);
  tiles.push({ TargetID: 5, ...check(51) });
  const view = [];
  const dash = [];
  hub.OpenMonitorTileLevels('desktop:1', (s) => dash.push(s));
  hub.OpenMonitorLiveLevels('desktop:1', 5, (s) => view.push(s));
  assert.equal(started.length, 1);

  // A tile-only check (its view toggles off) is not in the view's snapshot.
  targets.set(5, []);
  hub.OpenMonitorLiveLevels('desktop:1', 5, (s) => view.push(s));
  assert.equal(started[0].stopped, false);
  await tick2();
  assert.deepEqual(view[view.length - 1], { TargetID: 5, Checks: [] });

  // Its tile toggle going off too ends the stream.
  tiles.length = 0;
  hub.OpenMonitorLiveLevels('desktop:1', 5, (s) => view.push(s));
  assert.equal(started[0].stopped, true);
  await tick2();
  assert.deepEqual(dash[dash.length - 1], { Tiles: [] });
  hub.CloseMonitorLiveLevels('desktop:1');
  hub.CloseMonitorTileLevels('desktop:1');
});
