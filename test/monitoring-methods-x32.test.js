const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const osc = require(methodPath('_osc-shared.js'));

function loadX32() {
  return loadWithMocks(methodPath('x32-console.js'), {});
}

// A fake X32 / X-Air console on 127.0.0.1. It answers reads the way the console
// does: same address back, current value as the argument, sent to the sender.
//   model/name/firmware : the /xinfo identity
//   mainOn              : 1 (on) / 0 (muted) for the main bus of the family
//   channels            : { 2: { on: 0, name: 'Lead Vox' } }
//   dropFirst           : swallow this many incoming datagrams (UDP loss)
//   raw                 : (msg) => Buffer | null to override every reply
//   silentPaths         : addresses never answered
function startConsole({
  model = 'X32',
  name = 'X32-02-4A-53',
  firmware = '4.06',
  mainOn = 1,
  channels = {},
  dropFirst = 0,
  raw = null,
  silentPaths = [],
} = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const received = [];
    let dropped = 0;
    const xair = /^(XR|MR)/.test(model);
    sock.on('message', (buf, rinfo) => {
      if (dropped < dropFirst) {
        dropped++;
        return;
      }
      for (const msg of osc.ParseOscPacket(buf)) {
        received.push(msg.Address);
        if (silentPaths.includes(msg.Address)) continue;
        let reply = null;
        if (raw) {
          reply = raw(msg);
        } else if (msg.Address === '/xinfo') {
          reply = osc.EncodeOscMessage('/xinfo', ['127.0.0.1', name, model, firmware]);
        } else if (msg.Address === '/status') {
          reply = osc.EncodeOscMessage('/status', ['active', '127.0.0.1', name]);
        } else if (msg.Address === (xair ? '/lr/mix/on' : '/main/st/mix/on')) {
          reply = osc.EncodeOscMessage(msg.Address, [mainOn]);
        } else {
          const m = /^\/ch\/(\d\d)\/(mix\/on|config\/name)$/.exec(msg.Address);
          if (m) {
            const ch = channels[Number(m[1])] || {};
            reply =
              m[2] === 'mix/on'
                ? osc.EncodeOscMessage(msg.Address, [ch.on == null ? 1 : ch.on])
                : osc.EncodeOscMessage(msg.Address, [ch.name || '']);
          }
        }
        if (reply) sock.send(reply, rinfo.port, rinfo.address);
      }
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

// A free UDP port with nothing listening on it.
function freeUdpPort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

test('x32 exposes its identity and read-only defaults', () => {
  const x32 = loadX32();
  assert.equal(x32.ID, 'x32-console');
  assert.equal(typeof x32.Run, 'function');
  assert.equal(typeof x32.Debug, 'function');
  const byKey = Object.fromEntries(x32.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 10023);
  assert.equal(byKey.Port.Required, true);
  assert.equal(byKey.CheckName.Default, false);
  assert.equal(byKey.CheckMainMute.Default, false);
  assert.equal(byKey.CheckChannelMutes.Default, false);
  assert.equal(byKey.MonitoredChannels.Type, 'list');
  assert.equal(byKey.MonitoredChannels.ItemType, 'number');
  assert.deepEqual(byKey.MonitoredChannels.VisibleWhen, { Key: 'CheckChannelMutes', Equals: true });
  assert.equal(byKey.Timeout.Advanced, true);
  assert.equal(byKey.Timeout.Default, 4000);
  assert.ok(!x32.Actions, 'checks are read-only');
});

test('x32 happy path reads model, name and firmware', async () => {
  const x32 = loadX32();
  const desk = await startConsole();
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Model, 'X32');
    assert.equal(result.ConsoleName, 'X32-02-4A-53');
    assert.equal(result.Firmware, '4.06');
    assert.equal(result.ReportedIp, '127.0.0.1');
    assert.equal(result.Family, 'x32');
    assert.equal(result.IsConsole, true);
    assert.equal(typeof result.LatencyMs, 'number');
    // No assertion enabled -> no mute reads sent.
    assert.ok(!desk.received.some((a) => a.includes('/mix/on')));
  } finally {
    await desk.close();
  }
});

test('x32 degrades on a different console name, case-insensitively', async () => {
  const x32 = loadX32();
  const desk = await startConsole({ name: 'FOH-X32' });
  try {
    const ok = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 1500, CheckName: true, ExpectedName: 'foh-x32' },
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 1500, CheckName: true, ExpectedName: 'MON-X32' },
    });
    assert.equal(bad.Success, true);
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'Name "FOH-X32" (expected "MON-X32")');
  } finally {
    await desk.close();
  }
});

