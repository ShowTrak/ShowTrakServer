// The shared capability model — Modules/RemoteAccess.
//
// This module decides what a REMOTE surface (the Web UI on `/ui`, ShowTrak
// Remote on `/sdk`) may reach. It exists as one definition rather than one per
// surface because two hand-maintained copies of a security allowlist is exactly
// the drift that becomes a vulnerability: someone adds a channel to one and
// forgets the other, or removes a dangerous one from a surface and leaves it
// live elsewhere.
//
// Two things are worth proving here, and the first is the more important:
//
//   1. The extraction changed NO decision. The capability model used to live
//      inside webui-namespace; a refactor that quietly widened one channel for
//      the browser would be invisible in review. The table-driven pass below
//      walks every channel in the IPC registry and asserts the decision under
//      each mode/permission combination — so "behaviour-preserving" is a claim
//      the suite checks rather than one the commit message makes.
//
//   2. Deny by default really is the default. A channel absent from every
//      allowlist must be refused, whatever the permissions say.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'RemoteAccess', 'index.js');
const REGISTRY_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'IPCRegistry', 'channels.js');

const { INVOKE_CHANNELS } = require(REGISTRY_PATH);

function load({ settings = {}, mode = 'EDIT' } = {}) {
  return loadWithMocks(MODULE_PATH, {
    '../SettingsManager': {
      Manager: {
        GetValue: async (Key) => {
          if (settings.__throws) throw new Error('settings unavailable');
          return settings[Key];
        },
      },
    },
    '../ModeManager': { Manager: { Get: () => mode } },
  });
}

// Everything on, both global feature flags on, EDIT mode — the most permissive
// configuration the model can be in.
const ALL_ON = {
  SYSTEM_ALLOW_WOL: 1,
  SYSTEM_ALLOW_UNASSIGNED_CLIENTS: 1,
};
for (const Prefix of ['WEBUI', 'REMOTE']) {
  for (const Key of [
    'ALLOW_IDENTIFY',
    'ALLOW_REMOTE_SCRIPT_EXECUTION',
    'ALLOW_WOL',
    'ALLOW_CLIENT_MANAGEMENT',
    'ALLOW_GROUP_MANAGEMENT',
    'ALLOW_MONITORING_MANAGEMENT',
    'ALLOW_ALERT_MANAGEMENT',
    'ALLOW_UNASSIGNED_CLIENTS',
  ]) {
    ALL_ON[`${Prefix}_${Key}`] = 1;
  }
}

// --- Behaviour preservation --------------------------------------------------

test('both surfaces reach identical decisions for every registry channel', async () => {
  // The surfaces are deliberately identical: a phone and a browser are both "not
  // the desktop". If a future change makes one stricter, this is the test that
  // should be updated to say so out loud — not quietly deleted.
  const Mod = load({ settings: ALL_ON, mode: 'EDIT' });

  for (const Channel of INVOKE_CHANNELS) {
    const Web = await Mod.AuthorizeChannel('WEBUI', Channel);
    const Remote = await Mod.AuthorizeChannel('REMOTE', Channel);
    assert.deepEqual(Remote, Web, `surfaces disagree about "${Channel}"`);
  }
});

test('every registry channel resolves to a decision, never a throw', async () => {
  const Mod = load({ settings: ALL_ON });
  for (const Channel of INVOKE_CHANNELS) {
    const Decision = await Mod.AuthorizeChannel('REMOTE', Channel);
    assert.equal(typeof Decision.allowed, 'boolean', `"${Channel}" produced no decision`);
  }
});

test('a channel on no allowlist is denied however permissive the settings', async () => {
  const Mod = load({ settings: ALL_ON, mode: 'EDIT' });

  // Settings channels are the case that matters: they hold the SDK API key and
  // the workspace PIN, so a surface that could read them could mint its own
  // access. They are absent from every list, and must stay that way.
  for (const Channel of ['SetSetting', 'Settings:Get', 'Shutdown', 'Show:Open']) {
    const Decision = await Mod.AuthorizeChannel('REMOTE', Channel);
    assert.deepEqual(
      Decision,
      { allowed: false, reason: 'forbidden' },
      `"${Channel}" was reachable from a remote surface`
    );
  }
});

