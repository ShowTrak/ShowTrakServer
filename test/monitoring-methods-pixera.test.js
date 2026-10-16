const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loadPixera() {
  return loadWithMocks(methodPath('pixera.js'), {});
}

function framePxr1(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.write('pxr1', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function frameDl(obj) {
  return Buffer.from(JSON.stringify(obj) + '0xPX', 'utf8');
}

// Split a framed request stream in whichever framing it arrives.
function takeRequests(state) {
  const out = [];
  for (;;) {
    if (state.buf.length >= 8 && state.buf.toString('latin1', 0, 4) === 'pxr1') {
      const size = state.buf.readUInt32LE(4);
      if (state.buf.length < 8 + size) break;
      out.push({ framing: 'pxr1', req: JSON.parse(state.buf.toString('utf8', 8, 8 + size)) });
      state.buf = state.buf.subarray(8 + size);
      continue;
    }
    const end = state.buf.indexOf('0xPX');
    if (end < 0 || state.buf.toString('latin1', 0, 4) === 'pxr1') break;
    out.push({ framing: 'dl', req: JSON.parse(state.buf.toString('utf8', 0, end)) });
    state.buf = state.buf.subarray(end + 4);
  }
  return out;
}

// A fake PIXERA API access point.
//   framing     : 'pxr1' | 'dl' — what this access point accepts; the other gets silence
//   project     : getProjectName result
//   timelines   : { name: transportMode }
//   revision    : getApiRevision result
//   chunked     : write replies one byte at a time (fragmented TCP)
//   errors      : methods answered with a JSON-RPC error
//   raw         : (socket) => void, takes over the connection entirely
function startPixera({
  framing = 'pxr1',
  project = 'Main Show',
  timelines = { Intro: 1, Loop: 2, Outro: 3 },
  revision = 480,
  chunked = false,
  errors = [],
  raw = null,
} = {}) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const seen = [];
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      if (raw) return raw(socket);
      const state = { buf: Buffer.alloc(0) };
      socket.on('data', (chunk) => {
        state.buf = Buffer.concat([state.buf, chunk]);
        for (const { framing: f, req } of takeRequests(state)) {
          seen.push(req);
          if (f !== framing) continue; // a mismatched access point says nothing
          let reply;
          if (errors.includes(req.method)) {
            reply = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'nope' } };
          } else if (req.method === 'Pixera.Utility.getApiRevision') {
            reply = { jsonrpc: '2.0', id: req.id, result: revision };
          } else if (req.method === 'Pixera.Session.getProjectName') {
            reply = { jsonrpc: '2.0', id: req.id, result: project };
          } else if (req.method === 'Pixera.Timelines.getTimelineNames') {
            reply = { jsonrpc: '2.0', id: req.id, result: Object.keys(timelines) };
          } else if (req.method === 'Pixera.Compound.getTransportModeOnTimeline') {
            reply = { jsonrpc: '2.0', id: req.id, result: timelines[req.params.timelineName] };
          } else {
            continue;
          }
          const bytes = framing === 'dl' ? frameDl(reply) : framePxr1(reply);
          if (chunked) for (const b of bytes) socket.write(Buffer.from([b]));
          else socket.write(bytes);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

test('pixera exposes its identity and read-only defaults', () => {
  const px = loadPixera();
  assert.equal(px.ID, 'pixera');
  const byKey = Object.fromEntries(px.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 1400);
  assert.equal(byKey.Port.Required, true);
  assert.equal(byKey.Framing.Default, 'pxr1');
  assert.equal(byKey.CheckProject.Default, false);
  assert.equal(byKey.CheckPlayingTimelines.Default, false);
  assert.equal(byKey.PlayingTimelines.Type, 'list');
  assert.deepEqual(byKey.PlayingTimelines.VisibleWhen, {
    Key: 'CheckPlayingTimelines',
    Equals: true,
  });
  assert.equal(byKey.Timeout.Advanced, true);
  assert.ok(!px.Actions);
});

test('pixera happy path reads revision, project and timeline transports', async () => {
  const px = loadPixera();
  const srv = await startPixera();
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.ApiRevision, 480);
    assert.equal(result.ApiBeta, false);
    assert.equal(result.ProjectName, 'Main Show');
    assert.equal(result.TimelineCount, 3);
    assert.deepEqual(result.Timelines, [
      { Name: 'Intro', Transport: 'play' },
      { Name: 'Loop', Transport: 'pause' },
      { Name: 'Outro', Transport: 'stop' },
    ]);
    // Only documented getters were sent.
    for (const req of srv.seen) assert.match(req.method, /\.get[A-Z]/);
    assert.equal(srv.seen[0].jsonrpc, '2.0');
  } finally {
    await srv.close();
  }
});

test('pixera speaks the delimited JSON/TCP(dl) framing when selected', async () => {
  const px = loadPixera();
  const srv = await startPixera({ framing: 'dl', revision: 481 });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1500, Framing: 'dl' },
    });
    assert.equal(result.Success, true);
    assert.equal(result.ApiRevision, 481);
    assert.equal(result.ApiBeta, true);
    assert.equal(result.Timelines.length, 3);
  } finally {
    await srv.close();
  }
});

