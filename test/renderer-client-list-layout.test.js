const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/UI/js/app/lib/client-list-layout.ts — the pure layout and
// status rules extracted from client-list.ts (1018 LOC, previously 0%).
//
// This is the first pass of the "extract pure logic" strategy: the decisions
// move into a leaf module that loads with no DOM, the rendering stays put.
//
// What is actually at stake in each rule:
//   - the tile state class is the colour the operator reads across the room to
//     know whether a machine is fine, degraded or dead;
//   - the selectable-ID list is what a group-title click acts on, so if it
//     drops the monitor:/dummy: entries an action the operator believed was
//     group-wide silently skips everything that is not a ShowTrak client;
//   - the merged tile order is the drag/drop ordering, which is how a rig is
//     laid out to match the physical room;
//   - the column count comes from an operator-editable settings row and must
//     never be able to produce a zero-column grid.

const LAYOUT_PATH = path.join(
  __dirname,
  '..',
  'dist-test',
  'UI',
  'js',
  'app',
  'lib',
  'client-list-layout.js'
);

const Layout = require(LAYOUT_PATH);

const client = (O = {}) => ({ UUID: 'c1', GroupID: 1, Weight: 0, ...O });
const monitor = (O = {}) => ({ TargetID: 1, GroupID: 1, Weight: 0, ...O });
const dummy = (O = {}) => ({ UUID: 'd1', GroupID: 1, Weight: 0, ...O });
const group = (O = {}) => ({ GroupID: 1, Title: 'FOH', Weight: 0, ...O });

// --- Status text ------------------------------------------------------------

test('identifying beats every other status', () => {
  // The operator has physically asked "which machine is this?" and is looking
  // at the screen for the answer, so it outranks even a degraded state.
  const Identifying = { Identifying: true, Online: true, Degraded: true, Unassigned: true };
  assert.equal(Layout.GetClientStatusDisplayText(Identifying), 'Identifying');
  assert.equal(Layout.GetClientCompactStatusLabel(Identifying), 'Identifying');

  // ...but only while it is actually online-ish; an offline client that still
  // has a stale Identifying flag would otherwise read as present.
  assert.equal(Layout.GetClientStatusDisplayText({ Online: false, Degraded: false }), 'Offline');
});

test('degraded outranks online, because online alone would look fine', () => {
  assert.equal(Layout.GetClientStatusDisplayText({ Online: true, Degraded: true }), 'Degraded');
  assert.equal(Layout.GetClientStatusDisplayText({ Online: true }), 'Online');
});

test('an unassigned slot reads as Unassigned only on the tile, and only when offline', () => {
  // The two labels differ deliberately: the modal has room for real detail, the
  // tile has to explain a reserved slot that has never had a device.
  assert.equal(Layout.GetClientCompactStatusLabel({ Unassigned: true }), 'Unassigned');
  assert.equal(Layout.GetClientStatusDisplayText({ Unassigned: true }), 'Offline');

  // Ordering: a slot that somehow has a device reporting in shows its real
  // state rather than a stale reservation label.
  assert.equal(Layout.GetClientCompactStatusLabel({ Unassigned: true, Online: true }), 'Online');
  assert.equal(
    Layout.GetClientCompactStatusLabel({ Unassigned: true, Online: true, Degraded: true }),
    'Degraded'
  );
});

test('a client still starting up says so rather than claiming to be Online', () => {
  // The machine is connected but its show software is still launching, so a
  // guard is outstanding. "Online" would claim a health we have not confirmed;
  // "Degraded" would assert a fault we have not established.
  const Starting = { Online: true, Initialising: true };
  assert.equal(Layout.GetClientStatusDisplayText(Starting), 'Starting Up');
  assert.equal(Layout.GetClientCompactStatusLabel(Starting), 'Starting Up');
  // Grey, like an idle monitor — not the green of a machine that is ready.
  assert.equal(Layout.GetClientTileStateClass(Starting), 'IDLE');

  // A published fault outranks it: once something is genuinely degraded, that
  // is what the operator needs to see.
  const Degraded = { Online: true, Initialising: true, Degraded: true };
  assert.equal(Layout.GetClientStatusDisplayText(Degraded), 'Degraded');
  assert.equal(Layout.GetClientTileStateClass(Degraded), 'DEGRADED');
});

test('a missing client is Offline rather than blank or a crash', () => {
  for (const Value of [null, undefined, {}]) {
    assert.equal(Layout.GetClientStatusDisplayText(Value), 'Offline');
    assert.equal(Layout.GetClientCompactStatusLabel(Value), 'Offline');
  }
});

// --- Tile state class -------------------------------------------------------

test('the tile colour follows severity, not presence', () => {
  assert.equal(Layout.GetClientTileStateClass({ Online: true, Degraded: true }), 'DEGRADED');
  assert.equal(Layout.GetClientTileStateClass({ Online: true }), 'ONLINE');
  assert.equal(Layout.GetClientTileStateClass({ Online: false }), '');
});

