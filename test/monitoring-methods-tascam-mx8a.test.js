const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('tascam-mx8a.js'), {});
}

function defaultState() {
  const state = {
    'DEVICE/MODELNAME': '"MX-8A"',
    'DEVICE/NAME': '"Rack A"',
    'DEVICE/VER/SYSTEM': 'V1.10B0022',
    'DEVICE/SERIAL': 'AB12CD34',
    'DEVICE/SAMPLE': '48000',
    'TESTTONE/ENABLE': 'OFF',
    'METER/TOTAL': '0',
    'METER/INTERVAL': '100',
  };
  for (let n = 1; n <= 8; n++) {
    state[`ANLGIN/${n}/MUTE`] = 'OFF';
    state[`ANLGIN/${n}/NAME`] = `"Input${n}"`;
    state[`MIX/${n}/MUTE`] = 'OFF';
    state[`MIX/${n}/NAME`] = `"Mix${n}"`;
    state[`ANLGOUT/${n}/MUTE`] = 'OFF';
    state[`ANLGOUT/${n}/NAME`] = `"Output${n}"`;
    state[`ANLGOUT/${n}/TESTTONE`] = 'OFF';
    state[`ANLGIN/${n}/METER/PRE`] = 'OFF';
  }
  return state;
}

// A fake MX-8A on the Ethernet protocol: CR+LF lines, a password login, then
// `GET k …` → `OK GET k:v …` and `SET k:v …` → `OK SET` plus a NOTIFY.
//
// Options:
//   state      key → value overrides (values as sent, names quoted)
//   password   the network password ('' = none)
//   busy       true: answer the first line with "Another User Already Connected" and hang up
//   push       true: send a NOTIFY and a METER line before every reply
//   fragment   true: write every reply one byte at a time
//   raw        a string to send on connect instead of speaking the protocol
//   silentOn   a command line never answered
//   rejectKeys keys a SET refuses with ERR2
//   levels     input number → meter value (hex) sent while metering
//   single     true: like the real unit, a second connection while one is open
//              is told "Another User Already Connected" and hung up on
function startUnit(options = {}) {
  const {
    password = '',
    busy = false,
    push = false,
    fragment = false,
    raw = null,
    silentOn = null,
    rejectKeys = [],
    levels = {},
    single = false,
  } = options;
  const state = { ...defaultState(), ...(options.state || {}) };
  const received = [];
  const stats = { connections: 0, open: 0 };
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      const turnedAway = single && stats.open > 0;
      stats.connections++;
      if (!turnedAway) stats.open++;
      sockets.add(socket);
      let meterTimer = null;
      let meterStop = null;
      const stopMeters = () => {
        clearInterval(meterTimer);
        clearTimeout(meterStop);
        meterTimer = null;
      };
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        stopMeters();
        if (!turnedAway) stats.open--;
      });
      const send = (text) => {
        if (!fragment) return socket.write(text);
        for (const ch of Buffer.from(text)) socket.write(Buffer.from([ch]));
      };
      if (raw != null) {
        socket.write(raw);
        return;
      }
      let stage = 'connected';
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        let end;
        while ((end = text.indexOf('\r\n')) >= 0) {
          const line = text.slice(0, end);
          text = text.slice(end + 2);
          received.push(line);
          if (line === silentOn) continue;
          if (stage === 'connected') {
            if (busy || turnedAway) {
              socket.end('Another User Already Connected\r\n');
              return;
            }
            stage = 'password';
            send('Enter Password\r\n');
            continue;
          }
          if (stage === 'password') {
            if (line === password) {
              stage = 'in';
              send('Login Successful\r\n');
            } else {
              send('Login Failed\r\n');
              socket.end();
            }
            continue;
          }
          let out = push ? 'NOTIFY ANLGIN/1/FADER:-3.0\r\nMETER MIX/1/METER:4026E73C\r\n' : '';
          const [type, ...params] = line.split(' ');
          if (type === 'GET') {
            out += `OK GET ${params.map((k) => `${k}:${k in state ? state[k] : 'ERR1'}`).join(' ')}\r\n`;
          } else if (type === 'SET') {
            if (params[0] === 'DEVICE/RESET:BOOT') {
              socket.destroy();
              return;
            }
            const errors = [];
            const changed = [];
            for (const p of params) {
              const [k, v] = p.split(':');
              if (!(k in state) && k !== 'DEVICE/IDENTIFY') errors.push(`${k}:ERR1`);
              else if (rejectKeys.includes(k)) errors.push(`${k}:ERR2`);
              else {
                state[k] = v;
                changed.push(p);
              }
            }
            out += errors.length ? `OK SET ${errors.join(' ')}\r\n` : 'OK SET\r\n';
            if (changed.length) out += `NOTIFY ${changed.join(' ')}\r\n`;
            if (changed.some((p) => p.startsWith('METER/TOTAL:'))) {
              stopMeters();
              const total = Number(state['METER/TOTAL']);
              if (total > 0) {
                meterTimer = setInterval(
                  () => {
                    const keys = Object.keys(state).filter(
                      (k) => /^ANLGIN\/\d\/METER\/PRE$/.test(k) && state[k] === 'ON'
                    );
                    if (!keys.length || socket.destroyed) return;
                    const values = keys.map((k) => `${k}:${levels[k.split('/')[1]] || '00000000'}`);
                    socket.write(`METER ${values.join(' ')}\r\n`);
                  },
                  Number(state['METER/INTERVAL']) || 100
                );
                meterStop = setTimeout(stopMeters, total);
              }
            }
          } else {
            out += `NG ${line}\r\n`;
          }
          send(out);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        state,
        stats,
        dropAll: () => {
          for (const s of sockets) s.destroy();
        },
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

test('happy path: login, device read, reads only', async () => {
  const M = load();
  await withUnit({}, async (unit) => {
    const r = await M.Run(target(unit.port));
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.Login, 'ok');
    assert.equal(r.Model, 'MX-8A');
    assert.equal(r.DeviceName, 'Rack A');
    assert.equal(r.Firmware, 'V1.10B0022');
    assert.equal(r.Serial, 'AB12CD34');
    assert.equal(r.SampleRate, 48000);
    assert.equal(r.TestTone, false);
    assert.equal(r.Mutes, null);
    assert.deepEqual(unit.received, [
      '',
      '',
      'GET DEVICE/MODELNAME DEVICE/NAME DEVICE/VER/SYSTEM DEVICE/SERIAL DEVICE/SAMPLE TESTTONE/ENABLE',
    ]);
    assert.ok(unit.received.every((l) => !l.startsWith('SET')));
  });
});

