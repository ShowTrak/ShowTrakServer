const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const osc = require(methodPath('_osc-shared.js'));

function loadWing() {
  return loadWithMocks(methodPath('behringer-wing.js'), {});
}

// A fake WING on 127.0.0.1, answering the way Maillot's "WING Remote Protocols"
// documents: `/?` -> `,s WING,<ip>,<name>,<model>,<serial>,<fw>`; a read of an
// int leaf -> `,sfi <text> <raw> <value>`; of a float leaf -> `,sff`; of a
// string leaf -> `,s`. Writes (a message with arguments) change the state and
// are NOT echoed.
//   values      : { '/ch/5/mute': 1, '/ch/5/fdr': -144, '/$ctl/lib/$actshow': 'I:SHOW2' }
//   info        : the `/?` signature string
//   dropFirst   : swallow this many incoming datagrams (UDP loss)
//   silentPaths : addresses never answered
//   ignoreWrites: writes are received but do not change the state
//   raw         : (msg) => Buffer | null to override every reply
const FLOAT_LEAVES = /\/fdr$/;
const INT_LEAVES = /\/(mute|lock|\$actidx|\$actionidx)$/;

function startWing({
  info = 'WING,127.0.0.1,FOH,wing-rack,S1234,3.0.5-0-gabc:release',
  values = {},
  dropFirst = 0,
  silentPaths = [],
  ignoreWrites = false,
  raw = null,
} = {}) {
  const state = {
    '/$stat/lock': 1,
    '/$globals/clkrate': '48000.0',
    '/$globals/clksrc': 'INT',
    '/$ctl/lib/$actshow': 'I:SHOW2',
    '/$ctl/lib/$active': 'I:SHOW2/scene_1.snap',
    '/$stat/sc_stat': 'OK',
    '/$stat/A/stat': 'OK',
    '/$stat/A/dev': 'DL16',
    '/$stat/B/stat': '-',
    '/$stat/B/dev': '',
    '/$stat/C/stat': '-',
    '/$stat/C/dev': '',
    ...values,
  };
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const received = [];
    const writes = [];
    let dropped = 0;
    sock.on('message', (buf, rinfo) => {
      if (dropped < dropFirst) {
        dropped++;
        return;
      }
      for (const msg of osc.ParseOscPacket(buf)) {
        received.push(msg.Address);
        if (msg.Args.length) {
          writes.push({ Address: msg.Address, Args: msg.Args });
          if (!ignoreWrites) state[msg.Address] = msg.Args[0];
          continue;
        }
        if (silentPaths.includes(msg.Address)) continue;
        let reply = null;
        if (raw) {
          reply = raw(msg);
        } else if (msg.Address === '/?') {
          reply = osc.EncodeOscMessage('/?', [info]);
        } else if (FLOAT_LEAVES.test(msg.Address)) {
          const db = state[msg.Address] == null ? 0 : Number(state[msg.Address]);
          const text = db <= -144 ? '-oo' : db.toFixed(1);
          reply = osc.EncodeOscMessage(msg.Address, [text, { Float: 0.5 }, { Float: db }]);
        } else if (INT_LEAVES.test(msg.Address)) {
          const v = state[msg.Address] == null ? 0 : Number(state[msg.Address]);
          reply = osc.EncodeOscMessage(msg.Address, [String(v), { Float: v ? 1 : 0 }, { Int: v }]);
        } else if (/\/\$?name$/.test(msg.Address) || msg.Address in state) {
          reply = osc.EncodeOscMessage(msg.Address, [String(state[msg.Address] ?? '')]);
        }
        if (reply) sock.send(reply, rinfo.port, rinfo.address);
      }
    });
    sock.bind(0, '127.0.0.1', () => {
      resolve({
        port: sock.address().port,
        received,
        writes,
        state,
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

// A UDP port that is bound but never answers.
function silentSocket() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('message', () => {});
    s.bind(0, '127.0.0.1', () =>
      resolve({ port: s.address().port, close: () => new Promise((r) => s.close(r)) })
    );
  });
}

function run(wing, desk, settings = {}) {
  return wing.Run({
    Address: '127.0.0.1',
    Settings: { Port: desk.port, Timeout: 1500, ...settings },
  });
}

test('wing exposes its identity and defaults', () => {
  const wing = loadWing();
  assert.equal(wing.ID, 'behringer-wing');
  assert.equal(wing.Name, 'Behringer WING');
  assert.equal(typeof wing.Run, 'function');
  assert.equal(typeof wing.Debug, 'function');
  assert.equal(typeof wing.RunAction, 'function');
  const byKey = Object.fromEntries(wing.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 2223);
  assert.equal(byKey.Port.Required, true);
  for (const key of [
    'CheckName',
    'CheckClock',
    'CheckAes50',
    'CheckStageConnect',
    'CheckShow',
    'CheckStrips',
    'CheckFaders',
  ]) {
    assert.equal(byKey[key].Default, false, key);
  }
  assert.equal(byKey.MonitoredStrips.Type, 'list');
  assert.deepEqual(byKey.MonitoredStrips.VisibleWhen, { Key: 'CheckStrips', Equals: true });
  assert.equal(byKey.Timeout.Advanced, true);
  assert.equal(byKey.Timeout.Default, 4000);
  for (const field of wing.Settings) {
    if (field.Note) assert.match(field.Note, /[.!?]$/, `${field.Key} note ends with a full stop`);
  }
});

test('wing destructive actions never let normalization invent a target', () => {
  const wing = loadWing();
  assert.ok(wing.Actions.length >= 3);
  for (const action of wing.Actions) {
    assert.equal(action.Destructive, true, `${action.ID} needs a confirmation`);
    assert.match(action.Note, /\.$/);
    for (const param of action.Params || []) {
      assert.equal(param.Min, undefined, `${action.ID}/${param.Key}`);
      assert.equal(param.Max, undefined, `${action.ID}/${param.Key}`);
      assert.equal(param.Default, undefined, `${action.ID}/${param.Key}`);
    }
  }
});

test('wing happy path reads identity, clock and library without writing', async () => {
  const wing = loadWing();
  const desk = await startWing();
  try {
    const result = await run(wing, desk);
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.IsConsole, true);
    assert.equal(result.Model, 'wing-rack');
    assert.equal(result.ModelLabel, 'WING Rack');
    assert.equal(result.ConsoleName, 'FOH');
    assert.equal(result.Serial, 'S1234');
    assert.equal(result.Firmware, '3.0.5-0-gabc:release');
    assert.equal(result.ReportedIp, '127.0.0.1');
    assert.equal(result.ClockLocked, true);
    assert.equal(result.ClockSource, 'INT');
    assert.equal(result.SampleRate, 48000);
    assert.equal(result.ShowName, 'I:SHOW2');
    assert.equal(result.SceneName, 'I:SHOW2/scene_1.snap');
    assert.equal(typeof result.LatencyMs, 'number');
    assert.equal(desk.received[0], '/?');
    assert.deepEqual(desk.writes, [], 'a probe never writes');
    assert.ok(!desk.received.some((a) => a.startsWith('/*')), 'never subscribes');
    assert.ok(!desk.received.some((a) => a.includes('/mute')), 'no strip reads unless asked');
    assert.ok(!desk.received.includes('/$stat/sc_stat'));
  } finally {
    await desk.close();
  }
});

test('wing survives a lost datagram by re-sending', async () => {
  const wing = loadWing();
  const desk = await startWing({ dropFirst: 1 });
  try {
    const result = await run(wing, desk, { Timeout: 2000 });
    assert.equal(result.Success, true);
    assert.equal(result.ConsoleName, 'FOH');
  } finally {
    await desk.close();
  }
});

test('wing reports offline when nothing answers', async () => {
  const wing = loadWing();
  const silent = await silentSocket();
  try {
    const result = await wing.Run({
      Address: '127.0.0.1',
      Settings: { Port: silent.port, Timeout: 600 },
    });
    assert.equal(result.Success, false);
    assert.equal(result.Error, 'No reply within 600ms');
    assert.ok(!result.Degraded);
  } finally {
    await silent.close();
  }
});

test('wing reports offline on a closed port', async () => {
  const wing = loadWing();
  const port = await freeUdpPort();
  const result = await wing.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 800 } });
  assert.equal(result.Success, false);
  assert.ok(result.Error);
});

