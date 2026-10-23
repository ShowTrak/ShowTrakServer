const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('symetrix-dsp.js'), {});
}

// The version report from the Composer Control Protocol's Setup Commands page.
const VERSION_REPORT = [
  'Firmware Version: V2.000',
  'Build Date: Tue Apr 8 12:36:30 PDT 2014',
  'Internal Build: V8.00',
  'Linux Version: V3.2.0',
  'Dante firmware: F:3.6.4 Sym:5.42',
  'Startup firmware: V2.18',
  'Additional Info:',
  'Linux version 3.2.0-ADI-2012R1-pre-9-pae+ (uclinux-devel@linux-tclw)',
  '(gcc version 4.3.5 (ADI-2010R1-RC4) ) #3119 Tue Nov 19 17:13:55 PST 2013 TCP/IP instance #1 of 4 >',
];

// A fake Symetrix unit on the Composer Control Protocol: CR-terminated
// commands, CR-terminated replies, quiet mode unless $v.
//
// Options:
//   controls   control number -> value (others NAK)
//   preset     GPR value (number)
//   echo       true: echo each command line back first (Echo Mode on)
//   push       a push line sent right after connecting and before each reply
//   fragment   true: write every reply one byte at a time
//   raw        a string to send on connect instead of speaking the protocol
//   silentOn   a command never answered
//   prompt     true: end the version report with the bare " >" prompt and no
//              line end, as the Setup Commands example prints it
//   presets    preset numbers LP accepts (others NAK)
function startUnit(options = {}) {
  const {
    controls = { 101: 0, 205: 40000, 12: 65535 },
    preset = 7,
    echo = false,
    push = null,
    fragment = false,
    raw = null,
    silentOn = null,
    prompt = false,
    presets = [1, 2, 7],
  } = options;
  const received = [];
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const send = (text) => {
        if (!fragment) return socket.write(text);
        for (const ch of text) socket.write(ch);
      };
      if (raw != null) {
        socket.write(raw);
        return;
      }
      if (push) send(push + '\r');
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString('latin1');
        let cr;
        while ((cr = text.indexOf('\r')) >= 0) {
          const line = text.slice(0, cr).trim();
          text = text.slice(cr + 1);
          received.push(line);
          if (line === silentOn) continue;
          let out = echo ? line + '\r' : '';
          if (push) out += push + '\r';
          const cmd = line.replace(/^\$[qve]\s+/, '');
          if (cmd === 'NOP') out += 'ACK\r';
          else if (cmd === 'V' && prompt) {
            out += VERSION_REPORT.slice(0, -1).join('\r') + '\r';
            out += VERSION_REPORT[VERSION_REPORT.length - 1].replace(/ >$/, '') + ' >';
          } else if (cmd === 'V') out += VERSION_REPORT.join('\r') + '\r';
          else if (/^LP \d+$/.test(cmd)) {
            out += presets.includes(Number(cmd.split(' ')[1])) ? 'ACK\r' : 'NAK\r';
          } else if (/^CS \d+ \d+$/.test(cmd)) {
            const [, n, v] = cmd.split(' ').map(Number);
            if (Object.prototype.hasOwnProperty.call(controls, n)) {
              controls[n] = v;
              out += 'ACK\r';
            } else out += 'NAK\r';
          } else if (cmd === 'GPR') out += String(preset).padStart(4, '0') + '\r';
          else if (/^GS2 \d+$/.test(cmd)) {
            const n = Number(cmd.split(' ')[1]);
            out += Object.prototype.hasOwnProperty.call(controls, n)
              ? `${n} ${controls[n]}\r`
              : 'NAK\r';
          } else out += 'NAK\r';
          send(out);
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
            server.close(() => r());
          }),
      });
    });
  });
}

async function withUnit(options, fn) {
  const unit = await startUnit(options);
  try {
    return await fn(unit);
  } finally {
    await unit.close();
  }
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('happy path: NOP, version report and last preset, reads only', async () => {
  const M = load();
  await withUnit({}, async (unit) => {
    const r = await M.Run(target(unit.port));
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.IsSymetrix, true);
    assert.equal(r.Firmware, 'V2.000');
    assert.equal(r.LastPreset, 7);
    assert.ok(r.Version.some((v) => v.Key === 'Dante firmware' && v.Value === 'F:3.6.4 Sym:5.42'));
    assert.deepEqual(unit.received, ['$q NOP', '$v V', '$q NOP', '$q GPR']);
  });
});

