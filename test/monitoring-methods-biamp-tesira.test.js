const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('biamp-tesira.js'), {});
}

const IAC = 0xff;
const WILL = 0xfb;
const WONT = 0xfc;
const DO = 0xfd;
const DONT = 0xfe;

// Replies taken from Biamp's TTP documentation (the Device attribute table and
// the TTP fault responses page). deviceInfo has no published example; its shape
// follows the other DEVICE gets.
const REPLIES_OK = {
  'DEVICE get deviceInfo':
    '+OK "value":{"deviceModel":"TesiraFORTE AI" "deviceRevision":"2" "serialNumber":"01842224" "firmwareVersion":"4.7.1.23292" "ipAddress":"10.30.150.62"}',
  'DEVICE get serialNumber': '+OK "value":"01842224"',
  'DEVICE get version': '+OK "value":"3.15.0.12"',
  'DEVICE get networkStatus':
    '+OK "value":{"schemaVersion":2 "hostname":"TesiraServer91" "defaultGatewayStatus":"0.0.0.0" "networkInterfaceStatusWithName":[{"interfaceId":"control" "networkInterfaceStatus":{"macAddress":"00:90:5e:13:3b:27" "linkStatus":LINK_1_GB "addressSource":STATIC "ip":"10.30.150.62" "netmask":"255.255.0.0" "dhcpLeaseObtainedDate":"" "dhcpLeaseExpiresDate":"" "gateway":"0.0.0.0"}}] "dnsStatus":{"primaryDNSServer":"0.0.0.0" "secondaryDNSServer":"0.0.0.0" "domainName":""} "mDNSEnabled":true" telnetDisabled":false}',
  'DEVICE get activeFaultList':
    '+OK "value":[{"id":INDICATOR_NONE_IN_DEVICE "name":"No fault in device" "faults":[] "serialNumber":"01842216"} {"id":INDICATOR_NONE_IN_DEVICE "name":"No fault in device" "faults":[] "serialNumber":"01882935"}]',
  'DEVICE get networkPortInfo':
    '+OK "networkPortInfo":[{"name":"P2" "linkUp":false "speed":0 "statistics":[{"t":RX_PACKETS "v":0}] "info":[] "portRole":PORT_ROLE_DANTE_ONLY} {"name":"P1" "linkUp":true "speed":1000 "statistics":[] "info":[{"t":LLDP_PORTNAME "v":"P1"}] "portRole":PORT_ROLE_AVB_ONLY} {"name":"control" "linkUp":true "speed":1000 "statistics":[] "info":[] "portRole":INVALID PortRoleType}]',
  'Level1 get mute 1': '+OK "value":false',
  'Level1 get level 1': '+OK "value":-10.000000',
  '"Main Level" get level 1': '+OK "value":0.000000',
};

const FAULTS_MIXED =
  '+OK "value":[{"id":INDICATOR_MAJOR_IN_DEVICE "name":"Major Fault in Device" "faults":[{"id":FAULT_AVB_STREAM_INACTIVE "name":"One or more AVB streams inactive"}] "serialNumber":"01842216"} {"id":INDICATOR_MINOR_IN_DEVICE "name":"Minor Fault in Device" "faults":[{"id":FAULT_FAN "name":"Cooling fan malfunction.  Check filter and fan."}] "serialNumber":"01882935"}]';
const FAULTS_MINOR_ONLY =
  '+OK [[2 "Minor Fault in Device" [ [89 "Cooling fan malfunction.  Check filter and fan."]] "02196874"]]';