test('wing refuses a missing address or bad port without sending', async () => {
  const wing = loadWing();
  assert.deepEqual(await wing.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const bad = await wing.Run({ Address: '127.0.0.1', Settings: { Port: 70000 } });
  assert.equal(bad.Error, 'Invalid port: 70000');
});

test('wing degrades when something that is not a WING answers', async () => {
  const wing = loadWing();
  const desk = await startWing({
    raw: (msg) => (msg.Address === '/?' ? osc.EncodeOscMessage('/?', ['hello']) : null),
  });
  try {
    const result = await run(wing, desk);
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Responded, but does not look like a Behringer WING');
    assert.equal(result.IsConsole, false);
    assert.deepEqual(
      desk.received.filter((a) => a !== '/?'),
      [],
      'nothing else is asked'
    );
  } finally {
    await desk.close();
  }
});

test('wing ignores malformed packets and still reads the console', async () => {
  const wing = loadWing();
  let sentJunk = false;
  // Answer the first /? with junk bytes, then behave.
  const junkDesk = await startWing({
    raw: (msg) => {
      if (msg.Address === '/?' && !sentJunk) {
        sentJunk = true;
        return Buffer.from([0x00, 0xff, 0x13, 0x37, 0x2c]);
      }
      if (msg.Address === '/?') {
        return osc.EncodeOscMessage('/?', ['WING,127.0.0.1,MON,ngc-full,NO_SERIAL,3.0.5']);
      }
      return osc.EncodeOscMessage(msg.Address, ['x']);
    },
  });
  try {
    const result = await run(wing, junkDesk, { Timeout: 2000 });
    assert.equal(result.Success, true);
    assert.equal(result.ModelLabel, 'WING');
    assert.equal(result.ConsoleName, 'MON');
    // 'x' is not a lock value.
    assert.equal(result.ClockLocked, null);
  } finally {
    await junkDesk.close();
  }

  const { ParseWingInfo } = wing._internal;
  assert.equal(ParseWingInfo({ Address: '/?', Args: [] }), null);
  assert.equal(ParseWingInfo({ Address: '/?', Args: [42] }), null);
  assert.equal(ParseWingInfo({ Address: '/?', Args: ['WING,1.2.3.4,a,b'] }), null);
  assert.equal(ParseWingInfo({ Address: '/xinfo', Args: ['WING,1,2,3,4,5'] }), null);
  assert.equal(ParseWingInfo({ Address: '/?', Args: ['X32,1.2.3.4,a,b,c,d'] }), null);
  assert.deepEqual(ParseWingInfo({ Address: '/?', Args: ['WING,not-ip,N,ngc-full,S,1.0,extra'] }), {
    Ip: '',
    Name: 'N',
    Model: 'ngc-full',
    Serial: 'S',
    Firmware: '1.0,extra',
  });
});

test('wing degrades on a different console name, case-insensitively', async () => {
  const wing = loadWing();
  const desk = await startWing();
  try {
    const ok = await run(wing, desk, { CheckName: true, ExpectedName: 'foh' });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await run(wing, desk, { CheckName: true, ExpectedName: 'MON' });
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'Name "FOH" (expected "MON")');
  } finally {
    await desk.close();
  }
});

