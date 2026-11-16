const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

const { EncodeOscMessage, ParseOscPacket } = require(methodPath('_osc-shared.js'));

function load() {
  return loadWithMocks(methodPath('dbaudio-ds100.js'), {});
}

function freeUdpPort() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A fake DS100 built from the d&b OSC protocol document (DOC05325 v1.3.12):
// every address is under /dbaudio1, an address with no arguments is a read,
// and the reply goes to a FIXED port (50011 on a real device, `replyPort`
// here) on the sender's IP, never to the port the query came from.
//
// Options (null = stay silent for that address):
//   name, firmware, gnrlerr, errortext, statustext, sample, inputs, outputs,
//   scene (string "major.minor" or an array of args), sceneName, room
//   mutes        { output: 0|1 }
//   names        { output: 'Name' }
//   scenes       list of "major.minor" strings recall/next/previous move through
//   dropFirst    true: ignore the first query for every address (lossy UDP)
//   silent       true: never answer
//   garbage      true: send a junk datagram before every reply
//   ignoreRecall true: accept but ignore scene writes
function startDevice(options) {
  const {
    name = 'Soundscape-A',
    firmware = 'DS100 V3.02.02',
    gnrlerr = 0,
    errortext = 'OK',
    statustext = 'OK',
    sample = 4,
    inputs = 64,
    outputs = 24,
    sceneName = 'Act 1',
    room = 5,
    mutes = {},
    names = {},
    scenes = ['1.00', '2.00', '7.00', '12.05'],
    dropFirst = false,
    silent = false,
    garbage = false,
    ignoreRecall = false,
  } = options;
  let scene = options.scene === undefined ? '1.00' : options.scene;
  const received = [];
  const seen = new Set();
  const state = {
    get scene() {
      return scene;
    },
  };
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const reply = (address, args) => {
      // Read at reply time: withDevice picks the reply port after this binds.
      const { replyPort } = options;
      if (garbage) sock.send(Buffer.from('not osc at all'), replyPort, '127.0.0.1');
      sock.send(EncodeOscMessage(address, args), replyPort, '127.0.0.1');
    };
    sock.on('message', (buf) => {
      for (const msg of ParseOscPacket(buf)) {
        received.push(msg);
        if (silent) continue;
        const p = msg.Address;
        if (p === '/dbaudio1/scene/recall') {
          if (ignoreRecall) continue;
          const [major, minor = 0] = msg.Args;
          const text = `${major}.${String(minor).padStart(2, '0')}`;
          if (scenes.includes(text)) scene = text;
          continue;
        }
        if (p === '/dbaudio1/scene/next' || p === '/dbaudio1/scene/previous') {
          if (ignoreRecall) continue;
          const i = scenes.indexOf(String(scene));
          const j = p.endsWith('next') ? i + 1 : i - 1;
          if (j >= 0 && j < scenes.length) scene = scenes[j];
          continue;
        }
        if (msg.Args.length) continue; // any other write is ignored
        if (dropFirst && !seen.has(p)) {
          seen.add(p);
          continue;
        }
        let args = null;
        if (p === '/dbaudio1/settings/devicename' && name != null) args = [name];
        else if (p === '/dbaudio1/fixed/firmwareversion' && firmware != null) args = [firmware];
        else if (p === '/dbaudio1/error/gnrlerr' && gnrlerr != null) args = [gnrlerr];
        else if (p === '/dbaudio1/error/errortext' && errortext != null) args = [errortext];
        else if (p === '/dbaudio1/status/statustext' && statustext != null) args = [statustext];
        else if (p === '/dbaudio1/status/audionetworksamplestatus' && sample != null)
          args = [sample];
        else if (p === '/dbaudio1/status/matrixinputcount' && inputs != null) args = [inputs];
        else if (p === '/dbaudio1/status/matrixoutputcount' && outputs != null) args = [outputs];
        else if (p === '/dbaudio1/scene/sceneindex' && scene != null)
          args = Array.isArray(scene) ? scene : [scene];
        else if (p === '/dbaudio1/scene/scenename' && sceneName != null) args = [sceneName];
        else if (p === '/dbaudio1/matrixsettings/reverbroomid' && room != null) args = [room];
        else {
          const m = /^\/dbaudio1\/matrixoutput\/(mute|channelname)\/(\d+)$/.exec(p);
          if (m && (outputs == null || Number(m[2]) <= outputs)) {
            args = m[1] === 'mute' ? [mutes[m[2]] ? 1 : 0] : [names[m[2]] || ''];
          }
        }
        if (args) reply(p, args);
      }
    });
    sock.bind(0, '127.0.0.1', () => {
      resolve({
        port: sock.address().port,
        received,
        state,
        close: () => new Promise((r) => sock.close(r)),
      });
    });
  });
}