test('password is sent after the prompt; a wrong one is degraded, not offline', async () => {
  const M = load();
  await withUnit({ password: 'secret' }, async (unit) => {
    const ok = await M.Run(target(unit.port, { Password: 'secret' }));
    assert.equal(ok.Degraded, undefined, ok.DegradedReason);
    assert.equal(unit.received[1], 'secret');
    const bad = await M.Run(target(unit.port, { Password: 'nope' }));
    assert.equal(bad.Success, true);
    assert.equal(bad.Login, 'refused');
    assert.match(bad.DegradedReason, /refused the password \("Login Failed"\)/);
  });
  const M2 = load();
  const r = await M2.Run(target(1, { Password: 'a\r\nGET X' }));
  assert.equal(r.Error, 'The password cannot contain line breaks');
});

test('another controller connected: online, not degraded, nothing read', async () => {
  const M = load();
  await withUnit({ busy: true }, async (unit) => {
    const r = await M.Run(target(unit.port, { CheckMutes: true, MonitoredInputs: [1] }));
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.Login, 'busy');
    assert.equal(r.Model, null);
    assert.match(M.Debug(r, target(unit.port)), /only control connection/);
  });
});

test('test tone on degrades by default and names the outputs; can be turned off', async () => {
  const M = load();
  const state = {
    'TESTTONE/ENABLE': 'ON',
    'ANLGOUT/2/TESTTONE': 'ON',
    'ANLGOUT/5/TESTTONE': 'ON',
  };
  await withUnit({ state }, async (unit) => {
    const r = await M.Run(target(unit.port));
    assert.equal(r.Degraded, true);
    assert.equal(r.DegradedReason, 'Test tone is on (outputs 2, 5)');
    assert.deepEqual(r.TestToneOutputs, [2, 5]);
    const off = await M.Run(target(unit.port, { CheckTestTone: false }));
    assert.equal(off.Degraded, undefined, off.DegradedReason);
  });
});

