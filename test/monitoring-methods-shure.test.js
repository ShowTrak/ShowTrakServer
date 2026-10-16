const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('shure-wireless.js'), {});
}

// A ULXD4D answering GET 0 ALL: channel 1 healthy, channel 2 low battery,
// both padded the way the receiver pads strings.
const ULXD4D_ALL = [
  '< REP MODEL {ULXD4D                          } >',
  '< REP DEVICE_ID {RACK-A  } >',
  '< REP FW_VER {2.7.6.0                 } >',
  '< REP 1 CHAN_NAME {Lead Vox} >',
  '< REP 1 FREQUENCY 578350 >',
  '< REP 1 TX_TYPE ULXD2 >',
  '< REP 1 BATT_BARS 004 >',
  '< REP 1 BATT_CHARGE 080 >',
  '< REP 1 BATT_RUN_TIME 00312 >',
  '< REP 1 BATT_TYPE LION >',
  '< REP 1 AUDIO_MUTE OFF >',
  '< REP 1 RF_INT_DET NONE >',
  '< REP 1 RX_RF_LVL 060 >',
  '< REP 1 RF_ANTENNA AX >',
  '< REP 2 CHAN_NAME {Bass    } >',
  '< REP 2 FREQUENCY 580100 >',
  '< REP 2 TX_TYPE ULXD1 >',
  '< REP 2 BATT_BARS 001 >',
  '< REP 2 BATT_RUN_TIME 00045 >',
  '< REP 2 TX_MUTE_STATUS ON >',
  '< REP 2 AUDIO_MUTE OFF >',
  '< REP 2 RF_INT_DET CRITICAL >',
  '< REP 2 ENCRYPTION_WARNING OFF >',
].join('');

// A fake receiver: replies to `< GET 0 ALL >` with `reply`, optionally split
// into tiny chunks to exercise reassembly. `silent` accepts and never answers.
function startShureServer({
  reply = ULXD4D_ALL,
  chunk = 0,
  silent = false,
  closeAfter = false,
} = {}) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const received = [];
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      let buf = '';
      socket.on('data', (data) => {
        buf += data.toString('latin1');
        if (!buf.includes('>')) return;
        received.push(buf);
        buf = '';
        if (silent) return;
        if (!chunk) {
          socket.write(reply);
          if (closeAfter) socket.end();
          return;
        }
        let i = 0;
        const step = () => {
          if (i >= reply.length) {
            if (closeAfter) socket.end();
            return;
          }
          socket.write(reply.slice(i, i + chunk));
          i += chunk;
          setTimeout(step, 1);
        };
        step();
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

test('shure settings defaults: battery on, everything else opt-in', () => {
  const m = load();
  assert.equal(m.ID, 'shure-wireless');
  const byKey = Object.fromEntries(m.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 2202);
  assert.deepEqual(byKey.Channels.Default, []);
  assert.equal(byKey.Channels.Type, 'list');
  assert.equal(byKey.CheckBattery.Default, true);
  assert.equal(byKey.LowBatteryBars.Default, 1);
  assert.equal(byKey.LowBatteryMinutes.Default, 60);
  assert.equal(byKey.RequireTransmitter.Default, false);
  assert.equal(byKey.CheckMute.Default, false);
  assert.equal(byKey.CheckWarnings.Default, false);
  assert.equal(byKey.Timeout.Advanced, true);
  const opts = m._internal.ParseOptions({ Settings: {} });
  assert.equal(opts.CheckBattery, true);
  assert.equal(opts.RequireTransmitter, false);
});

test('shure happy path: reads both channels and degrades only the low pack', async () => {
  const m = load();
  const server = await startShureServer();
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 3000 } });
    assert.equal(r.Success, true);
    assert.equal(server.received[0], '< GET 0 ALL >');
    assert.equal(r.Model, 'ULXD4D');
    assert.equal(r.Family, 'ULX-D');
    assert.equal(r.DeviceId, 'RACK-A');
    assert.equal(r.Firmware, '2.7.6.0');
    assert.equal(r.Channels.length, 2);
    const [c1, c2] = r.Channels;
    assert.equal(c1.Name, 'Lead Vox');
    assert.equal(c1.FrequencyMHz, 578.35);
    assert.equal(c1.TxPresent, true);
    assert.equal(c1.TxType, 'ULXD2');
    assert.equal(c1.BatteryBars, 4);
    assert.equal(c1.BatteryPercent, 80);
    assert.equal(c1.BatteryMinutes, 312);
    assert.deepEqual(c1.RfLevelsDbm, [-68]);
    assert.equal(c2.Name, 'Bass');
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Ch 2 (Bass): battery 1/5 bars, 45 min left');
    assert.ok(typeof r.LatencyMs === 'number');
  } finally {
    await server.close();
  }
});