test('x32 main mute uses /main/st/mix/on on X32 and degrades when muted', async () => {
  const x32 = loadX32();
  const desk = await startConsole({ mainOn: 0 });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 1500, CheckMainMute: true },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Main LR muted');
    assert.equal(result.MainMuted, true);
    assert.ok(desk.received.includes('/main/st/mix/on'));
    assert.ok(!desk.received.includes('/lr/mix/on'));
  } finally {
    await desk.close();
  }
});

test('x32 main mute uses /lr/mix/on on an X-Air model', async () => {
  const x32 = loadX32();
  const desk = await startConsole({ model: 'XR18', name: 'XR18-1D-DA-B4', mainOn: 1 });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 1500, CheckMainMute: true },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Family, 'xair');
    assert.equal(result.MainOn, true);
    assert.ok(desk.received.includes('/lr/mix/on'));
    assert.ok(!desk.received.includes('/main/st/mix/on'));
  } finally {
    await desk.close();
  }
});

test('x32 names each muted, unreadable and missing channel', async () => {
  const x32 = loadX32();
  const desk = await startConsole({
    model: 'XR18',
    channels: { 2: { on: 0, name: 'Lead Vox' }, 3: { on: 1, name: 'Gtr' }, 4: { on: 0 } },
    silentPaths: ['/ch/05/mix/on'],
  });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: {
        Port: desk.port,
        Timeout: 800,
        CheckChannelMutes: true,
        MonitoredChannels: ['2', '3', '4', '5', '20', 'junk', '2'],
      },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      'Ch 2 (Lead Vox): muted; Ch 4: muted; Ch 5: failed to read mute state; Ch 20: not on this XR18'
    );
    assert.ok(desk.received.includes('/ch/02/mix/on'), 'channel path is zero-padded');
    assert.ok(!desk.received.includes('/ch/20/mix/on'), 'no read for a channel the model lacks');
  } finally {
    await desk.close();
  }
});

test('x32 channel list is ignored while the channel toggle is off', async () => {
  const x32 = loadX32();
  const desk = await startConsole({ channels: { 1: { on: 0 } } });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 1500, MonitoredChannels: ['1'] },
    });
    assert.ok(!result.Degraded);
    assert.ok(!desk.received.includes('/ch/01/mix/on'));
  } finally {
    await desk.close();
  }
});

test('x32 re-sends lost queries until they are answered', async () => {
  const x32 = loadX32();
  // Drop /xinfo and /status from the first round.
  const desk = await startConsole({ dropFirst: 2, mainOn: 1 });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 2000, CheckMainMute: true },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Model, 'X32');
  } finally {
    await desk.close();
  }
});

test('x32 matches replies by address in any order, including inside a bundle', async () => {
  const x32 = loadX32();
  // Answer /xinfo with a bundle that carries the main-mute value FIRST (a
  // reply nobody has asked for yet), then the identity.
  const bundle = (msgs) => {
    const parts = [Buffer.from('#bundle\0'), Buffer.alloc(8)];
    for (const m of msgs) {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(m.length, 0);
      parts.push(size, m);
    }
    return Buffer.concat(parts);
  };
  const desk = await startConsole({
    raw: (msg) => {
      if (msg.Address === '/xinfo') {
        return bundle([
          osc.EncodeOscMessage('/main/st/mix/on', [0]),
          osc.EncodeOscMessage('/xinfo', ['10.0.0.5', 'Desk', 'M32', '4.10']),
        ]);
      }
      if (msg.Address === '/main/st/mix/on') return osc.EncodeOscMessage(msg.Address, [1]);
      return null;
    },
  });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 1500, CheckMainMute: true },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Model, 'M32');
    assert.equal(result.Family, 'x32');
    // The unsolicited early mute value was ignored; the real read says on.
    assert.equal(result.MainOn, true);
    assert.ok(!result.Degraded, result.DegradedReason);
  } finally {
    await desk.close();
  }
});

test('x32 reports degraded when something answers but is not a console', async () => {
  const x32 = loadX32();
  const desk = await startConsole({
    raw: (msg) =>
      msg.Address === '/xinfo' ? osc.EncodeOscMessage('/xinfo', ['only', 'two']) : null,
  });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 600 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /does not look like an X32/);
  } finally {
    await desk.close();
  }
});

