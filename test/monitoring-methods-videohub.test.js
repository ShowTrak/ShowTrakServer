const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('videohub.js'), {});
}

// Build a Videohub state dump. Inputs/outputs are 0-based on the wire.
function dump({
  version = '2.8',
  present = 'true',
  model = 'Blackmagic Smart Videohub 12G 40x40',
  friendly = 'Rack A Router',
  inputs = 12,
  outputs = 12,
  inputLabels = {},
  outputLabels = {},
  routing = {},
  locks = {},
  alarms = null,
  endPrelude = true,
} = {}) {
  let out = `PROTOCOL PREAMBLE:\nVersion: ${version}\n\n`;
  if (present !== 'true') return out + `VIDEOHUB DEVICE:\nDevice present: ${present}\n\n`;
  out +=
    'VIDEOHUB DEVICE:\nDevice present: true\n' +
    `Model name: ${model}\nFriendly name: ${friendly}\nUnique ID: 7C2E0D03C49B\n` +
    `Video inputs: ${inputs}\nVideo processing units: 0\nVideo outputs: ${outputs}\n` +
    'Video monitoring outputs: 0\nSerial ports: 0\n\n';
  if (alarms) {
    out += 'ALARM STATUS:\n' + alarms.map(([n, s]) => `${n}: ${s}\n`).join('') + '\n';
  }
  out += 'CONFIGURATION:\nTake Mode: false\n\n';
  const lines = (count, fn) =>
    Array.from({ length: count }, (_, i) => fn(i))
      .map((l) => `${l}\n`)
      .join('');
  out +=
    'INPUT LABELS:\n' + lines(inputs, (i) => `${i} ${inputLabels[i] ?? `Input ${i + 1}`}`) + '\n';
  out +=
    'OUTPUT LABELS:\n' +
    lines(outputs, (i) => `${i} ${outputLabels[i] ?? `Output ${i + 1}`}`) +
    '\n';
  out += 'VIDEO OUTPUT LOCKS:\n' + lines(outputs, (i) => `${i} ${locks[i] ?? 'U'}`) + '\n';
  out += 'VIDEO OUTPUT ROUTING:\n' + lines(outputs, (i) => `${i} ${routing[i] ?? i}`) + '\n';
  if (endPrelude) out += 'END PRELUDE:\n\n';
  return out;
}

// The show patch used by most tests: output 3 (0-based 2) "Proj L" on
// input 7 (0-based 6) "Media A"; input 9 (0-based 8) is "Spare".
const SHOW = {
  inputLabels: { 6: 'Media A', 8: 'Spare' },
  outputLabels: { 2: 'Proj L' },
  routing: { 2: 6 },
};

// A fake Videohub Server: dumps on connect, keeps the connection open like the
// real thing, and records every byte the client sends.
function startVideohub({ text = dump(SHOW), crlf = true, fragment = false } = {}) {
  const payload = text == null ? null : crlf ? text.replace(/\n/g, '\r\n') : text;
  const state = { receivedBytes: 0 };
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => {
        state.receivedBytes += chunk.length;
      });
      if (payload == null) return;
      if (!fragment) {
        socket.write(payload);
        return;
      }
      let i = 0;
      const step = () => {
        if (i >= payload.length || socket.destroyed) return;
        socket.write(payload.slice(i, i + 5));
        i += 5;
        setImmediate(step);
      };
      step();
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
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
  const vh = load();
  const server = await startVideohub(serverOpts);
  try {
    const started = Date.now();
    const result = await vh.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, ...settings },
    });
    // Give any stray write a moment to land before counting.
    await new Promise((r) => setTimeout(r, 20));
    return { vh, result, elapsed: Date.now() - started, sent: server.state.receivedBytes };
  } finally {
    await server.close();
  }
}

