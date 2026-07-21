const test = require('node:test');
const assert = require('node:assert/strict');

const { NormalizeMacAddress, IsExternalMacAddress } = require('../dist/Modules/MacAddress');

test('NormalizeMacAddress accepts every common separator and canonicalises them', () => {
  const Expected = 'AA:BB:CC:DD:EE:FF';
  assert.equal(NormalizeMacAddress('AA:BB:CC:DD:EE:FF'), Expected);
  assert.equal(NormalizeMacAddress('aa:bb:cc:dd:ee:ff'), Expected);
  assert.equal(NormalizeMacAddress('aa-bb-cc-dd-ee-ff'), Expected);
  assert.equal(NormalizeMacAddress('aabb.ccdd.eeff'), Expected);
  assert.equal(NormalizeMacAddress('aabbccddeeff'), Expected);
  assert.equal(NormalizeMacAddress('  AA:BB:CC:DD:EE:FF  '), Expected);
});

test('NormalizeMacAddress rejects anything that is not a 48-bit MAC', () => {
  for (const Invalid of [
    null,
    undefined,
    '',
    '   ',
    'not-a-mac',
    'AA:BB:CC:DD:EE', // too short
    'AA:BB:CC:DD:EE:FF:00', // too long
    'GG:BB:CC:DD:EE:FF', // non-hex
    {},
    [],
  ]) {
    assert.equal(
      NormalizeMacAddress(Invalid),
      null,
      `expected ${JSON.stringify(Invalid)} to reject`
    );
  }
});

test('IsExternalMacAddress accepts vendor-assigned unicast addresses', () => {
  // Globally-unique OUIs: multicast bit clear, locally-administered bit clear.
  assert.equal(IsExternalMacAddress('00:1A:2B:3C:4D:5E'), true);
  assert.equal(IsExternalMacAddress('3C:22:FB:11:22:33'), true);
  // Formatting must not change the verdict.
  assert.equal(IsExternalMacAddress('3c-22-fb-11-22-33'), true);
});

test('IsExternalMacAddress rejects the all-zero MAC reported by loopback', () => {
  assert.equal(IsExternalMacAddress('00:00:00:00:00:00'), false);
});

test('IsExternalMacAddress rejects multicast addresses', () => {
  // Least-significant bit of the first octet set — never a NIC's own address.
  assert.equal(IsExternalMacAddress('01:00:5E:00:00:FB'), false);
  assert.equal(IsExternalMacAddress('FF:FF:FF:FF:FF:FF'), false);
});

test('IsExternalMacAddress rejects locally-administered (virtual/randomized) addresses', () => {
  // Second-least-significant bit of the first octet set: Docker bridges,
  // hypervisor adapters and randomized Wi-Fi privacy addresses all land here,
  // and none of them can wake a physical machine.
  assert.equal(IsExternalMacAddress('02:42:AC:11:00:02'), false); // docker0
  assert.equal(IsExternalMacAddress('0A:00:27:00:00:00'), false); // VirtualBox host-only
  assert.equal(IsExternalMacAddress('DA:1B:2C:3D:4E:5F'), false); // randomized client
});

test('IsExternalMacAddress rejects malformed input rather than throwing', () => {
  assert.equal(IsExternalMacAddress('not-a-mac'), false);
  assert.equal(IsExternalMacAddress(null), false);
  assert.equal(IsExternalMacAddress(undefined), false);
});
