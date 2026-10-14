const test = require('node:test');
const assert = require('node:assert/strict');

// Critical displays, the pure half (ClientManager/display.ts): recognising which
// reported display a critical entry refers to, judging it against its
// conditions, the view the renderer draws, and the entry a mark request makes.

const Display = require('../dist/Modules/ClientManager/display');

function display(overrides = {}) {
  return {
    SessionID: '1',
    ScreenNumber: 1,
    DisplayID: 'edid:DEL:1234:SER1',
    HardwareID: 'edid:DEL:1234:SER1',
    IsStableIdentity: true,
    IdentitySource: 'edid',
    Label: 'DELL U2720Q',
    Width: 1920,
    Height: 1080,
    ScaleFactor: 2,
    RefreshRate: 60,
    Rotation: 0,
    Internal: false,
    Primary: true,
    Bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    ...overrides,
  };
}

function critical(overrides = {}) {
  return Display.normalizeCriticalDisplayEntry({
    DisplayID: 'edid:DEL:1234:SER1',
    Label: 'DELL U2720Q',
    RequirePresent: true,
    Width: 3840,
    Height: 2160,
    RefreshRate: 60,
    Timestamp: 1,
    ...overrides,
  });
}

// --- Entries ----------------------------------------------------------------------

test('a row written before conditions existed reads as the old guard: present, resolution, refresh', () => {
  const entry = Display.normalizeCriticalDisplayEntry({
    UUID: 'c1',
    DisplayID: 'edid:DEL:1234:SER1',
    Label: 'Main',
    Width: 3840,
    Height: 2160,
    RefreshRate: 60,
    ScaleFactor: null,
    Timestamp: 5,
  });
  assert.deepEqual(entry, {
    DisplayID: 'edid:DEL:1234:SER1',
    Label: 'Main',
    RequirePresent: true,
    Width: 3840,
    Height: 2160,
    RefreshRate: 60,
    ScaleFactor: null,
    Rotation: null,
    RequirePrimary: false,
    PositionX: null,
    PositionY: null,
    Timestamp: 5,
  });
});

test('normalizing reads sqlite 0/1 and drops half a resolution or position', () => {
  const entry = Display.normalizeCriticalDisplayEntry({
    DisplayID: ' x ',
    RequirePresent: 0,
    RequirePrimary: 1,
    Width: 1920,
    Height: null,
    PositionX: 0,
    PositionY: null,
    Rotation: -90,
  });
  assert.equal(entry.DisplayID, 'x');
  assert.equal(entry.RequirePresent, false);
  assert.equal(entry.RequirePrimary, true);
  assert.equal(entry.Width, null);
  assert.equal(entry.Height, null);
  assert.equal(entry.PositionX, null);
  assert.equal(entry.Rotation, 270);
  assert.equal(Display.normalizeCriticalDisplayEntry({ DisplayID: '' }), null);
});

// --- Readings ---------------------------------------------------------------------

test('resolution is read in physical pixels, independent of scaling', () => {
  const now = Display.displayReadings(display({ Width: 1920, Height: 1080, ScaleFactor: 2 }));
  assert.equal(now.Width, 3840);
  assert.equal(now.Height, 2160);
  assert.equal(now.ScaleFactor, 2);
  // Electron reports a refresh rate of 0 when it cannot read one.
  assert.equal(Display.displayReadings(display({ RefreshRate: 0 })).RefreshRate, null);
});

// --- Identity ---------------------------------------------------------------------

test('an attribute id is matched to the same model whatever mode it is in now', () => {
  assert.equal(Display.DisplayModelKey('attr:DEL:1234:1920x1080@60:e'), 'attr:DEL:1234:e');
  assert.equal(Display.DisplayModelKey('attr:::3840x2160@30:i'), 'attr:::i');
  assert.equal(Display.DisplayModelKey('edid:DEL:1234:SER1'), null);
  assert.equal(Display.IsWeakDisplayID('attr:::1920x1080@60:e'), true);
  assert.equal(Display.IsWeakDisplayID('session:5'), true);
  assert.equal(Display.IsWeakDisplayID('port:linux:DP-1'), false);

  const reported = [display({ DisplayID: 'attr:::3840x2160@30:e', Label: null })];
  const criticals = [critical({ DisplayID: 'attr:::1920x1080@60:e', Label: null })];
  assert.deepEqual(
    [...Display.matchCriticalDisplays(reported, criticals)],
    [['attr:::1920x1080@60:e', 0]]
  );
});

