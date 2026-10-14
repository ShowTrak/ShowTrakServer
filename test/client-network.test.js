const test = require('node:test');
const assert = require('node:assert/strict');

// Critical network interfaces — the pure half (Modules/ClientManager/network.ts):
// address parsing, judging an interface against its conditions, the renderer's
// view, and what a mark request resolves to.

const Net = require('../dist/Modules/ClientManager/network.js');

function iface(overrides = {}) {
  return {
    name: 'en0',
    addresses: [
      {
        family: 'IPv4',
        address: '10.0.0.5',
        netmask: '255.255.255.0',
        cidr: '10.0.0.5/24',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
      },
      {
        family: 'IPv6',
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
      },
    ],
    gateway: '10.0.0.1',
    ...overrides,
  };
}

const loopback = {
  name: 'lo0',
  addresses: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
};

function critical(overrides = {}) {
  return {
    Name: 'en0',
    MAC: null,
    RequirePresent: true,
    Address: null,
    RangeStart: null,
    RangeEnd: null,
    Netmask: null,
    Gateway: null,
    Timestamp: 1,
    ...overrides,
  };
}

test('ParseIP reads IPv4 and every IPv6 spelling, and refuses anything else', () => {
  assert.deepEqual(Net.ParseIP('10.0.0.5'), { Family: 4, Value: 0x0a000005n });
  assert.equal(Net.ParseIP('256.0.0.1'), null);
  assert.equal(Net.ParseIP('10.0.0'), null);
  assert.equal(Net.ParseIP('host.local'), null);
  assert.equal(Net.ParseIP(42), null);
  assert.equal(Net.ParseIP('::1').Value, 1n);
  assert.equal(Net.ParseIP('fe80::1%en0').Family, 6);
  assert.equal(Net.ParseIP('::ffff:10.0.0.1').Value, 0xffff0a000001n);
  assert.equal(Net.ParseIP('1:2:3:4:5:6:7'), null);
  assert.equal(Net.ParseIP('1::2::3'), null);
  assert.ok(Net.SameIP('2001:db8::1', '2001:DB8:0:0:0:0:0:1'));
  assert.ok(!Net.SameIP('10.0.0.1', '10.0.0.2'));
});

test('IsNetmask accepts contiguous masks only', () => {
  for (const mask of [
    '255.255.255.0',
    '255.255.0.0',
    '255.255.255.255',
    '0.0.0.0',
    'ffff:ffff::',
  ]) {
    assert.ok(Net.IsNetmask(mask), mask);
  }
  for (const mask of ['255.0.255.0', '255.255.255.1', 'nonsense']) {
    assert.ok(!Net.IsNetmask(mask), mask);
  }
});

test('the primary address is the first IPv4, else the first routable IPv6', () => {
  assert.equal(Net.PrimaryAddress(iface()).address, '10.0.0.5');
  const v6only = iface({
    addresses: [
      { family: 'IPv6', address: 'fe80::1' },
      { family: 6, address: '2001:db8::5', netmask: 'ffff:ffff:ffff:ffff::' },
    ],
  });
  assert.equal(Net.PrimaryAddress(v6only).address, '2001:db8::5');
  assert.equal(Net.PrimaryAddress(iface({ addresses: [] })), null);
});

test('a missing interface faults only when presence is required', () => {
  assert.deepEqual(Net.evaluateNetworkIssues(null, critical()), [
    { Kind: 'missing', Message: 'en0 is not connected' },
  ]);
  // Absent and allowed to be: its address conditions describe it while up.
  assert.deepEqual(
    Net.evaluateNetworkIssues(null, critical({ RequirePresent: false, Address: '10.0.0.9' })),
    []
  );
});