test('shure reassembles a reply fragmented into 3-byte chunks', async () => {
  const m = load();
  const server = await startShureServer({ chunk: 3 });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 4000 } });
    assert.equal(r.Success, true);
    assert.equal(r.Channels.length, 2);
    assert.equal(r.Channels[0].Name, 'Lead Vox');
    assert.equal(r.Channels[1].BatteryBars, 1);
  } finally {
    await server.close();
  }
});

test('shure Channels setting limits monitoring and flags a channel the receiver lacks', async () => {
  const m = load();
  const server = await startShureServer();
  try {
    const r = await m.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 3000, Channels: ['1', 4] },
    });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Ch 4: not reported by this receiver');
    assert.deepEqual(r.MissingChannels, [4]);
    assert.equal(r.Channels.find((c) => c.Number === 2).Monitored, false);
  } finally {
    await server.close();
  }
});

test('shure opt-in checks: mute, RF warnings, and battery off', async () => {
  const m = load();
  const server = await startShureServer();
  try {
    const r = await m.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        Timeout: 3000,
        CheckBattery: false,
        CheckMute: true,
        CheckWarnings: true,
      },
    });
    assert.equal(r.DegradedReason, 'Ch 2 (Bass): transmitter muted, RF interference detected');
  } finally {
    await server.close();
  }
});

test('shure require-transmitter only fires when enabled', () => {
  const m = load();
  const snap = m._internal.ParseCapture(
    '< REP 1 CHAN_NAME {Spare} >< REP 1 TX_TYPE UNKN >< REP 1 BATT_BARS 255 >< REP 1 BATT_RUN_TIME 65535 >'
  );
  const device = m._internal.InterpretSnapshot(snap);
  const ch = device.Channels[0];
  assert.equal(ch.TxPresent, false);
  assert.equal(ch.BatteryBars, null, '255 is unknown, not zero');
  assert.equal(ch.BatteryMinutes, null);
  const base = m._internal.ParseOptions({ Settings: {} });
  assert.deepEqual(m._internal.EvaluateShure(device, base).Reasons, []);
  const strict = { ...base, RequireTransmitter: true };
  assert.deepEqual(m._internal.EvaluateShure(device, strict).Reasons, [
    'Ch 1 (Spare): no transmitter',
  ]);
});

