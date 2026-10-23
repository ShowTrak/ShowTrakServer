const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('allen-heath-console.js'), {});
}

const HEADER = [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x10, 0x01, 0x00];

// A fake Allen & Heath console speaking MIDI over TCP, built from the dLive
// V2.0 / Avantis V1.10 / SQ Issue 5 protocol documents.
//
// Options:
//   family        'dlive' | 'avantis' | 'sq' (decides which queries it answers)
//   base          0-based base MIDI channel it answers on (others are ignored)
//   names         { note: 'Name' } channel names (note = channel - 1)
//   mutes         { 'midiChannel:note': true|false } dLive mute states
//   sqMutes       { 'msb:lsb': true|false } SQ mute states
//   running       true: replies use MIDI running status
//   activeSense   true: interleave FE bytes inside every reply
//   fragment      true: write replies one byte at a time
//   silent        true: accept the connection, never answer
//   raw           bytes to send on connect instead of answering
//   ignoreSets    true: dLive mute Note On messages are not applied
function startConsole(options = {}) {
  const {
    family = 'dlive',
    base = 0,
    names = { 0: 'Kick' },
    mutes = {},
    sqMutes = {},
    running = false,
    activeSense = false,
    fragment = false,
    silent = false,
    raw = null,
    ignoreSets = false,
  } = options;
  const received = [];
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const send = (bytes) => {
        let out = bytes;
        if (activeSense) {
          out = [];
          for (const b of bytes) out.push(b, 0xfe);
        }
        if (!fragment) return socket.write(Buffer.from(out));
        for (const b of out) socket.write(Buffer.from([b]));
      };
      if (raw != null) {
        socket.write(Buffer.from(raw));
        return;
      }
      let buf = [];
      socket.on('data', (chunk) => {
        for (const b of chunk) {
          received.push(b);
          buf.push(b);
        }
        if (silent) {
          buf = [];
          return;
        }
        // Consume complete requests from the front of the buffer.
        for (;;) {
          if (!buf.length) break;
          if (buf[0] === 0xf0) {
            const end = buf.indexOf(0xf7);
            if (end === -1) break;
            const msg = buf.slice(0, end + 1);
            buf = buf.slice(end + 1);
            if (family === 'sq') continue;
            const ch = msg[8];
            if (msg[9] === 0x01) {
              if (ch !== base) continue;
              const note = msg[10];
              const name = names[note] || '';
              send([...HEADER, ch, 0x02, note, ...Buffer.from(name, 'ascii'), 0xf7]);
            } else if (msg[9] === 0x05 && msg[10] === 0x09 && family === 'dlive') {
              if (ch !== base && ch !== base + 4) continue;
              const note = msg[11];
              const muted = !!mutes[`${ch}:${note}`];
              const vel = muted ? 0x7f : 0x3f;
              send(
                running
                  ? [0x90 | ch, note, vel, note, 0x00]
                  : [0x90 | ch, note, vel, 0x90 | ch, note, 0x00]
              );
            }
            continue;
          }
          if ((buf[0] & 0xf0) === 0x90) {
            // A mute set: Note On then its Note Off (velocity 00).
            if (buf.length < 6) break;
            const msg = buf.slice(0, 6);
            buf = buf.slice(6);
            if (family !== 'sq' && !ignoreSets && msg[2] !== 0) {
              mutes[`${msg[0] & 0x0f}:${msg[1]}`] = msg[2] >= 0x40;
            }
            continue;
          }
          if ((buf[0] & 0xf0) === 0xb0) {
            if (buf.length < 9) break;
            const msg = buf.slice(0, 9);
            buf = buf.slice(9);
            const cc = msg[0];
            if (family !== 'sq' || (cc & 0x0f) !== base) continue;
            if (msg[7] !== 0x60 || msg[8] !== 0x7f) continue; // only the 'get' form is answered
            const msb = msg[2];
            const lsb = msg[5];
            const vf = sqMutes[`${msb}:${lsb}`] ? 0x01 : 0x00;
            send(
              running
                ? [cc, 0x63, msb, 0x62, lsb, 0x06, 0x00, 0x26, vf]
                : [cc, 0x63, msb, cc, 0x62, lsb, cc, 0x06, 0x00, cc, 0x26, vf]
            );
            continue;
          }
          buf.shift(); // unknown byte
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

async function withConsole(options, fn) {
  const desk = await startConsole(options);
  try {
    return await fn(desk);
  } finally {
    await desk.close();
  }
}

function run(ah, desk, settings = {}) {
  return ah.Run({
    Address: '127.0.0.1',
    Settings: { Port: desk.port, Timeout: 1500, Family: 'dlive', MidiChannel: 1, ...settings },
  });
}

test('allen-heath: dLive answers the Input 1 name query and reads healthy', async () => {
  const ah = load();
  await withConsole({}, async (desk) => {
    const r = await run(ah, desk);
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.IsAllenHeath, true);
    assert.equal(r.Input1Name, 'Kick');
    assert.equal(typeof r.LatencyMs, 'number');
    // Exactly the documented name request was sent, nothing else.
    assert.deepEqual(desk.received, [...HEADER, 0x00, 0x01, 0x00, 0xf7]);
  });
});

test('allen-heath: dLive channel and main mutes flag Degraded with channel names', async () => {
  const ah = load();
  await withConsole(
    {
      names: { 0: 'Kick', 2: 'Snare' },
      mutes: { '0:2': true, '4:48': true },
    },
    async (desk) => {
      const r = await run(ah, desk, {
        CheckMainMute: true,
        CheckChannelMutes: true,
        MonitoredChannels: [1, 3],
      });
      assert.equal(r.Success, true);
      assert.equal(r.Degraded, true);
      assert.match(r.DegradedReason, /Main 1 muted/);
      assert.match(r.DegradedReason, /Ch 3 \(Snare\): muted/);
      assert.doesNotMatch(r.DegradedReason, /Ch 1/);
      assert.equal(r.MainMuted, true);
      const ch1 = r.Channels.find((c) => c.Channel === 1);
      assert.equal(ch1.Muted, false);
      assert.equal(ch1.Name, 'Kick');
    }
  );
});

test('allen-heath: dLive all unmuted reads healthy, with running-status, active-sense and fragmented replies', async () => {
  const ah = load();
  await withConsole({ running: true, activeSense: true, fragment: true }, async (desk) => {
    const r = await run(ah, desk, {
      CheckMainMute: true,
      CheckChannelMutes: true,
      MonitoredChannels: [1, 2, 3],
    });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.MainMuted, false);
    assert.deepEqual(
      r.Channels.map((c) => c.Muted),
      [false, false, false]
    );
  });
});

test('allen-heath: a channel beyond the family range is named, not queried', async () => {
  const ah = load();
  await withConsole({}, async (desk) => {
    const r = await run(ah, desk, { CheckChannelMutes: true, MonitoredChannels: [200] });
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Ch 200: not on dLive/);
  });
});

test('allen-heath: wrong base MIDI channel reads offline with a hint', async () => {
  const ah = load();
  await withConsole({ base: 4 }, async (desk) => {
    const started = Date.now();
    const r = await run(ah, desk, { Timeout: 600 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /MIDI channel/);
    assert.ok(Date.now() - started < 1500);
  });
});

test('allen-heath: Avantis reads identity only and ignores mute toggles', async () => {
  const ah = load();
  await withConsole({ family: 'avantis', base: 11 }, async (desk) => {
    const r = await run(ah, desk, {
      Family: 'avantis',
      MidiChannel: 12,
      CheckMainMute: true,
      CheckChannelMutes: true,
      MonitoredChannels: [1],
    });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.IsAllenHeath, true);
    assert.equal(r.MainMuted, null);
    assert.deepEqual(r.Channels, []);
    assert.deepEqual(desk.received, [...HEADER, 0x0b, 0x01, 0x00, 0xf7]);
  });
});

test('allen-heath: SQ with no mute checks sends nothing and reports the connection only', async () => {
  const ah = load();
  await withConsole({ family: 'sq' }, async (desk) => {
    const r = await run(ah, desk, { Family: 'sq' });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded);
    assert.equal(r.IsAllenHeath, null);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(desk.received, []);
  });
});

