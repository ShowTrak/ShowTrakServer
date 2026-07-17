const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// A minimal net-snmp stub: get(oids, cb) answers from a scripted OID->value map
// (a value of Error triggers a transport failure). Version constants and
// isVarbindError mirror the real module's surface.
function makeSnmpMock(oidValues, options = {}) {
  return {
    Version1: 0,
    Version2c: 1,
    isVarbindError: (vb) => !!(vb && vb.__error),
    createSession() {
      return {
        get(oids, cb) {
          if (options.transportError) {
            cb(new Error('read timeout'));
            return;
          }
          const varbinds = oids.map((oid) => {
            if (!Object.prototype.hasOwnProperty.call(oidValues, oid)) {
              return { __error: true };
            }
            const value = oidValues[oid];
            return value instanceof Buffer ? { value } : { value };
          });
          cb(null, varbinds);
        },
        close() {},
        on() {},
      };
    },
  };
}

function loadSnmpProjector(mock) {
  return loadWithMocks(methodPath('snmp-projector.js'), { 'net-snmp': mock });
}

const IDENTITY = {
  '1.3.6.1.2.1.1.1.0': Buffer.from('EPSON Network Projector'),
  '1.3.6.1.2.1.1.3.0': 123456,
  '1.3.6.1.2.1.1.5.0': Buffer.from('Stage-Left'),
};

test('EvaluateProjector: lamp threshold and clean readings', () => {
  const { _internal } = loadSnmpProjector(makeSnmpMock({}));
  const profile = { ID: 'epson', Label: 'Epson', Verified: true, LampHoursOid: 'x' };
  const config = { LampWarnHours: 4000, Customs: [] };
  assert.deepEqual(
    _internal.EvaluateProjector({ LampHours: 100, Customs: [] }, profile, config),
    []
  );
  const hot = _internal.EvaluateProjector({ LampHours: 5000, Customs: [] }, profile, config);
  assert.equal(hot.length, 1);
  assert.match(hot[0], /Lamp 5000/);
});

test('EvaluateProjector: custom OID comparators', () => {
  const { _internal } = loadSnmpProjector(makeSnmpMock({}));
  const profile = { ID: 'generic', Label: 'Generic', Verified: true };
  const mk = (Op, Value, got) => ({
    Customs: [{ Check: { Oid: 'o', Op, Value }, Value: got }],
  });
  const base = { LampWarnHours: 0, Customs: [{ Op: 'equals', Value: '', Oid: 'o' }] };
  assert.deepEqual(_internal.EvaluateProjector(mk('equals', 'OK', 'OK'), profile, base), []);
  assert.match(
    _internal.EvaluateProjector(mk('equals', 'OK', 'BAD'), profile, base)[0],
    /expected = OK/
  );
  assert.deepEqual(_internal.EvaluateProjector(mk('max', '50', '40'), profile, base), []);
  assert.match(_internal.EvaluateProjector(mk('max', '50', '60'), profile, base)[0], /≤ 50/);
  assert.match(
    _internal.EvaluateProjector(mk('equals', 'x', null), profile, base)[0],
    /not present/i
  );
  assert.match(
    _internal.EvaluateProjector(mk('min', 'abc', 'def'), profile, base)[0],
    /not numeric/i
  );
});

test('snmp-projector generic profile reports identity and is Online', async () => {
  const snmp = loadSnmpProjector(makeSnmpMock(IDENTITY));
  const result = await snmp.Run({
    Address: '127.0.0.1',
    Settings: { Profile: 'generic', Community: 'public' },
  });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.SysName, 'Stage-Left');
  assert.match(String(result.SysDescr), /EPSON/);
});

test('snmp-projector epson lamp hours read from the profile OID', async () => {
  const snmp = loadSnmpProjector(
    makeSnmpMock({ ...IDENTITY, '1.3.6.1.4.1.1248.4.1.1.1.1.0': 5000 })
  );
  const result = await snmp.Run({
    Address: '127.0.0.1',
    Settings: { Profile: 'epson', LampWarnHours: 4000 },
  });
  assert.equal(result.Success, true);
  assert.equal(result.LampHours, 5000);
  assert.equal(result.Degraded, true);
  assert.match(String(result.DegradedReason), /Lamp/);
});

test('snmp-projector marks ProfileMissing without degrading when brand OIDs are absent', async () => {
  const snmp = loadSnmpProjector(makeSnmpMock(IDENTITY)); // no epson OID present
  const result = await snmp.Run({
    Address: '127.0.0.1',
    Settings: { Profile: 'epson' },
  });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded);
  assert.equal(result.ProfileMissing, true);
});

test('snmp-projector is Offline when identity OIDs fail at the transport level', async () => {
  const snmp = loadSnmpProjector(makeSnmpMock(IDENTITY, { transportError: true }));
  const result = await snmp.Run({
    Address: '127.0.0.1',
    Settings: { Profile: 'generic' },
  });
  assert.equal(result.Success, false);
});
