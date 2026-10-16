const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const {
  RunTcpSession,
  ReplyQueue,
  ProbeTcpConnect,
} = require('../dist/Modules/MonitoringMethods/_tcp-session');

// The shared TCP plumbing every short-lived device probe runs on. A rule broken
// here breaks every method at once, so each is pinned against a real socket.

function listen(onConnection) {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// A port nothing is listening on: bind one, note it, release it.
async function closedPort() {
  const server = await listen(() => {});
  const { port } = server.address();
  await close(server);
  return port;
}

test('a session settles exactly once, runs OnSettle once, and closes its socket', async () => {
  const server = await listen((socket) => socket.write('hello\n'));
  const { port } = server.address();
  let settles = 0;
  let socketRef = null;
  const result = await RunTcpSession({
    Address: '127.0.0.1',
    Port: port,
    IdleMs: 2000,
    OnSettle: () => settles++,
    OnData: (chunk, session) => {
      socketRef = session.Socket;
      session.Finish(`first:${chunk.toString().trim()}`);
      session.Finish('second');
    },
    OnTimeout: () => 'timeout',
    OnError: (m) => `error:${m}`,
    OnClose: () => 'closed',
  });
  assert.equal(result, 'first:hello');
  assert.equal(settles, 1);
  assert.equal(socketRef.destroyed, true);
  await close(server);
});

test('the absolute deadline ends a session a trickling peer keeps idle-alive', async () => {
  // A byte every 50ms keeps resetting a 300ms idle timeout forever; only the
  // deadline can end this.
  const timers = [];
  const server = await listen((socket) => {
    const t = setInterval(() => socket.write('.'), 50);
    timers.push(t);
    socket.on('close', () => clearInterval(t));
    socket.on('error', () => {});
  });
  const { port } = server.address();
  const started = Date.now();
  const kind = await RunTcpSession({
    Address: '127.0.0.1',
    Port: port,
    IdleMs: 300,
    DeadlineMs: 400,
    OnData: () => {},
    OnTimeout: (_s, k) => k,
    OnError: () => 'error',
  });
  assert.equal(kind, 'deadline');
  assert.ok(Date.now() - started < 2000, 'deadline did not bound the session');
  for (const t of timers) clearInterval(t);
  await close(server);
});

test('the idle timeout fires when the peer goes silent', async () => {
  const server = await listen(() => {});
  const { port } = server.address();
  const kind = await RunTcpSession({
    Address: '127.0.0.1',
    Port: port,
    IdleMs: 150,
    OnTimeout: (_s, k) => k,
    OnError: () => 'error',
  });
  assert.equal(kind, 'idle');
  await close(server);
});

test('a refused connection reports through OnError', async () => {
  const port = await closedPort();
  const result = await RunTcpSession({
    Address: '127.0.0.1',
    Port: port,
    IdleMs: 1000,
    OnTimeout: () => 'timeout',
    OnError: (m) => m,
  });
  assert.match(result, /ECONNREFUSED/);
});

test('ReplyQueue resolves a request once its predicate sees a whole reply', async () => {
  const queue = new ReplyQueue(1000);
  const line = (buf) => {
    const i = buf.indexOf('\n');
    return i === -1 ? null : i + 1;
  };
  const pending = queue.Next(line);
  assert.equal(queue.Feed('par'), true);
  assert.equal(queue.Feed('tial\nnext\n'), true);
  assert.equal(await pending, 'partial\n');
  // The remainder stays buffered for the next request.
  assert.equal(await queue.Next(line), 'next\n');
});

test('ReplyQueue reports an oversized buffer and fails a pending request on demand', async () => {
  const queue = new ReplyQueue(4);
  assert.equal(queue.Feed('12345'), false);
  const pending = queue.Next(() => null);
  queue.FailPending(new Error('session ended'));
  await assert.rejects(pending, /session ended/);
});

test('ProbeTcpConnect: open is success, refused is degraded', async () => {
  const server = await listen((socket) => socket.on('error', () => {}));
  const open = await ProbeTcpConnect('127.0.0.1', server.address().port, 1000);
  assert.equal(open.Success, true);
  assert.equal(typeof open.LatencyMs, 'number');
  await close(server);

  const refused = await ProbeTcpConnect('127.0.0.1', await closedPort(), 1000);
  assert.equal(refused.Success, false);
  assert.equal(refused.Degraded, true);
});