// A fake Tesira TTP server on Telnet. Opens with option offers (DO ECHO, WILL
// SUPPRESS-GO-AHEAD, as in Biamp's Telnet page), refuses to go further until
// every offer has been answered, optionally asks for a login, then prints the
// banner and answers each LF-terminated command from `replies`.
//
// Options:
//   replies     command -> reply line (missing -> -ERR)
//   login       { user, pass } the device accepts, or null for no login prompt
//   fragment    true: write everything one byte at a time
//   raw         a string to send on connect instead of speaking TTP
//   silentOn    a command never answered (to exercise the budget)
//   lineEnd     line terminator ('\r\n' default, or '\r\0')
//   echo        true: echo each command line back before its reply
function startTesira(options = {}) {
  const {
    replies = REPLIES_OK,
    login = null,
    fragment = false,
    raw = null,
    silentOn = null,
    lineEnd = '\r\n',
    echo = false,
  } = options;
  const received = [];
  const negotiation = [];
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const send = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        if (!fragment) return socket.write(buf);
        for (const byte of buf) socket.write(Buffer.from([byte]));
      };
      if (raw != null) {
        socket.write(raw);
        return;
      }
      const offers = [
        [DO, 0x01],
        [WILL, 0x03],
        [DO, 0x18],
      ];
      send(Buffer.from(offers.flatMap(([verb, opt]) => [IAC, verb, opt])));
      let answered = 0;
      let phase = 'negotiate';
      let text = '';
      const afterNegotiation = () => {
        if (login) {
          phase = 'user';
          send('login: ');
        } else {
          phase = 'ready';
          send(`${lineEnd}Welcome to the Tesira Text Protocol Server...${lineEnd}`);
        }
      };
      socket.on('data', (chunk) => {
        let i = 0;
        while (phase === 'negotiate' && i < chunk.length) {
          if (chunk[i] === IAC && i + 2 < chunk.length + 0) {
            negotiation.push([chunk[i + 1], chunk[i + 2]]);
            answered++;
            i += 3;
            if (answered === offers.length) afterNegotiation();
          } else i++;
        }
        text += chunk.slice(i).toString('utf8');
        let nl;
        while ((nl = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, nl).replace(/\r$/, '');
          text = text.slice(nl + 1);
          received.push(line);
          if (phase === 'user') {
            phase = 'pass';
            socket.user = line;
            send('Password: ');
          } else if (phase === 'pass') {
            if (socket.user === login.user && line === login.pass) {
              phase = 'ready';
              send(`${lineEnd}Welcome to the Tesira Text Protocol Server...${lineEnd}`);
            } else {
              phase = 'user';
              send(`${lineEnd}Login incorrect${lineEnd}login: `);
            }
          } else if (phase === 'ready') {
            if (line === silentOn) continue;
            const reply = Object.prototype.hasOwnProperty.call(replies, line)
              ? replies[line]
              : `-ERR address not found: {"deviceId":0 "classCode":0 "instanceNum":0}`;
            send((echo ? line + lineEnd : '') + reply + lineEnd);
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        negotiation,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

async function withTesira(options, fn) {
  const dev = await startTesira(options);
  try {
    return await fn(dev);
  } finally {
    await dev.close();
  }
}

function target(port, settings = {}) {
  return { Address: '127.0.0.1', Settings: { Port: port, Timeout: 2000, ...settings } };
}

test('happy path: refuses every Telnet option, reads device, network and faults', async () => {
  const M = load();
  await withTesira({}, async (dev) => {
    const r = await M.Run(target(dev.port));
    assert.equal(r.Success, true, r.Error);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.IsTesira, true);
    assert.equal(r.Model, 'TesiraFORTE AI');
    assert.equal(r.SerialNumber, '01842224');
    assert.equal(r.Firmware, '4.7.1.23292');
    assert.equal(r.Hostname, 'TesiraServer91');
    assert.deepEqual(r.Interfaces, [
      { Name: 'control', Ip: '10.30.150.62', Mac: '00:90:5e:13:3b:27', Link: 'LINK_1_GB' },
    ]);
    assert.deepEqual(r.Faults, []);
    assert.equal(r.LoginState, 'not-asked');
    // DO -> WON'T, WILL -> DON'T, option byte returned.
    assert.deepEqual(dev.negotiation, [
      [WONT, 0x01],
      [DONT, 0x03],
      [WONT, 0x18],
    ]);
    // Only gets were sent.
    for (const line of dev.received) assert.match(line, /^\S+ get /);
    assert.ok(!dev.received.includes('DEVICE get networkPortInfo'));
  });
});

test('falls back to serialNumber + version when deviceInfo is refused', async () => {
  const M = load();
  const replies = { ...REPLIES_OK };
  delete replies['DEVICE get deviceInfo'];
  await withTesira({ replies }, async (dev) => {
    const r = await M.Run(target(dev.port));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.SerialNumber, '01842224');
    assert.equal(r.Firmware, '3.15.0.12');
    assert.equal(r.Model, null);
    assert.ok(dev.received.includes('DEVICE get version'));
  });
});

test('active faults degrade, quoting each; major-only ignores minor faults', async () => {
  const M = load();
  await withTesira(
    { replies: { ...REPLIES_OK, 'DEVICE get activeFaultList': FAULTS_MIXED } },
    async (dev) => {
      const r = await M.Run(target(dev.port));
      assert.equal(r.Degraded, true);
      assert.match(r.DegradedReason, /2 active faults/);
      assert.match(r.DegradedReason, /AVB streams inactive \(01842216\)/);
      assert.match(r.DegradedReason, /Cooling fan malfunction\. Check filter and fan\./);

      const major = await M.Run(target(dev.port, { FaultSeverity: 'major' }));
      assert.match(major.DegradedReason, /^Major fault: One or more AVB streams inactive/);
      assert.doesNotMatch(major.DegradedReason, /Cooling/);

      const off = await M.Run(target(dev.port, { CheckFaults: false }));
      assert.equal(off.Degraded, undefined);
      assert.equal(off.Faults.length, 2, 'faults are still read for the debug panel');
    }
  );
  await withTesira(
    { replies: { ...REPLIES_OK, 'DEVICE get activeFaultList': FAULTS_MINOR_ONLY } },
    async (dev) => {
      const r = await M.Run(target(dev.port));
      assert.match(r.DegradedReason, /^Minor fault: Cooling fan malfunction/);
      const major = await M.Run(target(dev.port, { FaultSeverity: 'major' }));
      assert.equal(major.Degraded, undefined);
    }
  );
});

test('fault list error is reported when fault checks are on', async () => {
  const M = load();
  const replies = { ...REPLIES_OK };
  delete replies['DEVICE get activeFaultList'];
  await withTesira({ replies }, async (dev) => {
    const r = await M.Run(target(dev.port));
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /Fault list unavailable: address not found/);
  });
});

test('port links: listed port with no link or missing degrades', async () => {
  const M = load();
  await withTesira({}, async (dev) => {
    const ok = await M.Run(
      target(dev.port, { CheckPorts: true, RequiredPorts: ['control', 'p1'] })
    );
    assert.equal(ok.Degraded, undefined, ok.DegradedReason);
    const bad = await M.Run(
      target(dev.port, { CheckPorts: true, RequiredPorts: ['P2', 'P9', 'control'] })
    );
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /Port P2 has no link/);
    assert.match(bad.DegradedReason, /Port P9 not found/);
    assert.doesNotMatch(bad.DegradedReason, /control/);
  });
});

