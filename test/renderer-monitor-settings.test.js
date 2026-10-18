const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/monitor-settings.ts: the payload a monitor's
// Settings tab autosaves, and reordering its checks by drag and drop. The DOM
// side (monitor-info-edit.ts) is a thin adapter over this.
//
// The server deletes any check a save leaves out, so most of these pin that
// every check always travels, whole.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  BuildMonitorUpdatePayload,
  CheckOrderChanged,
  ParseMonitorInterval,
  ReorderChecks,
} = require('../dist-test/UI/js/app/lib/monitor-settings.js');

const CHECK = (CheckID, Extra = {}) => ({
  CheckID,
  Name: `Check ${CheckID}`,
  Address: ` 10.0.0.${CheckID} `,
  Method: 'ping',
  Settings: { Count: CheckID },
  DegradedThresholdMs: 250,
  FailureThreshold: null,
  ...Extra,
});

const TARGET = {
  GroupID: 4,
  Slug: 'stage-projector',
  Checks: [CHECK(1), CHECK(2), CHECK(3)],
};

const EDITS = {
  Nickname: 'Stage Projector',
  Slug: 'stage-projector',
  Interval: 15000,
  FailureThreshold: 3,
};

test('a save carries the edited fields, the untouched group and every check', () => {
  const Payload = BuildMonitorUpdatePayload(TARGET, EDITS);
  assert.equal(Payload.Nickname, 'Stage Projector');
  assert.equal(Payload.Interval, 15000);
  assert.equal(Payload.FailureThreshold, 3);
  assert.equal(Payload.GroupID, 4);
  assert.deepEqual(
    Payload.Checks.map((Check) => Check.CheckID),
    [1, 2, 3]
  );
  assert.deepEqual(Payload.Checks[0], {
    CheckID: 1,
    Name: 'Check 1',
    Address: '10.0.0.1',
    Method: 'ping',
    Settings: { Count: 1 },
    DegradedThresholdMs: 250,
    FailureThreshold: null,
  });
});

test('a monitor with no name is not saved', () => {
  assert.equal(BuildMonitorUpdatePayload(TARGET, { ...EDITS, Nickname: '   ' }), null);
});

test('the slug travels only when changed, and emptying it keeps the old one', () => {
  assert.equal('Slug' in BuildMonitorUpdatePayload(TARGET, EDITS), false);
  assert.equal('Slug' in BuildMonitorUpdatePayload(TARGET, { ...EDITS, Slug: '' }), false);
  assert.equal(
    BuildMonitorUpdatePayload(TARGET, { ...EDITS, Slug: ' foh-projector ' }).Slug,
    'foh-projector'
  );
});

test('an inherited failure threshold is sent as null', () => {
  assert.equal(
    BuildMonitorUpdatePayload(TARGET, { ...EDITS, FailureThreshold: null }).FailureThreshold,
    null
  );
});

test('a reorder sends the checks in the dragged order', () => {
  const Payload = BuildMonitorUpdatePayload(TARGET, EDITS, [3, 1, 2]);
  assert.deepEqual(
    Payload.Checks.map((Check) => Check.CheckID),
    [3, 1, 2]
  );
});

test('a check missing from the dragged order is kept, never dropped', () => {
  // Added elsewhere mid-drag: leaving it out of the save would delete it.
  assert.deepEqual(
    ReorderChecks(TARGET.Checks, [2, 1]).map((Check) => Check.CheckID),
    [2, 1, 3]
  );
  // An ID that no longer exists (deleted elsewhere) is ignored.
  assert.deepEqual(
    ReorderChecks(TARGET.Checks, [9, 3]).map((Check) => Check.CheckID),
    [3, 1, 2]
  );
  assert.deepEqual(
    ReorderChecks(TARGET.Checks, null).map((Check) => Check.CheckID),
    [1, 2, 3]
  );
});

test('a drop back where it started is not a change', () => {
  assert.equal(CheckOrderChanged([1, 2, 3], [1, 2, 3]), false);
  assert.equal(CheckOrderChanged([1, 2, 3], [2, 1, 3]), true);
  assert.equal(CheckOrderChanged([1, 2], [1, 2, 3]), true);
});

test('an unreadable interval falls back to the 30 second default', () => {
  assert.equal(ParseMonitorInterval('45000'), 45000);
  assert.equal(ParseMonitorInterval(''), 30000);
  assert.equal(ParseMonitorInterval('0'), 30000);
  assert.equal(ParseMonitorInterval(undefined), 30000);
});
