const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function load() {
  return loadWithMocks(methodPath('qsys-core.js'), {});
}

const STATUS_OK = {
  Platform: 'Core 510i',
  State: 'Active',
  DesignName: 'SAF-MainPA',
  DesignCode: 'qALFilm6IcAz',
  IsRedundant: false,
  IsEmulator: false,
  Status: { Code: 0, String: 'OK' },
};

// A fake Q-SYS Core speaking QRC: NUL-terminated JSON-RPC 2.0. Sends an
// EngineStatus notification on connect (as a real Core does), then answers
// Logon / StatusGet / Control.Get by id.
//
// Options:
//   status        StatusGet result (or null to never answer StatusGet)
//   statusError   StatusGet error object instead of a result
//   creds         { User, Password } the Core accepts; when set, StatusGet
//                 without a successful Logon answers error 10
//   controls      Named Control name -> { Value, String }
//   batchErrors   true: one unknown name fails the whole Control.Get (error 8)
//   engineStatus  false to skip the connect notification
//   fragment      true: write every frame one byte at a time
//   raw           a string to send on connect instead of speaking QRC
function startCore(options = {}) {
  const {
    status = STATUS_OK,
    statusError = null,
    creds = null,
    controls = {},
    batchErrors = true,
    engineStatus = true,
    fragment = false,
    raw = null,
  } = options;
  const received = [];
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const send = (obj) => {
        const text = JSON.stringify(obj) + '\0';
        if (!fragment) return socket.write(text);
        for (const ch of text) socket.write(ch);
      };
      if (raw != null) {
        socket.write(raw);
        return;
      }
      if (engineStatus && status) {
        send({
          jsonrpc: '2.0',
          method: 'EngineStatus',
          params: {
            State: status.State,
            DesignName: status.DesignName,
            DesignCode: status.DesignCode,
            IsRedundant: status.IsRedundant,
            IsEmulator: status.IsEmulator,
          },
        });
      }
      let loggedOn = !creds;
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\0')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const msg = JSON.parse(frame);
          received.push(msg);
          const reply = (body) => send({ jsonrpc: '2.0', id: msg.id, ...body });
          if (msg.method === 'Logon') {
            const ok =
              creds && msg.params.User === creds.User && msg.params.Password === creds.Password;
            if (ok || !creds) {
              loggedOn = true;
              reply({ result: true });
            } else {
              reply({ error: { code: 10, message: 'Logon required' } });
            }
          } else if (msg.method === 'StatusGet') {
            if (!loggedOn) reply({ error: { code: 10, message: 'Logon required' } });
            else if (statusError) reply({ error: statusError });
            else if (status) reply({ result: status });
          } else if (msg.method === 'Control.Get') {
            const names = msg.params;
            const unknown = names.filter((n) => !(n in controls));
            if (unknown.length && batchErrors) {
              reply({ error: { code: 8, message: 'Unknown control' } });
            } else {
              reply({
                result: names
                  .filter((n) => n in controls)
                  .map((n) => ({ Name: n, ...controls[n] })),
              });
            }
          }
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

// A bare TCP server whose connection handler is the test's; tracks sockets so
// close() can drop them and let the test process exit.
function startRaw(onConnection) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      onConnection(socket);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });
}

async function withCore(options, fn) {
  const core = await startCore(options);
  try {
    return await fn(core);
  } finally {
    await core.close();
  }
}

function run(qsys, core, settings = {}) {
  return qsys.Run({
    Address: '127.0.0.1',
    Settings: { Port: core.port, Timeout: 1500, ...settings },
  });
}

test('qsys-core exports the method contract with the documented defaults', () => {
  const qsys = load();
  assert.equal(qsys.ID, 'qsys-core');
  assert.equal(typeof qsys.Name, 'string');
  const byKey = Object.fromEntries(qsys.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.Port.Default, 1710);
  assert.equal(byKey.Port.Required, true);
  assert.equal(byKey.Password.Sensitive, true);
  assert.equal(byKey.CheckStatus.Default, true);
  assert.equal(byKey.RequireActive.Default, true);
  assert.match(byKey.RequireActive.Note, /backup Core/);
  assert.equal(byKey.CheckDesign.Default, false);
  assert.deepEqual(byKey.ExpectedDesign.VisibleWhen, { Key: 'CheckDesign', Equals: true });
  assert.equal(byKey.CheckControls.Default, false);
  assert.equal(byKey.ControlAssertions.Type, 'list');
  assert.equal(byKey.Timeout.Advanced, true);
  // Defaults apply when the keys are absent (a check saved before they existed).
  const opts = qsys._internal.ParseHealthOptions({ Settings: {} });
  assert.equal(opts.CheckStatus, true);
  assert.equal(opts.RequireActive, true);
  assert.equal(opts.CheckDesign, false);
  assert.equal(opts.CheckControls, false);
});