test('shure Axient Digital keys: TX_MODEL, per-antenna RSSI, quality, mute mode, slots ignored', () => {
  const m = load();
  const snap = m._internal.ParseCapture(
    [
      '< REP MODEL {AD4Q-A} >',
      '< REP 3 CHAN_NAME {Narrator                       } >',
      '< REP 3 FREQUENCY 0578350 >',
      '< REP 3 TX_MODEL ADX1 >',
      '< REP 3 TX_BATT_BARS 002 >',
      '< REP 3 TX_BATT_CHARGE_PERCENT 041 >',
      '< REP 3 TX_BATT_MINS 65534 >',
      '< REP 3 TX_MUTE_MODE_STATUS MUTE >',
      '< REP 3 INTERFERENCE_STATUS DETECTED >',
      '< REP 3 ENCRYPTION_STATUS ERROR >',
      '< REP 3 UNREGISTERED_TX_STATUS ERROR >',
      '< REP 3 CHAN_QUALITY 004 >',
      '< REP 3 RSSI 1 083 >',
      '< REP 3 RSSI 2 064 >',
      '< REP 3 ANTENNA_STATUS BR >',
      '< REP 3 SLOT_BATT_BARS 1 000 >',
      '< SAMPLE 3 ALL 005 031 102 102 BB 31 086 31 065 >',
    ].join('\r\n')
  );
  const d = m._internal.InterpretSnapshot(snap);
  assert.equal(d.Family, 'Axient Digital');
  const ch = d.Channels[0];
  assert.equal(ch.Number, 3);
  assert.equal(ch.Name, 'Narrator');
  assert.equal(ch.FrequencyMHz, 578.35);
  assert.equal(ch.TxType, 'ADX1');
  assert.equal(ch.BatteryBars, 2, 'slot bars must not overwrite the channel value');
  assert.equal(ch.BatteryPercent, 41);
  assert.equal(ch.BatteryMinutes, null);
  assert.equal(ch.BatteryCalculating, true);
  assert.equal(ch.TxMuted, true);
  assert.equal(ch.SignalQuality, 4);
  assert.deepEqual(ch.RfLevelsDbm, [-37, -56]);
  assert.equal(ch.Antenna, 'BR');
  const opts = {
    ...m._internal.ParseOptions({ Settings: {} }),
    CheckMute: true,
    CheckWarnings: true,
    LowBatteryBars: 2,
  };
  assert.deepEqual(m._internal.EvaluateShure(d, opts).Reasons, [
    'Ch 3 (Narrator): battery 2/5 bars, transmitter muted, RF interference detected, encryption mismatch, unregistered transmitter',
  ]);
});

test('shure SLX-D: family inferred from MODEL, battery minutes threshold', () => {
  const m = load();
  const d = m._internal.InterpretSnapshot(
    m._internal.ParseCapture(
      '< REP MODEL {SLXD4D} >< REP 1 CHAN_NAME {Pastor} >< REP 1 TX_MODEL SLXD2 >< REP 1 TX_BATT_BARS 003 >< REP 1 TX_BATT_MINS 00030 >'
    )
  );
  assert.equal(d.Family, 'SLX-D');
  const reasons = m._internal.EvaluateShure(d, m._internal.ParseOptions({ Settings: {} })).Reasons;
  assert.deepEqual(reasons, ['Ch 1 (Pastor): battery 30 min left']);
  const off = m._internal.EvaluateShure(
    d,
    m._internal.ParseOptions({ Settings: { LowBatteryMinutes: 0 } })
  ).Reasons;
  assert.deepEqual(off, []);
});

test('shure parser: braces may hold > and <, junk and REP ERR are ignored', () => {
  const m = load();
  const { Messages, Rest } = m._internal.SplitMessages(
    'garbage< REP 1 CHAN_NAME {A>B<C} >noise< REP ERR >< REP 2 BATT'
  );
  assert.deepEqual(Messages, ['REP 1 CHAN_NAME {A>B<C}', 'REP ERR']);
  assert.equal(Rest, '< REP 2 BATT');
  assert.equal(m._internal.ParseReport('REP ERR'), null);
  assert.equal(m._internal.ParseReport('SAMPLE 1 ALL XB 096 038'), null);
  assert.equal(m._internal.ParseReport('REP 255'), null);
  const r = m._internal.ParseReport('REP 1 CHAN_NAME {A>B<C}');
  assert.equal(m._internal.Unquote(r.Args[0]), 'A>B<C');
  // An unterminated runaway message is dropped rather than wedging the buffer.
  const runaway = m._internal.SplitMessages('<' + 'x'.repeat(2000));
  assert.deepEqual(runaway.Messages, []);
  assert.equal(runaway.Rest, '');
  assert.equal(m._internal.ShureNumber('255', 5, [255]), null);
  assert.equal(m._internal.ShureNumber('abc', 5), null);
  assert.equal(m._internal.ShureNumber('004', 5), 4);
  assert.deepEqual(m._internal.ParseChannelList('3, 1, x, 3, 0'), [1, 3]);
});

