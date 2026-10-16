const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loadObs() {
  return loadWithMocks(methodPath('obs-studio.js'), {});
}

function authString(password, salt, challenge) {
  const secret = crypto
    .createHash('sha256')
    .update(password + salt)
    .digest('base64');
  return crypto
    .createHash('sha256')
    .update(secret + challenge)
    .digest('base64');
}

function okResult(type, data) {
  return {
    requestType: type,
    requestId: type,
    requestStatus: { result: true, code: 100 },
    responseData: data,
  };
}

// A fake obs-websocket 5 server. `state` is read on every batch, so a test can
// mutate it between probes to simulate counters moving.
function startObs({
  password = null,
  state = {},
  hello = null,
  failRequests = [],
  silentAfterIdentify = false,
  onIdentify = null,
} = {}) {
  return new Promise((resolve) => {
    const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
    const challenge = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';
    const log = [];
    const closes = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws) => {
      ws.on('close', (code) => closes.push(code));
      ws.send(
        JSON.stringify(
          hello || {
            op: 0,
            d: {
              obsStudioVersion: '31.0.2',
              obsWebSocketVersion: '5.5.4',
              rpcVersion: 1,
              ...(password != null ? { authentication: { challenge, salt } } : {}),
            },
          }
        )
      );
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        log.push(msg);
        if (msg.op === 1) {
          if (onIdentify) onIdentify(msg.d);
          if (password != null && msg.d.authentication !== authString(password, salt, challenge)) {
            ws.close(4009, 'Authentication failed.');
            return;
          }
          ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        } else if (msg.op === 8) {
          if (silentAfterIdentify) return;
          const s = {
            stream: {
              outputActive: false,
              outputReconnecting: false,
              outputSkippedFrames: 0,
              outputTotalFrames: 0,
            },
            record: { outputActive: false, outputPaused: false },
            stats: {
              cpuUsage: 3.2,
              memoryUsage: 512,
              activeFps: 60,
              averageFrameRenderTime: 1.4,
              renderSkippedFrames: 0,
              renderTotalFrames: 1000,
              outputSkippedFrames: 0,
              outputTotalFrames: 1000,
            },
            scene: 'Main',
            ...state,
          };
          const results = msg.d.requests.map((r) => {
            if (failRequests.includes(r.requestType)) {
              return {
                requestType: r.requestType,
                requestId: r.requestId,
                requestStatus: { result: false, code: 207, comment: 'Not ready' },
              };
            }
            switch (r.requestType) {
              case 'GetVersion':
                return okResult('GetVersion', {
                  obsVersion: '31.0.2',
                  obsWebSocketVersion: '5.5.4',
                  rpcVersion: 1,
                  platform: 'macos',
                  platformDescription: 'macOS 15.1',
                });
              case 'GetStreamStatus':
                return okResult('GetStreamStatus', {
                  outputTimecode: '00:10:00.000',
                  outputDuration: 600000,
                  outputCongestion: 0,
                  outputBytes: 123456789,
                  ...s.stream,
                });
              case 'GetRecordStatus':
                return okResult('GetRecordStatus', {
                  outputTimecode: '00:05:00.000',
                  outputDuration: 300000,
                  outputBytes: 987654,
                  ...s.record,
                });
              case 'GetStats':
                return okResult('GetStats', s.stats);
              case 'GetCurrentProgramScene':
                return okResult('GetCurrentProgramScene', { sceneName: s.scene, sceneUuid: 'u' });
              default:
                return { requestType: r.requestType, requestStatus: { result: false, code: 204 } };
            }
          });
          ws.send(JSON.stringify({ op: 9, d: { requestId: msg.d.requestId, results } }));
        }
      });
    });
    wss.on('listening', () => {
      resolve({
        port: wss.address().port,
        log,
        closes,
        state,
        close: () =>
          new Promise((r) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => r());
          }),
      });
    });
  });
}

function freeTcpPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (pred, ms = 1000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

test('obs exposes its identity and read-only defaults', () => {
  const obs = loadObs();
  assert.equal(obs.ID, 'obs-studio');
  const byKey = Object.fromEntries(obs.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 4455);
  assert.equal(byKey.Port.Required, true);
  assert.equal(byKey.Password.Sensitive, true);
  assert.equal(byKey.CheckStreaming.Default, false);
  assert.equal(byKey.CheckRecording.Default, false);
  assert.equal(byKey.CheckDroppedFrames.Default, false);
  assert.equal(byKey.MaxDroppedPercent.Default, 1);
  assert.deepEqual(byKey.MaxDroppedPercent.VisibleWhen, {
    Key: 'CheckDroppedFrames',
    Equals: true,
  });
  assert.equal(byKey.Timeout.Advanced, true);
  assert.ok(!obs.Actions);
});

test('obs happy path without auth reads versions, outputs, stats and scene', async () => {
  const obs = loadObs();
  let identify = null;
  const srv = await startObs({ onIdentify: (d) => (identify = d) });
  try {
    const r = await obs.Run({ Address: '127.0.0.1', Settings: { Port: srv.port, Timeout: 2000 } });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.ObsVersion, '31.0.2');
    assert.equal(r.WebSocketVersion, '5.5.4');
    assert.equal(r.Platform, 'macos');
    assert.equal(r.StreamActive, false);
    assert.equal(r.RecordActive, false);
    assert.equal(r.CpuUsage, 3.2);
    assert.equal(r.ActiveFps, 60);
    assert.equal(r.ProgramScene, 'Main');
    assert.equal(r.AuthRequired, false);
    // Identify asked for no events and carried no auth string.
    assert.deepEqual(identify, { rpcVersion: 1, eventSubscriptions: 0 });
    // Exactly one batch of the five read-only requests.
    const batches = srv.log.filter((m) => m.op === 8);
    assert.equal(batches.length, 1);
    assert.deepEqual(
      batches[0].d.requests.map((q) => q.requestType),
      ['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetStats', 'GetCurrentProgramScene']
    );
    await waitFor(() => srv.closes.length > 0);
    assert.deepEqual(srv.closes, [1000], 'closed cleanly');
  } finally {
    await srv.close();
  }
});

test('obs authenticates with the SHA-256 challenge string', async () => {
  const obs = loadObs();
  const srv = await startObs({ password: 'supersecretpassword' });
  try {
    const r = await obs.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 2000, Password: 'supersecretpassword' },
    });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.AuthRequired, true);
  } finally {
    await srv.close();
  }
});

test('obs reports a rejected password (close 4009) as degraded, not offline', async () => {
  const obs = loadObs();
  const srv = await startObs({ password: 'right' });
  try {
    const r = await obs.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 2000, Password: 'wrong' },
    });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Password rejected by OBS');
    assert.equal(r.AuthFailed, true);
    assert.equal(r.ObsVersion, '31.0.2');
  } finally {
    await srv.close();
  }
});

test('obs says a password is needed when none is set', async () => {
  const obs = loadObs();
  const srv = await startObs({ password: 'right' });
  try {
    const r = await obs.Run({ Address: '127.0.0.1', Settings: { Port: srv.port, Timeout: 2000 } });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /requires a password/);
    assert.ok(!srv.log.some((m) => m.op === 1), 'no doomed Identify was sent');
  } finally {
    await srv.close();
  }
});

test('obs streaming and recording checks name each problem', async () => {
  const obs = loadObs();
  const srv = await startObs({
    state: {
      stream: {
        outputActive: true,
        outputReconnecting: true,
        outputSkippedFrames: 0,
        outputTotalFrames: 10,
      },
      record: { outputActive: true, outputPaused: true },
    },
  });
  try {
    const r = await obs.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 2000, CheckStreaming: true, CheckRecording: true },
    });
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Stream reconnecting; Recording paused');
    srv.state.stream = { outputActive: false, outputReconnecting: false };
    srv.state.record = { outputActive: false, outputPaused: false };
    const off = await obs.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 2000, CheckStreaming: true, CheckRecording: true },
    });
    assert.equal(off.DegradedReason, 'Not streaming; Not recording');
    srv.state.stream = { outputActive: true, outputReconnecting: false };
    srv.state.record = { outputActive: true, outputPaused: false };
    const ok = await obs.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 2000, CheckStreaming: true, CheckRecording: true },
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
  } finally {
    await srv.close();
  }
});

const dropStats = (renderSkipped, renderTotal, outSkipped, outTotal) => ({
  cpuUsage: 1,
  activeFps: 60,
  renderSkippedFrames: renderSkipped,
  renderTotalFrames: renderTotal,
  outputSkippedFrames: outSkipped,
  outputTotalFrames: outTotal,
});

