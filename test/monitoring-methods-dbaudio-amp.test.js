const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('dbaudio-amp.js'), {});
}

// --- OCP.1 encoding helpers for the fake amplifier ------------------------------

function ocaString(text) {
  const bytes = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(Array.from(text).length);
  return Buffer.concat([len, bytes]);
}
const u8 = (v) => Buffer.from([v]);
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
};
// OcaSwitch.GetPosition answers position, min, max.
const switchPos = (v) => Buffer.concat([u16(v), u16(0), u16(1)]);

function message(pduType, pdus) {
  const body = Buffer.concat(pdus);
  const head = Buffer.alloc(10);
  head.writeUInt8(0x3b, 0);
  head.writeUInt16BE(1, 1);
  head.writeUInt32BE(9 + body.length, 3);
  head.writeUInt8(pduType, 7);
  head.writeUInt16BE(pdus.length, 8);
  return Buffer.concat([head, body]);
}

function responsePdu(handle, status, params) {
  const p = params || Buffer.alloc(0);
  const b = Buffer.alloc(10);
  b.writeUInt32BE(10 + p.length, 0);
  b.writeUInt32BE(handle, 4);
  b.writeUInt8(status, 8);
  b.writeUInt8(params ? 1 : 0, 9);
  return Buffer.concat([b, p]);
}

const keepAlive = () => message(4, [u16(1)]);

function ono(channel, obj) {
  return ((1 << 28) | (channel << 15) | obj) >>> 0;
}

// Builds the object map of a healthy amplifier. Keys are `${ONo}:${level}.${index}`.
function ampObjects({
  model = 'D80',
  name = 'Stage Left',
  family = 'dxdy',
  power = 1,
  muted = [false, false, false, false],
  isp = [true, true, true, true],
  gr = [false, false, false, false],
  ovl = [false, false, false, false],
  state = 0x0001,
} = {}) {
  const ids =
    family === '5d'
      ? { PwrOn: 0x101, Isp: 0x401, Gr: 0x402, Ovl: 0x403 }
      : { PwrOn: 0x100, Isp: 0x400, Gr: 0x401, Ovl: 0x402 };
  const map = {
    '1:3.6': Buffer.concat([ocaString('d&b audiotechnik'), ocaString(model), ocaString('2.10.4')]),
    '1:3.4': ocaString(name),
    '1:3.3': ocaString('SN-12345'),
    '1:3.13': state == null ? { status: 8 } : u16(state),
    [`${ono(0, ids.PwrOn)}:4.1`]: switchPos(power),
    // OcaSwitch.SetPosition: accepted, no return values.
    [`${ono(0, ids.PwrOn)}:4.2`]: { status: 0 },
  };
  for (let ch = 1; ch <= 4; ch++) {
    map[`${ono(ch, 0x205)}:4.1`] = u8(muted[ch - 1] ? 1 : 2);
    map[`${ono(ch, 0x205)}:4.2`] = { status: 0 };
    map[`${ono(ch, ids.Isp)}:5.1`] = u8(isp[ch - 1] ? 1 : 0);
    map[`${ono(ch, ids.Gr)}:5.1`] = u8(gr[ch - 1] ? 1 : 0);
    map[`${ono(ch, ids.Ovl)}:5.1`] = u8(ovl[ch - 1] ? 1 : 0);
  }
  return map;
}

