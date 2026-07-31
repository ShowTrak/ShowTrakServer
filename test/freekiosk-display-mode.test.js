// Display-mode gating for FreeKiosk terminals.
//
// The whole feature exists because of one thing FreeKiosk's API does NOT do.
// There is no way to read the display mode (`GET /api/mode` answers 405
// "requires POST") and no way to read the foreground package. Worse, switching a
// device from WebView to External App changes NOTHING in /api/status —
// `webview.currentUrl` keeps reporting the last page it loaded, indefinitely.
//
// So a terminal locked to an app was showing a URL that looked live, was armed
// with a check that kept passing, and was accumulating a green history chart —
// all describing a page nobody was looking at. The operator declares the mode,
// and everything that depends on a WebView reading disappears when it does not
// apply. Absence beats a confident wrong answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  FREEKIOSK_METRICS_BY_KEY,
  DEFAULT_DISPLAY_MODE,
  DISPLAY_MODE_FIELD_KEY,
  FREEKIOSK_DISPLAY_MODES,
  GetDisplayMode,
  IsMetricActive,
  IsMetricMonitored,
  BuildFreeKioskAlarmFields,
  BuildDefaultAlarmSettings,
  SETUP_SECTION_KEY,
  FREEKIOSK_SECTIONS,
  AlarmFieldKeys,
} = require(path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'metrics.js'));

const { ParseAlarmSettings, EvaluateAllAlarms } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'alarms.js')
);

const WEBVIEW_ONLY = ['webview_currentUrl', 'webview_loading', 'webview_canGoBack'];

// ---- The declaration itself ------------------------------------------------

test('an unset mode reads as WebView, so nothing configured before this changes', () => {
  // Every terminal that existed before the field did was implicitly treated as a
  // WebView kiosk. Defaulting any other way would silently strip rows and
  // disarm checks on somebody's working setup during an upgrade.
  assert.equal(DEFAULT_DISPLAY_MODE, 'webview');
  assert.equal(GetDisplayMode(undefined), 'webview');
  assert.equal(GetDisplayMode(null), 'webview');
  assert.equal(GetDisplayMode({}), 'webview');
  assert.equal(GetDisplayMode({ [DISPLAY_MODE_FIELD_KEY]: '' }), 'webview');
});

test('an unrecognised stored mode falls back rather than gating on a typo', () => {
  assert.equal(GetDisplayMode({ [DISPLAY_MODE_FIELD_KEY]: 'kiosk' }), 'webview');
  assert.equal(GetDisplayMode({ [DISPLAY_MODE_FIELD_KEY]: 'WEBVIEW' }), 'webview');
});

test('each declared mode round-trips', () => {
  for (const Mode of FREEKIOSK_DISPLAY_MODES) {
    assert.equal(GetDisplayMode({ [DISPLAY_MODE_FIELD_KEY]: Mode.Value }), Mode.Value);
  }
  assert.deepEqual(
    FREEKIOSK_DISPLAY_MODES.map((M) => M.Value),
    ['webview', 'external_app', 'media_player']
  );
});

// ---- What the mode gates ---------------------------------------------------

test('the WebView readings are the ones that go stale, and the only ones gated', () => {
  // Pinned deliberately. A metric gaining RequiresMode should be a decision,
  // not something that arrives unnoticed with an unrelated edit.
  const Gated = [...FREEKIOSK_METRICS_BY_KEY.values()]
    .filter((M) => M.RequiresMode && M.RequiresMode.length)
    .map((M) => M.Key);
  assert.deepEqual(Gated.sort(), [...WEBVIEW_ONLY].sort());
  for (const Key of WEBVIEW_ONLY) {
    assert.deepEqual(FREEKIOSK_METRICS_BY_KEY.get(Key).RequiresMode, ['webview']);
  }
});

test('a WebView reading is inactive in every mode that is not WebView', () => {
  for (const Key of WEBVIEW_ONLY) {
    const Metric = FREEKIOSK_METRICS_BY_KEY.get(Key);
    assert.equal(IsMetricActive({ [DISPLAY_MODE_FIELD_KEY]: 'webview' }, Metric), true, Key);
    assert.equal(IsMetricActive({ [DISPLAY_MODE_FIELD_KEY]: 'external_app' }, Metric), false, Key);
    assert.equal(IsMetricActive({ [DISPLAY_MODE_FIELD_KEY]: 'media_player' }, Metric), false, Key);
    // No stored mode at all still means WebView.
    assert.equal(IsMetricActive({}, Metric), true, Key);
  }
});

test('a mode-independent reading is untouched by the mode', () => {
  // content_displaying is screen-on-and-not-screensavered, which is exactly as
  // true of an external app as of a web page — it is the one Content check that
  // survives the switch, and the reason the section does not vanish wholesale.
  const Displaying = FREEKIOSK_METRICS_BY_KEY.get('content_displaying');
  for (const Mode of FREEKIOSK_DISPLAY_MODES) {
    assert.equal(IsMetricActive({ [DISPLAY_MODE_FIELD_KEY]: Mode.Value }, Displaying), true);
  }
});