test('pixera is offline with a framing hint when the access point stays silent', async () => {
  const px = loadPixera();
  const srv = await startPixera({ framing: 'dl' });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 600, Framing: 'pxr1' },
    });
    assert.equal(result.Success, false);
    assert.match(result.Error, /protocol matches/);
  } finally {
    await srv.close();
  }
});

test('pixera reassembles replies fragmented one byte at a time', async () => {
  const px = loadPixera();
  const srv = await startPixera({ chunked: true, project: 'Schön Show' });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.ProjectName, 'Schön Show');
  } finally {
    await srv.close();
  }
});

test('pixera degrades on a different project, ignoring case and .pxr', async () => {
  const px = loadPixera();
  const srv = await startPixera({ project: 'Main Show' });
  try {
    const ok = await px.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: srv.port,
        Timeout: 1500,
        CheckProject: true,
        ExpectedProject: 'main show.pxr',
      },
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1500, CheckProject: true, ExpectedProject: 'Rehearsal' },
    });
    assert.equal(bad.Success, true);
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'Project "Main Show" (expected "Rehearsal")');
  } finally {
    await srv.close();
  }
});

test('pixera names each listed timeline that is not playing or does not exist', async () => {
  const px = loadPixera();
  const srv = await startPixera();
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: srv.port,
        Timeout: 1500,
        CheckPlayingTimelines: true,
        PlayingTimelines: ['intro', 'Loop', 'Outro', 'Encore'],
      },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      'Timeline "Loop": paused; Timeline "Outro": stopped; Timeline "Encore": not found'
    );
  } finally {
    await srv.close();
  }
});

test('pixera timeline list is ignored while the toggle is off', async () => {
  const px = loadPixera();
  const srv = await startPixera();
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1500, PlayingTimelines: ['Loop'] },
    });
    assert.ok(!result.Degraded);
  } finally {
    await srv.close();
  }
});

test('pixera reports a JSON-RPC error on an enabled read as a failure to read', async () => {
  const px = loadPixera();
  const srv = await startPixera({ errors: ['Pixera.Session.getProjectName'] });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1500, CheckProject: true, ExpectedProject: 'X' },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Failed to read the project name');
  } finally {
    await srv.close();
  }
});

test('pixera reads a capped number of timelines, listed ones first', async () => {
  const px = loadPixera();
  const { MAX_TIMELINE_READS } = px._internal;
  const timelines = {};
  for (let i = 0; i < MAX_TIMELINE_READS + 10; i++) timelines[`TL ${i}`] = 3;
  timelines['Last'] = 1;
  const srv = await startPixera({ timelines });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: srv.port,
        Timeout: 3000,
        CheckPlayingTimelines: true,
        PlayingTimelines: ['Last'],
      },
    });
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Timelines.length, MAX_TIMELINE_READS);
    assert.equal(result.Timelines[0].Name, 'Last');
    assert.equal(result.TimelinesTruncated, true);
  } finally {
    await srv.close();
  }
});

test('pixera degrades when the responder is not PIXERA', async () => {
  const px = loadPixera();
  const srv = await startPixera({
    raw: (socket) => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'),
  });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /does not look like the PIXERA JSON API/);
  } finally {
    await srv.close();
  }
});

test('pixera degrades when a JSON-RPC peer gives a non-numeric revision', async () => {
  const px = loadPixera();
  const srv = await startPixera({ revision: 'hello' });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.IsPixera, false);
  } finally {
    await srv.close();
  }
});

test('pixera is offline (and degraded-refused) when the port is closed', async () => {
  const px = loadPixera();
  const tmp = await startPixera();
  const port = tmp.port;
  await tmp.close();
  const result = await px.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(result.Success, false);
  assert.match(result.Error, /ECONNREFUSED/);
  assert.equal(result.Degraded, true);
});

