const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises the scope engine in src/UI/js/app/scope-dropdown.ts.
//
// A "scope" answers one question: WHICH machines does this apply to. It backs
// both the alert-rule targets and the per-script whitelist, so a wrong answer
// is not a rendering glitch — it is an alert that never fires for the machine
// that failed, or a destructive script offered to a machine it was explicitly
// restricted away from.
//
// The single most important property is the ROUND TRIP. The dropdown converts
//   stored scope -> selected values -> stored scope
// every time an editor opens and saves. If that is not stable, merely opening a
// rule and pressing save silently changes who it covers, with nothing on screen
// to indicate it.
//
// Two collapse rules carry real meaning and are pinned explicitly:
//   - selecting every entity collapses to Workspace, so a client adopted
//     tomorrow is covered automatically rather than silently falling outside
//     the rule;
//   - selecting all of a group's members collapses to that group, for the same
//     reason at group level.

const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');

const Scope = require(path.join(APP, 'scope-dropdown.js'));
const State = require(path.join(APP, '01-state.js'));

const {
  buildScopeModel,
  parseScopeSelection,
  resolveScopeTargetValues,
  buildScopeFromTargetValues,
  scopeToSelectedValues,
  summarizeScopeSelection,
  scopeClientValueToScopedID,
  buildScopeEntityLabel,
  scopeIconClass,
} = Scope;

const GROUPS = [
  { GroupID: 1, Title: 'FOH', Weight: 10 },
  { GroupID: 2, Title: 'Stage', Weight: 20 },
];

/** Seed the shared entity caches the model is built from. */
function seed({ clients = [], monitors = [], dummies = [] } = {}) {
  State.setAllClients(clients);
  State.setMonitoringTargets(monitors);
  State.setDummyClients(dummies);
}

const client = (O = {}) => ({ UUID: 'c1', Nickname: 'FOH PC', GroupID: 1, Weight: 0, ...O });
const monitor = (O = {}) => ({ TargetID: 1, Nickname: 'UPS', GroupID: 1, Weight: 0, ...O });
const dummy = (O = {}) => ({ UUID: 'd1', Nickname: 'Projector', GroupID: 2, Weight: 0, ...O });

const model = (Options = {}) => buildScopeModel({ Groups: GROUPS, ...Options });

test.beforeEach(() => seed());

// --- Value encoding ---------------------------------------------------------

test('a client value decodes back to its scoped id', () => {
  assert.equal(scopeClientValueToScopedID('client:abc-123'), 'abc-123');
  assert.equal(scopeClientValueToScopedID('client:monitor:7'), 'monitor:7');
  assert.equal(scopeClientValueToScopedID('client:check:3'), 'check:3');
});

test('anything that is not a client value decodes to empty', () => {
  // Returning a truthy fragment for a group value would let a group id leak into
  // the Clients list and target an entity that does not exist.
  for (const Value of ['group:1', 'workspace:*', '', 'abc', null, undefined]) {
    assert.equal(scopeClientValueToScopedID(Value), '', `value ${JSON.stringify(Value)}`);
  }
});

test('an entity label prefers the nickname and appends the hostname once', () => {
  assert.equal(buildScopeEntityLabel('FOH PC', 'foh-01', 'uuid'), 'FOH PC (foh-01)');
  assert.equal(buildScopeEntityLabel('foh-01', 'foh-01', 'uuid'), 'foh-01', 'no duplicate detail');
  assert.equal(buildScopeEntityLabel('', '', ''), 'Unknown Target');
  assert.equal(buildScopeEntityLabel(null, null, 'uuid-fallback'), 'uuid-fallback');
});

test('each entity kind has its own icon', () => {
  assert.equal(scopeIconClass('showtrak'), 'bi-display');
  assert.equal(scopeIconClass('monitor'), 'bi-diagram-3');
  assert.equal(scopeIconClass('monitor-check'), 'bi-diagram-3');
  assert.equal(scopeIconClass('dummy'), 'bi-cpu');
  assert.equal(scopeIconClass('nonsense'), '');
});

// --- Model construction -----------------------------------------------------

test('entities are nested under their group', () => {
  seed({ clients: [client({ UUID: 'c1', GroupID: 1 }), client({ UUID: 'c2', GroupID: 2 })] });
  const Model = model();

  const FOH = Model.Groups.find((G) => G.GroupID === 1);
  const Stage = Model.Groups.find((G) => G.GroupID === 2);
  assert.deepEqual(FOH.ChildValues, ['client:c1']);
  assert.deepEqual(Stage.ChildValues, ['client:c2']);
  assert.deepEqual(Model.Ungrouped, []);
});

