const test = require('node:test');
const assert = require('node:assert/strict');

// Covers the pure parts of the renderer's shared-state layer:
//   src/UI/js/app/state/client-labels.ts  (client labelling helpers)
//   src/UI/js/app/state/capabilities.ts   (desktop vs web capability profile)
//   src/UI/js/app/state/server-caches.ts  (live-binding setters)
//   src/UI/js/app/lib/status-badges.ts    (shared badge markup)
//   src/UI/js/app/lib/wait.ts
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).
const {
  IsIntegratedClientEntity,
  FormatClientVersionLabel,
  FormatClientHostnameVersionLabel,
} = require('../dist-test/UI/js/app/state/client-labels.js');
const {
  OfflineBadgeContent,
  UnassignedBadgeContent,
} = require('../dist-test/UI/js/app/lib/status-badges.js');
const { Wait } = require('../dist-test/UI/js/app/lib/wait.js');

// --- client-labels ----------------------------------------------------------
//
// These decide how every tile, list row and info modal labels a client, and
// crucially whether it is treated as an SDK/integrated entity (which gates
// Identify, display monitoring and script execution elsewhere).

test('IsIntegratedClientEntity honours the explicit Integrated flag', () => {
  assert.equal(IsIntegratedClientEntity({ Integrated: true }), true);
  assert.equal(IsIntegratedClientEntity({ Integrated: false }), false);
  // Only strict true counts; a truthy string must not sneak through.
  assert.equal(IsIntegratedClientEntity({ Integrated: 'yes' }), false);
});

test('IsIntegratedClientEntity infers integration from the OperatingSystem field', () => {
  assert.equal(IsIntegratedClientEntity({ OperatingSystem: 'Integrated' }), true);
  assert.equal(IsIntegratedClientEntity({ OperatingSystem: '  INTEGRATED  ' }), true);
  assert.equal(IsIntegratedClientEntity({ OperatingSystem: 'Windows_NT' }), false);
  assert.equal(IsIntegratedClientEntity({ OperatingSystem: '' }), false);
});

test('IsIntegratedClientEntity treats a missing client as not integrated', () => {
  assert.equal(IsIntegratedClientEntity(null), false);
  assert.equal(IsIntegratedClientEntity(undefined), false);
  assert.equal(IsIntegratedClientEntity({}), false);
});

test('FormatClientVersionLabel strips a leading v and prefixes with v', () => {
  assert.equal(FormatClientVersionLabel({ Version: '3.14.0' }), 'v3.14.0');
  assert.equal(FormatClientVersionLabel({ Version: 'v3.14.0' }), 'v3.14.0');
  assert.equal(FormatClientVersionLabel({ Version: 'V 3.14.0' }), 'v3.14.0');
  assert.equal(FormatClientVersionLabel({ Version: '  3.14.0  ' }), 'v3.14.0');
});

test('FormatClientVersionLabel marks integrated entities as SDK builds', () => {
  assert.equal(FormatClientVersionLabel({ Integrated: true, Version: '1.2.3' }), 'SDK v1.2.3');
  assert.equal(
    FormatClientVersionLabel({ OperatingSystem: 'integrated', Version: '1.2.3' }),
    'SDK v1.2.3'
  );
});

test('FormatClientVersionLabel falls back to Unknown rather than an empty label', () => {
  assert.equal(FormatClientVersionLabel({ Version: '' }), 'vUnknown');
  assert.equal(FormatClientVersionLabel({ Version: null }), 'vUnknown');
  assert.equal(FormatClientVersionLabel({}), 'vUnknown');
  assert.equal(FormatClientVersionLabel(null), 'vUnknown');
  assert.equal(FormatClientVersionLabel({ Integrated: true }), 'SDK vUnknown');
});

test('FormatClientHostnameVersionLabel prepends the hostname only when nicknamed', () => {
  // A nickname is shown as the tile's main label, so the hostname moves into the
  // secondary line to stay visible. Without a nickname the hostname is already
  // the main label and repeating it would be noise.
  assert.equal(
    FormatClientHostnameVersionLabel({ Nickname: 'Foyer', Hostname: 'PC-01', Version: '3.14.0' }),
    'PC-01 - v3.14.0'
  );
  assert.equal(
    FormatClientHostnameVersionLabel({ Hostname: 'PC-01', Version: '3.14.0' }),
    'v3.14.0'
  );
});

test('FormatClientHostnameVersionLabel ignores a blank nickname or hostname', () => {
  assert.equal(
    FormatClientHostnameVersionLabel({ Nickname: '   ', Hostname: 'PC-01', Version: '3.14.0' }),
    'v3.14.0'
  );
  assert.equal(
    FormatClientHostnameVersionLabel({ Nickname: 'Foyer', Hostname: '  ', Version: '3.14.0' }),
    'v3.14.0'
  );
  assert.equal(FormatClientHostnameVersionLabel(null), 'vUnknown');
});

// --- capabilities -----------------------------------------------------------
//
// The profile is computed once at module evaluation from a window global the
// Web UI shell injects before any module loads, so each case has to re-require
// the module with the global in place.