test('videohub reads the dump to END PRELUDE without sending a byte', async () => {
  const { result, elapsed, sent } = await runAgainst(
    {},
    {
      CheckRoutes: true,
      ExpectedRoutes: ['3:7'],
    }
  );
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(sent, 0, 'the probe must send nothing');
  assert.ok(elapsed < 1000, `END PRELUDE should settle at once (took ${elapsed}ms)`);
  assert.equal(result.Model, 'Blackmagic Smart Videohub 12G 40x40');
  assert.equal(result.FriendlyName, 'Rack A Router');
  assert.equal(result.ProtocolVersion, '2.8');
  assert.equal(result.VideoInputs, 12);
  assert.equal(result.VideoOutputs, 12);
  assert.equal(result.EndPrelude, true);
  assert.equal(result.TakeMode, false);
  assert.equal(result.Routes.length, 12);
  assert.deepEqual(result.Routes[2], {
    Output: 3,
    OutputLabel: 'Proj L',
    Input: 7,
    InputLabel: 'Media A',
    Lock: 'U',
  });
  assert.equal(result.RouteChecks.length, 1);
  assert.equal(result.RouteChecks[0].Match, true);
});

test('videohub names both numbers and labels in a route mismatch', async () => {
  const { result } = await runAgainst(
    { text: dump({ ...SHOW, routing: { 2: 8 } }) },
    { CheckRoutes: true, ExpectedRoutes: ['3:7'] }
  );
  assert.equal(result.Degraded, true);
  assert.equal(
    result.DegradedReason,
    'Output 3 (Proj L) is on Input 9 (Spare), expected Input 7 (Media A)'
  );
  // Default labels are not repeated in brackets.
  const plain = await runAgainst(
    { text: dump({ routing: { 0: 1 } }) },
    { CheckRoutes: true, ExpectedRoutes: ['1:1'] }
  );
  assert.equal(plain.result.DegradedReason, 'Output 1 is on Input 2, expected Input 1');
});

test('videohub reports malformed and out-of-range expected routes instead of dropping them', async () => {
  const { result } = await runAgainst(
    {},
    { CheckRoutes: true, ExpectedRoutes: ['3:7', 'proj', '0:4', '40:1', '1:99'] }
  );
  assert.equal(result.Degraded, true);
  assert.deepEqual(result.DegradedReason.split('; '), [
    'Expected route "proj" is not in Output:Input form',
    'Expected route "0:4" is not in Output:Input form',
    'Expected route 40:1: the router has 12 outputs',
    'Expected route 1:99: the router has 12 inputs',
  ]);
  // Routes are ignored entirely while CheckRoutes is off.
  const off = await runAgainst({}, { CheckRoutes: false, ExpectedRoutes: ['proj'] });
  assert.ok(!off.result.Degraded);
});

test('videohub settles on a quiet period for firmware without END PRELUDE', async () => {
  const { result, elapsed } = await runAgainst(
    { text: dump({ ...SHOW, version: '2.3', endPrelude: false }) },
    { Timeout: 3000, CheckRoutes: true, ExpectedRoutes: ['3:7'] }
  );
  assert.equal(result.Success, true);
  assert.ok(!result.Degraded, result.DegradedReason);
  assert.equal(result.EndPrelude, false);
  assert.ok(
    elapsed < 1500,
    `quiet period should settle well inside the budget (took ${elapsed}ms)`
  );
});

test('videohub degrades when no router is attached or it needs a firmware update', async () => {
  const absent = await runAgainst({ text: dump({ present: 'false' }) }, { Timeout: 3000 });
  assert.equal(absent.result.Success, true);
  assert.equal(absent.result.Degraded, true);
  assert.equal(absent.result.DegradedReason, 'No router connected to the Videohub Server');
  assert.ok(absent.elapsed < 1000, 'Device present: false should settle at once');

  const update = await runAgainst({ text: dump({ present: 'needs_update' }) });
  assert.equal(update.result.Degraded, true);
  assert.match(update.result.DegradedReason, /firmware needs updating/);
});