test('attribute assertions: match, mismatch, unknown tag and invalid entries', async () => {
  const M = load();
  await withTesira({}, async (dev) => {
    const ok = await M.Run(
      target(dev.port, {
        CheckAttributes: true,
        AttributeAssertions: ['Level1 mute 1=off', 'Level1 level 1=-10', '"Main Level" level 1=0'],
      })
    );
    assert.equal(ok.Degraded, undefined, ok.DegradedReason);
    assert.ok(dev.received.includes('"Main Level" get level 1'));

    const bad = await M.Run(
      target(dev.port, {
        CheckAttributes: true,
        AttributeAssertions: ['Level1 mute 1=true', 'level1 mute 1=false', 'nonsense'],
      })
    );
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /"Level1 mute 1" is false \(expected true\)/);
    assert.match(bad.DegradedReason, /"level1 mute 1" not read \(address not found/);
    assert.match(bad.DegradedReason, /Invalid attribute assertion "nonsense"/);
  });
});

test('an entry with a line break is refused, never sent', () => {
  const M = load();
  const parsed = M._internal.ParseAttributeAssertions(['Level1 mute 1\nDEVICE reboot=x']);
  assert.equal(parsed.Assertions.length, 0);
  assert.equal(parsed.Invalid.length, 1);
});

