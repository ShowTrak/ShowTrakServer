const test = require('node:test');
const assert = require('node:assert/strict');

// The live levels card in a monitor's view. lib/live-levels.ts holds the
// decisions (bar width, colour zone, peak hold, markup) and is tested directly.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/live-levels.js');

test('bar width spans -60 to 0 dBFS; silence is empty', () => {
  assert.equal(Lib.LevelPercent(null), 0);
  assert.equal(Lib.LevelPercent(-90), 0);
  assert.equal(Lib.LevelPercent(-60), 0);
  assert.equal(Lib.LevelPercent(-30), 50);
  assert.equal(Lib.LevelPercent(0), 100);
  assert.equal(Lib.LevelPercent(3), 100);
});

test('zones and formatting', () => {
  assert.equal(Lib.LevelZoneOf(-20), 'ok');
  assert.equal(Lib.LevelZoneOf(-12), 'hot');
  assert.equal(Lib.LevelZoneOf(-3), 'clip');
  assert.equal(Lib.LevelZoneOf(null), 'ok');
  assert.equal(Lib.FormatLevel(-6), '-6.0 dB');
  assert.equal(Lib.FormatLevel(null), '−∞');
});

test('peak holds, then falls to meet the level', () => {
  let peak = Lib.NextPeak(undefined, -10, 0);
  assert.deepEqual(peak, { Db: -10, At: 0 });
  peak = Lib.NextPeak(peak, -30, 1000);
  assert.equal(peak.Db, -10);
  // 0.5 s past the hold at 20 dB/s: 10 dB lower.
  peak = Lib.NextPeak(peak, -30, Lib.PEAK_HOLD_MS + 500);
  assert.equal(peak.Db, -20);
  peak = Lib.NextPeak(peak, -30, Lib.PEAK_HOLD_MS + 5000);
  assert.deepEqual(peak, { Db: -30, At: Lib.PEAK_HOLD_MS + 5000 });
  // Louder takes over at once.
  assert.deepEqual(Lib.NextPeak(peak, -1, 99999), { Db: -1, At: 99999 });
});

test('card markup escapes device names; the signature ignores levels', () => {
  const check = {
    CheckID: 4,
    Name: '<Rack>',
    State: 'live',
    Message: null,
    Channels: [
      { Label: '<b>Mic</b>', Db: -6 },
      { Label: 'Input 2', Db: null },
    ],
  };
  const html = Lib.LiveLevelsCardHtml(check);
  assert.match(html, /&lt;Rack&gt; · Input Levels/);
  assert.match(html, /&lt;b&gt;Mic&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Mic/);
  assert.equal((html.match(/class="live-levels-row"/g) || []).length, 2);
  assert.match(html, /is-live/);
  const quieter = { ...check, Channels: check.Channels.map((c) => ({ ...c, Db: -40 })) };
  assert.equal(Lib.LiveLevelsSignature(check), Lib.LiveLevelsSignature(quieter));
  assert.notEqual(
    Lib.LiveLevelsSignature(check),
    Lib.LiveLevelsSignature({ ...check, State: 'unavailable', Message: 'Busy' })
  );
  assert.match(Lib.LiveLevelsCardHtml({ ...check, State: 'unavailable', Message: 'Busy' }), /Busy/);
  assert.equal(Lib.LiveLevelsStatus({ ...check, State: 'connecting' }).Text, 'Connecting…');
});
