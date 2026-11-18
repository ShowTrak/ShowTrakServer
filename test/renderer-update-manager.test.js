const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises the pure decision layer of src/UI/js/app/update-manager.ts.
//
// This module decides which machines a client update is pushed to. Two failure
// directions, both bad and both silent:
//
//   - too permissive: a client below v3.4.0 has no remote-update support at all,
//     so "deploying" to it does nothing while the UI reports it as targeted --
//     the operator believes a rig is updated when part of it is not;
//   - too strict: eligible machines are quietly dropped from the deploy, which
//     is only discovered later when versions have drifted across the rig.
//
// The module loads under plain Node with no DOM (jQuery is only touched inside
// the render functions), so the decision functions are tested directly. No
// extraction was needed here -- unlike client-list, the logic was already in
// exported top-level functions.

const MODULE_PATH = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'update-manager.js');

const UpdateManager = require(MODULE_PATH);
const {
  NormalizeVersionToken,
  ParseSemverTuple,
  IsVersionAtLeast,
  IsClientEligibleForSelectedRelease,
  GetUpdateVersionHint,
  GetUpdateProgressPercent,
  GetUpdateStatusText,
  GetUpdateStatusClass,
  MINIMUM_REMOTE_UPDATE_VERSION,
} = UpdateManager;

const client = (O = {}) => ({ UUID: 'client-1', Online: true, Version: '3.13.0', ...O });

// --- Version parsing --------------------------------------------------------

test('a version token is normalised for comparison, not for display', () => {
  // Releases are tagged "v3.14.0" while clients report "3.14.0"; comparing the
  // raw strings would make every client look out of date forever.
  assert.equal(NormalizeVersionToken('v3.14.0'), '3.14.0');
  assert.equal(NormalizeVersionToken('V3.14.0'), '3.14.0');
  assert.equal(NormalizeVersionToken('  3.14.0  '), '3.14.0');
  assert.equal(NormalizeVersionToken('3.14.0-BETA'), '3.14.0-beta');
});

test('an absent version normalises to empty rather than "undefined"', () => {
  for (const Value of [null, undefined, '', 0, false]) {
    assert.equal(NormalizeVersionToken(Value), '', `value ${JSON.stringify(Value)}`);
  }
});

test('only a strict three-part semver parses', () => {
  assert.deepEqual(ParseSemverTuple('3.14.0'), [3, 14, 0]);
  assert.deepEqual(ParseSemverTuple('v3.14.0'), [3, 14, 0], 'the v prefix is tolerated');
  assert.deepEqual(ParseSemverTuple(' 10.2.33 '), [10, 2, 33]);
  // A client on a pre-release is still a known version: its core is what the
  // remote-update minimum is compared against.
  assert.deepEqual(ParseSemverTuple('3.14.0-beta'), [3, 14, 0]);
  assert.deepEqual(ParseSemverTuple('v3.32.0-beta.1'), [3, 32, 0]);
});

test('anything that is not a plain semver fails to parse rather than guessing', () => {
  // Guessing here would be worse than refusing: a client whose version cannot be
  // established must not be treated as new enough to update remotely.
  for (const Value of ['3.14', '3', '3.14.0.1', 'latest', '', null, undefined, {}]) {
    assert.equal(ParseSemverTuple(Value), null, `value ${JSON.stringify(Value)} parsed`);
  }
});

// --- Version comparison -----------------------------------------------------

test('version comparison is numeric per component, not lexical', () => {
  // The case a string compare gets wrong: "3.9.0" > "3.10.0" lexically, so a
  // lexical check would strand every client on a two-digit minor.
  assert.equal(IsVersionAtLeast('3.10.0', [3, 9, 0]), true);
  assert.equal(IsVersionAtLeast('3.9.0', [3, 10, 0]), false);
  assert.equal(IsVersionAtLeast('10.0.0', [9, 99, 99]), true);
});

test('the minimum is inclusive', () => {
  assert.equal(IsVersionAtLeast('3.4.0', [3, 4, 0]), true);
  assert.equal(IsVersionAtLeast('3.3.99', [3, 4, 0]), false);
  assert.equal(IsVersionAtLeast('3.4.1', [3, 4, 0]), true);
});

test('an unparseable version is never at least the minimum', () => {
  // Fail closed: an unknown version means we cannot prove remote update is
  // supported, so we do not claim it is.
  for (const Value of [null, undefined, '', 'unknown', '3.4', 'v3.4.0-rc1']) {
    assert.equal(IsVersionAtLeast(Value, [3, 4, 0]), false, `value ${JSON.stringify(Value)}`);
  }
});

