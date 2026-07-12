const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'WOLManager', 'index.js');

const noopLogger = {
  CreateLogger: () => ({ log: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
};

// A fake dgram whose sockets record every send and drive the callbacks
// synchronously, so the send loop resolves deterministically without real I/O.
function fakeDgram(sends) {
  return {
    createSocket() {
      const socket = {
        _broadcast: false,
        unref() {},
        once() {},
        setBroadcast(value) {
          socket._broadcast = value;
        },
        send(msg, offset, length, port, address, cb) {
          sends.push({
            from: socket._from,
            length,
            port,
            address,
            broadcast: socket._broadcast,
            hex: msg.toString('hex'),
          });
          cb(null);
        },
        bind(_port, from, cb) {
          socket._from = from;
          cb();
        },
        close() {},
      };
      return socket;
    },
  };
}

function fakeOs(interfaces) {
  return { networkInterfaces: () => interfaces };
}

function loadWOL({ dgram, os } = {}) {
  const mocks = { '../Logger': noopLogger };
  if (dgram) mocks.dgram = dgram;
  if (os) mocks.os = os;
  return loadWithMocks(modulePath, mocks);
}

// --- pure helpers -----------------------------------------------------------

test('BuildMagicPacket produces the 102-byte 0xFF sync stream + MAC×16', () => {
  const { _internal } = loadWOL();
  const packet = _internal.BuildMagicPacket('AA:BB:CC:DD:EE:FF');
  assert.equal(packet.length, 102);
  assert.equal(packet.subarray(0, 6).toString('hex'), 'ffffffffffff');
  assert.equal(packet.subarray(6).toString('hex'), 'aabbccddeeff'.repeat(16));
});

test('BuildMagicPacket accepts colon, dash, and bare MAC formats identically', () => {
  const { _internal } = loadWOL();
  const expected = _internal.BuildMagicPacket('aabbccddeeff').toString('hex');
  assert.equal(_internal.BuildMagicPacket('AA:BB:CC:DD:EE:FF').toString('hex'), expected);
  assert.equal(_internal.BuildMagicPacket('aa-bb-cc-dd-ee-ff').toString('hex'), expected);
});

test('NormalizeMac rejects malformed MAC addresses', () => {
  const { _internal } = loadWOL();
  assert.throws(() => _internal.NormalizeMac('nope'), /Invalid MAC/);
  assert.throws(() => _internal.NormalizeMac('AA:BB:CC:DD:EE'), /Invalid MAC/); // too short
  assert.throws(() => _internal.NormalizeMac('GG:BB:CC:DD:EE:FF'), /Invalid MAC/); // non-hex
});

test('BroadcastAddress sets the host bits for common netmasks', () => {
  const { _internal } = loadWOL();
  assert.equal(_internal.BroadcastAddress('192.168.1.42', '255.255.255.0'), '192.168.1.255');
  assert.equal(_internal.BroadcastAddress('10.0.5.7', '255.255.0.0'), '10.0.255.255');
  assert.equal(_internal.BroadcastAddress('172.16.5.4', '255.255.255.128'), '172.16.5.127');
});

// --- Wake validation --------------------------------------------------------

test('Wake returns a failure tuple when no MAC is supplied', async () => {
  const { Manager } = loadWOL();
  assert.deepEqual(await Manager.Wake(''), ['No MAC address provided', null]);
});

test('Wake returns a failure tuple for an invalid MAC (no network touched)', async () => {
  const { Manager } = loadWOL();
  const [err, data] = await Manager.Wake('not-a-mac');
  assert.match(err, /Invalid MAC/);
  assert.equal(data, null);
});

// --- Wake send orchestration ------------------------------------------------

test('Wake broadcasts only on external IPv4 interfaces and reports success', async () => {
  const sends = [];
  const { Manager } = loadWOL({
    dgram: fakeDgram(sends),
    os: fakeOs({
      eth0: [{ address: '192.168.1.42', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
      wlan0: [{ address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', internal: false }],
    }),
  });

  const [err, data] = await Manager.Wake('AA:BB:CC:DD:EE:FF', 1, 50);
  assert.equal(err, null);
  assert.equal(data, 'Wake On LAN packet sent successfully');

  // The one external IPv4 interface hits both its directed and the limited
  // broadcast; the loopback and IPv6 interfaces are skipped entirely.
  assert.deepEqual(
    sends.map((s) => s.address).sort(),
    ['192.168.1.255', '255.255.255.255']
  );
  for (const sent of sends) {
    assert.equal(sent.port, 9);
    assert.equal(sent.length, 102);
    assert.equal(sent.broadcast, true, 'setBroadcast(true) must run before send');
    assert.equal(sent.hex.slice(0, 12), 'ffffffffffff');
  }
});

test('Wake broadcasts on every external IPv4 interface', async () => {
  const sends = [];
  const { Manager } = loadWOL({
    dgram: fakeDgram(sends),
    os: fakeOs({
      eth0: [{ address: '192.168.1.42', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
      eth1: [{ address: '10.0.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    }),
  });

  await Manager.Wake('AA:BB:CC:DD:EE:FF', 1, 50);

  // Both interfaces hit their own directed broadcast plus the limited broadcast.
  assert.deepEqual(
    sends.map((s) => `${s.from}->${s.address}`).sort(),
    [
      '10.0.0.5->10.0.0.255',
      '10.0.0.5->255.255.255.255',
      '192.168.1.42->192.168.1.255',
      '192.168.1.42->255.255.255.255',
    ]
  );
});

test('Wake fails cleanly when there are no external IPv4 interfaces', async () => {
  const sends = [];
  const { Manager } = loadWOL({
    dgram: fakeDgram(sends),
    os: fakeOs({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    }),
  });

  const [err, data] = await Manager.Wake('AA:BB:CC:DD:EE:FF');
  assert.equal(err, 'No external IPv4 network interfaces available');
  assert.equal(data, null);
  assert.equal(sends.length, 0);
});