test('preset assertion: wrong preset and no preset degrade', async () => {
  const M = load();
  await withUnit({ preset: 3 }, async (unit) => {
    const ok = await M.Run(target(unit.port, { CheckPreset: true, ExpectedPreset: 3 }));
    assert.equal(ok.Degraded, undefined, ok.DegradedReason);
    const bad = await M.Run(target(unit.port, { CheckPreset: true, ExpectedPreset: 7 }));
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /Preset 3 loaded \(expected 7\)/);
  });
  await withUnit({ preset: 0 }, async (unit) => {
    const r = await M.Run(target(unit.port, { CheckPreset: true, ExpectedPreset: 2 }));
    assert.match(r.DegradedReason, /No preset loaded \(expected preset 2\)/);
  });
});

test('control assertions: equality, comparisons, on/off, missing and invalid', async () => {
  const M = load();
  await withUnit({}, async (unit) => {
    const ok = await M.Run(
      target(unit.port, {
        CheckControls: true,
        ControlAssertions: ['101=0', '205 >= 30000', '205<65535', '12=on', '101=off'],
      })
    );
    assert.equal(ok.Degraded, undefined, ok.DegradedReason);
    assert.ok(unit.received.includes('$q GS2 205'));
    // Each number is read once even when asserted twice.
    assert.equal(unit.received.filter((l) => l === '$q GS2 205').length, 1);

    const bad = await M.Run(
      target(unit.port, {
        CheckControls: true,
        ControlAssertions: ['101=65535', '205<30000', '999=0', '12>on', 'abc', '20000=0'],
      })
    );
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /Control 101 is 0 \(expected 65535\)/);
    assert.match(bad.DegradedReason, /Control 205 is 40000 \(expected < 30000\)/);
    assert.match(bad.DegradedReason, /Control 999 not read \(Not in the site file\)/);
    assert.match(bad.DegradedReason, /Invalid control assertion "12>on"/);
    assert.match(bad.DegradedReason, /Invalid control assertion "abc"/);
    assert.match(bad.DegradedReason, /Invalid control assertion "20000=0"/);
  });
});

test('echo mode and pushed data are skipped, fragmented replies reassembled', async () => {
  const M = load();
  await withUnit({ echo: true, push: '#00007=12321', fragment: true }, async (unit) => {
    const r = await M.Run(
      target(unit.port, {
        Timeout: 4000,
        CheckPreset: true,
        ExpectedPreset: 7,
        CheckControls: true,
        ControlAssertions: ['205=40000'],
      })
    );
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.Firmware, 'V2.000');
    assert.equal(r.LastPreset, 7);
    assert.deepEqual(r.Controls, [{ Number: 205, Found: true, Value: 40000 }]);
  });
});

test('wrong device: a reply other than ACK is reachable but degraded', async () => {
  const M = load();
  await withUnit({ raw: 'HTTP/1.1 400 Bad Request\r\n\r\n' }, async (unit) => {
    const r = await M.Run(target(unit.port));
    assert.equal(r.Success, true);
    assert.equal(r.IsSymetrix, false);
    assert.match(r.DegradedReason, /not as a Symetrix control port/);
    assert.equal(r.UnexpectedReply, 'HTTP/1.1 400 Bad Request');
  });
});

test('silent device: offline after the budget', async () => {
  const M = load();
  await withUnit({ raw: '' }, async (unit) => {
    const started = Date.now();
    const r = await M.Run(target(unit.port, { Timeout: 500 }));
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply from the Symetrix unit after 500ms/);
    assert.ok(Date.now() - started < 1500);
  });
});