test('mute checks: muted channels named, unknown keys and invalid entries reported', async () => {
  const M = load();
  const state = {
    'ANLGIN/3/MUTE': 'ON',
    'ANLGIN/3/NAME': '"Lectern Mic"',
    'ANLGOUT/8/MUTE': 'ON',
  };
  await withUnit({ state }, async (unit) => {
    delete unit.state['MIX/2/MUTE'];
    const r = await M.Run(
      target(unit.port, {
        CheckMutes: true,
        MonitoredInputs: [1, 3, 3],
        MonitoredMixes: [2],
        MonitoredOutputs: [8, 9],
      })
    );
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Input 3 \(Lectern Mic\) is muted/);
    assert.match(r.DegradedReason, /Output 8 \(Output8\) is muted/);
    assert.match(r.DegradedReason, /Mix 2 mute not read \(not available on this unit\)/);
    assert.match(r.DegradedReason, /Invalid channel "Output 9" \(use 1 to 8\)/);
    assert.doesNotMatch(r.DegradedReason, /Input 1/);
    assert.ok(
      unit.received.includes('GET ANLGIN/1/MUTE ANLGIN/3/MUTE MIX/2/MUTE ANLGOUT/8/MUTE'),
      unit.received.join('\n')
    );
    // Names are only read for the muted channels.
    assert.ok(unit.received.includes('GET ANLGIN/3/NAME ANLGOUT/8/NAME'));
  });
});

test('names are read four to a GET', async () => {
  const M = load();
  const state = {};
  for (let n = 1; n <= 6; n++) state[`ANLGIN/${n}/MUTE`] = 'ON';
  await withUnit({ state }, async (unit) => {
    const r = await M.Run(
      target(unit.port, { CheckMutes: true, MonitoredInputs: [1, 2, 3, 4, 5, 6] })
    );
    assert.equal(r.Mutes.filter((m) => m.Name).length, 6);
    const nameGets = unit.received.filter(
      (l) => l.startsWith('GET ANLGIN/') && l.endsWith('/NAME')
    );
    assert.deepEqual(nameGets, [
      'GET ANLGIN/1/NAME ANLGIN/2/NAME ANLGIN/3/NAME ANLGIN/4/NAME',
      'GET ANLGIN/5/NAME ANLGIN/6/NAME',
    ]);
  });
});

test('pushed NOTIFY / METER lines are skipped, fragmented UTF-8 reassembled', async () => {
  const M = load();
  const state = { 'ANLGIN/1/MUTE': 'ON', 'ANLGIN/1/NAME': '"Bühne Mic"' };
  await withUnit({ push: true, fragment: true, state }, async (unit) => {
    const r = await M.Run(
      target(unit.port, { Timeout: 4000, CheckMutes: true, MonitoredInputs: [1] })
    );
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Model, 'MX-8A');
    assert.equal(r.DegradedReason, 'Input 1 (Bühne Mic) is muted');
  });
});

test('wrong device: a reply other than the login prompt is reachable but degraded', async () => {
  const M = load();
  await withUnit({ raw: 'HTTP/1.1 400 Bad Request\r\n\r\n' }, async (unit) => {
    const r = await M.Run(target(unit.port));
    assert.equal(r.Success, true);
    assert.equal(r.Login, 'unexpected');
    assert.equal(r.LoginReply, 'HTTP/1.1 400 Bad Request');
    assert.match(r.DegradedReason, /not as a TASCAM MX-8A control port/);
  });
});

test('silent device: offline after the budget', async () => {
  const M = load();
  await withUnit({ raw: '' }, async (unit) => {
    const started = Date.now();
    const r = await M.Run(target(unit.port, { Timeout: 500 }));
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply from the MX-8A after 500ms/);
    assert.ok(Date.now() - started < 1500);
  });
});

