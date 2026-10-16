const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('hyperdeck.js'), {});
}

const BANNER =
  '500 connection info:\r\nprotocol version: 1.11\r\nmodel: HyperDeck Studio HD Plus\r\n\r\n';

function block(header, fields) {
  return (
    `${header}\r\n` +
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('') +
    '\r\n'
  );
}

function slotBlock(slot) {
  return block('202 slot info:', {
    'slot id': slot.id,
    'slot name': slot.name || `sd${slot.id}`,
    status: slot.status,
    'volume name': slot.volume || '',
    'recording time': slot.time ?? 0,
    'video format': slot.format || '1080p25',
    blocked: 'false',
  });
}

// A fake HyperDeck. Speaks first with the banner, then answers device info,
// transport info and the multi-line `slot info:` / `slot id: N` form. Every
// command line it receives is recorded in `received` so tests can prove the
// probe only ever queries.
function startHyperDeck(opts = {}) {
  const {
    banner = BANNER,
    model = 'HyperDeck Studio HD Plus',
    slots = [
      { id: 1, status: 'mounted', volume: 'Show A', time: 3600 },
      { id: 2, status: 'mounted', volume: 'Show B', time: 7200 },
    ],
    transport = { status: 'record', 'slot id': 1, 'clip id': 4, 'display timecode': '01:02:03:04' },
    slotCount = slots.length,
    asyncNoise = false,
    fragment = false,
    silentAfter = null, // stop answering once this command is seen
    slotErrors = {}, // slot id -> raw error line
  } = opts;
  const received = [];
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const send = (text) => {
        if (!fragment) {
          socket.write(text);
          return;
        }
        // Dribble the reply out in 3-byte chunks to exercise reassembly.
        let i = 0;
        const step = () => {
          if (i >= text.length || socket.destroyed) return;
          socket.write(text.slice(i, i + 3));
          i += 3;
          setImmediate(step);
        };
        step();
      };
      if (banner != null) send(banner);

      let buf = '';
      let pendingSlotQuery = false;
      let silent = false;
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8').replace(/\r/g, '');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          received.push(line);
          if (silent) continue;
          if (silentAfter && line === silentAfter) {
            silent = true;
            continue;
          }
          const noise = asyncNoise
            ? '508 transport info:\r\nstatus: play\r\n\r\n502 slot info:\r\nslot id: 9\r\n\r\n'
            : '';
          if (line === 'device info') {
            send(
              noise +
                block('204 device info:', {
                  'protocol version': '1.11',
                  model,
                  'unique id': 'abc123',
                  'slot count': slotCount,
                  'software version': '8.4',
                  name: 'Rec Left',
                })
            );
          } else if (line === 'transport info') {
            send(noise + block('208 transport info:', { speed: 0, ...transport }));
          } else if (line === 'slot info:') {
            pendingSlotQuery = true;
          } else if (pendingSlotQuery && line.startsWith('slot id:')) {
            const id = Number(line.split(':')[1]);
            pendingSlotQuery = false;
            if (slotErrors[id]) {
              send(noise + `${slotErrors[id]}\r\n`);
            } else {
              const slot = slots.find((s) => s.id === id);
              send(noise + (slot ? slotBlock(slot) : '102 invalid value\r\n'));
            }
          } else if (line === 'quit') {
            socket.end();
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

async function runAgainst(serverOpts, settings = {}) {
  const hd = load();
  const server = await startHyperDeck(serverOpts);
  try {
    const result = await hd.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, ...settings },
    });
    return { hd, result, received: server.received };
  } finally {
    await server.close();
  }
}

test('hyperdeck happy path reads model, transport and every slot, sending queries only', async () => {
  const { result, received } = await runAgainst({});
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.Model, 'HyperDeck Studio HD Plus');
  assert.equal(result.ProtocolVersion, '1.11');
  assert.equal(result.SoftwareVersion, '8.4');
  assert.equal(result.DeviceName, 'Rec Left');
  assert.equal(result.TransportStatus, 'record');
  assert.equal(result.ActiveSlot, 1);
  assert.equal(result.ClipId, 4);
  assert.equal(result.Timecode, '01:02:03:04');
  assert.equal(result.Slots.length, 2);
  assert.deepEqual(
    result.Slots.map((s) => [s.Id, s.Status, s.VolumeName, s.RecordingTimeSec]),
    [
      [1, 'mounted', 'Show A', 3600],
      [2, 'mounted', 'Show B', 7200],
    ]
  );
  assert.equal(typeof result.LatencyMs, 'number');
  // Read-only: only queries (and the multi-line slot info form) were sent.
  const allowed = new Set(['device info', 'transport info', 'slot info:', 'quit', '']);
  for (const line of received) {
    assert.ok(allowed.has(line) || /^slot id: \d+$/.test(line), `unexpected command: ${line}`);
  }
  assert.ok(received.includes('slot id: 1') && received.includes('slot id: 2'));
});