test('each address condition reports its own fault', () => {
  const judge = (overrides, live = iface()) =>
    Net.evaluateNetworkIssues(live, critical(overrides)).map((i) => [i.Kind, i.Message]);

  assert.deepEqual(judge({ Address: '10.0.0.5' }), []);
  assert.deepEqual(judge({ Address: '10.0.0.9' }), [
    ['address', 'IP address is 10.0.0.5 (expected 10.0.0.9)'],
  ]);
  assert.deepEqual(judge({ Address: '2001:db8::9' }), [
    ['address', 'IP address is fe80::1 (expected 2001:db8::9)'],
  ]);
  assert.deepEqual(judge({ Address: '10.0.0.9' }, iface({ addresses: [] })), [
    ['address', 'No IPv4 address (expected 10.0.0.9)'],
  ]);

  assert.deepEqual(judge({ RangeStart: '10.0.0.1', RangeEnd: '10.0.0.10' }), []);
  assert.deepEqual(judge({ RangeStart: '10.0.0.100', RangeEnd: '10.0.0.200' }), [
    ['range', 'IP address 10.0.0.5 is outside 10.0.0.100–10.0.0.200'],
  ]);

  assert.deepEqual(judge({ Netmask: '255.255.255.0' }), []);
  assert.deepEqual(judge({ Netmask: '255.255.0.0' }), [
    ['netmask', 'Subnet mask is 255.255.255.0 (expected 255.255.0.0)'],
  ]);
  // No address of the family: the mask has nothing to judge.
  assert.deepEqual(judge({ Netmask: '255.255.0.0' }, iface({ addresses: [] })), []);

  assert.deepEqual(judge({ Gateway: '10.0.0.1' }), []);
  assert.deepEqual(judge({ Gateway: '10.0.0.254' }), [
    ['gateway', 'Router is 10.0.0.1 (expected 10.0.0.254)'],
  ]);
  assert.deepEqual(judge({ Gateway: '10.0.0.1' }, iface({ gateway: null })), [
    ['gateway', 'No router (expected 10.0.0.1)'],
  ]);
});

test('a router the client cannot read is unknown, not a fault', () => {
  const live = iface();
  delete live.gateway;
  assert.deepEqual(Net.evaluateNetworkIssues(live, critical({ Gateway: '10.0.0.1' })), []);
});

test('the view judges nothing until the list is trusted', () => {
  const criticals = [critical({ Address: '10.0.0.9' }), critical({ Name: 'en7' })];
  const untrusted = Net.buildNetworkView([iface()], criticals, false, 5);
  assert.equal(untrusted.View.SampledAt, null);
  assert.equal(untrusted.View.Capabilities, null);
  assert.deepEqual(untrusted.Warnings, []);
  assert.deepEqual(untrusted.Missing, []);
  const en7 = untrusted.View.Interfaces.find((i) => i.Name === 'en7');
  assert.equal(en7.IsConnected, false);
  assert.equal(en7.Missing, false);

  const trusted = Net.buildNetworkView([iface(), loopback], criticals, true, 5);
  assert.equal(trusted.View.SampledAt, 5);
  assert.deepEqual(trusted.View.Capabilities, { Router: true });
  assert.deepEqual(trusted.Warnings, ['Network Address Changed', 'Missing Network Interface']);
  assert.deepEqual(
    trusted.Missing.map((i) => i.Name),
    ['en7']
  );
  const en0 = trusted.View.Interfaces.find((i) => i.Name === 'en0');
  assert.equal(en0.MAC, 'AA:BB:CC:DD:EE:FF');
  assert.equal(en0.Gateway, '10.0.0.1');
  assert.equal(en0.IsCritical, true);
  assert.equal(trusted.View.Interfaces.find((i) => i.Name === 'lo0').Internal, true);
});

test('an absent interface that may be absent is listed but never missing', () => {
  const result = Net.buildNetworkView([], [critical({ RequirePresent: false })], true, 1);
  assert.equal(result.View.Interfaces[0].Missing, false);
  assert.deepEqual(result.Missing, []);
  assert.deepEqual(result.Warnings, []);
});

test('routers are a capability only when the client reports the field', () => {
  const old = iface();
  delete old.gateway;
  assert.deepEqual(Net.networkCapabilities([old]), { Router: false });
  assert.deepEqual(Net.networkCapabilities([old, iface({ gateway: null })]), { Router: true });
});

test('a first mark guards presence, the current address, mask and router', () => {
  const [err, entry] = Net.resolveCriticalNetworkEntry(
    'en0',
    {},
    iface(),
    null,
    { Router: true },
    9
  );
  assert.equal(err, null);
  assert.deepEqual(entry, {
    Name: 'en0',
    MAC: 'AA:BB:CC:DD:EE:FF',
    Family: 'IPv4',
    RequirePresent: true,
    Address: '10.0.0.5',
    RangeStart: null,
    RangeEnd: null,
    Netmask: '255.255.255.0',
    Gateway: '10.0.0.1',
    Timestamp: 9,
  });
  // No router guard when the client cannot report routers.
  const [, noRouter] = Net.resolveCriticalNetworkEntry(
    'en0',
    {},
    iface(),
    null,
    { Router: false },
    9
  );
  assert.equal(noRouter.Gateway, null);
});