test('a read that never answers is cut off by the whole-session budget', async () => {
  const M = load();
  await withUnit({ silentOn: 'GET ANLGIN/2/MUTE' }, async (unit) => {
    const r = await M.Run(
      target(unit.port, { Timeout: 600, CheckMutes: true, MonitoredInputs: [2] })
    );
    assert.equal(r.Success, true);
    assert.equal(r.DegradedReason, 'The unit did not finish the mute read in time');
    assert.equal(r.Model, 'MX-8A');
  });
});

test('refused connection is offline-degraded and no address is an error', async () => {
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
  const { SplitParams, ParseReply, NextReplyLine, FormatFirmware } = M._internal;
  assert.deepEqual(SplitParams('A:"x y" B:ON'), ['A:"x y"', 'B:ON']);
  assert.deepEqual(ParseReply('OK GET CID:12345678 ANLGIN/1/MUTE:ON ANLGIN/1/NAME:"a b"'), {
    Type: 'GET',
    Values: { 'ANLGIN/1/MUTE': 'ON', 'ANLGIN/1/NAME': 'a b' },
  });
  // The spec's error example has no leading OK.
  assert.deepEqual(ParseReply('GET ANLGIN/1/MUTEE:ERR1').Values, { 'ANLGIN/1/MUTEE': 'ERR1' });
  assert.deepEqual(ParseReply('OK SET'), { Type: 'SET', Values: {} });
  assert.equal(ParseReply('NG PUT ANLGIN/1/MUTE:ON'), null);
  assert.equal(NextReplyLine('NOTIFY A:1\r\nMETER B:2\r\n'), null);
  assert.equal(NextReplyLine('NOTIFY A:1\r\nOK SET\r\nrest'), 'NOTIFY A:1\r\nOK SET\r\n'.length);
  assert.equal(FormatFirmware('V1.00B0010'), '1.00 (build 0010)');
  assert.equal(FormatFirmware('weird'), 'weird');
});

test('Debug renders healthy, mutes, offline and escapes device text', async () => {
  const M = load();
  const state = { 'ANLGIN/3/MUTE': 'ON', 'ANLGIN/3/NAME': '"<b>Mic</b>"' };
  await withUnit({ state }, async (unit) => {
    const t = target(unit.port, { CheckMutes: true, MonitoredInputs: [1, 3] });
    const r = await M.Run(t);
    const html = M.Debug(r, t);
    assert.match(html, /1\.10 \(build 0022\)/);
    assert.match(html, /48 kHz/);
    assert.match(html, /Input 3 \(&lt;b&gt;Mic&lt;\/b&gt;\)/);
    assert.doesNotMatch(html, /<b>Mic/);
  });
  const wrong = M.Debug(
    { Success: true, Degraded: true, Login: 'unexpected', LoginReply: '<script>' },
    target(1)
  );
  assert.match(wrong, /&lt;script&gt;/);
  assert.doesNotMatch(wrong, /<script>/);
  assert.match(M.Debug({ Success: false, Error: 'x' }, target(1)), /Offline/);
});

// --- Actions ------------------------------------------------------------------

test('actions: declared IDs and Destructive flags', () => {
  const M = load();
  const byId = Object.fromEntries(M.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), [
    'identify',
    'testtone.off',
    'input.mute',
    'input.unmute',
    'mix.mute',
    'mix.unmute',
    'output.mute',
    'output.unmute',
    'reboot',
  ]);
  const destructive = M.Actions.filter((a) => a.Destructive).map((a) => a.ID);
  assert.deepEqual(destructive, ['input.mute', 'mix.mute', 'output.mute', 'reboot']);
  for (const a of M.Actions) assert.ok(!a.AllowedWhileOffline);
});