// A controllable clock for the dropped-frame window. Restored after each test.
function fakeClock(obs, start = 1_000_000) {
  const clock = { now: start };
  obs._internal.SetClock(() => clock.now);
  return clock;
}

test('obs judges dropped frames over the delta since the baseline', async () => {
  const obs = loadObs(); // one module instance = one memory of baselines
  const clock = fakeClock(obs);
  const srv = await startObs({
    state: {
      stream: { outputActive: true, outputSkippedFrames: 500, outputTotalFrames: 10000 },
      stats: dropStats(900, 10000, 0, 10000),
    },
  });
  const settings = {
    Port: srv.port,
    Timeout: 2000,
    CheckDroppedFrames: true,
    MaxDroppedPercent: 1,
  };
  const check = { CheckID: 7, Address: '127.0.0.1', Settings: settings };
  try {
    // First probe: huge lifetime totals, but no baseline -> no verdict.
    const first = await obs.Run(check);
    assert.ok(!first.Degraded, first.DegradedReason);
    assert.deepEqual(first.DropDeltas, { Network: null, Encoding: null, Rendering: null });

    // 30 s later: 30 of 1000 network frames dropped (3%), 5 of 1000 rendered.
    clock.now += 30000;
    srv.state.stream = { outputActive: true, outputSkippedFrames: 530, outputTotalFrames: 11000 };
    srv.state.stats = dropStats(905, 11000, 0, 11000);
    const second = await obs.Run(check);
    assert.equal(second.Degraded, true);
    assert.equal(second.DegradedReason, 'Dropped frames (network) 3% (limit 1%)');
    assert.equal(second.DropDeltas.Rendering.Skipped, 5);
    assert.equal(second.DropDeltas.Rendering.WindowMs, 30000);

    // OBS restarted: counters went backwards -> no verdict, not a false alarm.
    clock.now += 30000;
    srv.state.stream = { outputActive: true, outputSkippedFrames: 0, outputTotalFrames: 100 };
    srv.state.stats = dropStats(0, 100, 0, 100);
    const third = await obs.Run(check);
    assert.ok(!third.Degraded, third.DegradedReason);

    // Encoding lag over the limit is named separately.
    clock.now += 30000;
    srv.state.stream = { outputActive: true, outputSkippedFrames: 0, outputTotalFrames: 1100 };
    srv.state.stats = dropStats(0, 1100, 200, 1100);
    const fourth = await obs.Run(check);
    assert.equal(fourth.DegradedReason, 'Encoding lag 20% (limit 1%)');
  } finally {
    obs._internal.SetClock(null);
    await srv.close();
  }
});

test('obs gives no drop verdict on a short window and keeps the old baseline', async () => {
  const obs = loadObs();
  const clock = fakeClock(obs);
  const srv = await startObs({ state: { stats: dropStats(0, 1000, 0, 1000) } });
  const check = {
    CheckID: 3,
    Address: '127.0.0.1',
    Settings: { Port: srv.port, Timeout: 2000, CheckDroppedFrames: true, MaxDroppedPercent: 1 },
  };
  try {
    await obs.Run(check); // baseline at t0: 0 / 1000

    // A run-now 50 ms later: 1 of 2 new frames missed. Must NOT read as 50%.
    clock.now += 50;
    srv.state.stats = dropStats(1, 1002, 0, 1002);
    const quick = await obs.Run(check);
    assert.ok(!quick.Degraded, quick.DegradedReason);
    assert.equal(quick.DropDeltas.Rendering, null);

    // Long enough in time but too few frames (OBS idle) -> still no verdict.
    clock.now += 10000;
    srv.state.stats = dropStats(1, 1010, 0, 1010);
    const idle = await obs.Run(check);
    assert.equal(idle.DropDeltas.Rendering, null);

    // The baseline was kept from t0, so the next qualifying window measures
    // from there: 1 missed of 2000 new frames = 0.05%, under the limit.
    clock.now += 30000;
    srv.state.stats = dropStats(1, 3000, 0, 3000);
    const real = await obs.Run(check);
    assert.ok(!real.Degraded, real.DegradedReason);
    assert.deepEqual(
      { Skipped: real.DropDeltas.Rendering.Skipped, Total: real.DropDeltas.Rendering.Total },
      { Skipped: 1, Total: 2000 }
    );
  } finally {
    obs._internal.SetClock(null);
    await srv.close();
  }
});

