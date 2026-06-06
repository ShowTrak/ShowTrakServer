const test = require('node:test');
const assert = require('node:assert/strict');

const { Manager: IPCValidation } = require('../src/Modules/IPCValidation');

test('IPCValidation.UUID trims and validates non-empty UUID strings', () => {
  assert.equal(IPCValidation.UUID('  abc-123  '), 'abc-123');
  assert.throws(() => IPCValidation.UUID('  '), /at least 2 characters/i);
  assert.throws(() => IPCValidation.UUID(null), /must be a string/i);
});

test('IPCValidation.UUIDList validates arrays, deduplicates, and rejects empty lists', () => {
  assert.deepEqual(IPCValidation.UUIDList(['a1', 'b2', 'a1']), ['a1', 'b2']);
  assert.throws(() => IPCValidation.UUIDList([]), /cannot be empty/i);
  assert.throws(() => IPCValidation.UUIDList('bad'), /must be an array/i);
});

test('IPCValidation.ClientUpdatePayload validates supported fields only', () => {
  const payload = IPCValidation.ClientUpdatePayload({
    Nickname: '  Arcade-PC 01  ',
    GroupID: '42',
    Ignored: true,
  });

  assert.equal(payload.Nickname, 'Arcade-PC 01');
  assert.equal(payload.GroupID, 42);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'Ignored'), false);

  assert.throws(() => IPCValidation.ClientUpdatePayload({}), /supported fields/i);
});

test('IPCValidation.SettingUpdatePayload allows primitive setting values', () => {
  assert.deepEqual(IPCValidation.SettingUpdatePayload('SYSTEM_ALLOW_WOL', true), [
    'SYSTEM_ALLOW_WOL',
    true,
  ]);
  assert.deepEqual(IPCValidation.SettingUpdatePayload('AB', 'x'), ['AB', 'x']);
  assert.throws(
    () => IPCValidation.SettingUpdatePayload('SETTING_X', { bad: true }),
    /must be a boolean, string, or number/i
  );
});

test('IPCValidation.NetworkDiscoveryScanID validates scan identifiers', () => {
  assert.equal(
    IPCValidation.NetworkDiscoveryScanID('  12345678-1234-1234-1234-123456789abc  '),
    '12345678-1234-1234-1234-123456789abc'
  );
  assert.throws(() => IPCValidation.NetworkDiscoveryScanID('tiny'), /at least 8 characters/i);
});

test('IPCValidation.NetworkDiscoveryScanOptions validates and normalizes options', () => {
  const options = IPCValidation.NetworkDiscoveryScanOptions({
    EnableBonjour: 1,
    EnableProbe: 0,
    TimeoutMs: 15000,
    MaxHostsPerSubnet: 256,
    Concurrency: 24,
    ProbePorts: [80, 443, 443, 8080],
  });

  assert.deepEqual(options, {
    EnableBonjour: true,
    EnableProbe: false,
    TimeoutMs: 15000,
    MaxHostsPerSubnet: 256,
    Concurrency: 24,
    ProbePorts: [80, 443, 8080],
  });

  assert.throws(
    () => IPCValidation.NetworkDiscoveryScanOptions({ ProbePorts: ['abc'] }),
    /valid TCP port numbers/i
  );
  assert.throws(
    () => IPCValidation.NetworkDiscoveryScanOptions({ TimeoutMs: 10 }),
    /between 1000 and 120000/i
  );
});
