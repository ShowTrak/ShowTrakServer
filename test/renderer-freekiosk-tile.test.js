// Exercises src/UI/js/app/freekiosk.ts — the FreeKiosk tile markup.
//
// RenderFreeKioskTile returns a string, so it can be asserted without a DOM.
// What is actually at stake:
//   - data-uuid must be the kiosk:-prefixed id, or drag/drop and "select the
//     whole group" silently skip every terminal;
//   - the state class is the colour an operator reads across a room;
//   - exactly one status block may be visible, or the tile shows two verdicts;
//   - device-supplied text (a nickname, a hostname) must be escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FreeKiosk = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'freekiosk.js')
);

const terminal = (overrides = {}) => ({
  UUID: 'k1',
  Nickname: 'Lobby Kiosk',
  Address: '10.0.0.5',
  Port: 8080,
  State: 'ONLINE',
  Online: true,
  Degraded: false,
  DegradedWarnings: [],
  Alarms: [],
  Metrics: {},
  GroupID: null,
  Weight: 100,
  LastSuccessAt: null,
  ...overrides,
});

const visibleBlocks = (html) => (html.match(/SHOWTRAK_PC_STATUS [^"]*d-grid/g) || []).length;

test('the selection id is the kiosk-prefixed UUID, matching the layout helper', () => {
  const html = FreeKiosk.RenderFreeKioskTile(terminal());
  assert.match(html, /data-uuid="kiosk:k1"/);
  assert.match(html, /data-flip-key="kiosk:k1"/);
  // The bare UUID is carried separately, for the cog and double-click handlers.
  assert.match(html, /data-kiosk-uuid="k1"/);
  assert.equal(FreeKiosk.FreeKioskScopedID('k1'), 'kiosk:k1');
});

test('the tile carries the class the CSS colours it by', () => {
  for (const [state, cls] of [
    ['ONLINE', 'ONLINE'],
    ['DEGRADED', 'DEGRADED'],
    ['IDLE', 'IDLE'],
  ]) {
    const html = FreeKiosk.RenderFreeKioskTile(terminal({ State: state }));
    assert.match(html, new RegExp(`class="SHOWTRAK_PC FREEKIOSK ${cls}"`), state);
  }
  // Offline has no extra class: the base tile is already the offline colour.
  assert.match(
    FreeKiosk.RenderFreeKioskTile(terminal({ State: 'OFFLINE' })),
    /class="SHOWTRAK_PC FREEKIOSK "/
  );
});

test('exactly one status block is visible per state', () => {
  for (const state of ['IDLE', 'ONLINE', 'DEGRADED', 'OFFLINE']) {
    const html = FreeKiosk.RenderFreeKioskTile(terminal({ State: state }));
    assert.equal(visibleBlocks(html), 1, `${state} should show one block`);
  }
});

test('a degraded terminal shows its first alarm reason', () => {
  const html = FreeKiosk.RenderFreeKioskTile(
    terminal({
      State: 'DEGRADED',
      Degraded: true,
      DegradedWarnings: ['Battery Level 12% is below 20%', 'Displaying Content: No'],
    })
  );
  assert.match(html, /Battery Level 12% is below 20%/);
  // Only the first: the tile has one line for it.
  assert.ok(!html.includes('Displaying Content: No'));
});

test('a degraded terminal with no reason still says something', () => {
  const html = FreeKiosk.RenderFreeKioskTile(
    terminal({ State: 'DEGRADED', Degraded: true, DegradedWarnings: [] })
  );
  assert.match(html, /Alarm/);
});

test('the address line hides the default port and shows a custom one', () => {
  assert.equal(FreeKiosk.FreeKioskDisplayAddress(terminal()), '10.0.0.5');
  assert.equal(FreeKiosk.FreeKioskDisplayAddress(terminal({ Port: 9000 })), '10.0.0.5:9000');
  assert.equal(FreeKiosk.FreeKioskDisplayAddress(terminal({ Address: '' })), 'No address');
});

test('device-supplied text is escaped', () => {
  const html = FreeKiosk.RenderFreeKioskTile(
    terminal({ Nickname: '<img src=x onerror=alert(1)>', Address: '"><script>x</script>' })
  );
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img/);
});

test('the compact status mirrors the state', () => {
  assert.deepEqual(FreeKiosk.FreeKioskCompactStatus(terminal({ State: 'ONLINE' })), {
    text: 'Online',
    color: 'text-light',
    offline: false,
  });
  assert.deepEqual(FreeKiosk.FreeKioskCompactStatus(terminal({ State: 'IDLE' })), {
    text: 'Idle',
    color: 'text-light',
    offline: false,
  });
  // Offline defers to the offline-since counter rather than a label.
  assert.equal(FreeKiosk.FreeKioskCompactStatus(terminal({ State: 'OFFLINE' })).offline, true);
  assert.equal(
    FreeKiosk.FreeKioskCompactStatus(
      terminal({ State: 'DEGRADED', DegradedWarnings: ['Low battery'] })
    ).color,
    'text-warning'
  );
});

test('the vitals bars draw empty before the first poll', () => {
  // No catalogue is loaded in this context, so the formatter has no metric to
  // work from — it must still produce something, not throw or print undefined.
  // An absent reading has to be an EMPTY bar: a missing battery level drawn
  // full would read across a room as a healthy tablet.
  const html = FreeKiosk.FreeKioskVitalsBars(terminal({ Metrics: {} }));
  assert.match(html, /data-type="BATTERY"[^>]*width: 0%/);
  assert.match(html, /data-type="BRIGHTNESS"[^>]*width: 0%/);
  assert.ok(!html.includes('undefined'));
});

test('the bars are the same markup a client uses for CPU and RAM', () => {
  const html = FreeKiosk.FreeKioskVitalsBars(
    terminal({ Metrics: { battery_level: 42, screen_brightness: 75 } })
  );
  assert.match(html, /<div class="progress"[^>]*>/);
  assert.match(html, /class="progress-bar bg-white"[^>]*width: 42%/);
  assert.match(html, /class="progress-bar bg-white"[^>]*width: 75%/);
});

test('an out-of-range reading is clamped rather than overflowing the bar', () => {
  const html = FreeKiosk.FreeKioskVitalsBars(
    terminal({ Metrics: { battery_level: 140, screen_brightness: -20 } })
  );
  assert.match(html, /data-type="BATTERY"[^>]*width: 100%/);
  assert.match(html, /data-type="BRIGHTNESS"[^>]*width: 0%/);
});

test('charging is stated in the tooltip and changes nothing visually', () => {
  // The battery bar used to animate while charging. It was removed: a tile wall
  // is scanned for the one thing that is wrong, and the only moving element on
  // it was pulling the eye toward a terminal that was perfectly healthy.
  const charging = FreeKiosk.FreeKioskVitalsBars(
    terminal({ Metrics: { battery_level: 50, battery_charging: true } })
  );
  const flat = FreeKiosk.FreeKioskVitalsBars(
    terminal({ Metrics: { battery_level: 50, battery_charging: false } })
  );
  assert.match(charging, /title="Battery [^"]*\(charging\)"/);
  assert.ok(!charging.includes('is-charging'));

  // Identical markup apart from the tooltip text — nothing about the bar itself
  // reacts to the charging state.
  assert.equal(
    charging.replace(/ \(charging\)/, ''),
    flat,
    'the bars themselves must render identically'
  );
});

test('the tile embeds the bars in the online indicator', () => {
  const html = FreeKiosk.RenderFreeKioskTile(
    terminal({ Metrics: { battery_level: 60, screen_brightness: 30 } })
  );
  assert.match(html, /data-type="INDICATOR_ONLINE"/);
  assert.match(html, /data-type="BATTERY"/);
  assert.match(html, /data-type="BRIGHTNESS"/);
});

test('the type label is what an operator sees where a client shows its version', () => {
  const html = FreeKiosk.RenderFreeKioskTile(terminal());
  assert.equal(FreeKiosk.FREEKIOSK_TYPE_LABEL, 'KIOSK');
  assert.match(html, /data-type="FreeKioskLabel">KIOSK</);
});
