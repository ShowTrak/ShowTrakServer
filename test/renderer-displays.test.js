const test = require('node:test');
const assert = require('node:assert/strict');

// The Displays section of the client info modal. lib/displays.ts holds the
// decisions (section state, the card's subtitle and badge, the conditions
// table, turning the table back into a request) and is tested directly;
// client-info-displays.ts builds the markup as a pure string function.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/displays.js');
const Displays = require('../dist-test/UI/js/app/client-info-displays.js');

function critical(overrides = {}) {
  return {
    DisplayID: 'edid:DEL:1234:SER1',
    Label: 'Stage Left',
    RequirePresent: true,
    Width: 3840,
    Height: 2160,
    RefreshRate: 60,
    ScaleFactor: null,
    Rotation: null,
    RequirePrimary: false,
    PositionX: null,
    PositionY: null,
    Timestamp: 1,
    ...overrides,
  };
}

function view(overrides = {}) {
  return {
    SessionID: '1',
    ScreenNumber: 2,
    DisplayID: 'edid:DEL:1234:SER1',
    Label: 'Stage Left',
    Width: 1920,
    Height: 1080,
    ScaleFactor: 2,
    RefreshRate: 60,
    Rotation: 0,
    Primary: false,
    Bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    IsConnected: true,
    IsCritical: false,
    Missing: false,
    Mismatch: false,
    Issues: [],
    Critical: null,
    ...overrides,
  };
}

function client(overrides = {}) {
  return { UUID: 'c1', Online: true, Version: '3.21.0', DisplayList: [view()], ...overrides };
}

test('section state: outdated, offline, ok', () => {
  assert.equal(Lib.GetDisplaySectionState(client(), false), 'outdated');
  assert.equal(Lib.GetDisplaySectionState(client({ Online: false }), true), 'offline');
  assert.equal(Lib.GetDisplaySectionState(client(), true), 'ok');
  // Offline, only the critical baselines are listed.
  const offline = client({
    Online: false,
    DisplayList: [view(), view({ IsCritical: true, Critical: critical() })],
  });
  assert.equal(Lib.VisibleDisplays(offline, 'offline').length, 1);
});

test('the subtitle reads in pixels, with refresh, scaling and any rotation', () => {
  assert.equal(Lib.DisplaySummary(view()), '3840 × 2160 · 60 Hz · 200%');
  assert.equal(
    Lib.DisplaySummary(view({ Rotation: 90 })),
    '3840 × 2160 · 60 Hz · 200% · Rotated 90°'
  );
  assert.equal(
    Lib.DisplaySummary(view({ IsConnected: false, Missing: true, Critical: critical() })),
    'Not connected'
  );
  assert.equal(
    Lib.DisplaySummary(view({ IsConnected: false, IsCritical: true, Critical: critical() })),
    'Not reported yet'
  );
});

test('the key is the critical entry id once critical, else the display id', () => {
  assert.equal(Lib.DisplayKey(view()), 'edid:DEL:1234:SER1');
  assert.equal(
    Lib.DisplayKey(view({ IsCritical: true, Critical: critical({ DisplayID: 'session:3' }) })),
    'session:3'
  );
});

test('badge states', () => {
  assert.equal(Lib.DisplayBadge(view()).State, 'plain');
  assert.equal(Lib.DisplayBadge(view({ IsCritical: true, Critical: critical() })).State, 'healthy');
  assert.equal(
    Lib.DisplayBadge(
      view({ IsCritical: true, Critical: critical(), Issues: [{ Kind: 'scale', Message: 'x' }] })
    ).State,
    'issue'
  );
  assert.equal(
    Lib.DisplayBadge(
      view({ IsCritical: true, IsConnected: false, Missing: true, Critical: critical() })
    ).State,
    'missing'
  );
  assert.equal(
    Lib.DisplayBadge(
      view({ IsCritical: true, IsConnected: false, Critical: critical({ RequirePresent: false }) })
    ).State,
    'absent'
  );
});

test('condition rows show the baseline when guarded, the live value when not', () => {
  const rows = Lib.DisplayConditionRows(
    view({
      IsCritical: true,
      Critical: critical({ Width: 1920, Height: 1080 }),
      Issues: [{ Kind: 'resolution', Message: 'Resolution is 3840 × 2160 (expected 1920 × 1080)' }],
    })
  );
  const byField = Object.fromEntries(rows.map((Row) => [Row.Field, Row]));
  assert.deepEqual(
    rows.map((Row) => Row.Field),
    [
      'RequirePresent',
      'CheckResolution',
      'CheckRefreshRate',
      'CheckScale',
      'CheckRotation',
      'RequirePrimary',
      'CheckPosition',
    ]
  );
  assert.equal(byField.CheckResolution.Value, '1920 × 1080');
  assert.equal(byField.CheckResolution.Checked, true);
  assert.match(byField.CheckResolution.Failing, /expected 1920 × 1080/);
  assert.equal(byField.CheckScale.Value, '200%');
  assert.equal(byField.CheckScale.Checked, false);
  assert.equal(byField.CheckPosition.Value, '1920, 0');
  assert.equal(byField.RequirePrimary.Value, 'No');
  assert.equal(byField.RequirePresent.Value, 'Yes');
  // Connected is the point of monitoring a display: always ticked, never editable.
  assert.equal(byField.RequirePresent.Checked, true);
  assert.equal(byField.RequirePresent.Locked, true);
  assert.equal(byField.CheckResolution.Locked, false);
});