test('both gates apply, and either one alone is enough to deactivate', () => {
  const Url = FREEKIOSK_METRICS_BY_KEY.get('webview_currentUrl');
  assert.equal(IsMetricActive({ DisplayMode: 'webview', G_Content_On: true }, Url), true);
  assert.equal(IsMetricActive({ DisplayMode: 'webview', G_Content_On: false }, Url), false);
  assert.equal(IsMetricActive({ DisplayMode: 'external_app', G_Content_On: true }, Url), false);
  assert.equal(IsMetricMonitored({ DisplayMode: 'external_app' }, 'webview_currentUrl'), false);
});

// ---- The alarm engine ------------------------------------------------------

test('a URL check armed before the switch to app mode is force-disabled', () => {
  // This is the bug with teeth. Left enabled, a "contains showtrak.co.uk" check
  // goes on passing forever against a retained string, reporting a page as
  // healthy on a terminal that has not rendered a page in weeks.
  const Keys = AlarmFieldKeys('webview_currentUrl');
  const Settings = {
    [Keys.On]: true,
    [Keys.Op]: 'contains',
    [Keys.V]: 'showtrak.co.uk',
    DisplayMode: 'external_app',
  };
  assert.equal(ParseAlarmSettings(Settings).get('webview_currentUrl').Enabled, false);

  // ...and the same settings in WebView mode are still armed.
  assert.equal(
    ParseAlarmSettings({ ...Settings, DisplayMode: 'webview' }).get('webview_currentUrl').Enabled,
    true
  );
});

test('a disabled-by-mode check produces no verdict at all, breaching or passing', () => {
  const Keys = AlarmFieldKeys('webview_currentUrl');
  const Settings = {
    [Keys.On]: true,
    [Keys.Op]: 'notContains',
    [Keys.V]: 'showtrak.co.uk',
    DisplayMode: 'external_app',
  };
  // The retained reading would satisfy neither operator ambiguously — the point
  // is that it is never consulted.
  const Results = EvaluateAllAlarms({ webview_currentUrl: 'https://showtrak.co.uk' }, Settings);
  assert.equal(
    Results.some((R) => R.Key === 'webview_currentUrl'),
    false
  );

  // Guard against the inverse: the same call in WebView mode HAS to produce a
  // verdict, or this test would pass on a typo that armed nothing at all.
  const Armed = EvaluateAllAlarms(
    { webview_currentUrl: 'https://showtrak.co.uk' },
    {
      ...Settings,
      DisplayMode: 'webview',
    }
  );
  assert.ok(Armed.some((R) => R.Key === 'webview_currentUrl'));
});

test('switching modes does not disturb checks outside the WebView readings', () => {
  const Battery = AlarmFieldKeys('battery_level');
  const Settings = {
    [Battery.On]: true,
    [Battery.Op]: 'below',
    [Battery.V]: 20,
    DisplayMode: 'external_app',
  };
  const Results = EvaluateAllAlarms({ battery_level: 5 }, Settings);
  const Battery_ = Results.find((R) => R.Key === 'battery_level');
  assert.ok(Battery_, 'battery is mode-independent and must still be judged');
  assert.equal(Battery_.Breach, true);
});

// ---- The settings schema ---------------------------------------------------

test('the schema offers the mode picker in its own Setup panel, ungated', () => {
  const Fields = BuildFreeKioskAlarmFields();
  const Mode = Fields.find((F) => F.Key === DISPLAY_MODE_FIELD_KEY);
  assert.ok(Mode, 'the operator has no other way to declare it');
  assert.equal(Mode.Type, 'select');
  assert.equal(Mode.Default, 'webview');
  assert.equal(Mode.MetricSection, SETUP_SECTION_KEY);
  assert.deepEqual(
    Mode.Options.map((O) => O.value),
    ['webview', 'external_app', 'media_player']
  );
  // It says what the terminal IS, so switching Content monitoring off must not
  // hide the control that decides what Content even means.
  assert.equal(Mode.VisibleWhen, undefined);
});

test('every field of a WebView metric carries the mode gate, not just its toggle', () => {
  // A hidden checkbox still reports itself as checked, so gating only the toggle
  // would leave its operator and threshold on screen under a heading that no
  // longer applies. Same reasoning as the group gate it sits beside.
  const Fields = BuildFreeKioskAlarmFields();
  const Url = Fields.filter((F) => F.MetricKey === 'webview_currentUrl');
  assert.ok(Url.length >= 3, 'toggle, operator and value at minimum');
  for (const Field of Url) {
    const Conditions = Array.isArray(Field.VisibleWhen) ? Field.VisibleWhen : [Field.VisibleWhen];
    const Gate = Conditions.find((C) => C && C.Key === DISPLAY_MODE_FIELD_KEY);
    assert.ok(Gate, `${Field.Key} is missing the mode gate`);
    assert.deepEqual(Gate.In, ['webview']);
  }
});

