const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function loadAmp() {
  return loadWithMocks(methodPath('powersoft-amp.js'), {});
}

// --- Frame helpers built straight from the Powersoft PDF (not from the module) ---

function frame(cmd, cookie, data, { answerPort = 0, crc = 0 } = {}) {
  const out = Buffer.alloc(12 + data.length);
  out[0] = 0x02;
  out[1] = cmd;
  out.writeUInt16LE(cookie, 2);
  out.writeUInt16LE(data.length, 4);
  out.writeUInt16LE(answerPort, 6);
  data.copy(out, 8);
  out.writeUInt16LE(crc, 8 + data.length);
  out[10 + data.length] = ~cmd & 0xff;
  out[11 + data.length] = 0x03;
  return out;
}

function cstr(s) {
  const b = Buffer.alloc(32);
  b.write(s, 'latin1');
  return b;
}

function infoData({ manufacturer, family, model, serial }) {
  return Buffer.concat([cstr(manufacturer), cstr(family), cstr(model), cstr(serial)]);
}

function readGmData({ numChannels, mutes = [], gains = [] }) {
  const d = Buffer.alloc(52);
  d[0] = 1;
  d[1] = numChannels;
  for (let i = 0; i < 8; i++) {
    d.writeInt16LE(0, 4 + i * 2);
    d.writeInt16LE(gains[i] == null ? 0 : gains[i], 20 + i * 2);
    d[36 + i] = 0;
    d[44 + i] = mutes[i] ? 1 : 0;
  }
  return d;
}

function alarmsData({ gpio = 0, global = 0, channels = [] }) {
  const d = Buffer.alloc(40);
  d[0] = 1;
  d[1] = gpio;
  d.writeUInt32LE(global >>> 0, 4);
  for (let i = 0; i < 8; i++) d.writeUInt32LE((channels[i] || 0) >>> 0, 8 + i * 4);
  return d;
}

