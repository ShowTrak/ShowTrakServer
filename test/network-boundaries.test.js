const test = require('node:test');
const assert = require('node:assert/strict');

// Critical network interfaces at the server's boundaries: the router field on
// an untrusted client report, the mark request from the renderer, what the
// public projection publishes, and the history timeline.

const { Manager: SocketValidation } = require('../dist/Modules/SocketValidation/index');
const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');
const { ToPublicClient } = require('../dist/Modules/Server/serializers');
const History = require('../dist/main/monitoring-history');

test('NetworkInterfaces keeps the router, and keeps its absence absent', () => {
  const [withRouter, withoutRouter, noRouter] = SocketValidation.NetworkInterfaces([
    { name: 'en0', addresses: [], gateway: ' 10.0.0.1 ' },
    { name: 'en1', addresses: [] },
    { name: 'en2', addresses: [], gateway: null },
  ]);
  assert.equal(withRouter.gateway, '10.0.0.1');
  assert.equal('gateway' in withoutRouter, false);
  assert.equal(noRouter.gateway, null);
  assert.throws(
    () => SocketValidation.NetworkInterfaces([{ name: 'en0', addresses: [], gateway: 7 }]),
    /gateway must be a string/
  );
});

test('CriticalNetworkInterfacePayload keeps only the options that were sent', () => {
  assert.deepEqual(IPCValidation.CriticalNetworkInterfacePayload({ Name: ' en0 ' }), {
    Name: 'en0',
  });
  assert.deepEqual(
    IPCValidation.CriticalNetworkInterfacePayload({
      Name: 'en0',
      RequirePresent: false,
      Address: ' 10.0.0.5 ',
      RangeStart: '10.0.0.1',
      RangeEnd: '10.0.0.50',
      Netmask: '255.255.255.0',
      Gateway: '',
    }),
    {
      Name: 'en0',
      RequirePresent: false,
      Address: '10.0.0.5',
      RangeStart: '10.0.0.1',
      RangeEnd: '10.0.0.50',
      Netmask: '255.255.255.0',
      Gateway: null,
    }
  );
});

test('CriticalNetworkInterfacePayload rejects bad names, addresses, masks and ranges', () => {
  for (const [value, pattern] of [
    ['en0', /must be an object/],
    [{ Name: '' }, /Name/],
    [{ Name: 'en0', RequirePresent: 'yes' }, /RequirePresent must be true or false/],
    [{ Name: 'en0', Address: '10.0.0' }, /Address must be an IP address/],
    [{ Name: 'en0', Gateway: 5 }, /Gateway must be an IP address/],
    [{ Name: 'en0', Netmask: '255.0.255.0' }, /Netmask must be a subnet mask/],
    [{ Name: 'en0', RangeStart: '10.0.0.1' }, /set together/],
    [{ Name: 'en0', RangeStart: '10.0.0.1', RangeEnd: null }, /set together/],
    [{ Name: 'en0', RangeStart: '10.0.0.9', RangeEnd: '10.0.0.1' }, /cannot be after/],
    [{ Name: 'en0', RangeStart: '10.0.0.1', RangeEnd: '::9' }, /same family/],
  ]) {
    assert.throws(() => IPCValidation.CriticalNetworkInterfacePayload(value), pattern);
  }
  assert.equal(IPCValidation.NetworkInterfaceName(' Ethernet 2 '), 'Ethernet 2');
});

test('the public projection publishes the network view and baselines', () => {
  const view = { SampledAt: 1, Capabilities: { Router: true }, Interfaces: [] };
  const published = ToPublicClient({
    UUID: 'c1',
    NetworkStatus: view,
    CriticalNetworkInterfaces: [{ Name: 'en0' }],
  });
  assert.equal(published.NetworkStatus, view);
  assert.deepEqual(published.CriticalNetworkInterfaces, [{ Name: 'en0' }]);

  const bare = ToPublicClient({ UUID: 'c2', NetworkStatus: 'junk' });
  assert.deepEqual(bare.NetworkStatus, { SampledAt: null, Capabilities: null, Interfaces: [] });
  assert.deepEqual(bare.CriticalNetworkInterfaces, []);
});

test('history records critical interfaces, and leaves allowed absences idle', () => {
  const uuid = 'net-history-client';
  const t0 = Date.now() - 60000;
  const client = (interfaces, Online = true) => ({
    UUID: uuid,
    Online,
    NetworkStatus: { Interfaces: interfaces },
  });
  const healthy = { Name: 'en0', IsCritical: true, IsConnected: true, Missing: false, Issues: [] };
  const plain = { Name: 'en1', IsCritical: false, IsConnected: true, Missing: false, Issues: [] };
  const absent = { Name: 'en7', IsCritical: true, IsConnected: false, Missing: false, Issues: [] };

  History.recordClientNetworkHistorySamples(client([healthy, plain, absent]), t0);
  History.recordClientNetworkHistorySamples(
    client([{ ...healthy, Issues: [{ Kind: 'address', Message: 'x' }] }]),
    t0 + 4000
  );
  History.recordClientNetworkHistorySamples(
    client([{ ...healthy, IsConnected: false, Missing: true }]),
    t0 + 8000
  );
  // Offline: nothing recorded at all.
  History.recordClientNetworkHistorySamples(client([], false), t0 + 11000);

  const series = History.getClientNetworkHistorySamples(uuid);
  assert.deepEqual(
    series.map((s) => s.InterfaceName),
    ['en0']
  );
  assert.deepEqual(
    series[0].samples.map((s) => [s.ts, s.online, s.degraded]),
    [
      [t0, true, false],
      [t0 + 4000, true, true],
      [t0 + 8000, false, false],
    ]
  );
});

test('CriticalNetworkInterfacePayload accepts a family, and only a real one', () => {
  assert.deepEqual(
    IPCValidation.CriticalNetworkInterfacePayload({ Name: 'utun3', Family: 'IPv6' }),
    {
      Name: 'utun3',
      Family: 'IPv6',
    }
  );
  assert.throws(
    () => IPCValidation.CriticalNetworkInterfacePayload({ Name: 'en0', Family: 'ipv6' }),
    /Family must be IPv4 or IPv6/
  );
});