test('allen-heath: SQ mute reads use only the documented get form', async () => {
  const ah = load();
  await withConsole(
    { family: 'sq', base: 2, sqMutes: { '0:68': true, '0:4': true } },
    async (desk) => {
      const r = await run(ah, desk, {
        Family: 'sq',
        MidiChannel: 3,
        CheckMainMute: true,
        CheckChannelMutes: true,
        MonitoredChannels: [1, 5],
      });
      assert.equal(r.Success, true);
      assert.equal(r.Degraded, true);
      assert.match(r.DegradedReason, /LR muted/);
      assert.match(r.DegradedReason, /Ch 5: muted/);
      assert.equal(r.Channels.find((c) => c.Channel === 1).Muted, false);
      // Every 9-byte request is BN 63 MB BN 62 LB BN 60 7F: never 60 00 (toggle).
      assert.equal(desk.received.length % 9, 0);
      for (let i = 0; i < desk.received.length; i += 9) {
        const m = desk.received.slice(i, i + 9);
        assert.deepEqual(
          [m[0], m[1], m[3], m[4], m[6], m[7], m[8]],
          [0xb2, 0x63, 0xb2, 0x62, 0xb2, 0x60, 0x7f]
        );
      }
      const lr = desk.received
        .slice(0, 27)
        .some((_, i, a) => a[i] === 0x63 && a[i + 1] === 0x00 && a[i + 4] === 0x44);
      assert.ok(lr, 'LR mute parameter 00/44 queried');
    }
  );
});