// A fake Powersoft amplifier on 127.0.0.1 speaking the UDP protocol. It answers
// the sender on the request's answer_port (or the source port when it is 0, so
// a test notices if the module ever sends 0).
//   standby      : 1 (standby) / 2 (operative)
//   dropFirst    : swallow this many incoming datagrams (UDP loss)
//   silentCmds   : request cmds never answered
//   raw          : (req) => Buffer | null to override every reply
//   reverse      : hold all replies and send them in reverse order
//   refuseCmds   : request cmds answered with answer_ok = 0
// STANDBY writes (ON-OFF-READ 1/2) and WRITEOUTMUTE change the fake's state, so
// a following read shows the effect.
function startAmp({
  manufacturer = 'Powersoft',
  family = 'Ottocanali',
  model = '4K4 DSP+D',
  serial = '718049',
  standby = 2,
  numChannels = 4,
  mutes = [],
  gains = [],
  global = 0,
  channels = [],
  gpio = 0,
  dropFirst = 0,
  silentCmds = [],
  raw = null,
  reverse = false,
  refuseCmds = [],
} = {}) {
  mutes = [...mutes];
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const received = [];
    let dropped = 0;
    const held = [];
    sock.on('message', (buf, rinfo) => {
      if (dropped < dropFirst) {
        dropped++;
        return;
      }
      const req = {
        cmd: buf[1],
        cookie: buf.readUInt16LE(2),
        count: buf.readUInt16LE(4),
        answerPort: buf.readUInt16LE(6),
        data: buf.subarray(8, 8 + buf.readUInt16LE(4)),
        crc: buf.readUInt16LE(8 + buf.readUInt16LE(4)),
        notCmd: buf[10 + buf.readUInt16LE(4)],
        etx: buf[buf.length - 1],
      };
      received.push(req);
      if (silentCmds.includes(req.cmd)) return;
      let reply = null;
      const ok = refuseCmds.includes(req.cmd) ? 0 : 1;
      if (raw) reply = raw(req);
      else if (req.cmd === 3) {
        const ch = req.data[0];
        const valid = ok && ch < numChannels;
        if (valid) mutes[ch] = req.data[1] === 1;
        reply = frame(252, req.cookie, Buffer.from([valid ? 1 : 0, ch, req.data[1], 0]));
      } else if (req.cmd === 14 && req.data[0] !== 0) {
        if (ok) standby = req.data[0] === 1 ? 2 : 1;
        reply = frame(241, req.cookie, Buffer.from([ok, standby, 0, 0]));
      } else if (req.cmd === 11) {
        reply = frame(244, req.cookie, infoData({ manufacturer, family, model, serial }));
      } else if (req.cmd === 14) {
        reply = frame(241, req.cookie, Buffer.from([1, standby, 0, 0]));
      } else if (req.cmd === 1) {
        reply = frame(254, req.cookie, readGmData({ numChannels, mutes, gains }));
      } else if (req.cmd === 25) {
        reply = frame(230, req.cookie, alarmsData({ gpio, global, channels }));
      }
      if (!reply) return;
      const port = req.answerPort || rinfo.port;
      if (reverse) {
        held.push(reply);
        if (held.length === 3 + (silentCmds.length ? 0 : 1)) {
          for (const r of held.reverse()) sock.send(r, port, rinfo.address);
        }
        return;
      }
      sock.send(reply, port, rinfo.address);
    });
    sock.bind(0, '127.0.0.1', () => {
      resolve({
        port: sock.address().port,
        received,
        close: () => new Promise((r) => sock.close(r)),
      });
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function runAgainst(amp, settings = {}) {
  const mod = loadAmp();
  return mod.Run({
    Address: '127.0.0.1',
    Settings: { Port: amp.port, Timeout: 1500, ...settings },
  });
}

test('powersoft exposes its identity and read-only defaults', () => {
  const amp = loadAmp();
  assert.equal(amp.ID, 'powersoft-amp');
  assert.equal(typeof amp.Run, 'function');
  assert.equal(typeof amp.Debug, 'function');
  const byKey = Object.fromEntries(amp.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 1234);
  assert.equal(byKey.Port.Required, true);
  assert.equal(byKey.CheckStandby.Default, true);
  assert.equal(byKey.CheckFaults.Default, true);
  assert.equal(byKey.CheckChannelFaults.Default, true);
  assert.equal(byKey.CheckClip.Default, false);
  assert.equal(byKey.CheckMutes.Default, false);
  assert.equal(byKey.CheckSerial.Default, false);
  assert.deepEqual(byKey.MonitoredChannels.VisibleWhen, { Key: 'CheckMutes', Equals: true });
  assert.deepEqual(byKey.ExpectedSerial.VisibleWhen, { Key: 'CheckSerial', Equals: true });
  assert.equal(byKey.Timeout.Advanced, true);
  assert.equal(typeof amp.RunAction, 'function');
});

test('powersoft happy path reads identity, standby, mutes and alarms', async () => {
  const amp = await startAmp({ gains: [0, -350] });
  try {
    const result = await runAgainst(amp);
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.IsAmplifier, true);
    assert.equal(result.Manufacturer, 'Powersoft');
    assert.equal(result.Family, 'Ottocanali');
    assert.equal(result.Model, '4K4 DSP+D');
    assert.equal(result.Serial, '718049');
    assert.equal(result.Standby, false);
    assert.equal(result.NumChannels, 4);
    assert.equal(result.AlarmsRead, true);
    assert.deepEqual(result.GlobalAlarms, []);
    assert.equal(result.Channels.length, 4);
    assert.equal(result.Channels[1].GainDb, -3.5);
    assert.equal(result.Channels[1].Muted, false);
    assert.equal(typeof result.LatencyMs, 'number');
  } finally {
    await amp.close();
  }
});

test('powersoft only ever sends read requests, framed as the PDF specifies', async () => {
  const amp = await startAmp();
  try {
    await runAgainst(amp, { CheckMutes: true });
    const cmds = amp.received.map((r) => r.cmd).sort((a, b) => a - b);
    assert.deepEqual(cmds, [1, 11, 14, 25]);
    for (const req of amp.received) {
      assert.equal(req.notCmd, ~req.cmd & 0xff);
      assert.equal(req.etx, 0x03);
      assert.equal(req.crc, 0, 'empty / all-zero data has CRC 0');
      assert.ok(req.answerPort > 0, 'answer_port names our socket');
    }
    const standby = amp.received.find((r) => r.cmd === 14);
    assert.deepEqual([...standby.data], [0, 0, 0, 0], 'STANDBY is sent with ON_OFF_READ = 0');
    const cookies = new Set(amp.received.map((r) => r.cookie));
    assert.equal(cookies.size, amp.received.length, 'each request has its own cookie');
  } finally {
    await amp.close();
  }
});

test('powersoft skips READALLALARMS2 when every alarm toggle is off', async () => {
  const amp = await startAmp();
  try {
    const result = await runAgainst(amp, {
      CheckFaults: false,
      CheckChannelFaults: false,
      CheckClip: false,
    });
    assert.equal(result.Success, true);
    assert.ok(!amp.received.some((r) => r.cmd === 25));
    assert.equal(result.AlarmsRead, false);
  } finally {
    await amp.close();
  }
});

test('powersoft degrades in standby, and not when the toggle is off', async () => {
  const amp = await startAmp({ standby: 1 });
  try {
    const on = await runAgainst(amp);
    assert.equal(on.Success, true);
    assert.equal(on.Degraded, true);
    assert.equal(on.Standby, true);
    assert.match(on.DegradedReason, /In standby/);
    const off = await runAgainst(amp, { CheckStandby: false });
    assert.ok(!off.Degraded, off.DegradedReason);
  } finally {
    await amp.close();
  }
});

test('powersoft names each global alarm bit', async () => {
  const amp = await startAmp({ global: (1 << 0) | (1 << 6) | (1 << 8) });
  try {
    const result = await runAgainst(amp);
    assert.equal(result.Degraded, true);
    assert.deepEqual(result.GlobalAlarms, [
      'Mains phase error',
      'Fan fault',
      'High over-temperature',
    ]);
    assert.match(result.DegradedReason, /Fan fault/);
    const off = await runAgainst(amp, { CheckFaults: false });
    assert.ok(!off.Degraded, off.DegradedReason);
  } finally {
    await amp.close();
  }
});

test('powersoft names channel faults and keeps clip behind its own toggle', async () => {
  const amp = await startAmp({ channels: [0, (1 << 3) | (1 << 7), 1 << 0] });
  try {
    const result = await runAgainst(amp);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /Ch 2: over-temperature, low load protection/);
    assert.doesNotMatch(result.DegradedReason, /clip/);
    assert.equal(result.Channels[2].Clip, true);

    const clip = await runAgainst(amp, { CheckChannelFaults: false, CheckClip: true });
    assert.equal(clip.DegradedReason, 'Ch 3: input clip');

    const neither = await runAgainst(amp, { CheckChannelFaults: false });
    assert.ok(!neither.Degraded, neither.DegradedReason);
  } finally {
    await amp.close();
  }
});

test('powersoft output mutes: every channel by default, or only the listed ones', async () => {
  const amp = await startAmp({ mutes: [false, true, false, true] });
  try {
    const all = await runAgainst(amp, { CheckMutes: true });
    assert.equal(all.DegradedReason, 'Ch 2: muted; Ch 4: muted');
    const listed = await runAgainst(amp, { CheckMutes: true, MonitoredChannels: ['1', 3, 9] });
    assert.equal(listed.DegradedReason, 'Ch 9: not on this amplifier');
    const ignored = await runAgainst(amp, { MonitoredChannels: [2] });
    assert.ok(!ignored.Degraded, 'mute list is ignored while the toggle is off');
  } finally {
    await amp.close();
  }
});

test('powersoft serial check is case-insensitive', async () => {
  const amp = await startAmp({ serial: 'ab1234' });
  try {
    const ok = await runAgainst(amp, { CheckSerial: true, ExpectedSerial: 'AB1234' });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await runAgainst(amp, { CheckSerial: true, ExpectedSerial: 'XY9' });
    assert.equal(bad.DegradedReason, 'Serial "ab1234" (expected "XY9")');
  } finally {
    await amp.close();
  }
});

test('powersoft re-sends lost requests with the same cookie', async () => {
  const amp = await startAmp({ dropFirst: 3 });
  try {
    const result = await runAgainst(amp, { Timeout: 2000 });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
  } finally {
    await amp.close();
  }
});

test('powersoft matches answers by cookie in any order', async () => {
  const amp = await startAmp({ reverse: true, mutes: [true] });
  try {
    const result = await runAgainst(amp, { CheckMutes: true, MonitoredChannels: [1] });
    assert.equal(result.Serial, '718049');
    assert.equal(result.Standby, false);
    assert.equal(result.DegradedReason, 'Ch 1: muted');
  } finally {
    await amp.close();
  }
});

test('powersoft reports what it read when an answer never comes', async () => {
  const amp = await startAmp({ silentCmds: [25] });
  try {
    const result = await runAgainst(amp, { Timeout: 800 });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Failed to read the alarms');
    assert.equal(result.Serial, '718049');
  } finally {
    await amp.close();
  }
});

test('powersoft treats answer_ok = 0 as an unread value', async () => {
  const amp = await startAmp({
    raw: (req) => {
      if (req.cmd === 11) {
        return frame(
          244,
          req.cookie,
          infoData({ manufacturer: 'Powersoft', family: 'X', model: 'X8', serial: '1' })
        );
      }
      if (req.cmd === 14) return frame(241, req.cookie, Buffer.from([0, 0, 0, 0]));
      if (req.cmd === 1) return frame(254, req.cookie, Buffer.alloc(52));
      return frame(230, req.cookie, Buffer.alloc(40));
    },
  });
  try {
    const result = await runAgainst(amp, { CheckMutes: true });
    assert.equal(result.Success, true);
    assert.match(result.DegradedReason, /Failed to read the standby state/);
    assert.match(result.DegradedReason, /Failed to read the alarms/);
    assert.match(result.DegradedReason, /Failed to read the output mutes/);
  } finally {
    await amp.close();
  }
});

test('powersoft is degraded when something answers that is not an amplifier', async () => {
  const amp = await startAmp({ raw: () => Buffer.from('HELLO WORLD, NOT AN AMP') });
  try {
    const result = await runAgainst(amp, { Timeout: 600 });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Responded, but does not look like a Powersoft amplifier');
  } finally {
    await amp.close();
  }
});

test('powersoft ignores frames with the wrong cookie, cmd or trailer', async () => {
  const amp = await startAmp({
    raw: (req) => {
      const good = frame(~req.cmd & 0xff, req.cookie, Buffer.alloc(128));
      if (req.cmd === 11) {
        const badTrailer = Buffer.from(good);
        badTrailer[10 + 128] = 0x55;
        return badTrailer;
      }
      if (req.cmd === 14) return frame(241, (req.cookie + 1) & 0xffff, Buffer.from([1, 2, 0, 0]));
      return frame(0x99, req.cookie, Buffer.alloc(4));
    },
  });
  try {
    const result = await runAgainst(amp, { Timeout: 600 });
    assert.equal(result.IsAmplifier, false);
    assert.equal(result.Standby, null);
    assert.equal(result.Degraded, true);
  } finally {
    await amp.close();
  }
});

test('powersoft is offline when nothing answers', async () => {
  const mod = loadAmp();
  const port = await freeUdpPort();
  const started = Date.now();
  const result = await mod.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 600 } });
  assert.equal(result.Success, false);
  assert.ok(result.Error);
  assert.ok(Date.now() - started < 1500, 'bounded by the whole-probe budget');
});

