const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const BANNER =
  '\x1b[2J\x1b[0m' + // ANSI reset / clear (fingerprint)
  '   MA2 Lighting Control\r\n' +
  'Please login!\r\n' +
  '\r [Fixture]>';

const VERSION_REPLY =
  '\r\ngrandMA2 Console\r\n' +
  'Version: 3.9.0.3\r\n' +
  'Showfile: PantoNight\r\n' +
  'Showpath: /shows/PantoNight\r\n' +
  '\r [Fixture]>';

// A fake grandMA2 telnet remote. Sends the banner on connect, then handles the
// `login` and `Version` commands. `creds` is the accepted "user pass" pair.
function startMa2Server({ banner = BANNER, creds = 'admin secret' } = {}) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.write(banner);
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf
            .slice(0, idx)
            .replace(/[\r\n]+$/, '')
            .trim();
          buf = buf.slice(idx + 1);
          if (/^login\s+/i.test(line)) {
            const supplied = line.replace(/^login\s+/i, '').trim();
            if (supplied === creds)
              socket.write(`Logged in as User ${creds.split(' ')[0]}\r\n\r [Fixture]>`);
            else socket.write('no login\r\n\r [Fixture]>');
          } else if (/^version$/i.test(line)) {
            socket.write(VERSION_REPLY);
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

test('ma2 liveness is online without credentials and fingerprints the console', async () => {
  const ma2 = loadWithMocks(methodPath('ma2.js'), {});
  assert.equal(ma2.ID, 'ma2');
  const server = await startMa2Server();
  try {
    const result = await ma2.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
    assert.equal(result.IsGrandMa2, true);
    assert.equal(result.LoginState, 'not-attempted');
  } finally {
    await server.close();
  }
});

test('ma2 reads version and show file when good credentials are supplied', async () => {
  const ma2 = loadWithMocks(methodPath('ma2.js'), {});
  const server = await startMa2Server({ creds: 'admin secret' });
  try {
    const result = await ma2.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, User: 'admin', Password: 'secret', Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
    assert.equal(result.LoginState, 'ok');
    assert.equal(result.Ma2Version, '3.9.0.3');
    assert.equal(result.ShowFile, 'PantoNight');
  } finally {
    await server.close();
  }
});

test('ma2 degrades on rejected credentials', async () => {
  const ma2 = loadWithMocks(methodPath('ma2.js'), {});
  const server = await startMa2Server({ creds: 'admin secret' });
  try {
    const result = await ma2.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, User: 'admin', Password: 'wrong', Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /login rejected/i);
  } finally {
    await server.close();
  }
});

test('ma2 degrades when the responder is not a grandMA2', async () => {
  const ma2 = loadWithMocks(methodPath('ma2.js'), {});
  const server = await startMa2Server({ banner: 'hello from some other service\r\n> ' });
  try {
    const result = await ma2.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1000 },
    });
    // No prompt / login marker means the banner never "completes"; the probe
    // times out but has bytes — treated as reachable-but-not-grandMA2 only when
    // a banner completes. Here it stays offline (no recognised banner).
    assert.equal(result.Success, false);
  } finally {
    await server.close();
  }
});

test('ma2 is offline when the port is refused', async () => {
  const ma2 = loadWithMocks(methodPath('ma2.js'), {});
  const tmp = await startMa2Server();
  const port = tmp.port;
  await tmp.close();
  const result = await ma2.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(result.Success, false);
});

test('ma2-show confirms the expected show and degrades on a mismatch', async () => {
  const ma2Show = loadWithMocks(methodPath('ma2-show.js'), {});
  assert.equal(ma2Show.ID, 'ma2-show');
  const server = await startMa2Server({ creds: 'admin secret' });
  try {
    const ok = await ma2Show.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        User: 'admin',
        Password: 'secret',
        Timeout: 2000,
        ExpectedShow: 'PantoNight',
      },
    });
    assert.equal(ok.Success, true);
    assert.ok(!ok.Degraded);

    const wrong = await ma2Show.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        User: 'admin',
        Password: 'secret',
        Timeout: 2000,
        ExpectedShow: 'OtherShow',
      },
    });
    assert.equal(wrong.Success, true);
    assert.equal(wrong.Degraded, true);
    assert.match(wrong.DegradedReason, /expected "OtherShow"/);
  } finally {
    await server.close();
  }
});

test('ma2-show reports missing credentials as degraded', async () => {
  const ma2Show = loadWithMocks(methodPath('ma2-show.js'), {});
  const server = await startMa2Server();
  try {
    const result = await ma2Show.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /credentials are required/i);
  } finally {
    await server.close();
  }
});

test('ma2 internal helpers classify login and parse version', () => {
  const shared = loadWithMocks(methodPath('_ma2-shared.js'), {});
  const { ClassifyLogin, ParseVersionReply, IsGrandMa2Banner, StripAnsi } = shared._internal;
  assert.equal(ClassifyLogin('Logged in as User admin'), 'ok');
  assert.equal(ClassifyLogin('no login'), 'bad-credentials');
  assert.equal(ClassifyLogin('Remote commandline disabled'), 'disabled');
  assert.equal(ClassifyLogin('still waiting'), null);
  const parsed = ParseVersionReply('Version: 3.9.0.3\r\nShowfile: PantoNight\r\n[Fixture]>');
  assert.equal(parsed.Version, '3.9.0.3');
  assert.equal(parsed.ShowFile, 'PantoNight');
  assert.equal(IsGrandMa2Banner('Please login!'), true);
  assert.equal(IsGrandMa2Banner('nope'), false);
  assert.equal(StripAnsi('\x1b[0mHi'), 'Hi');
});