test('videohub CheckAlarms (default on) surfaces non-ok alarms', async () => {
  const alarms = [
    ['Fan 0', 'ok'],
    ['Power Supply Slot 1', 'fail'],
  ];
  const on = await runAgainst({ text: dump({ ...SHOW, alarms }) });
  assert.equal(on.result.Degraded, true);
  assert.equal(on.result.DegradedReason, 'Power Supply Slot 1 alarm: fail');
  assert.equal(on.result.Alarms.length, 2);

  const off = await runAgainst({ text: dump({ ...SHOW, alarms }) }, { CheckAlarms: false });
  assert.ok(!off.result.Degraded);

  const allOk = await runAgainst({ text: dump({ ...SHOW, alarms: [['Fan 0', 'ok']] }) });
  assert.ok(!allOk.result.Degraded);
});

test('videohub reassembles a dump delivered in tiny fragments, LF or CR LF', async () => {
  const lf = await runAgainst(
    { fragment: true, crlf: false },
    { CheckRoutes: true, ExpectedRoutes: ['3:7'] }
  );
  assert.ok(!lf.result.Degraded, lf.result.DegradedReason);
  assert.equal(lf.result.Routes.length, 12);
  const crlf = await runAgainst({ fragment: true }, { CheckRoutes: true, ExpectedRoutes: ['3:7'] });
  assert.ok(!crlf.result.Degraded, crlf.result.DegradedReason);
  assert.equal(crlf.result.Routes[2].OutputLabel, 'Proj L');
});

test('videohub degrades when the responder is not a Videohub', async () => {
  const { result } = await runAgainst({ text: 'HTTP/1.1 400 Bad Request\n\n' });
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.match(result.DegradedReason, /does not look like a Videohub/);
});

test('videohub is offline when the port is silent or refused', async () => {
  const silent = await runAgainst({ text: null }, { Timeout: 600 });
  assert.equal(silent.result.Success, false);
  assert.match(silent.result.Error, /No reply from Videohub/);

  const vh = load();
  const tmp = await startVideohub();
  const port = tmp.port;
  await tmp.close();
  const refused = await vh.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 1000 } });
  assert.equal(refused.Success, false);
  assert.equal(refused.Degraded, true);
});

test('videohub reports a dump cut short by the budget', async () => {
  // Preamble and device only, then silence: routes cannot be checked.
  const partial = dump(SHOW).split('INPUT LABELS:')[0];
  const { result } = await runAgainst(
    { text: partial },
    { Timeout: 600, CheckRoutes: true, ExpectedRoutes: ['3:7'] }
  );
  assert.equal(result.Success, true);
  assert.equal(result.Degraded, true);
  assert.equal(result.DegradedReason, 'Routing table not received');
});

test('videohub Debug escapes device strings and shows route pills and the table', async () => {
  const { vh, result } = await runAgainst(
    {
      text: dump({
        ...SHOW,
        model: '<script>alert(1)</script>',
        outputLabels: { 2: '<img src=x onerror=1>' },
        routing: { 2: 8 },
        locks: { 4: 'L' },
      }),
    },
    { CheckRoutes: true, ExpectedRoutes: ['3:7', 'junk'] }
  );
  const target = {
    Address: '127.0.0.1',
    Settings: { Port: 9990, CheckRoutes: true, ExpectedRoutes: ['3:7', 'junk'] },
  };
  const html = vh.Debug(result, target);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /Mismatch/);
  assert.match(html, /Invalid/);
  assert.match(html, /Expected routes \(2\)/);
  assert.match(html, /Routing \(12 outputs\)/);
  assert.match(html, /locked/);

  const offline = vh.Debug({ Success: false, Error: '<b>x</b>' }, { Address: 'h', Settings: {} });
  assert.ok(!offline.includes('<b>x</b>'));
  assert.match(offline, /Offline/);
});

test('videohub NormalizeSettings tidies valid routes and keeps malformed ones', () => {
  const vh = load();
  const out = vh.NormalizeSettings({ Port: 9990, ExpectedRoutes: ['03 : 7', '4:8, 5:9;bad', ''] });
  assert.deepEqual(out.ExpectedRoutes, ['3:7', '4:8', '5:9', 'bad']);
  assert.equal(out.Port, 9990);
  assert.deepEqual(vh.NormalizeSettings({ ExpectedRoutes: '1:2,2:3' }).ExpectedRoutes, [
    '1:2',
    '2:3',
  ]);
  assert.deepEqual(vh.NormalizeSettings(null), {});
});