test('powersoft rejects a missing address or bad port without probing', async () => {
  const mod = loadAmp();
  assert.deepEqual(await mod.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const bad = await mod.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.equal(bad.Success, false);
  assert.match(bad.Error, /Invalid port/);
});

test('powersoft CRC is CRC-16/ARC with the PDF check value', () => {
  const { Crc16, BuildFrame, ParseFrame } = loadAmp()._internal;
  assert.equal(Crc16(Buffer.from('123456789')), 0xbb3d);
  assert.equal(Crc16(Buffer.alloc(0)), 0);
  assert.equal(Crc16(Buffer.alloc(4)), 0);
  const built = BuildFrame(11, 0x1234, 5555, Buffer.alloc(0));
  assert.deepEqual([...built], [0x02, 11, 0x34, 0x12, 0, 0, 0xb3, 0x15, 0, 0, 244, 0x03]);
  assert.equal(ParseFrame(Buffer.from([1, 2, 3])), null);
  const parsed = ParseFrame(frame(244, 7, Buffer.from([1, 2])));
  assert.equal(parsed.Cmd, 244);
  assert.equal(parsed.Cookie, 7);
  assert.deepEqual([...parsed.Data], [1, 2]);
  // Length that disagrees with count is rejected.
  assert.equal(
    ParseFrame(Buffer.concat([frame(244, 7, Buffer.from([1, 2])), Buffer.from([3])])),
    null
  );
});

test('powersoft decoders follow the PDF layouts', () => {
  const i = loadAmp()._internal;
  assert.equal(i.ParseStandby(Buffer.from([1, 1, 0, 0])), true);
  assert.equal(i.ParseStandby(Buffer.from([1, 2, 0, 0])), false);
  assert.equal(i.ParseStandby(Buffer.from([1, 7, 0, 0])), null);
  const gm = i.ParseReadGm(readGmData({ numChannels: 2, mutes: [true], gains: [-6000, 1500] }));
  assert.deepEqual(gm, { NumChannels: 2, OutGainDb: [-60, 15], OutMuted: [true, false] });
  assert.equal(i.ParseReadGm(Buffer.alloc(10)), null);
  const al = i.ParseAlarms2(alarmsData({ gpio: 0x81, global: 1 << 4, channels: [1 << 4] }));
  assert.equal(al.Gpio, 0x81);
  assert.deepEqual(i.GlobalAlarmNames(al.Global), ['Digital board over-temperature']);
  assert.deepEqual(i.ChannelFaultNames(al.ChannelWords[0]), ['rail voltage fault']);
  assert.deepEqual(i.ChannelFaultNames(1 << 0), [], 'clip is not a fault');
  assert.deepEqual(i.ParseChannelList(['2', 2, 'x', 0, 5]), [2, 5]);
});

test('powersoft EvaluateHealth is pure and gated by its toggles', () => {
  const { EvaluateHealth } = loadAmp()._internal;
  const snap = {
    IsAmplifier: true,
    Serial: 'S1',
    Standby: true,
    NumChannels: 1,
    AlarmsRead: true,
    GlobalAlarms: ['Fan fault'],
    Channels: [{ Channel: 1, Muted: true, GainDb: 0, Clip: true, Faults: ['other fault'] }],
  };
  const none = {
    CheckStandby: false,
    CheckFaults: false,
    CheckChannelFaults: false,
    CheckClip: false,
    CheckMutes: false,
    Channels: [],
    CheckSerial: false,
    ExpectedSerial: '',
  };
  assert.deepEqual(EvaluateHealth(snap, none), []);
  assert.deepEqual(
    EvaluateHealth(snap, {
      ...none,
      CheckStandby: true,
      CheckFaults: true,
      CheckChannelFaults: true,
      CheckClip: true,
      CheckMutes: true,
    }),
    ['In standby', 'Fan fault', 'Ch 1: other fault, input clip', 'Ch 1: muted']
  );
});

test('powersoft Debug escapes device-supplied strings', async () => {
  const amp = await startAmp({
    family: '<img src=x>',
    model: '"m"',
    serial: '<b>s</b>',
    channels: [1 << 6],
  });
  try {
    const mod = loadAmp();
    const target = { Address: '127.0.0.1', Settings: { Port: amp.port, Timeout: 1500 } };
    const result = await mod.Run(target);
    const html = mod.Debug(result, target);
    assert.ok(!html.includes('<img src=x>'));
    assert.ok(!html.includes('<b>s</b>'));
    assert.match(html, /&lt;img src=x&gt;/);
    assert.match(html, /Operative/);
    assert.match(html, /Ch 1/);
    assert.match(html, /other fault/);
  } finally {
    await amp.close();
  }
});

test('powersoft Debug renders the offline hint', () => {
  const mod = loadAmp();
  const html = mod.Debug(
    { Success: false, Error: 'No reply within 600ms' },
    { Address: '10.0.0.5', Settings: { Port: 1234 } }
  );
  assert.match(html, /Offline/);
  assert.match(html, /No reply within 600ms/);
  assert.match(html, /UDP 1234/);
});

// --- Actions -------------------------------------------------------------------------

// CRC-16/ARC computed independently of the module (reflected 0xA001, init 0).
function crcArc(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

function actionTarget(amp, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: amp.port, Timeout: 1500, ...settings } };
}

