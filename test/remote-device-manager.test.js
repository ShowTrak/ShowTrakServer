// RemoteDeviceManager — the pairing lifecycle for ShowTrak Remote devices.
//
// Two secrets with deliberately different lifetimes live in this module, and the
// tests are weighted accordingly:
//
//   The device token is what a paired phone authenticates with forever after. It
//   must never be stored in plaintext, and it must be returned to the caller
//   exactly once — there is no path that can recover it afterwards.
//
//   The pairing code is displayed on a screen anyone in the room can see, so it
//   has to be single-use and short-lived. "Single-use" is the load-bearing half:
//   a photograph of the QR is worthless the moment the first device redeems it.
//
// The DB is stubbed. Unstubbed, the real manager's ../DB opens a live sqlite
// connection at module load — green locally, broken on CI (see
// test/server-namespace-mock-coverage.test.js).
const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const MODULE_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'RemoteDeviceManager',
  'index.js'
);

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

function load({ rows = [], insertErr = null, touchErr = null, deleteErr = null } = {}) {
  const calls = { insert: [], touch: [], del: [], deleteAll: 0 };
  const Db = {
    All: async () => [null, rows],
    Get: async (sql, params) => {
      const [Value] = params;
      const Column = /TokenHash/.test(sql) ? 'TokenHash' : 'DeviceID';
      return [null, rows.find((R) => R[Column] === Value) || null];
    },
    Run: async (sql, params) => {
      if (/^INSERT/.test(sql)) {
        calls.insert.push(params);
        return [insertErr, null];
      }
      if (/^UPDATE/.test(sql)) {
        calls.touch.push(params);
        return [touchErr, null];
      }
      if (/WHERE DeviceID/.test(sql)) {
        calls.del.push(params);
        return [deleteErr, null];
      }
      calls.deleteAll += 1;
      return [deleteErr, null];
    },
  };

  const Mod = loadWithMocks(MODULE_PATH, {
    '../Logger': loggerStub,
    '../DB': { Manager: Db },
    '../UUID': { Manager: { Generate: () => 'generated-uuid' } },
  });

  return { Mod, calls };
}

// --- Device tokens -----------------------------------------------------------

test('pairing persists only the hash of the token it returns', async () => {
  const { Mod, calls } = load();
  const [Err, Paired] = await Mod.Manager.Pair('Stage Tablet', 'ios');

  assert.equal(Err, null);
  assert.ok(Paired.DeviceToken, 'no token was handed back');

  const [, TokenHash] = calls.insert[0];
  assert.notEqual(TokenHash, Paired.DeviceToken, 'the plaintext token was written to the database');
  assert.equal(
    TokenHash,
    crypto.createHash('sha256').update(Paired.DeviceToken, 'utf8').digest('hex')
  );
});

test('a minted token has full entropy, not a truncated or predictable one', async () => {
  // 32 bytes = 256 bits, hex-encoded. This is asserted because the token is the
  // ONLY thing standing between a stranger on the show LAN and full control once
  // pairing is over — and because a "tidier" shorter token is an easy, silent
  // regression to introduce.
  const { Mod } = load();
  const [, First] = await Mod.Manager.Pair('A', 'ios');
  const [, Second] = await Mod.Manager.Pair('B', 'ios');

  assert.equal(First.DeviceToken.length, 64);
  assert.match(First.DeviceToken, /^[0-9a-f]+$/);
  assert.notEqual(First.DeviceToken, Second.DeviceToken);
});

test('a device name is clamped and stripped of control characters', async () => {
  // Attacker-controlled text that gets rendered in the settings device list. The
  // ANSI escape matters as much as the tab: the pane is not the only place this
  // string is written — it also reaches the log.
  const { Mod, calls } = load();
  await Mod.Manager.Pair('Stage\tTablet\u001b[31m', 'ios');
  assert.equal(calls.insert[0][2], 'StageTablet[31m');

  await Mod.Manager.Pair('x'.repeat(500), 'ios');
  assert.equal(calls.insert[1][2].length, 64);
});

test('a blank device name still yields something identifiable in the revoke list', async () => {
  // A blank row would be unrevokable in practice: the operator could not tell
  // which device they were removing.
  const { Mod, calls } = load();
  await Mod.Manager.Pair('   ', 'ios');
  assert.equal(calls.insert[0][2], 'Unnamed Device');
});

test('an unrecognised platform is discarded rather than stored', async () => {
  const { Mod, calls } = load();
  await Mod.Manager.Pair('Phone', 'ios');
  await Mod.Manager.Pair('Phone', 'WINDOWS');
  assert.equal(calls.insert[0][3], 'ios');
  assert.equal(calls.insert[1][3], null);
});

test('a failed insert reports a failure instead of a token that authenticates nothing', async () => {
  const { Mod } = load({ insertErr: 'disk full' });
  const [Err, Paired] = await Mod.Manager.Pair('Phone', 'ios');
  assert.match(String(Err), /Failed to pair/);
  assert.equal(Paired, null);
});