// A fake d&b amplifier speaking OCP.1. Unknown objects answer BadONo (5).
//
// Options:
//   objects     key -> Buffer params, or { status } for a non-OK reply,
//               or { silent: true } to never answer
//   fragment    write replies one byte at a time
//   batch       answer every command of a received chunk in ONE message
//   chatter     send a keep-alive and a notification-type message on connect
//   raw         send this instead of speaking OCP.1
//   delayAmpMs  delay replies to amplifier objects (not the Device Manager)
function startAmp(options = {}) {
  const {
    objects = ampObjects(),
    fragment = false,
    batch = false,
    chatter = false,
    raw = null,
    delayAmpMs = 0,
  } = options;
  const received = [];
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const write = (buf) => {
        if (socket.destroyed) return;
        if (!fragment) return socket.write(buf);
        for (const byte of buf) socket.write(Buffer.from([byte]));
      };
      if (raw != null) {
        socket.write(raw);
        return;
      }
      if (chatter) {
        write(keepAlive());
        write(message(2, [Buffer.from([0, 0, 0, 4, 0, 0, 0, 0])]));
      }
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const replies = [];
        while (buf.length >= 10) {
          const size = buf.readUInt32BE(3) + 1;
          if (buf.length < size) break;
          const msg = buf.subarray(0, size);
          buf = buf.subarray(size);
          const count = msg.readUInt16BE(8);
          let pos = 10;
          for (let i = 0; i < count; i++) {
            const pduSize = msg.readUInt32BE(pos);
            const handle = msg.readUInt32BE(pos + 4);
            const target = msg.readUInt32BE(pos + 8);
            const level = msg.readUInt16BE(pos + 12);
            const index = msg.readUInt16BE(pos + 14);
            const paramCount = msg.readUInt8(pos + 16);
            const params = Buffer.from(msg.subarray(pos + 17, pos + pduSize));
            pos += pduSize;
            const key = `${target}:${level}.${index}`;
            received.push({
              type: msg.readUInt8(7),
              version: msg.readUInt16BE(1),
              key,
              paramCount,
              params,
              raw: count === 1 ? Buffer.from(msg) : null,
            });
            const entry = objects[key];
            if (entry && entry.silent) continue;
            const pdu = Buffer.isBuffer(entry)
              ? responsePdu(handle, 0, entry)
              : responsePdu(handle, entry ? entry.status : 5, null);
            replies.push({ pdu, amp: target !== 1 });
          }
        }
        const send = (list) => {
          if (!list.length) return;
          if (batch)
            write(
              message(
                3,
                list.map((r) => r.pdu)
              )
            );
          else for (const r of list) write(message(3, [r.pdu]));
        };
        send(replies.filter((r) => !r.amp || !delayAmpMs));
        if (delayAmpMs) {
          const later = replies.filter((r) => r.amp);
          setTimeout(() => send(later), delayAmpMs);
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

async function runWith(amp, settings = {}) {
  const m = load();
  return m.Run({
    Address: '127.0.0.1',
    Settings: { Port: amp.port, Timeout: 2000, ...settings },
  });
}

// --- Pure helpers ------------------------------------------------------------------

test('object numbers follow the NanoOcp layout', () => {
  const { _internal } = load();
  assert.equal(_internal.AmpONo(0, 0x100), 0x10000100);
  assert.equal(_internal.AmpONo(1, 0x205), 0x10008205);
  assert.equal(_internal.AmpONo(4, 0x402), 0x10020402);
});

test('model detection picks the 5D layout only for a 5D', () => {
  const { _internal } = load();
  assert.equal(_internal.DetectFamily('5D'), '5d');
  assert.equal(_internal.DetectFamily('d&b 5D'), '5d');
  assert.equal(_internal.DetectFamily('D80'), 'dxdy');
  assert.equal(_internal.DetectFamily('D40'), 'dxdy');
  assert.equal(_internal.DetectFamily('15D'), 'dxdy');
  assert.equal(_internal.DetectFamily(null), 'dxdy');
  assert.equal(_internal.FamilyFor('5d', 'D80'), '5d');
  assert.equal(_internal.FamilyFor('dx', '5D'), 'dxdy');
});

test('ports follow the model unless one is set', () => {
  const { _internal } = load();
  const ports = (s) => _internal.PortsFor(_internal.ParseConfig({ Address: 'x', Settings: s }));
  assert.deepEqual(ports({}), [30013, 50014]);
  assert.deepEqual(ports({ Model: 'dx' }), [30013]);
  assert.deepEqual(ports({ Model: 'dy' }), [50014]);
  assert.deepEqual(ports({ Model: '5d' }), [50014]);
  assert.deepEqual(ports({ Model: 'dx', Port: 1234 }), [1234]);
  assert.deepEqual(ports({ Model: 'bogus' }), [30013, 50014]);
});

test('channel list accepts letters and falls back to all four', () => {
  const { _internal } = load();
  assert.deepEqual(_internal.ParseChannels(['b', ' A ', 'x', 'B']), [1, 2]);
  assert.deepEqual(_internal.ParseChannels([]), [1, 2, 3, 4]);
  assert.deepEqual(_internal.ParseChannels(undefined), [1, 2, 3, 4]);
});

// --- Probes against the fake amplifier ---------------------------------------------

test('healthy D80 reads model, power and channels', async () => {
  const amp = await startAmp();
  try {
    const r = await runWith(amp);
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.Model, 'D80');
    assert.equal(r.Manufacturer, 'd&b audiotechnik');
    assert.equal(r.FirmwareVersion, '2.10.4');
    assert.equal(r.DeviceName, 'Stage Left');
    assert.equal(r.SerialNumber, 'SN-12345');
    assert.deepEqual(r.DeviceStateFlags, ['Operational']);
    assert.equal(r.PowerOn, true);
    assert.equal(r.Family, 'dxdy');
    assert.equal(r.Port, amp.port);
    assert.equal(r.Channels.length, 4);
    assert.deepEqual(
      r.Channels.map((c) => [c.Channel, c.Muted, c.SignalPresent, c.Overload]),
      [
        ['A', false, true, false],
        ['B', false, true, false],
        ['C', false, true, false],
        ['D', false, true, false],
      ]
    );
    assert.ok(typeof r.LatencyMs === 'number');
    // Only reads went out, as CommandResponseRequired, protocol version 1.
    assert.ok(amp.received.every((c) => c.type === 1 && c.version === 1));
    const methods = new Set(amp.received.map((c) => c.key.split(':')[1]));
    for (const m of methods) assert.ok(['3.6', '3.4', '3.3', '3.13', '4.1', '5.1'].includes(m), m);
    assert.ok(amp.received.some((c) => c.key === `${0x10000100}:4.1`));
  } finally {
    await amp.close();
  }
});

test('a 5D is detected and read with its own object numbers', async () => {
  const amp = await startAmp({ objects: ampObjects({ model: '5D', family: '5d' }) });
  try {
    const r = await runWith(amp);
    assert.equal(r.Family, '5d');
    assert.equal(r.PowerOn, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.ok(amp.received.some((c) => c.key === `${0x10000101}:4.1`));
  } finally {
    await amp.close();
  }
});

test('the model setting overrides detection', async () => {
  // A 5D layout named like a D80: only the explicit 5D setting reads it right.
  const amp = await startAmp({ objects: ampObjects({ model: 'D80', family: '5d' }) });
  try {
    const wrong = await runWith(amp);
    assert.equal(wrong.Degraded, true);
    assert.match(
      wrong.DegradedReason,
      /Power state not readable \(object not found on this amplifier; check the amplifier model setting\)/
    );
    const right = await runWith(amp, { Model: '5d' });
    assert.equal(right.Degraded, undefined, right.DegradedReason);
  } finally {
    await amp.close();
  }
});

test('standby is degraded and suppresses the signal check', async () => {
  const amp = await startAmp({
    objects: ampObjects({ power: 0, isp: [false, false, false, false] }),
  });
  try {
    const r = await runWith(amp, { RequireSignal: true });
    assert.equal(r.Success, true);
    assert.equal(r.PowerOn, false);
    assert.equal(r.DegradedReason, 'Amplifier is in standby');
    const off = await runWith(amp, { RequirePowerOn: false, RequireSignal: true });
    assert.equal(off.Degraded, undefined);
  } finally {
    await amp.close();
  }
});

test('overload is degraded by default and respects the channel list', async () => {
  const amp = await startAmp({ objects: ampObjects({ ovl: [false, true, false, true] }) });
  try {
    const r = await runWith(amp);
    assert.equal(r.DegradedReason, 'Overload on channels B, D');
    const onlyA = await runWith(amp, { Channels: ['A', 'C'] });
    assert.equal(onlyA.Degraded, undefined);
    const disabled = await runWith(amp, { CheckOverload: false });
    assert.equal(disabled.Degraded, undefined);
  } finally {
    await amp.close();
  }
});

test('mute, limiting and signal checks are opt-in', async () => {
  const amp = await startAmp({
    objects: ampObjects({
      muted: [true, false, false, false],
      gr: [false, false, true, false],
      isp: [true, true, true, false],
    }),
  });
  try {
    const quiet = await runWith(amp);
    assert.equal(quiet.Degraded, undefined);
    const r = await runWith(amp, {
      CheckMute: true,
      CheckGainReduction: true,
      RequireSignal: true,
    });
    assert.equal(
      r.DegradedReason,
      'Muted: channel A; Limiting on channel C; No input signal on channel D'
    );
  } finally {
    await amp.close();
  }
});

test('device state flags degrade; an unimplemented GetState does not', async () => {
  const bad = await startAmp({ objects: ampObjects({ state: 0x0004 | 0x0010 }) });
  try {
    const r = await runWith(bad);
    assert.equal(r.DegradedReason, 'Amplifier reports an error; Amplifier is updating firmware');
    const off = await runWith(bad, { CheckDeviceState: false });
    assert.equal(off.Degraded, undefined);
  } finally {
    await bad.close();
  }
  const none = await startAmp({ objects: ampObjects({ state: null }) });
  try {
    const r = await runWith(none);
    assert.equal(r.Degraded, undefined);
    assert.equal(r.DeviceState, null);
    assert.equal(r.DeviceStateFlags, null);
  } finally {
    await none.close();
  }
});

test('device name check, with a multi-byte UTF-8 name', async () => {
  const amp = await startAmp({ objects: ampObjects({ name: 'Bühne Links 🎛' }) });
  try {
    const r = await runWith(amp, { CheckName: true, ExpectedName: 'bühne links 🎛' });
    assert.equal(r.DeviceName, 'Bühne Links 🎛');
    assert.equal(r.Degraded, undefined);
    const wrong = await runWith(amp, { CheckName: true, ExpectedName: 'Stage Right' });
    assert.equal(wrong.DegradedReason, 'Device name "Bühne Links 🎛" (expected "Stage Right")');
  } finally {
    await amp.close();
  }
});

test('unreadable channel objects are reported for enabled checks only', async () => {
  const objects = ampObjects();
  delete objects[`${ono(3, 0x402)}:5.1`];
  const amp = await startAmp({ objects });
  try {
    const r = await runWith(amp);
    assert.equal(
      r.DegradedReason,
      'Overload not readable on channel C (object not found on this amplifier)'
    );
    assert.deepEqual(r.Channels[2].Errors, ['Overload: object not found on this amplifier']);
    const off = await runWith(amp, { CheckOverload: false });
    assert.equal(off.Degraded, undefined);
  } finally {
    await amp.close();
  }
});

test('fragmented replies, batched responses and unsolicited messages', async () => {
  for (const opts of [{ fragment: true }, { batch: true, chatter: true }]) {
    const amp = await startAmp(opts);
    try {
      const r = await runWith(amp);
      assert.equal(r.Success, true);
      assert.equal(r.Degraded, undefined, JSON.stringify(opts) + ' ' + r.DegradedReason);
      assert.equal(r.Model, 'D80');
      assert.equal(r.Channels.length, 4);
    } finally {
      await amp.close();
    }
  }
});

test('a non-AES70 answer is reachable but degraded', async () => {
  const amp = await startAmp({ raw: 'HTTP/1.1 400 Bad Request\r\n\r\n' });
  try {
    const r = await runWith(amp);
    assert.equal(r.Success, true);
    assert.equal(r.IsAes70, false);
    assert.equal(r.DegradedReason, 'Responded, but not as an AES70 (OCA) device');
  } finally {
    await amp.close();
  }
});

test('a bogus message size is treated as not AES70', async () => {
  const junk = Buffer.from([0x3b, 0, 1, 0xff, 0xff, 0xff, 0xff, 3, 0, 1]);
  const amp = await startAmp({ raw: junk });
  try {
    const r = await runWith(amp);
    assert.equal(r.IsAes70, false);
  } finally {
    await amp.close();
  }
});

test('refused connection is offline with the degraded flag', async () => {
  const amp = await startAmp();
  const port = amp.port;
  await amp.close();
  const m = load();
  const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(r.Success, false);
  assert.equal(r.Degraded, true);
  assert.match(r.Error, /ECONNREFUSED/);
});

test('silent device times out inside the budget', async () => {
  const amp = await startAmp({ raw: '' });
  try {
    const started = Date.now();
    const r = await runWith(amp, { Timeout: 600 });
    const elapsed = Date.now() - started;
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply after 600ms/);
    assert.ok(elapsed < 1100, `took ${elapsed}ms`);
  } finally {
    await amp.close();
  }
});

test('the timeout is a budget for the whole probe', async () => {
  // The manager answers at once, the amplifier objects only after the budget.
  const amp = await startAmp({ delayAmpMs: 900 });
  try {
    const started = Date.now();
    const r = await runWith(amp, { Timeout: 600 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed}ms`);
    assert.equal(r.Success, true);
    assert.equal(r.Model, 'D80');
    assert.equal(r.DegradedReason, 'The amplifier did not answer every read in time');
  } finally {
    await amp.close();
  }
});

test('a missing address fails without connecting', async () => {
  const m = load();
  const r = await m.Run({ Address: '', Settings: {} });
  assert.deepEqual(r, { Success: false, Error: 'No address configured' });
});

// --- Debug renderer ------------------------------------------------------------------

test('Debug renders offline, not-AES70 and healthy panels, escaping device text', async () => {
  const m = load();
  const target = { Address: '10.0.0.5', Settings: { Port: 30013 } };
  const offline = m.Debug({ Success: false, Error: 'connect ECONNREFUSED' }, target);
  assert.match(offline, /Offline/);
  assert.match(offline, /ECONNREFUSED/);
  assert.match(offline, /TCP 30013/);

  const notOca = m.Debug({ Success: true, Degraded: true, IsAes70: false, LatencyMs: 3 }, target);
  assert.match(notOca, /not as an AES70/);

  const amp = await startAmp({
    objects: ampObjects({
      name: '<img src=x onerror=alert(1)>',
      muted: [false, true, false, false],
    }),
  });
  try {
    const t = { Address: '127.0.0.1', Settings: { Port: amp.port, CheckMute: true } };
    const r = await m.Run(t);
    const html = m.Debug(r, t);
    assert.ok(!html.includes('<img'), 'device name must be escaped');
    assert.match(html, /&lt;img/);
    assert.match(html, /D80/);
    assert.match(html, /Channel A/);
    assert.match(html, /Channel D/);
    assert.match(html, /Muted/);
    assert.match(html, /Signal yes · Limiting no · Overload no/);
    assert.match(html, /Operational/);
    assert.match(html, />On</);
  } finally {
    await amp.close();
  }
});

test('Debug shows standby and unknown power', () => {
  const m = load();
  const target = { Address: '10.0.0.5', Settings: {} };
  const base = { Success: true, IsAes70: true, LatencyMs: 2, Channels: [] };
  assert.match(m.Debug({ ...base, PowerOn: false }, target), /Standby/);
  assert.match(
    m.Debug({ ...base, PowerOn: null, PowerError: 'BadONo' }, target),
    /Unknown \(BadONo\)/
  );
  // Auto port shows both candidates while offline.
  assert.match(m.Debug({ Success: false, Error: 'x' }, target), /30013 or 50014/);
});

// --- Actions -------------------------------------------------------------------------

function actionTarget(amp, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: amp.port, Timeout: 2000, ...settings } };
}

// Only the commands that carry parameters (the Sets), as [key, params hex].
function setsOf(amp) {
  return amp.received.filter((r) => r.paramCount > 0).map((r) => [r.key, r.params.toString('hex')]);
}

test('actions are declared with the agreed IDs, params and confirmation flags', () => {
  const m = load();
  const byId = Object.fromEntries(m.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['power.on', 'power.standby', 'mute.on', 'mute.off']);
  assert.ok(!byId['power.on'].Destructive);
  assert.equal(byId['power.standby'].Destructive, true);
  assert.equal(byId['mute.on'].Destructive, true);
  assert.ok(!byId['mute.off'].Destructive);
  for (const a of m.Actions) assert.ok(!a.AllowedWhileOffline, a.ID);
  assert.equal(byId['mute.on'].Params[0].Key, 'Channel');
  assert.deepEqual(
    byId['mute.on'].Params[0].Options.map((o) => o.value),
    ['all', 'A', 'B', 'C', 'D']
  );
  assert.equal(typeof m.RunAction, 'function');
  assert.equal(m.InvalidateCaches, undefined, 'nothing is cached');
});

test('Power On sends OcaSwitch.SetPosition(1) to Settings_PwrOn, byte for byte', async () => {
  const amp = await startAmp();
  try {
    const r = await load().RunAction(actionTarget(amp, { Model: 'dx' }), 'power.on', {});
    assert.deepEqual(r, { Success: true, Detail: 'Amplifier powered on' });
    // An explicit model needs no read first: the Set is the only command sent.
    assert.equal(amp.received.length, 1);
    const expected = Buffer.from(
      '3b' + // sync
        '0001' + // protocol version 1
        '0000001c' + // message size: 9-byte header + 19-byte PDU
        '01' + // CommandResponseRequired
        '0001' + // one PDU
        '00000013' + // command size 17 + 2
        '00000001' + // handle
        '10000100' + // ONo: type 1, channel 0, Settings_PwrOn 0x100
        '0004' + // def level (OcaSwitch)
        '0002' + // SetPosition
        '01' + // one parameter
        '0001', // position 1 = on
      'hex'
    );
    assert.deepEqual(amp.received[0].raw, expected);
  } finally {
    await amp.close();
  }
});

test('Standby sends position 0; a 5D found by auto-detection uses its own power object', async () => {
  const amp = await startAmp({ objects: ampObjects({ model: '5D', family: '5d' }) });
  try {
    const r = await load().RunAction(actionTarget(amp), 'power.standby', {});
    assert.deepEqual(r, { Success: true, Detail: 'Amplifier put into standby' });
    // Model read first (auto), then the Set on the 5D's PwrOn 0x101.
    assert.deepEqual(
      amp.received.map((x) => x.key),
      ['1:3.6', `${ono(0, 0x101)}:4.2`]
    );
    assert.deepEqual(setsOf(amp), [[`${ono(0, 0x101)}:4.2`, '0000']]);
  } finally {
    await amp.close();
  }
});

test('Mute Channel sets OcaMute state 1 on that channel; Unmute sends 2', async () => {
  const amp = await startAmp();
  try {
    const m = load();
    const muted = await m.RunAction(actionTarget(amp), 'mute.on', { Channel: 'b' });
    assert.deepEqual(muted, { Success: true, Detail: 'Channel B muted' });
    const unmuted = await m.RunAction(actionTarget(amp), 'mute.off', { Channel: '3' });
    assert.deepEqual(unmuted, { Success: true, Detail: 'Channel C unmuted' });
    assert.deepEqual(setsOf(amp), [
      [`${ono(2, 0x205)}:4.2`, '01'],
      [`${ono(3, 0x205)}:4.2`, '02'],
    ]);
  } finally {
    await amp.close();
  }
});

test('Mute All sets every channel', async () => {
  const amp = await startAmp();
  try {
    const r = await load().RunAction(actionTarget(amp), 'mute.on', { Channel: 'all' });
    assert.deepEqual(r, { Success: true, Detail: 'All channels muted' });
    assert.deepEqual(
      setsOf(amp).sort(),
      [1, 2, 3, 4].map((ch) => [`${ono(ch, 0x205)}:4.2`, '01']).sort()
    );
  } finally {
    await amp.close();
  }
});

test('a bad channel is refused before anything is sent', async () => {
  const amp = await startAmp();
  try {
    const m = load();
    for (const Channel of ['E', '5', '', 'A,B', null]) {
      const r = await m.RunAction(actionTarget(amp), 'mute.on', { Channel });
      assert.deepEqual(r, { Success: false, Error: 'Choose a channel: A, B, C, D or All' });
    }
    const unknown = await m.RunAction(actionTarget(amp), 'preset.recall', {});
    assert.equal(unknown.Success, false);
    assert.match(unknown.Error, /Unknown d&b amplifier action/);
    assert.equal(amp.received.length, 0);
  } finally {
    await amp.close();
  }
});

test('a refused Set is reported with the amplifier’s reason', async () => {
  const objects = ampObjects();
  objects[`${ono(0, 0x100)}:4.2`] = { status: 3 }; // Locked
  objects[`${ono(4, 0x205)}:4.2`] = { status: 15 }; // PermissionDenied
  const amp = await startAmp({ objects });
  try {
    const m = load();
    const power = await m.RunAction(actionTarget(amp, { Model: 'dx' }), 'power.standby', {});
    assert.deepEqual(power, { Success: false, Error: 'The amplifier refused: Locked' });
    const all = await m.RunAction(actionTarget(amp), 'mute.on', { Channel: 'all' });
    assert.deepEqual(all, {
      Success: false,
      Error: 'Channels A, B, C muted, but the amplifier refused channel D: PermissionDenied',
    });
  } finally {
    await amp.close();
  }
});

test('power on a mis-detected layout points at the model setting', async () => {
  // A 5D layout reporting a D80 name: auto picks the D80 power object.
  const amp = await startAmp({ objects: ampObjects({ model: 'D80', family: '5d' }) });
  try {
    const r = await load().RunAction(actionTarget(amp), 'power.on', {});
    assert.deepEqual(r, {
      Success: false,
      Error:
        'The amplifier refused: object not found on this amplifier; check the amplifier model setting',
    });
  } finally {
    await amp.close();
  }
});

test('an action against a silent or absent amplifier fails inside the budget', async () => {
  const objects = ampObjects();
  objects[`${ono(1, 0x205)}:4.2`] = { silent: true };
  const amp = await startAmp({ objects });
  try {
    const m = load();
    const started = Date.now();
    const r = await m.RunAction(actionTarget(amp, { Timeout: 600 }), 'mute.off', { Channel: 'A' });
    assert.ok(Date.now() - started < 1500);
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply after/);
  } finally {
    await amp.close();
  }
  const port = amp.port; // closed now: refused
  const refused = await load().RunAction(
    { Address: '127.0.0.1', Settings: { Port: port, Timeout: 600 } },
    'power.on',
    {}
  );
  assert.equal(refused.Success, false);
  assert.match(refused.Error, /ECONNREFUSED/);
  const none = await load().RunAction({ Settings: {} }, 'power.on', {});
  assert.deepEqual(none, { Success: false, Error: 'No address configured' });
});

test('DescribeAction binds the channel into favourite labels', () => {
  const m = load();
  assert.equal(m.DescribeAction('mute.on', { Channel: 'c' }), 'Mute Channel C');
  assert.equal(m.DescribeAction('mute.off', { Channel: 'all' }), 'Unmute All Channels');
  assert.equal(m.DescribeAction('mute.on', { Channel: 'Z' }), null);
  assert.equal(m.DescribeAction('power.on', {}), null);
});

test('the probe never sends a parameter (read-only)', async () => {
  const amp = await startAmp();
  try {
    await runWith(amp, { CheckMute: true, CheckGainReduction: true, RequireSignal: true });
    assert.ok(amp.received.length > 10);
    for (const r of amp.received) {
      assert.equal(r.paramCount, 0, r.key);
      assert.match(r.key, /:\d+\.1$|:3\.\d+$/, r.key);
    }
  } finally {
    await amp.close();
  }
});