test('two identical attribute-identified displays pair with the baseline each resembles', () => {
  const reported = [
    display({ DisplayID: 'attr:::1280x720@60:e', Width: 1280, Height: 720, ScaleFactor: 1 }),
    display({ DisplayID: 'attr:::1920x1080@50:e', Width: 1920, Height: 1080, ScaleFactor: 1 }),
  ];
  const criticals = [
    critical({ DisplayID: 'attr:::1920x1080@60:e', Width: 1920, Height: 1080, Label: null }),
    critical({ DisplayID: 'attr:::1280x720@50:e', Width: 1280, Height: 720, Label: null }),
  ];
  const matches = Display.matchCriticalDisplays(reported, criticals);
  assert.equal(matches.get('attr:::1920x1080@60:e'), 1);
  assert.equal(matches.get('attr:::1280x720@50:e'), 0);

  // One of them unplugged leaves exactly one entry unmatched.
  const one = Display.matchCriticalDisplays([reported[0]], criticals);
  assert.equal(one.size, 1);
});

test('a display the client could not fingerprint this time is known by its name', () => {
  const weak = display({ DisplayID: 'attr:::3840x2160@60:e', IdentitySource: 'attributes' });
  assert.equal(Display.matchCriticalDisplays([weak], [critical()]).get('edid:DEL:1234:SER1'), 0);
  // And the other way round: marked while weak, now fingerprinted.
  assert.equal(
    Display.matchCriticalDisplays([display()], [critical({ DisplayID: 'session:7' })]).get(
      'session:7'
    ),
    0
  );
});

test('a name never matches two strong ids, nor an ambiguous name', () => {
  const other = display({ DisplayID: 'edid:DEL:1234:SER2' });
  assert.equal(Display.matchCriticalDisplays([other], [critical()]).size, 0);

  const twins = [
    display({ DisplayID: 'attr:::1920x1080@60:e' }),
    display({ DisplayID: 'session:2', SessionID: '2' }),
  ];
  assert.equal(Display.matchCriticalDisplays(twins, [critical()]).size, 0);
});

// --- Judging ----------------------------------------------------------------------

test('each guarded property raises its own issue; unguarded ones are not judged', () => {
  const entry = critical({
    ScaleFactor: 2,
    Rotation: 0,
    RequirePrimary: true,
    PositionX: 0,
    PositionY: 0,
  });
  assert.deepEqual(Display.evaluateDisplayIssues(display(), entry), []);

  const changed = display({
    Width: 1280,
    Height: 720,
    ScaleFactor: 1,
    RefreshRate: 30,
    Rotation: 90,
    Primary: false,
    Bounds: { x: 1920, y: 0, width: 1280, height: 720 },
  });
  assert.deepEqual(
    Display.evaluateDisplayIssues(changed, entry).map((Issue) => Issue.Message),
    [
      'Resolution is 1280 × 720 (expected 3840 × 2160)',
      'Refresh rate is 30 Hz (expected 60 Hz)',
      'Scaling is 100% (expected 200%)',
      'Rotation is 90° (expected 0°)',
      'Not the primary display',
      'Position is 1920, 0 (expected 0, 0)',
    ]
  );

  const onlyRefresh = critical({ Width: null, Height: null });
  assert.deepEqual(
    Display.evaluateDisplayIssues(changed, onlyRefresh).map((Issue) => Issue.Kind),
    ['refresh_rate']
  );
});

test('a scaling change alone is not a resolution change', () => {
  // 4K at 150%: the reported size in points shrinks, the output mode does not.
  const entry = critical({ Width: 3840, Height: 2160 });
  const scaled = display({ Width: 2560, Height: 1440, ScaleFactor: 1.5 });
  assert.deepEqual(Display.evaluateDisplayIssues(scaled, entry), []);
  // A pixel either side from fractional scaling is not a change either.
  const fractional = display({ Width: 3073, Height: 1728, ScaleFactor: 1.25 });
  assert.deepEqual(Display.evaluateDisplayIssues(fractional, entry), []);
});

test('an unknown is never a fault', () => {
  const entry = critical({ Rotation: 0, RequirePrimary: true, PositionX: 0, PositionY: 0 });
  const silent = display({
    RefreshRate: 0,
    Rotation: undefined,
    Primary: undefined,
    Bounds: undefined,
  });
  assert.deepEqual(Display.evaluateDisplayIssues(silent, entry), []);
});

test('absence faults only when presence is required', () => {
  assert.deepEqual(Display.evaluateDisplayIssues(null, critical()), [
    { Kind: 'missing', Message: 'DELL U2720Q is not connected' },
  ]);
  assert.deepEqual(Display.evaluateDisplayIssues(null, critical({ RequirePresent: false })), []);
});

