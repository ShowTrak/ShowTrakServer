const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('yamaha-console.js'), {});
}

const MASTER = 'MIXER:Current/St/Fader/On';

// A fake Yamaha console speaking RCP: LF-terminated text lines on TCP.
//
// Options:
//   product      devinfo productname ('CL5')
//   version      devinfo version
//   deviceName   devinfo devicename
//   runmode      devstatus runmode ('normal')
//   error        devstatus error value, or null to answer ERROR
//   master       [ST L on, ST R on] as 1/0, or null to answer ERROR
//   notify       true: interleave unsolicited NOTIFY lines before each answer
//   fragment     true: write every reply one byte at a time
//   silentAfter  stop answering after this many commands
//   raw          a string to send on connect instead of speaking RCP
function startConsole(options = {}) {
  const {
    product = 'CL5',
    version = 'V5.10',
    deviceName = 'FOH CL5',
    runmode = 'normal',
    error = 'none',
    master = [1, 1],
    notify = false,
    fragment = false,
    silentAfter = Infinity,
    raw = null,
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
        for (const ch of Buffer.from(text, 'utf8')) socket.write(Buffer.from([ch]));
      };
      if (raw != null) {
        socket.write(raw);
        return;
      }
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          received.push(line);
          if (received.length > silentAfter) continue;
          let out = notify
            ? `NOTIFY set ${MASTER} 2 0 0 "OFF"\nNOTIFY sscurrent_ex MIXER:Lib/Scene 3\n`
            : '';
          const [cmd, sub, x] = line.split(' ');
          if (line === 'devstatus runmode') out += `OK devstatus runmode "${runmode}"\n`;
          else if (line === 'devinfo productname') out += `OK devinfo productname "${product}"\n`;
          else if (line === 'devinfo version') out += `OK devinfo version "${version}"\n`;
          else if (line === 'devinfo devicename') out += `OK devinfo devicename "${deviceName}"\n`;
          else if (line === 'devstatus error') {
            out +=
              error == null
                ? 'ERROR devstatus UnknownCommand\n'
                : `OK devstatus error "${error}"\n`;
          } else if (cmd === 'get' && sub === MASTER) {
            if (!master) out += 'ERROR get InvalidArgument\n';
            else {
              const v = master[Number(x)];
              out += `OK get ${MASTER} ${x} 0 ${v} "${v ? 'ON' : 'OFF'}"\n`;
            }
          } else out += `ERROR ${cmd} UnknownCommand\n`;
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
            server.close(r);
          }),
      });
    });
  });
}

async function withConsole(options, fn) {
  const desk = await startConsole(options);
  try {
    return await fn(desk);
  } finally {
    await desk.close();
  }
}

function run(yamaha, desk, settings = {}) {
  return yamaha.Run({
    Address: '127.0.0.1',
    Settings: { Port: desk.port, Timeout: 1500, ...settings },
  });
}

test('yamaha-console exports the method contract with the documented defaults', () => {
  const yamaha = load();
  assert.equal(yamaha.ID, 'yamaha-console');
  const byKey = Object.fromEntries(yamaha.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 49280);
  assert.equal(byKey.Port.Required, true);
  assert.equal(byKey.CheckRunMode.Default, true);
  assert.equal(byKey.CheckModel.Default, false);
  assert.deepEqual(byKey.ExpectedModel.VisibleWhen, { Key: 'CheckModel', Equals: true });
  assert.equal(byKey.CheckAlerts.Default, false);
  assert.equal(byKey.CheckMasterMute.Default, false);
  assert.equal(byKey.Timeout.Advanced, true);
  const opts = yamaha._internal.ParseHealthOptions({ Settings: {} });
  assert.equal(opts.CheckRunMode, true);
  assert.equal(opts.CheckMasterMute, false);
});

test('yamaha-console identifies a healthy console and sends only reads', async () => {
  const yamaha = load();
  await withConsole({}, async (desk) => {
    const result = await run(yamaha, desk);
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.ProductName, 'CL5');
    assert.equal(result.Series, 'CL');
    assert.equal(result.Version, 'V5.10');
    assert.equal(result.DeviceName, 'FOH CL5');
    assert.equal(result.RunMode, 'normal');
    assert.equal(result.Master, null);
    assert.equal(typeof result.LatencyMs, 'number');
    assert.deepEqual(desk.received, [
      'devstatus runmode',
      'devinfo productname',
      'devinfo version',
      'devinfo devicename',
    ]);
    assert.ok(!desk.received.some((l) => /^(set|ssrecall|scpmode)/.test(l)));
  });
});