test('actions log in, send one SET and read OK SET; refusals are specific', async () => {
  const M = load();
  await withUnit({ password: 'pw', push: true, rejectKeys: ['ANLGOUT/4/MUTE'] }, async (unit) => {
    const t = target(unit.port, { Password: 'pw' });
    assert.deepEqual(await M.RunAction(t, 'input.mute', { Channel: 3 }), {
      Success: true,
      Detail: 'Input 3 muted',
    });
    assert.equal(unit.state['ANLGIN/3/MUTE'], 'ON');
    assert.deepEqual(await M.RunAction(t, 'mix.unmute', { Channel: '2' }), {
      Success: true,
      Detail: 'Mix bus 2 unmuted',
    });
    assert.deepEqual(await M.RunAction(t, 'identify', {}), {
      Success: true,
      Detail: 'Identifying',
    });
    assert.deepEqual(await M.RunAction(t, 'testtone.off', {}), {
      Success: true,
      Detail: 'Test tone off',
    });
    const refused = await M.RunAction(t, 'output.mute', { Channel: 4 });
    assert.equal(refused.Success, false);
    assert.match(refused.Error, /refused ANLGOUT\/4\/MUTE \(value refused\)/);
    assert.deepEqual(
      unit.received.filter((l) => l.startsWith('SET')),
      [
        'SET ANLGIN/3/MUTE:ON',
        'SET MIX/2/MUTE:OFF',
        'SET DEVICE/IDENTIFY:EXE',
        'SET TESTTONE/ENABLE:OFF',
        'SET ANLGOUT/4/MUTE:ON',
      ]
    );
  });
});

test('reboot counts a dropped connection as done', async () => {
  const M = load();
  await withUnit({}, async (unit) => {
    assert.deepEqual(await M.RunAction(target(unit.port), 'reboot', {}), {
      Success: true,
      Detail: 'Rebooting',
    });
  });
});

test('actions: busy, wrong password and bad params', async () => {
  const M = load();
  await withUnit({ busy: true }, async (unit) => {
    const r = await M.RunAction(target(unit.port), 'identify', {});
    assert.equal(r.Success, false);
    assert.match(r.Error, /holds the unit’s only control connection/);
  });
  await withUnit({ password: 'pw' }, async (unit) => {
    const r = await M.RunAction(target(unit.port, { Password: 'x' }), 'identify', {});
    assert.match(r.Error, /refused the password/);
  });
  await withUnit({}, async (unit) => {
    const t = target(unit.port);
    for (const [id, params] of [
      ['input.mute', {}],
      ['input.mute', { Channel: '' }],
      ['input.mute', { Channel: 0 }],
      ['mix.mute', { Channel: 9 }],
      ['output.mute', { Channel: '1 ANLGIN/2/MUTE:ON' }],
      ['output.mute', { Channel: 1.5 }],
      ['output.mute', { Channel: true }],
    ]) {
      const r = await M.RunAction(t, id, params);
      assert.equal(r.Success, false, `${id} ${JSON.stringify(params)}`);
      assert.match(r.Error, /number must be a number from 1 to 8/);
    }
    assert.match((await M.RunAction(t, 'nope', {})).Error, /Unknown MX-8A action/);
    assert.deepEqual(unit.received, []);
  });
});

test('DescribeAction binds the channel', () => {
  const M = load();
  assert.equal(M.DescribeAction('input.mute', { Channel: 3 }), 'Mute Input 3');
  assert.equal(M.DescribeAction('mix.unmute', { Channel: '2' }), 'Unmute Mix Bus 2');
  assert.equal(M.DescribeAction('input.mute', {}), null);
  assert.equal(M.DescribeAction('reboot', {}), 'Reboot');
  assert.equal(M.DescribeAction('nope', {}), null);
});

// --- Live levels ----------------------------------------------------------------

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('HasLiveLevels follows the toggle; MeterToDb reads the spec table', () => {
  const M = load();
  assert.equal(M.HasLiveLevels(target(1)), false);
  assert.equal(M.HasLiveLevels(target(1, { ReadLevels: true })), true);
  const { MeterToDb } = M._internal;
  assert.equal(MeterToDb('80000000'), 0);
  assert.equal(MeterToDb('4026E73C'), -6);
  assert.equal(MeterToDb('0020C49B'), -60);
  assert.equal(MeterToDb('00000000'), null);
  assert.equal(MeterToDb('zz'), null);
});

