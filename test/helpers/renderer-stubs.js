// Minimal browser-global stubs for renderer tests.
//
// The renderer modules load under plain Node, but some of their FUNCTIONS reach
// for jQuery, `document` or a vendor global. This is strategy (c) from the
// WP-1 decision: hand-rolled micro-stubs for the call shapes a given function
// actually uses, rather than adopting jsdom (which Tom declined).
//
// Install what a test needs BEFORE requiring the module under test — several
// renderer modules read globals at module scope.

/**
 * A chainable no-op that answers any jQuery call.
 *
 * jQuery's API is almost entirely fluent, so a Proxy returning itself covers
 * essentially every shape a render function uses. Value-returning accessors
 * answer '' and `length` answers 0, so `if (!$el.length) return;` guards take
 * their early-exit path — which is what we want: the tests here are about the
 * decisions, not the markup.
 */
function chainable() {
  const Target = function () {
    return chainable();
  };
  return new Proxy(Target, {
    get(_t, Prop) {
      if (Prop === 'length') return 0;
      // Must be absent, or an accidental `await $(...)` would hang.
      if (Prop === 'then') return undefined;
      if (typeof Prop === 'symbol') return undefined;
      if (Prop === 'val' || Prop === 'text' || Prop === 'html' || Prop === 'attr') return () => '';
      return () => chainable();
    },
    apply() {
      return chainable();
    },
  });
}

/** Install a chainable jQuery stub as `$` / `jQuery`. */
function installJQuery() {
  global.$ = () => chainable();
  global.jQuery = global.$;
}

/** A single fake DOM element that answers the traversal calls renderers make. */
function fakeElement() {
  const El = {
    style: {},
    className: '',
    innerHTML: '',
    textContent: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    insertAdjacentHTML() {},
  };
  return El;
}

/** Install a minimal `document` plus the `CSS` global the toast helper reads. */
function installDocument() {
  global.document = {
    getElementById: () => fakeElement(),
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    createElement: fakeElement,
    body: fakeElement(),
  };
  global.CSS = { escape: (Value) => String(Value) };
}

/**
 * Install the `Howl` vendor global.
 *
 * settings.ts constructs Howl instances at MODULE SCOPE, so any module that
 * transitively imports it fails to load without this — which is four of them
 * (alert-rules, osc-feeds, audio-assets, wire-context-menu).
 */
function installHowl() {
  global.Howl = function Howl() {
    return { play() {}, stop() {}, volume() {}, unload() {} };
  };
}

module.exports = { installJQuery, installDocument, installHowl, fakeElement, chainable };