test('a degraded client shows DEGRADED even while offline', () => {
  // The degraded flag survives the client dropping off, and the reason it is
  // degraded is still what the operator needs to see.
  assert.equal(Layout.GetClientTileStateClass({ Online: false, Degraded: true }), 'DEGRADED');
});

test('a reserved slot greys out instead of alarming red', () => {
  // An unassigned slot has never had a device. Rendering it as offline would
  // read as a fault for something working exactly as intended.
  assert.equal(Layout.GetClientTileStateClass({ Unassigned: true }), 'IDLE');
  assert.equal(Layout.GetClientTileStateClass({ Unassigned: true, Online: true }), 'ONLINE');
  assert.equal(Layout.GetClientTileStateClass({ Unassigned: true, Degraded: true }), 'DEGRADED');
});

test('a missing client produces no state class rather than throwing', () => {
  for (const Value of [null, undefined, {}]) {
    assert.equal(Layout.GetClientTileStateClass(Value), '');
  }
});

// --- Warning text -----------------------------------------------------------

test('the tile shows the first degraded warning', () => {
  assert.equal(
    Layout.GetTileWarningText({ DegradedWarnings: ['Dante device offline', 'Second thing'] }),
    'Dante device offline'
  );
});

test('a degraded client with no usable warning still says something', () => {
  // A client can be marked degraded by a rule that populated no message, and an
  // empty warning band is worse than a generic one — it reads as a render bug.
  for (const Warnings of [[], null, undefined, [''], ['   '], [null]]) {
    assert.equal(
      Layout.GetTileWarningText({ DegradedWarnings: Warnings }),
      'Missing USB Device',
      `warnings ${JSON.stringify(Warnings)}`
    );
  }
  assert.equal(Layout.GetTileWarningText(null), 'Missing USB Device');
});

// --- Column count -----------------------------------------------------------

test('the configured column count is used when it is sane', () => {
  for (const Value of [2, 3, 4, 5, 6, '4']) {
    assert.equal(
      Layout.ParseGroupColumnCount([{ Key: 'UI_GROUP_COLUMN_COUNT', Value }]),
      Number(Value),
      `value ${JSON.stringify(Value)}`
    );
  }
});

test('an out-of-range column count is clamped to a layout that works', () => {
  // A 0 or negative would produce a grid with no columns and an empty screen
  // mid-show; the value comes from a numeric input the operator edits.
  assert.equal(Layout.ParseGroupColumnCount([{ Key: 'UI_GROUP_COLUMN_COUNT', Value: 0 }]), 2);
  assert.equal(Layout.ParseGroupColumnCount([{ Key: 'UI_GROUP_COLUMN_COUNT', Value: -5 }]), 2);
  assert.equal(Layout.ParseGroupColumnCount([{ Key: 'UI_GROUP_COLUMN_COUNT', Value: 99 }]), 6);
});

test('an unreadable column count falls back to the default', () => {
  for (const Settings of [
    [{ Key: 'UI_GROUP_COLUMN_COUNT', Value: 'lots' }],
    [{ Key: 'UI_GROUP_COLUMN_COUNT', Value: null }],
    [{ Key: 'UI_GROUP_COLUMN_COUNT' }],
    [{ Key: 'SOMETHING_ELSE', Value: 5 }],
    [null, undefined],
    [],
    null,
    undefined,
    'not an array',
  ]) {
    assert.equal(Layout.ParseGroupColumnCount(Settings), 2, `settings ${JSON.stringify(Settings)}`);
  }
});

// --- Group label ------------------------------------------------------------

test('a long group label is truncated with an ellipsis that fits', () => {
  // The ellipsis is included in the budget, so the result is never longer than
  // the group tab it has to fit inside.
  assert.equal(Layout.TruncateGroupLabel('Front of House Left'), 'Front of Hous...');
  assert.equal(Layout.TruncateGroupLabel('Front of House Left').length, 16);
  assert.equal(Layout.TruncateGroupLabel('FOH'), 'FOH');
  assert.equal(Layout.TruncateGroupLabel('Exactly16Chars!!'), 'Exactly16Chars!!');
});

test('the truncation length is configurable and never produces a bare ellipsis', () => {
  assert.equal(Layout.TruncateGroupLabel('Projection', 6), 'Pro...');
  // Even at an absurd max the first character survives, so a label is never
  // rendered as punctuation alone.
  assert.equal(Layout.TruncateGroupLabel('Projection', 1), 'P...');
});

test('an empty or missing group label renders as nothing', () => {
  for (const Value of ['', '   ', null, undefined]) {
    assert.equal(Layout.TruncateGroupLabel(Value), '');
  }
});