test('a metric with no mode requirement keeps the exact gate shape it had before', () => {
  // The single-condition form is emitted as the original
  // data-visible-when-key/-value attribute pair; collapsing to it matters
  // because everything that predates display modes must render byte-identically.
  const Fields = BuildFreeKioskAlarmFields();
  const Toggle = Fields.find((F) => F.Key === AlarmFieldKeys('battery_level').On);
  assert.deepEqual(Toggle.VisibleWhen, { Key: 'G_Battery_On', Equals: true });

  // A Fixed group emits no switch, so its metrics carry no gate at all.
  const Latency = Fields.find((F) => F.Key === AlarmFieldKeys('poll_latencyMs').On);
  assert.equal(Latency.VisibleWhen, undefined);
});

test('a new terminal starts in WebView mode', () => {
  assert.equal(BuildDefaultAlarmSettings()[DISPLAY_MODE_FIELD_KEY], 'webview');
});

// ---- Which controls survive, and in which mode -----------------------------

test('the mode-setting commands are gone from the map entirely', () => {
  // Removed rather than hidden. FreeKiosk applies a mode change but will not
  // bring itself in front of a running external app, so switching out of app
  // mode remotely left the tablet unchanged while ShowTrak reported success.
  // The map IS the allowlist, so these are unreachable, not merely unlisted.
  const { FREEKIOSK_COMMANDS_BY_ID } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'commands.js')
  );
  for (const ID of ['kiosk.start', 'mode', 'url', 'app.launch']) {
    assert.equal(FREEKIOSK_COMMANDS_BY_ID.get(ID), undefined, ID);
  }
});

test('reload and clear-cache survive, still gated to WebView', () => {
  // Refreshing and clearing the cache are the two content controls worth
  // keeping: both act on the WebView that is already up rather than trying to
  // change what the terminal displays.
  const { FREEKIOSK_COMMANDS } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'commands.js')
  );
  const Gated = {};
  for (const Command of FREEKIOSK_COMMANDS) {
    if (Command.Modes) Gated[Command.ID] = Command.Modes.slice();
  }
  assert.deepEqual(Gated, { reload: ['webview'], clearCache: ['webview'] });
});

test('the mode-independent controls stay available in every mode', () => {
  // Power, brightness, volume and the beep are properties of the tablet, not of
  // what it is displaying. Gating those would leave a media-player terminal with
  // almost no controls at all.
  const { FREEKIOSK_COMMANDS_BY_ID } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'commands.js')
  );
  for (const ID of [
    'wake',
    'screen.on',
    'screen.off',
    'lock',
    'reboot',
    'brightness',
    'screensaver.on',
    'screensaver.off',
    'volume',
    'audio.beep',
    'restart-ui',
  ]) {
    assert.equal(FREEKIOSK_COMMANDS_BY_ID.get(ID).Modes, undefined, ID);
  }
});

test('the display mode is the only thing left in the setup bucket', () => {
  const Fields = BuildFreeKioskAlarmFields();
  const Setup = Fields.filter((F) => F.MetricSection === SETUP_SECTION_KEY).map((F) => F.Key);
  assert.deepEqual(Setup, [DISPLAY_MODE_FIELD_KEY]);
  assert.equal(FREEKIOSK_SECTIONS.includes(SETUP_SECTION_KEY), false);
});

// ---- Commands that take the connection down with them ----------------------

test('reboot and restart are the commands that expect a dropped connection', () => {
  // Both tear down the HTTP server mid-response. Nothing else should claim the
  // exemption, because it converts a transport failure into a reported success.
  const { FREEKIOSK_COMMANDS } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'commands.js')
  );
  const Expecting = FREEKIOSK_COMMANDS.filter((C) => C.ExpectDisconnect).map((C) => C.ID);
  assert.deepEqual(Expecting.sort(), ['reboot', 'restart-ui']);
});

// ---- What the context menu offers ------------------------------------------

test('the bulk context menu carries only what makes sense across a selection', () => {
  // Bulk decides the context menu; the view modal renders every command
  // regardless. Screen Off, the screensaver pair and Beep were dropped from the
  // menu because they are per-device fiddling rather than things worth doing to
  // a whole selection at once — they remain one click away in the view modal.
  const { FREEKIOSK_COMMANDS_BY_ID } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'commands.js')
  );
  for (const ID of ['screen.off', 'screensaver.on', 'screensaver.off', 'audio.beep']) {
    const Command = FREEKIOSK_COMMANDS_BY_ID.get(ID);
    assert.ok(Command, `${ID} must still exist for the view modal`);
    assert.ok(!Command.Bulk, `${ID} must not be offered as a bulk action`);
  }
});

test('the bulk set is exactly what the context menu should show', () => {
  const { FREEKIOSK_COMMANDS } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'FreeKiosk', 'commands.js')
  );
  // A command needing a parameter form is skipped by the menu too, so this is
  // the whole list an operator sees under "FreeKiosk Terminals".
  const Offered = FREEKIOSK_COMMANDS.filter(
    (Command) => Command.Bulk && !(Command.Params && Command.Params.length)
  ).map((Command) => Command.ID);
  assert.deepEqual(Offered, [
    'wake',
    'screen.on',
    'lock',
    'reboot',
    'reload',
    'clearCache',
    'restart-ui',
  ]);
});
