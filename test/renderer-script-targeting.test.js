const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Exercises src/UI/js/app/lib/script-targeting.ts — the rules that decide which
// machines a script is OFFERED against in the context menu.
//
// Extracted from wire-context-menu.ts, where it was a private function inside a
// 790-line DOM module and therefore untestable.
//
// The authoritative whitelist gate is server-side, in
// ScriptWhitelistManager.IsClientAllowed. This is the renderer's copy, and its
// job is to keep a restricted machine out of the menu in the first place. That
// still matters: a script offered against the wrong machine is a script an
// operator will eventually run on the wrong machine — and scripts are how you
// reboot, shut down or reconfigure a rig mid-show.
//
// Both directions are failures:
//   - too permissive: a script restricted to three machines appears against all
//     of them, and the restriction only takes effect after the operator has
//     already pressed it;
//   - too strict: a legitimate target silently disappears from the menu, and
//     the operator concludes the script is broken.

const TARGETING_PATH = path.join(
  __dirname,
  '..',
  'dist-test',
  'UI',
  'js',
  'app',
  'lib',
  'script-targeting.js'
);

const { IsClientWhitelisted, IsScriptTargetable, ResolveScriptTargets } = require(TARGETING_PATH);

const client = (O = {}) => ({ UUID: 'c1', GroupID: 1, OperatingSystem: 'Windows', ...O });
const script = (O = {}) => ({ CompatiblePlatforms: ['Windows'], Whitelist: null, ...O });

// --- Whitelist admission ----------------------------------------------------

test('a script with no whitelist is unrestricted', () => {
  // The default for every script nobody has narrowed; treating absent as
  // "deny all" would make every existing script vanish from the menu.
  for (const Scope of [null, undefined]) {
    assert.equal(IsClientWhitelisted(Scope, client()), true, `scope ${JSON.stringify(Scope)}`);
  }
});

test('an explicit workspace scope is unrestricted', () => {
  assert.equal(IsClientWhitelisted({ Workspace: true }, client()), true);
  // ...and workspace wins even when the other lists are empty, which is what
  // distinguishes "everyone" from "nobody yet".
  assert.equal(IsClientWhitelisted({ Workspace: true, Clients: [], Groups: [] }, client()), true);
});

test('an empty non-workspace scope admits nobody', () => {
  // The distinction that matters: a scope narrowed to nothing must not fall
  // back to "everyone". That is how a restricted script escapes its restriction.
  assert.equal(IsClientWhitelisted({ Workspace: false }, client()), false);
  assert.equal(IsClientWhitelisted({ Workspace: false, Clients: [], Groups: [] }, client()), false);
});

test('a directly named client is admitted', () => {
  const Scope = { Workspace: false, Clients: ['c1'], Groups: [] };
  assert.equal(IsClientWhitelisted(Scope, client({ UUID: 'c1' })), true);
  assert.equal(IsClientWhitelisted(Scope, client({ UUID: 'c2' })), false);
});

test('a client in a whitelisted group is admitted', () => {
  const Scope = { Workspace: false, Clients: [], Groups: [1] };
  assert.equal(IsClientWhitelisted(Scope, client({ GroupID: 1 })), true);
  assert.equal(IsClientWhitelisted(Scope, client({ GroupID: 2 })), false);
});

test('group membership is compared numerically', () => {
  // Group ids arrive as numbers from the API and as strings from DOM datasets;
  // a strict comparison would silently deny every client on one of those paths.
  const Scope = { Workspace: false, Clients: [], Groups: [1] };
  assert.equal(IsClientWhitelisted(Scope, client({ GroupID: '1' })), true);
});

test('an ungrouped client is never admitted by a group rule', () => {
  const Scope = { Workspace: false, Clients: [], Groups: [1] };
  assert.equal(IsClientWhitelisted(Scope, client({ GroupID: null })), false);
  assert.equal(IsClientWhitelisted(Scope, client({ GroupID: undefined })), false);
});

test('either rule alone is enough', () => {
  const Scope = { Workspace: false, Clients: ['c9'], Groups: [7] };
  assert.equal(IsClientWhitelisted(Scope, client({ UUID: 'c9', GroupID: 1 })), true, 'by uuid');
  assert.equal(IsClientWhitelisted(Scope, client({ UUID: 'c1', GroupID: 7 })), true, 'by group');
  assert.equal(IsClientWhitelisted(Scope, client({ UUID: 'c1', GroupID: 1 })), false);
});

test('a malformed client is denied rather than admitted', () => {
  // Fail closed: an entity we cannot identify must not inherit a whitelist.
  const Scope = { Workspace: false, Clients: ['c1'], Groups: [1] };
  for (const Value of [null, undefined, {}, { UUID: '' }]) {
    assert.equal(IsClientWhitelisted(Scope, Value), false, `client ${JSON.stringify(Value)}`);
  }
});

