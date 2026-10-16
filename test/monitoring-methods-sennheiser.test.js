const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('sennheiser-wireless.js'), {});
}

// Answer an SSC read the way the spec describes: fill every null leaf from the
// fixture; addresses the fixture lacks come back as an osc error (404). A
// message with no known address at all is answered with the error alone.
function answer(query, fixture) {
  const errors = [];
  const fill = (q, f, trail) => {
    const out = {};
    let any = false;
    for (const [k, v] of Object.entries(q)) {
      const has = f != null && typeof f === 'object' && !Array.isArray(f) && k in f;
      if (!has) {
        errors.push(trail.concat(k).join('/'));
        continue;
      }
      if (v === null) {
        out[k] = f[k];
        any = true;
      } else {
        const sub = fill(v, f[k], trail.concat(k));
        if (sub) {
          out[k] = sub;
          any = true;
        }
      }
    }
    return any ? out : null;
  };
  const filled = fill(query, fixture, []) || {};
  if (errors.length)
    filled.osc = { error: errors.map((e) => ({ [e]: [404, { desc: 'address not found' }] })) };
  return filled;
}

// A fake SSC receiver on 127.0.0.1. `dropFirst` ignores the first copy of every
// distinct message (simulated UDP loss); `raw` replies with that text instead.
function startSscServer({ fixture, dropFirst = false, raw = null, silent = false } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const seen = new Set();
    const received = [];
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      received.push(text);
      if (silent) return;
      if (dropFirst && !seen.has(text)) {
        seen.add(text);
        return;
      }
      const reply = raw != null ? raw : JSON.stringify(answer(JSON.parse(text), fixture));
      sock.send(reply, rinfo.port, rinfo.address);
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

const EM6000 = {
  device: { identity: { product: 'EM6000', version: '1.1.4.74' }, name: 'D6000-RACK' },
  rx1: {
    name: 'LEAD VOX',
    carrier: 578350,
    audio_mute: false,
    active_warnings: [],
    skx: { type: ['SK 6000', '470 MHz', '558 MHz'], name: 'LEADVOX', battery: ['70%', '5:12'] },
  },
  rx2: {
    name: 'SPARE',
    carrier: 600000,
    audio_mute: false,
    active_warnings: ['NoLink'],
    skx: { type: '', name: '', battery: [] },
  },
  mm: [
    [180, 0, 170, 0, 1, 0, 230, 128, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ],
};

function ewdxFixture(product = 'EW-DX EM 4 Dante', channels = 4) {
  const f = {
    device: { identity: { product, version: '3.2.0' }, name: 'EWDX-SL' },
    mates: {},
    m: {},
  };
  const names = ['HOST', 'GUEST', 'SPARE', 'BAND'];
  for (let n = 1; n <= channels; n++) {
    f[`rx${n}`] = { name: names[n - 1], frequency: 520000 + n * 1000, mute: n === 4, warnings: [] };
    f.mates[`tx${n}`] = {
      type: 'SK',
      name: names[n - 1],
      mute: n === 4,
      battery: { gauge: n === 2 ? 20 : 90, type: 'Battery', lifetime: n === 2 ? 45 : 400 },
    };
    f.m[`rx${n}`] = { rsqi: n === 3 ? 0 : 88, divi: 1 };
  }
  if (channels >= 4) f.rx4.warnings = ['Aes256Error', 'AfPeak'];
  return f;
}

test('sennheiser settings defaults: battery on, everything else opt-in', () => {
  const m = load();
  assert.equal(m.ID, 'sennheiser-wireless');
  const byKey = Object.fromEntries(m.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 45);
  assert.deepEqual(byKey.Channels.Default, []);
  assert.equal(byKey.CheckBattery.Default, true);
  assert.equal(byKey.LowBatteryPercent.Default, 25);
  assert.equal(byKey.LowBatteryMinutes.Default, 60);
  assert.equal(byKey.RequireTransmitter.Default, false);
  assert.equal(byKey.CheckMute.Default, false);
  assert.equal(byKey.CheckWarnings.Default, false);
  assert.equal(byKey.Timeout.Advanced, true);
});

test('sennheiser Digital 6000: reads both channels, healthy by default', async () => {
  const m = load();
  const server = await startSscServer({ fixture: EM6000 });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.Model, 'EM6000');
    assert.equal(r.Family, 'Digital 6000');
    assert.equal(r.DeviceId, 'D6000-RACK');
    assert.equal(r.Firmware, '1.1.4.74');
    assert.equal(r.Partial, false);
    const [c1, c2] = r.Channels;
    assert.equal(c1.Name, 'LEAD VOX');
    assert.equal(c1.FrequencyMHz, 578.35);
    assert.equal(c1.TxPresent, true);
    assert.equal(c1.TxType, 'SK 6000');
    assert.equal(c1.BatteryPercent, 70);
    assert.equal(c1.BatteryMinutes, 312);
    assert.deepEqual(c1.RfLevelsDbm, [-37.5, -42.5]);
    assert.equal(c1.LinkQuality, 90);
    assert.equal(c1.ActiveAntenna, 'A');
    assert.equal(c2.TxPresent, false);
    // Only Digital 6000 queries are sent once the product is known.
    assert.ok(!server.received.some((t) => t.includes('mates')));
  } finally {
    await server.close();
  }
});