test('the remote-update floor is v3.4.0', () => {
  // Pinned by value: clients below this have no remote-update handler at all, so
  // lowering it would silently produce deploys that do nothing.
  assert.deepEqual(MINIMUM_REMOTE_UPDATE_VERSION, [3, 4, 0]);
});

// --- Eligibility ------------------------------------------------------------

test('an online client on an older supported version is eligible', () => {
  const Result = IsClientEligibleForSelectedRelease(client({ Version: '3.13.0' }), 'v3.14.0');
  assert.equal(Result.eligible, true);
  assert.equal(Result.reason, 'Ready to deploy');
});

test('an offline client is never targeted', () => {
  // Queueing an update for a machine that cannot receive it leaves a pending
  // task the operator has to reason about mid-show.
  const Result = IsClientEligibleForSelectedRelease(client({ Online: false }), 'v3.14.0');
  assert.equal(Result.eligible, false);
  assert.equal(Result.reason, 'Offline');
});

test('a client below the remote-update floor is refused with the reason', () => {
  // The reason text matters: it is what tells the operator to go and update that
  // machine by hand, rather than leaving them to wonder why it never moved.
  const Result = IsClientEligibleForSelectedRelease(client({ Version: '3.3.9' }), 'v3.14.0');
  assert.equal(Result.eligible, false);
  assert.match(Result.reason, /Manual update required/);
  assert.match(Result.reason, /3\.4\.0/);
});

test('a client already on the selected version is skipped', () => {
  // Both spellings, since the release is tagged with a v and the client is not.
  for (const [ClientVersion, Tag] of [
    ['3.14.0', 'v3.14.0'],
    ['v3.14.0', '3.14.0'],
    ['3.14.0', '3.14.0'],
    ['V3.14.0', 'v3.14.0'],
  ]) {
    const Result = IsClientEligibleForSelectedRelease(client({ Version: ClientVersion }), Tag);
    assert.equal(Result.eligible, false, `${ClientVersion} vs ${Tag}`);
    assert.equal(Result.reason, 'Already on selected version');
  }
});

test('no selected release means nothing is eligible', () => {
  for (const Tag of ['', '   ', null, undefined]) {
    const Result = IsClientEligibleForSelectedRelease(client(), Tag);
    assert.equal(Result.eligible, false, `tag ${JSON.stringify(Tag)}`);
    assert.equal(Result.reason, 'Select a release');
  }
});

test('a downgrade is allowed, because rolling back is a real operation', () => {
  // Deliberate: the guard is "already on this version", not "older than this
  // version". Pinning a rig back to a known-good build is exactly what the
  // release picker is for.
  const Result = IsClientEligibleForSelectedRelease(client({ Version: '3.14.0' }), 'v3.13.0');
  assert.equal(Result.eligible, true);
});

test('a malformed client is refused rather than crashing the list render', () => {
  for (const Value of [null, undefined, {}, { Online: true }]) {
    const Result = IsClientEligibleForSelectedRelease(Value, 'v3.14.0');
    assert.equal(Result.eligible, false, `client ${JSON.stringify(Value)}`);
    assert.equal(Result.reason, 'Unknown client');
  }
});

test('the version check runs before the already-current check', () => {
  // An ancient client that happens to match the tag must still report "manual
  // update required" -- saying "current" would imply it is fine when it cannot
  // be updated remotely at all.
  const Result = IsClientEligibleForSelectedRelease(client({ Version: '3.3.0' }), 'v3.3.0');
  assert.match(Result.reason, /Manual update required/);
});

// --- The operator-facing hint ----------------------------------------------

test('the hint explains every ineligible case in the operator’s language', () => {
  const Cases = [
    [client(), '', { eligible: false, reason: 'Select a release' }, 'Select release', 'MUTED'],
    [
      client({ Online: false }),
      'v3.14.0',
      { eligible: false, reason: 'Offline' },
      'Offline',
      'MUTED',
    ],
    [
      client({ Version: '3.3.0' }),
      'v3.14.0',
      { eligible: false, reason: 'Manual update required (< 3.4.0)' },
      'Manual only',
      'WARNING',
    ],
    [
      client({ Version: '3.14.0' }),
      'v3.14.0',
      { eligible: false, reason: 'Already on selected version' },
      'Current',
      'SUCCESS',
    ],
    [client(), 'v3.14.0', { eligible: true, reason: 'Ready to deploy' }, 'Ready', 'INFO'],
  ];

  for (const [Client, Tag, Eligibility, Text, ClassName] of Cases) {
    const Hint = GetUpdateVersionHint(Client, Tag, Eligibility);
    assert.equal(Hint.text, Text, `${Text}: wrong text`);
    assert.equal(Hint.className, ClassName, `${Text}: wrong class`);
    assert.ok(Hint.title && Hint.title.length > 0, `${Text}: no tooltip`);
  }
});