test('allen-heath: SQ running-status replies are understood', async () => {
  const ah = load();
  await withConsole({ family: 'sq', running: true, sqMutes: { '0:68': false } }, async (desk) => {
    const r = await run(ah, desk, { Family: 'sq', CheckMainMute: true });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.MainMuted, false);
  });
});

test('allen-heath: a device answering with garbage reads Degraded, not an A&H console', async () => {
  const ah = load();
  await withConsole({ raw: Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n') }, async (desk) => {
    const r = await run(ah, desk, { Timeout: 600 });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /not as an Allen & Heath console/);
  });
});

test('allen-heath: missing mute replies are reported as failed reads', async () => {
  const ah = load();
  await withConsole({ family: 'avantis' }, async (desk) => {
    // Pretend dLive against a desk that only answers names: the mute queries
    // go unanswered within the budget.
    const r = await run(ah, desk, { Timeout: 600, CheckMainMute: true });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Failed to read the Main 1 mute state/);
  });
});

test('allen-heath: refused connection is offline and flagged Degraded', async () => {
  const ah = load();
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const r = await ah.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 800 } });
  assert.equal(r.Success, false);
  assert.equal(r.Degraded, true);
});

test('allen-heath: silent console is bounded by the whole-probe budget', async () => {
  const ah = load();
  await withConsole({ silent: true }, async (desk) => {
    const started = Date.now();
    const r = await run(ah, desk, {
      Timeout: 500,
      CheckMainMute: true,
      CheckChannelMutes: true,
      MonitoredChannels: [1, 2],
    });
    assert.equal(r.Success, false);
    assert.ok(Date.now() - started < 1200);
  });
});

