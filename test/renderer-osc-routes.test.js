const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { installJQuery, installHowl } = require('./helpers/renderer-stubs');

// Exercises the OSC/HTTP route reference in src/UI/js/app/osc-feeds.ts.
//
// This modal is the documentation an integrator reads before wiring a lighting
// desk, a Companion button or a show-control cue to ShowTrak. If a route is
// mis-rendered or filed under the wrong heading, someone builds a cue against
// an address that does not exist — and finds out during a show.
//
// The path formatter is also a security boundary in miniature: route paths are
// rendered as HTML, and the parameter placeholders are the only part that is
// meant to be markup.

installHowl();
installJQuery();

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const Osc = require(path.join(APP, 'osc-feeds.js'));

const {
  FormatDebugTime,
  normalizeMethods,
  formatRoutePath,
  normalizeRouteForOrdering,
  getLogicalRouteOrder,
  getRouteSectionIndex,
  getRouteSectionTitle,
  ROUTE_DISPLAY_ORDER,
  ROUTE_SECTIONS,
} = Osc;

// --- HTTP methods -----------------------------------------------------------

test('methods are upper-cased and split from either shape', () => {
  // Routes arrive as an array from the server and occasionally as a
  // comma-separated string from older definitions.
  assert.deepEqual(normalizeMethods(['get', 'post']), ['GET', 'POST']);
  assert.deepEqual(normalizeMethods('get,post'), ['GET', 'POST']);
  assert.deepEqual(normalizeMethods(' get , post '), ['GET', 'POST']);
});

test('empty method entries are dropped', () => {
  // A blank chip in the reference reads as an unnamed method an integrator
  // might try to use.
  assert.deepEqual(normalizeMethods(['get', '', '  ']), ['GET']);
  assert.deepEqual(normalizeMethods('get,,post,'), ['GET', 'POST']);
});

test('an absent method list yields an empty list', () => {
  for (const Value of [undefined, null, [], '', {}, 42]) {
    assert.deepEqual(normalizeMethods(Value), [], `value ${JSON.stringify(Value)}`);
  }
});

// --- Path rendering ---------------------------------------------------------

test('a route path renders segment by segment', () => {
  const Html = formatRoutePath('/Clients');
  assert.match(Html, /<span>\/<\/span>/);
  assert.match(Html, /<span>Clients<\/span>/);
});

