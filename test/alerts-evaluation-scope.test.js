const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Which entities an alert rule watches (AlertsManager/evaluation.isScopeMatch).
//
// This is the gate every event passes through, so both failure directions are
// operational: too narrow and the rule never fires for the machine that failed;
// too wide and a show gets alerts for machines nobody asked about.
//
// The module is pure, so it is exercised directly rather than through the
// manager's event plumbing.
const { isScopeMatch } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'AlertsManager', 'evaluation.js')
);

const rule = (Scope) => ({
  Scope: { Workspace: false, Groups: [], Clients: [], Tags: [], ...Scope },
});
const clientCtx = (UUID, GroupID = null) => ({ EntityType: 'client', UUID, GroupID });
const tag = (TagID, Scope) => ({
  TagID,
  Scope: { Workspace: false, Groups: [], Clients: [], Tags: [], ...Scope },
});

test('the direct arms still match: workspace, group, named client', () => {
  assert.equal(isScopeMatch(rule({ Workspace: true }), clientCtx('c1')), true);
  assert.equal(isScopeMatch(rule({ Groups: [3] }), clientCtx('c1', 3)), true);
  assert.equal(isScopeMatch(rule({ Groups: [3] }), clientCtx('c1', 4)), false);
  assert.equal(isScopeMatch(rule({ Clients: ['c1'] }), clientCtx('c1')), true);
  assert.equal(isScopeMatch(rule({ Clients: ['c1'] }), clientCtx('c2')), false);
});

test('a monitoring target matches by its scoped id', () => {
  const Ctx = { EntityType: 'monitor', TargetID: 7, GroupID: null };
  assert.equal(isScopeMatch(rule({ Clients: ['monitor:7'] }), Ctx), true);
  assert.equal(isScopeMatch(rule({ Clients: ['monitor:8'] }), Ctx), false);
});

test('a rule can watch a tag, covering whatever the tag covers', () => {
  const Tags = [tag(1, { Clients: ['c1'], Groups: [9] })];
  const Rule = rule({ Tags: [1] });

  assert.equal(isScopeMatch(Rule, clientCtx('c1'), Tags), true, 'named by the tag');
  assert.equal(isScopeMatch(Rule, clientCtx('c9', 9), Tags), true, 'in a group the tag covers');
  assert.equal(isScopeMatch(Rule, clientCtx('c9', 8), Tags), false);
});

test('a watched tag reaches through the tags it absorbs', () => {
  const Tags = [tag(1, { Tags: [2] }), tag(2, { Clients: ['deep'] })];
  assert.equal(isScopeMatch(rule({ Tags: [1] }), clientCtx('deep'), Tags), true);
  assert.equal(isScopeMatch(rule({ Tags: [1] }), clientCtx('shallow'), Tags), false);
});

test('a tag-watching rule fires for a monitoring target the tag covers', () => {
  const Tags = [tag(1, { Clients: ['monitor:7'] })];
  const Ctx = { EntityType: 'monitor', TargetID: 7, GroupID: null };
  assert.equal(isScopeMatch(rule({ Tags: [1] }), Ctx, Tags), true);
});

test('without the tag list a tag-watching rule matches nothing', () => {
  // The evaluator always passes the list; this pins the safe direction for any
  // caller that does not — a rule that misses, never one that fires wrongly.
  const Tags = [tag(1, { Clients: ['c1'] })];
  assert.equal(isScopeMatch(rule({ Tags: [1] }), clientCtx('c1')), false);
  assert.equal(isScopeMatch(rule({ Tags: [1] }), clientCtx('c1'), Tags), true);
});

test('per-check alerts stay strictly opt-in, ignoring workspace, groups and tags', () => {
  // A broad rule must not fire once per check on top of the aggregated
  // target-level alert, so only an explicit check: entry counts.
  const Tags = [tag(1, { Workspace: true })];
  const Ctx = { EntityType: 'monitor-check', CheckID: 3, GroupID: 1 };

  assert.equal(isScopeMatch(rule({ Workspace: true }), Ctx, Tags), false);
  assert.equal(isScopeMatch(rule({ Groups: [1] }), Ctx, Tags), false);
  assert.equal(isScopeMatch(rule({ Tags: [1] }), Ctx, Tags), false);
  assert.equal(isScopeMatch(rule({ Clients: ['check:3'] }), Ctx, Tags), true);
});

test('an event with no entity id cannot match a non-workspace rule', () => {
  const Tags = [tag(1, { Workspace: true })];
  const Ctx = { EntityType: 'client', UUID: null, GroupID: null };
  assert.equal(isScopeMatch(rule({ Tags: [1] }), Ctx, Tags), false);
  assert.equal(isScopeMatch(rule({ Workspace: true }), Ctx, Tags), true);
});
