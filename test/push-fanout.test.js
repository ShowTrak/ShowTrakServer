const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const WebSocket = require('ws');

// Exercises src/Modules/Server/push-fanout.ts against a REAL Socket.IO server.
//
// The Web UI and SDK sinks moved from one `socket.emit` per socket to a single
// broadcast to the chosen socket ids, so the packet is encoded once. The SDK is
// a published contract consumed by clients on their own release cycle, so the
// bytes on the wire must not change: these tests read the raw engine.io frames
// a plain WebSocket receives and compare them with what `socket.emit` sends.

const { EmitToSockets } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'Server', 'push-fanout.js')
);

async function startServer() {
  const HttpServer = http.createServer();
  const io = new Server(HttpServer);
  await new Promise((resolve) => HttpServer.listen(0, '127.0.0.1', resolve));
  const { port } = HttpServer.address();
  return {
    io,
    port,
    close: () =>
      new Promise((resolve) => {
        io.close();
        HttpServer.close(() => resolve());
      }),
  };
}

// Connect a raw engine.io v4 WebSocket client to a namespace, resolving with the
// server-side socket and the list of frames the client received afterwards.
function connectRaw(port, ns, io) {
  return new Promise((resolve, reject) => {
    const Frames = [];
    const Ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const Namespace = io.of(ns);
    Ws.on('error', reject);
    Ws.on('message', (Data) => {
      const Text = Data.toString();
      if (Text.startsWith('0')) {
        Ws.send(`40${ns},`);
        return;
      }
      if (Text === '2') {
        Ws.send('3');
        return;
      }
      if (Text.startsWith(`40${ns},`)) {
        const { sid } = JSON.parse(Text.slice(`40${ns},`.length));
        const ServerSocket = Namespace.sockets.get(sid);
        resolve({ ServerSocket, Frames, Ws });
        return;
      }
      Frames.push(Text);
    });
  });
}

const waitFor = async (Predicate, Ms = 2000) => {
  const Deadline = Date.now() + Ms;
  while (!Predicate()) {
    if (Date.now() > Deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('a broadcast to chosen sockets sends the same bytes as socket.emit, only to them', async (t) => {
  const Srv = await startServer();
  t.after(() => Srv.close());
  const Ns = Srv.io.of('/t');
  const A = await connectRaw(Srv.port, '/t', Srv.io);
  const B = await connectRaw(Srv.port, '/t', Srv.io);
  const Left = await connectRaw(Srv.port, '/t', Srv.io);
  t.after(() => [A, B, Left].forEach((C) => C.Ws.close()));

  const Payload = [{ UUID: 'u1', Vitals: { CPU: { UsagePercentage: 12 } }, Items: [1, 2] }];

  // Reference: what a single per-socket emit puts on the wire.
  Left.ServerSocket.emit('ClientUpdated', ...Payload);
  await waitFor(() => Left.Frames.length === 1);
  const Expected = Left.Frames[0];

  EmitToSockets(Ns, [A.ServerSocket, B.ServerSocket], 'ClientUpdated', Payload);
  await waitFor(() => A.Frames.length === 1 && B.Frames.length === 1);
  assert.equal(A.Frames[0], Expected);
  assert.equal(B.Frames[0], Expected);

  // The socket that was not chosen receives nothing more.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(Left.Frames.length, 1);
});

test('a single socket and an empty list both behave', async (t) => {
  const Srv = await startServer();
  t.after(() => Srv.close());
  const Ns = Srv.io.of('/t');
  const A = await connectRaw(Srv.port, '/t', Srv.io);
  t.after(() => A.Ws.close());

  EmitToSockets(Ns, [], 'Notify', ['info', 'nobody']);
  EmitToSockets(Ns, [A.ServerSocket], 'Notify', ['info', 'one']);
  await waitFor(() => A.Frames.length === 1);
  assert.equal(A.Frames[0], '42/t,["Notify","info","one"]');
});

test('without a broadcast operator it falls back to per-socket emits, isolating failures', () => {
  const Got = [];
  const Dead = {
    id: 'dead',
    emit: () => {
      throw new Error('closed');
    },
  };
  const Alive = { id: 'alive', emit: (...Args) => Got.push(Args) };
  EmitToSockets({}, [Dead, Alive], 'Notify', ['info', 'x']);
  assert.deepEqual(Got, [['Notify', 'info', 'x']]);
});

test('a throwing broadcast is swallowed and never retried per socket', () => {
  const Got = [];
  const Ns = {
    to: () => ({
      emit: () => {
        throw new Error('adapter down');
      },
    }),
  };
  const S1 = { id: 's1', emit: (...Args) => Got.push(Args) };
  const S2 = { id: 's2', emit: (...Args) => Got.push(Args) };
  assert.doesNotThrow(() => EmitToSockets(Ns, [S1, S2], 'Notify', ['info']));
  assert.deepEqual(Got, []);
});