test('login prompt is answered; wrong credentials read as rejected', async () => {
  const M = load();
  await withTesira({ login: { user: 'default', pass: 'default' } }, async (dev) => {
    const r = await M.Run(target(dev.port, { Password: 'default' }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, undefined, r.DegradedReason);
    assert.equal(r.LoginState, 'ok');
    assert.equal(dev.received[0], 'default');
  });
  await withTesira({ login: { user: 'tech', pass: '1234' } }, async (dev) => {
    const r = await M.Run(target(dev.port, { Username: 'tech', Password: 'nope' }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.equal(r.LoginState, 'rejected');
    assert.match(r.DegradedReason, /Login rejected/);
  });
});

test('fragmented bytes (IAC split across chunks) and CR NUL line ends', async () => {
  const M = load();
  await withTesira(
    {
      fragment: true,
      lineEnd: '\r\0',
      replies: { ...REPLIES_OK, 'DEVICE get activeFaultList': FAULTS_MIXED },
    },
    async (dev) => {
      const r = await M.Run(target(dev.port, { Timeout: 4000 }));
      assert.equal(r.Success, true, r.Error);
      assert.equal(r.Hostname, 'TesiraServer91');
      assert.equal(r.Faults.length, 2);
      assert.equal(dev.negotiation.length, 3);
    }
  );
});

test('wrong device: a banner that is not TTP is reachable but degraded', async () => {
  const M = load();
  await withTesira({ raw: 'SSH-2.0-OpenSSH_9.0\r\n' }, async (dev) => {
    const r = await M.Run(target(dev.port, { Timeout: 600 }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /not as a Tesira/);
  });
});

test('silent device: offline after the budget', async () => {
  const M = load();
  await withTesira({ raw: '' }, async (dev) => {
    const started = Date.now();
    const r = await M.Run(target(dev.port, { Timeout: 500 }));
    assert.equal(r.Success, false);
    assert.match(r.Error, /No reply from the Tesira after 500ms/);
    assert.ok(Date.now() - started < 1500);
  });
});

test('a read that never answers is cut off by the whole-session budget', async () => {
  const M = load();
  await withTesira({ silentOn: 'DEVICE get activeFaultList' }, async (dev) => {
    const r = await M.Run(target(dev.port, { Timeout: 600 }));
    assert.equal(r.Success, true);
    assert.equal(r.Degraded, true);
    assert.match(r.DegradedReason, /did not finish reading the fault list in time/);
    assert.equal(r.Hostname, 'TesiraServer91');
  });
});

test('refused connection is offline (degraded flag) and no address is an error', async () => {
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

test('garbage and hostile values parse without throwing', () => {
  const M = load();
  const { ParseReplyLine, ParseTtpValue, ParseFaultList } = M._internal;
  assert.equal(ParseReplyLine('+OK').Ok, true);
  assert.equal(ParseReplyLine('-CANNOT_DELIVER').Ok, false);
  ParseTtpValue('{"a":[1 2 {"b":}]] }} "x');
  ParseTtpValue('::: ]]] {{{');
  assert.equal(ParseFaultList('nope'), null);
  assert.deepEqual(ParseFaultList([1, 'x', null]), []);
  assert.throws(() => ParseTtpValue('['.repeat(200)), /nested too deeply/);
});

test('Debug renders healthy, faulted, offline and escapes device text', async () => {
  const M = load();
  await withTesira(
    {
      replies: {
        ...REPLIES_OK,
        'DEVICE get activeFaultList':
          '+OK "value":[{"id":INDICATOR_MAJOR_IN_DEVICE "name":"Major" "faults":[{"id":FAULT_X "name":"<b>boom</b>"}] "serialNumber":"1"}]',
      },
    },
    async (dev) => {
      const t = target(dev.port, {
        CheckPorts: true,
        RequiredPorts: ['P2'],
        CheckAttributes: true,
        AttributeAssertions: ['Level1 mute 1=false'],
      });
      const r = await M.Run(t);
      const html = M.Debug(r, t);
      assert.match(html, /TesiraFORTE AI/);
      assert.match(html, /Active faults \(1\)/);
      assert.match(html, /&lt;b&gt;boom&lt;\/b&gt;/);
      assert.doesNotMatch(html, /<b>boom/);
      assert.match(html, /No link/);
      assert.match(html, /Level1 mute 1/);
    }
  );
  const offline = M.Debug({ Success: false, Error: 'ECONNREFUSED' }, target(23));
  assert.match(offline, /Offline/);
  assert.match(offline, /Telnet is enabled/);
});

// --- Actions ------------------------------------------------------------------

const ACTION_REPLIES = {
  'DEVICE recallPreset 1001': '+OK',
  'DEVICE recallPresetByName "Show Start"': '+OK',
  'DEVICE recallPresetByName Interval': '+OK',
  'Level1 set mute 1 true': '+OK',
  'Level1 set mute 2 false': '+OK',
  '"Main Level" set mute 0 true': '+OK',
  'Level1 set mute 9 true':
    '-ERR INVALID_PARAMETER Index out of range:channelIndex min:1 max:2 received:9',
  'DEVICE recallPreset 9999': '-ERR Preset not found',
};

test('actions: declared IDs, params first and Destructive flags', () => {
  const M = load();
  const byId = Object.fromEntries(M.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['preset.recall', 'mute.on', 'mute.off']);
  assert.equal(byId['preset.recall'].Destructive, true);
  assert.equal(byId['mute.on'].Destructive, true);
  assert.ok(!byId['mute.off'].Destructive);
  assert.equal(byId['preset.recall'].Params[0].Key, 'Preset');
  assert.equal(byId['mute.on'].Params[0].Key, 'InstanceTag');
  assert.equal(byId['mute.on'].Params[1].Key, 'Channel');
  for (const a of M.Actions) assert.ok(!a.AllowedWhileOffline);
});

test('Recall Preset sends recallPreset for an ID and recallPresetByName for a name', async () => {
  const M = load();
  await withTesira(
    { replies: ACTION_REPLIES, echo: true, login: { user: 'default', pass: 'default' } },
    async (dev) => {
      const t = target(dev.port, { Password: 'default' });
      assert.deepEqual(await M.RunAction(t, 'preset.recall', { Preset: '1001' }), {
        Success: true,
        Detail: 'Preset 1001 recalled',
      });
      assert.deepEqual(await M.RunAction(t, 'preset.recall', { Preset: 'Show Start' }), {
        Success: true,
        Detail: 'Preset "Show Start" recalled',
      });
      assert.equal((await M.RunAction(t, 'preset.recall', { Preset: 'Interval' })).Success, true);
      const sent = dev.received.filter((l) => l.startsWith('DEVICE'));
      assert.deepEqual(sent, [
        'DEVICE recallPreset 1001',
        'DEVICE recallPresetByName "Show Start"',
        'DEVICE recallPresetByName Interval',
      ]);
    }
  );
});

test('Mute / Unmute send set mute with the tag and channel; refusals are specific', async () => {
  const M = load();
  await withTesira({ replies: ACTION_REPLIES }, async (dev) => {
    const t = target(dev.port);
    assert.deepEqual(await M.RunAction(t, 'mute.on', { InstanceTag: 'Level1', Channel: '1' }), {
      Success: true,
      Detail: 'Level1 channel 1 muted',
    });
    assert.deepEqual(await M.RunAction(t, 'mute.off', { InstanceTag: 'Level1', Channel: '2' }), {
      Success: true,
      Detail: 'Level1 channel 2 unmuted',
    });
    const ganged = await M.RunAction(t, 'mute.on', { InstanceTag: 'Main Level', Channel: '0' });
    assert.equal(ganged.Success, true, ganged.Error);
    assert.deepEqual(dev.received, [
      'Level1 set mute 1 true',
      'Level1 set mute 2 false',
      '"Main Level" set mute 0 true',
    ]);

    const range = await M.RunAction(t, 'mute.on', { InstanceTag: 'Level1', Channel: '9' });
    assert.equal(range.Success, false);
    assert.match(
      range.Error,
      /refused to mute Level1 channel 9: INVALID_PARAMETER Index out of range/
    );
    const missing = await M.RunAction(t, 'mute.on', { InstanceTag: 'level1', Channel: '1' });
    assert.equal(missing.Success, false);
    assert.match(missing.Error, /no block with instance tag "level1"/);
    const preset = await M.RunAction(t, 'preset.recall', { Preset: '9999' });
    assert.match(preset.Error, /refused to recall preset 9999: Preset not found/);
  });
});

test('action params with line breaks, quotes or tabs are refused before connecting', async () => {
  const M = load();
  await withTesira({ replies: ACTION_REPLIES }, async (dev) => {
    const t = target(dev.port);
    const bad = [
      ['preset.recall', { Preset: '' }, /Enter a preset/],
      ['preset.recall', { Preset: 'A\nDEVICE reboot' }, /cannot contain/],
      ['preset.recall', { Preset: 'A" DEVICE reboot "' }, /cannot contain/],
      ['preset.recall', { Preset: 'A\tB' }, /cannot contain/],
      ['preset.recall', { Preset: 'A B' }, /cannot contain/],
      ['mute.on', { InstanceTag: '', Channel: '1' }, /instance tag/],
      ['mute.on', { InstanceTag: 'Level1\rDEVICE reboot', Channel: '1' }, /cannot contain/],
      ['mute.on', { InstanceTag: 'Level1', Channel: '1 true\nDEVICE reboot' }, /whole number/],
      ['mute.on', { InstanceTag: 'Level1', Channel: '-1' }, /whole number/],
      ['mute.on', { InstanceTag: 'Level1', Channel: 'x' }, /whole number/],
      ['nope', {}, /Unknown Tesira action/],
    ];
    for (const [id, params, re] of bad) {
      const r = await M.RunAction(t, id, params);
      assert.equal(r.Success, false, id);
      assert.match(r.Error, re);
    }
    assert.deepEqual(dev.received, []);
  });
  // A line break in the password would type a second line at the prompt.
  const r = await M.RunAction(target(1, { Password: 'x\nDEVICE reboot' }), 'mute.off', {
    InstanceTag: 'Level1',
    Channel: '1',
  });
  assert.match(r.Error, /control character/);
  const run = await M.Run(target(1, { Username: 'a\rb' }));
  assert.equal(run.Success, false);
  assert.match(run.Error, /control character/);
});

test('actions: login rejected, offline, not a Tesira and no answer in time', async () => {
  const M = load();
  await withTesira({ replies: ACTION_REPLIES, login: { user: 'tech', pass: '1' } }, async (dev) => {
    const r = await M.RunAction(target(dev.port, { Password: 'nope' }), 'mute.off', {
      InstanceTag: 'Level1',
      Channel: '2',
    });
    assert.equal(r.Success, false);
    assert.match(r.Error, /Login rejected/);
    assert.ok(!dev.received.includes('Level1 set mute 2 false'));
  });
  await withTesira({ raw: 'SSH-2.0-OpenSSH_9.0\r\n' }, async (dev) => {
    const r = await M.RunAction(target(dev.port, { Timeout: 600 }), 'preset.recall', {
      Preset: '1001',
    });
    assert.equal(r.Success, false);
    assert.match(r.Error, /not as a Tesira/);
  });
  await withTesira(
    { replies: ACTION_REPLIES, silentOn: 'DEVICE recallPreset 1001' },
    async (dev) => {
      const r = await M.RunAction(target(dev.port, { Timeout: 600 }), 'preset.recall', {
        Preset: '1001',
      });
      assert.equal(r.Success, false);
      assert.match(
        r.Error,
        /did not answer in time\. The command to recall preset 1001 may or may not/
      );
    }
  );
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const off = await M.RunAction(target(port), 'preset.recall', { Preset: '1001' });
  assert.equal(off.Success, false);
  assert.match(off.Error, /ECONNREFUSED/);
  assert.equal(
    (await M.RunAction({ Settings: {} }, 'preset.recall', { Preset: '1' })).Error,
    'No address configured'
  );
});

test('echoed commands are skipped, even for an instance tag starting with "-"', () => {
  const M = load();
  const { TakeReply } = M._internal;
  const text = '-Odd get mute 1\r\n+OK "value":true\r\n';
  assert.equal(TakeReply(text, '-Odd get mute 1'), text.length);
  assert.equal(TakeReply('-Odd get mute 1\r\n', '-Odd get mute 1'), null);
});

test('DescribeAction binds the preset, tag and channel', () => {
  const M = load();
  assert.equal(M.DescribeAction('preset.recall', { Preset: '1001' }), 'Recall Preset - 1001');
  assert.equal(
    M.DescribeAction('mute.on', { InstanceTag: 'Level1', Channel: '2' }),
    'Mute - Level1 channel 2'
  );
  assert.equal(
    M.DescribeAction('mute.off', { InstanceTag: 'Level1', Channel: '2' }),
    'Unmute - Level1 channel 2'
  );
  assert.equal(M.DescribeAction('preset.recall', {}), null);
});
