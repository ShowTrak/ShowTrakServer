const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { INVOKE_CHANNELS, SUBSCRIBE_CHANNELS } = require('../src/Modules/IPCRegistry/channels');

const SRC_DIR = path.join(__dirname, '..', 'src');

// Recursively collect .js files under a directory.
function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Extract the string literal channel names passed to a given call form, e.g.
// RPC.handle('X', ...) -> ['X'].
function extractCallChannels(source, callPattern) {
  const names = new Set();
  const regex = new RegExp(`${callPattern}\\(\\s*'([^']+)'`, 'g');
  let match;
  while ((match = regex.exec(source)) !== null) {
    names.add(match[1]);
  }
  return names;
}

// Main process source: main.js plus any registrar modules under src/main.
function readMainProcessSource() {
  const files = [path.join(SRC_DIR, 'main.js'), ...collectJsFiles(path.join(SRC_DIR, 'main'))];
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

test('every RPC.handle channel is declared in the INVOKE registry', () => {
  const source = readMainProcessSource();
  const handlerChannels = extractCallChannels(source, 'RPC\\.handle');
  const registry = new Set(INVOKE_CHANNELS);

  const undeclared = [...handlerChannels].filter((name) => !registry.has(name)).sort();
  assert.deepEqual(
    undeclared,
    [],
    `RPC.handle channels missing from IPCRegistry INVOKE_CHANNELS (renderer would be blocked): ${undeclared.join(', ')}`
  );
});

test('every INVOKE registry channel has a matching RPC.handle handler', () => {
  const source = readMainProcessSource();
  const handlerChannels = extractCallChannels(source, 'RPC\\.handle');

  const dead = INVOKE_CHANNELS.filter((name) => !handlerChannels.has(name)).sort();
  assert.deepEqual(
    dead,
    [],
    `INVOKE_CHANNELS entries with no RPC.handle handler (dead allowlist entries): ${dead.join(', ')}`
  );
});

test('IPC registry channel lists contain no duplicates', () => {
  assert.equal(new Set(INVOKE_CHANNELS).size, INVOKE_CHANNELS.length, 'duplicate INVOKE channel');
  assert.equal(
    new Set(SUBSCRIBE_CHANNELS).size,
    SUBSCRIBE_CHANNELS.length,
    'duplicate SUBSCRIBE channel'
  );
});

test('preload bridge only invokes/subscribes channels declared in the registry', () => {
  const bridge = fs.readFileSync(path.join(SRC_DIR, 'bridge_main.js'), 'utf8');
  const invokeRegistry = new Set(INVOKE_CHANNELS);
  const subscribeRegistry = new Set(SUBSCRIBE_CHANNELS);

  const bridgeInvokes = extractCallChannels(bridge, 'invoke');
  const bridgeSubscribes = extractCallChannels(bridge, 'subscribe');

  const badInvokes = [...bridgeInvokes].filter((name) => !invokeRegistry.has(name)).sort();
  const badSubscribes = [...bridgeSubscribes].filter((name) => !subscribeRegistry.has(name)).sort();

  assert.deepEqual(badInvokes, [], `bridge invoke() channels not in registry: ${badInvokes.join(', ')}`);
  assert.deepEqual(
    badSubscribes,
    [],
    `bridge subscribe() channels not in registry: ${badSubscribes.join(', ')}`
  );
});

// The preload bridge is sandboxed and cannot require the registry at runtime, so
// it inlines the allowlists. These assertions ensure the inline copies stay
// byte-for-set identical to the registry (drift in either direction fails CI).
function extractInlineSet(source, varName) {
  const block = source.match(new RegExp(`${varName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!block) return null;
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('bridge inline INVOKE allowlist matches the registry exactly', () => {
  const bridge = fs.readFileSync(path.join(SRC_DIR, 'bridge_main.js'), 'utf8');
  const inline = extractInlineSet(bridge, 'INVOKE_CHANNELS');
  assert.ok(inline, 'could not find inline INVOKE_CHANNELS Set in bridge_main.js');
  assert.deepEqual([...inline].sort(), [...INVOKE_CHANNELS].sort());
});

test('bridge inline SUBSCRIBE allowlist matches the registry exactly', () => {
  const bridge = fs.readFileSync(path.join(SRC_DIR, 'bridge_main.js'), 'utf8');
  const inline = extractInlineSet(bridge, 'SUBSCRIBE_CHANNELS');
  assert.ok(inline, 'could not find inline SUBSCRIBE_CHANNELS Set in bridge_main.js');
  assert.deepEqual([...inline].sort(), [...SUBSCRIBE_CHANNELS].sort());
});