/** Re-evaluate state/capabilities.ts with `window` set to `windowValue`. */
function loadCapabilities(windowValue) {
  const Path = require.resolve('../dist-test/UI/js/app/state/capabilities.js');
  delete require.cache[Path];
  const HadWindow = 'window' in globalThis;
  const Previous = globalThis.window;
  if (windowValue === undefined) delete globalThis.window;
  else globalThis.window = windowValue;
  try {
    return require(Path).Capabilities;
  } finally {
    delete require.cache[Path];
    if (HadWindow) globalThis.window = Previous;
    else delete globalThis.window;
  }
}

test('Capabilities falls back to the full desktop profile when nothing is injected', () => {
  // On the desktop there is no window.__SHOWTRAK_CAPS__ at all.
  const Desktop = loadCapabilities(undefined);
  assert.equal(Desktop.isWeb, false);
  assert.equal(Desktop.showNavbar, true);
  assert.equal(Desktop.showCogs, true);
  assert.equal(Desktop.showModeToggle, true);
  assert.equal(Desktop.canToggleAlertActions, true);
  assert.equal(Desktop.requiresPasscode, false);
  assert.equal(Desktop.allowRemoteScripts, true);
  assert.equal(Desktop.wolEnabled, true);
  assert.equal(Desktop.allowUnassignedClients, true);
});

test('Capabilities keeps desktop defaults when window exists but nothing is injected', () => {
  assert.equal(loadCapabilities({}).isWeb, false);
  assert.equal(loadCapabilities({ __SHOWTRAK_CAPS__: null }).isWeb, false);
  // A non-object injection is ignored rather than spread.
  assert.equal(loadCapabilities({ __SHOWTRAK_CAPS__: 'web' }).isWeb, false);
});

test('Capabilities overlays an injected web profile onto the desktop defaults', () => {
  const Web = loadCapabilities({
    __SHOWTRAK_CAPS__: { allowRemoteScripts: false, requiresPasscode: true },
  });
  // Injected keys win...
  assert.equal(Web.allowRemoteScripts, false);
  assert.equal(Web.requiresPasscode, true);
  // ...unspecified keys keep their desktop default...
  assert.equal(Web.showNavbar, true);
  assert.equal(Web.wolEnabled, true);
  // ...and isWeb is forced true regardless of what was injected.
  assert.equal(Web.isWeb, true);
});

test('Capabilities does not let an injected isWeb:false override the web surface', () => {
  // isWeb is applied AFTER the spread precisely so a malformed or stale
  // injection cannot make the Web UI believe it is the desktop app and unlock
  // desktop-only actions.
  assert.equal(loadCapabilities({ __SHOWTRAK_CAPS__: { isWeb: false } }).isWeb, true);
});

// --- server-caches ----------------------------------------------------------

test('server-caches setters are visible through the 01-state re-export barrel', () => {
  // ESM live bindings flow through `export *`, so a setter called on the leaf
  // module must be observable by the ~20 modules that import from './01-state'.
  // This is the property the barrel exists to provide.
  const Leaf = require('../dist-test/UI/js/app/state/server-caches.js');
  const Barrel = require('../dist-test/UI/js/app/01-state.js');

  const Clients = [{ UUID: 'a' }];
  Leaf.setAllClients(Clients);
  assert.deepEqual(Barrel.AllClients, Clients);

  Leaf.setPendingAdoption([{ UUID: 'b' }]);
  assert.equal(Barrel.PendingAdoption[0].UUID, 'b');

  Leaf.setConfig({ Version: '3.14.0' });
  assert.equal(Barrel.Config.Version, '3.14.0');

  // Shared Map instances are identical objects across both paths.
  assert.equal(Barrel.GroupUUIDCache, Leaf.GroupUUIDCache);
  assert.equal(Barrel.ClientOnlineState, Leaf.ClientOnlineState);

  Leaf.setAllClients([]);
  Leaf.setPendingAdoption([]);
});

// --- status-badges ----------------------------------------------------------

test('OfflineBadgeContent renders the shared offline markup with a placeholder', () => {
  assert.equal(OfflineBadgeContent(), 'Offline <span class="badge bg-ghost">00:00:00</span>');
  assert.equal(
    OfflineBadgeContent('01:23:45'),
    'Offline <span class="badge bg-ghost">01:23:45</span>'
  );
});

test('UnassignedBadgeContent states the slot is empty instead of counting downtime', () => {
  assert.equal(
    UnassignedBadgeContent(),
    'Unassigned <span class="badge bg-ghost">No Device</span>'
  );
});

// --- wait -------------------------------------------------------------------

test('Wait resolves after roughly the requested delay', async () => {
  const Start = process.hrtime.bigint();
  await Wait(25);
  const ElapsedMs = Number(process.hrtime.bigint() - Start) / 1e6;
  // Generous lower bound: timers may fire a touch early, but not instantly.
  assert.ok(ElapsedMs >= 15, `expected to wait ~25ms, waited ${ElapsedMs.toFixed(1)}ms`);
});

test('Wait(0) still yields to the event loop rather than running inline', async () => {
  let Ran = false;
  const Pending = Wait(0).then(() => {
    Ran = true;
  });
  assert.equal(Ran, false, 'Wait must not resolve synchronously');
  await Pending;
  assert.equal(Ran, true);
});