test('a read that never answers is cut off by the whole-session budget', async () => {
  const M = load();
  await withUnit({ silentOn: '$q GPR' }, async (unit) => {
    const r = await M.Run(target(unit.port, { Timeout: 600, CheckPreset: true }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'The unit did not finish the preset read in time');
    assert.equal(r.Firmware, 'V2.000');
  });
});

test('refused connection is offline and no address is an error', async () => {
  const M = load();
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const r = await M.Run(target(port));
  assert.equal(r.Success, false);
  assert.match(r.Error, /ECONNREFUSED/);
  assert.equal((await M.Run({ Settings: {} })).Error, 'No address configured');
});

test('pure helpers', () => {
  const M = load();
  const { ParsePreset, ParseGs2, ReplyTo, UpToAck, ParseVersionReport } = M._internal;
  assert.equal(ParsePreset('0007'), 7);
  assert.equal(ParsePreset('NAK'), null);
  assert.deepEqual(ParseGs2('368 47114'), { Number: 368, Value: 47114 });
  assert.equal(ParseGs2('#00368=47114'), null);
  assert.equal(
    ReplyTo('$q NOP')('#00001=00002\r$q NOP\rACK\r'),
    '#00001=00002\r$q NOP\rACK\r'.length
  );
  assert.equal(ReplyTo('$q NOP')('#00001=00002\r'), null);
  assert.equal(UpToAck('a: b\rACK\rrest'), 'a: b\rACK\r'.length);
  assert.deepEqual(ParseVersionReport(['TCP/IP instance #1 of 4 >', 'Additional Info:']), []);
});

test('Debug renders healthy, failing controls, offline and escapes device text', async () => {
  const M = load();
  await withUnit({}, async (unit) => {
    const t = target(unit.port, {
      CheckPreset: true,
      ExpectedPreset: 7,
      CheckControls: true,
      ControlAssertions: ['101=0', '999=0'],
    });
    const r = await M.Run(t);
    const html = M.Debug(r, t);
    assert.match(html, /V2\.000/);
    assert.match(html, /Control 101/);
    assert.match(html, /Not in the site file/);
    assert.match(html, /7 \(expected 7\)/);
  });
  const wrong = M.Debug(
    { Success: true, Degraded: true, IsSymetrix: false, UnexpectedReply: '<script>' },
    target(1)
  );
  assert.match(wrong, /&lt;script&gt;/);
  assert.doesNotMatch(wrong, /<script>/);
  assert.match(M.Debug({ Success: false, Error: 'x' }, target(1)), /Offline/);
});

test('version report ending in a bare ">" prompt still completes (ACK glued to it)', async () => {
  const M = load();
  await withUnit({ prompt: true }, async (unit) => {
    const r = await M.Run(target(unit.port, { CheckPreset: true, ExpectedPreset: 7 }));
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.Firmware, 'V2.000');
    assert.equal(r.LastPreset, 7);
  });
  const { UpToAck, ReplyTo } = M._internal;
  assert.equal(UpToAck('x: y\rof 4 >ACK\r'), 'x: y\rof 4 >ACK\r'.length);
  assert.equal(UpToAck('x: y\rof 4 >'), null);
  // A lone prompt mark is not a reply.
  assert.equal(ReplyTo('$q GPR')('>\r0007\r'), '>\r0007\r'.length);
});

// --- Actions ------------------------------------------------------------------

test('actions: declared IDs, params first and Destructive flags', () => {
  const M = load();
  const byId = Object.fromEntries(M.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['preset.load', 'control.set']);
  assert.equal(byId['preset.load'].Destructive, true);
  assert.equal(byId['control.set'].Destructive, true);
  assert.equal(byId['preset.load'].Params[0].Key, 'Preset');
  assert.deepEqual(
    byId['control.set'].Params.map((p) => p.Key),
    ['Control', 'Value']
  );
  for (const a of M.Actions) assert.ok(!a.AllowedWhileOffline);
});

