const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Scope matching: does this scope cover this machine?
//
// The same question is asked on both sides of the app — the server decides
// whether an alert fires or a script may run, the renderer decides which tags
// badge a tile and which scripts appear in a menu — so the logic exists TWICE,
// once per process (the renderer is bundled for the browser and cannot import
// main-process modules). This file runs the SAME cases against both copies, so
// the mirrors cannot drift apart silently.
//
// The arm that needs the care is Tags. A tag's membership is itself a scope
// which may name further tags, so resolving one is a graph walk over data the
// operator authored by hand — including, inevitably, cycles.

const SERVER = require(path.join(__dirname, '..', 'dist', 'Modules', 'ScopeMatching', 'index.js'));
const RENDERER = require(
  path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app', 'lib', 'scope-matching.js')
);

const IMPLEMENTATIONS = [
  ['server', SERVER],
  ['renderer', RENDERER],
];

const scope = (O = {}) => ({ Workspace: false, Groups: [], Clients: [], Tags: [], ...O });
const entity = (ScopedID, GroupID = null) => ({ ScopedID, GroupID });
const tag = (TagID, Scope) => ({ TagID, Scope: scope(Scope) });

for (const [Name, Impl] of IMPLEMENTATIONS) {
  const { ScopeCoversEntity, NormalizeScopeTags } = Impl;

  test(`[${Name}] the direct arms: workspace, named client, member of a group`, () => {
    assert.equal(ScopeCoversEntity(scope({ Workspace: true }), entity('anything')), true);
    assert.equal(ScopeCoversEntity(scope({ Clients: ['c1'] }), entity('c1')), true);
    assert.equal(ScopeCoversEntity(scope({ Clients: ['c1'] }), entity('c2')), false);
    assert.equal(ScopeCoversEntity(scope({ Groups: [4] }), entity('c1', 4)), true);
    assert.equal(ScopeCoversEntity(scope({ Groups: [4] }), entity('c1', 5)), false);
    assert.equal(ScopeCoversEntity(scope({ Groups: [4] }), entity('c1', null)), false);
  });

  test(`[${Name}] a group id compares numerically, however it was stored`, () => {
    assert.equal(ScopeCoversEntity(scope({ Groups: ['4'] }), entity('c1', 4)), true);
    assert.equal(ScopeCoversEntity(scope({ Groups: [4] }), entity('c1', '4')), true);
  });

  test(`[${Name}] an empty scope covers nothing`, () => {
    // The callers disagree about what an ABSENT scope means, but an empty one
    // is unambiguous: nothing was chosen, so nothing is covered.
    assert.equal(ScopeCoversEntity(scope(), entity('c1', 1)), false);
    assert.equal(ScopeCoversEntity(null, entity('c1')), false);
    assert.equal(ScopeCoversEntity(scope({ Workspace: true }), null), false);
    assert.equal(ScopeCoversEntity(scope({ Workspace: true }), entity('')), false);
  });

  test(`[${Name}] a scoped id must match exactly, prefix included`, () => {
    // 'monitor:7' and the client whose UUID is '7' are different machines.
    assert.equal(ScopeCoversEntity(scope({ Clients: ['monitor:7'] }), entity('monitor:7')), true);
    assert.equal(ScopeCoversEntity(scope({ Clients: ['monitor:7'] }), entity('7')), false);
  });

  test(`[${Name}] a tag arm covers whatever the tag covers`, () => {
    const Tags = [tag(1, { Clients: ['c1'], Groups: [2] })];
    const S = scope({ Tags: [1] });
    assert.equal(ScopeCoversEntity(S, entity('c1'), Tags), true);
    assert.equal(ScopeCoversEntity(S, entity('c9', 2), Tags), true);
    assert.equal(ScopeCoversEntity(S, entity('c9', 3), Tags), false);
  });

  test(`[${Name}] tags nest, so a superset tag reaches through its members`, () => {
    // "all-av" absorbs "video", which names the machine. This is the whole
    // point of a tag being selectable inside another tag's scope.
    const Tags = [tag(1, { Tags: [2] }), tag(2, { Tags: [3] }), tag(3, { Clients: ['deep'] })];
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('deep'), Tags), true);
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('elsewhere'), Tags), false);
  });

  test(`[${Name}] a cycle terminates rather than hanging the app`, () => {
    // Authored across two edits (A adds B, then B adds A), so it is reachable
    // and has to resolve — an infinite walk here would freeze a live show.
    const Tags = [tag(1, { Tags: [2] }), tag(2, { Tags: [1], Clients: ['in'] })];
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('in'), Tags), true);
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('out'), Tags), false);
  });

  test(`[${Name}] a self-referencing tag is inert, not fatal`, () => {
    const Tags = [tag(1, { Tags: [1], Clients: ['in'] })];
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('in'), Tags), true);
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('out'), Tags), false);
  });

  test(`[${Name}] a tag that no longer exists contributes no members`, () => {
    // A deleted tag still named by a saved scope must narrow the scope, never
    // widen it — silently covering everything would be the dangerous failure.
    assert.equal(ScopeCoversEntity(scope({ Tags: [99] }), entity('c1', 1), []), false);
    assert.equal(ScopeCoversEntity(scope({ Tags: [99] }), entity('c1', 1)), false);
  });

  test(`[${Name}] a workspace tag pulls everything in`, () => {
    const Tags = [tag(1, { Workspace: true })];
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('anything'), Tags), true);
  });

  test(`[${Name}] tag ids are coerced and junk is dropped`, () => {
    assert.deepEqual(NormalizeScopeTags(['3', 3, 0, -1, 1.5, 'x', null, {}]), [3]);
    assert.deepEqual(NormalizeScopeTags(null), []);
    assert.deepEqual(NormalizeScopeTags('nope'), []);
  });

  test(`[${Name}] a malformed tag list is tolerated`, () => {
    const Tags = [null, {}, { TagID: 'x' }, tag(1, { Clients: ['c1'] })];
    assert.equal(ScopeCoversEntity(scope({ Tags: [1] }), entity('c1'), Tags), true);
  });
}

// --- Renderer-only: WHY a scope covers an entity -----------------------------
// The renderer additionally needs the route, because only a directly-named
// machine can be removed from one client's editor; everything else would mean
// rewriting the scope for every other machine it covers.

test('the renderer reports which arm matched, direct first', () => {
  const { ScopeMembershipKindFor } = RENDERER;
  const Tags = [tag(1, { Clients: ['c1'] })];

  assert.equal(ScopeMembershipKindFor(scope({ Clients: ['c1'] }), entity('c1', 2)), 'direct');
  assert.equal(ScopeMembershipKindFor(scope({ Workspace: true }), entity('c1')), 'workspace');
  assert.equal(ScopeMembershipKindFor(scope({ Groups: [2] }), entity('c1', 2)), 'group');
  assert.equal(ScopeMembershipKindFor(scope({ Tags: [1] }), entity('c1'), Tags), 'tag');
  assert.equal(ScopeMembershipKindFor(scope(), entity('c1', 2)), null);

  // Direct outranks the rest: it is the one the editor may revoke.
  assert.equal(
    ScopeMembershipKindFor(
      scope({ Clients: ['c1'], Workspace: true, Tags: [1] }),
      entity('c1', 2),
      Tags
    ),
    'direct'
  );
});