test('qsys-core reads status from a healthy Active Core', async () => {
  const qsys = load();
  await withCore({}, async (core) => {
    const result = await run(qsys, core);
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Platform, 'Core 510i');
    assert.equal(result.State, 'Active');
    assert.equal(result.DesignName, 'SAF-MainPA');
    assert.equal(result.DesignCode, 'qALFilm6IcAz');
    assert.equal(result.StatusCode, 0);
    assert.equal(result.StatusSource, 'StatusGet');
    assert.equal(result.LogonState, 'not-attempted');
    assert.equal(typeof result.LatencyMs, 'number');
    // No Logon without a user; StatusGet sent with the documented params.
    assert.deepEqual(
      core.received.map((m) => m.method),
      ['StatusGet']
    );
    assert.equal(core.received[0].jsonrpc, '2.0');
    assert.equal(typeof core.received[0].id, 'number');
  });
});

test('qsys-core survives replies fragmented one byte at a time', async () => {
  const qsys = load();
  await withCore({ fragment: true }, async (core) => {
    const result = await run(qsys, core, { Timeout: 3000 });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.State, 'Active');
  });
});

test('qsys-core logs on when a user is set and degrades on a rejected PIN', async () => {
  const qsys = load();
  const creds = { User: 'showtrak', Password: '1234' };
  await withCore({ creds }, async (core) => {
    const good = await run(qsys, core, { User: 'showtrak', Password: '1234' });
    assert.equal(good.Success, true);
    assert.ok(!good.Degraded, good.DegradedReason);
    assert.equal(good.LogonState, 'ok');
    const logon = core.received.find((m) => m.method === 'Logon');
    assert.deepEqual(logon.params, { User: 'showtrak', Password: '1234' });

    const bad = await run(qsys, core, { User: 'showtrak', Password: '9999' });
    assert.equal(bad.Success, true);
    assert.equal(bad.Degraded, true);
    assert.equal(bad.LogonState, 'rejected');
    // One reason, not a second "Logon required" for the StatusGet that followed.
    assert.equal(bad.DegradedReason, 'Logon rejected (check the user and PIN)');
  });
});

test('qsys-core asks for credentials when Access Control refuses StatusGet', async () => {
  const qsys = load();
  await withCore({ creds: { User: 'a', Password: 'b' } }, async (core) => {
    const result = await run(qsys, core);
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /Logon required: set a user and PIN/);
  });
});

test('qsys-core CheckStatus degrades with the Core status text, and can be turned off', async () => {
  const qsys = load();
  const status = { ...STATUS_OK, Status: { Code: 2, String: 'Fault - 2 Missing Devices' } };
  await withCore({ status }, async (core) => {
    const result = await run(qsys, core);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Core status Fault: Fault - 2 Missing Devices');
    const off = await run(qsys, core, { CheckStatus: false });
    assert.ok(!off.Degraded, off.DegradedReason);
  });
});

test('qsys-core RequireActive flags a Standby Core and skips the control read', async () => {
  const qsys = load();
  const status = { ...STATUS_OK, State: 'Standby', IsRedundant: true };
  await withCore(
    { status, controls: { MainMute: { Value: false, String: 'false' } } },
    async (core) => {
      const result = await run(qsys, core, {
        CheckControls: true,
        ControlAssertions: ['MainMute=false'],
      });
      assert.equal(result.Degraded, true);
      assert.equal(result.DegradedReason, 'Core is Standby (not Active)');
      assert.equal(result.Controls, null);
      assert.match(result.ControlsSkipped, /Standby/);
      assert.ok(!core.received.some((m) => m.method === 'Control.Get'));

      // The backup Core of a pair: RequireActive off reads clean.
      const backup = await run(qsys, core, { RequireActive: false });
      assert.ok(!backup.Degraded, backup.DegradedReason);
    }
  );
});