async function withDevice(options, fn) {
  // Bind the fake first, then pick a reply port it does not hold: a port freed
  // by freeUdpPort can otherwise be handed straight back to the fake.
  const deviceOptions = { ...options };
  const device = await startDevice(deviceOptions);
  let replyPort = await freeUdpPort();
  while (replyPort === device.port) replyPort = await freeUdpPort();
  deviceOptions.replyPort = replyPort;
  const ds100 = load();
  try {
    return await fn(device, ds100, replyPort);
  } finally {
    ds100._internal.Ds100Receiver.Stop();
    await device.close();
  }
}

function target(device, replyPort, settings = {}) {
  return {
    Address: '127.0.0.1',
    Settings: { Port: device.port, ReplyPort: replyPort, Timeout: 1500, ...settings },
  };
}

function run(ds100, device, replyPort, settings) {
  return ds100.Run(target(device, replyPort, settings));
}

test('ds100: reads identity, error, status and sync with read-only queries', async () => {
  await withDevice({}, async (device, ds100, replyPort) => {
    const r = await run(ds100, device, replyPort);
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.DeviceName, 'Soundscape-A');
    assert.equal(r.Model, 'DS100');
    assert.equal(r.Firmware, 'V3.02.02');
    assert.equal(r.GeneralError, false);
    assert.equal(r.StatusText, 'OK');
    assert.equal(r.SampleRate, '48 kHz');
    assert.equal(r.InputCount, 64);
    assert.equal(r.OutputCount, 24);
    assert.equal(r.Scene, '1.00');
    assert.equal(r.SceneName, 'Act 1');
    assert.equal(r.Room, 5);
    assert.equal(r.RoomName, 'Modern – large (KKL Luzern)');
    assert.equal(typeof r.LatencyMs, 'number');
    for (const msg of device.received) {
      assert.match(msg.Address, /^\/dbaudio1\//);
      assert.deepEqual(msg.Args, [], `${msg.Address} must be a read`);
    }
  });
});

test('ds100: completes early when every reply is in', async () => {
  await withDevice({}, async (device, ds100, replyPort) => {
    const started = Date.now();
    const r = await run(ds100, device, replyPort, { Timeout: 5000 });
    assert.equal(r.Success, true);
    assert.ok(Date.now() - started < 2000, 'should not wait for the whole budget');
  });
});

test('ds100: older firmware without the optional reads is still healthy', async () => {
  await withDevice(
    { firmware: null, inputs: null, outputs: null, scene: null, sceneName: null, room: null },
    async (device, ds100, replyPort) => {
      const started = Date.now();
      const r = await run(ds100, device, replyPort, { Timeout: 4000 });
      assert.equal(r.Success, true);
      assert.ok(!r.Degraded, r.DegradedReason);
      assert.equal(r.Firmware, null);
      assert.equal(r.Scene, null);
      assert.equal(r.Room, null);
      assert.ok(Date.now() - started < 2000, 'optional reads must not hold the probe');
    }
  );
});

test('ds100: general error is Degraded with the error text', async () => {
  await withDevice({ gnrlerr: 1, errortext: 'Fan failure' }, async (device, ds100, replyPort) => {
    const r = await run(ds100, device, replyPort);
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'General error: Fan failure');
    const off = await run(ds100, device, replyPort, { CheckError: false });
    assert.ok(!off.Degraded, off.DegradedReason);
  });
});

test('ds100: audio network out of sync is Degraded unless the check is off', async () => {
  await withDevice({ sample: 1 }, async (device, ds100, replyPort) => {
    const r = await run(ds100, device, replyPort);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Audio network not in sync/);
    assert.equal(r.SampleRate, 'Not in sync');
    const off = await run(ds100, device, replyPort, { CheckSync: false });
    assert.ok(!off.Degraded, off.DegradedReason);
  });
});