test('yamaha-console ignores unsolicited NOTIFY lines and fragmented replies', async () => {
  const yamaha = load();
  await withConsole({ notify: true, fragment: true, deviceName: 'Bühne' }, async (desk) => {
    const result = await run(yamaha, desk, { CheckMasterMute: true, Timeout: 3000 });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.ProductName, 'CL5');
    // A multi-byte character split across packets survives.
    assert.equal(result.DeviceName, 'Bühne');
    assert.deepEqual(
      result.Master.map((m) => m.On),
      [true, true]
    );
  });
});

test('yamaha-console CheckRunMode degrades outside normal mode and stops querying', async () => {
  const yamaha = load();
  await withConsole({ runmode: 'update' }, async (desk) => {
    const result = await run(yamaha, desk, { CheckMasterMute: true });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Console in update mode');
    assert.deepEqual(desk.received, ['devstatus runmode']);
  });
  await withConsole({ runmode: 'emergency' }, async (desk) => {
    const result = await run(yamaha, desk);
    assert.equal(result.DegradedReason, 'Console in emergency mode');
    assert.equal(result.ProductName, 'CL5');
    const off = await run(yamaha, desk, { CheckRunMode: false });
    assert.ok(!off.Degraded, off.DegradedReason);
  });
});

test('yamaha-console CheckModel matches a case-insensitive prefix', async () => {
  const yamaha = load();
  await withConsole({ product: 'QL1' }, async (desk) => {
    const ok = await run(yamaha, desk, { CheckModel: true, ExpectedModel: 'ql' });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await run(yamaha, desk, { CheckModel: true, ExpectedModel: 'CL5' });
    assert.equal(bad.Degraded, true);
    assert.equal(bad.DegradedReason, 'Model QL1 (expected CL5…)');
  });
});

test('yamaha-console CheckMasterMute reads ST L and ST R and names the one that is off', async () => {
  const yamaha = load();
  await withConsole({ product: 'DM7', master: [1, 0] }, async (desk) => {
    const result = await run(yamaha, desk, { CheckMasterMute: true });
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Stereo master ST R is off');
    assert.ok(desk.received.includes(`get ${MASTER} 0 0`));
    assert.ok(desk.received.includes(`get ${MASTER} 1 0`));
  });
});

test('yamaha-console CheckMasterMute refuses unconfirmed products without asking', async () => {
  const yamaha = load();
  await withConsole({ product: 'RIO3224-D2' }, async (desk) => {
    const result = await run(yamaha, desk, { CheckMasterMute: true });
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Stereo master check not supported on RIO3224-D2');
    assert.ok(!desk.received.some((l) => l.startsWith('get ')));
  });
});

test('yamaha-console reports a stereo master the console refuses to read', async () => {
  const yamaha = load();
  await withConsole({ product: 'TF5', master: null }, async (desk) => {
    const result = await run(yamaha, desk, { CheckMasterMute: true });
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /Failed to read stereo master ST L \(InvalidArgument\)/);
  });
});

test('yamaha-console CheckAlerts degrades on an alert and notes consoles without one', async () => {
  const yamaha = load();
  await withConsole(
    { error: 'flt/SYSTEM ERROR// x53 on (1) ID-001 2013/1/22 11:38:23' },
    async (desk) => {
      const result = await run(yamaha, desk, { CheckAlerts: true });
      assert.equal(result.Degraded, true);
      assert.equal(result.DegradedReason, 'Fault alert: SYSTEM ERROR');
    }
  );
  await withConsole({ error: 'warning' }, async (desk) => {
    const result = await run(yamaha, desk, { CheckAlerts: true });
    assert.equal(result.DegradedReason, 'Warning alert');
  });
  await withConsole({ error: 'none' }, async (desk) => {
    const result = await run(yamaha, desk, { CheckAlerts: true });
    assert.ok(!result.Degraded, result.DegradedReason);
  });
  await withConsole({ product: 'DM3', error: null }, async (desk) => {
    const result = await run(yamaha, desk, { CheckAlerts: true });
    assert.equal(result.DegradedReason, 'Alert status not available on DM3');
    // An unanswered optional query is not fatal for the rest.
    assert.equal(result.ProductName, 'DM3');
  });
});

test('yamaha-console degrades with the unfinished stage when the console stalls', async () => {
  const yamaha = load();
  await withConsole({ silentAfter: 2 }, async (desk) => {
    const result = await run(yamaha, desk, { Timeout: 600 });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /did not answer the firmware-version query in time/);
    assert.equal(result.ProductName, 'CL5');
  });
});

test('yamaha-console degrades when the responder is not a Yamaha console', async () => {
  const yamaha = load();
  await withConsole({ raw: 'SSH-2.0-OpenSSH_9.6\r\n' }, async (desk) => {
    const result = await run(yamaha, desk, { Timeout: 600 });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.IsYamaha, false);
    assert.equal(result.DegradedReason, 'Responded, but not as a Yamaha console (RCP)');
  });
});