test('wing clock check flags lock, source and sample rate', async () => {
  const wing = loadWing();
  const desk = await startWing({
    values: { '/$stat/lock': 0, '/$globals/clksrc': 'A', '/$globals/clkrate': '44100.0' },
  });
  try {
    const result = await run(wing, desk, {
      CheckClock: true,
      ExpectedClockSource: 'INT',
      ExpectedSampleRate: '48000',
    });
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      'Clock not locked; Clock source A (expected INT); Sample rate 44.1 kHz (expected 48 kHz)'
    );
    const quiet = await run(wing, desk, { CheckClock: false });
    assert.ok(!quiet.Degraded, 'the clock is only judged when asked');
  } finally {
    await desk.close();
  }
});

test('wing AES50 and StageConnect checks name each fault', async () => {
  const wing = loadWing();
  const desk = await startWing({ values: { '/$stat/C/stat': 'ERR', '/$stat/sc_stat': 'ERR' } });
  try {
    const result = await run(wing, desk, {
      CheckAes50: true,
      Aes50Ports: ['A', 'b', 'AES50 C', 'D'],
      CheckStageConnect: true,
    });
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      'Unknown AES50 port "D"; AES50 B: no link; AES50 C: error; StageConnect: error'
    );
    assert.deepEqual(
      result.Aes50.map((p) => [p.Port, p.State, p.Device]),
      [
        ['A', 'OK', 'DL16'],
        ['B', '-', null],
        ['C', 'ERR', null],
      ]
    );
    assert.ok(desk.received.includes('/$stat/sc_stat'));
  } finally {
    await desk.close();
  }
});