test('an entity in no group, or in a group that is not shown, falls to the flat list', () => {
  // It must remain selectable — dropping it would make an entity impossible to
  // target at all.
  seed({ clients: [client({ UUID: 'c1', GroupID: null }), client({ UUID: 'c2', GroupID: 99 })] });
  const Model = model();

  assert.deepEqual(
    Model.Ungrouped.map((E) => E.Value),
    ['client:c1', 'client:c2']
  );
  assert.ok(Model.AllClientValueSet.has('client:c2'));
});

test('all three entity kinds appear, with monitors and dummies scoped', () => {
  // The scoped-id prefixes are the shared slug-namespace convention; without
  // them a monitor and a client could collide on the same numeric id.
  seed({ clients: [client()], monitors: [monitor()], dummies: [dummy()] });
  const Model = model();

  assert.ok(Model.AllClientValueSet.has('client:c1'));
  assert.ok(Model.AllClientValueSet.has('client:monitor:1'));
  assert.ok(Model.AllClientValueSet.has('client:d1'));
});

test('individual monitor checks are selectable in their own right', () => {
  // A rule can target one failing check rather than the whole target.
  seed({
    monitors: [monitor({ Checks: [{ CheckID: 7, Name: 'Battery', Method: 'snmp-ups' }] })],
  });
  const Model = model();

  assert.ok(Model.AllClientValueSet.has('client:check:7'));
  assert.match(Model.LabelByValue.get('client:check:7'), /UPS · Battery/);
});

test('IncludeKinds restricts what the dropdown will offer', () => {
  seed({ clients: [client()], monitors: [monitor()], dummies: [dummy()] });

  const OnlyClients = model({ IncludeKinds: ['showtrak'] });
  assert.deepEqual(OnlyClients.AllClientValues, ['client:c1']);

  const NoChecks = model({ IncludeKinds: ['monitor'] });
  assert.deepEqual(NoChecks.AllClientValues, ['client:monitor:1']);
});

test('integrated clients can be excluded, since they cannot run scripts', () => {
  seed({
    clients: [client({ UUID: 'c1' }), client({ UUID: 'sdk', OperatingSystem: 'Integrated' })],
  });

  assert.equal(model().AllClientValues.length, 2);
  assert.deepEqual(model({ ExcludeIntegrated: true }).AllClientValues, ['client:c1']);
});

test('a caller-supplied filter narrows clients and groups', () => {
  seed({ clients: [client({ UUID: 'c1', GroupID: 1 }), client({ UUID: 'c2', GroupID: 2 })] });

  const Filtered = model({ ClientFilter: (C) => C.UUID === 'c1' });
  assert.deepEqual(Filtered.AllClientValues, ['client:c1']);

  // A group filtered out does not hide its members — they move to the flat list.
  const OneGroup = model({ GroupFilter: (G) => G.GroupID === 1 });
  assert.equal(OneGroup.Groups.length, 1);
  assert.deepEqual(
    OneGroup.Ungrouped.map((E) => E.Value),
    ['client:c2']
  );
});

test('ShowGroups false produces one flat list', () => {
  seed({ clients: [client({ UUID: 'c1', GroupID: 1 }), client({ UUID: 'c2', GroupID: 2 })] });
  const Flat = model({ ShowGroups: false });

  assert.deepEqual(Flat.Groups, []);
  assert.equal(Flat.Ungrouped.length, 2);
  assert.equal(Flat.AllClientValues.length, 2, 'nothing may be lost by flattening');
});

test('entities sort by weight then label, so the tree matches the rig order', () => {
  seed({
    clients: [
      client({ UUID: 'c3', Nickname: 'Zulu', Weight: 1 }),
      client({ UUID: 'c1', Nickname: 'Alpha', Weight: 5 }),
      client({ UUID: 'c2', Nickname: 'Bravo', Weight: 1 }),
    ],
  });
  const FOH = model().Groups.find((G) => G.GroupID === 1);
  assert.deepEqual(FOH.ChildValues, ['client:c2', 'client:c3', 'client:c1']);
});

test('malformed entities are skipped rather than producing unselectable rows', () => {
  seed({
    clients: [null, {}, { UUID: '' }, client({ UUID: 'ok' })],
    monitors: [null, { TargetID: null }],
    dummies: [null, { UUID: null }],
  });
  assert.deepEqual(model().AllClientValues, ['client:ok']);
});

// --- Selection parsing ------------------------------------------------------

test('a selection parses into its three buckets', () => {
  assert.deepEqual(parseScopeSelection(['workspace:*']), {
    Workspace: true,
    Groups: [],
    Clients: [],
  });
  assert.deepEqual(parseScopeSelection(['group:1', 'group:2', 'client:c1']), {
    Workspace: false,
    Groups: [1, 2],
    Clients: ['c1'],
  });
});