// --- Group order ------------------------------------------------------------

test('groups render in weight order with the ungrouped bucket appended', () => {
  const Order = Layout.BuildGroupRenderOrder([
    group({ GroupID: 2, Title: 'Stage', Weight: 20 }),
    group({ GroupID: 1, Title: 'FOH', Weight: 10 }),
  ]);

  assert.deepEqual(
    Order.map((G) => G.Title),
    ['FOH', 'Stage', 'No Group']
  );
});

test('the ungrouped bucket is pinned to the bottom by identity, not by weight', () => {
  // Pinning by weight would let a real group given a very high weight sort
  // below the ungrouped bucket and hide itself underneath it.
  const Order = Layout.BuildGroupRenderOrder([
    group({ GroupID: 1, Title: 'Heavy', Weight: 999999 }),
    group({ GroupID: 2, Title: 'Light', Weight: 1 }),
  ]);

  assert.deepEqual(
    Order.map((G) => G.Title),
    ['Light', 'Heavy', 'No Group']
  );
  assert.equal(Order[Order.length - 1].GroupID, null);
});

test('the ungrouped bucket exists even with no groups at all', () => {
  for (const Groups of [[], null, undefined]) {
    const Order = Layout.BuildGroupRenderOrder(Groups);
    assert.equal(Order.length, 1);
    assert.equal(Order[0].GroupID, null);
    assert.equal(Order[0].isFullWidth, true, 'the ungrouped bucket spans the grid');
  }
});

test('building the render order does not mutate the caller’s array', () => {
  // __LastGroups is the live cache; pushing the synthetic bucket into it would
  // add one more "No Group" on every single render.
  const Groups = [group()];
  Layout.BuildGroupRenderOrder(Groups);
  Layout.BuildGroupRenderOrder(Groups);
  assert.equal(Groups.length, 1);
});

test('a group with no weight sorts as zero rather than dropping out', () => {
  const Order = Layout.BuildGroupRenderOrder([
    group({ GroupID: 1, Title: 'Weighted', Weight: 5 }),
    group({ GroupID: 2, Title: 'Unweighted', Weight: undefined }),
  ]);
  assert.deepEqual(
    Order.map((G) => G.Title),
    ['Unweighted', 'Weighted', 'No Group']
  );
});

// --- Group span -------------------------------------------------------------

test('only an explicitly narrow group takes a single column', () => {
  assert.equal(Layout.GetGroupSpan({ isFullWidth: false }, 4), 1);
  assert.equal(Layout.GetGroupSpan({ isFullWidth: true }, 4), 4);
  // Absent means full width: groups created before the flag existed must not
  // silently collapse to one column.
  assert.equal(Layout.GetGroupSpan({}, 4), 4);
  assert.equal(Layout.GetGroupSpan(null, 4), 4);
});

// --- Group membership -------------------------------------------------------

test('a group collects its own clients, monitors and dummies', () => {
  const Members = Layout.SelectGroupMembers(
    1,
    [client({ UUID: 'a', GroupID: 1 }), client({ UUID: 'b', GroupID: 2 })],
    [monitor({ TargetID: 1, GroupID: 1 }), monitor({ TargetID: 2, GroupID: 2 })],
    [dummy({ UUID: 'd1', GroupID: 1 }), dummy({ UUID: 'd2', GroupID: 2 })]
  );

  assert.deepEqual(
    Members.Clients.map((C) => C.UUID),
    ['a']
  );
  assert.deepEqual(
    Members.Monitors.map((M) => M.TargetID),
    [1]
  );
  assert.deepEqual(
    Members.Dummies.map((D) => D.UUID),
    ['d1']
  );
});

test('clients within a group are ordered by weight', () => {
  const Members = Layout.SelectGroupMembers(
    1,
    [
      client({ UUID: 'third', Weight: 30 }),
      client({ UUID: 'first', Weight: 10 }),
      client({ UUID: 'second', Weight: 20 }),
    ],
    [],
    []
  );
  assert.deepEqual(
    Members.Clients.map((C) => C.UUID),
    ['first', 'second', 'third']
  );
});

test('a monitor or dummy with a falsy GroupID lands in the ungrouped bucket', () => {
  // The database can hand back 0 rather than null. Comparing it strictly
  // against null would match no group at all and the entity would vanish from
  // the layout entirely — present in the data, invisible on screen.
  const Members = Layout.SelectGroupMembers(
    null,
    [],
    [monitor({ TargetID: 1, GroupID: 0 }), monitor({ TargetID: 2, GroupID: null })],
    [dummy({ UUID: 'd1', GroupID: undefined })]
  );

  assert.deepEqual(
    Members.Monitors.map((M) => M.TargetID),
    [1, 2]
  );
  assert.equal(Members.Dummies.length, 1);
});

