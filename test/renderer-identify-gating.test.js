const test = require('node:test');
const assert = require('node:assert/strict');

// Covers the version-gating and target-eligibility logic in
// src/UI/js/app/identify.ts — the part of the Identify flow that decides
// whether the action is offered for a given client at all. Getting this wrong
// either hides Identify from capable clients or fires it at clients too old to
// understand it.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
//
// NOT covered here: ApplyIdentifyStateLocally, StopIdentifyingForUUIDs and
// UpdateIdentifyStatusBanner. They call into the 1000-line client-list renderer
// and window.API, so they need the WP-1 DOM strategy decision first.
const {
  ParseSemverTuple,
  IsVersionAtLeast,
  GetIdentifyTargetByUUID,
  GetIdentifyingUUIDs,
  MINIMUM_IDENTIFY_VERSION,
  MINIMUM_DISPLAY_MONITORING_VERSION,
} = require('../dist-test/UI/js/app/identify.js');
const {
  setAllClients,
  setPendingAdoption,
} = require('../dist-test/UI/js/app/state/server-caches.js');

test.afterEach(() => {
  setAllClients([]);
  setPendingAdoption([]);
});

// --- ParseSemverTuple -------------------------------------------------------

test('ParseSemverTuple extracts a three-part version as numbers', () => {
  assert.deepEqual(ParseSemverTuple('3.14.0'), [3, 14, 0]);
  assert.deepEqual(ParseSemverTuple('  3.14.0  '), [3, 14, 0]);
  assert.deepEqual(ParseSemverTuple('v3.14.0'), [3, 14, 0]);
  assert.deepEqual(ParseSemverTuple('3.14.0-beta.1'), [3, 14, 0]);
  assert.deepEqual(ParseSemverTuple('ShowTrak Client 3.14.0 (build 9)'), [3, 14, 0]);
});

test('ParseSemverTuple returns null for anything without a full triple', () => {
  assert.equal(ParseSemverTuple('3.14'), null);
  assert.equal(ParseSemverTuple('not a version'), null);
  assert.equal(ParseSemverTuple(''), null);
  assert.equal(ParseSemverTuple(null), null);
  assert.equal(ParseSemverTuple(undefined), null);
});

test('ParseSemverTuple keeps multi-digit components intact', () => {
  assert.deepEqual(ParseSemverTuple('10.20.30'), [10, 20, 30]);
});

// --- IsVersionAtLeast -------------------------------------------------------

test('IsVersionAtLeast compares component-by-component, most significant first', () => {
  assert.equal(IsVersionAtLeast('3.7.0', [3, 7, 0]), true);
  assert.equal(IsVersionAtLeast('3.7.1', [3, 7, 0]), true);
  assert.equal(IsVersionAtLeast('3.8.0', [3, 7, 0]), true);
  assert.equal(IsVersionAtLeast('4.0.0', [3, 7, 0]), true);
  assert.equal(IsVersionAtLeast('3.6.9', [3, 7, 0]), false);
  assert.equal(IsVersionAtLeast('2.99.99', [3, 7, 0]), false);
});

test('IsVersionAtLeast does not compare components as strings', () => {
  // '10' < '9' lexically but 10 > 9 numerically; a string compare here would
  // lock every 3.10+ client out of Identify.
  assert.equal(IsVersionAtLeast('3.10.0', [3, 9, 0]), true);
  assert.equal(IsVersionAtLeast('3.9.0', [3, 10, 0]), false);
});

test('IsVersionAtLeast refuses an unparseable version rather than assuming capable', () => {
  // Failing closed matters: an unknown version must not be told to identify.
  assert.equal(IsVersionAtLeast('unknown', [3, 7, 0]), false);
  assert.equal(IsVersionAtLeast('', [3, 7, 0]), false);
  assert.equal(IsVersionAtLeast(null, [3, 7, 0]), false);
  assert.equal(IsVersionAtLeast(undefined, [3, 7, 0]), false);
});

test('IsVersionAtLeast handles a short minimum tuple', () => {
  assert.equal(IsVersionAtLeast('3.7.0', [3]), true);
  assert.equal(IsVersionAtLeast('2.9.9', [3]), false);
  assert.equal(IsVersionAtLeast('3.7.0', []), true);
});

test('the exported minimums are the documented feature gates', () => {
  assert.deepEqual(MINIMUM_IDENTIFY_VERSION, [3, 7, 0]);
  assert.deepEqual(MINIMUM_DISPLAY_MONITORING_VERSION, [3, 8, 0]);
  // Display monitoring landed after identify, so its gate must not be lower.
  assert.equal(IsVersionAtLeast('3.8.0', MINIMUM_IDENTIFY_VERSION), true);
  assert.equal(IsVersionAtLeast('3.7.0', MINIMUM_DISPLAY_MONITORING_VERSION), false);
});

// --- GetIdentifyTargetByUUID ------------------------------------------------

test('GetIdentifyTargetByUUID reports an adopted, online, new-enough client eligible', () => {
  setAllClients([{ UUID: 'client-1', Online: true, Version: '3.7.0', Identifying: false }]);
  assert.deepEqual(GetIdentifyTargetByUUID('client-1'), {
    UUID: 'client-1',
    Eligible: true,
    IsIdentifying: false,
  });
});

