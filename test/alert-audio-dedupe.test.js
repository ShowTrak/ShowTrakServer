const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises dist/Modules/AlertActions/_audio-dedupe.js — the window that collapses
// repeat requests for the SAME alert sound into a single audible playback.
//
// The properties that matter:
//   1. Identity, not volume of traffic, decides. One fault matching a client, a
//      group and a tag rule must be one cue; two DIFFERENT sounds must both play.
//   2. The claim is synchronous. Alert actions run under Promise.allSettled, so a
//      check-then-record with an await in between would let two callers both win.
//   3. A backwards clock step must not mute alerts until real time catches up.

const MODULE_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'AlertActions',
  '_audio-dedupe.js'
);

/** Fresh module state per test — the window and the open claims are module-level. */
function loadDedupe() {
  return loadWithMocks(MODULE_PATH, {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('keys namespace built-in sounds separately from custom assets', () => {
  const Dedupe = loadDedupe();
  assert.equal(Dedupe.SoundPlaybackKey('Alert'), 'sound:Alert');
  assert.equal(Dedupe.AssetPlaybackKey('a1'), 'asset:a1');
  // An asset whose ID happens to match a sound name must not collide with it.
  assert.notEqual(Dedupe.SoundPlaybackKey('Alert'), Dedupe.AssetPlaybackKey('Alert'));
});

test('defaults to a 500ms window', () => {
  const Dedupe = loadDedupe();
  assert.equal(Dedupe.GetAudioDedupeWindow(), 500);
});

test('the first claim in a window wins and the rest are refused', () => {
  const Dedupe = loadDedupe();
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), false);
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), false);
});

test('different sounds hold independent windows', () => {
  const Dedupe = loadDedupe();
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
  // A different tone and a custom asset both still play alongside it.
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Warning'), true);
  assert.equal(Dedupe.ClaimAudioPlayback('asset:a1'), true);
  assert.equal(Dedupe.ClaimAudioPlayback('asset:a2'), true);
  // ...and each of them is then deduped on its own.
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Warning'), false);
  assert.equal(Dedupe.ClaimAudioPlayback('asset:a1'), false);
});

test('a refused claim does not extend the window', async () => {
  // Without this, a fault re-firing faster than the window would suppress the
  // sound forever instead of letting it through once per window.
  const Dedupe = loadDedupe();
  Dedupe.SetAudioDedupeWindow(40);

  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
  await sleep(25);
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), false);
  await sleep(30);
  // 55ms after the play that opened it, the window is spent regardless of the
  // refusal that landed in the middle.
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
});

test('a zero window disables de-duplication entirely', () => {
  const Dedupe = loadDedupe();
  Dedupe.SetAudioDedupeWindow(0);
  assert.equal(Dedupe.GetAudioDedupeWindow(), 0);
  for (let i = 0; i < 5; i++) {
    assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
  }
});

test('the window is clamped and malformed values are ignored', () => {
  const Dedupe = loadDedupe();

  Dedupe.SetAudioDedupeWindow(-100);
  assert.equal(Dedupe.GetAudioDedupeWindow(), 0);

  Dedupe.SetAudioDedupeWindow(999999);
  assert.equal(Dedupe.GetAudioDedupeWindow(), 10000);

  Dedupe.SetAudioDedupeWindow(750.4);
  assert.equal(Dedupe.GetAudioDedupeWindow(), 750);

  // A missing or non-numeric setting leaves the last good value in place rather
  // than silently muting or un-muting alerts.
  Dedupe.SetAudioDedupeWindow('nonsense');
  assert.equal(Dedupe.GetAudioDedupeWindow(), 750);
  Dedupe.SetAudioDedupeWindow(undefined);
  assert.equal(Dedupe.GetAudioDedupeWindow(), 750);
});

test('a backwards clock step releases the window instead of muting the sound', (t) => {
  const Dedupe = loadDedupe();
  const RealNow = Date.now;
  let Now = 1_000_000;
  t.mock.method(Date, 'now', () => Now);
  t.after(() => {
    Date.now = RealNow;
  });

  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), false);

  // NTP (or an operator) steps the host clock back an hour mid-show.
  Now -= 3_600_000;
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
});

test('ResetAudioDedupe clears open windows and restores the default', () => {
  const Dedupe = loadDedupe();
  Dedupe.SetAudioDedupeWindow(5000);
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);

  Dedupe.ResetAudioDedupe();
  assert.equal(Dedupe.GetAudioDedupeWindow(), 500);
  assert.equal(Dedupe.ClaimAudioPlayback('sound:Alert'), true);
});
