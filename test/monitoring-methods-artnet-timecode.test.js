const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loggerStub() {
  const noop = () => {};
  const logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    child: () => logger,
  };
  return { CreateLogger: () => logger };
}

function loadTimecode() {
  return loadWithMocks(methodPath('artnet-timecode.js'), { '../Logger': loggerStub() });
}

// A module whose receiver never binds a socket: packets are fed through the same
// Ingest() the socket handler uses.
function loadOffline() {
  const mod = loadTimecode();
  const rx = mod._internal.ArtnetReceiver;
  rx.EnsureStarted = () => {};
  return { mod, rx };
}

// Build an ArtTimeCode packet (Art-Net 4: 19 bytes).
function buildTimecode(opts = {}) {
  const {
    hours = 1,
    minutes = 2,
    seconds = 3,
    frames = 4,
    type = 1,
    stream = 0,
    opcode = 0x9700,
    length = 19,
  } = opts;
  const buf = Buffer.alloc(19);
  Buffer.from([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]).copy(buf, 0);
  buf.writeUInt16LE(opcode, 8);
  buf.writeUInt16BE(14, 10);
  buf[13] = stream;
  buf[14] = frames;
  buf[15] = seconds;
  buf[16] = minutes;
  buf[17] = hours;
  buf[18] = type;
  return buf.subarray(0, length);
}

// --- Packet parsing ----------------------------------------------------------

test('ParseArtTimeCode reads the time, type and stream', () => {
  const { ParseArtTimeCode } = loadTimecode()._internal;
  const tc = ParseArtTimeCode(
    buildTimecode({ hours: 23, minutes: 59, seconds: 58, frames: 24, type: 1, stream: 3 }),
    '::ffff:10.0.0.7'
  );
  assert.deepEqual(tc, {
    Address: '10.0.0.7',
    StreamId: 3,
    Hours: 23,
    Minutes: 59,
    Seconds: 58,
    Frames: 24,
    Type: 1,
  });
});

test('ParseArtTimeCode rejects other opcodes, runts, junk and out-of-range fields', () => {
  const { ParseArtTimeCode } = loadTimecode()._internal;
  assert.equal(ParseArtTimeCode(buildTimecode({ opcode: 0x5000 }), '1.2.3.4'), null);
  assert.equal(ParseArtTimeCode(buildTimecode({ length: 18 }), '1.2.3.4'), null);
  assert.equal(ParseArtTimeCode(Buffer.from('definitely not art-net'), '1.2.3.4'), null);
  assert.equal(ParseArtTimeCode(buildTimecode({ hours: 24 }), '1.2.3.4'), null);
  assert.equal(ParseArtTimeCode(buildTimecode({ frames: 30 }), '1.2.3.4'), null);
  assert.equal(ParseArtTimeCode(buildTimecode({ seconds: 60 }), '1.2.3.4'), null);
});

test('FormatTimecode uses ; before the frames only for drop-frame', () => {
  const { FormatTimecode } = loadTimecode()._internal;
  const t = { Hours: 1, Minutes: 2, Seconds: 3, Frames: 4 };
  assert.equal(FormatTimecode({ ...t, Type: 1 }), '01:02:03:04');
  assert.equal(FormatTimecode({ ...t, Type: 2 }), '01:02:03;04');
  assert.equal(FormatTimecode({ ...t, Type: 9 }), '01:02:03:04');
});

// --- Receiver tracking ---------------------------------------------------------