test('ds100: device name check is case-insensitive and flags another device', async () => {
  await withDevice({}, async (device, ds100, replyPort) => {
    const ok = await run(ds100, device, replyPort, {
      CheckName: true,
      ExpectedName: 'soundscape-a',
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await run(ds100, device, replyPort, {
      CheckName: true,
      ExpectedName: 'Soundscape-B',
    });
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /Name "Soundscape-A" \(expected "Soundscape-B"\)/);
  });
});

test('ds100: scene check compares major.minor and names the loaded scene', async () => {
  await withDevice({ scene: '12.05', sceneName: 'Interval' }, async (device, ds100, replyPort) => {
    const ok = await run(ds100, device, replyPort, { CheckScene: true, ExpectedScene: '12.05' });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await run(ds100, device, replyPort, { CheckScene: true, ExpectedScene: '7' });
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'Scene 12.05 "Interval" (expected 7.00)');
    const junk = await run(ds100, device, replyPort, { CheckScene: true, ExpectedScene: 'abc' });
    assert.match(junk.DegradedReason, /Expected scene "abc" is not a scene number/);
  });
});

test('ds100: scene reply as two ints (the document example) is understood', async () => {
  await withDevice({ scene: [777, 95] }, async (device, ds100, replyPort) => {
    const r = await run(ds100, device, replyPort, { CheckScene: true, ExpectedScene: '777.95' });
    assert.equal(r.Scene, '777.95');
    assert.ok(!r.Degraded, r.DegradedReason);
  });
});

test('ds100: scene check on a device that never answers it waits, then reports', async () => {
  await withDevice({ scene: null }, async (device, ds100, replyPort) => {
    const r = await run(ds100, device, replyPort, {
      Timeout: 700,
      CheckScene: true,
      ExpectedScene: '1',
    });
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Failed to read the current scene/);
  });
});

test('ds100: En-Space room check', async () => {
  await withDevice({ room: 0 }, async (device, ds100, replyPort) => {
    const bad = await run(ds100, device, replyPort, { CheckRoom: true, ExpectedRoom: '5' });
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'En-Space room Off (expected Modern – large (KKL Luzern))');
    const ok = await run(ds100, device, replyPort, { CheckRoom: true, ExpectedRoom: '0' });
    assert.ok(!ok.Degraded, ok.DegradedReason);
  });
});

test('ds100: output mutes with names, and outputs beyond the licence', async () => {
  await withDevice(
    { outputs: 24, mutes: { 2: 1 }, names: { 1: 'Main L', 2: 'Main R' } },
    async (device, ds100, replyPort) => {
      const r = await run(ds100, device, replyPort, {
        Timeout: 1000,
        CheckOutputMutes: true,
        MonitoredOutputs: [1, 2, 40],
      });
      assert.equal(r.Success, true);
      assert.equal(r.Degraded, true);
      assert.match(r.DegradedReason, /Output 2 \(Main R\): muted/);
      assert.match(r.DegradedReason, /Output 40: not on this DS100 \(24 outputs\)/);
      assert.doesNotMatch(r.DegradedReason, /Output 1/);
      const o1 = r.Outputs.find((o) => o.Output === 1);
      assert.deepEqual(o1, { Output: 1, Supported: true, Name: 'Main L', Muted: false });
    }
  );
});

test('ds100: lost datagrams are re-sent until answered, junk packets ignored', async () => {
  await withDevice({ dropFirst: true, garbage: true }, async (device, ds100, replyPort) => {
    const r = await run(ds100, device, replyPort, {
      Timeout: 2000,
      CheckOutputMutes: true,
      MonitoredOutputs: [1],
    });
    assert.equal(r.Success, true);
    assert.ok(!r.Degraded, r.DegradedReason);
    assert.equal(r.DeviceName, 'Soundscape-A');
    assert.equal(r.Outputs[0].Muted, false);
  });
});

test('ds100: a silent device is offline within budget, with the reply-port hint', async () => {
  await withDevice({ silent: true }, async (device, ds100, replyPort) => {
    const started = Date.now();
    const r = await run(ds100, device, replyPort, { Timeout: 600 });
    const took = Date.now() - started;
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply from the DS100 within 600ms/);
    assert.match(r.Error, new RegExp(`UDP ${replyPort}`));
    assert.ok(took < 1500, `took ${took}ms`);
  });
});