test('a disconnected display can only clear conditions', () => {
  const rows = Lib.DisplayConditionRows(
    view({ IsConnected: false, Missing: true, IsCritical: true, Critical: critical() })
  );
  const byField = Object.fromEntries(rows.map((Row) => [Row.Field, Row]));
  assert.equal(byField.CheckResolution.Supported, true); // guarded: can be unticked
  assert.equal(byField.CheckResolution.Value, '3840 × 2160');
  assert.equal(byField.CheckScale.Supported, false);
  assert.equal(byField.CheckScale.Value, 'Unsupported');
  assert.equal(byField.RequirePresent.Supported, true);
});

test('a property the display does not report is unsupported', () => {
  const rows = Lib.DisplayConditionRows(
    view({ RefreshRate: 0, IsCritical: true, Critical: critical({ RefreshRate: null }) })
  );
  assert.equal(rows.find((Row) => Row.Field === 'CheckRefreshRate').Supported, false);
});

test('the form becomes a full request, never carrying the locked connected tick', () => {
  assert.deepEqual(
    Lib.ParseDisplayRuleFields('d1', { RequirePresent: false, CheckRotation: true }),
    {
      DisplayID: 'd1',
      CheckResolution: false,
      CheckRefreshRate: false,
      CheckScale: false,
      CheckRotation: true,
      RequirePrimary: false,
      CheckPosition: false,
    }
  );
});

test('the render key moves with ticks and readings, not with nothing', () => {
  const base = client({ DisplayList: [view({ IsCritical: true, Critical: critical() })] });
  const key = Lib.DisplayRenderKey(base, 'ok');
  assert.equal(Lib.DisplayRenderKey(base, 'ok'), key);
  const ticked = client({
    DisplayList: [view({ IsCritical: true, Critical: critical({ Rotation: 0 }) })],
  });
  assert.notEqual(Lib.DisplayRenderKey(ticked, 'ok'), key);
  const rotated = client({
    DisplayList: [view({ Rotation: 90, IsCritical: true, Critical: critical() })],
  });
  assert.notEqual(Lib.DisplayRenderKey(rotated, 'ok'), key);
});

test('timeline live state', () => {
  const crit = view({ IsCritical: true, Critical: critical() });
  assert.deepEqual(Lib.DisplayTimelineLiveState(crit, false), { State: 'IDLE', Label: 'Idle' });
  assert.deepEqual(Lib.DisplayTimelineLiveState(crit, true), {
    State: 'ONLINE',
    Label: 'Connected',
  });
  assert.deepEqual(
    Lib.DisplayTimelineLiveState(
      { ...crit, Issues: [{ Kind: 'rotation', Message: 'turned' }] },
      true
    ),
    { State: 'DEGRADED', Label: 'turned' }
  );
  assert.deepEqual(
    Lib.DisplayTimelineLiveState({ ...crit, IsConnected: false, Missing: true }, true),
    { State: 'OFFLINE', Label: 'Missing' }
  );
});

// --- client-info-displays.ts: markup ---------------------------------------------

test('a plain card shows the screen number, primary badge and toggle, no table', () => {
  const html = Displays.BuildDisplaySectionHtml(
    client({ DisplayList: [view({ Primary: true })] }),
    'ok'
  );
  assert.match(html, /SHOWTRAK_DISPLAY_NUMBER[^>]*>2</);
  assert.match(html, /SHOWTRAK_AUDIO_DEFAULT_BADGE">Primary/);
  assert.match(html, /SHOWTRAK_TOGGLE_CRITICAL_DISPLAY/);
  assert.match(html, /data-display="edid%3ADEL%3A1234%3ASER1"/);
  assert.doesNotMatch(html, /SHOWTRAK_DISPLAY_CONDITIONS/);
});

test('a critical card carries its conditions table and issues', () => {
  const html = Displays.BuildDisplaySectionHtml(
    client({
      DisplayList: [
        view({
          IsCritical: true,
          Critical: critical({ Rotation: 0 }),
          Issues: [{ Kind: 'rotation', Message: 'Rotation is 90° (expected 0°)' }],
          Mismatch: true,
        }),
      ],
    }),
    'ok'
  );
  assert.match(html, /SHOWTRAK_DISPLAY_CONDITIONS/);
  assert.match(html, /data-rule="CheckRotation"\s+checked/);
  assert.doesNotMatch(html, /data-rule="CheckRotation"[^>]*disabled/);
  assert.match(html, /data-rule="RequirePresent"\s+checked disabled/);
  assert.match(html, /Rotation is 90° \(expected 0°\)/);
  assert.match(html, /is-mismatch-critical/);
});

test('messages: outdated, offline, none reported', () => {
  assert.match(
    Displays.BuildDisplaySectionHtml(client(), 'outdated'),
    /Display Monitoring Unavailable/
  );
  assert.match(
    Displays.BuildDisplaySectionHtml(client({ Online: false }), 'offline'),
    /Client Offline/
  );
  assert.match(
    Displays.BuildDisplaySectionHtml(client({ DisplayList: [] }), 'ok'),
    /No Displays Detected/
  );
});