test('a malformed scope list does not throw or admit', () => {
  for (const Scope of [
    { Workspace: false, Clients: 'c1', Groups: 1 },
    { Workspace: false, Clients: null, Groups: null },
    { Workspace: false },
  ]) {
    assert.equal(IsClientWhitelisted(Scope, client()), false, `scope ${JSON.stringify(Scope)}`);
  }
});

// --- OS compatibility + whitelist together ---------------------------------

test('a script is targetable only when BOTH conditions hold', () => {
  const Restricted = script({ Whitelist: { Workspace: false, Clients: ['c1'], Groups: [] } });

  assert.equal(
    IsScriptTargetable(Restricted, client({ UUID: 'c1', OperatingSystem: 'Windows' })),
    true
  );
  assert.equal(
    IsScriptTargetable(Restricted, client({ UUID: 'c1', OperatingSystem: 'Linux' })),
    false,
    'wrong OS must not be offered even when whitelisted'
  );
  assert.equal(
    IsScriptTargetable(Restricted, client({ UUID: 'c2', OperatingSystem: 'Windows' })),
    false,
    'right OS must not be offered when not whitelisted'
  );
});

test('a client with no reported OS is never a target', () => {
  // A client that has not reported its platform cannot be matched against
  // CompatiblePlatforms, and guessing would run a Windows script on a Mac.
  for (const OperatingSystem of ['', null, undefined]) {
    assert.equal(IsScriptTargetable(script(), client({ OperatingSystem })), false);
  }
  assert.equal(IsScriptTargetable(script(), null), false);
});

test('a script with no compatible platforms targets nothing', () => {
  // Empty means "declared for no platform", which is different from
  // "unrestricted" — the whitelist handles that axis, not this one.
  for (const CompatiblePlatforms of [[], null, undefined, 'Windows']) {
    assert.equal(
      IsScriptTargetable(script({ CompatiblePlatforms }), client()),
      false,
      `platforms ${JSON.stringify(CompatiblePlatforms)}`
    );
  }
});

test('OS matching is exact, not fuzzy', () => {
  // 'Windows' and 'Windows 11' are different values on the wire; matching
  // loosely would offer a script to a platform it was never tested on.
  const Script = script({ CompatiblePlatforms: ['Windows'] });
  assert.equal(IsScriptTargetable(Script, client({ OperatingSystem: 'Windows' })), true);
  assert.equal(IsScriptTargetable(Script, client({ OperatingSystem: 'windows' })), false);
  assert.equal(IsScriptTargetable(Script, client({ OperatingSystem: 'Windows 11' })), false);
});

test('a multi-platform script targets each of its platforms', () => {
  const Script = script({ CompatiblePlatforms: ['Windows', 'Darwin', 'Linux'] });
  for (const OperatingSystem of ['Windows', 'Darwin', 'Linux']) {
    assert.equal(IsScriptTargetable(Script, client({ OperatingSystem })), true, OperatingSystem);
  }
  assert.equal(IsScriptTargetable(Script, client({ OperatingSystem: 'FreeBSD' })), false);
});

// --- Resolving a selection --------------------------------------------------

test('only the admitted subset of a mixed selection is targeted', () => {
  // The behaviour the menu depends on: with a mix, the script shows once and
  // runs for the admitted subset only — it does not run for everyone, and it
  // does not disappear.
  const Script = script({
    CompatiblePlatforms: ['Windows'],
    Whitelist: { Workspace: false, Clients: ['a'], Groups: [7] },
  });

  const Targets = ResolveScriptTargets(Script, [
    client({ UUID: 'a', GroupID: 1 }),
    client({ UUID: 'b', GroupID: 7 }),
    client({ UUID: 'c', GroupID: 1 }),
    client({ UUID: 'd', GroupID: 7, OperatingSystem: 'Linux' }),
  ]);

  assert.deepEqual(Targets, ['a', 'b']);
});

test('a script with no admitted clients resolves to nothing', () => {
  // An empty result is how the caller knows to omit the entry entirely, rather
  // than offering something that would do nothing.
  const Script = script({ Whitelist: { Workspace: false, Clients: ['nobody'], Groups: [] } });
  assert.deepEqual(ResolveScriptTargets(Script, [client(), client({ UUID: 'c2' })]), []);
});

test('an unrestricted script targets every compatible client', () => {
  const Targets = ResolveScriptTargets(script(), [
    client({ UUID: 'a' }),
    client({ UUID: 'b' }),
    client({ UUID: 'c', OperatingSystem: 'Linux' }),
  ]);
  assert.deepEqual(Targets, ['a', 'b']);
});

test('an absent or malformed client list resolves to nothing', () => {
  for (const Clients of [null, undefined, [], 'nope', {}]) {
    assert.deepEqual(
      ResolveScriptTargets(script(), Clients),
      [],
      `clients ${JSON.stringify(Clients)}`
    );
  }
});

test('selection order is preserved, so the menu matches the tile order', () => {
  const Targets = ResolveScriptTargets(script(), [
    client({ UUID: 'third' }),
    client({ UUID: 'first' }),
    client({ UUID: 'second' }),
  ]);
  assert.deepEqual(Targets, ['third', 'first', 'second']);
});