test('x32 treats non-OSC junk as a non-console responder', async () => {
  const x32 = loadX32();
  const desk = await startConsole({ raw: () => Buffer.from('HTTP/1.1 400 Bad Request\r\n') });
  try {
    const result = await x32.Run({
      Address: '127.0.0.1',
      Settings: { Port: desk.port, Timeout: 600 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
  } finally {
    await desk.close();
  }
});

test('x32 is offline when nothing answers', async () => {
  const x32 = loadX32();
  const port = await freeUdpPort();
  const started = Date.now();
  const result = await x32.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 600 } });
  assert.equal(result.Success, false);
  assert.ok(result.Error);
  // Either an ICMP refusal (fast) or the whole-probe deadline, never longer.
  assert.ok(Date.now() - started < 1500);
});

test('x32 rejects a missing address or bad port without probing', async () => {
  const x32 = loadX32();
  assert.deepEqual(await x32.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const bad = await x32.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.equal(bad.Success, false);
  assert.match(bad.Error, /Invalid port/);
});

test('x32 EvaluateHealth is pure and gated by its toggles', () => {
  const { EvaluateHealth } = loadX32()._internal;
  const snap = {
    IsConsole: true,
    ConsoleName: 'A',
    Model: 'X32',
    Family: 'x32',
    MainOn: null,
    Channels: [{ Channel: 1, Supported: true, Name: null, On: false }],
  };
  const off = {
    CheckName: false,
    ExpectedName: 'B',
    CheckMainMute: false,
    CheckChannelMutes: false,
    Channels: [1],
  };
  assert.deepEqual(EvaluateHealth(snap, off), []);
  assert.deepEqual(EvaluateHealth(snap, { ...off, CheckMainMute: true }), [
    'Failed to read the Main LR mute state',
  ]);
  assert.deepEqual(EvaluateHealth(snap, { ...off, CheckChannelMutes: true }), ['Ch 1: muted']);
  assert.deepEqual(EvaluateHealth({ ...snap, IsConsole: false }, off), [
    'Responded, but does not look like an X32 / M32 / X-Air console',
  ]);
});

test('x32 parser helpers', () => {
  const i = loadX32()._internal;
  assert.equal(i.FamilyOfModel('XR18'), 'xair');
  assert.equal(i.FamilyOfModel('MR12'), 'xair');
  assert.equal(i.FamilyOfModel('M32R'), 'x32');
  assert.equal(i.FamilyOfModel('X32RACK'), 'x32');
  assert.equal(i.ChannelOnPath(7), '/ch/07/mix/on');
  assert.equal(i.ChannelNamePath(12), '/ch/12/config/name');
  assert.equal(i.ParseOnSwitch(0), false);
  assert.equal(i.ParseOnSwitch(1), true);
  assert.equal(i.ParseOnSwitch('1'), null);
  assert.deepEqual(i.ParseChannelList(['1', 2, ' 3 ', 'x', 0, -1, 1.5, '2']), [1, 2, 3]);
  assert.deepEqual(i.ParseChannelList(undefined), []);
  assert.deepEqual(i.ParseChannelList('4'), [4]);
  assert.equal(i.ParseXinfo({ Address: '/xinfo', Args: ['ip', 'n', '', 'fw'] }), null);
  assert.equal(i.ParseXinfo({ Address: '/xinfo', Args: ['ip', 'n', 3, 'fw'] }), null);
  assert.equal(i.ParseXinfo({ Address: '/xinfo', Args: ['V0.04', 'n', 'XR18', '1.1'] }).Ip, '');
  assert.deepEqual(i.ParseXinfo({ Address: '/xinfo', Args: [' 10.0.0.9 ', 'n', 'X32', '4.0'] }), {
    Ip: '10.0.0.9',
    Name: 'n',
    Model: 'X32',
    Firmware: '4.0',
  });
});

test('x32 Debug escapes device-supplied strings', () => {
  const x32 = loadX32();
  const html = x32.Debug(
    {
      Success: true,
      LatencyMs: 3,
      Model: '<script>alert(1)</script>',
      ConsoleName: '<img src=x onerror=1>',
      Firmware: '<b>fw</b>',
      ReportedIp: '"><script>',
      Family: 'x32',
      MainOn: false,
      Channels: [{ Channel: 1, Supported: true, Name: '<script>x</script>', On: false }],
    },
    {
      Address: '127.0.0.1',
      Settings: { CheckChannelMutes: true, MonitoredChannels: ['1'] },
    }
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Muted'));
});

test('x32 Debug renders the offline hint', () => {
  const x32 = loadX32();
  const html = x32.Debug(
    { Success: false, Error: 'No reply within 600ms' },
    { Address: 'desk.local', Settings: {} }
  );
  assert.ok(html.includes('desk.local:10023'));
  assert.ok(html.includes('10024'));
  assert.ok(html.includes('Offline'));
});
