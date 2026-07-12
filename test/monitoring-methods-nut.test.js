const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// A fake `net` whose Socket speaks NUT: it answers each written command line
// with a scripted reply, so nothing touches the real network.
//
// `script` maps the command keyword(s) -> reply string. `behaviour` can force
// a connection refusal (never emits 'connect', emits ECONNREFUSED) or silence
// (connects but never replies).
function makeNetMock({ replies = {}, refuse = false, silent = false } = {}) {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
    }
    setTimeout() {}
    connect() {
      process.nextTick(() => {
        if (refuse) {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:3493');
          err.code = 'ECONNREFUSED';
          this.emit('error', err);
          this.emit('close');
          return;
        }
        this.emit('connect');
      });
      return this;
    }
    write(data) {
      if (silent || refuse) return true;
      const line = String(data).trim();
      // Resolve the reply for this command.
      let reply = null;
      if (/^USERNAME\b/.test(line)) reply = replies.USERNAME;
      else if (/^PASSWORD\b/.test(line)) reply = replies.PASSWORD;
      else if (/^LIST UPS\b/.test(line)) reply = replies.LIST;
      else if (/ups\.status\b/.test(line)) reply = replies.STATUS;
      else if (/battery\.charge\b/.test(line)) reply = replies.CHARGE;
      else if (/^LOGOUT\b/.test(line)) reply = replies.LOGOUT || '';
      if (reply != null && reply !== '') {
        process.nextTick(() => {
          if (!this.destroyed) this.emit('data', Buffer.from(reply, 'utf8'));
        });
      }
      return true;
    }
    destroy() {
      this.destroyed = true;
      process.nextTick(() => this.emit('close'));
      return this;
    }
  }
  return { Socket: FakeSocket, default: { Socket: FakeSocket } };
}

function loadNut(netMock) {
  return loadWithMocks(methodPath('nut-ups.js'), { net: netMock });
}

const LIST_OK = 'BEGIN LIST UPS\nUPS ups "Server Room UPS"\nUPS backup "Rack B"\nEND LIST UPS\n';

const BASE_SETTINGS = { Port: 3493, UPSName: 'ups', Timeout: 2000 };

test('nut-ups module exposes the expected shape', () => {
  const nut = loadNut(makeNetMock({ replies: {} }));
  assert.equal(nut.ID, 'nut-ups');
  assert.equal(nut.Name, 'Network UPS Tools (NUT)');
  assert.ok(Array.isArray(nut.Settings));
  const keys = nut.Settings.map((s) => s.Key);
  assert.deepEqual(keys, ['Port', 'UPSName', 'Username', 'Password', 'Timeout']);
});

test('nut-ups reports online when ups.status is OL', async () => {
  const nut = loadNut(
    makeNetMock({
      replies: {
        LIST: LIST_OK,
        STATUS: 'VAR ups ups.status "OL"\n',
        CHARGE: 'VAR ups battery.charge "100"\n',
      },
    })
  );
  const result = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.Status, 'OL');
  assert.equal(result.BatteryCharge, '100');
  assert.equal(typeof result.LatencyMs, 'number');
});

test('nut-ups is degraded (On battery) when status is OB', async () => {
  const nut = loadNut(
    makeNetMock({
      replies: {
        LIST: LIST_OK,
        STATUS: 'VAR ups ups.status "OB DISCHRG"\n',
        CHARGE: 'VAR ups battery.charge "87"\n',
      },
    })
  );
  const result = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'On battery');
  assert.equal(result.BatteryCharge, '87');
});

test('nut-ups is degraded (Low battery) when status contains LB', async () => {
  const nut = loadNut(
    makeNetMock({
      replies: {
        LIST: LIST_OK,
        STATUS: 'VAR ups ups.status "OB LB"\n',
        CHARGE: 'VAR ups battery.charge "8"\n',
      },
    })
  );
  const result = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Low battery');
});

test('nut-ups is degraded (UPS not found) when the named UPS is absent', async () => {
  const nut = loadNut(
    makeNetMock({
      replies: {
        LIST: LIST_OK,
        STATUS: 'VAR ups ups.status "OL"\n',
        CHARGE: 'VAR ups battery.charge "100"\n',
      },
    })
  );
  const result = await nut.Run({
    Address: '127.0.0.1',
    Settings: { ...BASE_SETTINGS, UPSName: 'missing' },
  });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'UPS not found');
});

test('nut-ups is offline when the connection is refused', async () => {
  const nut = loadNut(makeNetMock({ refuse: true }));
  const result = await nut.Run({ Address: '127.0.0.1', Settings: BASE_SETTINGS });
  assert.equal(result.Success, false);
  assert.match(result.Error, /ECONNREFUSED/);
});

test('nut-ups is offline on ERR ACCESS-DENIED during auth', async () => {
  const nut = loadNut(
    makeNetMock({
      replies: {
        USERNAME: 'OK\n',
        PASSWORD: 'ERR ACCESS-DENIED\n',
        LIST: LIST_OK,
      },
    })
  );
  const result = await nut.Run({
    Address: '127.0.0.1',
    Settings: { ...BASE_SETTINGS, Username: 'admin', Password: 'wrong' },
  });
  assert.equal(result.Success, false);
  assert.match(result.Error, /ACCESS-DENIED/i);
});

test('nut-ups validates address and UPS name before probing', async () => {
  const nut = loadNut(makeNetMock({ replies: {} }));
  assert.equal((await nut.Run({})).Success, false);
  assert.equal(
    (await nut.Run({ Address: '127.0.0.1', Settings: { Port: 3493, UPSName: '' } })).Success,
    false
  );
  assert.equal(
    (await nut.Run({ Address: '127.0.0.1', Settings: { Port: 70000, UPSName: 'ups' } })).Success,
    false
  );
});

test('nut-ups internal parse + classify helpers behave correctly', () => {
  const nut = loadNut(makeNetMock({ replies: {} }));
  const { ParseListUps, ParseVarValue, ParseErr, ClassifyStatus, UpsNameMatches } = nut._internal;

  assert.deepEqual(ParseListUps(LIST_OK), ['ups', 'backup']);
  assert.equal(ParseVarValue('VAR ups ups.status "OL CHRG"'), 'OL CHRG');
  assert.equal(ParseVarValue('ERR VAR-NOT-SUPPORTED'), null);
  assert.equal(ParseErr('ERR ACCESS-DENIED'), 'ACCESS-DENIED');
  assert.equal(ParseErr('OK'), null);

  assert.equal(ClassifyStatus('OL').Online, true);
  assert.equal(ClassifyStatus('OL CHRG').Online, true);
  assert.equal(ClassifyStatus('OB DISCHRG').DegradedReason, 'On battery');
  assert.equal(ClassifyStatus('OB LB').DegradedReason, 'Low battery');
  assert.equal(ClassifyStatus('RB').DegradedReason, 'Replace battery');
  assert.equal(ClassifyStatus('OVER').DegradedReason, 'Overload');
  assert.equal(ClassifyStatus('').DegradedReason, 'Unknown status');

  assert.equal(UpsNameMatches(['ups', 'backup'], 'UPS'), true);
  assert.equal(UpsNameMatches(['ups'], 'missing'), false);
});