test('ds100: replies from another host are ignored', async () => {
  await withDevice({}, async (device, ds100, replyPort) => {
    // The fake answers from 127.0.0.1; probing 127.0.0.2 must not accept it.
    const r = await ds100.Run({
      Address: '127.0.0.2',
      Settings: { Port: device.port, ReplyPort: replyPort, Timeout: 500 },
    });
    assert.equal(r.Success, false);
    // The shared socket survives a probe to an unanswering host.
    const ok = await run(ds100, device, replyPort);
    assert.equal(ok.Success, true, ok.Error);
  });
});

test('ds100: reply port held by another program fails with a clear reason', async () => {
  const blocker = dgram.createSocket('udp4');
  await new Promise((r) => blocker.bind(0, r));
  const busyPort = blocker.address().port;
  const ds100 = load();
  try {
    const r = await ds100.Run({
      Address: '127.0.0.1',
      Settings: { Port: 9, ReplyPort: busyPort, Timeout: 600 },
    });
    assert.equal(r.Success, false);
    assert.match(r.Error, new RegExp(`Failed to listen on UDP port ${busyPort}`));
    assert.match(r.Error, /already in use by another program/);
  } finally {
    ds100._internal.Ds100Receiver.Stop();
    await new Promise((r) => blocker.close(r));
  }
});

test('ds100: the shared socket is closed once nobody probes it', async () => {
  await withDevice({}, async (device, ds100, replyPort) => {
    await run(ds100, device, replyPort);
    const receiver = ds100._internal.Ds100Receiver;
    assert.deepEqual(receiver.OpenPorts(), [replyPort]);
    receiver.Sweep(Date.now() + 1000);
    assert.deepEqual(receiver.OpenPorts(), [replyPort], 'still within the interest TTL');
    receiver.Sweep(Date.now() + 365 * 24 * 3600 * 1000);
    assert.deepEqual(receiver.OpenPorts(), []);
  });
});

test('ds100: config validation', async () => {
  const ds100 = load();
  assert.deepEqual(await ds100.Run({ Address: '', Settings: {} }), {
    Success: false,
    Error: 'No address configured',
  });
  const r = await ds100.Run({ Address: '::1', Settings: { Timeout: 500 } });
  assert.equal(r.Success, false);
  assert.match(r.Error, /IPv4/);
  ds100._internal.Ds100Receiver.Stop();
});

test('ds100: scene text and reply parsing', () => {
  const { ParseSceneText, ParseSceneReply, FormatScene } = load()._internal;
  assert.deepEqual(ParseSceneText('7'), { Major: 7, Minor: 0 });
  assert.deepEqual(ParseSceneText('7.00'), { Major: 7, Minor: 0 });
  assert.deepEqual(ParseSceneText('777.95'), { Major: 777, Minor: 95 });
  assert.deepEqual(ParseSceneText('777 95'), { Major: 777, Minor: 95 });
  assert.equal(ParseSceneText('1000'), null);
  assert.equal(ParseSceneText('7.100'), null);
  assert.equal(ParseSceneText(''), null);
  assert.equal(ParseSceneText('-1'), null);
  assert.deepEqual(ParseSceneReply(['12.05']), { Major: 12, Minor: 5 });
  assert.deepEqual(ParseSceneReply([3]), { Major: 3, Minor: 0 });
  assert.deepEqual(ParseSceneReply([3, 7]), { Major: 3, Minor: 7 });
  assert.equal(ParseSceneReply([]), null);
  assert.equal(ParseSceneReply([1.5]), null);
  assert.equal(FormatScene({ Major: 12, Minor: 5 }), '12.05');
});

test('ds100: actions are Destructive and recall params carry no Default/Min/Max', () => {
  const ds100 = load();
  for (const action of ds100.Actions) {
    assert.equal(action.Destructive, true, action.ID);
    for (const p of action.Params || []) {
      assert.equal(p.Default, undefined, `${action.ID}.${p.Key}`);
      assert.equal(p.Min, undefined, `${action.ID}.${p.Key}`);
      assert.equal(p.Max, undefined, `${action.ID}.${p.Key}`);
    }
  }
  assert.ok(!ds100.Actions.some((a) => /clear/i.test(a.ID)), 'no factory reset action');
});

test('ds100: recall packets use the documented ,i and ,ii forms', () => {
  const { SceneRecallPacket } = load()._internal;
  const [a] = ParseOscPacket(SceneRecallPacket({ Major: 7, Minor: 0 }));
  assert.deepEqual(a, { Address: '/dbaudio1/scene/recall', Args: [7] });
  const [b] = ParseOscPacket(SceneRecallPacket({ Major: 777, Minor: 95 }));
  assert.deepEqual(b, { Address: '/dbaudio1/scene/recall', Args: [777, 95] });
});