test('sennheiser Digital 6000: low battery and require-transmitter reasons', async () => {
  const m = load();
  const fixture = JSON.parse(JSON.stringify(EM6000));
  fixture.rx1.skx.battery = ['low', '0:25'];
  const server = await startSscServer({ fixture });
  try {
    const r = await m.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, RequireTransmitter: true },
    });
    assert.equal(r.Degraded, true);
    assert.equal(
      r.DegradedReason,
      'Ch 1 (LEAD VOX): battery low, 25 min left; Ch 2 (SPARE): no transmitter'
    );
  } finally {
    await server.close();
  }
});

test('sennheiser EW-DX EM 4: four channels, percent + runtime thresholds, no-link spare ignored', async () => {
  const m = load();
  const server = await startSscServer({ fixture: ewdxFixture() });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } });
    assert.equal(r.Success, true);
    assert.equal(r.Family, 'EW-DX');
    assert.equal(r.Channels.length, 4);
    const ch2 = r.Channels[1];
    assert.equal(ch2.BatteryPercent, 20);
    assert.equal(ch2.BatteryMinutes, 45);
    assert.equal(ch2.LinkQuality, 88);
    assert.equal(r.Channels[2].TxPresent, false, 'RSQI 0 is no link');
    assert.equal(r.DegradedReason, 'Ch 2 (GUEST): battery 20%, 45 min left');
  } finally {
    await server.close();
  }
});

test('sennheiser EW-DX opt-ins: mute and warnings (audio peak ignored), channel filter', async () => {
  const m = load();
  const server = await startSscServer({ fixture: ewdxFixture() });
  try {
    const r = await m.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: server.port,
        Timeout: 2000,
        Channels: [3, 4],
        CheckMute: true,
        CheckWarnings: true,
        RequireTransmitter: true,
      },
    });
    assert.equal(
      r.DegradedReason,
      'Ch 3 (SPARE): no transmitter; Ch 4 (BAND): transmitter muted, receiver output muted, encryption mismatch'
    );
    assert.equal(r.Channels[1].Monitored, false);
  } finally {
    await server.close();
  }
});

test('sennheiser EW-DX EM 2: only the channels that exist, a configured missing one is a reason', async () => {
  const m = load();
  const server = await startSscServer({ fixture: ewdxFixture('EW-DX EM 2', 2) });
  try {
    const r = await m.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2500, Channels: '1, 3', CheckBattery: false },
    });
    assert.equal(r.Channels.length, 2);
    assert.deepEqual(r.MissingChannels, [3]);
    assert.equal(r.DegradedReason, 'Ch 3: not reported by this receiver');
  } finally {
    await server.close();
  }
});

test('sennheiser re-sends queries lost on the wire', async () => {
  const m = load();
  const server = await startSscServer({ fixture: EM6000, dropFirst: true });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 3000 } });
    assert.equal(r.Success, true);
    assert.equal(r.Channels.length, 2);
    assert.equal(r.Channels[0].BatteryPercent, 70);
  } finally {
    await server.close();
  }
});

test('sennheiser: a non-SSC responder is reached but degraded', async () => {
  const m = load();
  const server = await startSscServer({ raw: 'hello, I am not JSON' });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 1500 } });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /not with Sennheiser SSC/);
  } finally {
    await server.close();
  }
});

test('sennheiser: JSON that holds no receiver channels is degraded', async () => {
  const m = load();
  const server = await startSscServer({
    fixture: { device: { identity: { product: 'CHG 70N' } } },
  });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2500 } });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /no receiver channels/);
  } finally {
    await server.close();
  }
});

test('sennheiser: silence is offline within the budget', async () => {
  const m = load();
  const server = await startSscServer({ silent: true });
  try {
    const started = Date.now();
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 700 } });
    assert.equal(r.Success, false);
    assert.match(r.Error, /No SSC reply/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await server.close();
  }
});

test('sennheiser: closed port and unresolvable host are offline', async () => {
  const m = load();
  const probe = dgram.createSocket('udp4');
  await new Promise((r) => probe.bind(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 700 } });
  assert.equal(r.Success, false);
  // Platforms differ on whether loopback ICMP reaches a connected UDP socket:
  // either the refusal surfaces (Degraded) or the budget expires.
  if (r.Degraded) assert.match(r.Error, /ECONNREFUSED/);
  else assert.match(r.Error, /No SSC reply/);
  const bad = await m.Run({ Address: 'no-such-host.invalid', Settings: { Timeout: 700 } });
  assert.equal(bad.Success, false);
  const none = await m.Run({ Settings: {} });
  assert.match(none.Error, /No address/);
});