test('qsys-core reports an Idle Core as having no design running', async () => {
  const qsys = load();
  const status = { ...STATUS_OK, State: 'Idle', DesignName: '' };
  await withCore({ status }, async (core) => {
    const result = await run(qsys, core);
    assert.equal(result.DegradedReason, 'Core is Idle (no design running)');
  });
});

test('qsys-core CheckDesign compares the design name without regard to case', async () => {
  const qsys = load();
  await withCore({}, async (core) => {
    const match = await run(qsys, core, { CheckDesign: true, ExpectedDesign: 'saf-mainpa' });
    assert.ok(!match.Degraded, match.DegradedReason);
    const blank = await run(qsys, core, { CheckDesign: true, ExpectedDesign: '' });
    assert.ok(!blank.Degraded, blank.DegradedReason);
    const wrong = await run(qsys, core, { CheckDesign: true, ExpectedDesign: 'Rehearsal' });
    assert.equal(wrong.Degraded, true);
    assert.equal(wrong.DegradedReason, 'Design "SAF-MainPA" (expected "Rehearsal")');
  });
});

test('qsys-core control assertions pass, fail with both values, and name unknown controls', async () => {
  const qsys = load();
  const controls = {
    MainMute: { Value: false, String: 'false' },
    MainGain: { Value: -5.9999995, String: '-6.0dB' },
    Source: { Value: 2, String: 'Lectern' },
  };
  await withCore({ controls }, async (core) => {
    const ok = await run(qsys, core, {
      CheckControls: true,
      ControlAssertions: ['MainMute=FALSE', 'MainGain=-6', 'Source=lectern'],
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    assert.equal(ok.Controls.length, 3);

    const bad = await run(qsys, core, {
      CheckControls: true,
      ControlAssertions: ['MainGain=-10', 'Missing Thing=1', 'Source=Lectern'],
    });
    assert.equal(bad.Success, true);
    assert.equal(bad.Degraded, true);
    assert.match(bad.DegradedReason, /Control "MainGain" is -6\.0dB \(expected -10\)/);
    assert.match(bad.DegradedReason, /Control "Missing Thing" not found \(Unknown control \(8\)\)/);
    assert.doesNotMatch(bad.DegradedReason, /Source/);
  });
});

test('qsys-core treats a control left out of a batch answer as not found', async () => {
  const qsys = load();
  await withCore({ controls: { A: { Value: 1 } }, batchErrors: false }, async (core) => {
    const result = await run(qsys, core, {
      CheckControls: true,
      ControlAssertions: ['A=1', 'B=1'],
    });
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /Control "B" not found/);
    assert.doesNotMatch(result.DegradedReason, /Control "A"/);
  });
});

test('qsys-core reports a malformed assertion instead of sending it', async () => {
  const qsys = load();
  await withCore({}, async (core) => {
    const result = await run(qsys, core, {
      CheckControls: true,
      ControlAssertions: ['=5', 'NoEquals'],
    });
    assert.equal(result.Degraded, true);
    assert.match(result.DegradedReason, /Invalid control assertion "=5"/);
    assert.match(result.DegradedReason, /Invalid control assertion "NoEquals"/);
    assert.ok(!core.received.some((m) => m.method === 'Control.Get'));
  });
});

test('qsys-core falls back to EngineStatus when StatusGet is never answered', async () => {
  const qsys = load();
  // A real Core always answers; this exercises the partial-session path: the
  // connect notification arrives, then StatusGet goes unanswered.
  const neverAnswers = await startRaw((socket) => {
    socket.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'EngineStatus',
        params: {
          State: 'Active',
          DesignName: 'Show',
          DesignCode: 'x',
          IsRedundant: false,
          IsEmulator: true,
        },
      }) + '\0'
    );
  });
  try {
    const result = await qsys.Run({
      Address: '127.0.0.1',
      Settings: { Port: neverAnswers.port, Timeout: 600 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.StatusSource, 'EngineStatus');
    assert.equal(result.DesignName, 'Show');
    assert.equal(result.IsEmulator, true);
    assert.match(result.DegradedReason, /did not finish StatusGet in time/);
  } finally {
    await neverAnswers.close();
  }
});

test('qsys-core degrades when the responder is not a Q-SYS Core', async () => {
  const qsys = load();
  await withCore({ raw: 'HTTP/1.1 400 Bad Request\r\n\r\n' }, async (core) => {
    const result = await run(qsys, core, { Timeout: 600 });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'Responded, but not as a Q-SYS Core (QRC)');
    assert.equal(result.IsQsys, false);
  });
});

