const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule, recordingManager } = require('./helpers/main-mocks');

// Exercises the paired-devices registrar through the REAL rpc wrapper, with only
// the sqlite-backed manager and Electron stubbed.
//
// The behaviour worth pinning here is the broadcast. Revoking a device has to
// reach a LIVE session, not just the next handshake: a connected socket never
// re-presents its credential, so without the emit a revoked phone keeps full
// control until it happens to reconnect — which is precisely the window
// revocation exists to close. Deleting the row is the easy half; the emit is the
// half that is silent when it breaks.

const state = {
  devices: [null, []],
  revoke: [null, 'device-1'],
  revokeAll: [null, null],
  pairingCode: { Code: 'abcd1234', ExpiresAt: 1700000060000 },
  issueThrows: false,
};

const remoteMgr = recordingManager({
  GetAll: () => state.devices,
  Revoke: () => state.revoke,
  RevokeAll: () => state.revokeAll,
  IssuePairingCode: () => {
    if (state.issueThrows) throw new Error('no entropy');
    return state.pairingCode;
  },
  ClearPairingCodes: () => undefined,
});
const broadcastMgr = recordingManager({ emit: () => {} });
const electronStub = { ipcMain: { handle() {} } };

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: electronStub },
  { match: matchesModule('electron'), value: electronStub },
  { match: matchesModule('/Modules/RemoteDeviceManager'), value: { Manager: remoteMgr } },
  { match: matchesModule('/Modules/Broadcast'), value: { Manager: broadcastMgr } },
]);
test.after(() => restore());

const { register } = require('../dist/main/registrars/remote-devices');
const { GetHandler } = require('../dist/main/handler-registry');
register();

function resetCalls() {
  for (const m of [remoteMgr, broadcastMgr]) m.__calls.length = 0;
}

test.beforeEach(() => resetCalls());

test('registers a handler for every paired-device channel', () => {
  const channels = [
    'Remote:GetDevices',
    'Remote:RevokeDevice',
    'Remote:RevokeAllDevices',
    'Remote:IssuePairingCode',
    'Remote:ClearPairingCode',
  ];
  for (const Channel of channels) {
    assert.equal(typeof GetHandler(Channel), 'function', `${Channel} has no handler`);
  }
});

test('the device list is passed through untouched', async () => {
  state.devices = [null, [{ DeviceID: 'device-1', DeviceName: 'iPhone' }]];
  const [Err, Devices] = await GetHandler('Remote:GetDevices')(null);
  assert.equal(Err, null);
  assert.equal(Devices[0].DeviceID, 'device-1');
});

test('revoking a device broadcasts the id so its live socket is ejected', async () => {
  state.revoke = [null, 'device-1'];
  const [Err, ID] = await GetHandler('Remote:RevokeDevice')(null, 'device-1');

  assert.equal(Err, null);
  assert.equal(ID, 'device-1');
  const [Emitted] = broadcastMgr.__callsTo('emit');
  assert.ok(Emitted, 'the revoked device was never broadcast');
  assert.deepEqual(Emitted.args, ['RemoteDeviceRevoked', 'device-1']);
});

test('a failed revoke does not broadcast an ejection that never happened', async () => {
  // Emitting here would disconnect a device that is still authorised, taking a
  // working phone off the show for no reason.
  state.revoke = ['Failed to revoke device', null];
  const [Err] = await GetHandler('Remote:RevokeDevice')(null, 'device-1');

  assert.match(String(Err), /Failed to revoke/);
  assert.equal(broadcastMgr.__callsTo('emit').length, 0);
});

test('revoke all broadcasts a null target, meaning every device', async () => {
  state.revokeAll = [null, null];
  const [Err, Ok] = await GetHandler('Remote:RevokeAllDevices')(null);

  assert.equal(Err, null);
  assert.equal(Ok, true);
  const [Emitted] = broadcastMgr.__callsTo('emit');
  assert.deepEqual(Emitted.args, ['RemoteDeviceRevoked', null]);
});

test('a failed revoke-all does not broadcast', async () => {
  state.revokeAll = ['Failed to revoke devices', null];
  const [Err] = await GetHandler('Remote:RevokeAllDevices')(null);

  assert.match(String(Err), /Failed to revoke/);
  assert.equal(broadcastMgr.__callsTo('emit').length, 0);
});

test('issuing a pairing code returns it for display', async () => {
  state.issueThrows = false;
  const [Err, Issued] = await GetHandler('Remote:IssuePairingCode')(null);
  assert.equal(Err, null);
  assert.equal(Issued.Code, 'abcd1234');
});

test('a failure to issue a code is reported rather than thrown at the renderer', async () => {
  state.issueThrows = true;
  const [Err, Issued] = await GetHandler('Remote:IssuePairingCode')(null);
  assert.match(String(Err), /Failed to issue/);
  assert.equal(Issued, null);
  state.issueThrows = false;
});

test('clearing pairing codes reaches the manager', async () => {
  const [Err, Ok] = await GetHandler('Remote:ClearPairingCode')(null);
  assert.equal(Err, null);
  assert.equal(Ok, true);
  assert.equal(remoteMgr.__callsTo('ClearPairingCodes').length, 1);
});
