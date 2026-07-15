const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function loggerStub() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    child: () => logger,
  };
  return { CreateLogger: () => logger };
}

// A fake dgram socket that records multicast joins/leaves and fires 'listening'
// synchronously on bind(), so the receiver reaches its 'ready' state without a
// real OS socket.
function makeFakeSocket() {
  const handlers = {};
  return {
    joined: [],
    dropped: [],
    on(event, cb) {
      handlers[event] = cb;
      return this;
    },
    bind() {
      if (handlers.listening) handlers.listening();
    },
    unref() {},
    addMembership(group, iface) {
      this.joined.push(`${group}@${iface || 'default'}`);
    },
    dropMembership(group, iface) {
      this.dropped.push(`${group}@${iface || 'default'}`);
    },
    close() {},
  };
}

// Controllable NetworkInterfaces mock: the receiver reads Addresses() and
// subscribes via OnChange(); the test drives both.
function makeNetworkInterfacesMock(initialAddrs) {
  let addrs = initialAddrs.slice();
  let listener = null;
  return {
    Manager: {
      Addresses: () => addrs.slice(),
      List: () =>
        addrs.map((a) => ({
          Name: 'x',
          Address: a,
          CIDR: null,
          Netmask: '',
          MAC: null,
          Internal: false,
        })),
      OnChange: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
      Init() {},
      Stop() {},
    },
    // test controls:
    set(next) {
      addrs = next.slice();
      if (listener) listener({ Added: [], Removed: [], Current: [] });
    },
    hasListener: () => listener !== null,
  };
}

function loadReceiver(fakeSocket, netMock) {
  const dgram = { createSocket: () => fakeSocket };
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', '_sacn-shared.js'),
    {
      dgram,
      '../NetworkInterfaces': netMock,
      '../Logger': loggerStub(),
    }
  );
}

test('sACN receiver joins the multicast group on every current interface', () => {
  const sock = makeFakeSocket();
  const net = makeNetworkInterfacesMock(['10.0.0.5', '10.0.1.9']);
  const { SacnReceiver, MulticastAddressForUniverse } = loadReceiver(sock, net);
  const GROUP = MulticastAddressForUniverse(100);

  SacnReceiver.Observe(100);

  assert.equal(sock.joined.includes(`${GROUP}@10.0.0.5`), true);
  assert.equal(sock.joined.includes(`${GROUP}@10.0.1.9`), true);
  SacnReceiver.Stop();
});

test('sACN receiver joins the group on a newly-added interface', () => {
  const sock = makeFakeSocket();
  const net = makeNetworkInterfacesMock(['10.0.0.5']);
  const { SacnReceiver, MulticastAddressForUniverse } = loadReceiver(sock, net);
  const GROUP = MulticastAddressForUniverse(50);

  SacnReceiver.Observe(50);
  assert.equal(sock.joined.filter((j) => j === `${GROUP}@10.0.0.5`).length, 1);

  // A lighting VLAN NIC comes up after boot.
  net.set(['10.0.0.5', '10.0.5.42']);
  assert.equal(sock.joined.includes(`${GROUP}@10.0.5.42`), true);
  // The already-joined interface is not re-joined.
  assert.equal(sock.joined.filter((j) => j === `${GROUP}@10.0.0.5`).length, 1);
  SacnReceiver.Stop();
});

test('sACN receiver drops the group from a removed interface', () => {
  const sock = makeFakeSocket();
  const net = makeNetworkInterfacesMock(['10.0.0.5', '10.0.5.42']);
  const { SacnReceiver, MulticastAddressForUniverse } = loadReceiver(sock, net);
  const GROUP = MulticastAddressForUniverse(7);

  SacnReceiver.Observe(7);
  assert.equal(sock.joined.includes(`${GROUP}@10.0.5.42`), true);

  // The VLAN NIC goes away.
  net.set(['10.0.0.5']);
  assert.equal(sock.dropped.includes(`${GROUP}@10.0.5.42`), true);
  SacnReceiver.Stop();
});

test('sACN receiver unsubscribes from interface changes on Stop', () => {
  const sock = makeFakeSocket();
  const net = makeNetworkInterfacesMock(['10.0.0.5']);
  const { SacnReceiver } = loadReceiver(sock, net);

  SacnReceiver.Observe(1);
  assert.equal(net.hasListener(), true);
  SacnReceiver.Stop();
  assert.equal(net.hasListener(), false);
});