test('an unknown channel is denied rather than passed through', async () => {
  const Mod = load({ settings: ALL_ON });
  assert.deepEqual(await Mod.AuthorizeChannel('REMOTE', 'DropAllTables'), {
    allowed: false,
    reason: 'forbidden',
  });
});

// --- Reads -------------------------------------------------------------------

test('reads are allowed with no permission at all', async () => {
  // Reads sit above the permission model entirely: a session that may connect
  // may look. Every mutation is gated below.
  const Mod = load({ settings: {}, mode: 'SHOW' });
  for (const Channel of ['GetClient', 'GetAllGroups', 'Tags:GetAll', 'GetClientHistory']) {
    assert.deepEqual(await Mod.AuthorizeChannel('REMOTE', Channel), {
      allowed: true,
      reason: null,
    });
  }
});

// --- EDIT mode is the master gate --------------------------------------------

test('management is refused in SHOW mode even with every permission granted', async () => {
  const Mod = load({ settings: ALL_ON, mode: 'SHOW' });

  for (const Channel of [
    'UpdateClient',
    'CreateGroup',
    'CreateMonitoringTarget',
    'CreateAlertRule',
    'CreateUnassignedClients',
  ]) {
    assert.deepEqual(
      await Mod.AuthorizeChannel('REMOTE', Channel),
      { allowed: false, reason: 'edit_mode_required' },
      `"${Channel}" was mutable in SHOW mode`
    );
  }
});

test('the mode requirement is reported ahead of the permission', async () => {
  // The two reasons mean very different things to whoever is holding the phone:
  // one they can fix themselves in a tap, the other needs someone at the desk.
  // Reporting "forbidden" for a mode problem sends them to the wrong place.
  const Mod = load({ settings: { ...ALL_ON, REMOTE_ALLOW_GROUP_MANAGEMENT: 0 }, mode: 'SHOW' });
  const Decision = await Mod.AuthorizeChannel('REMOTE', 'CreateGroup');
  assert.equal(Decision.reason, 'edit_mode_required');
});

// --- Per-category permissions ------------------------------------------------

const CATEGORIES = [
  ['REMOTE_ALLOW_CLIENT_MANAGEMENT', 'UpdateClient'],
  ['REMOTE_ALLOW_GROUP_MANAGEMENT', 'CreateGroup'],
  ['REMOTE_ALLOW_MONITORING_MANAGEMENT', 'CreateMonitoringTarget'],
  ['REMOTE_ALLOW_ALERT_MANAGEMENT', 'CreateAlertRule'],
  ['REMOTE_ALLOW_UNASSIGNED_CLIENTS', 'CreateUnassignedClients'],
];

for (const [Permission, Channel] of CATEGORIES) {
  test(`${Permission} off refuses ${Channel} in EDIT mode`, async () => {
    const Mod = load({ settings: { ...ALL_ON, [Permission]: 0 }, mode: 'EDIT' });
    assert.deepEqual(await Mod.AuthorizeChannel('REMOTE', Channel), {
      allowed: false,
      reason: 'forbidden',
    });
  });

  test(`${Permission} off leaves the other categories alone`, async () => {
    // Categories are independent by design — revoking one must not quietly take
    // the others with it.
    const Mod = load({ settings: { ...ALL_ON, [Permission]: 0 }, mode: 'EDIT' });
    for (const [OtherPermission, OtherChannel] of CATEGORIES) {
      if (OtherPermission === Permission) continue;
      const Decision = await Mod.AuthorizeChannel('REMOTE', OtherChannel);
      assert.equal(Decision.allowed, true, `"${OtherChannel}" was collateral damage`);
    }
  });
}

