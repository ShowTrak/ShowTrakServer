const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const { makeNutNet } = require('../test-support/nut-net-mock');

// The NUT UPS check's actions: instant commands sent over their own upsd login.
// What matters is that the command sent is one this UPS actually lists, that a
// refusal names the setting that fixes it, and that nothing able to cut power
// to the load is on offer at all.

function loadNut(netMock) {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', 'nut-ups.js'),
    { net: netMock }
  );
}

const TARGET = {
  Address: '127.0.0.1',
  Settings: { Port: 3493, UPSName: 'ups', Username: 'monuser', Password: 'secret', Timeout: 2000 },
};

const ALL_CMDS = [
  'beeper.mute',
  'beeper.disable',
  'beeper.enable',
  'test.battery.start.quick',
  'test.battery.stop',
  'load.off',
  'shutdown.return',
];

test('nut-ups offers the alarm and battery test, and nothing that cuts the load', () => {
  const nut = loadNut(makeNutNet({}));
  const ids = nut.Actions.map((Action) => Action.ID);
  assert.deepEqual(ids, [
    'beeper.mute',
    'beeper.disable',
    'beeper.enable',
    'test.battery.quick',
    'test.battery.stop',
  ]);
  assert.equal(typeof nut.RunAction, 'function');
  for (const Spec of Object.values(nut._internal.ACTION_COMMANDS)) {
    for (const Name of Spec.Candidates) assert.doesNotMatch(Name, /^(load\.|shutdown\.)/);
  }
  // A battery test runs the load on battery, so it asks first.
  assert.equal(nut.Actions.find((Action) => Action.ID === 'test.battery.quick').Destructive, true);
  // Nothing here can reach a UPS that upsd cannot, so none survive offline.
  assert.ok(nut.Actions.every((Action) => !Action.AllowedWhileOffline));
});

test('Mute Alarm logs in and sends beeper.mute to the configured UPS', async () => {
  const netMock = makeNutNet({ cmds: ALL_CMDS });
  const nut = loadNut(netMock);
  const r = await nut.RunAction(TARGET, 'beeper.mute', {});
  assert.deepEqual(r, { Success: true, Detail: 'Alarm muted' });
  assert.deepEqual(netMock.sent, [
    'USERNAME monuser',
    'PASSWORD secret',
    'LIST CMD ups',
    'INSTCMD ups beeper.mute',
    'LOGOUT',
  ]);
});

test('the battery test falls back to the generic start command when quick is not listed', async () => {
  const netMock = makeNutNet({ cmds: ['test.battery.start', 'test.battery.stop'] });
  const nut = loadNut(netMock);
  const r = await nut.RunAction(TARGET, 'test.battery.quick', {});
  assert.equal(r.Success, true);
  assert.ok(netMock.sent.includes('INSTCMD ups test.battery.start'));
});

test('a command the UPS does not list is refused without being sent', async () => {
  const netMock = makeNutNet({ cmds: ['test.battery.stop'] });
  const nut = loadNut(netMock);
  const r = await nut.RunAction(TARGET, 'beeper.mute', {});
  assert.equal(r.Success, false);
  assert.match(r.Error, /does not support/);
  assert.ok(!netMock.sent.some((Line) => Line.startsWith('INSTCMD')));
});

test('a server that will not list its commands still gets the preferred one sent', async () => {
  const netMock = makeNutNet({ cmds: 'ERR ACCESS-DENIED\n' });
  const nut = loadNut(netMock);
  const r = await nut.RunAction(TARGET, 'beeper.mute', {});
  assert.equal(r.Success, true);
  assert.ok(netMock.sent.includes('INSTCMD ups beeper.mute'));
});

test('a refusal names the upsd.users setting that grants the command', async () => {
  const nut = loadNut(
    makeNutNet({ cmds: ALL_CMDS, instcmd: { 'beeper.mute': 'ERR ACCESS-DENIED\n' } })
  );
  const r = await nut.RunAction(TARGET, 'beeper.mute', {});
  assert.equal(r.Success, false);
  assert.match(r.Error, /instcmds/);
});

test('an unknown UPS name is reported as such', async () => {
  const nut = loadNut(makeNutNet({ cmds: 'ERR UNKNOWN-UPS\n' }));
  const r = await nut.RunAction(TARGET, 'beeper.mute', {});
  assert.equal(r.Success, false);
  assert.match(r.Error, /no UPS named "ups"/);
});

test('without a NUT login the action is refused before connecting', async () => {
  const netMock = makeNutNet({ cmds: ALL_CMDS });
  const nut = loadNut(netMock);
  const r = await nut.RunAction(
    { Address: '127.0.0.1', Settings: { Port: 3493, UPSName: 'ups' } },
    'beeper.mute',
    {}
  );
  assert.equal(r.Success, false);
  assert.match(r.Error, /username and password/);
  assert.deepEqual(netMock.sent, []);
});

test('a failed login and an unreachable upsd fail the action the way they fail the probe', async () => {
  const denied = loadNut(makeNutNet({ auth: { PASSWORD: 'ERR ACCESS-DENIED\n' } }));
  const r1 = await denied.RunAction(TARGET, 'beeper.mute', {});
  assert.equal(r1.Success, false);
  assert.match(r1.Error, /Authentication failed \(ACCESS-DENIED\)/);

  const refused = loadNut(makeNutNet({ refuse: true }));
  const r2 = await refused.RunAction(TARGET, 'beeper.mute', {});
  assert.equal(r2.Success, false);
  assert.match(r2.Error, /ECONNREFUSED/);
});

test('ParseListCmd reads command names out of a LIST CMD reply', () => {
  const shared = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', '_nut-shared.js')
  );
  assert.deepEqual(
    shared._internal.ParseListCmd(
      'BEGIN LIST CMD ups\nCMD ups beeper.mute\nCMD ups test.battery.start\nEND LIST CMD ups\n'
    ),
    ['beeper.mute', 'test.battery.start']
  );
  assert.deepEqual(shared._internal.ParseListCmd('ERR UNKNOWN-UPS\n'), []);
});