test('wing show and scene check matches the full path or the bare name', async () => {
  const wing = loadWing();
  const desk = await startWing();
  try {
    const ok = await run(wing, desk, {
      CheckShow: true,
      ExpectedShow: 'show2',
      ExpectedScene: 'Scene_1',
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const full = await run(wing, desk, {
      CheckShow: true,
      ExpectedScene: 'I:SHOW2/scene_1.snap',
    });
    assert.ok(!full.Degraded, full.DegradedReason);
    const bad = await run(wing, desk, {
      CheckShow: true,
      ExpectedShow: 'MATINEE',
      ExpectedScene: 'scene_2',
    });
    assert.equal(
      bad.DegradedReason,
      'Show "I:SHOW2" (expected "MATINEE"); Scene "I:SHOW2/scene_1.snap" (expected "scene_2")'
    );
  } finally {
    await desk.close();
  }
  const empty = await startWing({ values: { '/$ctl/lib/$actshow': '', '/$ctl/lib/$active': '' } });
  try {
    const none = await run(wing, empty, {
      CheckShow: true,
      ExpectedShow: 'SHOW2',
      ExpectedScene: 'a',
    });
    assert.equal(
      none.DegradedReason,
      'No show open (expected "SHOW2"); No scene loaded (expected "a")'
    );
  } finally {
    await empty.close();
  }
});

test('wing strip check names muted, engaged, faded-out, unreadable and unknown strips', async () => {
  const wing = loadWing();
  const desk = await startWing({
    values: {
      '/main/1/mute': 0,
      '/main/1/fdr': 0,
      '/main/1/$name': 'PA',
      '/ch/5/mute': 1,
      '/ch/5/$name': 'Vox',
      '/ch/5/fdr': -3,
      '/bus/2/mute': 0,
      '/bus/2/fdr': -144,
      '/mgrp/1/mute': 1,
      '/mgrp/1/name': 'Band',
      '/dca/3/mute': 0,
      '/dca/3/fdr': 0,
    },
    silentPaths: ['/aux/1/mute'],
  });
  try {
    const result = await run(wing, desk, {
      Timeout: 800,
      CheckStrips: true,
      CheckFaders: true,
      MonitoredStrips: [
        'Main 1',
        'ch5',
        'Bus.2',
        'mute group 1',
        'DCA 3',
        'aux 1',
        'Ch 41',
        'banana',
        'ch 5',
      ],
    });
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      [
        'Unknown strip "Ch 41"',
        'Unknown strip "banana"',
        'Ch 5 (Vox): muted',
        'Bus 2: fader at −∞',
        'Mgrp 1 (Band): engaged',
        'Aux 1: failed to read mute state',
      ].join('; ')
    );
    const byStrip = Object.fromEntries(result.Strips.map((s) => [s.Strip, s]));
    assert.equal(byStrip['Main 1'].Name, 'PA');
    assert.equal(byStrip['Main 1'].Muted, false);
    assert.equal(byStrip['Main 1'].FaderDb, 0);
    assert.equal(byStrip['Ch 5'].FaderDb, -3);
    assert.equal(byStrip['Mgrp 1'].FaderDb, null);
    // Mute groups have no fader to read.
    assert.ok(!desk.received.includes('/mgrp/1/fdr'));
    assert.ok(desk.received.includes('/ch/5/$name'));
    assert.ok(desk.received.includes('/mgrp/1/name'));
    assert.equal(result.Strips.length, 6);
  } finally {
    await desk.close();
  }
});

test('wing reads faders only when asked', async () => {
  const wing = loadWing();
  const desk = await startWing({ values: { '/ch/1/fdr': -144 } });
  try {
    const result = await run(wing, desk, { CheckStrips: true, MonitoredStrips: ['ch 1'] });
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.ok(!desk.received.includes('/ch/1/fdr'));
  } finally {
    await desk.close();
  }
});

test('wing caps the strip list', () => {
  const wing = loadWing();
  const many = Array.from({ length: 40 }, (_, i) => `ch ${i + 1}`);
  const { Strips, Invalid } = wing._internal.ParseStripList(many);
  assert.equal(Strips.length, 32);
  assert.deepEqual(Invalid, []);
  assert.deepEqual(Strips[31], { Kind: 'ch', Number: 32 });
});

test('wing parses strips, values and library names', () => {
  const { ParseStrip, ParseDb, ParseSwitch, ParseSampleRate, LibraryNameMatches, ModelLabel } =
    loadWing()._internal;
  assert.deepEqual(ParseStrip('Ch 12'), { Kind: 'ch', Number: 12 });
  assert.deepEqual(ParseStrip('channel.40'), { Kind: 'ch', Number: 40 });
  assert.deepEqual(ParseStrip('MATRIX 8'), { Kind: 'mtx', Number: 8 });
  assert.deepEqual(ParseStrip('Mute Group 8'), { Kind: 'mgrp', Number: 8 });
  assert.equal(ParseStrip('main 5'), null);
  assert.equal(ParseStrip('ch 0'), null);
  assert.equal(ParseStrip(''), null);
  assert.equal(ParseStrip(null), null);
  assert.equal(ParseStrip('fx 1'), null);

  assert.equal(ParseDb({ Address: '/x', Args: ['-oo', 0, -144] }), -144);
  assert.equal(ParseDb({ Address: '/x', Args: ['-oo'] }), -144);
  assert.equal(ParseDb({ Address: '/x', Args: [-3.5] }), -3.5);
  assert.equal(ParseDb({ Address: '/x', Args: ['-2.0'] }), -2);
  assert.equal(ParseDb({ Address: '/x', Args: ['abc'] }), null);
  assert.equal(ParseDb(undefined), null);

  assert.equal(ParseSwitch({ Address: '/x', Args: ['1', 1, 1] }), true);
  assert.equal(ParseSwitch({ Address: '/x', Args: ['0', 0, 0] }), false);
  assert.equal(ParseSwitch({ Address: '/x', Args: [1] }), true);
  assert.equal(ParseSwitch({ Address: '/x', Args: ['0'] }), false);
  assert.equal(ParseSwitch({ Address: '/x', Args: ['ON'] }), null);

  assert.equal(ParseSampleRate({ Address: '/x', Args: ['44100.0'] }), 44100);
  assert.equal(ParseSampleRate({ Address: '/x', Args: ['junk'] }), null);

  assert.equal(LibraryNameMatches('I:SHOW2', 'show2'), true);
  assert.equal(LibraryNameMatches('I:SHOW2/scene_1.snap', 'scene_1'), true);
  assert.equal(LibraryNameMatches('I:SHOW2/scene_1.snap', 'scene_10'), false);
  assert.equal(LibraryNameMatches('', 'x'), false);

  assert.equal(ModelLabel('ngc-full'), 'WING');
  assert.equal(ModelLabel('wing-compact'), 'WING Compact');
  assert.equal(ModelLabel('future-thing'), 'future-thing');
  assert.equal(ModelLabel(null), null);
});

// --- Actions --------------------------------------------------------------------

function act(wing, desk, id, params = {}, timeout = 1500) {
  return wing.RunAction(
    { Address: '127.0.0.1', Settings: { Port: desk.port, Timeout: timeout } },
    id,
    params
  );
}

test('wing mute action writes, reads back and names the strip', async () => {
  const wing = loadWing();
  const desk = await startWing({ values: { '/ch/5/mute': 0, '/ch/5/$name': 'Vox' } });
  try {
    const muted = await act(wing, desk, 'strip.mute', { Strip: 'ch 5' });
    assert.deepEqual(muted, { Success: true, Detail: 'Ch 5 (Vox) muted' });
    assert.equal(desk.state['/ch/5/mute'], 1);
    assert.deepEqual(desk.writes[0], { Address: '/ch/5/mute', Args: [1] });
    // The probe proves it is a WING before writing.
    assert.equal(desk.received[0], '/?');

    const unmuted = await act(wing, desk, 'strip.unmute', { Strip: 'Ch 5' });
    assert.deepEqual(unmuted, { Success: true, Detail: 'Ch 5 (Vox) unmuted' });
    assert.equal(desk.state['/ch/5/mute'], 0);

    const engaged = await act(wing, desk, 'strip.mute', { Strip: 'Mgrp 2' });
    assert.equal(engaged.Detail, 'Mgrp 2 engaged');
  } finally {
    await desk.close();
  }
});

test('wing mute action fails when the console does not take the change', async () => {
  const wing = loadWing();
  const desk = await startWing({ values: { '/main/1/mute': 0 }, ignoreWrites: true });
  try {
    const result = await act(wing, desk, 'strip.mute', { Strip: 'Main 1' }, 1200);
    assert.equal(result.Success, false);
    assert.equal(result.Error, 'The console still reports Main 1 as unmuted');
    assert.ok(desk.writes.length >= 1);
  } finally {
    await desk.close();
  }
});

test('wing actions refuse bad params and non-WING devices without writing', async () => {
  const wing = loadWing();
  const desk = await startWing();
  try {
    for (const strip of ['', 'ch 99', 'all', undefined]) {
      const result = await act(wing, desk, 'strip.mute', { Strip: strip });
      assert.equal(result.Success, false);
      assert.match(result.Error, /^Strip must be like/);
    }
    for (const scene of ['', 0, -1, 1.5, 16385, 'two', true]) {
      const result = await act(wing, desk, 'scene.recall', { Scene: scene });
      assert.equal(result.Success, false, String(scene));
      assert.equal(result.Error, 'Scene must be 1 to 16384');
    }
    const unknown = await act(wing, desk, 'power.off', {});
    assert.equal(unknown.Error, 'Unknown WING action "power.off"');
    assert.deepEqual(desk.received, [], 'nothing reached the console');
  } finally {
    await desk.close();
  }

  const other = await startWing({
    raw: (msg) => (msg.Address === '/?' ? osc.EncodeOscMessage('/?', ['nope']) : null),
  });
  try {
    const result = await act(wing, other, 'strip.mute', { Strip: 'ch 1' }, 600);
    assert.equal(result.Success, false);
    assert.match(
      result.Error,
      /No WING answered at 127\.0\.0\.1:\d+ within 600ms, so nothing was sent\./
    );
    assert.deepEqual(other.writes, []);
  } finally {
    await other.close();
  }
});

test('wing scene actions need an open show and send the documented sequence', async () => {
  const wing = loadWing();
  const closed = await startWing({ values: { '/$ctl/lib/$actshow': '' } });
  try {
    const refused = await act(wing, closed, 'scene.recall', { Scene: 3 });
    assert.deepEqual(refused, {
      Success: false,
      Error: 'No show is open on the console, so nothing was sent.',
    });
    assert.deepEqual(closed.writes, []);
  } finally {
    await closed.close();
  }

  const desk = await startWing();
  try {
    const recalled = await act(wing, desk, 'scene.recall', { Scene: '3' });
    assert.deepEqual(recalled, { Success: true, Detail: 'Scene 3 recalled in I:SHOW2' });
    assert.deepEqual(desk.writes, [
      { Address: '/$ctl/lib/$actionidx', Args: [3] },
      { Address: '/$ctl/lib/$action', Args: ['GO'] },
    ]);
    desk.writes.length = 0;
    const next = await act(wing, desk, 'scene.next');
    assert.equal(next.Detail, 'Next scene recalled in I:SHOW2');
    const prev = await act(wing, desk, 'scene.previous');
    assert.equal(prev.Detail, 'Previous scene recalled in I:SHOW2');
    assert.deepEqual(desk.writes, [
      { Address: '/$ctl/lib/$action', Args: ['GONEXT'] },
      { Address: '/$ctl/lib/$action', Args: ['GOPREV'] },
    ]);
  } finally {
    await desk.close();
  }
});

test('wing describes actions and offers monitored strips as choices', () => {
  const wing = loadWing();
  assert.equal(wing.DescribeAction('strip.mute', { Strip: 'channel 4' }), 'Mute Ch 4');
  assert.equal(wing.DescribeAction('strip.unmute', { Strip: 'mgrp 2' }), 'Release Mgrp 2');
  assert.equal(wing.DescribeAction('scene.recall', { Scene: 7 }), 'Recall Scene 7');
  assert.equal(wing.DescribeAction('scene.recall', { Scene: 'x' }), null);
  assert.equal(wing.DescribeAction('scene.next', {}), null);

  assert.deepEqual(wing.GetActionOptions({ Success: true }), {});
  assert.deepEqual(
    wing.GetActionOptions({
      Success: true,
      Strips: [
        { Strip: 'Main 1', Name: 'PA' },
        { Strip: 'Ch 2', Name: null },
      ],
    }),
    {
      Strip: [
        { value: 'Main 1', label: 'Main 1 (PA)' },
        { value: 'Ch 2', label: 'Ch 2' },
      ],
    }
  );
});

// --- Debug ----------------------------------------------------------------------

test('wing debug escapes every console-supplied value', () => {
  const wing = loadWing();
  const evil = '<img src=x onerror=alert(1)>';
  const html = wing.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: `Name "${evil}"`,
      LatencyMs: 3,
      Model: evil,
      ConsoleName: evil,
      Serial: evil,
      Firmware: evil,
      ReportedIp: '127.0.0.1',
      ClockSource: evil,
      SampleRate: 48000,
      ClockLocked: false,
      ShowName: evil,
      SceneName: evil,
      StageConnect: evil,
      Aes50: [{ Port: 'A', State: evil, Device: evil }],
      Strips: [{ Strip: 'Ch 1', Kind: 'ch', Number: 1, Name: evil, Muted: true, FaderDb: -144 }],
      ConsoleError: evil,
    },
    { Address: '127.0.0.1', Settings: { CheckStrips: true } }
  );
  assert.ok(!html.includes('<img'), 'no raw markup from the console');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('−∞ dB'));
  assert.ok(html.includes('Not locked'));

  const offline = wing.Debug(
    { Success: false, Error: `<b>${evil}</b>` },
    { Address: '<script>', Settings: {} }
  );
  assert.ok(!offline.includes('<script>'));
  assert.ok(!offline.includes('<b>'));
  assert.ok(offline.includes('UDP 2223'));
});