test('allen-heath: config validation', async () => {
  const ah = load();
  assert.deepEqual(await ah.Run({ Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const r = await ah.Run({ Address: '127.0.0.1', Settings: { Family: 'dlive', MidiChannel: 13 } });
  assert.equal(r.Success, false);
  assert.match(r.Error, /1 to 12 on dLive/);
  const { ParseChannelList, ParseFamily } = ah._internal;
  assert.deepEqual(ParseChannelList(['3', 3, 'x', 0, 7.5, 2]), [3, 2]);
  assert.deepEqual(ParseChannelList(null), []);
  assert.equal(ParseFamily('SQ'), 'sq');
  assert.equal(ParseFamily('nope'), 'dlive');
});

test('allen-heath: MIDI parser handles running status, real-time bytes and SysEx', () => {
  const { MidiStreamParser, NrpnTracker, ParseNameReply } = load()._internal;
  const p = new MidiStreamParser();
  const events = [
    ...p.Feed([0x90, 0x01, 0x7f, 0xf8, 0x01, 0x00, 0x02]),
    ...p.Feed([0x3f, 0xf0, ...HEADER.slice(1), 0x00, 0x02, 0x05, 0xfe, 0x41, 0x42, 0xf7]),
  ];
  assert.deepEqual(events[0], { Type: 'note', Channel: 0, Note: 1, Velocity: 0x7f });
  assert.deepEqual(events[1], { Type: 'note', Channel: 0, Note: 1, Velocity: 0 });
  assert.deepEqual(events[2], { Type: 'note', Channel: 0, Note: 2, Velocity: 0x3f });
  assert.equal(events[3].Type, 'sysex');
  assert.deepEqual(ParseNameReply(events[3].Data), { MidiChannel: 0, Note: 5, Name: 'AB' });

  // An oversized SysEx is dropped rather than buffered without limit.
  const big = new MidiStreamParser().Feed([0xf0, ...new Array(2000).fill(0x41), 0xf7]);
  assert.deepEqual(big, []);

  const t = new NrpnTracker();
  let out = null;
  for (const e of new MidiStreamParser().Feed([
    0xb0, 0x63, 0x00, 0x62, 0x44, 0x06, 0x00, 0x26, 0x01,
  ])) {
    out = t.Feed(e) || out;
  }
  assert.deepEqual(out, { Channel: 0, Msb: 0, Lsb: 0x44, Coarse: 0, Fine: 1 });
  assert.equal(ParseNameReply([0xf0, 1, 2, 3]), null);
});

test('allen-heath: Debug renders offline, online and channel cards', async () => {
  const ah = load();
  const target = {
    Address: '10.0.0.5',
    Settings: {
      Port: 51328,
      Family: 'dlive',
      CheckChannelMutes: true,
      CheckMainMute: true,
      MonitoredChannels: [1, 2],
    },
  };
  const offline = ah.Debug({ Success: false, Error: 'connect ECONNREFUSED' }, target);
  assert.match(offline, /Offline/);
  assert.match(offline, /ECONNREFUSED/);
  assert.match(offline, /51328/);

  const online = ah.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: 'Ch 2 (<b>Vox</b>): muted',
      LatencyMs: 12,
      IsAllenHeath: true,
      Input1Name: 'Kick',
      MainMuted: false,
      Channels: [
        { Channel: 1, Supported: true, Name: 'Kick', Muted: false },
        { Channel: 2, Supported: true, Name: '<b>Vox</b>', Muted: true },
      ],
    },
    target
  );
  assert.match(online, /Input 1 name/);
  assert.match(online, /Muted/);
  assert.match(online, /Main 1/);
  assert.doesNotMatch(online, /<b>Vox<\/b>/);

  const sq = ah.Debug(
    { Success: true, LatencyMs: 3, IsAllenHeath: null, Channels: [] },
    { Address: '10.0.0.6', Settings: { Family: 'sq' } }
  );
  assert.match(sq, /no identity query/);
});

// --- Actions -------------------------------------------------------------------

function act(ah, desk, id, params, settings = {}) {
  return ah.RunAction(
    {
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 800, Family: 'dlive', MidiChannel: 1, ...settings },
    },
    id,
    params
  );
}

const NAME_Q = (ch, note) => [...HEADER, ch, 0x01, note, 0xf7];
const MUTE_Q = (ch, note) => [...HEADER, ch, 0x05, 0x09, note, 0xf7];

