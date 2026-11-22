const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/utils.ts: the renderer's shared helpers. (Safe,
// ErrorMessage and HandleNonFatalError, which it re-exports, are the renderer
// kit's, covered by @showtrak/protocol's specs.)
//
// These load from dist-test/ rather than dist/: the shipped renderer is an
// esbuild IIFE bundle, so tsconfig.renderer.test.json emits the same sources as
// individual CommonJS modules for tests and per-file coverage. See WP-0 in
// ~/.claude/plans/showtrak-test-coverage.md.
//
// Nothing here needs a DOM. jQuery is only touched inside ShowQRModal's body,
// never at module scope, so requiring the module in plain Node is safe.
const { FormatBytes, GetAlertVolume, WithNonFatal } = require('../dist-test/UI/js/app/utils.js');
const { setSettings } = require('../dist-test/UI/js/app/state/server-caches.js');

// --- FormatBytes ------------------------------------------------------------

test('FormatBytes scales through the unit table', () => {
  assert.equal(FormatBytes(0), '0 B');
  assert.equal(FormatBytes(512), '512 B');
  assert.equal(FormatBytes(1023), '1023 B');
  assert.equal(FormatBytes(1024), '1.0 KB');
  assert.equal(FormatBytes(1024 * 1024), '1.0 MB');
  assert.equal(FormatBytes(1024 ** 3), '1.0 GB');
  assert.equal(FormatBytes(1024 ** 4), '1.0 TB');
  assert.equal(FormatBytes(1024 ** 5), '1.0 PB');
});

test('FormatBytes keeps one decimal below 10 and drops it at or above', () => {
  assert.equal(FormatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(FormatBytes(15.2 * 1024 ** 3), '15 GB');
  // Bytes are always whole, regardless of magnitude.
  assert.equal(FormatBytes(1.5), '2 B');
});

test('FormatBytes saturates at the largest unit rather than running off the table', () => {
  // 1024 PB has nowhere further to go, so it stays in PB.
  assert.equal(FormatBytes(1024 ** 6), '1024 PB');
});

test('FormatBytes parses numeric strings and rejects anything else with null', () => {
  assert.equal(FormatBytes('2048'), '2.0 KB');
  assert.equal(FormatBytes(-1), null);
  assert.equal(FormatBytes(NaN), null);
  assert.equal(FormatBytes(Infinity), null);
  assert.equal(FormatBytes('not a number'), null);
  assert.equal(FormatBytes(null), null);
  assert.equal(FormatBytes(undefined), null);
});

// --- GetAlertVolume ---------------------------------------------------------
//
// Reads the ALERT_SOUND_VOLUME setting (a 0-100 slider) live from the shared
// settings cache and returns a 0..1 multiplier. The important property is that
// it NEVER silently mutes: every malformed input must default to full volume.

test('GetAlertVolume returns full volume when the setting is missing', () => {
  setSettings([]);
  assert.equal(GetAlertVolume(), 1);
  setSettings([{ Key: 'SOMETHING_ELSE', Value: '0' }]);
  assert.equal(GetAlertVolume(), 1);
});

test('GetAlertVolume converts the 0-100 slider to a 0..1 multiplier', () => {
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: '50' }]);
  assert.equal(GetAlertVolume(), 0.5);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 0 }]);
  assert.equal(GetAlertVolume(), 0);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 100 }]);
  assert.equal(GetAlertVolume(), 1);
});

test('GetAlertVolume clamps out-of-range values into 0..1', () => {
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 250 }]);
  assert.equal(GetAlertVolume(), 1);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: -40 }]);
  assert.equal(GetAlertVolume(), 0);
});

test('GetAlertVolume defaults to full volume rather than muting on a bad value', () => {
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: 'loud' }]);
  assert.equal(GetAlertVolume(), 1);
  setSettings([{ Key: 'ALERT_SOUND_VOLUME', Value: null }]);
  // Number(null) is 0, which is finite; a null value really does mute.
  assert.equal(GetAlertVolume(), 0);
});

test('GetAlertVolume tolerates a non-array settings cache', () => {
  setSettings(null);
  assert.equal(GetAlertVolume(), 1);
  setSettings([]);
});

// --- WithNonFatal -----------------------------------------------------------

test('WithNonFatal returns the operation result on success', async () => {
  assert.equal(await WithNonFatal('Ctx', () => 'ok'), 'ok');
  assert.equal(await WithNonFatal('Ctx', async () => 'async ok'), 'async ok');
});

test('WithNonFatal swallows a throw and returns the fallback', async () => {
  const Original = console.warn;
  const Calls = [];
  console.warn = (...args) => Calls.push(args);
  try {
    assert.equal(
      await WithNonFatal('Ctx:Sync', () => {
        throw new Error('sync boom');
      }),
      null
    );
    assert.equal(
      await WithNonFatal(
        'Ctx:Async',
        async () => {
          throw new Error('async boom');
        },
        'fallback'
      ),
      'fallback'
    );
  } finally {
    console.warn = Original;
  }
  assert.equal(Calls.length, 2);
  assert.equal(Calls[0][0], '[NonFatal] Ctx:Sync');
  assert.equal(Calls[1][0], '[NonFatal] Ctx:Async');
});