test('the receiver tracks last packet and last change per source and stream', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const { rx } = loadOffline();
  rx.ObserveTimecode();

  rx.Ingest(buildTimecode({ frames: 1 }), '10.0.0.7');
  t.mock.timers.tick(40);
  rx.Ingest(buildTimecode({ frames: 2 }), '10.0.0.7');
  t.mock.timers.tick(40);
  rx.Ingest(buildTimecode({ frames: 2 }), '10.0.0.7'); // repeat: no advance
  rx.Ingest(buildTimecode({ frames: 9, stream: 1 }), '10.0.0.7');

  const sources = rx.TimecodeSnapshot().Sources;
  const master = sources.find((s) => s.StreamId === 0);
  assert.equal(master.FirstSeenAt, 10000);
  assert.equal(master.LastChangedAt, 10040);
  assert.equal(master.LastSeenAt, 10080);
  assert.equal(master.PacketCount, 3);
  assert.equal(sources.length, 2, 'stream 1 tracked separately');
});

test('the receiver ignores timecode while no check is watching', () => {
  const { rx } = loadOffline();
  rx.Ingest(buildTimecode(), '10.0.0.7');
  assert.equal(rx.TimecodeSnapshot().Sources.length, 0);
});

// --- Evaluation (pure) -------------------------------------------------------

function source(overrides = {}) {
  return {
    Address: '10.0.0.7',
    StreamId: 0,
    Hours: 1,
    Minutes: 0,
    Seconds: 0,
    Frames: 12,
    Type: 1,
    LastSeenAt: 9900,
    LastChangedAt: 9900,
    FirstSeenAt: 5000,
    PacketCount: 100,
    ...overrides,
  };
}

function params(mod, { sources = [], settings = {}, ready = true, error = null } = {}) {
  return {
    Snapshot: { Ready: ready, Error: error, Sources: sources },
    Address: '10.0.0.7',
    Options: mod._internal.ParseOptions({ Settings: settings }),
    Now: 10000,
  };
}

test('EvaluateTimecode is online while timecode arrives and advances', () => {
  const mod = loadTimecode();
  const res = mod._internal.EvaluateTimecode(params(mod, { sources: [source()] }));
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, undefined);
  assert.equal(res.Timecode, '01:00:00:12');
  assert.equal(res.TimecodeType, 'EBU 25 fps');
  assert.equal(res.AgeMs, 100);
  assert.equal(res.SinceAdvanceMs, 100);
  assert.equal(res.LatencyMs, 100);
});

test('EvaluateTimecode is offline after the grace period and names other sources', () => {
  const mod = loadTimecode();
  const res = mod._internal.EvaluateTimecode(
    params(mod, {
      sources: [source({ LastSeenAt: 6000 }), source({ Address: '10.0.0.9' })],
    })
  );
  assert.equal(res.Success, false);
  assert.equal(res.Error, 'No Art-Net timecode from 10.0.0.7 (heard from 10.0.0.9)');
  assert.equal(res.OtherSources.length, 1);
  assert.equal(res.OtherSources[0].Address, '10.0.0.9');
});

test('EvaluateTimecode degrades when packets arrive but the time has stalled', () => {
  const mod = loadTimecode();
  const stalled = source({ LastChangedAt: 4000 });
  const res = mod._internal.EvaluateTimecode(params(mod, { sources: [stalled] }));
  assert.equal(res.Success, true);
  assert.equal(res.Degraded, true);
  assert.equal(res.DegradedReason, 'Timecode stalled at 01:00:00:12 for 6.0 s');
  // Custom stall window, and the toggle off.
  const lenient = params(mod, { sources: [stalled], settings: { StallMs: 10000 } });
  assert.equal(mod._internal.EvaluateTimecode(lenient).Degraded, undefined);
  const off = params(mod, { sources: [stalled], settings: { CheckAdvancing: false } });
  assert.equal(mod._internal.EvaluateTimecode(off).Degraded, undefined);
});