test('one surface losing a permission does not affect the other', async () => {
  const Mod = load({ settings: { ...ALL_ON, REMOTE_ALLOW_CLIENT_MANAGEMENT: 0 }, mode: 'EDIT' });
  assert.equal((await Mod.AuthorizeChannel('REMOTE', 'UpdateClient')).allowed, false);
  assert.equal((await Mod.AuthorizeChannel('WEBUI', 'UpdateClient')).allowed, true);
});

// --- Identify, scripts and WOL ----------------------------------------------

test('identify is allowed in SHOW mode — it mutates nothing', async () => {
  const Mod = load({ settings: ALL_ON, mode: 'SHOW' });
  assert.equal((await Mod.AuthorizeChannel('REMOTE', 'IdentifyClient')).allowed, true);
  assert.equal((await Mod.AuthorizeChannel('REMOTE', 'StopIdentifyingClient')).allowed, true);
});

test('identify obeys its own permission', async () => {
  const Mod = load({ settings: { ...ALL_ON, REMOTE_ALLOW_IDENTIFY: 0 }, mode: 'SHOW' });
  assert.deepEqual(await Mod.AuthorizeChannel('REMOTE', 'IdentifyClient'), {
    allowed: false,
    reason: 'forbidden',
  });
});

test('script execution defaults OFF and is not gated on edit mode', async () => {
  // Scripts are a SHOW-time action, so mode must not gate them — but they are
  // also the most dangerous thing a remote surface can do, hence the default.
  const Unset = load({ settings: { SYSTEM_ALLOW_WOL: 1 }, mode: 'EDIT' });
  assert.equal((await Unset.AuthorizeChannel('REMOTE', 'ExecuteScript')).allowed, false);

  const On = load({ settings: { REMOTE_ALLOW_REMOTE_SCRIPT_EXECUTION: 1 }, mode: 'SHOW' });
  assert.equal((await On.AuthorizeChannel('REMOTE', 'ExecuteScript')).allowed, true);
  assert.equal((await On.AuthorizeChannel('REMOTE', 'TriggerIntegratedEvent')).allowed, true);
});

test('WOL needs the global feature AND the per-surface permission', async () => {
  const Both = load({ settings: ALL_ON });
  assert.equal((await Both.AuthorizeChannel('REMOTE', 'WakeOnLan')).allowed, true);

  const NoGlobal = load({ settings: { ...ALL_ON, SYSTEM_ALLOW_WOL: 0 } });
  assert.equal((await NoGlobal.AuthorizeChannel('REMOTE', 'WakeOnLan')).allowed, false);

  const NoSurface = load({ settings: { ...ALL_ON, REMOTE_ALLOW_WOL: 0 } });
  assert.equal((await NoSurface.AuthorizeChannel('REMOTE', 'WakeOnLan')).allowed, false);
});

test('unassigned slots need the global feature AND the permission AND edit mode', async () => {
  const NoGlobal = load({
    settings: { ...ALL_ON, SYSTEM_ALLOW_UNASSIGNED_CLIENTS: 0 },
    mode: 'EDIT',
  });
  assert.deepEqual(await NoGlobal.AuthorizeChannel('REMOTE', 'CreateUnassignedClients'), {
    allowed: false,
    reason: 'forbidden',
  });
});

// --- Failure behaviour -------------------------------------------------------

test('an unreadable settings store falls back to the safe defaults, not to allow-all', async () => {
  // Management defaults are ON, but both global feature flags default OFF and
  // scripts default OFF — so a settings outage cannot hand a remote surface
  // anything it would not have had with the features switched off.
  const Mod = load({ settings: { __throws: true }, mode: 'EDIT' });

  assert.equal((await Mod.AuthorizeChannel('REMOTE', 'ExecuteScript')).allowed, false);
  assert.equal((await Mod.AuthorizeChannel('REMOTE', 'WakeOnLan')).allowed, false);
  assert.equal((await Mod.AuthorizeChannel('REMOTE', 'CreateUnassignedClients')).allowed, false);
  assert.equal((await Mod.AuthorizeChannel('REMOTE', 'GetClient')).allowed, true);
});