test('sennheiser pure helpers: profile detection, merge, clock parse, unknown product inference', () => {
  const m = load();
  const {
    DetectProfile,
    MergeReply,
    ParseClockMinutes,
    InterpretState,
    ParseDatagram,
    QueriesFor,
  } = m._internal;
  assert.equal(DetectProfile('EM6000-Dante'), 'Digital 6000');
  assert.equal(DetectProfile('EW-DX EM 2'), 'EW-DX');
  assert.equal(DetectProfile('SpeechLine'), null);
  assert.equal(DetectProfile(null), null);
  assert.ok(QueriesFor(null).length > QueriesFor('EW-DX').length);
  assert.equal(ParseClockMinutes('5:12'), 312);
  assert.equal(ParseClockMinutes('-:--'), null);
  assert.equal(ParseDatagram('not json'), null);
  assert.equal(ParseDatagram('[1,2]'), null);

  const state = {};
  MergeReply(state, { rx1: { name: 'A' }, osc: { error: [] } });
  MergeReply(state, { rx1: { carrier: 470100 }, __proto__: { polluted: true } });
  MergeReply(state, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.deepEqual(state, { rx1: { name: 'A', carrier: 470100 } });
  assert.equal({}.polluted, undefined);

  // No product: the shape of the reply decides the family.
  const d = InterpretState({ rx1: { name: 'X', carrier: 500000, skx: { battery: [] } } });
  assert.equal(d.Profile, 'Digital 6000');
  assert.equal(d.Channels[0].TxPresent, false);
  const e = InterpretState({ rx1: { name: 'Y' }, mates: { tx1: { type: 'SKM' } } });
  assert.equal(e.Profile, 'EW-DX');
  assert.equal(e.Channels[0].TxPresent, true, 'mate type is the fallback when RSQI is missing');
  // Unknown values never read as zero.
  const u = InterpretState({
    rx1: { name: 'Z' },
    m: { rx1: { rsqi: 50 } },
    mates: { tx1: { battery: { gauge: 'n/a' } } },
  });
  assert.equal(u.Channels[0].BatteryPercent, null);
  assert.equal(u.Channels[0].BatteryMinutes, null);
});

test('sennheiser Debug escapes device names and renders a card per channel', () => {
  const m = load();
  const html = m.Debug(
    {
      Success: true,
      LatencyMs: 3,
      Model: '<img src=x onerror=alert(1)>',
      Family: 'EW-DX',
      DeviceId: '<script>bad()</script>',
      Channels: [
        {
          Number: 1,
          Name: '<script>alert(1)</script>',
          FrequencyMHz: 521,
          TxPresent: true,
          TxType: 'SK',
          TxName: null,
          BatteryPercent: 90,
          BatteryMinutes: 400,
          BatteryLow: false,
          BatteryType: 'Battery',
          BatteryState: null,
          TxMuted: false,
          RxMuted: false,
          Warnings: ['<b>odd</b>'],
          LinkQuality: 88,
          RfLevelsDbm: [],
          ActiveAntenna: 'A',
          Monitored: true,
          Issues: [],
        },
        {
          Number: 2,
          Name: 'SPARE',
          TxPresent: false,
          RfLevelsDbm: [],
          Warnings: [],
          Monitored: true,
          Issues: [],
        },
      ],
      MissingChannels: [],
    },
    { Address: '10.0.0.9', Settings: {} }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>odd'));
  assert.equal((html.match(/monitoring-debug-card/g) || []).length, 2);
  assert.ok(html.includes('6:40 left'));
  assert.ok(html.includes('No transmitter'));
});

test('sennheiser: a slow resolver is bounded by the Timeout with a resolve error', async () => {
  const m = loadWithMocks(methodPath('sennheiser-wireless.js'), {
    dns: { promises: { lookup: () => new Promise(() => {}) } },
  });
  const started = Date.now();
  const r = await m.Run({ Address: 'slow.example', Settings: { Timeout: 600 } });
  assert.equal(r.Success, false);
  assert.match(r.Error, /Failed to resolve slow\.example: timed out/);
  assert.ok(Date.now() - started < 1500);
  const failing = loadWithMocks(methodPath('sennheiser-wireless.js'), {
    dns: { promises: { lookup: () => Promise.reject(new Error('ENOTFOUND')) } },
  });
  const f = await failing.Run({ Address: 'nope.example', Settings: { Timeout: 600 } });
  assert.match(f.Error, /Failed to resolve nope\.example: ENOTFOUND/);
});

test('sennheiser: a deeply nested datagram is capped, not a stack overflow', async () => {
  const m = load();
  const deep = '{"rx1":'.repeat(9000) + '1' + '}'.repeat(9000);
  const state = {};
  assert.doesNotThrow(() => m._internal.MergeReply(state, JSON.parse(deep)));
  let depth = 0;
  for (let cur = state; cur && typeof cur === 'object'; cur = cur.rx1) depth++;
  assert.ok(depth <= m._internal.MAX_MERGE_DEPTH);
  // End to end: the hostile reply neither crashes the process nor hangs the probe.
  const server = await startSscServer({ raw: deep });
  try {
    const r = await m.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 1500 } });
    assert.equal(typeof r.Success, 'boolean');
  } finally {
    await server.close();
  }
});