test('qsys-core treats a JSON-RPC method-not-found as not a Core', async () => {
  const qsys = load();
  await withCore(
    { engineStatus: false, statusError: { code: -32601, message: 'Method not found' } },
    async (core) => {
      const result = await run(qsys, core);
      assert.equal(result.Degraded, true);
      assert.equal(result.IsQsys, false);
    }
  );
});

test('qsys-core is offline when nothing answers, refused, or no address', async () => {
  const qsys = load();
  const tmp = await startCore();
  const port = tmp.port;
  await tmp.close();
  const refused = await qsys.Run({ Address: '127.0.0.1', Settings: { Port: port, Timeout: 800 } });
  assert.equal(refused.Success, false);
  assert.equal(refused.Degraded, true);

  const silent = await startRaw(() => {});
  try {
    const result = await qsys.Run({
      Address: '127.0.0.1',
      Settings: { Port: silent.port, Timeout: 500 },
    });
    assert.equal(result.Success, false);
    assert.match(result.Error, /No reply from the Q-SYS Core after 500ms/);
  } finally {
    await silent.close();
  }

  const none = await qsys.Run({ Settings: {} });
  assert.equal(none.Success, false);
  assert.match(none.Error, /No address/);
});

test('qsys-core SplitFrames keeps the incomplete tail and drops empty frames', () => {
  const { SplitFrames } = load()._internal;
  assert.deepEqual(SplitFrames('{"a":1}\0\0 {"b":2} \0{"c"'), {
    Frames: ['{"a":1}', '{"b":2}'],
    Rest: '{"c"',
  });
  assert.deepEqual(SplitFrames(''), { Frames: [], Rest: '' });
});

test('qsys-core ParseCoreStatus rejects non-status shapes and reads partial ones', () => {
  const { ParseCoreStatus } = load()._internal;
  assert.equal(ParseCoreStatus(null), null);
  assert.equal(ParseCoreStatus([1, 2]), null);
  assert.equal(ParseCoreStatus({ foo: 'bar' }), null);
  const partial = ParseCoreStatus({ State: 'Standby' });
  assert.equal(partial.State, 'Standby');
  assert.equal(partial.StatusCode, null);
  assert.equal(partial.Platform, null);
});

test('qsys-core value matching: numbers numerically, text case-insensitively, booleans', () => {
  const { OneMatches, ControlMatches } = load()._internal;
  assert.equal(OneMatches('-6', -5.9999995), true);
  assert.equal(OneMatches('-6.0', '-6'), true);
  assert.equal(OneMatches('-6', -6.5), false);
  assert.equal(OneMatches('ON', 'on'), true);
  assert.equal(OneMatches('true', true), true);
  assert.equal(OneMatches('1', true), true);
  assert.equal(OneMatches('false', true), false);
  assert.equal(OneMatches('x', null), false);
  // String first, then Value.
  assert.equal(ControlMatches('-6.0dB', { Found: true, String: '-6.0dB', Value: -6 }), true);
  assert.equal(ControlMatches('-6', { Found: true, String: '-6.0dB', Value: -6 }), true);
  assert.equal(ControlMatches('-6', { Found: false }), false);
});

test('qsys-core ParseControlAssertions splits on the first equals sign', () => {
  const { ParseControlAssertions } = load()._internal;
  assert.deepEqual(ParseControlAssertions([' Main Gain = -6 ', 'Text=a=b', '', 'bad', '=1']), {
    Assertions: [
      { Name: 'Main Gain', Expected: '-6' },
      { Name: 'Text', Expected: 'a=b' },
    ],
    Invalid: ['bad', '=1'],
  });
  assert.deepEqual(ParseControlAssertions('not a list'), { Assertions: [], Invalid: [] });
});

test('qsys-core Debug escapes device-supplied strings', async () => {
  const qsys = load();
  const evil = '<script>alert(1)</script>';
  const status = {
    ...STATUS_OK,
    Platform: evil,
    DesignName: evil,
    Status: { Code: 1, String: evil },
  };
  await withCore({ status, controls: { [evil]: { Value: evil, String: evil } } }, async (core) => {
    const target = {
      Address: '127.0.0.1',
      Settings: {
        Port: core.port,
        Timeout: 1500,
        CheckControls: true,
        ControlAssertions: [`${evil}=1`],
      },
    };
    const result = await qsys.Run(target);
    const html = qsys.Debug(result, target);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Compromised/);
  });
  const offline = qsys.Debug({ Success: false, Error: evil }, { Address: 'x', Settings: {} });
  assert.doesNotMatch(offline, /<script>/);
});