test('ds100: recall scene sends once and confirms by reading back', async () => {
  await withDevice({}, async (device, ds100, replyPort) => {
    const r = await ds100.RunAction(target(device, replyPort), 'scene.recall', {
      Major: 12,
      Minor: 5,
    });
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Detail, 'Scene 12.05 (Act 1) recalled');
    assert.equal(device.state.scene, '12.05');
    const writes = device.received.filter((m) => m.Address === '/dbaudio1/scene/recall');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].Args, [12, 5]);
  });
});

test('ds100: recalling a scene that does not exist fails with the reason', async () => {
  await withDevice({}, async (device, ds100, replyPort) => {
    const r = await ds100.RunAction(target(device, replyPort), 'scene.recall', { Major: 99 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /still reports scene 1\.00/);
    assert.match(r.Error, /scene 99\.00 exists in the R1 project/);
  });
});

test('ds100: next and previous scene report the move', async () => {
  await withDevice({ scene: '2.00' }, async (device, ds100, replyPort) => {
    const next = await ds100.RunAction(target(device, replyPort), 'scene.next', {});
    assert.equal(next.Success, true, next.Error);
    assert.match(next.Detail, /Scene 7\.00 .*recalled \(was 2\.00\)/);
    const prev = await ds100.RunAction(target(device, replyPort), 'scene.previous', {});
    assert.equal(prev.Success, true, prev.Error);
    assert.match(prev.Detail, /Scene 2\.00 .*recalled \(was 7\.00\)/);
  });
});

test('ds100: action params are validated and nothing is sent to a silent device', async () => {
  await withDevice({ silent: true }, async (device, ds100, replyPort) => {
    const t = target(device, replyPort, { Timeout: 500 });
    assert.match((await ds100.RunAction(t, 'scene.recall', {})).Error, /Scene number must be/);
    assert.match(
      (await ds100.RunAction(t, 'scene.recall', { Major: 1, Minor: 100 })).Error,
      /Minor number must be 0 to 99/
    );
    assert.match((await ds100.RunAction(t, 'device.clear', {})).Error, /Unknown DS100 action/);
    const r = await ds100.RunAction(t, 'scene.recall', { Major: 1 });
    assert.equal(r.Success, false);
    assert.match(r.Error, /Nothing was sent\.$/);
    assert.ok(!device.received.some((m) => m.Address === '/dbaudio1/scene/recall'));
  });
});

test('ds100: DescribeAction binds the scene', () => {
  const ds100 = load();
  assert.equal(ds100.DescribeAction('scene.recall', { Major: 12, Minor: 5 }), 'Recall Scene 12.05');
  assert.equal(ds100.DescribeAction('scene.recall', { Major: 3, Minor: '' }), 'Recall Scene 3.00');
  assert.equal(ds100.DescribeAction('scene.recall', {}), null);
  assert.equal(ds100.DescribeAction('scene.next', {}), null);
});

test('ds100: Debug escapes every device-supplied value', () => {
  const ds100 = load();
  const evil = '<img src=x onerror=alert(1)>';
  const html = ds100.Debug(
    {
      Success: true,
      Degraded: true,
      DegradedReason: evil,
      LatencyMs: 3,
      DeviceName: evil,
      Model: evil,
      Firmware: evil,
      GeneralError: true,
      ErrorText: evil,
      StatusText: evil,
      SampleStatus: 4,
      SampleRate: evil,
      InputCount: 64,
      OutputCount: 24,
      Scene: evil,
      SceneName: evil,
      RoomName: evil,
      Outputs: [{ Output: 1, Supported: true, Name: evil, Muted: true }],
    },
    {
      Address: evil,
      Settings: { CheckOutputMutes: true, MonitoredOutputs: [1], CheckScene: true },
    }
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  const offline = ds100.Debug({ Success: false, Error: evil }, { Address: evil, Settings: {} });
  assert.doesNotMatch(offline, /<img/);
});

test('ds100: every setting and action note ends with a full stop', () => {
  const ds100 = load();
  const fields = [...ds100.Settings, ...ds100.Actions.flatMap((a) => [a, ...(a.Params || [])])];
  for (const field of fields) {
    if (field.Note) assert.match(field.Note, /\.$/, `${field.Key || field.ID} note`);
  }
});
