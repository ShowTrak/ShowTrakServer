// A mock PJLink projector TCP server for the pjlink-* monitoring-method tests.
//
// startPJLinkServer({ auth, responses }) accepts a connection, writes the
// greeting (`PJLINK 0` or, when `auth` is given, `PJLINK 1 <seed>`), validates
// the MD5 digest prefixed to the first command, and answers each `%1XXXX ?`
// query from the `responses` map (a raw value like '1' / '000000', or an error
// token 'ERR1'..'ERR4'). Commands with no map entry get ERR1 (unsupported).
const net = require('node:net');
const crypto = require('node:crypto');

// The digest a client must send: lowercase-hex md5(seed + password).
function expectedDigest(seed, password) {
  return crypto
    .createHash('md5')
    .update(`${seed}${password}`)
    .digest('hex')
    .toLowerCase();
}

// startPJLinkServer options:
//   responses: { POWR: '1', ERST: '000000', LAMP: '8262 1', ... }
//   auth:      { seed: '498e4a67', password: 'secret' }  (omit for no auth)
function startPJLinkServer(options = {}) {
  const responses = options.responses || {};
  const auth = options.auth || null;
  return new Promise((resolve) => {
    const sockets = new Set();
    let connectionCount = 0;

    const server = net.createServer((socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));

      let firstCommand = true;
      let buffer = '';

      socket.write(auth ? `PJLINK 1 ${auth.seed}\r` : 'PJLINK 0\r');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.search(/[\r\n]/)) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          // Strip and validate the auth digest on the first command.
          if (firstCommand && auth) {
            const digest = line.slice(0, 32);
            if (digest.toLowerCase() !== expectedDigest(auth.seed, auth.password)) {
              socket.write('PJLINK ERRA\r');
              firstCommand = false;
              continue;
            }
            line = line.slice(32);
          }
          firstCommand = false;

          const match = line.match(/^%[12]([A-Z0-9]{4})\s+\?/i);
          if (!match) continue;
          const command = match[1].toUpperCase();
          const value = Object.prototype.hasOwnProperty.call(responses, command)
            ? responses[command]
            : 'ERR1';
          socket.write(`%1${command}=${value}\r`);
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        getConnectionCount: () => connectionCount,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

// A server that accepts connections but never sends the greeting (simulates a
// dead / wrong service on the port).
function startSilentServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
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

const HEALTHY_RESPONSES = {
  POWR: '1',
  ERST: '000000',
  LAMP: '8262 1',
  INPT: '31',
  AVMT: '30',
  CLSS: '1',
  NAME: 'Main Projector',
  INF1: 'ACME',
  INF2: 'PX-1000',
};

module.exports = { startPJLinkServer, startSilentServer, expectedDigest, HEALTHY_RESPONSES };