test('obs keeps a separate drop baseline per check on the same OBS', async () => {
  const obs = loadObs();
  const clock = fakeClock(obs);
  const srv = await startObs({ state: { stats: dropStats(0, 1000, 0, 1000) } });
  const settingsA = {
    Port: srv.port,
    Timeout: 2000,
    CheckDroppedFrames: true,
    MaxDroppedPercent: 0.5,
  };
  const settingsB = { ...settingsA, CheckStreaming: false, MaxDroppedPercent: 5 };
  const a = { CheckID: 11, Address: '127.0.0.1', Settings: settingsA };
  const b = { CheckID: 12, Address: '127.0.0.1', Settings: settingsB };
  try {
    // Both checks fire together on the tick, as target.ts RunChecks does.
    await Promise.all([obs.Run(a), obs.Run(b)]);
    clock.now += 30000;
    srv.state.stats = dropStats(10, 2000, 0, 2000);
    // Check A runs, then B a moment later (e.g. a run-now): B must measure
    // against its OWN 30 s-old baseline, not A's fresh sample.
    const ra = await obs.Run(a);
    clock.now += 20;
    srv.state.stats = dropStats(11, 2002, 0, 2002);
    const rb = await obs.Run(b);
    assert.equal(ra.DropDeltas.Rendering.Total, 1000);
    assert.equal(rb.DropDeltas.Rendering.Total, 1002);
    assert.equal(ra.DegradedReason, 'Rendering lag 1% (limit 0.5%)');
    assert.ok(!rb.Degraded, rb.DegradedReason);
    assert.ok(obs._internal.Baselines.has('check:11'));
    assert.ok(obs._internal.Baselines.has('check:12'));
    // The registry cache key separates the two checks too.
    assert.notEqual(obs.GetRunCacheKeyExtra(a), obs.GetRunCacheKeyExtra(b));
  } finally {
    obs._internal.SetClock(null);
    await srv.close();
  }
});

test('obs falls back to address:port for a probe with no check id', () => {
  const { BaselineKey } = loadObs()._internal;
  const cfg = { Address: 'obs.local', Port: 4455, TimeoutMs: 1000, Password: '' };
  assert.equal(BaselineKey({ CheckID: 5 }, cfg), 'check:5');
  assert.equal(BaselineKey({ CheckID: 0 }, cfg), 'addr:obs.local:4455');
  assert.equal(BaselineKey({}, cfg), 'addr:obs.local:4455');
  assert.equal(BaselineKey({ CheckID: '5' }, cfg), 'addr:obs.local:4455');
});

test('obs keeps the other readings when one request fails', async () => {
  const obs = loadObs();
  const srv = await startObs({ failRequests: ['GetStreamStatus'] });
  try {
    const r = await obs.Run({
      Address: '127.0.0.1',
      Settings: { Port: srv.port, Timeout: 2000, CheckStreaming: true },
    });
    assert.equal(r.Success, true);
    assert.equal(r.DegradedReason, 'Failed to read the stream status');
    assert.equal(r.StreamActive, null);
    assert.equal(r.ProgramScene, 'Main');
    assert.equal(r.RequestErrors.GetStreamStatus, 'Not ready');
  } finally {
    await srv.close();
  }
});

test('obs degrades when the WebSocket peer is not obs-websocket 5', async () => {
  const obs = loadObs();
  const srv = await startObs({ hello: { hello: 'world' } });
  try {
    const r = await obs.Run({ Address: '127.0.0.1', Settings: { Port: srv.port, Timeout: 2000 } });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /does not look like obs-websocket 5/);
  } finally {
    await srv.close();
  }
});

test('obs degrades when a WebSocket never says Hello (obs-websocket 4)', async () => {
  const obs = loadObs();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.on('listening', r));
  try {
    const r = await obs.Run({
      Address: '127.0.0.1',
      Settings: { Port: wss.address().port, Timeout: 600 },
    });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /obs-websocket 4/);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});

test('obs degrades when OBS identifies but never answers the batch', async () => {
  const obs = loadObs();
  const srv = await startObs({ silentAfterIdentify: true });
  try {
    const r = await obs.Run({ Address: '127.0.0.1', Settings: { Port: srv.port, Timeout: 600 } });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /did not answer the status requests/);
  } finally {
    await srv.close();
  }
});

test('obs is offline when nothing listens', async () => {
  const obs = loadObs();
  const port = await freeTcpPort();
  const r = await obs.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1500 } });
  assert.equal(r.Success, false);
  assert.match(r.Error, /Failed to connect/);
});