test('the "manual only" hint is a WARNING, not a muted aside', () => {
  // It is the only case that needs the operator to physically do something, so
  // it must not read like the ordinary "not applicable" states.
  const Hint = GetUpdateVersionHint(client({ Version: '3.3.0' }), 'v3.14.0', {
    eligible: false,
    reason: 'Manual update required (< 3.4.0)',
  });
  assert.equal(Hint.className, 'WARNING');
  assert.notEqual(Hint.className, 'MUTED');
});

test('offline is reported before any version reasoning', () => {
  // A client that is both offline and outdated is offline first: that is the
  // thing the operator can actually act on.
  const Hint = GetUpdateVersionHint(client({ Online: false, Version: '3.3.0' }), 'v3.14.0', {
    eligible: false,
    reason: 'Manual update required (< 3.4.0)',
  });
  assert.equal(Hint.text, 'Offline');
});

test('an unrecognised reason still produces a usable hint', () => {
  const Hint = GetUpdateVersionHint(client(), 'v3.14.0', {
    eligible: false,
    reason: 'Something new',
  });
  assert.equal(Hint.text, 'Something new');
  assert.equal(Hint.className, 'MUTED');

  const Empty = GetUpdateVersionHint(client(), 'v3.14.0', { eligible: false, reason: '' });
  assert.equal(Empty.text, 'Unavailable');
});

test('a missing eligibility object does not break the hint', () => {
  for (const Value of [null, undefined, {}]) {
    assert.doesNotThrow(() => GetUpdateVersionHint(client(), 'v3.14.0', Value));
  }
});

// --- Progress and status ----------------------------------------------------

test('a completed execution is 100% regardless of the reported progress', () => {
  // The final progress event can be missed; the terminal status is authoritative,
  // or a finished client sits at 97% forever.
  assert.equal(GetUpdateProgressPercent({ Status: 'Completed', Progress: 3 }), 100);
  assert.equal(GetUpdateProgressPercent({ Status: 'Completed' }), 100);
});

test('progress is clamped into 0-100 and rounded', () => {
  assert.equal(GetUpdateProgressPercent({ Progress: 45.6 }), 46);
  assert.equal(GetUpdateProgressPercent({ Progress: -10 }), 0);
  assert.equal(GetUpdateProgressPercent({ Progress: 250 }), 100);
});

test('unusable progress reads as zero, never NaN', () => {
  // NaN would render as "NaN%" in the operator's face and break the bar width.
  for (const Value of [null, undefined, 'soon', {}, NaN, Infinity]) {
    assert.equal(GetUpdateProgressPercent({ Progress: Value }), 0, `progress ${String(Value)}`);
  }
  assert.equal(GetUpdateProgressPercent(null), 0);
});

test('status text prefers the specific failure over a generic one', () => {
  // A failed update the operator cannot diagnose is a machine they have to visit.
  assert.equal(
    GetUpdateStatusText({ Status: 'Failed', Error: 'checksum mismatch', StatusText: 'x' }),
    'checksum mismatch'
  );
  assert.equal(
    GetUpdateStatusText({ Status: 'Failed', StatusText: 'Install refused' }),
    'Install refused'
  );
  assert.equal(GetUpdateStatusText({ Status: 'Failed' }), 'Failed');
});

test('status text covers the non-failure states', () => {
  assert.equal(GetUpdateStatusText(null), 'Ready to update');
  assert.equal(GetUpdateStatusText({ Status: 'Completed' }), 'Updated');
  assert.equal(
    GetUpdateStatusText({ Status: 'Running', StatusText: 'Downloading' }),
    'Downloading'
  );
  assert.equal(GetUpdateStatusText({ Status: 'Running' }), 'Pending');
});

test('the online/offline colour is case-insensitive and defaults to muted', () => {
  assert.equal(GetUpdateStatusClass('Online'), 'text-success');
  assert.equal(GetUpdateStatusClass('ONLINE'), 'text-success');
  assert.equal(GetUpdateStatusClass('offline'), 'text-danger');
  for (const Value of ['degraded', '', null, undefined, 'anything']) {
    assert.equal(GetUpdateStatusClass(Value), 'text-muted', `status ${JSON.stringify(Value)}`);
  }
});

// --- The client list's live redraw ------------------------------------------
//
// The open Update Manager is redrawn on every client heartbeat. It used to sort
// and rebuild every row each time; now each draw is planned against the last
// one, so a heartbeat that changes nothing the list shows changes nothing on
// screen, and one that does replaces only its own row.