test('an absent entity list is empty, not a crash', () => {
  const Members = Layout.SelectGroupMembers(1, null, undefined, 'nope');
  assert.deepEqual(Members, { Clients: [], Monitors: [], Dummies: [] });
});

test('selecting a group does not reorder the source array', () => {
  const Clients = [client({ UUID: 'b', Weight: 20 }), client({ UUID: 'a', Weight: 10 })];
  Layout.SelectGroupMembers(1, Clients, [], []);
  assert.deepEqual(
    Clients.map((C) => C.UUID),
    ['b', 'a'],
    'the live client cache was sorted in place'
  );
});

// --- Selectable IDs ---------------------------------------------------------

test('a group-title click selects every entity type, using scoped ids', () => {
  // These must mirror the tile data-uuid values exactly. Drop the prefixes and
  // "select the whole group" quietly selects only the ShowTrak clients, so an
  // action the operator believed was group-wide skips the monitors and dummies.
  const Members = Layout.SelectGroupMembers(
    1,
    [client({ UUID: 'client-a' })],
    [monitor({ TargetID: 7 })],
    [dummy({ UUID: 'dummy-a' })]
  );

  assert.deepEqual(Layout.BuildGroupSelectableIDs(Members), [
    'client-a',
    'monitor:7',
    'dummy:dummy-a',
  ]);
});

test('an empty group selects nothing', () => {
  assert.deepEqual(Layout.BuildGroupSelectableIDs({ Clients: [], Monitors: [], Dummies: [] }), []);
});

// --- Merged tile order ------------------------------------------------------

test('all three entity types share one weight-ordered tile sequence', () => {
  // This IS the drag/drop ordering: a rig is laid out to match the physical
  // room, and a client dragged between two monitors has to stay there.
  const Members = {
    Clients: [client({ UUID: 'c-mid', Weight: 20 })],
    Monitors: [monitor({ TargetID: 1, Weight: 10 })],
    Dummies: [dummy({ UUID: 'd-last', Weight: 30 })],
  };

  assert.deepEqual(
    Layout.BuildMergedTiles(Members).map((T) => [T.kind, T.weight]),
    [
      ['monitor', 10],
      ['client', 20],
      ['dummy', 30],
    ]
  );
});

test('a tile with no weight sorts first rather than disappearing', () => {
  const Merged = Layout.BuildMergedTiles({
    Clients: [client({ UUID: 'weighted', Weight: 5 }), client({ UUID: 'new', Weight: undefined })],
    Monitors: [],
    Dummies: [],
  });
  assert.deepEqual(
    Merged.map((T) => T.data.UUID),
    ['new', 'weighted']
  );
});

test('each merged entry carries its own data through untouched', () => {
  const Client = client({ UUID: 'c1', Nickname: 'FOH' });
  const [Entry] = Layout.BuildMergedTiles({ Clients: [Client], Monitors: [], Dummies: [] });
  assert.equal(Entry.kind, 'client');
  assert.equal(Entry.data, Client);
});

// --- Render gating ----------------------------------------------------------

test('a real group stays visible when empty so clients can be dragged into it', () => {
  const Empty = { Clients: [], Monitors: [], Dummies: [] };
  assert.equal(Layout.ShouldRenderGroup(1, Empty), true);
  assert.equal(Layout.ShouldRenderGroup(0, Empty), true);
});

test('the synthetic ungrouped bucket is hidden when it holds nothing', () => {
  assert.equal(Layout.ShouldRenderGroup(null, { Clients: [], Monitors: [], Dummies: [] }), false);
  assert.equal(
    Layout.ShouldRenderGroup(null, { Clients: [], Monitors: [monitor()], Dummies: [] }),
    true,
    'an ungrouped monitor must still be reachable'
  );
  assert.equal(
    Layout.ShouldRenderGroup(null, { Clients: [], Monitors: [], Dummies: [dummy()] }),
    true
  );
});

test('the welcome panel shows only on a genuinely empty install', () => {
  // One group means only the synthetic bucket exists.
  assert.equal(Layout.ShouldShowWelcomePanel(1, [], [], []), true);
  assert.equal(Layout.ShouldShowWelcomePanel(1, null, undefined, null), true);
});

test('the welcome panel is hidden as soon as anything exists', () => {
  // Including the case that only a monitor or only a dummy has been added —
  // telling an operator who just configured a UPS check that they have nothing
  // configured reads as the app having lost their work.
  assert.equal(Layout.ShouldShowWelcomePanel(2, [], [], []), false, 'a real group exists');
  assert.equal(Layout.ShouldShowWelcomePanel(1, [client()], [], []), false);
  assert.equal(Layout.ShouldShowWelcomePanel(1, [], [monitor()], []), false);
  assert.equal(Layout.ShouldShowWelcomePanel(1, [], [], [dummy()]), false);
});