test('a scoped client id survives parsing intact', () => {
  // 'client:monitor:7' must yield 'monitor:7', not 'monitor'.
  assert.deepEqual(parseScopeSelection(['client:monitor:7']).Clients, ['monitor:7']);
  assert.deepEqual(parseScopeSelection(['client:check:3']).Clients, ['check:3']);
});

test('unparseable selection entries are dropped, not coerced', () => {
  // A NaN group id would match no group while still counting as a restriction,
  // producing a rule that silently applies to nothing.
  const Parsed = parseScopeSelection(['group:abc', 'nonsense', '', 'group:']);
  assert.deepEqual(Parsed.Groups, []);
  assert.deepEqual(Parsed.Clients, []);
  assert.equal(Parsed.Workspace, false);
});

test('an absent selection parses to an empty scope', () => {
  for (const Value of [[], null, undefined]) {
    assert.deepEqual(parseScopeSelection(Value), { Workspace: false, Groups: [], Clients: [] });
  }
});

// --- Resolving a scope to concrete targets ---------------------------------

test('workspace resolves to every entity currently known', () => {
  // Including ones adopted after the rule was saved — that is the point of
  // storing "workspace" rather than a list.
  seed({ clients: [client({ UUID: 'c1' }), client({ UUID: 'c2', GroupID: 2 })] });
  const Model = model();

  const Values = resolveScopeTargetValues({ Workspace: true }, Model);
  assert.equal(Values.size, 2);
  assert.ok(Values.has('client:c1') && Values.has('client:c2'));
});

test('a group resolves to its current members', () => {
  seed({ clients: [client({ UUID: 'c1', GroupID: 1 }), client({ UUID: 'c2', GroupID: 2 })] });
  const Values = resolveScopeTargetValues({ Groups: [1] }, model());
  assert.deepEqual([...Values], ['client:c1']);
});

test('a client that no longer exists is dropped when resolving', () => {
  // A rule referencing a retired machine must not resurrect it as a phantom
  // target; the membership check against the live model is what prevents that.
  seed({ clients: [client({ UUID: 'c1' })] });
  const Values = resolveScopeTargetValues({ Clients: ['c1', 'deleted-uuid'] }, model());
  assert.deepEqual([...Values], ['client:c1']);
});

test('resolving is defensive about missing inputs', () => {
  const Model = model();
  assert.equal(resolveScopeTargetValues(null, Model).size, 0);
  assert.equal(resolveScopeTargetValues({ Workspace: true }, null).size, 0);
  assert.equal(resolveScopeTargetValues({}, Model).size, 0);
});

// --- Collapse rules ---------------------------------------------------------

test('selecting everything collapses to Workspace, not an exhaustive list', () => {
  // The difference matters later: a client adopted tomorrow is covered by
  // Workspace and would NOT be covered by a frozen list of today's UUIDs.
  seed({ clients: [client({ UUID: 'c1' }), client({ UUID: 'c2', GroupID: 2 })] });
  const Model = model();

  const Built = buildScopeFromTargetValues(Model.AllClientValues, Model);
  assert.deepEqual(Built, { Workspace: true, Groups: [], Clients: [] });
});

test('selecting a whole group collapses to that group', () => {
  seed({
    clients: [
      client({ UUID: 'c1', GroupID: 1 }),
      client({ UUID: 'c2', GroupID: 1 }),
      client({ UUID: 'c3', GroupID: 2 }),
    ],
  });
  const Model = model();

  const Built = buildScopeFromTargetValues(['client:c1', 'client:c2'], Model);
  assert.deepEqual(Built.Groups, [1]);
  assert.deepEqual(Built.Clients, [], 'members must not be listed twice');
});

test('a partially selected group stays as individual clients', () => {
  seed({ clients: [client({ UUID: 'c1', GroupID: 1 }), client({ UUID: 'c2', GroupID: 1 })] });
  const Built = buildScopeFromTargetValues(['client:c1'], model());

  assert.deepEqual(Built.Groups, []);
  assert.deepEqual(Built.Clients, ['c1']);
});

test('an empty group is never collapsed into the scope', () => {
  // Every member of an empty list vacuously satisfies "all selected", so without
  // the length guard the empty Stage group would be bolted onto every scope
  // that was ever built — quietly widening rules to cover anything later moved
  // into it.
  //
  // A third client outside FOH keeps this away from the workspace case: if
  // everything known were selected, the collapse to Workspace would fire first
  // and there would be no per-group decision to observe.
  seed({
    clients: [
      client({ UUID: 'c1', GroupID: 1 }),
      client({ UUID: 'c2', GroupID: 1 }),
      client({ UUID: 'elsewhere', GroupID: null }),
    ],
  });

  const Built = buildScopeFromTargetValues(['client:c1', 'client:c2'], model());

  assert.deepEqual(Built.Groups, [1], 'FOH is fully selected and should collapse');
  assert.ok(!Built.Groups.includes(2), 'the empty Stage group must not be included');
  assert.equal(Built.Workspace, false);
});