const {
  BuildUpdateManagerListModel,
  PlanUpdateManagerListPatch,
  UpdateManagerRenderedFrom,
  UpdateManagerRowHtml,
} = UpdateManager;

const NoExecution = () => null;
const listOf = (Clients, Tag = 'v3.20.0', Selected = new Set()) =>
  BuildUpdateManagerListModel(Clients, Tag, Selected, NoExecution);

test('the list is sorted by name, case-insensitively', () => {
  const Model = listOf([
    client({ UUID: 'b', Nickname: 'beta' }),
    client({ UUID: 'a', Nickname: 'Alpha' }),
    client({ UUID: 'c', Hostname: 'charlie' }),
  ]);
  assert.deepEqual(
    Model.Rows.map((Row) => Row.UUID),
    ['a', 'b', 'c']
  );
});

test('no clients draws the empty state rather than rows', () => {
  const Model = listOf([]);
  assert.equal(Model.Rows.length, 0);
  assert.match(Model.EmptyHtml, /No clients found/);
});

test('a heartbeat that changes nothing shown plans no row changes', () => {
  const Before = listOf([
    client({ UUID: 'a', Nickname: 'A' }),
    client({ UUID: 'b', Nickname: 'B' }),
  ]);
  // Vitals and uptime are not on the Update Manager's rows.
  const After = listOf([
    client({ UUID: 'a', Nickname: 'A', Vitals: { Cpu: { UsagePercentage: 50 } } }),
    client({ UUID: 'b', Nickname: 'B', Uptime: 123 }),
  ]);
  const Plan = PlanUpdateManagerListPatch(UpdateManagerRenderedFrom(Before), After);
  assert.deepEqual(Plan, { Full: false, Changed: [] });
});

test('a change to one client replaces only its row', () => {
  const Before = listOf([
    client({ UUID: 'a', Nickname: 'A' }),
    client({ UUID: 'b', Nickname: 'B' }),
  ]);
  const After = listOf([
    client({ UUID: 'a', Nickname: 'A' }),
    client({ UUID: 'b', Nickname: 'B', Online: false }),
  ]);
  const Plan = PlanUpdateManagerListPatch(UpdateManagerRenderedFrom(Before), After);
  assert.deepEqual(Plan, { Full: false, Changed: [1] });
});

test('a tick alone is not a row change, but it is in the drawn markup', () => {
  const Clients = [client({ UUID: 'a', Nickname: 'A' })];
  const Before = listOf(Clients, 'v3.20.0', new Set());
  const After = listOf(Clients, 'v3.20.0', new Set(['a']));
  // Redrawing the row for its tick would take focus off the box just clicked.
  assert.deepEqual(PlanUpdateManagerListPatch(UpdateManagerRenderedFrom(Before), After), {
    Full: false,
    Changed: [],
  });
  assert.equal(After.Rows[0].Checked, true);
  assert.match(UpdateManagerRowHtml(After.Rows[0]), /\schecked\s/);
  assert.doesNotMatch(UpdateManagerRowHtml(Before.Rows[0]), /\schecked\s/);
});

test('a new, removed or reordered client redraws the whole list', () => {
  const Before = UpdateManagerRenderedFrom(
    listOf([client({ UUID: 'a', Nickname: 'A' }), client({ UUID: 'b', Nickname: 'B' })])
  );
  const Added = listOf([
    client({ UUID: 'a', Nickname: 'A' }),
    client({ UUID: 'b', Nickname: 'B' }),
    client({ UUID: 'c', Nickname: 'C' }),
  ]);
  const Removed = listOf([client({ UUID: 'a', Nickname: 'A' })]);
  const Renamed = listOf([
    client({ UUID: 'a', Nickname: 'Z' }),
    client({ UUID: 'b', Nickname: 'B' }),
  ]);
  assert.deepEqual(PlanUpdateManagerListPatch(Before, Added), { Full: true });
  assert.deepEqual(PlanUpdateManagerListPatch(Before, Removed), { Full: true });
  assert.deepEqual(PlanUpdateManagerListPatch(Before, Renamed), { Full: true });
  assert.deepEqual(PlanUpdateManagerListPatch(null, Added), { Full: true });
});

test('a client dropping below the remote-update floor redraws for the warning', () => {
  const Before = UpdateManagerRenderedFrom(listOf([client({ UUID: 'a', Nickname: 'A' })]));
  const After = listOf([client({ UUID: 'a', Nickname: 'A', Version: '3.3.0' })]);
  assert.match(After.WarningHtml, /Manual Update Required/);
  assert.deepEqual(PlanUpdateManagerListPatch(Before, After), { Full: true });
});
