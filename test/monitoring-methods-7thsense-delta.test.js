const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function load() {
  return loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', '7thsense-delta.js'),
    {}
  );
}

const BANNER_LINES = [
  'ApplicationName Deltaserver.exe',
  'Welcome to the 7thSense Delta Telnet interface, Help[CR] for commands',
  'SERVER: ServerNode1',
  'READY',
];

const STATUS_FIELDS = {
  'SERVER  ': 'ServerNode1 (Leader)',
  'FILE   ': 'Main Show.xml',
  'MODE   ': 'Stopped',
  CURRENTFRAME: '2646',
  FRAMERATE: '30.0',
  'LICENCE ': 'Permanent',
  MOVIEDRIVES: 'C E',
  OTHERDRIVE: 'C',
  GRAPHICS: '1920 X 1080 60 HZ',
  'SMPTE ': 'OFF',
  AUDIOLEVEL: '100',
  VIDEOLEVEL: '100',
};

function statusBlock(fields, { eol = '\r\n', blank = true, terminator = 'OK' } = {}) {
  return (
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}${eol}`)
      .join('') +
    (blank ? eol : '') +
    `${terminator}${eol}`
  );
}

// A fake Delta external-control port. Speaks first with the banner, then
// answers STATUS (terminated by CR, as the docs specify). Every byte received
// is recorded so tests can prove the probe only ever sends STATUS.
function startDelta(opts = {}) {
  const {
    banner = BANNER_LINES.join('\r\n') + '\r\n',
    preBanner = null, // raw Buffer written before the banner (telnet IAC bytes)
    fields = STATUS_FIELDS,
    reply = null, // raw reply string, or a function returning one
    eol = '\r\n',
    blank = true,
    fragment = false,
    silent = false,
    closeImmediately = false,
  } = opts;
  const received = [];
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      if (closeImmediately) {
        socket.destroy();
        return;
      }
      const send = (data) => {
        if (!fragment) {
          socket.write(data);
          return;
        }
        // Dribble the reply out in 3-byte chunks to exercise reassembly.
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        let i = 0;
        const step = () => {
          if (i >= buf.length || socket.destroyed) return;
          socket.write(buf.subarray(i, i + 3));
          i += 3;
          setImmediate(step);
        };
        step();
      };
      if (silent) {
        socket.on('data', (chunk) => received.push(chunk.toString('latin1')));
        return;
      }
      if (preBanner) send(preBanner);
      if (banner != null) send(banner);
      let buf = '';
      socket.on('data', (chunk) => {
        received.push(chunk.toString('latin1'));
        buf += chunk.toString('latin1');
        let idx;
        while ((idx = buf.indexOf('\r')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.toUpperCase() === 'STATUS') {
            const text =
              typeof reply === 'function'
                ? reply()
                : reply != null
                  ? reply
                  : statusBlock(fields, { eol, blank });
            send(text);
          } else if (line) {
            send(`BAD${eol}`);
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

// A fake DeltaMonitor web API.
function startMonitor({ status = 200, body = { GPUS: [{ GPU_Id: 0, Temperature: 50 }] } } = {}) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url !== '/api/deltamonitor/server/gputemp' || status === 404) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(r);
          }),
      });
    });
  });
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function runAgainst(serverOpts, settings = {}, target = {}) {
  const m = load();
  m._internal.ResetState();
  const server = await startDelta(serverOpts);
  try {
    const result = await m.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, ...settings },
      ...target,
    });
    return { m, result, received: server.received };
  } finally {
    await server.close();
  }
}

// --- Happy path / framing ------------------------------------------------------

test('7thsense-delta happy path parses STATUS and sends only STATUS', async () => {
  const { result, received } = await runAgainst({});
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.IsDelta, true);
  assert.equal(result.StatusReply, 'ok');
  assert.equal(result.ServerName, 'ServerNode1');
  assert.equal(result.Role, 'Leader');
  assert.equal(result.ShowFile, 'Main Show.xml');
  assert.equal(result.Mode, 'Stopped');
  assert.equal(result.CurrentFrame, 2646);
  assert.equal(result.FrameRate, 30);
  assert.equal(result.Licence, 'Permanent');
  assert.equal(result.Graphics, '1920 X 1080 60 HZ');
  assert.equal(result.Smpte, 'OFF');
  assert.equal(result.OtherDrives, 'C');
  assert.equal(result.StatusFields.CURRENTFRAME, '2646');
  assert.equal(result.StatusLines.length, 12);
  assert.equal(typeof result.LatencyMs, 'number');
  assert.equal(received.join(''), 'STATUS\r');
});

test('7thsense-delta reassembles 3-byte fragments with bare LF line endings', async () => {
  const { result } = await runAgainst({
    banner: BANNER_LINES.join('\n') + '\n',
    eol: '\n',
    fragment: true,
  });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.ServerName, 'ServerNode1');
  assert.equal(result.CurrentFrame, 2646);
});

test('7thsense-delta strips telnet IAC negotiation and never answers it', async () => {
  const iac = Buffer.concat([
    Buffer.from([0xff, 0xfd, 0x01]), // IAC DO ECHO
    Buffer.from([0xff, 0xfb, 0x03]), // IAC WILL SGA
    Buffer.from([0xff, 0xfa, 0x18, 0x01, 0xff, 0xf0]), // IAC SB TTYPE SEND IAC SE
    Buffer.from([0xff, 0xf1]), // IAC NOP
  ]);
  const { result, received } = await runAgainst({ preBanner: iac, fragment: true });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.ServerName, 'ServerNode1');
  assert.equal(received.join(''), 'STATUS\r');
});

test('7thsense-delta reads the Delta 2.6 variants: Master/Slave, OTHERDRIVES, no blank line, NBSP', async () => {
  const { result } = await runAgainst({
    blank: false,
    fields: {
      'SERVER  ': 'athlon2600 (Slave)',
      'FILE   ': 'TILE.xml',
      'MODE   ': 'Playing',
      CURRENTFRAME: '22',
      FRAMERATE: '37.5',
      'LICENCE ': '30.12.2006',
      MOVIEDRIVES: 'C E V W',
      OTHERDRIVES: 'C',
      GRAPHICS: '1920 X 1080 60 HZ',
    },
  });
  assert.equal(result.Success, true);
  assert.equal(result.Role, 'Follower');
  assert.equal(result.Mode, 'Playing');
  assert.equal(result.FrameRate, 37.5);
  assert.equal(result.OtherDrives, 'C');
  assert.equal(result.Graphics, '1920 X 1080 60 HZ');
  assert.equal(result.Licence, '30.12.2006');
});

test('7thsense-delta still reads a server that sends no banner (STATUS after the grace)', async () => {
  const { result, received } = await runAgainst({ banner: null }, { Timeout: 1200 });
  assert.equal(result.Success, true);
  assert.equal(result.IsDelta, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.ServerName, 'ServerNode1');
  assert.equal(received.join(''), 'STATUS\r');
});

// --- Unhappy replies --------------------------------------------------------------

test('7thsense-delta BAD reply is Degraded, not a crash', async () => {
  const { result } = await runAgainst({ reply: 'BAD\r\n' });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Delta did not recognise STATUS (BAD)');
});

test('7thsense-delta reports external control switched off (EXTCTRLCOMMS)', async () => {
  const { result } = await runAgainst({ reply: 'External Control Comms disabled\r\n' });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /External control is disabled/);
});

test('7thsense-delta unrecognised STATUS reply is Degraded', async () => {
  const { result } = await runAgainst({ reply: 'hello there\r\nfoo: bar\r\nOK\r\n' });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Unrecognised STATUS reply');
});

test('7thsense-delta a STATUS reply cut off by the budget reads as timed out', async () => {
  const { result } = await runAgainst(
    { reply: 'SERVER : Node (Leader)\r\nMODE : Playing\r\n' },
    { Timeout: 700 }
  );
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Timed out reading the status');
});

test('7thsense-delta wrong device fingerprint is Degraded', async () => {
  const { result } = await runAgainst(
    { banner: 'SSH-2.0-OpenSSH_9.6\r\n', reply: '' },
    { Timeout: 800 }
  );
  assert.equal(result.Success, true);
  assert.equal(result.IsDelta, false);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Responded, but does not look like a 7thSense Delta server');
});

test('7thsense-delta silent port is Offline after the budget', async () => {
  const { result, received } = await runAgainst({ silent: true }, { Timeout: 600 });
  assert.equal(result.Success, false);
  assert.ok(!result.Degraded);
  assert.match(result.Error, /No reply from the Delta server after 600ms/);
  // The grace still only ever sent STATUS.
  assert.equal(received.join(''), 'STATUS\r');
});

test('7thsense-delta refused port is Offline with Degraded', async () => {
  const m = load();
  m._internal.ResetState();
  const port = await freePort();
  const result = await m.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(result.Success, false);
  assert.equal(result.Degraded, true);
  assert.match(result.Error, /ECONNREFUSED/);
});

test('7thsense-delta a connection accepted then closed at once is Degraded, not Offline', async () => {
  const { m, result } = await runAgainst({ closeImmediately: true }, { Timeout: 1000 });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, m._internal.CLOSED_EARLY_REASON);
  assert.match(result.DegradedReason, /all Telnet connections may be in use/);
  assert.equal(result.ConnectionClosedEarly, true);
  const html = m.Debug(result, { Address: '127.0.0.1', Settings: {} });
  assert.ok(html.includes('Degraded'));
  assert.ok(html.includes('5 Telnet connections'));
  assert.ok(!html.includes('Mode'), 'no identity rows for a server that sent nothing');
});

test('7thsense-delta rejects a missing address and an invalid port', async () => {
  const m = load();
  assert.deepEqual(await m.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const bad = await m.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.equal(bad.Success, false);
  assert.match(bad.Error, /Invalid port/);
});

// --- Assertions ----------------------------------------------------------------------

test('7thsense-delta CheckPlaying flags Stopped and Preparing to Play, passes Playing', async () => {
  const stopped = await runAgainst({}, { CheckPlaying: true });
  assert.equal(stopped.result.DegradedReason, 'Not playing (Stopped)');

  const preparing = await runAgainst(
    { fields: { ...STATUS_FIELDS, 'MODE   ': 'Preparing to Play' } },
    { CheckPlaying: true }
  );
  assert.equal(preparing.result.DegradedReason, 'Preparing to play, not playing');

  const playing = await runAgainst(
    { fields: { ...STATUS_FIELDS, 'MODE   ': 'Playing' } },
    { CheckPlaying: true }
  );
  assert.ok(!playing.result.Degraded, playing.result.DegradedReason);
});

test('7thsense-delta CheckShow ignores case and the .xml extension', async () => {
  const match = await runAgainst({}, { CheckShow: true, ExpectedShow: 'main show' });
  assert.ok(!match.result.Degraded, match.result.DegradedReason);

  const exact = await runAgainst({}, { CheckShow: true, ExpectedShow: 'MAIN SHOW.XML' });
  assert.ok(!exact.result.Degraded, exact.result.DegradedReason);

  const wrong = await runAgainst({}, { CheckShow: true, ExpectedShow: 'Rehearsal' });
  assert.equal(wrong.result.DegradedReason, 'Show "Main Show.xml" loaded, expected "Rehearsal"');

  const unset = await runAgainst({}, { CheckShow: true, ExpectedShow: '  ' });
  assert.equal(unset.result.DegradedReason, 'No expected show set');
});

test('7thsense-delta CheckRole catches a leader change', async () => {
  const ok = await runAgainst({}, { CheckRole: true, ExpectedRole: 'leader' });
  assert.ok(!ok.result.Degraded, ok.result.DegradedReason);

  const wrong = await runAgainst({}, { CheckRole: true, ExpectedRole: 'follower' });
  assert.equal(wrong.result.DegradedReason, 'Server is Leader, expected Follower');

  const noRole = await runAgainst(
    { fields: { ...STATUS_FIELDS, 'SERVER  ': 'ServerNode1' } },
    { CheckRole: true }
  );
  assert.equal(noRole.result.DegradedReason, 'Failed to read the server role');
});

test('7thsense-delta CheckLicence flags a past date, warns ahead, passes Permanent', async () => {
  const m = load();
  const now = new Date(2026, 9, 16, 12, 0, 0).getTime();
  const { AssessLicence } = m._internal;
  assert.equal(AssessLicence('Permanent', now, 7), null);
  assert.equal(AssessLicence('permanent', now, 7), null);
  assert.equal(AssessLicence('30.12.2006', now, 7), 'Licence expired 30.12.2006');
  assert.equal(AssessLicence('16.10.2026', now, 0), 'Licence expires today (16.10.2026)');
  assert.equal(AssessLicence('19.10.2026', now, 7), 'Licence expires 19.10.2026 (in 3 days)');
  assert.equal(AssessLicence('17.10.2026', now, 7), 'Licence expires 17.10.2026 (in 1 day)');
  assert.equal(AssessLicence('30.12.2026', now, 7), null);
  assert.equal(AssessLicence('Demo', now, 7), 'Licence: Demo (neither Permanent nor a date)');
  assert.equal(AssessLicence(null, now, 7), 'Failed to read the licence');

  // Through Run, with the clock pinned.
  const loaded = load();
  loaded._internal.ResetState();
  loaded._internal.SetClock(() => now);
  const server = await startDelta({ fields: { ...STATUS_FIELDS, 'LICENCE ': '30.12.2006' } });
  try {
    const result = await loaded.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, CheckLicence: true },
    });
    assert.equal(result.DegradedReason, 'Licence expired 30.12.2006');
    const off = await loaded.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.ok(!off.Degraded, 'licence is not checked unless enabled');
  } finally {
    loaded._internal.SetClock(null);
    await server.close();
  }
});

test('7thsense-delta ParseLicenceDate reads dotted, ISO and slash dates', () => {
  const { ParseLicenceDate } = load()._internal;
  assert.deepEqual(ParseLicenceDate('30.12.2006'), { Year: 2006, Month: 12, Day: 30 });
  assert.deepEqual(ParseLicenceDate('2026-12-30'), { Year: 2026, Month: 12, Day: 30 });
  assert.deepEqual(ParseLicenceDate('30/12/2026'), { Year: 2026, Month: 12, Day: 30 });
  assert.deepEqual(ParseLicenceDate('12/30/2026'), { Year: 2026, Month: 12, Day: 30 });
  assert.deepEqual(ParseLicenceDate('Expires 01.02.2027'), { Year: 2027, Month: 2, Day: 1 });
  assert.equal(ParseLicenceDate('31.02.2026'), null);
  assert.equal(ParseLicenceDate('Permanent'), null);
});

test('7thsense-delta AdvanceFrame gives no verdict on first sample, show change, short window or stop', () => {
  const { AdvanceFrame, MIN_ADVANCE_WINDOW_MS: W } = load()._internal;
  const cur = (frame, at, extra = {}) => ({
    ShowFile: 'a.xml',
    Frame: frame,
    Playing: true,
    At: at,
    ...extra,
  });

  const first = AdvanceFrame(null, cur(10, 0));
  assert.equal(first.Verdict, null);
  assert.equal(first.Next.Frame, 10);

  const stalled = AdvanceFrame(first.Next, cur(10, W));
  assert.equal(stalled.Verdict, 'stalled');

  const moving = AdvanceFrame(first.Next, cur(40, W));
  assert.equal(moving.Verdict, 'advancing');

  const looped = AdvanceFrame(first.Next, cur(2, W));
  assert.equal(looped.Verdict, 'advancing');

  // Too soon: the older sample is kept so it is not compared with itself.
  const soon = AdvanceFrame(first.Next, cur(10, W - 1));
  assert.equal(soon.Verdict, null);
  assert.equal(soon.Next, first.Next);

  const showChange = AdvanceFrame(first.Next, cur(10, W, { ShowFile: 'b.xml' }));
  assert.equal(showChange.Verdict, null);
  assert.equal(showChange.Next.ShowFile, 'b.xml');

  const stopped = AdvanceFrame(first.Next, cur(10, W, { Playing: false }));
  assert.equal(stopped.Verdict, null);

  const fromStopped = AdvanceFrame({ ...first.Next, Playing: false }, cur(10, W));
  assert.equal(fromStopped.Verdict, null);

  const noFrame = AdvanceFrame(first.Next, cur(null, W));
  assert.deepEqual(noFrame, { Verdict: null, Next: null });
});

test('7thsense-delta CheckAdvancing through Run keys per check and ignores cached replays', async () => {
  const m = load();
  m._internal.ResetState();
  let clock = 1_000_000;
  m._internal.SetClock(() => clock);
  let frame = 100;
  const server = await startDelta({
    reply: () =>
      statusBlock({ ...STATUS_FIELDS, 'MODE   ': 'Playing', CURRENTFRAME: String(frame) }),
  });
  const run = (checkId) =>
    m.Run({
      Address: '127.0.0.1',
      CheckID: checkId,
      Settings: { Port: server.port, Timeout: 2000, CheckAdvancing: true },
    });
  try {
    const first = await run(7);
    assert.ok(!first.Degraded, 'no verdict on the first probe');
    assert.equal(first.FrameAdvancing, null);

    // A replay of the cached snapshot (same TakenAt) is never compared with itself.
    const replay = await run(7);
    assert.ok(!replay.Degraded, replay.DegradedReason);

    m._internal.ClearCaches();
    clock += 5000;
    frame = 250;
    const moving = await run(7);
    assert.ok(!moving.Degraded, moving.DegradedReason);
    assert.equal(moving.FrameAdvancing, true);

    m._internal.ClearCaches();
    clock += 5000;
    const stuck = await run(7);
    assert.equal(stuck.Degraded, true);
    assert.equal(
      stuck.DegradedReason,
      'Playing, but the frame has not advanced since the previous check (frame 250)'
    );
    assert.equal(stuck.FrameAdvancing, false);

    // Another check on the same server has its own (empty) history.
    const other = await run(8);
    assert.ok(!other.Degraded, other.DegradedReason);
    assert.equal(m._internal.Samples.has('check:7'), true);
    assert.equal(m._internal.Samples.has('check:8'), true);

    assert.equal(m.GetRunCacheKeyExtra({ CheckID: 7 }), 7);
    assert.equal(m.GetRunCacheKeyExtra({}), null);
    assert.equal(m._internal.SampleKey({}, { Address: 'Delta-1', Port: 23 }), 'addr:delta-1:23');
  } finally {
    m._internal.SetClock(null);
    await server.close();
  }
});

// --- GPU temperature (DeltaMonitor) -----------------------------------------------------

async function runWithGpu(monitorOpts, settings = {}) {
  const m = load();
  m._internal.ResetState();
  const delta = await startDelta({});
  const monitor = monitorOpts ? await startMonitor(monitorOpts) : null;
  const httpPort = monitor ? monitor.port : await freePort();
  try {
    const result = await m.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: delta.port,
        Timeout: 2000,
        CheckGpuTemp: true,
        HttpPort: httpPort,
        ...settings,
      },
    });
    return { m, result, requests: monitor ? monitor.requests : [], delta };
  } finally {
    await delta.close();
    if (monitor) await monitor.close();
  }
}

test('7thsense-delta GPU temperatures under the limit pass and are reported', async () => {
  const { result, requests } = await runWithGpu({
    body: {
      GPUS: [
        { GPU_Id: 0, Temperature: 50 },
        { GPU_Id: 1, Temperature: 49 },
      ],
    },
  });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.deepEqual(result.Gpus, [
    { Id: '0', TemperatureC: 50 },
    { Id: '1', TemperatureC: 49 },
  ]);
  assert.deepEqual(requests, ['GET /api/deltamonitor/server/gputemp']);
});

test('7thsense-delta a GPU over the limit is Degraded per GPU', async () => {
  const { result } = await runWithGpu(
    {
      body: {
        GPUS: [
          { GPU_Id: 0, Temperature: 70 },
          { GPU_Id: 1, Temperature: 91 },
        ],
      },
    },
    { MaxGpuTempC: 85 }
  );
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'GPU 1: 91 °C (limit 85 °C)');
});

test('7thsense-delta missing DeltaMonitor (404, refused, not JSON) is Degraded, never Offline', async () => {
  const { GPU_MISSING } = load()._internal;
  for (const opts of [{ status: 404 }, null, { body: '<html>Stack</html>' }]) {
    const { result } = await runWithGpu(opts);
    assert.equal(result.Success, true, JSON.stringify(opts));
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, GPU_MISSING);
    assert.equal(result.ServerName, 'ServerNode1');
  }
  assert.match(GPU_MISSING, /R-Series \/ P-Series/);
});

test('7thsense-delta GPU fetch is skipped unless enabled', async () => {
  const { result, requests } = await runWithGpu({}, { CheckGpuTemp: false });
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.Gpus, null);
  assert.deepEqual(requests, []);
});

test('7thsense-delta ParseGpuTemps accepts a data wrapper, string temps and any key case', () => {
  const { ParseGpuTemps } = load()._internal;
  assert.deepEqual(ParseGpuTemps({ data: { gpus: [{ gpu_id: 2, temperature: '61' }] } }), [
    { Id: '2', TemperatureC: 61 },
  ]);
  assert.deepEqual(ParseGpuTemps({ GPUS: [{ Temperature: 'n/a' }] }), [
    { Id: '0', TemperatureC: null },
  ]);
  assert.equal(ParseGpuTemps({ data: { status: {} } }), null);
  assert.equal(ParseGpuTemps([1, 2]), null);
  assert.equal(ParseGpuTemps(null), null);
});

// --- Pure helpers ----------------------------------------------------------------------

test('7thsense-delta ParseStatusFields accepts every documented colon spacing', () => {
  const { ParseStatusFields, ParseServerValue, NormaliseMode } = load()._internal;
  assert.deepEqual(
    ParseStatusFields([
      'SERVER  : Node (Leader)',
      'FILE   :show.xml',
      'currentframe: 5',
      'SMPTE : 01:02:03:04',
      'no colon here',
      ': empty key',
    ]),
    { SERVER: 'Node (Leader)', FILE: 'show.xml', CURRENTFRAME: '5', SMPTE: '01:02:03:04' }
  );
  assert.deepEqual(ParseServerValue('My Server (Master)'), { Name: 'My Server', Role: 'Leader' });
  assert.deepEqual(ParseServerValue('Node (Follower)'), { Name: 'Node', Role: 'Follower' });
  assert.deepEqual(ParseServerValue('Node (Standalone)'), { Name: 'Node', Role: 'Standalone' });
  assert.deepEqual(ParseServerValue('Node'), { Name: 'Node', Role: null });
  assert.equal(NormaliseMode('PLAYING'), 'Playing');
  assert.equal(NormaliseMode('preparing to play'), 'Preparing to Play');
  assert.equal(NormaliseMode('Paused'), 'Paused');
});

test('7thsense-delta TelnetFilter removes sequences split across chunks and keeps IAC IAC', () => {
  const { TelnetFilter } = load()._internal;
  const f = new TelnetFilter();
  const out = Buffer.concat([
    f.Feed(Buffer.from([0x41, 0xff])),
    f.Feed(Buffer.from([0xfb, 0x01, 0x42, 0xff, 0xfa])),
    f.Feed(Buffer.from([0x18, 0xff, 0xf0, 0x43, 0xff, 0xff, 0x44])),
  ]);
  assert.deepEqual([...out], [0x41, 0x42, 0x43, 0xff, 0x44]);
});

test('7thsense-delta DecodeLine reads UTF-8 and falls back to latin1', () => {
  const { DecodeLine } = load()._internal;
  assert.equal(
    DecodeLine(Buffer.from('FILE : Café.xml', 'utf8').toString('latin1')),
    'FILE : Café.xml'
  );
  assert.equal(DecodeLine(Buffer.from([0x43, 0x61, 0x66, 0xe9]).toString('latin1')), 'Café');
  assert.equal(DecodeLine('  A B\u0007 '), 'A B');
});

// --- Debug / settings ----------------------------------------------------------------------

test('7thsense-delta Debug escapes every device string', async () => {
  const evil = '<script>alert(1)</script>';
  const { m, result } = await runAgainst({
    fields: { ...STATUS_FIELDS, 'SERVER  ': `${evil} (Leader)`, 'FILE   ': `${evil}.xml` },
  });
  const html = m.Debug(result, { Address: '127.0.0.1', Settings: {} });
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('STATUS reply'));

  const gpuHtml = m.Debug(
    {
      Success: true,
      IsDelta: true,
      Gpus: [{ Id: evil, TemperatureC: 99 }],
      StatusLines: [],
    },
    { Address: '127.0.0.1', Settings: { CheckGpuTemp: true } }
  );
  assert.ok(!gpuHtml.includes('<script>'), gpuHtml);
  assert.ok(gpuHtml.includes('99 °C'));

  const wrong = m.Debug(
    { Success: true, Degraded: true, IsDelta: false, BannerLines: [evil], StatusLines: [] },
    { Address: '127.0.0.1', Settings: {} }
  );
  assert.ok(!wrong.includes('<script>'), wrong);
  assert.ok(wrong.includes('First lines received'));

  const offline = m.Debug({ Success: false, Error: evil }, { Address: '<b>x</b>', Settings: {} });
  assert.ok(!offline.includes('<script>') && !offline.includes('<b>'), offline);
});

test('7thsense-delta settings defaults', () => {
  const m = load();
  assert.equal(m.ID, '7thsense-delta');
  assert.equal(m.Name, '7thSense Delta');
  assert.equal(m.Group, 'Video');
  const byKey = Object.fromEntries(m.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 23);
  assert.equal(byKey.Port.Required, true);
  for (const key of [
    'CheckPlaying',
    'CheckAdvancing',
    'CheckShow',
    'CheckRole',
    'CheckLicence',
    'CheckGpuTemp',
  ]) {
    assert.equal(byKey[key].Default, false, key);
  }
  assert.equal(byKey.ExpectedRole.Default, 'leader');
  assert.equal(byKey.LicenceWarnDays.Default, 7);
  assert.equal(byKey.MaxGpuTempC.Default, 85);
  assert.equal(byKey.HttpPort.Default, 80);
  assert.equal(byKey.HttpPort.Advanced, true);
  assert.equal(byKey.Timeout.Default, 4000);
  assert.equal(byKey.Timeout.Advanced, true);
  assert.deepEqual(byKey.ExpectedShow.VisibleWhen, { Key: 'CheckShow', Equals: true });

  const opts = m._internal.ParseHealthOptions({ Settings: {} });
  assert.equal(opts.CheckPlaying, false);
  assert.equal(opts.ExpectedRole, 'Leader');
  assert.equal(opts.MaxGpuTempC, 85);
});