test('powersoft actions are declared with the agreed IDs and confirmation flags', () => {
  const m = loadAmp();
  const byId = Object.fromEntries(m.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['power.on', 'power.standby', 'mute.on', 'mute.off']);
  assert.ok(!byId['power.on'].Destructive);
  assert.equal(byId['power.standby'].Destructive, true);
  assert.equal(byId['mute.on'].Destructive, true);
  assert.ok(!byId['mute.off'].Destructive);
  for (const a of m.Actions) assert.ok(!a.AllowedWhileOffline, a.ID);
  assert.equal(byId['mute.on'].Params[0].Key, 'Channel');
  assert.equal(m.InvalidateCaches, undefined, 'nothing is cached');
});

test('Power On and Standby send STANDBY with the write flag and the PDF CRC', async () => {
  const amp = await startAmp({ standby: 1 });
  try {
    const m = loadAmp();
    const on = await m.RunAction(actionTarget(amp), 'power.on', {});
    assert.deepEqual(on, { Success: true, Detail: 'Amplifier taken out of standby' });
    const off = await m.RunAction(actionTarget(amp), 'power.standby', {});
    assert.deepEqual(off, { Success: true, Detail: 'Amplifier put into standby' });
    assert.deepEqual(
      amp.received.map((r) => [r.cmd, [...r.data], r.crc, r.notCmd, r.etx]),
      [
        [14, [1, 0, 0, 0], crcArc([1, 0, 0, 0]), 241, 3],
        [14, [2, 0, 0, 0], crcArc([2, 0, 0, 0]), 241, 3],
      ]
    );
    assert.notEqual(crcArc([1, 0, 0, 0]), 0);
    // The answer port is the action socket's own port, as for the probe.
    for (const r of amp.received) assert.notEqual(r.answerPort, 0);
  } finally {
    await amp.close();
  }
});

