const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

// Per-probe keep-alive (src/Modules/MonitoringMethods/_probe-agents.ts): the
// requests of ONE probe share a connection instead of opening one each (a full
// TLS handshake each over HTTPS), and nothing outlives the probe.

const dir = path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods');
const { WithProbeAgents } = require(path.join(dir, '_probe-agents.js'));
const { RequestJson } = require(path.join(dir, '_videoproc-http-shared.js'));
const { RequestSwitchJson } = require(path.join(dir, '_switch-shared.js'));

async function server() {
  const sockets = new Set();
  let connections = 0;
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, connection: req.headers.connection }));
  });
  srv.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: (p) => new URL(`http://127.0.0.1:${srv.address().port}${p}`),
    get connections() {
      return connections;
    },
    get open() {
      return sockets.size;
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

for (const [Name, Request] of [
  ['RequestJson', RequestJson],
  ['RequestSwitchJson', RequestSwitchJson],
]) {
  test(`${Name}: one probe's requests share one connection, closed when it ends`, async (t) => {
    const s = await server();
    t.after(() => s.close());
    const DeadlineAt = Date.now() + 5000;
    const bodies = await WithProbeAgents(async (Agents) => {
      const out = [];
      for (const p of ['/a', '/b', '/c', '/d']) {
        const res = await Request(s.url(p), { Method: 'GET', DeadlineAt, Agents });
        out.push(res.Json);
      }
      return out;
    });
    assert.deepEqual(
      bodies.map((b) => b.path),
      ['/a', '/b', '/c', '/d']
    );
    assert.equal(bodies[0].connection, 'keep-alive');
    assert.equal(s.connections, 1, 'four requests, one connection');
    await settle();
    assert.equal(s.open, 0, 'nothing left open once the probe ended');
  });

  test(`${Name}: without agents each request still closes its own connection`, async (t) => {
    const s = await server();
    t.after(() => s.close());
    const DeadlineAt = Date.now() + 5000;
    for (const p of ['/a', '/b']) {
      const res = await Request(s.url(p), { Method: 'GET', DeadlineAt });
      assert.equal(res.Json.connection, 'close');
    }
    assert.equal(s.connections, 2);
  });
}
