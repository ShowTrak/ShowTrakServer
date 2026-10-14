const test = require('node:test');
const assert = require('node:assert/strict');

// Covers the tap-to-confirm rule in src/UI/js/app/lib/touch-input.ts: a context
// menu action tapped with a finger or pen must need a second, confirming tap on
// every device and layout (an iPad gets the desktop layout), while mouse,
// trackpad and keyboard keep single activation outside the phone layout.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  IsTouchPointerType,
  ResolveClickPointerType,
  RequiresTapConfirm,
} = require('../dist-test/UI/js/app/lib/touch-input.js');

test('finger and pen are touch input; mouse and unknown are not', () => {
  assert.equal(IsTouchPointerType('touch'), true);
  assert.equal(IsTouchPointerType('pen'), true);
  assert.equal(IsTouchPointerType('mouse'), false);
  assert.equal(IsTouchPointerType(''), false);
  assert.equal(IsTouchPointerType(null), false);
  assert.equal(IsTouchPointerType(undefined), false);
});

test("the click's own pointerType wins over the last pointerdown", () => {
  assert.equal(ResolveClickPointerType(true, 'touch', 'mouse'), 'touch');
  assert.equal(ResolveClickPointerType(true, 'mouse', 'touch'), 'mouse');
});

test('a click without pointerType (older iOS WebKit) falls back to the last pointerdown', () => {
  assert.equal(ResolveClickPointerType(true, undefined, 'touch'), 'touch');
  assert.equal(ResolveClickPointerType(true, '', 'pen'), 'pen');
  assert.equal(ResolveClickPointerType(true, undefined, null), null);
});

test('the keyboard path (synthetic click, no native event) is never a tap', () => {
  assert.equal(ResolveClickPointerType(false, undefined, 'touch'), null);
});

test('desktop layout: touch and pen taps need confirming, mouse/keyboard do not', () => {
  assert.equal(RequiresTapConfirm(false, 'touch'), true);
  assert.equal(RequiresTapConfirm(false, 'pen'), true);
  assert.equal(RequiresTapConfirm(false, 'mouse'), false);
  assert.equal(RequiresTapConfirm(false, null), false);
});

test('mobile layout: every activation needs confirming, as before', () => {
  for (const type of ['touch', 'pen', 'mouse', null]) {
    assert.equal(RequiresTapConfirm(true, type), true, String(type));
  }
});