test('live levels: meters stream, the check reads over the same connection, and stopping restores', async () => {
  const M = load();
  const state = { 'ANLGIN/2/NAME': '"Lectern Mic"', 'ANLGIN/5/METER/PRE': 'ON' };
  const levels = { 1: '80000000', 2: '4026E73C' };
  await withUnit({ state, levels, single: true }, async (unit) => {
    const t = target(unit.port, { ReadLevels: true, CheckMutes: true, MonitoredInputs: [1] });
    const frames = [];
    const stop = M.StartLiveLevels(t, (f) => frames.push(f));
    assert.equal(frames[0].State, 'connecting');

    const live = await waitFor(() => frames.find((f) => f.State === 'live'));
    assert.equal(live.Channels.length, 8);
    assert.equal(live.Channels[1].Label, 'Lectern Mic');
    assert.equal(live.Channels[0].Label, 'Input1');
    assert.equal(live.Channels[0].Db, 0);
    assert.equal(live.Channels[1].Db, -6);
    assert.equal(live.Channels[2].Db, null);

    // The single-connection unit would turn a second session away; the check
    // rides on the live one instead.
    const r = await M.Run(t);
    assert.equal(r.Login, 'ok', r.DegradedReason);
    assert.equal(r.Model, 'MX-8A');
    assert.equal(unit.stats.connections, 1);

    stop();
    await waitFor(() => unit.stats.open === 0);
    const sets = unit.received.filter((l) => l.startsWith('SET'));
    assert.ok(sets.includes('SET METER/TOTAL:10000 METER/INTERVAL:100'), sets.join('\n'));
    assert.equal(sets[sets.length - 2], 'SET METER/TOTAL:0');
    // Input 5's meter switch was already on, so it is left on.
    assert.equal(
      sets[sets.length - 1],
      'SET ' + [1, 2, 3, 4, 6, 7, 8].map((n) => `ANLGIN/${n}/METER/PRE:OFF`).join(' ')
    );
    assert.equal(unit.state['ANLGIN/5/METER/PRE'], 'ON');
    assert.equal(unit.state['ANLGIN/1/METER/PRE'], 'OFF');
    assert.equal(M._internal.LiveSessions.size, 0);
  });
});

test('live levels: two viewers share one connection', async () => {
  const M = load();
  await withUnit({ single: true, levels: { 1: '80000000' } }, async (unit) => {
    const t = target(unit.port, { ReadLevels: true });
    const a = [];
    const b = [];
    const stopA = M.StartLiveLevels(t, (f) => a.push(f));
    const stopB = M.StartLiveLevels(t, (f) => b.push(f));
    await waitFor(() => a.some((f) => f.State === 'live') && b.some((f) => f.State === 'live'));
    assert.equal(unit.stats.connections, 1);
    stopA();
    assert.equal(M._internal.LiveSessions.size, 1);
    stopB();
    await waitFor(() => unit.stats.open === 0);
  });
});

test('live levels: another controller connected is reported, not hidden', async () => {
  const M = load();
  await withUnit({ busy: true }, async (unit) => {
    const frames = [];
    const stop = M.StartLiveLevels(target(unit.port, { ReadLevels: true }), (f) => frames.push(f));
    const problem = await waitFor(() => frames.find((f) => f.State === 'unavailable'));
    assert.match(problem.Message, /only control connection/);
    stop();
  });
  const frames = [];
  M.StartLiveLevels({ Settings: { ReadLevels: true } }, (f) => frames.push(f))();
  assert.deepEqual(frames, [
    { State: 'unavailable', Message: 'No address configured', Channels: [] },
  ]);
});

test('live levels: a dropped connection reads as unavailable until it reconnects', async () => {
  const M = load();
  await withUnit({ levels: { 1: '80000000' } }, async (unit) => {
    const frames = [];
    const stop = M.StartLiveLevels(target(unit.port, { ReadLevels: true }), (f) => frames.push(f));
    await waitFor(() => frames.some((f) => f.State === 'live'));
    unit.dropAll();
    await waitFor(() => frames.some((f) => f.State === 'unavailable'));
    stop();
  });
});
