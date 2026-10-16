const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib');
const { PlaceMenu, ResolveMenuAnchor } = require(path.join(LIB, 'menu-placement.js'));
const { FindTypeaheadMatch, NextTypeaheadBuffer, TYPEAHEAD_PAUSE_MS } = require(
  path.join(LIB, 'menu-typeahead.js')
);

// The context menu's placement and type-to-search rules, which used to run only
// inside the open handler with a live DOM.

const BOUNDS = { MinX: 8, MaxX: 992, MinY: 48, MaxY: 792 };
const SIZE = { Width: 200, Height: 300 };

test('the menu opens down and to the right of the anchor when there is room', () => {
  assert.deepEqual(PlaceMenu({ X: 100, Y: 100 }, SIZE, BOUNDS), { Left: 100, Top: 100 });
});

test('the menu flips left and up on an axis where it would overflow', () => {
  assert.deepEqual(PlaceMenu({ X: 900, Y: 700 }, SIZE, BOUNDS), { Left: 700, Top: 400 });
});

test('the menu is clamped inside the bounds, flush to the top-left when it is larger', () => {
  // Too tall to fit either above or below the anchor: pinned to the top edge.
  assert.deepEqual(PlaceMenu({ X: 0, Y: 600 }, { Width: 200, Height: 700 }, BOUNDS), {
    Left: 8,
    Top: 48,
  });
  assert.deepEqual(PlaceMenu({ X: 500, Y: 500 }, { Width: 2000, Height: 2000 }, BOUNDS), {
    Left: 8,
    Top: 48,
  });
});

test('the anchor prefers client coordinates, then page coordinates less scroll, then the centre', () => {
  const Scroll = { X: 10, Y: 20 };
  const Viewport = { Width: 1000, Height: 800 };
  assert.deepEqual(
    ResolveMenuAnchor({ clientX: 5, clientY: 6, pageX: 99, pageY: 99 }, Scroll, Viewport),
    {
      X: 5,
      Y: 6,
    }
  );
  assert.deepEqual(ResolveMenuAnchor({ pageX: 110, pageY: 220 }, Scroll, Viewport), {
    X: 100,
    Y: 200,
  });
  assert.deepEqual(ResolveMenuAnchor({}, Scroll, Viewport), { X: 500, Y: 400 });
});

test('typed letters extend the search, and a pause starts a new one', () => {
  assert.equal(NextTypeaheadBuffer('', 0, 'W', 10_000), 'w');
  assert.equal(NextTypeaheadBuffer('w', 10_000, 'a', 10_100), 'wa');
  assert.equal(NextTypeaheadBuffer('wa', 10_000, 'k', 10_000 + TYPEAHEAD_PAUSE_MS + 1), 'k');
});

test('repeating one letter cycles through the items starting with it', () => {
  assert.equal(NextTypeaheadBuffer('s', 10_000, 's', 10_100), 's');
  const Titles = ['select all', 'shutdown', 'wake on lan', 'stop'];
  assert.equal(FindTypeaheadMatch(Titles, 's', 0), 1);
  assert.equal(FindTypeaheadMatch(Titles, 's', 1), 3);
  assert.equal(FindTypeaheadMatch(Titles, 's', 3), 0, 'wraps past the end');
});

test('a prefix match wins over a substring match, and no match is -1', () => {
  const Titles = ['clear selection', 'select all'];
  assert.equal(FindTypeaheadMatch(Titles, 'sel', -1), 1);
  assert.equal(FindTypeaheadMatch(Titles, 'ection', -1), 0);
  assert.equal(FindTypeaheadMatch(Titles, 'zzz', -1), -1);
  assert.equal(FindTypeaheadMatch([], 'a', -1), -1);
});