test('GetIdentifyTargetByUUID rules out an offline client', () => {
  setAllClients([{ UUID: 'client-1', Online: false, Version: '3.14.0' }]);
  assert.equal(GetIdentifyTargetByUUID('client-1').Eligible, false);
});

test('GetIdentifyTargetByUUID rules out a client below the minimum version', () => {
  setAllClients([{ UUID: 'client-1', Online: true, Version: '3.6.9' }]);
  assert.equal(GetIdentifyTargetByUUID('client-1').Eligible, false);
});

test('GetIdentifyTargetByUUID rules out integrated/SDK entities', () => {
  // An SDK-integrated entity has no screen to flash, so Identify is meaningless
  // even though it is online and reports a recent version.
  setAllClients([{ UUID: 'sdk-1', Online: true, Version: '3.14.0', Integrated: true }]);
  assert.equal(GetIdentifyTargetByUUID('sdk-1').Eligible, false);

  setAllClients([
    { UUID: 'sdk-2', Online: true, Version: '3.14.0', OperatingSystem: 'Integrated' },
  ]);
  assert.equal(GetIdentifyTargetByUUID('sdk-2').Eligible, false);
});

test('GetIdentifyTargetByUUID reports the current identifying state', () => {
  setAllClients([{ UUID: 'client-1', Online: true, Version: '3.14.0', Identifying: true }]);
  assert.equal(GetIdentifyTargetByUUID('client-1').IsIdentifying, true);
});

test('GetIdentifyTargetByUUID gates a pending-adoption device on version only', () => {
  // A device awaiting adoption is by definition reachable, so there is no
  // Online flag to consult — only the version gate applies.
  setPendingAdoption([{ UUID: 'pending-1', Version: '3.7.0' }]);
  assert.equal(GetIdentifyTargetByUUID('pending-1').Eligible, true);

  setPendingAdoption([{ UUID: 'pending-2', Version: '3.6.0' }]);
  assert.equal(GetIdentifyTargetByUUID('pending-2').Eligible, false);
});

test('GetIdentifyTargetByUUID prefers the adopted client over a pending duplicate', () => {
  // The same physical machine can briefly appear in both lists during adoption.
  setAllClients([{ UUID: 'dup', Online: false, Version: '3.14.0' }]);
  setPendingAdoption([{ UUID: 'dup', Version: '3.14.0' }]);
  // The adopted (offline) record wins, so it is not eligible.
  assert.equal(GetIdentifyTargetByUUID('dup').Eligible, false);
});

test('GetIdentifyTargetByUUID returns an ineligible stub for an unknown UUID', () => {
  assert.deepEqual(GetIdentifyTargetByUUID('nobody'), {
    UUID: 'nobody',
    Eligible: false,
    IsIdentifying: false,
  });
});

// --- GetIdentifyingUUIDs ----------------------------------------------------

/**
 * Install a minimal stand-in for the two jQuery call shapes this function uses:
 * `$(selector).each(cb)` and `$(this).attr('data-uuid')`. This is a stub for one
 * call site, not a DOM — see the WP-1 strategy note in the coverage plan.
 */
function withFakeTiles(uuids, fn) {
  const Had = '$' in globalThis;
  const Previous = globalThis.$;
  globalThis.$ = (arg) => {
    if (typeof arg === 'string') {
      return {
        each(cb) {
          for (const UUID of uuids) cb.call({ __uuid: UUID });
        },
      };
    }
    return { attr: (name) => (name === 'data-uuid' ? arg.__uuid : undefined) };
  };
  try {
    return fn();
  } finally {
    if (Had) globalThis.$ = Previous;
    else delete globalThis.$;
  }
}

test('GetIdentifyingUUIDs reads the live tiles first', () => {
  // Rendered tiles stay accurate even when an incremental push has updated
  // classes before the list caches are reconciled, so they win over the caches.
  setAllClients([{ UUID: 'from-cache', Identifying: true }]);
  const Result = withFakeTiles(['from-dom'], () => GetIdentifyingUUIDs());
  assert.deepEqual(Result, ['from-dom']);
});

test('GetIdentifyingUUIDs de-duplicates and ignores blank tile UUIDs', () => {
  const Result = withFakeTiles(['a', 'a', '  ', 'b'], () => GetIdentifyingUUIDs());
  assert.deepEqual(Result.sort(), ['a', 'b']);
});

test('GetIdentifyingUUIDs falls back to the caches when no tiles are identifying', () => {
  setAllClients([
    { UUID: 'client-1', Identifying: true },
    { UUID: 'client-2', Identifying: false },
  ]);
  setPendingAdoption([{ UUID: 'pending-1', Identifying: true }]);
  const Result = withFakeTiles([], () => GetIdentifyingUUIDs());
  assert.deepEqual(Result.sort(), ['client-1', 'pending-1']);
});

test('GetIdentifyingUUIDs falls back to the caches when the DOM query throws', () => {
  // No jQuery at all: the try/catch keeps this working rather than taking the
  // identify banner down with it.
  setAllClients([{ UUID: 'client-1', Identifying: true }]);
  const Warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(GetIdentifyingUUIDs(), ['client-1']);
  } finally {
    console.warn = Warn;
  }
});

test('GetIdentifyingUUIDs returns an empty list when nothing is identifying', () => {
  assert.deepEqual(
    withFakeTiles([], () => GetIdentifyingUUIDs()),
    []
  );
});