test('hyperdeck RequireMedia (default on) degrades with no media, an empty active slot or a slot error', async () => {
  const none = await runAgainst({
    slots: [
      { id: 1, status: 'empty' },
      { id: 2, status: 'empty' },
    ],
    transport: { status: 'stopped', 'slot id': 'none' },
  });
  assert.equal(none.result.Success, true);
  assert.equal(none.result.Degraded, true);
  assert.equal(none.result.DegradedReason, 'No media mounted');
  assert.equal(none.result.ActiveSlot, null);

  const activeEmpty = await runAgainst({
    slots: [
      { id: 1, status: 'empty' },
      { id: 2, status: 'mounted', time: 100 },
    ],
  });
  assert.equal(activeEmpty.result.DegradedReason, 'Active slot 1: no media');

  const error = await runAgainst({
    slots: [
      { id: 1, status: 'mounted', time: 100 },
      { id: 2, status: 'error' },
    ],
  });
  assert.equal(error.result.DegradedReason, 'Slot 2: media error');

  const off = await runAgainst(
    { slots: [{ id: 1, status: 'empty' }], transport: { status: 'stopped', 'slot id': 'none' } },
    { RequireMedia: false }
  );
  assert.ok(!off.result.Degraded);
});

test('hyperdeck CheckRecording degrades unless the transport is recording', async () => {
  const stopped = await runAgainst(
    { transport: { status: 'stopped', 'slot id': 1 } },
    { CheckRecording: true }
  );
  assert.equal(stopped.result.Degraded, true);
  assert.equal(stopped.result.DegradedReason, 'Not recording (transport stopped)');

  const recording = await runAgainst({}, { CheckRecording: true });
  assert.ok(!recording.result.Degraded);
});

test('hyperdeck CheckRecordTime counts all mounted slots by default and the active slot on request', async () => {
  const slots = [
    { id: 1, status: 'mounted', time: 600 }, // 10 min
    { id: 2, status: 'mounted', time: 1200 }, // 20 min
  ];
  const all = await runAgainst({ slots }, { CheckRecordTime: true, MinRecordMinutes: 15 });
  assert.ok(!all.result.Degraded, all.result.DegradedReason);
  assert.equal(all.result.RecordTimeLeftSec, 1800);

  const active = await runAgainst(
    { slots },
    { CheckRecordTime: true, MinRecordMinutes: 15, RecordTimeScope: 'active' }
  );
  assert.equal(active.result.Degraded, true);
  assert.equal(active.result.DegradedReason, 'Slot 1: 10 min recording time left (minimum 15)');

  const low = await runAgainst({ slots }, { CheckRecordTime: true, MinRecordMinutes: 45 });
  assert.equal(low.result.DegradedReason, 'Slots 1 + 2: 30 min recording time left (minimum 45)');
});

test('hyperdeck skips interleaved async 5xx messages and reassembles fragmented replies', async () => {
  const { result } = await runAgainst({ asyncNoise: true, fragment: true });
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.TransportStatus, 'record');
  assert.deepEqual(
    result.Slots.map((s) => s.Id),
    [1, 2]
  );
});

test('hyperdeck records a slot that answers with an error and reads 105 as empty', async () => {
  const { result } = await runAgainst({
    slots: [{ id: 1, status: 'mounted', time: 999 }],
    slotCount: 3,
    slotErrors: { 2: '105 no disk' },
  });
  assert.equal(result.Slots.length, 3);
  assert.equal(result.Slots[1].Status, 'empty');
  assert.equal(result.Slots[1].Error, null);
  assert.equal(result.Slots[2].Error, '102 invalid value');
  assert.ok(!result.Degraded, result.DegradedReason);
});

test('hyperdeck reports a 120 rejection as degraded, not offline', async () => {
  const { result } = await runAgainst({ banner: '120 connection failed\r\n' });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /too many clients/);
});

test('hyperdeck degrades when the responder is not a HyperDeck', async () => {
  const { result } = await runAgainst({ banner: 'SSH-2.0-OpenSSH_9.6\r\n' });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /does not look like a HyperDeck/);

  // Bytes with no newline at all: still reached, still not a HyperDeck.
  const noLine = await runAgainst({ banner: '\x00\x01\x02' }, { Timeout: 600 });
  assert.equal(noLine.result.Success, true);
  assert.match(noLine.result.DegradedReason, /does not look like a HyperDeck/);
});

test('hyperdeck is offline when the port is silent or refused', async () => {
  const silent = await runAgainst({ banner: null }, { Timeout: 600 });
  assert.equal(silent.result.Success, false);
  assert.match(silent.result.Error, /No reply from HyperDeck/);

  const hd = load();
  const tmp = await startHyperDeck();
  const port = tmp.port;
  await tmp.close();
  const refused = await hd.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(refused.Success, false);
  assert.equal(refused.Degraded, true);
});

