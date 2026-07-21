const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Drift guard: the browser `window.API` shim (web-api-shim.ts) must implement
// EXACTLY the same method surface as the Electron desktop bridge (bridge_main.ts).
// If a new IPC method is added to the desktop bridge but not the web shim (or
// vice versa), the shared renderer would break on one surface. This test parses
// both source files and compares their exposed method-name sets.

function readSrc(relative) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', relative), 'utf8');
}

// Extract capitalised object keys of the form `  Name:` (all ShowTrakAPI methods
// are PascalCase). Local helpers in the shim are lowercase and thus excluded.
//
// Anchored to indentation depth: both API surfaces are one flat object literal,
// so every method key sits at the same (shallowest) indent — 2 spaces in
// bridge_main.ts, 4 in the shim where the object is nested inside a function.
// Anything deeper is a wrapped function parameter, not a method. Those are also
// PascalCase here (`Type:`, `Targets:`, `Settings:`), so without this filter
// Prettier splitting a long signature across lines would silently inject phantom
// "methods" and fail the drift guard for a purely cosmetic change.
function extractMethodNames(source) {
  const re = /^([ \t]+)([A-Z]\w+):/gm;
  const matches = [];
  let match;
  while ((match = re.exec(source)) !== null) {
    matches.push({ indent: match[1].length, name: match[2] });
  }
  if (!matches.length) return new Set();
  const KeyIndent = Math.min(...matches.map((Entry) => Entry.indent));
  return new Set(matches.filter((Entry) => Entry.indent === KeyIndent).map((Entry) => Entry.name));
}

// Extract per-method arity where the method is defined inline as an (async)
// arrow function: `Name: async (A: any, B: any) =>`. Methods bound to a shared
// helper (e.g. `SaveShow: nullTuple`) have no parsable parameter list and are
// returned as null (arity comparison is skipped for them).
function extractMethodArities(source) {
  const arities = new Map();
  const re = /^\s+([A-Z]\w+):\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=]*)?=>/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    const params = match[2]
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    arities.set(match[1], params.length);
  }
  return arities;
}

test('Web UI shim implements exactly the desktop window.API surface', () => {
  const bridge = extractMethodNames(readSrc('bridge_main.ts'));
  const shim = extractMethodNames(readSrc(path.join('UI', 'js', 'app', 'web-api-shim.ts')));

  // Sanity: both should be a substantial surface, not an empty parse.
  assert.ok(bridge.size > 90, `expected a large desktop API surface, got ${bridge.size}`);

  const missingInShim = [...bridge].filter((name) => !shim.has(name)).sort();
  const extraInShim = [...shim].filter((name) => !bridge.has(name)).sort();

  assert.deepEqual(
    missingInShim,
    [],
    `Web shim is missing methods present on the desktop bridge: ${missingInShim.join(', ')}`
  );
  assert.deepEqual(
    extraInShim,
    [],
    `Web shim exposes methods absent from the desktop bridge: ${extraInShim.join(', ')}`
  );
});

test('Web UI shim methods take the same number of arguments as the desktop bridge', () => {
  const bridgeAritiesSource = readSrc('bridge_main.ts');
  const shimSource = readSrc(path.join('UI', 'js', 'app', 'web-api-shim.ts'));
  const bridgeArities = extractMethodArities(bridgeAritiesSource);
  const shimArities = extractMethodArities(shimSource);

  // Sanity: the regex should parse the majority of the surface on both sides.
  assert.ok(
    bridgeArities.size > 80,
    `expected many parsable bridge methods, got ${bridgeArities.size}`
  );
  assert.ok(shimArities.size > 50, `expected many parsable shim methods, got ${shimArities.size}`);

  const mismatches = [];
  for (const [name, bridgeArity] of bridgeArities) {
    const shimArity = shimArities.get(name);
    if (shimArity === undefined) continue; // helper-bound shim method; name parity is covered above
    if (shimArity !== bridgeArity) {
      mismatches.push(`${name}: bridge=${bridgeArity} shim=${shimArity}`);
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    `Web shim methods with a different parameter count than the desktop bridge:\n${mismatches.join('\n')}`
  );
});