test('Mute Output reads the channel count, then sends WRITEOUTMUTE for that channel', async () => {
  const amp = await startAmp({ numChannels: 4 });
  try {
    const m = loadAmp();
    const r = await m.RunAction(actionTarget(amp), 'mute.on', { Channel: '2' });
    assert.deepEqual(r, { Success: true, Detail: 'Channel 2 muted' });
    assert.deepEqual(
      amp.received.map((x) => [x.cmd, [...x.data], x.crc]),
      [
        [1, [], 0],
        [3, [1, 1, 0, 0], crcArc([1, 1, 0, 0])],
      ]
    );
    const check = await runAgainst(amp, { CheckMutes: true });
    assert.match(check.DegradedReason, /Ch 2: muted/);
    const un = await m.RunAction(actionTarget(amp), 'mute.off', { Channel: '2' });
    assert.deepEqual(un, { Success: true, Detail: 'Channel 2 unmuted' });
    const last = amp.received[amp.received.length - 1];
    assert.deepEqual([last.cmd, ...last.data], [3, 1, 0, 0, 0]);
  } finally {
    await amp.close();
  }
});

test('Mute All covers exactly the channels the amplifier reports', async () => {
  const amp = await startAmp({ numChannels: 2 });
  try {
    const r = await loadAmp().RunAction(actionTarget(amp), 'mute.on', { Channel: 'ALL' });
    assert.deepEqual(r, { Success: true, Detail: 'All outputs muted' });
    const writes = amp.received.filter((x) => x.cmd === 3).map((x) => [...x.data]);
    assert.deepEqual(writes.sort(), [
      [0, 1, 0, 0],
      [1, 1, 0, 0],
    ]);
  } finally {
    await amp.close();
  }
});