test('verify resolves a token by its hash and touches LastSeenAt', async () => {
  const Token = 'a'.repeat(64);
  const Rows = [
    {
      DeviceID: 'device-1',
      TokenHash: crypto.createHash('sha256').update(Token, 'utf8').digest('hex'),
      DeviceName: 'iPhone',
      Platform: 'ios',
      PairedAt: 1,
      LastSeenAt: null,
    },
  ];
  const { Mod, calls } = load({ rows: Rows });

  const Device = await Mod.Manager.Verify(Token);
  assert.equal(Device.DeviceID, 'device-1');
  assert.equal(calls.touch.length, 1);
  assert.equal(calls.touch[0][1], 'device-1');
});

test('an unknown token resolves to null rather than throwing', async () => {
  const { Mod } = load();
  assert.equal(await Mod.Manager.Verify('nope'), null);
  assert.equal(await Mod.Manager.Verify(''), null);
  assert.equal(await Mod.Manager.Verify(undefined), null);
});

test('a failed LastSeenAt write does not cost a legitimate device its session', async () => {
  // The column is only ever read by the settings pane. Refusing the handshake
  // over it would take a working phone offline mid-show for a cosmetic write.
  const Token = 'b'.repeat(64);
  const Rows = [
    {
      DeviceID: 'device-1',
      TokenHash: crypto.createHash('sha256').update(Token, 'utf8').digest('hex'),
      DeviceName: 'iPhone',
      Platform: 'ios',
      PairedAt: 1,
      LastSeenAt: null,
    },
  ];
  const { Mod } = load({ rows: Rows, touchErr: 'locked' });

  const Device = await Mod.Manager.Verify(Token);
  assert.ok(Device, 'a cosmetic write failure refused a valid device');
});

// --- Pairing codes -----------------------------------------------------------

test('a pairing code is redeemable exactly once', async () => {
  const { Mod } = load();
  const { Code } = Mod.Manager.IssuePairingCode();

  assert.equal(Mod.Manager.RedeemPairingCode(Code), true);
  assert.equal(
    Mod.Manager.RedeemPairingCode(Code),
    false,
    'a photographed QR stayed valid after being used'
  );
});

test('issuing a new code invalidates the previous one', async () => {
  // The settings pane only ever shows one QR. Leaving older codes live would
  // widen the window for no benefit.
  const { Mod } = load();
  const { Code: First } = Mod.Manager.IssuePairingCode();
  Mod.Manager.IssuePairingCode();

  assert.equal(Mod.Manager.RedeemPairingCode(First), false);
});

test('a pairing code expires on its own', async () => {
  const { Mod } = load();
  const { Code } = Mod.Manager.IssuePairingCode();

  mock.timers.enable({ apis: ['Date'], now: Date.now() + Mod.PAIRING_CODE_TTL_MS + 1000 });
  try {
    assert.equal(Mod.Manager.RedeemPairingCode(Code), false);
  } finally {
    mock.timers.reset();
  }
});

test('clearing codes makes a displayed QR immediately worthless', async () => {
  const { Mod } = load();
  const { Code } = Mod.Manager.IssuePairingCode();
  Mod.Manager.ClearPairingCodes();

  assert.equal(Mod.Manager.RedeemPairingCode(Code), false);
});

test('a junk pairing code is rejected without throwing', async () => {
  const { Mod } = load();
  Mod.Manager.IssuePairingCode();

  assert.equal(Mod.Manager.RedeemPairingCode(''), false);
  assert.equal(Mod.Manager.RedeemPairingCode(undefined), false);
  assert.equal(Mod.Manager.RedeemPairingCode({}), false);
});

// --- Listing and revocation --------------------------------------------------

test('the device list never carries a token or its hash', async () => {
  const Rows = [
    {
      DeviceID: 'device-1',
      TokenHash: 'deadbeef',
      DeviceName: 'iPhone',
      Platform: 'ios',
      PairedAt: 10,
      LastSeenAt: 20,
    },
  ];
  const { Mod } = load({ rows: Rows });

  const [Err, Devices] = await Mod.Manager.GetAll();
  assert.equal(Err, null);
  assert.deepEqual(Object.keys(Devices[0]).sort(), [
    'DeviceID',
    'DeviceName',
    'LastSeenAt',
    'PairedAt',
    'Platform',
  ]);
});

test('revoke refuses a blank device id rather than deleting nothing quietly', async () => {
  const { Mod, calls } = load();
  const [Err] = await Mod.Manager.Revoke('');
  assert.match(String(Err), /No device specified/);
  assert.equal(calls.del.length, 0);
});

test('revoke returns the id it removed so the caller can eject that session', async () => {
  const { Mod, calls } = load();
  const [Err, ID] = await Mod.Manager.Revoke('device-1');
  assert.equal(Err, null);
  assert.equal(ID, 'device-1');
  assert.deepEqual(calls.del[0], ['device-1']);
});

test('revoke all clears the table', async () => {
  const { Mod, calls } = load();
  const [Err] = await Mod.Manager.RevokeAll();
  assert.equal(Err, null);
  assert.equal(calls.deleteAll, 1);
});