test('yamaha-console is offline when nothing answers, refused, or no address', async () => {
  const yamaha = load();
  const tmp = await startConsole();
  const port = tmp.port;
  await tmp.close();
  const refused = await yamaha.Run({
    Address: '127.0.0.1',
    Settings: { Port: port, Timeout: 800 },
  });
  assert.equal(refused.Success, false);
  assert.equal(refused.Degraded, true);

  await withConsole({ silentAfter: 0 }, async (desk) => {
    const result = await run(yamaha, desk, { Timeout: 500 });
    assert.equal(result.Success, false);
    assert.match(result.Error, /No reply from the console after 500ms/);
  });

  const none = await yamaha.Run({ Settings: {} });
  assert.equal(none.Success, false);
  assert.match(none.Error, /No address/);
});

test('yamaha-console Tokenize handles quotes, escapes and unterminated values', () => {
  const { Tokenize } = load()._internal;
  assert.deepEqual(
    Tokenize('OK devinfo devicename "FOH \\"A\\" \\\\ desk"').map((t) => t.Value),
    ['OK', 'devinfo', 'devicename', 'FOH "A" \\ desk']
  );
  assert.deepEqual(
    Tokenize('OK get X 0 0 1 "ON"').map((t) => [t.Value, t.Quoted]),
    [
      ['OK', false],
      ['get', false],
      ['X', false],
      ['0', false],
      ['0', false],
      ['1', false],
      ['ON', true],
    ]
  );
  assert.deepEqual(
    Tokenize('OK x "open').map((t) => t.Value),
    ['OK', 'x', 'open']
  );
  assert.deepEqual(Tokenize('   '), []);
});

test('yamaha-console ParseLine and ReplyPredicate skip NOTIFY and junk lines', () => {
  const { ParseLine, ReplyPredicate } = load()._internal;
  assert.equal(ParseLine('hello world'), null);
  assert.equal(ParseLine('"OK" devinfo'), null);
  assert.equal(ParseLine('OKm get X 0 0 1').Status, 'OK');
  assert.equal(ParseLine('ERROR get InvalidArgument\r').Status, 'ERROR');
  const pred = ReplyPredicate(['devinfo', 'productname']);
  assert.equal(pred('NOTIFY set A 0 0 1\nOK devinfo productn'), null);
  const buffered = 'NOTIFY set A 0 0 1\njunk\nOK devinfo productname "CL5"\nOK more\n';
  assert.equal(buffered.slice(0, pred(buffered)).endsWith('"CL5"\n'), true);
  assert.equal(pred('ERROR devinfo UnknownCommand\n'), 'ERROR devinfo UnknownCommand\n'.length);
});

test('yamaha-console DetectSeries and ParseAlert', () => {
  const { DetectSeries, ParseAlert } = load()._internal;
  assert.equal(DetectSeries('CL3'), 'CL');
  assert.equal(DetectSeries('QL5'), 'QL');
  assert.equal(DetectSeries('TF-RACK'), 'TF');
  assert.equal(DetectSeries('DM3 Standard'), 'DM3');
  assert.equal(DetectSeries('DM7 Compact'), 'DM7');
  assert.equal(DetectSeries('RIVAGE PM10'), 'RIVAGE PM');
  assert.equal(DetectSeries('DSP-RX-EX'), 'RIVAGE PM');
  assert.equal(DetectSeries('CS-R10'), 'RIVAGE PM');
  assert.equal(DetectSeries('RIO3224-D2'), null);
  assert.equal(DetectSeries(null), null);
  assert.equal(ParseAlert(null), null);
  assert.deepEqual(ParseAlert('none'), { Level: null, Message: null });
  assert.deepEqual(ParseAlert('fault'), { Level: 'Fault', Message: null });
  assert.deepEqual(ParseAlert('err/DCP[0] communication error// x53 on'), {
    Level: 'Error',
    Message: 'DCP[0] communication error',
  });
  assert.deepEqual(ParseAlert('wrn/Fan// x10'), { Level: 'Warning', Message: 'Fan' });
});

test('yamaha-console Debug escapes device-supplied strings', async () => {
  const yamaha = load();
  const evil = '<script>alert(1)</script>';
  await withConsole(
    { product: evil, version: evil, deviceName: evil, runmode: evil },
    async (desk) => {
      const target = {
        Address: '127.0.0.1',
        Settings: {
          Port: desk.port,
          Timeout: 1500,
          CheckMasterMute: true,
          CheckModel: true,
          ExpectedModel: evil,
        },
      };
      const result = await yamaha.Run(target);
      const html = yamaha.Debug(result, target);
      assert.doesNotMatch(html, /<script>/);
      assert.match(html, /&lt;script&gt;/);
    }
  );
  const offline = yamaha.Debug({ Success: false, Error: evil }, { Address: 'x', Settings: {} });
  assert.doesNotMatch(offline, /<script>/);
});