test('Load Preset and Set Control send LP / CS and read ACK; NAK is specific', async () => {
  const M = load();
  await withUnit({ echo: true, push: '#00007=12321' }, async (unit) => {
    const t = target(unit.port);
    assert.deepEqual(await M.RunAction(t, 'preset.load', { Preset: '2' }), {
      Success: true,
      Detail: 'Preset 2 loaded',
    });
    assert.deepEqual(await M.RunAction(t, 'control.set', { Control: '101', Value: '65535' }), {
      Success: true,
      Detail: 'Control 101 set to 65535',
    });
    assert.deepEqual(await M.RunAction(t, 'control.set', { Control: '12', Value: 'off' }), {
      Success: true,
      Detail: 'Control 12 set to 0',
    });
    const noPreset = await M.RunAction(t, 'preset.load', { Preset: '9' });
    assert.equal(noPreset.Success, false);
    assert.match(noPreset.Error, /refused to load preset 9\. Check that it is defined/);
    const noControl = await M.RunAction(t, 'control.set', { Control: '999', Value: '1' });
    assert.equal(noControl.Success, false);
    assert.match(
      noControl.Error,
      /refused control 999\. Check that the number is in the site file/
    );
    assert.deepEqual(unit.received, [
      '$q LP 2',
      '$q CS 101 65535',
      '$q CS 12 0',
      '$q LP 9',
      '$q CS 999 1',
    ]);
  });
});

test('action params are validated before connecting', async () => {
  const M = load();
  await withUnit({}, async (unit) => {
    const t = target(unit.port);
    const bad = [
      ['preset.load', { Preset: '' }, /Preset must be a number from 1 to 1000/],
      ['preset.load', { Preset: '0' }, /Preset must be/],
      ['preset.load', { Preset: '1001' }, /Preset must be/],
      ['preset.load', { Preset: '2\rR!' }, /Preset must be/],
      ['control.set', { Control: '0', Value: '1' }, /Control number must be/],
      ['control.set', { Control: '10001', Value: '1' }, /Control number must be/],
      ['control.set', { Control: '101', Value: '' }, /Value must be/],
      ['control.set', { Control: '101', Value: '65536' }, /Value must be/],
      ['control.set', { Control: '101', Value: '-1' }, /Value must be/],
      ['control.set', { Control: '101', Value: '1\rR!' }, /Value must be/],
      ['nope', {}, /Unknown Symetrix action/],
    ];
    for (const [id, params, re] of bad) {
      const r = await M.RunAction(t, id, params);
      assert.equal(r.Success, false, id);
      assert.match(r.Error, re);
    }
    assert.deepEqual(unit.received, []);
  });
});

test('actions: no answer, wrong device and refused connection', async () => {
  const M = load();
  await withUnit({ silentOn: '$q LP 2' }, async (unit) => {
    const started = Date.now();
    const r = await M.RunAction(target(unit.port, { Timeout: 500 }), 'preset.load', {
      Preset: '2',
    });
    assert.equal(r.Success, false);
    assert.match(r.Error, /did not answer in time\. The command may or may not have been applied/);
    assert.ok(Date.now() - started < 1500);
  });
  await withUnit({ raw: 'HTTP/1.1 400 Bad Request\r\n\r\n' }, async (unit) => {
    const r = await M.RunAction(target(unit.port), 'preset.load', { Preset: '2' });
    assert.equal(r.Success, false);
    assert.match(r.Error, /Unexpected reply "HTTP\/1\.1 400 Bad Request"/);
  });
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const off = await M.RunAction(target(port), 'preset.load', { Preset: '2' });
  assert.match(off.Error, /ECONNREFUSED/);
});

test('each action session is closed as soon as the unit answers', async () => {
  const M = load();
  let open = 0;
  let closedAt = 0;
  const server = net.createServer((socket) => {
    open++;
    socket.on('data', () => socket.write('ACK\r'));
    socket.on('close', () => {
      open--;
      closedAt = Date.now();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const started = Date.now();
  const r = await M.RunAction(target(server.address().port, { Timeout: 5000 }), 'control.set', {
    Control: '1',
    Value: '0',
  });
  assert.equal(r.Success, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(open, 0);
  assert.ok(closedAt - started < 1000);
  await new Promise((r) => server.close(r));
});

test('Set Control stays free text; DescribeAction binds params', () => {
  const M = load();
  assert.equal(M.GetActionOptions, undefined);
  assert.equal(M.DescribeAction('preset.load', { Preset: '3' }), 'Load Preset 3');
  assert.equal(
    M.DescribeAction('control.set', { Control: '101', Value: '65535' }),
    'Set Control 101 to 65535'
  );
  assert.equal(M.DescribeAction('control.set', {}), null);
});