test('videohub settings defaults', () => {
  const vh = load();
  assert.equal(vh.ID, 'videohub');
  assert.equal(vh.Group, 'Video');
  const byKey = Object.fromEntries(vh.Settings.map((f) => [f.Key, f]));
  assert.equal(byKey.Port.Default, 9990);
  assert.equal(byKey.CheckAlarms.Default, true);
  assert.equal(byKey.CheckRoutes.Default, false);
  assert.equal(byKey.ExpectedRoutes.Type, 'list');
  assert.deepEqual(byKey.ExpectedRoutes.VisibleWhen, { Key: 'CheckRoutes', Equals: true });
  assert.equal(byKey.Timeout.Default, 4000);
  const opts = vh._internal.ParseHealthOptions({ Settings: {} });
  assert.equal(opts.CheckAlarms, true);
  assert.equal(opts.CheckRoutes, false);
});

test('videohub ApplyBlock merges status updates and ignores unknown blocks', () => {
  const { ApplyBlock, EmptySnapshot, ParseExpectedRoute, DescribePort } = load()._internal;
  const snap = EmptySnapshot();
  ApplyBlock(snap, { Header: 'OUTPUT LABELS:', Lines: ['0 Left', '1 Right'] });
  ApplyBlock(snap, { Header: 'OUTPUT LABELS:', Lines: ['1 Centre'] });
  assert.deepEqual(snap.OutputLabels, { 0: 'Left', 1: 'Centre' });
  ApplyBlock(snap, { Header: 'VIDEO OUTPUT ROUTING:', Lines: ['0 5', 'junk', '1 x'] });
  assert.deepEqual(snap.Routing, { 0: 5 });
  ApplyBlock(snap, { Header: 'INPUT LABELS:', Lines: ['3'] }); // blank label
  assert.equal(snap.InputLabels[3], '');
  ApplyBlock(snap, { Header: 'SOMETHING NEW:', Lines: ['a b'] });
  ApplyBlock(snap, { Header: 'ALARM STATUS:', Lines: ['Fan 0: ok'] });
  ApplyBlock(snap, { Header: 'ALARM STATUS:', Lines: ['Fan 0: fail'] });
  assert.deepEqual(snap.Alarms, [{ Name: 'Fan 0', Status: 'fail' }]);

  assert.deepEqual(ParseExpectedRoute(' 3 : 7 '), { Output: 3, Input: 7 });
  assert.equal(ParseExpectedRoute('3-7'), null);
  assert.equal(ParseExpectedRoute('0:1'), null);
  assert.equal(DescribePort('Output', 2, { 2: 'Proj L' }), 'Output 3 (Proj L)');
  assert.equal(DescribePort('Input', 0, { 0: 'input 1' }), 'Input 1');
});

test('blackmagic shared block framing', () => {
  const shared = loadWithMocks(methodPath('_blackmagic-shared.js'), {});
  const { TakeBlock, SplitBlocks, ParseFields } = shared._internal;
  assert.equal(TakeBlock('VIDEOHUB DEVICE:\nDevice present: true\n', false), null);
  const taken = TakeBlock('\nEND PRELUDE:\n\nNEXT', false);
  assert.deepEqual(taken.Block, { Header: 'END PRELUDE:', Lines: [] });
  assert.equal(taken.Consumed, '\nEND PRELUDE:\n\n'.length);
  // Videohub ACK is blank-terminated; HyperDeck single lines are not.
  assert.equal(TakeBlock('ACK\n', false), null);
  assert.equal(TakeBlock('200 ok\n', true).Block.Header, '200 ok');
  const { Blocks, Rest } = SplitBlocks('A:\n1 x\n\nB:\n\nC:\n2', false);
  assert.deepEqual(
    Blocks.map((b) => b.Header),
    ['A:', 'B:']
  );
  assert.equal(Rest, 'C:\n2');
  assert.deepEqual(ParseFields(['Model Name: X', 'nope', 'timecode: 01:02:03:04']), {
    'model name': 'X',
    timecode: '01:02:03:04',
  });
});
