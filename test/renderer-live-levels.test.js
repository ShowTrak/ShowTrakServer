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
      { Group: 'Inputs', Label: '<b>Mic</b>', Db: -6 },
      { Group: 'Inputs', Label: 'Input 2', Db: null },
      { Group: 'Outputs', Label: 'Main L', Db: -10 },
    ],
  };
  const html = Lib.LiveLevelsCardHtml(check);
  assert.match(html, /&lt;Rack&gt; · Levels/);
  assert.match(html, /&lt;b&gt;Mic&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Mic/);
  assert.equal((html.match(/class="live-levels-row live-levels-strip"/g) || []).length, 3);
  // Grouped, numbered within each group, indexed across the whole list.
  assert.equal((html.match(/class="live-levels-group"/g) || []).length, 2);
  assert.match(
    html,
    /live-levels-group">Outputs<\/div><div class="live-levels-strips"><div class="live-levels-row live-levels-strip" data-index="2"[^>]*><div class="live-levels-strip-head"><span class="live-levels-number">1</
  );
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

const Tiles = require('../dist-test/UI/js/app/lib/tile-widgets.js');

function monitor(overrides = {}) {
  return {
    TargetID: 5,
    Online: true,
    Degraded: false,
    CheckCount: 1,
    LastChecked: 1,
    TileWidget: { Kind: 'levels', CheckID: 51 },
    ...overrides,
  };
}

test('a tile widget only stands in for a healthy status line', () => {
  assert.equal(Tiles.ShowsTileWidget(monitor()), true);
  assert.equal(Tiles.ShowsTileWidget(monitor({ Degraded: true })), false);
  assert.equal(Tiles.ShowsTileWidget(monitor({ Online: false })), false);
  assert.equal(Tiles.ShowsTileWidget(monitor({ LastChecked: null })), false);
  assert.equal(Tiles.ShowsTileWidget(monitor({ TileWidget: null })), false);
  assert.equal(Tiles.ShowsTileWidget(monitor({ TileWidget: undefined })), false);
  assert.equal(Tiles.TileWidgetKind(monitor()), 'levels');
  assert.equal(Tiles.TileWidgetKind(monitor({ TileWidget: null })), '');
});

test('the levels footer shows bars when live and a short line otherwise', () => {
  assert.deepEqual(Tiles.TileLevelsView(undefined), { Bars: [], Text: 'Levels…' });
  assert.deepEqual(Tiles.TileLevelsView({ State: 'unavailable', Message: 'Busy', Channels: [] }), {
    Bars: [],
    Text: 'Busy',
  });
  const live = Tiles.TileLevelsView({
    State: 'live',
    Message: null,
    Channels: [
      { Label: 'Main L', Db: -30 },
      { Label: 'Main R', Db: -2 },
    ],
  });
  assert.equal(live.Text, null);
  assert.deepEqual(live.Bars, [
    {
      Label: 'Main L',
      Percent: 50,
      Zone: 'ok',
      PeakPercent: 50,
      PeakZone: 'ok',
      Title: 'Main L: -30.0 dB',
    },
    {
      Label: 'Main R',
      Percent: 96.7,
      Zone: 'clip',
      PeakPercent: 96.7,
      PeakZone: 'clip',
      Title: 'Main R: -2.0 dB',
    },
  ]);
  // The peak line holds after the level drops.
  const peaks = new Map();
  const tile = (db) => ({ State: 'live', Message: null, Channels: [{ Label: 'Main L', Db: db }] });
  Tiles.TileLevelsView(tile(-6), peaks, 0);
  const after = Tiles.TileLevelsView(tile(-40), peaks, 500);
  assert.equal(after.Bars[0].Percent, 33.3);
  assert.equal(after.Bars[0].PeakPercent, 90);
  assert.equal(
    Tiles.TileLevelsView({ State: 'live', Message: null, Channels: [] }).Text,
    'No outputs chosen'
  );
});

test('fader slider: −∞ at the bottom, clamped to its range, readout as sent', () => {
  assert.equal(Lib.FaderToSlider(null), Lib.FADER_SLIDER_MIN);
  assert.equal(Lib.FaderToSlider(-90), -60);
  assert.equal(Lib.FaderToSlider(-6), -6);
  assert.equal(Lib.FaderToSlider(20), 10);
  assert.equal(Lib.SliderToFader(Lib.FADER_SLIDER_MIN), null);
  assert.equal(Lib.SliderToFader(-60), -60);
  assert.equal(Lib.SliderToFader(3.5), 3.5);
  assert.equal(Lib.FormatFader(null), '−∞');
  assert.equal(Lib.FormatFader(undefined), '—');
  assert.equal(Lib.FormatFader(3.5), '+3.5');
  assert.equal(Lib.FormatFader(-6), '-6.0');
});

test('controlled strips get a fader and a mute under the meter; the rest do not', () => {
  const html = Lib.LiveLevelsCardHtml({
    CheckID: 1,
    Name: '',
    State: 'live',
    Message: null,
    Channels: [
      { ID: 'in:1', Group: 'Inputs', Label: 'Mic', Db: -6, Control: true, Fader: -3, Muted: true },
      { ID: 'out:1', Group: 'Outputs', Label: 'Main L', Db: -6 },
    ],
  });
  // The controls sit under the meter, inside the channel's own strip.
  assert.match(html, /live-levels-peak"><\/span><\/span><div class="live-levels-strip-controls">/);
  assert.equal((html.match(/live-levels-fader"/g) || []).length, 1);
  assert.match(html, /value="-3"/);
  assert.match(html, /live-levels-mute is-muted" aria-pressed="true"/);
  // An uncontrolled channel's strip is just its name, level and meter.
  assert.match(
    html,
    /data-channel-id="out:1">(?:(?!strip-controls).)*<\/div><\/div><\/div><\/div>$/
  );
  // Turning control on redraws the card.
  const base = {
    CheckID: 1,
    Name: '',
    State: 'live',
    Message: null,
    Channels: [{ ID: 'in:1', Group: 'Inputs', Label: 'Mic', Db: -6 }],
  };
  assert.notEqual(
    Lib.LiveLevelsSignature(base),
    Lib.LiveLevelsSignature({ ...base, Channels: [{ ...base.Channels[0], Control: true }] })
  );
});