test('EvaluateTimecode checks the frame rate only when enabled', () => {
  const mod = loadTimecode();
  const smpte = source({ Type: 3 });
  assert.equal(
    mod._internal.EvaluateTimecode(params(mod, { sources: [smpte] })).Degraded,
    undefined
  );
  const res = mod._internal.EvaluateTimecode(
    params(mod, { sources: [smpte], settings: { CheckFrameRate: true, ExpectedFrameRate: '1' } })
  );
  assert.equal(res.Degraded, true);
  assert.equal(res.DegradedReason, 'Frame rate SMPTE 30 fps (expected EBU 25 fps)');
  const df = mod._internal.EvaluateTimecode(
    params(mod, {
      sources: [source({ Type: 2 })],
      settings: { CheckFrameRate: true, ExpectedFrameRate: '2' },
    })
  );
  assert.equal(df.Degraded, undefined);
  assert.equal(df.Timecode, '01:00:00;12');
});

test('EvaluateTimecode prefers the master stream from the source', () => {
  const mod = loadTimecode();
  const res = mod._internal.EvaluateTimecode(
    params(mod, {
      sources: [source({ StreamId: 2, Frames: 1, LastSeenAt: 9990 }), source({ StreamId: 0 })],
    })
  );
  assert.equal(res.StreamId, 0);
  assert.equal(res.OtherSources.length, 1);
  assert.equal(res.OtherSources[0].StreamId, 2);
});

test('EvaluateTimecode reports listener starting and listener errors as offline', () => {
  const mod = loadTimecode();
  const starting = mod._internal.EvaluateTimecode(params(mod, { ready: false }));
  assert.equal(starting.Success, false);
  assert.match(starting.Error, /starting/);
  const failed = mod._internal.EvaluateTimecode(params(mod, { error: 'EADDRINUSE' }));
  assert.equal(failed.Success, false);
  assert.match(failed.Error, /Art-Net listener error: EADDRINUSE/);
});

// --- Settings ----------------------------------------------------------------

test('settings defaults: advancing on, frame rate off, 3 s grace', () => {
  const mod = loadTimecode();
  const byKey = Object.fromEntries(mod.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.CheckAdvancing.Default, true);
  assert.equal(byKey.StallMs.Default, 2000);
  assert.equal(byKey.CheckFrameRate.Default, false);
  assert.deepEqual(
    byKey.ExpectedFrameRate.Options.map((o) => o.value),
    ['0', '1', '2', '3']
  );
  assert.equal(byKey.Timeout.Default, 3000);
  assert.equal(byKey.Timeout.Advanced, true);
  assert.equal(mod.SupportsLatencyThreshold, false);
  assert.equal(mod.ID, 'artnet-timecode');
  assert.deepEqual(mod._internal.ParseOptions({ Settings: {} }), {
    GracePeriodMs: 3000,
    CheckAdvancing: true,
    StallMs: 2000,
    CheckFrameRate: false,
    ExpectedType: 1,
  });
  assert.equal(
    mod._internal.ParseOptions({ Settings: { ExpectedFrameRate: '7' } }).ExpectedType,
    1
  );
});

// --- Run / Debug ----------------------------------------------------------------

test('Run reads the receiver cache for the configured source', () => {
  const { mod, rx } = loadOffline();
  assert.match(mod.Run({ Address: '', Settings: {} }).Error, /No source IP/);
  // First run registers interest; nothing heard yet.
  assert.equal(mod.Run({ Address: '10.0.0.7', Settings: {} }).Success, false);
  rx.Ingest(buildTimecode({ frames: 5 }), '10.0.0.7');
  rx.Ingest(buildTimecode({ frames: 5 }), '10.0.0.8');
  const res = mod.Run({ Address: '10.0.0.7', Settings: {} });
  assert.equal(res.Success, true);
  assert.equal(res.Timecode, '01:02:03:05');
  assert.equal(res.OtherSources[0].Address, '10.0.0.8');
});

test('Debug escapes untrusted strings and lists other sources', () => {
  const mod = loadTimecode();
  const res = mod._internal.EvaluateTimecode(
    params(mod, { sources: [source(), source({ Address: '<script>x</script>' })] })
  );
  const html = mod.Debug(res, { Address: '10.0.0.7' });
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /01:00:00:12/);
  assert.match(html, /Other timecode sources \(1\)/);

  const offline = mod.Debug(
    { Success: false, Error: 'No Art-Net timecode from <b>' },
    { Address: '<img>' }
  );
  assert.ok(!offline.includes('<b>') && !offline.includes('<img>'));
  assert.match(offline, /Not receiving/);
});

