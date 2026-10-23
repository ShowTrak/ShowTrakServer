// Tiny local HTTP server for the video processor monitoring method tests
// (Brompton Tessera, Barco Event Master, Analog Way LivePremier). Each test
// supplies a handler; the server records every request it saw.
const http = require('node:http');

async function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      const entry = { method: req.method, url: req.url, headers: req.headers, body, json };
      requests.push(entry);
      Promise.resolve(handler(entry, res)).catch(() => {
        try {
          res.statusCode = 500;
          res.end();
        } catch {
          // ignore
        }
      });
    });
  });
  // A fake server must never crash the test runner on a client reset.
  server.on('error', () => {});
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res, status, value, headers = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

module.exports = { startMockServer, sendJson };