test('hyperdeck reports which step the budget ran out in', async () => {
  const started = Date.now();
  const { result } = await runAgainst({ silentAfter: 'slot id: 2' }, { Timeout: 700 });
  assert.ok(Date.now() - started < 2500);
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /^Timed out reading slot 2 info/);
  assert.equal(result.Slots.length, 1);
});

test('hyperdeck rejects a missing address and a bad port without connecting', async () => {
  const hd = load();
  assert.equal((await hd.Run({ Settings: {} })).Error, 'No address configured');
  const bad = await hd.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.match(bad.Error, /Invalid port/);
});

test('hyperdeck Debug escapes device strings and renders a card per slot', async () => {
  const { hd, result } = await runAgainst({
    model: '<script>alert(1)</script>',
    slots: [
      { id: 1, status: 'mounted', volume: '<img src=x onerror=1>', time: 60 },
      { id: 2, status: 'empty' },
    ],
  });
  const html = hd.Debug(result, { Address: '127.0.0.1', Settings: { Port: 9993 } });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /Slot 1/);
  assert.match(html, /Slot 2/);
  assert.match(html, /Recording/);

  const offline = hd.Debug({ Success: false, Error: '<b>x</b>' }, { Address: 'h', Settings: {} });
  assert.ok(!offline.includes('<b>x</b>'));
  assert.match(offline, /Offline/);
});

test('hyperdeck settings defaults', () => {
  const hd = load();
  assert.equal(hd.ID, 'hyperdeck');
  assert.equal(hd.Group, 'Video');
  const byKey = Object.fromEntries(hd.Settings.map((f) => [f.Key, f]));
  assert.equal(byKey.Port.Default, 9993);
  assert.equal(byKey.RequireMedia.Default, true);
  assert.equal(byKey.CheckRecording.Default, false);
  assert.equal(byKey.CheckRecordTime.Default, false);
  assert.equal(byKey.MinRecordMinutes.Default, 15);
  assert.deepEqual(byKey.MinRecordMinutes.VisibleWhen, { Key: 'CheckRecordTime', Equals: true });
  assert.equal(byKey.RecordTimeScope.Default, 'all');
  assert.equal(byKey.Timeout.Default, 4000);

  const opts = hd._internal.ParseHealthOptions({ Settings: {} });
  assert.equal(opts.RequireMedia, true);
  assert.equal(opts.CheckRecording, false);
  assert.equal(opts.MinRecordMinutes, 15);
  assert.equal(opts.RecordTimeScope, 'all');
});

test('hyperdeck reply framing handles single-line, multi-line and partial replies', () => {
  const { FrameReply, DecodeReply, ParseMessage } = load()._internal;
  assert.equal(FrameReply('200 ok'), null); // no newline yet
  assert.equal(FrameReply('200 ok\n'), 7);
  assert.equal(FrameReply('208 transport info:\nstatus: play\n'), null); // no blank line yet
  const text = '208 transport info:\nstatus: play\ntimecode: 00:00:01:02\n\n200 ok\n';
  const first = FrameReply(text);
  const msg = DecodeReply(text.slice(0, first));
  assert.equal(msg.Code, 208);
  assert.equal(msg.Text, 'transport info');
  assert.equal(msg.Fields.timecode, '00:00:01:02'); // value colons survive
  assert.equal(DecodeReply(text.slice(first)).Code, 200);
  assert.equal(ParseMessage('hello world', []), null);
  // Leading blank lines are skipped.
  assert.equal(DecodeReply('\n\n102 invalid value\n').Code, 102);
});

test('hyperdeck EvaluateHealth is pure and orders reasons', () => {
  const { EvaluateHealth, ParseSlot, ParseTransport } = load()._internal;
  const snap = {
    IsHyperDeck: true,
    Rejected: false,
    Transport: ParseTransport({ status: 'stopped', 'slot id': '2' }),
    Slots: [
      ParseSlot(1, { status: 'error' }),
      ParseSlot(2, { status: 'mounted', 'recording time': '120' }),
    ],
    Incomplete: null,
  };
  const reasons = EvaluateHealth(snap, {
    RequireMedia: true,
    CheckRecording: true,
    CheckRecordTime: true,
    MinRecordMinutes: 15,
    RecordTimeScope: 'active',
  });
  assert.deepEqual(reasons, [
    'Slot 1: media error',
    'Not recording (transport stopped)',
    'Slot 2: 2 min recording time left (minimum 15)',
  ]);
  assert.deepEqual(EvaluateHealth({ ...snap, IsHyperDeck: false }, {}), [
    'Responded, but does not look like a HyperDeck',
  ]);
});
