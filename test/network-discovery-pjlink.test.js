const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

function modulePath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'NetworkDiscovery', name);
}

function loadPJLinkDiscovery() {
  return require(modulePath('pjlink-discovery.js'));
}

test('BuildSearchDatagram emits the %2SRCH search request', () => {
  const { BuildSearchDatagram } = loadPJLinkDiscovery();
  assert.equal(BuildSearchDatagram().toString('ascii'), '%2SRCH\r');
});

test('ParseAcknResponse extracts the MAC and rejects other datagrams', () => {
  const { ParseAcknResponse } = loadPJLinkDiscovery();
  assert.equal(ParseAcknResponse('%2ACKN=00:11:22:33:44:55\r'), '00:11:22:33:44:55');
  assert.equal(ParseAcknResponse('%2SRCH\r'), null);
  assert.equal(ParseAcknResponse('garbage'), null);
});

test('StartPJLinkDiscovery fires OnProjector for an ACKN responder', async () => {
  const { StartPJLinkDiscovery } = loadPJLinkDiscovery();

  // A fake projector: reply to any datagram with an ACKN from a known MAC.
  const responder = dgram.createSocket('udp4');
  await new Promise((resolve) => responder.bind(0, '127.0.0.1', resolve));
  const responderPort = responder.address().port;
  responder.on('message', (_msg, rinfo) => {
    responder.send('%2ACKN=aa:bb:cc:dd:ee:ff\r', rinfo.port, '127.0.0.1');
  });

  try {
    const found = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no projector discovered')), 3000);
      const handle = StartPJLinkDiscovery({
        DurationMs: 3000,
        TargetPort: responderPort,
        BroadcastAddresses: ['127.0.0.1'],
        OnProjector: (projector) => {
          clearTimeout(timer);
          handle.Stop();
          resolve(projector);
        },
      });
    });
    assert.equal(found.Address, '127.0.0.1');
    assert.equal(found.Mac, 'aa:bb:cc:dd:ee:ff');
  } finally {
    responder.close();
  }
});
