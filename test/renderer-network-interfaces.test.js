const test = require('node:test');
const assert = require('node:assert/strict');

// The Network section of the client info modal. lib/network-interfaces.ts holds
// the decisions (section state, card title and subtitle, the conditions table,
// turning the table back into a request) and is tested directly;
// client-info-network.ts builds the markup as a pure string function.
//
// Loaded from dist-test/ (see test/renderer-utils.test.js for why).

const Lib = require('../dist-test/UI/js/app/lib/network-interfaces.js');

function view(overrides = {}) {
  return {
    Name: 'en0',
    MAC: 'AA:BB:CC:DD:EE:FF',
    Internal: false,
    Addresses: [
      { family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', cidr: '10.0.0.5/24' },
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::' },
    ],
    Gateway: '10.0.0.1',
    IsConnected: true,
    IsCritical: false,
    Missing: false,
    Issues: [],
    Critical: null,
    ...overrides,
  };
}

function critical(overrides = {}) {
  return {
    Name: 'en0',
    MAC: null,
    RequirePresent: true,
    Address: '10.0.0.5',
    RangeStart: null,
    RangeEnd: null,
    Netmask: '255.255.255.0',
    Gateway: null,
    Timestamp: 1,
    ...overrides,
  };
}

function client(overrides = {}) {
  return {
    UUID: 'c1',
    Online: true,
    NetworkStatus: { SampledAt: 1, Capabilities: { Router: true }, Interfaces: [view()] },
    ...overrides,
  };
}

test('the section waits for a report, and says when the client is offline', () => {
  assert.equal(Lib.GetNetworkSectionState(client()), 'ok');
  assert.equal(Lib.GetNetworkSectionState(client({ Online: false })), 'offline');
  assert.equal(
    Lib.GetNetworkSectionState(client({ NetworkStatus: { SampledAt: null, Interfaces: [] } })),
    'waiting'
  );
  assert.equal(Lib.GetNetworkSectionState(client({ NetworkStatus: undefined })), 'waiting');
});

test('the IP address is the title and the interface name leads the subtitle', () => {
  assert.deepEqual(Lib.NetworkInterfaceTitle(view(), 'IPv4'), { Title: '10.0.0.5', Extra: [] });
  assert.deepEqual(Lib.NetworkInterfaceTitle(view(), 'IPv6'), { Title: 'fe80::1', Extra: [] });
  const twoV4 = view({
    Addresses: [
      { family: 'IPv4', address: '10.0.0.5' },
      { family: 4, address: '10.0.1.5' },
    ],
  });
  assert.deepEqual(Lib.NetworkInterfaceTitle(twoV4, 'IPv4'), {
    Title: '10.0.0.5',
    Extra: ['10.0.1.5'],
  });
  assert.equal(Lib.NetworkInterfaceTitle(view({ Addresses: [] }), 'IPv4').Title, 'No IPv4 Address');
  assert.equal(
    Lib.NetworkInterfaceTitle(view({ IsConnected: false, Missing: true }), 'IPv4').Title,
    'Not Connected'
  );

  assert.equal(
    Lib.NetworkInterfaceSummary(view(), { Router: true }, 'IPv4'),
    'en0 · 255.255.255.0 · Router 10.0.0.1 · AA:BB:CC:DD:EE:FF'
  );
  assert.equal(
    Lib.NetworkInterfaceSummary(view({ Gateway: null, MAC: null }), { Router: false }, 'IPv4'),
    'en0 · 255.255.255.0'
  );
  assert.equal(
    Lib.NetworkInterfaceSummary(view({ Gateway: null }), { Router: true }, 'IPv4'),
    'en0 · 255.255.255.0 · No router · AA:BB:CC:DD:EE:FF'
  );
});

test('internal interfaces offer no critical toggle', () => {
  assert.equal(Lib.NetworkInterfaceBadge(view({ Internal: true })).State, 'internal');
  assert.equal(Lib.NetworkInterfaceBadge(view()).State, 'plain');
  assert.equal(
    Lib.NetworkInterfaceBadge(view({ IsCritical: true, Critical: critical() })).State,
    'healthy'
  );
  assert.equal(
    Lib.NetworkInterfaceBadge(
      view({ IsCritical: true, Critical: critical(), Issues: [{ Kind: 'address', Message: 'x' }] })
    ).State,
    'issue'
  );
  assert.equal(
    Lib.NetworkInterfaceBadge(
      view({ IsCritical: true, IsConnected: false, Missing: true, Critical: critical() })
    ).State,
    'missing'
  );
  assert.equal(
    Lib.NetworkInterfaceBadge(
      view({ IsCritical: true, IsConnected: false, Critical: critical({ RequirePresent: false }) })
    ).State,
    'absent'
  );
});

test('the conditions table lists the five conditions with live values and defaults', () => {
  const rows = Lib.NetworkConditionRows(
    view({
      IsCritical: true,
      Critical: critical(),
      Issues: [{ Kind: 'netmask', Message: 'Subnet mask is wrong' }],
    }),
    { Router: true }
  );
  assert.deepEqual(
    rows.map((r) => [r.Field, r.Label, r.Value, r.Checked, r.Supported]),
    [
      ['RequirePresent', 'Present', 'Yes', true, true],
      ['Address', 'IP address', '10.0.0.5', true, true],
      ['Range', 'IP range', '10.0.0.5', false, true],
      ['Netmask', 'Subnet mask', '255.255.255.0', true, true],
      ['Gateway', 'Router', '10.0.0.1', false, true],
    ]
  );
  assert.deepEqual(rows[2].Defaults, ['10.0.0.1', '10.0.0.254']);
  assert.deepEqual(rows[1].Expected, ['10.0.0.5']);
  assert.equal(rows[3].Failing, 'Subnet mask is wrong');
  assert.equal(Lib.NetworkConditionRows(view(), { Router: true }).length, 0);
});

test('the router row is unsupported until the client reports routers', () => {
  const rows = Lib.NetworkConditionRows(view({ IsCritical: true, Critical: critical() }), {
    Router: false,
  });
  const router = rows.find((r) => r.Field === 'Gateway');
  assert.equal(router.Supported, false);
  assert.equal(router.Value, 'Unsupported');
  // A router already guarded stays clearable.
  const guarded = Lib.NetworkConditionRows(
    view({ IsCritical: true, Critical: critical({ Gateway: '10.0.0.1' }) }),
    { Router: false }
  ).find((r) => r.Field === 'Gateway');
  assert.equal(guarded.Supported, true);
});

test('SubnetHostRange gives the usable hosts of an IPv4 subnet', () => {
  assert.deepEqual(Lib.SubnetHostRange('10.0.0.5', '255.255.255.0'), {
    Start: '10.0.0.1',
    End: '10.0.0.254',
  });
  assert.deepEqual(Lib.SubnetHostRange('192.168.4.9', '255.255.252.0'), {
    Start: '192.168.4.1',
    End: '192.168.7.254',
  });
  assert.deepEqual(Lib.SubnetHostRange('10.0.0.5', '255.255.255.255'), {
    Start: '10.0.0.5',
    End: '10.0.0.5',
  });
  assert.deepEqual(Lib.SubnetHostRange('2001:db8::5', 'ffff::'), {
    Start: '2001:db8::5',
    End: '2001:db8::5',
  });
  assert.equal(Lib.SubnetHostRange('nope', '255.0.0.0'), null);
});

test('the form turns into a request, or a reason it cannot', () => {
  const fields = {
    RequirePresent: true,
    Address: ' 10.0.0.5 ',
    RangeStart: '',
    RangeEnd: '',
    Netmask: '255.255.255.0',
    Gateway: '',
  };
  assert.deepEqual(Lib.ParseNetworkRuleFields('en0', fields), {
    Payload: {
      Name: 'en0',
      RequirePresent: true,
      Address: '10.0.0.5',
      RangeStart: null,
      RangeEnd: null,
      Netmask: '255.255.255.0',
      Gateway: null,
    },
  });
  assert.match(
    Lib.ParseNetworkRuleFields('en0', { ...fields, Address: '10.0.0' }).Error,
    /IP address "10.0.0" is not an IP address/
  );
  assert.match(
    Lib.ParseNetworkRuleFields('en0', { ...fields, RangeStart: '10.0.0.1' }).Error,
    /both a start and an end/
  );
  assert.match(
    Lib.ParseNetworkRuleFields('en0', { ...fields, RangeStart: '10.0.0.9', RangeEnd: '10.0.0.1' })
      .Error,
    /cannot be after/
  );
});

test('the render key follows what the cards show', () => {
  const base = Lib.NetworkRenderKey(client(), 'ok', 'IPv4');
  assert.equal(Lib.NetworkRenderKey(client(), 'ok', 'IPv4'), base);
  assert.notEqual(Lib.NetworkRenderKey(client(), 'ok', 'IPv6'), base);
  const moved = client({
    NetworkStatus: {
      SampledAt: 2,
      Capabilities: { Router: true },
      Interfaces: [view({ Gateway: '10.0.0.254' })],
    },
  });
  assert.notEqual(Lib.NetworkRenderKey(moved, 'ok', 'IPv4'), base);
});

test('timeline states: idle offline or absent, red missing, orange broken', () => {
  const crit = view({ IsCritical: true, Critical: critical() });
  assert.equal(Lib.NetworkTimelineLiveState(crit, false).State, 'IDLE');
  assert.equal(Lib.NetworkTimelineLiveState(crit, true).State, 'ONLINE');
  assert.equal(
    Lib.NetworkTimelineLiveState({ ...crit, IsConnected: false, Missing: true }, true).State,
    'OFFLINE'
  );
  assert.equal(Lib.NetworkTimelineLiveState({ ...crit, IsConnected: false }, true).State, 'IDLE');
  assert.deepEqual(
    Lib.NetworkTimelineLiveState(
      { ...crit, Issues: [{ Kind: 'address', Message: 'moved' }] },
      true
    ),
    { State: 'DEGRADED', Label: 'moved' }
  );
});

// --- client-info-network.ts: markup --------------------------------------------

const Network = require('../dist-test/UI/js/app/client-info-network.js');

test('a card titles the address, subtitles the name, and offers the toggle', () => {
  const html = Network.BuildNetworkSectionHtml(client(), 'ok', 'IPv4');
  assert.match(html, /<h6 class="mb-0 SHOWTRAK_NET_ADDRESS">10\.0\.0\.5<\/h6>/);
  assert.match(html, /en0 · 255\.255\.255\.0 · Router 10\.0\.0\.1/);
  assert.match(html, /SHOWTRAK_TOGGLE_CRITICAL_NETWORK/);
  assert.doesNotMatch(html, /SHOWTRAK_NET_CONDITIONS/);
});

test('an internal interface gets a badge instead of a toggle', () => {
  const html = Network.BuildNetworkSectionHtml(
    client({
      NetworkStatus: {
        SampledAt: 1,
        Capabilities: { Router: true },
        Interfaces: [view({ Name: 'lo0', Internal: true })],
      },
    }),
    'ok',
    'IPv4'
  );
  assert.match(html, /SHOWTRAK_NET_INTERNAL_BADGE/);
  assert.doesNotMatch(html, /SHOWTRAK_TOGGLE_CRITICAL_NETWORK/);
});

test('a critical card carries its conditions table with typed values', () => {
  const html = Network.BuildNetworkSectionHtml(
    client({
      NetworkStatus: {
        SampledAt: 1,
        Capabilities: { Router: true },
        Interfaces: [
          view({
            IsCritical: true,
            Critical: critical({ RangeStart: '10.0.0.1', RangeEnd: '10.0.0.9' }),
          }),
        ],
      },
    }),
    'ok',
    'IPv4'
  );
  for (const field of ['RequirePresent', 'Address', 'Range', 'Netmask', 'Gateway']) {
    assert.match(html, new RegExp(`data-cond="${field}"`));
  }
  assert.match(html, /data-rule="RangeStart" value="10\.0\.0\.1"/);
  assert.match(html, /data-rule="Gateway" value="" placeholder="10\.0\.0\.1"/);
});

test('offline and waiting sections say so above whatever is known', () => {
  const offline = Network.BuildNetworkSectionHtml(client({ Online: false }), 'offline', 'IPv4');
  assert.match(offline, /Client Offline/);
  const waiting = Network.BuildNetworkSectionHtml(
    client({ NetworkStatus: { SampledAt: null, Capabilities: null, Interfaces: [] } }),
    'waiting',
    'IPv4'
  );
  assert.match(waiting, /Waiting for Network Interfaces/);
});