test('pixera rejects a missing address without probing', async () => {
  const px = loadPixera();
  assert.deepEqual(await px.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
});

test('pixera ParseReply never throws on hostile JSON', () => {
  const { ParseReply, TransportOf } = loadPixera()._internal;
  assert.doesNotThrow(() => ParseReply('{"id":{"toString":1}}'));
  assert.equal(ParseReply('{"id":{"toString":1}}'), null);
  assert.equal(ParseReply('{"id":{"valueOf":1,"toString":1},"result":1}'), null);
  assert.equal(ParseReply('{"id":[1],"result":1}'), null);
  assert.equal(ParseReply('[1,2]'), null);
  assert.equal(ParseReply('{"id":"12","result":1}').Id, 12);
  assert.deepEqual(ParseReply('{"id":4,"error":{"toString":1,"message":{"toString":1}}}'), {
    Id: 4,
    Ok: false,
    Result: null,
    Error: 'JSON-RPC error',
  });
  assert.equal(ParseReply('{"id":4,"error":"boom"}').Error, 'boom');
  assert.equal(TransportOf({ toString: 1 }), null);
  assert.equal(TransportOf('1'), null);
  assert.equal(TransportOf(2), 'pause');
});

test('pixera survives hostile replies on the wire', async () => {
  const px = loadPixera();
  const hostile = (obj) => {
    const body = Buffer.from(obj, 'utf8');
    const head = Buffer.alloc(8);
    head.write('pxr1', 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const srv = await startPixera({
    raw: (socket) =>
      socket.once('data', () => {
        socket.write(hostile('{"id":{"toString":1},"result":480}'));
        socket.write(hostile('{"id":1,"result":{"toString":1}}'));
        socket.write(hostile('{"id":2,"error":{"toString":1}}'));
        socket.write(hostile('{"id":3,"result":[{"toString":1},"Main"]}'));
      }),
  });
  try {
    const result = await px.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 1000 },
    });
    // Reached, but the revision is not a number -> not PIXERA, degraded.
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.IsPixera, false);
  } finally {
    await srv.close();
  }
});

test('pixera framing helpers', () => {
  const { EncodeRequest, DecodeStream, ParseReply } = loadPixera()._internal;
  const req = EncodeRequest(7, 'Pixera.Utility.getApiRevision', null, 'pxr1');
  assert.equal(req.toString('latin1', 0, 4), 'pxr1');
  assert.equal(req.readUInt32LE(4), req.length - 8);
  // The length counts BYTES, so a multi-byte name stays in frame.
  const named = EncodeRequest(1, 'm', { timelineName: 'Ü' }, 'pxr1');
  assert.equal(named.readUInt32LE(4), Buffer.byteLength(named.toString('utf8', 8)));
  assert.ok(EncodeRequest(1, 'm', null, 'dl').toString().endsWith('}0xPX'));

  // Partial header, partial body, then two messages in mixed framings.
  const a = framePxr1({ id: 1, result: 1 });
  const b = frameDl({ id: 2, result: 'x' });
  const all = Buffer.concat([a, b]);
  let r = DecodeStream(all.subarray(0, 3));
  assert.deepEqual(r.Messages, []);
  assert.equal(r.Rest.length, 3);
  r = DecodeStream(all.subarray(0, 10));
  assert.deepEqual(r.Messages, []);
  r = DecodeStream(all);
  assert.equal(r.Messages.length, 2);
  assert.equal(r.Rest.length, 0);
  assert.equal(r.Desync, false);
  assert.equal(DecodeStream(Buffer.from('garbage')).Desync, true);

  assert.equal(ParseReply('not json'), null);
  assert.equal(ParseReply('{"result":1}'), null);
  assert.deepEqual(ParseReply('{"id":3,"error":{"message":"bad"}}'), {
    Id: 3,
    Ok: false,
    Result: null,
    Error: 'bad',
  });
});

test('pixera Debug escapes device-supplied strings', () => {
  const px = loadPixera();
  const html = px.Debug(
    {
      Success: true,
      LatencyMs: 4,
      ApiRevision: 480,
      ProjectName: '<script>alert(1)</script>',
      TimelineCount: 1,
      Timelines: [{ Name: '<img src=x onerror=1>', Transport: 'play' }],
    },
    { Address: '127.0.0.1', Settings: {} }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Playing'));
});

test('pixera Debug renders the offline hint', () => {
  const px = loadPixera();
  const html = px.Debug(
    { Success: false, Error: 'boom' },
    { Address: 'media.local', Settings: {} }
  );
  assert.ok(html.includes('media.local:1400'));
  assert.ok(html.includes('Settings → API'));
});