test('allen-heath actions: declared with the right flags and first params', () => {
  const { Actions } = load();
  const byId = Object.fromEntries(Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId).sort(), ['mute.off', 'mute.on', 'scene.recall']);
  assert.equal(byId['scene.recall'].Destructive, true);
  assert.equal(byId['mute.on'].Destructive, true);
  assert.ok(!byId['mute.off'].Destructive);
  for (const a of Actions) {
    assert.ok(!a.AllowedWhileOffline);
    for (const p of a.Params) {
      assert.equal(p.Default, undefined);
      assert.equal(p.Min, undefined);
      assert.equal(p.Max, undefined);
    }
  }
  assert.equal(byId['scene.recall'].Params[0].Key, 'Scene');
  assert.equal(byId['mute.on'].Params[0].Key, 'Channel');
});

test('allen-heath actions: scene recall bytes per family and bank', () => {
  const { SceneRecallMessage } = load()._internal;
  const hex = (b) => [...b];
  // SQ Issue 5 worked examples.
  assert.deepEqual(hex(SceneRecallMessage(0, 7)), [0xb0, 0x00, 0x00, 0xc0, 0x06]);
  assert.deepEqual(hex(SceneRecallMessage(0, 120)), [0xb0, 0x00, 0x00, 0xc0, 0x77]);
  assert.deepEqual(hex(SceneRecallMessage(0, 156)), [0xb0, 0x00, 0x01, 0xc0, 0x1b]);
  assert.deepEqual(hex(SceneRecallMessage(2, 156)), [0xb2, 0x00, 0x01, 0xc2, 0x1b]);
  // dLive / Avantis bank edges (1-128 = 00, 385-500 = 03).
  assert.deepEqual(hex(SceneRecallMessage(11, 128)), [0xbb, 0x00, 0x00, 0xcb, 0x7f]);
  assert.deepEqual(hex(SceneRecallMessage(11, 129)), [0xbb, 0x00, 0x01, 0xcb, 0x00]);
  assert.deepEqual(hex(SceneRecallMessage(0, 500)), [0xb0, 0x00, 0x03, 0xc0, 0x73]);
});

test('allen-heath actions: dLive scene recall checks the console answers first, then sends once', async () => {
  const ah = load();
  await withConsole({}, async (desk) => {
    const r = await act(ah, desk, 'scene.recall', { Scene: '130' });
    assert.deepEqual(r, { Success: true, Detail: 'Scene 130 recalled' });
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(desk.received, [...NAME_Q(0, 0), 0xb0, 0x00, 0x01, 0xc0, 0x01]);
  });
});