// --- Real socket (best-effort; skips if udp/6454 is unavailable) ---------------

test('the shared receiver ingests a real ArtTimeCode datagram', async (t) => {
  const mod = loadTimecode();
  const rx = mod._internal.ArtnetReceiver;
  mod.Run({ Address: '127.0.0.1', Settings: {} }); // registers interest, starts the socket
  const ready = await rx.WhenReady(1000);
  if (!ready) {
    rx.Stop();
    t.skip(`Art-Net socket not ready (${rx.ListenerError() || 'binding'}); cannot bind udp/6454`);
    return;
  }

  const client = dgram.createSocket('udp4');
  try {
    for (const frames of [1, 2]) {
      await new Promise((resolve, reject) =>
        client.send(buildTimecode({ frames }), 6454, '127.0.0.1', (err) =>
          err ? reject(err) : resolve()
        )
      );
    }
    let res;
    for (let i = 0; i < 20; i++) {
      res = mod.Run({ Address: '127.0.0.1', Settings: {} });
      if (res.Success && res.Timecode === '01:02:03:02') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!res.Success) {
      t.skip('loopback delivery not available in this environment');
      return;
    }
    assert.equal(res.Timecode, '01:02:03:02');
    assert.equal(res.PacketCount, 2);
  } finally {
    client.close();
    rx.Stop();
  }
});

// Interest is refreshed only by a check's own Run(), so a check on the longest
// allowed interval must still find its universe / timecode cache alive when it
// next runs. A reap window shorter than the interval read Offline on every run.
test('universe and timecode checks survive the longest monitoring interval', () => {
  const { MAX_MONITORING_INTERVAL_MS } = require(
    path.join(__dirname, '..', 'dist', 'Modules', 'Config', 'constants.js')
  );
  const { mod, rx } = loadOffline();
  const universe = require(methodPath('artnet-universe.js'));
  rx.State = 'ready';

  const RealNow = Date.now;
  let Now = RealNow();
  Date.now = () => Now;
  try {
    const Dmx = Buffer.alloc(18);
    Buffer.from('Art-Net\0', 'latin1').copy(Dmx, 0);
    Dmx.writeUInt16LE(0x5000, 8);
    Dmx.writeUInt16BE(14, 10);
    Dmx[14] = 1; // universe 1

    const UniverseTarget = { Address: '10.0.0.5', Settings: { Universe: 1 } };
    const TimecodeTarget = { Address: '10.0.0.6', Settings: { CheckAdvancing: false } };
    let Frame = 0;
    for (let Tick = 0; Tick < 3; Tick += 1) {
      const U = universe.Run(UniverseTarget);
      const T = mod.Run(TimecodeTarget);
      if (Tick > 0) {
        assert.equal(U.Success, true, `universe tick ${Tick}: ${U.Error}`);
        assert.equal(T.Success, true, `timecode tick ${Tick}: ${T.Error}`);
      }
      // Both senders keep transmitting; the receiver sweeps every 30 s.
      const End = Now + MAX_MONITORING_INTERVAL_MS;
      let NextSweep = Now + 30000;
      while (Now < End) {
        Now += 500;
        rx.Ingest(Dmx, '10.0.0.5');
        rx.Ingest(
          buildTimecode({ frames: Frame % 25, seconds: Math.floor(Frame / 25) % 60 }),
          '10.0.0.6'
        );
        Frame += 1;
        if (Now >= NextSweep) {
          rx.Sweep();
          NextSweep += 30000;
        }
      }
    }
  } finally {
    Date.now = RealNow;
    rx.Stop();
  }
});
