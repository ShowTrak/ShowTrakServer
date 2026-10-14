const test = require('node:test');
const assert = require('node:assert/strict');

// Covers the touch long-press state machine in src/UI/js/app/lib/long-press.ts,
// which is the only way to open the context menu on iPadOS (WebKit never fires
// `contextmenu` from a touch). The DOM wiring in wire-context-menu.ts is a thin
// adapter over this and is not covered here.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  LongPressTracker,
  LONG_PRESS_MS,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  NATIVE_CONTEXTMENU_SUPPRESS_MS,
  CLICK_SWALLOW_MS,
} = require('../dist-test/UI/js/app/lib/long-press.js');

// Manual clock: timers only run when advance() passes their due time.
function makeClock() {
  let now = 1000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.due <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function setup() {
  const clock = makeClock();
  const fired = [];
  const tracker = new LongPressTracker((x, y) => fired.push([x, y]), clock);
  return { clock, fired, tracker };
}

const touch = (x, y, pointerId = 1) => ({
  pointerId,
  pointerType: 'touch',
  clientX: x,
  clientY: y,
});

test('a held touch fires once at the hold threshold, at the finger position', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown(touch(100, 200));
  clock.advance(LONG_PRESS_MS - 1);
  assert.deepEqual(fired, []);
  clock.advance(1);
  assert.deepEqual(fired, [[100, 200]]);
  clock.advance(LONG_PRESS_MS * 3);
  assert.equal(fired.length, 1);
});

test('pen presses count; mouse presses are left to the native contextmenu', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown({ pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 });
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, []);
  tracker.PointerDown({ pointerId: 2, pointerType: 'pen', clientX: 5, clientY: 6 });
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, [[5, 6]]);
});

test('lifting before the threshold is a tap: nothing fires, no click swallowed', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown(touch(10, 10));
  clock.advance(LONG_PRESS_MS - 50);
  tracker.PointerUp({ pointerId: 1 });
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, []);
  assert.equal(tracker.ShouldSwallowClick(), false);
  assert.equal(clock.pending(), 0);
});

test('small drift is tolerated; moving past the tolerance (a scroll) cancels', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown(touch(0, 0));
  tracker.PointerMove(touch(LONG_PRESS_MOVE_TOLERANCE_PX - 1, 0));
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, [[LONG_PRESS_MOVE_TOLERANCE_PX - 1, 0]]);

  const b = setup();
  b.tracker.PointerDown(touch(0, 0));
  b.tracker.PointerMove(touch(LONG_PRESS_MOVE_TOLERANCE_PX, LONG_PRESS_MOVE_TOLERANCE_PX));
  b.clock.advance(LONG_PRESS_MS);
  assert.deepEqual(b.fired, []);
});

test('pointercancel / dragstart (Cancel) abandons the press', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown(touch(0, 0));
  tracker.Cancel();
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, []);
});

test('a second finger (pinch) abandons the press instead of starting another', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown(touch(0, 0, 1));
  tracker.PointerDown(touch(50, 50, 2));
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, []);
});

test('moves from another pointer are ignored', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown(touch(0, 0, 1));
  tracker.PointerMove(touch(500, 500, 2));
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, [[0, 0]]);
});

test('the lift-click after a fired long-press is swallowed exactly once', () => {
  const { clock, tracker } = setup();
  tracker.PointerDown(touch(0, 0));
  clock.advance(LONG_PRESS_MS + 300);
  tracker.PointerUp({ pointerId: 1 });
  assert.equal(tracker.ShouldSwallowClick(), true);
  assert.equal(tracker.ShouldSwallowClick(), false);
});

test('if no lift-click arrives, a later genuine tap is not eaten', () => {
  const { clock, tracker } = setup();
  tracker.PointerDown(touch(0, 0));
  clock.advance(LONG_PRESS_MS);
  tracker.PointerUp({ pointerId: 1 });
  clock.advance(CLICK_SWALLOW_MS);
  assert.equal(tracker.ShouldSwallowClick(), false);
});

test('a cancelled fired press (browser took over) does not arm click swallowing', () => {
  const { clock, tracker } = setup();
  tracker.PointerDown(touch(0, 0));
  clock.advance(LONG_PRESS_MS);
  tracker.Cancel();
  tracker.PointerUp({ pointerId: 1 });
  assert.equal(tracker.ShouldSwallowClick(), false);
});

test('Android: a native contextmenu after our long-press is dropped', () => {
  const { clock, tracker } = setup();
  tracker.PointerDown(touch(0, 0));
  clock.advance(LONG_PRESS_MS);
  clock.advance(100);
  assert.equal(tracker.OnNativeContextMenu(), true);
  clock.advance(NATIVE_CONTEXTMENU_SUPPRESS_MS);
  assert.equal(tracker.OnNativeContextMenu(), false);
});

test('Android: a native contextmenu before our threshold wins and cancels ours', () => {
  const { clock, fired, tracker } = setup();
  tracker.PointerDown(touch(0, 0));
  clock.advance(LONG_PRESS_MS - 100);
  assert.equal(tracker.OnNativeContextMenu(), false);
  clock.advance(LONG_PRESS_MS);
  assert.deepEqual(fired, []);
  tracker.PointerUp({ pointerId: 1 });
  assert.equal(tracker.ShouldSwallowClick(), false);
});

test('a desktop right-click with no touch history is never suppressed', () => {
  const { tracker } = setup();
  assert.equal(tracker.OnNativeContextMenu(), false);
});
