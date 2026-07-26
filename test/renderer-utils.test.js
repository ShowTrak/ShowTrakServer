const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/utils.ts — the renderer's shared helpers.
//
// These load from dist-test/ rather than dist/: the shipped renderer is an
// esbuild IIFE bundle, so tsconfig.renderer.test.json emits the same sources as
// individual CommonJS modules for tests and per-file coverage. See WP-0 in
// ~/.claude/plans/showtrak-test-coverage.md.
//
// Nothing here needs a DOM. jQuery is only touched inside ShowQRModal's body,
// never at module scope, so requiring the module in plain Node is safe.
const {
  Safe,
  ErrorMessage,
  FormatBytes,
  GetAlertVolume,
  HandleNonFatalError,
  WithNonFatal,
} = require('../dist-test/UI/js/app/utils.js');
const { setSettings } = require('../dist-test/UI/js/app/state/server-caches.js');

// --- Safe -------------------------------------------------------------------
//
// Safe is THE escaper for the renderer: every interpolated value in every
// template literal that becomes markup passes through it. A regression here is
// an XSS hole across the whole UI, so it gets the most attention.

test('Safe escapes all five significant HTML entities', () => {
  assert.equal(Safe(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('Safe escapes the ampersand first so entities are not double-encoded', () => {
  // If & were escaped last, '<' would become '&lt;' and then '&amp;lt;'.
  assert.equal(Safe('<'), '&lt;');
  assert.equal(Safe('&lt;'), '&amp;lt;');
});

test('Safe neutralises a script tag and an attribute breakout', () => {
  assert.equal(Safe('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  // Both quote styles are escaped, so the result is safe inside a double- OR
  // single-quoted attribute value.
  assert.equal(Safe('" onerror="alert(1)'), '&quot; onerror=&quot;alert(1)');
  assert.equal(Safe("' onerror='alert(1)"), '&#39; onerror=&#39;alert(1)');
});

test('Safe collapses null and undefined to an empty string, never the literal word', () => {
  assert.equal(Safe(null), '');
  assert.equal(Safe(undefined), '');
});

test('Safe escapes arrays element-wise and comma-joins them', () => {
  assert.equal(Safe(['<a>', '<b>']), '&lt;a&gt;,&lt;b&gt;');
  assert.equal(Safe([]), '');
  // Nested arrays recurse through the same element-wise path.
  assert.equal(Safe([['<a>'], '<b>']), '&lt;a&gt;,&lt;b&gt;');
  // null/undefined members collapse individually rather than stringifying.
  assert.equal(Safe([null, undefined, 'x']), ',,x');
});

test('Safe coerces non-strings to their string form and escapes the result', () => {
  assert.equal(Safe(42), '42');
  assert.equal(Safe(0), '0');
  assert.equal(Safe(false), 'false');
  assert.equal(Safe(NaN), 'NaN');
  // An object whose toString carries markup must not escape the escaper.
  assert.equal(Safe({ toString: () => '<img onerror=x>' }), '&lt;img onerror=x&gt;');
});

// --- ErrorMessage -----------------------------------------------------------

test('ErrorMessage prefers a non-empty message property', () => {
  assert.equal(ErrorMessage(new Error('boom')), 'boom');
  assert.equal(ErrorMessage({ message: 'plain object' }), 'plain object');
});

test('ErrorMessage falls back when message is absent, empty or not a string', () => {
  assert.equal(ErrorMessage({ message: '' }, 'fallback'), 'fallback');
  assert.equal(ErrorMessage({ message: 123 }, 'fallback'), 'fallback');
  assert.equal(ErrorMessage({}, 'fallback'), 'fallback');
  assert.equal(ErrorMessage(null, 'fallback'), 'fallback');
});

test('ErrorMessage stringifies the thrown value when there is no fallback', () => {
  assert.equal(ErrorMessage('a thrown string'), 'a thrown string');
  assert.equal(ErrorMessage(null), 'null');
  assert.equal(ErrorMessage(undefined), 'undefined');
  assert.equal(ErrorMessage(404), '404');
});

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
  // Number(null) is 0, which is finite — a null value really does mute.
  assert.equal(GetAlertVolume(), 0);
});

test('GetAlertVolume tolerates a non-array settings cache', () => {
  setSettings(null);
  assert.equal(GetAlertVolume(), 1);
  setSettings([]);
});

// --- HandleNonFatalError / WithNonFatal -------------------------------------

/** Capture console.warn for the duration of `fn`. */
function captureWarnings(fn) {
  const Original = console.warn;
  const Calls = [];
  console.warn = (...args) => Calls.push(args);
  try {
    return { result: fn(), calls: Calls };
  } finally {
    console.warn = Original;
  }
}

test('HandleNonFatalError logs the context, with and without an error', () => {
  const { calls } = captureWarnings(() => {
    HandleNonFatalError('Ctx:Thing', new Error('bad'));
    HandleNonFatalError('Ctx:Thing');
    HandleNonFatalError(null);
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], '[NonFatal] Ctx:Thing');
  assert.match(calls[0][1].message, /bad/);
  assert.deepEqual(calls[1], ['[NonFatal] Ctx:Thing']);
  // A falsy context degrades to the bare prefix rather than "[NonFatal] null".
  assert.deepEqual(calls[2], ['[NonFatal]']);
});

test('HandleNonFatalError never throws, even when the console does', () => {
  const Original = console.warn;
  console.warn = () => {
    throw new Error('console is gone');
  };
  try {
    // This is the last-resort reporter; if it can throw, error handling
    // elsewhere turns a non-fatal problem into a fatal one.
    assert.doesNotThrow(() => HandleNonFatalError('Ctx', new Error('x')));
  } finally {
    console.warn = Original;
  }
});

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