test('a bad or absent channel is refused with a specific error', async () => {
  const amp = await startAmp({ numChannels: 4 });
  try {
    const m = loadAmp();
    for (const Channel of ['0', '9', 'A', '', '1.5', null]) {
      const r = await m.RunAction(actionTarget(amp), 'mute.on', { Channel });
      assert.deepEqual(r, {
        Success: false,
        Error: 'Choose an output channel from 1 to 8, or All',
      });
    }
    assert.equal(amp.received.length, 0, 'nothing sent for bad input');
    const absent = await m.RunAction(actionTarget(amp), 'mute.on', { Channel: '6' });
    assert.deepEqual(absent, {
      Success: false,
      Error: 'This amplifier has 4 output channels, so there is no channel 6',
    });
    assert.ok(!amp.received.some((x) => x.cmd === 3), 'no write for a channel it lacks');
    const unknown = await m.RunAction(actionTarget(amp), 'preset.load', {});
    assert.match(unknown.Error, /Unknown Powersoft amplifier action/);
  } finally {
    await amp.close();
  }
});

test('an amplifier answering answer_ok = 0 is reported as refusing', async () => {
  const amp = await startAmp({ refuseCmds: [14, 3] });
  try {
    const m = loadAmp();
    const power = await m.RunAction(actionTarget(amp), 'power.standby', {});
    assert.deepEqual(power, {
      Success: false,
      Error: 'The amplifier did not accept the standby command',
    });
    const mute = await m.RunAction(actionTarget(amp), 'mute.on', { Channel: 'all' });
    assert.deepEqual(mute, { Success: false, Error: 'The amplifier did not confirm the mute' });
  } finally {
    await amp.close();
  }
});