test('selecting nothing produces an empty scope, not workspace', () => {
  seed({ clients: [client()] });
  assert.deepEqual(buildScopeFromTargetValues([], model()), {
    Workspace: false,
    Groups: [],
    Clients: [],
  });
});

test('an empty model does not collapse an empty selection to workspace', () => {
  // Every value of an empty AllClientValues is vacuously selected; the length
  // guard is what stops a workspace-wide rule being created out of nothing.
  seed();
  assert.deepEqual(buildScopeFromTargetValues([], model()), {
    Workspace: false,
    Groups: [],
    Clients: [],
  });
});

// --- The round trip ---------------------------------------------------------

test('every scope shape survives resolve -> rebuild unchanged', () => {
  // The property that keeps opening and saving a rule from changing it.
  seed({
    clients: [
      client({ UUID: 'c1', GroupID: 1 }),
      client({ UUID: 'c2', GroupID: 1 }),
      client({ UUID: 'c3', GroupID: 2 }),
      client({ UUID: 'loose', GroupID: null }),
    ],
    monitors: [monitor({ TargetID: 5, GroupID: 2 })],
    dummies: [dummy({ UUID: 'd1', GroupID: null })],
  });
  const Model = model();

  const Cases = [
    { Workspace: true, Groups: [], Clients: [] },
    { Workspace: false, Groups: [1], Clients: [] },
    { Workspace: false, Groups: [], Clients: ['c1'] },
    { Workspace: false, Groups: [1], Clients: ['c3'] },
    { Workspace: false, Groups: [], Clients: ['monitor:5'] },
    { Workspace: false, Groups: [], Clients: ['loose', 'd1'] },
    { Workspace: false, Groups: [], Clients: [] },
  ];

  for (const Original of Cases) {
    const Values = resolveScopeTargetValues(Original, Model);
    const RoundTripped = buildScopeFromTargetValues([...Values], Model);
    assert.deepEqual(
      RoundTripped,
      Original,
      `scope changed on round trip: ${JSON.stringify(Original)}`
    );
  }
});

test('the selection-value round trip is stable too', () => {
  // scope -> selected values -> scope, which is what the dropdown itself does.
  const Cases = [
    { Workspace: true, Groups: [], Clients: [] },
    { Workspace: false, Groups: [1, 2], Clients: ['c1', 'monitor:5'] },
    { Workspace: false, Groups: [], Clients: [] },
  ];
  for (const Original of Cases) {
    assert.deepEqual(
      parseScopeSelection(scopeToSelectedValues(Original)),
      Original,
      `changed on round trip: ${JSON.stringify(Original)}`
    );
  }
});

test('a scope encodes to the stable persisted value format', () => {
  assert.deepEqual(scopeToSelectedValues({ Workspace: true }), ['workspace:*']);
  assert.deepEqual(scopeToSelectedValues({ Groups: [1], Clients: ['c1'] }), [
    'group:1',
    'client:c1',
  ]);
  assert.deepEqual(scopeToSelectedValues(null), []);
  assert.deepEqual(scopeToSelectedValues({}), []);
});

// --- Summaries --------------------------------------------------------------

test('the summary names what is selected, or how much more', () => {
  seed({ clients: [client({ UUID: 'c1', Nickname: 'FOH PC' })] });
  const Model = model();

  assert.equal(summarizeScopeSelection(Model, { Workspace: true }, 'None'), 'All Clients');
  assert.equal(summarizeScopeSelection(Model, { Groups: [1] }, 'None'), 'FOH');
  assert.equal(summarizeScopeSelection(Model, { Groups: [1, 2] }, 'None'), 'FOH +1');
  assert.match(summarizeScopeSelection(Model, { Clients: ['c1'] }, 'None'), /FOH PC/);
});

test('an empty or missing scope shows the placeholder', () => {
  const Model = model();
  assert.equal(summarizeScopeSelection(Model, null, 'Select targets'), 'Select targets');
  assert.equal(summarizeScopeSelection(Model, {}, 'Select targets'), 'Select targets');
});

test('a selected entity the model no longer knows still summarises readably', () => {
  // After a client is deleted the saved rule still references it; showing the
  // raw id is better than an empty chip that looks like nothing is selected.
  const Model = model();
  assert.equal(summarizeScopeSelection(Model, { Clients: ['gone-uuid'] }, 'None'), 'gone-uuid');
  assert.equal(summarizeScopeSelection(Model, { Groups: [42] }, 'None'), 'Group 42');
});