// --- View -------------------------------------------------------------------------

test('the view merges reported and critical displays and warns once per kind', () => {
  const entry = critical({ RefreshRate: 30 });
  const absent = critical({ DisplayID: 'port:linux:DP-2', Label: 'Projector' });
  const result = Display.buildDisplayView([display()], [entry, absent], true);
  assert.equal(result.List.length, 2);
  const [main, projector] = result.List;
  assert.equal(main.IsCritical, true);
  assert.equal(main.Mismatch, true);
  assert.equal(main.Critical.DisplayID, 'edid:DEL:1234:SER1');
  assert.equal(main.CurrentSignature, '3840x2160@60');
  assert.equal(main.ExpectedSignature, '3840x2160@30');
  assert.equal(projector.IsConnected, false);
  assert.equal(projector.Missing, true);
  assert.deepEqual(result.Warnings, ['Display Configuration Changed', 'Missing Display']);
  assert.equal(result.Missing.length, 1);
  assert.equal(result.Mismatched.length, 1);
});

test('nothing is judged before the client has reported on this connection', () => {
  const result = Display.buildDisplayView([], [critical()], false);
  assert.equal(result.List[0].Missing, false);
  assert.deepEqual(result.List[0].Issues, []);
  assert.deepEqual(result.Warnings, []);
  assert.deepEqual(result.Missing, []);
});

test('a display allowed to be absent reads as not connected, never missing', () => {
  const result = Display.buildDisplayView([], [critical({ RequirePresent: false })], true);
  assert.equal(result.List[0].Missing, false);
  assert.deepEqual(result.Warnings, []);
});

// --- Mark requests ----------------------------------------------------------------

test('a first mark guards presence, resolution and refresh rate, as the old guard did', () => {
  const [err, entry] = Display.resolveCriticalDisplayEntry('edid:x', {}, display(), null, 9);
  assert.equal(err, null);
  assert.equal(entry.RequirePresent, true);
  assert.equal(entry.Width, 3840);
  assert.equal(entry.Height, 2160);
  assert.equal(entry.RefreshRate, 60);
  assert.equal(entry.ScaleFactor, null);
  assert.equal(entry.Rotation, null);
  assert.equal(entry.RequirePrimary, false);
  assert.equal(entry.PositionX, null);
  assert.equal(entry.Label, 'DELL U2720Q');
  assert.equal(entry.Timestamp, 9);

  // A display that cannot read its rate is still markable; the rate just is not guarded.
  const [, noRate] = Display.resolveCriticalDisplayEntry(
    'x',
    {},
    display({ RefreshRate: 0 }),
    null,
    1
  );
  assert.equal(noRate.RefreshRate, null);
});

test('ticking a property guards its value now; a guarded one keeps its baseline', () => {
  const existing = critical();
  const changed = display({ Width: 1280, Height: 720, ScaleFactor: 1, Rotation: 90 });
  const [, entry] = Display.resolveCriticalDisplayEntry(
    existing.DisplayID,
    { CheckRotation: true, CheckScale: true, CheckPosition: true, RequirePrimary: true },
    changed,
    existing,
    50
  );
  // Editing other conditions does not quietly accept the new resolution.
  assert.equal(entry.Width, 3840);
  assert.equal(entry.Rotation, 90);
  assert.equal(entry.ScaleFactor, 1);
  assert.equal(entry.PositionX, 0);
  assert.equal(entry.PositionY, 0);
  assert.equal(entry.RequirePrimary, true);
  assert.equal(entry.Timestamp, 1);

  const [, cleared] = Display.resolveCriticalDisplayEntry(
    existing.DisplayID,
    { CheckResolution: false, CheckRefreshRate: false, RequirePresent: false },
    null,
    existing,
    50
  );
  assert.equal(cleared.Width, null);
  assert.equal(cleared.RefreshRate, null);
  assert.equal(cleared.RequirePresent, false);
});

test('a disconnected display cannot capture a new condition', () => {
  const [err, entry] = Display.resolveCriticalDisplayEntry(
    'edid:DEL:1234:SER1',
    { CheckRotation: true },
    null,
    critical(),
    1
  );
  assert.equal(entry, null);
  assert.match(err, /Connect the display to start monitoring its rotation/);
  assert.match(
    Display.resolveCriticalDisplayEntry('x', {}, null, null, 1)[0],
    /not connected to this client/
  );
});