test('a lost write is re-sent with the same cookie', async () => {
  const amp = await startAmp({ dropFirst: 1 });
  try {
    const r = await loadAmp().RunAction(actionTarget(amp, { Timeout: 2000 }), 'power.on', {});
    assert.equal(r.Success, true);
    assert.equal(amp.received.length, 1, 'the dropped datagram is not recorded');
  } finally {
    await amp.close();
  }
});

test('an action against a silent amplifier fails inside the budget', async () => {
  const amp = await startAmp({ silentCmds: [14, 1] });
  try {
    const started = Date.now();
    const r = await loadAmp().RunAction(actionTarget(amp, { Timeout: 600 }), 'power.on', {});
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(r, { Success: false, Error: 'No reply within 600ms' });
    const mute = await loadAmp().RunAction(actionTarget(amp, { Timeout: 600 }), 'mute.on', {
      Channel: '1',
    });
    assert.equal(mute.Success, false);
  } finally {
    await amp.close();
  }
  const none = await loadAmp().RunAction({ Settings: {} }, 'power.on', {});
  assert.deepEqual(none, { Success: false, Error: 'No address configured' });
});

test('GetActionOptions offers the reported channels; DescribeAction binds them', () => {
  const m = loadAmp();
  assert.deepEqual(
    m.GetActionOptions({ Success: true, NumChannels: 2 }).Channel.map((o) => o.value),
    ['all', '1', '2']
  );
  assert.deepEqual(m.GetActionOptions({ Success: false }), {});
  assert.equal(m.DescribeAction('mute.on', { Channel: '3' }), 'Mute Output 3');
  assert.equal(m.DescribeAction('mute.off', { Channel: 'all' }), 'Unmute All Outputs');
  assert.equal(m.DescribeAction('mute.on', { Channel: 'x' }), null);
  assert.equal(m.DescribeAction('power.on', {}), null);
});