test('qsys-core boolean assertions match a numeric 0/1 mute with either String form', async () => {
  const qsys = load();
  const { OneMatches, ControlMatches } = qsys._internal;
  // Numeric Values: the words get truth semantics, 1/0 stay numeric.
  assert.equal(OneMatches('false', 0), true);
  assert.equal(OneMatches('false', 0.0), true);
  assert.equal(OneMatches('true', 1), true);
  assert.equal(OneMatches('On', 1), true);
  assert.equal(OneMatches('off', 1), false);
  assert.equal(OneMatches('1', 0.5), false);
  assert.equal(OneMatches('0', false), true);
  for (const [String, Value] of [
    ['unmuted', 0],
    ['Unmuted', false],
  ]) {
    const reading = { Found: true, String, Value };
    assert.equal(ControlMatches('false', reading), true, `${String}/${Value}`);
    assert.equal(ControlMatches('unmuted', reading), true);
    assert.equal(ControlMatches('true', reading), false);
    assert.equal(ControlMatches('muted', reading), false);
  }
  for (const [String, Value] of [
    ['muted', 1],
    ['Muted', true],
  ]) {
    const reading = { Found: true, String, Value };
    assert.equal(ControlMatches('true', reading), true, `${String}/${Value}`);
    assert.equal(ControlMatches('MUTED', reading), true);
    assert.equal(ControlMatches('false', reading), false);
  }

  // End to end against a Core reporting mutes as numbers.
  const controls = {
    MainMute: { Value: 0, String: 'unmuted' },
    FoldbackMute: { Value: 1, String: 'muted' },
  };
  await withCore({ controls }, async (core) => {
    const ok = await run(qsys, core, {
      CheckControls: true,
      ControlAssertions: ['MainMute=false', 'FoldbackMute=true'],
    });
    assert.ok(!ok.Degraded, ok.DegradedReason);
    const bad = await run(qsys, core, {
      CheckControls: true,
      ControlAssertions: ['MainMute=true', 'FoldbackMute=unmuted'],
    });
    assert.equal(
      bad.DegradedReason,
      'Control "MainMute" is unmuted (expected true); Control "FoldbackMute" is muted (expected unmuted)'
    );
  });
});

test('qsys-core never throws on hostile JSON where primitives belong', async () => {
  const qsys = load();
  const { ParseCoreStatus, ParseError, ParseControlResult } = qsys._internal;
  const hostile = { toString: 1, valueOf: 1 };
  const parsed = ParseCoreStatus({
    State: 'Active',
    Platform: hostile,
    DesignName: hostile,
    DesignCode: [1],
    IsRedundant: hostile,
    IsEmulator: 'yes',
    Status: { Code: hostile, String: hostile },
  });
  assert.equal(parsed.State, 'Active');
  assert.equal(parsed.Platform, null);
  assert.equal(parsed.DesignName, null);
  assert.equal(parsed.DesignCode, null);
  assert.equal(parsed.IsRedundant, null);
  assert.equal(parsed.IsEmulator, null);
  assert.equal(parsed.StatusCode, null);
  assert.equal(parsed.StatusString, null);
  assert.deepEqual(ParseError({ code: hostile, message: hostile }), {
    Code: null,
    Message: 'Error',
  });
  const [reading] = ParseControlResult(['A'], [{ Name: 'A', Value: hostile, String: hostile }]);
  assert.equal(reading.Found, true);
  assert.equal(reading.Value, undefined);
  assert.equal(reading.String, null);

  // End to end: a Core-shaped responder sending hostile fields, including a
  // hostile id, still yields a result rather than an exception.
  const evil = await startRaw((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\0')) !== -1) {
        const msg = JSON.parse(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: { toString: 1 } }) + '\0');
        socket.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { State: 'Active', Platform: hostile, Status: { Code: hostile } },
          }) + '\0'
        );
      }
    });
  });
  try {
    const result = await qsys.Run({
      Address: '127.0.0.1',
      Settings: { Port: evil.port, Timeout: 1500 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.State, 'Active');
    assert.equal(result.Platform, null);
    assert.equal(result.StatusCode, null);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(typeof qsys.Debug(result, { Address: '127.0.0.1', Settings: {} }), 'string');
  } finally {
    await evil.close();
  }
});