test('obs uses an injected WebSocket constructor', async () => {
  const obs = loadObs();
  obs._internal.SetWebSocketImpl(
    class {
      constructor(url) {
        throw new Error(`refused ${url}`);
      }
    }
  );
  try {
    const r = await obs.Run({ Address: '::1', Settings: { Port: 4455, Timeout: 500 } });
    assert.equal(r.Success, false);
    assert.equal(r.Error, 'refused ws://[::1]:4455');
  } finally {
    obs._internal.SetWebSocketImpl(null);
  }
});

test('obs auth string matches the protocol definition', () => {
  const { BuildAuthString } = loadObs()._internal;
  const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
  const challenge = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';
  assert.equal(
    BuildAuthString('supersecretpassword', salt, challenge),
    authString('supersecretpassword', salt, challenge)
  );
});

test('obs AdvanceDropBaseline edge cases', () => {
  const { AdvanceDropBaseline, MIN_DROP_WINDOW_MS, MIN_DROP_FRAMES } = loadObs()._internal;
  const c = (o) => ({
    StreamActive: true,
    StreamSkipped: 0,
    StreamTotal: 0,
    EncodeSkipped: 0,
    EncodeTotal: 0,
    RenderSkipped: 0,
    RenderTotal: 0,
    ...o,
  });
  const t0 = 1000;
  const later = t0 + MIN_DROP_WINDOW_MS;
  const base = AdvanceDropBaseline(null, c({ RenderTotal: 100, StreamTotal: 10 }), t0).Next;
  // No new frames -> no verdict, baseline kept.
  const same = AdvanceDropBaseline(base, c({ RenderTotal: 100, StreamTotal: 10 }), later);
  assert.equal(same.Deltas.Rendering, null);
  assert.equal(same.Next.Rendering, base.Rendering);
  // Stream stopped -> no network verdict and the network baseline is dropped.
  const stopped = AdvanceDropBaseline(base, c({ StreamActive: false, StreamTotal: 500 }), later);
  assert.equal(stopped.Deltas.Network, null);
  assert.equal(stopped.Next.Network, null);
  // Missing counters -> no verdict.
  assert.equal(AdvanceDropBaseline(base, c({ RenderTotal: null }), later).Deltas.Rendering, null);
  // Exactly the minimum window and frame count qualifies.
  const ok = AdvanceDropBaseline(
    base,
    c({ RenderTotal: 100 + MIN_DROP_FRAMES, RenderSkipped: 3, StreamTotal: 10 }),
    later
  );
  assert.deepEqual(ok.Deltas.Rendering, {
    Skipped: 3,
    Total: MIN_DROP_FRAMES,
    Percent: (3 / MIN_DROP_FRAMES) * 100,
    WindowMs: MIN_DROP_WINDOW_MS,
  });
  assert.equal(ok.Next.Rendering.At, later);
  // One millisecond short of the window does not.
  assert.equal(
    AdvanceDropBaseline(
      base,
      c({ RenderTotal: 100 + MIN_DROP_FRAMES, RenderSkipped: 3 }),
      later - 1
    ).Deltas.Rendering,
    null
  );
});

test('obs Debug escapes device-supplied strings', () => {
  const obs = loadObs();
  const html = obs.Debug(
    {
      Success: true,
      LatencyMs: 5,
      ObsVersion: '<script>x</script>',
      WebSocketVersion: '5.5.4',
      PlatformDescription: '<img src=x onerror=1>',
      ProgramScene: '<script>alert(1)</script>',
      StreamActive: true,
      StreamReconnecting: false,
      StreamTimecode: '<b>',
      StreamBytes: 2048,
      RecordActive: false,
      CpuUsage: 1.23,
      ActiveFps: 60,
      DropDeltas: {
        Network: null,
        Encoding: null,
        Rendering: { Skipped: 1, Total: 100, Percent: 1, WindowMs: 30000 },
      },
    },
    { Address: '127.0.0.1', Settings: {} }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('2.0 KB'));
});

test('obs Debug renders the offline hint', () => {
  const obs = loadObs();
  const html = obs.Debug({ Success: false, Error: 'nope' }, { Address: 'obs.local', Settings: {} });
  assert.ok(html.includes('obs.local:4455'));
  assert.ok(html.includes('WebSocket Server Settings'));
});