test('an update keeps what it does not mention and can edit a missing interface', () => {
  const existing = critical({ Address: '10.0.0.5', Netmask: '255.255.255.0', Timestamp: 3 });
  const [err, entry] = Net.resolveCriticalNetworkEntry(
    'en0',
    { RangeStart: '10.0.0.1', RangeEnd: '10.0.0.50', Address: null },
    null,
    existing,
    null,
    9
  );
  assert.equal(err, null);
  assert.equal(entry.Address, null);
  assert.equal(entry.Netmask, '255.255.255.0');
  assert.equal(entry.RangeStart, '10.0.0.1');
  assert.equal(entry.Timestamp, 3);
});

test('marks that cannot be honoured are refused with a reason', () => {
  const resolve = (options, live = iface(), existing = null) =>
    Net.resolveCriticalNetworkEntry('en0', options, live, existing, { Router: true }, 1)[0];
  assert.match(resolve({}, loopback), /Internal network interfaces cannot be monitored/);
  assert.match(resolve({}, null), /not connected/);
  assert.match(resolve({ Netmask: '255.0.255.0' }), /not a valid subnet mask/);
  assert.match(resolve({ RangeStart: '10.0.0.1' }), /both a start and an end/);
  assert.match(resolve({ RangeStart: '10.0.0.9', RangeEnd: '10.0.0.1' }), /cannot be after/);
  assert.match(resolve({ RangeStart: '10.0.0.1', RangeEnd: '::1' }), /same kind/);
});

test('stored entries are normalised, dropping conditions that cannot be judged', () => {
  const entry = Net.normalizeCriticalNetworkEntry({
    Name: ' en0 ',
    RequirePresent: 1,
    Address: 'not-an-ip',
    RangeStart: '10.0.0.9',
    RangeEnd: '10.0.0.1',
    Netmask: '255.0.255.0',
    Gateway: '10.0.0.1',
    Timestamp: 4,
  });
  assert.equal(entry.Name, 'en0');
  assert.equal(entry.RequirePresent, true);
  assert.equal(entry.Address, null);
  assert.equal(entry.RangeStart, null);
  assert.equal(entry.RangeEnd, null);
  assert.equal(entry.Netmask, null);
  assert.equal(entry.Gateway, '10.0.0.1');
  assert.equal(Net.normalizeCriticalNetworkEntry({ Name: '  ' }), null);
});

// A tunnel (utun, awdl) often carries only an IPv6 link-local address, which a
// first mark does not guard. Its family is recorded instead, so the card stays
// in the IPv6 list rather than falling back to IPv4.
const tunnel = iface({
  name: 'utun3',
  addresses: [{ family: 'IPv6', address: 'fe80::abcd', netmask: 'ffff:ffff:ffff:ffff::' }],
  gateway: null,
});

test('a first mark records the family it was marked under', () => {
  const [, marked] = Net.resolveCriticalNetworkEntry(
    'utun3',
    { Family: 'IPv6' },
    tunnel,
    null,
    null,
    1
  );
  assert.equal(marked.Family, 'IPv6');
  assert.equal(marked.Address, null);

  // An update that does not mention it keeps it, even with nothing guarded.
  const [, updated] = Net.resolveCriticalNetworkEntry(
    'utun3',
    { RequirePresent: false },
    null,
    marked,
    null,
    2
  );
  assert.equal(updated.Family, 'IPv6');
});

test('without a stated family it follows the guarded address, then the addresses it has', () => {
  assert.equal(
    Net.resolveCriticalNetworkEntry('utun3', {}, tunnel, null, null, 1)[1].Family,
    'IPv6'
  );
  assert.equal(
    Net.resolveCriticalNetworkEntry('en0', {}, iface(), null, null, 1)[1].Family,
    'IPv4'
  );
  // An entry saved before the family was recorded gains it on its next save.
  const legacy = Net.normalizeCriticalNetworkEntry(critical({ Address: '2001:db8::5' }));
  assert.equal(legacy.Family, null);
  assert.equal(
    Net.resolveCriticalNetworkEntry('en0', { RequirePresent: true }, null, legacy, null, 1)[1]
      .Family,
    'IPv6'
  );
});

test('marking under IPv6 captures the IPv6 address even when there is an IPv4 one', () => {
  const dual = iface({
    addresses: [
      ...iface().addresses,
      { family: 'IPv6', address: '2001:db8::5', netmask: 'ffff:ffff:ffff:ffff::' },
    ],
  });
  const [, entry] = Net.resolveCriticalNetworkEntry('en0', { Family: 'IPv6' }, dual, null, null, 1);
  assert.equal(entry.Address, '2001:db8::5');
  assert.equal(entry.Netmask, 'ffff:ffff:ffff:ffff::');
});