test('shure: a receiver that never goes quiet is cut at the budget and marked Partial', async () => {
  const m = load();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write('< REP 1 CHAN_NAME {Choir} >< REP 1 TX_TYPE ULXD1 >< REP 1 BATT_BARS 005 >');
      const timer = setInterval(() => socket.write('< REP 1 RX_RF_LVL 070 >'), 100);
      socket.on('close', () => clearInterval(timer));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await m.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.address().port, Timeout: 900 },
    });
    assert.equal(r.Success, true);
    assert.equal(r.Partial, true);
    assert.equal(r.Channels[0].Name, 'Choir');
    assert.ok(!r.Degraded);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

test('shure: connected but silent is reached-but-not-a-Shure-receiver', async () => {
  const m = load();
  const server = await startShureServer({ silent: true });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 600 } });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /no Shure reports/);
  } finally {
    await server.close();
  }
});

test('shure: a peer that answers with non-Shure text is not counted as a receiver', async () => {
  const m = load();
  const server = await startShureServer({
    reply: 'HTTP/1.1 400 Bad Request\r\n\r\n',
    closeAfter: true,
  });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 1500 } });
    assert.equal(r.Success, false);
    assert.match(r.Error, /closed/);
  } finally {
    await server.close();
  }
});

test('shure: refused port is offline with Degraded, missing address is offline', async () => {
  const m = load();
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(r.Success, false);
  assert.equal(r.Degraded, true);
  assert.match(r.Error, /ECONNREFUSED/);
  const none = await m.Run({ Settings: {} });
  assert.equal(none.Success, false);
  assert.match(none.Error, /No address/);
});

test('shure: unreachable host times out within the budget', async () => {
  const m = load();
  const started = Date.now();
  // TEST-NET-1 is never routed; either it times out or the OS refuses quickly.
  const r = await m.Run({ Address: '192.0.2.1', Settings: { Port: 2202, Timeout: 700 } });
  assert.equal(r.Success, false);
  assert.ok(Date.now() - started < 3000);
});

test('shure Debug escapes device-supplied names and renders a card per channel', () => {
  const m = load();
  const html = m.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: 'Ch 1 (<script>x</script>): battery 1/5 bars',
      LatencyMs: 12,
      Model: '<b>ULXD4</b>',
      Family: 'ULX-D',
      Channels: [
        {
          Number: 1,
          Name: '<script>alert(1)</script>',
          FrequencyMHz: 578.35,
          TxPresent: true,
          TxType: 'ULXD2',
          TxDeviceId: null,
          BatteryBars: 1,
          BatteryPercent: null,
          BatteryMinutes: 45,
          BatteryCalculating: false,
          BatteryCommWarning: false,
          BatteryType: 'LION',
          TxMuted: null,
          RxMuted: false,
          Interference: false,
          EncryptionError: null,
          UnregisteredTx: null,
          SignalQuality: null,
          RfLevelsDbm: [-60],
          Antenna: 'AX',
          Monitored: true,
          Issues: ['battery 1/5 bars'],
        },
      ],
      MissingChannels: [],
    },
    { Address: '10.0.0.5', Settings: { Port: 2202 } }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>ULXD4'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal((html.match(/monitoring-debug-card/g) || []).length, 1);
  assert.ok(html.includes('0:45 left'));
  const offline = m.Debug(
    { Success: false, Error: 'ECONNREFUSED' },
    { Address: 'x', Settings: {} }
  );
  assert.match(offline, /Offline/);
});

test('shure parser stays linear on a hostile 64 KB buffer of unterminated frames', () => {
  const m = load();
  const hostile = '<{'.repeat(32 * 1024);
  const started = process.hrtime.bigint();
  const { Messages } = m._internal.SplitMessages(hostile);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(Messages, []);
  assert.ok(ms < 200, `split took ${ms.toFixed(1)}ms`);
  // A real frame after the junk is still found once later traffic pushes the
  // junk past the frame bound (until then it is held as a possibly-partial frame).
  const mixed = '<{'.repeat(2000) + '< REP 1 BATT_BARS 003 >' + ' '.repeat(600);
  assert.deepEqual(m._internal.SplitMessages(mixed).Messages, ['REP 1 BATT_BARS 003']);
});