test('a parameter segment is highlighted and bracketed', () => {
  // The integrator has to be able to tell "the literal word Slug" from "put
  // your slug here"; they are otherwise indistinguishable in a URL.
  const Html = formatRoutePath('/Client/:Slug/WakeOnLAN');
  assert.match(Html, /text-info">\[Slug\]/);
  assert.match(Html, /<span>WakeOnLAN<\/span>/);
  assert.doesNotMatch(Html, /:Slug/);
});

test('the root path still renders as a slash', () => {
  for (const Value of ['', '/', null, undefined]) {
    assert.equal(formatRoutePath(Value), '<span>/</span>', `path ${JSON.stringify(Value)}`);
  }
});

test('empty segments from doubled slashes are skipped', () => {
  assert.equal(formatRoutePath('//Clients//'), formatRoutePath('/Clients'));
});

test('a route path is escaped before it reaches the modal', () => {
  // Paths originate server-side, but they are rendered as raw HTML here, so the
  // escaping is what keeps a crafted route definition from injecting markup.
  const Html = formatRoutePath('/Client/<img src=x onerror=alert(1)>/Run');
  assert.doesNotMatch(Html, /<img/);
  assert.match(Html, /&lt;img/);

  const Param = formatRoutePath('/Client/:<script>alert(1)</script>');
  assert.doesNotMatch(Param, /<script>/);
});

// --- Ordering ---------------------------------------------------------------

test('the API and ShowTrak prefixes are stripped for ordering', () => {
  // The same logical route is exposed under more than one prefix; they must sort
  // together rather than forming duplicate sections.
  assert.equal(normalizeRouteForOrdering('/ShowTrak/Clients'), '/Clients');
  assert.equal(normalizeRouteForOrdering('/API/Clients'), '/Clients');
  assert.equal(normalizeRouteForOrdering('/api/clients'), '/clients');
  assert.equal(normalizeRouteForOrdering('/Clients'), '/Clients');
});

test('stripping a prefix always leaves a rooted path', () => {
  assert.equal(normalizeRouteForOrdering('/ShowTrak'), '/');
  assert.equal(normalizeRouteForOrdering('Clients'), '/Clients');
  assert.equal(normalizeRouteForOrdering(''), '/');
  assert.equal(normalizeRouteForOrdering(null), '/');
});

test('a prefix is only stripped at a segment boundary', () => {
  // '/APIs/...' is a different route and must not lose its first segment.
  assert.equal(normalizeRouteForOrdering('/APIs/Thing'), '/APIs/Thing');
  assert.equal(normalizeRouteForOrdering('/ShowTrakServer/Thing'), '/ShowTrakServer/Thing');
});

test('the curated routes keep their hand-picked order', () => {
  // The reference is ordered by what an integrator reaches for first, not
  // alphabetically.
  for (let i = 1; i < ROUTE_DISPLAY_ORDER.length; i++) {
    assert.ok(
      getLogicalRouteOrder(ROUTE_DISPLAY_ORDER[i]) >
        getLogicalRouteOrder(ROUTE_DISPLAY_ORDER[i - 1]),
      `${ROUTE_DISPLAY_ORDER[i]} does not sort after ${ROUTE_DISPLAY_ORDER[i - 1]}`
    );
  }
});

test('a curated route sorts ahead of any uncurated one', () => {
  // Explicit indices are small; section bases start at 0*100 and unknowns at
  // 9000, so a curated route always wins.
  const LastCurated = getLogicalRouteOrder(ROUTE_DISPLAY_ORDER[ROUTE_DISPLAY_ORDER.length - 1]);
  assert.ok(getLogicalRouteOrder('/Something/New') > LastCurated);
});

test('an uncurated route sorts by its section', () => {
  assert.ok(getLogicalRouteOrder('/Client/Other') < getLogicalRouteOrder('/Group/Other'));
  assert.ok(getLogicalRouteOrder('/Group/Other') < getLogicalRouteOrder('/All/Other'));
});

test('a route in no known section sorts last rather than at the top', () => {
  // Falling to 0 would put unrecognised routes above the curated ones, which is
  // exactly the wrong end of a reference document.
  const Unknown = getLogicalRouteOrder('/Totally/Unknown');
  assert.ok(Unknown >= 9000);
  assert.ok(Unknown > getLogicalRouteOrder('/All/Other'));
});

test('ordering ignores the prefix a route is reached through', () => {
  assert.equal(getLogicalRouteOrder('/ShowTrak/Clients'), getLogicalRouteOrder('/Clients'));
  assert.equal(getLogicalRouteOrder('/API/Clients'), getLogicalRouteOrder('/Clients'));
});

// --- Sections ---------------------------------------------------------------

test('each section owns its declared segments', () => {
  for (let Index = 0; Index < ROUTE_SECTIONS.length; Index++) {
    for (const Segment of ROUTE_SECTIONS[Index].Segments) {
      assert.equal(
        getRouteSectionIndex(`/${Segment}/Anything`),
        Index,
        `/${Segment} is filed under the wrong section`
      );
    }
  }
});

test('section matching is case-insensitive and prefix-agnostic', () => {
  const Expected = getRouteSectionTitle('/Client/:Slug/WakeOnLAN');
  assert.equal(getRouteSectionTitle('/client/:slug/wakeonlan'), Expected);
  assert.equal(getRouteSectionTitle('/API/Client/:Slug/WakeOnLAN'), Expected);
  assert.equal(getRouteSectionTitle('/ShowTrak/Client/:Slug/WakeOnLAN'), Expected);
});

test('shutdown is filed under Control, not Clients', () => {
  // It is the one route that acts on the server rather than on machines, and
  // burying it among the client routes is how someone fires it by mistake.
  assert.equal(getRouteSectionTitle('/Shutdown'), 'Control');
  assert.equal(getRouteSectionTitle('/Shutdown/Force'), 'Control');
});

test('clients, monitors and dummies share one section', () => {
  const Title = getRouteSectionTitle('/Clients');
  assert.equal(getRouteSectionTitle('/Client/:Slug/WakeOnLAN'), Title);
  assert.equal(getRouteSectionTitle('/Dummy/:Slug/Heartbeat'), Title);
});

test('an unrecognised route falls into Other rather than a real section', () => {
  assert.equal(getRouteSectionIndex('/Totally/Unknown'), ROUTE_SECTIONS.length);
  assert.equal(getRouteSectionTitle('/Totally/Unknown'), 'Other');
  assert.equal(getRouteSectionTitle(''), 'Other');
  assert.equal(getRouteSectionTitle(null), 'Other');
});

test('every curated route lands in a real section', () => {
  // A curated route in "Other" means the section table and the display order
  // have drifted apart, and the reference would render it detached from the
  // group it belongs to.
  for (const Path of ROUTE_DISPLAY_ORDER) {
    assert.notEqual(getRouteSectionTitle(Path), 'Other', `${Path} has no section`);
  }
});

// --- Debug terminal ---------------------------------------------------------

test('debug timestamps are zero-padded wall-clock time', () => {
  // Read alongside a lighting desk's own log, so the format has to be stable
  // and sortable.
  const At = new Date(2026, 0, 2, 9, 5, 3).getTime();
  assert.equal(FormatDebugTime(At), '09:05:03');

  const Later = new Date(2026, 0, 2, 23, 59, 59).getTime();
  assert.equal(FormatDebugTime(Later), '23:59:59');
});

test('an unusable timestamp falls back to now rather than 1970', () => {
  // Epoch 0 would render every malformed entry as 00:00:00 (or a timezone
  // offset), which reads as a real time and is deeply confusing in a log.
  for (const Value of [null, undefined, NaN, 'nope', 0]) {
    assert.match(FormatDebugTime(Value), /^\d{2}:\d{2}:\d{2}$/, `value ${String(Value)}`);
  }
});