test('allen-heath actions: a silent or wrong-channel console is never sent the command', async () => {
  const ah = load();
  await withConsole({ base: 3 }, async (desk) => {
    const r = await act(ah, desk, 'mute.on', { Channel: 2 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /did not answer on MIDI channel 1.*nothing was sent/);
    assert.deepEqual(desk.received, NAME_Q(0, 1));
  });
});

test('allen-heath actions: dLive Surface port refuses scene recall', async () => {
  const ah = load();
  const r = await ah.RunAction(
    { Address: '127.0.0.1', Settings: { Port: 51328, Family: 'dlive' } },
    'scene.recall',
    { Scene: 1 }
  );
  assert.equal(r.Success, false);
  assert.match(r.Error, /MixRack \(port 51325\)/);
});

test('allen-heath actions: dLive mute sends Note On + Note Off and reads the mute back', async () => {
  const ah = load();
  await withConsole({ names: { 4: 'Vox' } }, async (desk) => {
    const on = await act(ah, desk, 'mute.on', { Channel: 5 });
    assert.deepEqual(on, { Success: true, Detail: 'Input 5 (Vox) muted' });
    assert.deepEqual(desk.received, [
      ...NAME_Q(0, 4),
      ...[0x90, 0x04, 0x7f, 0x90, 0x04, 0x00],
      ...MUTE_Q(0, 4),
    ]);
    desk.received.length = 0;
    const off = await act(ah, desk, 'mute.off', { Channel: 5 });
    assert.deepEqual(off, { Success: true, Detail: 'Input 5 (Vox) unmuted' });
    assert.deepEqual(desk.received.slice(12, 18), [0x90, 0x04, 0x3f, 0x90, 0x04, 0x00]);
  });
});

test('allen-heath actions: a dLive that keeps the old mute state is a specific error', async () => {
  const ah = load();
  await withConsole({ ignoreSets: true }, async (desk) => {
    const r = await act(ah, desk, 'mute.on', { Channel: 1 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /still reports Input 1 \(Kick\) as unmuted/);
  });
});

test('allen-heath actions: Avantis uses the dLive mute and scene messages, base channel 12', async () => {
  const ah = load();
  await withConsole({ family: 'avantis', base: 11, names: { 95: 'Last' } }, async (desk) => {
    const r = await act(
      ah,
      desk,
      'mute.on',
      { Channel: 96 },
      { Family: 'avantis', MidiChannel: 12 }
    );
    assert.deepEqual(r, { Success: true, Detail: 'Input 96 (Last) muted' });
    await new Promise((res) => setTimeout(res, 30));
    // No mute read-back on Avantis: it documents none.
    assert.deepEqual(desk.received, [...NAME_Q(11, 95), 0x9b, 0x5f, 0x7f, 0x9b, 0x5f, 0x00]);
    desk.received.length = 0;
    const s = await act(
      ah,
      desk,
      'scene.recall',
      { Scene: 500 },
      { Family: 'avantis', MidiChannel: 12 }
    );
    assert.equal(s.Success, true);
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(desk.received.slice(-5), [0xbb, 0x00, 0x03, 0xcb, 0x73]);
  });
});

test('allen-heath actions: SQ mute and scene send only the documented set messages, never a get or toggle', async () => {
  const ah = load();
  await withConsole({ family: 'sq', base: 2 }, async (desk) => {
    const sq = { Family: 'sq', MidiChannel: 3 };
    assert.deepEqual(await act(ah, desk, 'mute.on', { Channel: 48 }, sq), {
      Success: true,
      Detail: 'Input 48 muted',
    });
    assert.deepEqual(await act(ah, desk, 'mute.off', { Channel: 1 }, sq), {
      Success: true,
      Detail: 'Input 1 unmuted',
    });
    assert.deepEqual(await act(ah, desk, 'scene.recall', { Scene: 300 }, sq), {
      Success: true,
      Detail: 'Scene 300 recalled',
    });
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(desk.received, [
      ...[0xb2, 0x63, 0x00, 0xb2, 0x62, 0x2f, 0xb2, 0x06, 0x00, 0xb2, 0x26, 0x01],
      ...[0xb2, 0x63, 0x00, 0xb2, 0x62, 0x00, 0xb2, 0x06, 0x00, 0xb2, 0x26, 0x00],
      ...[0xb2, 0x00, 0x02, 0xc2, 0x2b],
    ]);
    // No Data Increment (CC 60) anywhere: neither the get nor the toggle.
    for (let i = 0; i < desk.received.length - 1; i++) {
      assert.ok(!(desk.received[i] === 0xb2 && desk.received[i + 1] === 0x60));
    }
  });
});

test('allen-heath actions: params are validated per family before connecting', async () => {
  const ah = load();
  const t = (Settings) => ({ Address: '127.0.0.1', Settings: { Port: 1, ...Settings } });
  const cases = [
    ['scene.recall', {}, {}, /Scene must be 1 to 500 on dLive/],
    ['scene.recall', { Scene: 0 }, {}, /1 to 500/],
    ['scene.recall', { Scene: 501 }, {}, /1 to 500/],
    ['scene.recall', { Scene: 2.5 }, {}, /1 to 500/],
    ['scene.recall', { Scene: true }, {}, /1 to 500/],
    ['scene.recall', { Scene: 301 }, { Family: 'sq' }, /Scene must be 1 to 300 on SQ/],
    ['mute.on', { Channel: 129 }, {}, /1 to 128 on dLive/],
    ['mute.on', { Channel: 97 }, { Family: 'avantis' }, /1 to 96 on Avantis/],
    ['mute.off', { Channel: 49 }, { Family: 'sq' }, /1 to 48 on SQ/],
    ['mute.off', { Channel: 'x' }, {}, /Input channel must be/],
    ['mute.on', { Channel: 1 }, { MidiChannel: 'abc' }, /Base MIDI channel must be/],
    ['mute.on', { Channel: 1 }, { MidiChannel: 13 }, /1 to 12 on dLive/],
    ['power.off', {}, {}, /Unknown Allen & Heath action/],
  ];
  for (const [id, params, settings, re] of cases) {
    const r = await ah.RunAction(t(settings), id, params);
    assert.equal(r.Success, false, `${id} ${JSON.stringify(params)}`);
    assert.match(r.Error, re);
  }
  const none = await ah.RunAction({ Settings: {} }, 'mute.on', { Channel: 1 });
  assert.equal(none.Error, 'No address configured');
});

test('allen-heath actions: DescribeAction binds the param', () => {
  const { DescribeAction } = load();
  assert.equal(DescribeAction('scene.recall', { Scene: 12 }), 'Recall Scene 12');
  assert.equal(DescribeAction('mute.on', { Channel: '3' }), 'Mute Input 3');
  assert.equal(DescribeAction('mute.off', { Channel: 3 }), 'Unmute Input 3');
  assert.equal(DescribeAction('scene.recall', {}), null);
});

test('allen-heath: Run never sends a state-changing message, whatever the settings', async () => {
  // Every message Run may send: a SysEx query (name 01 / mute get 05 09), or the
  // SQ get BN 63 MB BN 62 LB BN 60 7F. Anything else would be a set.
  const settingsList = [
    {},
    { CheckMainMute: true, CheckChannelMutes: true, MonitoredChannels: [1, 128, 129, 'x'] },
    { CheckMainMute: 'true', CheckChannelMutes: 1, MonitoredChannels: '5' },
    {
      Family: 'avantis',
      MidiChannel: 12,
      CheckMainMute: true,
      CheckChannelMutes: true,
      MonitoredChannels: [1],
    },
    { Family: 'sq', CheckChannelMutes: true, MonitoredChannels: [] },
    {
      Family: 'sq',
      CheckMainMute: true,
      CheckChannelMutes: true,
      MonitoredChannels: [1, 48, 49, 999],
    },
    { Family: 'SQ ', MidiChannel: '16', CheckMainMute: true },
    { Family: 'garbage', MidiChannel: 2.5, CheckMainMute: true },
    { Family: 'dlive', MidiChannel: -4, CheckMainMute: true },
    { Family: null, MidiChannel: null, MonitoredChannels: { a: 1 }, CheckChannelMutes: true },
  ];
  for (const family of ['dlive', 'sq']) {
    for (const settings of settingsList) {
      await withConsole({ family }, async (desk) => {
        await run(ah0, desk, { Timeout: 500, ...settings });
        const b = desk.received;
        let i = 0;
        while (i < b.length) {
          if (b[i] === 0xf0) {
            const end = b.indexOf(0xf7, i);
            const msg = b.slice(i, end + 1);
            assert.ok(
              msg[9] === 0x01 || (msg[9] === 0x05 && msg[10] === 0x09),
              JSON.stringify(msg)
            );
            i = end + 1;
          } else {
            const m = b.slice(i, i + 9);
            assert.equal(m[0] & 0xf0, 0xb0, JSON.stringify(settings));
            assert.deepEqual([m[1], m[4], m[7], m[8]], [0x63, 0x62, 0x60, 0x7f]);
            assert.ok(m[0] === m[3] && m[3] === m[6]);
            i += 9;
          }
        }
      });
    }
  }
});
const ah0 = load();
