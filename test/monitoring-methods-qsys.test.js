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
//   components    Named Components: [{ Name, Type, Controls: [{ Name, Type,
//                 Value, String }] }] for Component.GetComponents / Get /
//                 GetControls. Unknown component -> error 7, unknown control
//                 in Component.Get -> error 8 (as QRC's error table says)
//   componentsError  Component.GetComponents error object instead of a result
//   silentDevices    names whose Component.Get / GetControls is never answered
//   banks         snapshot bank name -> snapshot count, for Snapshot.Load
//   commandError  error object every Snapshot.Load / Control.Set answers with
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
    components = [],
    componentsError = null,
    silentDevices = [],
    banks = {},
    commandError = null,
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
          } else if (msg.method === 'Snapshot.Load' || msg.method === 'Control.Set') {
            if (!loggedOn) reply({ error: { code: 10, message: 'Logon required' } });
            else if (commandError) reply({ error: commandError });
            else if (msg.method === 'Control.Set') {
              if (!(msg.params.Name in controls)) {
                reply({ error: { code: 8, message: 'Unknown control' } });
              } else {
                controls[msg.params.Name] = { Value: msg.params.Value };
                reply({ result: true });
              }
            } else if (!(msg.params.Name in banks) || msg.params.Bank > banks[msg.params.Name]) {
              reply({ error: { code: -32602, message: 'Invalid params' } });
            } else {
              reply({ result: true });
            }
          } else if (msg.method === 'Component.GetComponents') {
            if (componentsError) reply({ error: componentsError });
            else {
              reply({
                result: components.map((c) => ({
                  ID: c.Name,
                  Name: c.Name,
                  Type: c.Type,
                  Properties: [],
                  Controls: null,
                  ControlSource: 2,
                })),
              });
            }
          } else if (msg.method === 'Component.Get' || msg.method === 'Component.GetControls') {
            const comp = components.find((c) => c.Name === msg.params.Name);
            if (silentDevices.includes(msg.params.Name)) return;
            if (!comp) {
              reply({ error: { code: 7, message: 'Unknown component name' } });
            } else if (msg.method === 'Component.GetControls') {
              reply({ result: { Name: comp.Name, Controls: comp.Controls || [] } });
            } else {
              const wanted = msg.params.Controls.map((c) => c.Name);
              const found = (comp.Controls || []).filter((c) => wanted.includes(c.Name));
              if (found.length < wanted.length) {
                reply({ error: { code: 8, message: 'Unknown control' } });
              } else {
                reply({ result: { Name: comp.Name, Controls: found } });
              }
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

// --- Design devices ------------------------------------------------------------

function statusControl(code, string) {
  return { Name: 'status', Type: 'Text', Value: code, String: string, Position: code / 5 };
}

const DESIGN = [
  {
    Name: 'Amp-Stage-L',
    Type: 'amplifier_cxq_status',
    Controls: [statusControl(0, 'OK')],
  },
  {
    Name: 'AmpOut-Stage-L',
    Type: 'cxq_amplifier',
    Controls: [
      statusControl(0, 'OK'),
      { Name: 'channel.1.protect', Type: 'Boolean', Value: false, String: 'false' },
      { Name: 'channel.2.short', Type: 'Boolean', Value: false, String: 'false' },
      { Name: 'channel.1.gain', Type: 'Float', Value: -6, String: '-6.0dB' },
    ],
  },
  { Name: 'QIO-FOH', Type: 'lcqln_status', Controls: [statusControl(0, 'OK')] },
  { Name: 'Cam-Rear', Type: 'onvif_camera_operative', Controls: [statusControl(0, 'OK')] },
  { Name: 'USB-Lectern', Type: 'io_usb_bridge', Controls: [statusControl(0, 'OK')] },
  { Name: 'TSC-Booth', Type: 'touch_screen_status', Controls: [statusControl(0, 'OK')] },
  // Exposed, but not a device status component: never read.
  {
    Name: 'MainGain',
    Type: 'gain',
    Controls: [{ Name: 'gain', Type: 'Float', Value: 0, String: '0dB' }],
  },
  // An I/O card, not a status component: never read either.
  {
    Name: 'Flex-In',
    Type: 'io_card_flex_in_core_8flex',
    Controls: [{ Name: 'gain', Type: 'Float', Value: 0, String: '0dB' }],
  },
];

function withDesign(changes) {
  return DESIGN.map((c) => (changes[c.Name] ? { ...c, ...changes[c.Name] } : c));
}

test('qsys-core device settings default off and keep the existing session unchanged', async () => {
  const qsys = load();
  const byKey = Object.fromEntries(qsys.Settings.map((s) => [s.Key, s]));
  assert.equal(byKey.CheckDevices.Default, false);
  assert.equal(byKey.DeviceSource.Default, 'discover');
  assert.deepEqual(byKey.DeviceNames.VisibleWhen, [
    { Key: 'CheckDevices', Equals: true },
    { Key: 'DeviceSource', Equals: 'list' },
  ]);
  for (const key of [
    'DeviceAmps',
    'DeviceIo',
    'DeviceCameras',
    'DeviceBridges',
    'DeviceTouchPanels',
  ]) {
    assert.equal(byKey[key].Default, true, key);
  }
  assert.equal(byKey.DeviceOther.Default, false);
  assert.equal(byKey.CheckAmpFaults.Default, true);
  assert.equal(byKey.FlagNotPresent.Default, false);
  assert.equal(byKey.StatusControlName.Default, 'status');
  assert.match(byKey.CheckDevices.Note, /Script Access/);

  const plan = qsys._internal.ParseDevicePlan({});
  assert.deepEqual(plan, {
    Source: 'discover',
    Names: [],
    Categories: ['amp', 'io', 'camera', 'bridge', 'touch'],
    AmpFaults: true,
    FlagNotPresent: false,
    StatusControl: 'status',
  });

  // Off: no component methods are sent and no device fields appear.
  const components = withDesign({ 'Amp-Stage-L': { Controls: [statusControl(2, 'Fault')] } });
  await withCore({ components }, async (core) => {
    const result = await run(qsys, core);
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal('Devices' in result, false);
    assert.deepEqual(
      core.received.map((m) => m.method),
      ['StatusGet']
    );
  });
});

test('qsys-core CategorizeType sorts the inventory component types', () => {
  const { CategorizeType } = load()._internal;
  // Types from QSC's developer-community component reference list.
  assert.equal(CategorizeType('amplifier_cxq_status'), 'amp');
  assert.equal(CategorizeType('amplifier_dpa_status'), 'amp');
  assert.equal(CategorizeType('cxq_amplifier'), 'amp');
  assert.equal(CategorizeType('spaq_status'), 'amp');
  assert.equal(CategorizeType('lcqln_status'), 'io');
  assert.equal(CategorizeType('io_status'), 'io');
  assert.equal(CategorizeType('io_dcio_status'), 'io');
  assert.equal(CategorizeType('io_core_nano_status'), 'io');
  assert.equal(CategorizeType('onvif_camera_operative'), 'camera');
  assert.equal(CategorizeType('io_usb_bridge'), 'bridge');
  assert.equal(CategorizeType('usb_uvc'), 'bridge');
  assert.equal(CategorizeType('touch_screen_status'), 'touch');
  assert.equal(CategorizeType('vstreamer_status'), 'other');
  assert.equal(CategorizeType('%PLUGIN%_abc_%FP%_def'), 'other');
  // An unlisted status Type (newer hardware) is placed by keyword; an unlisted
  // Amp Output by its suffix.
  assert.equal(CategorizeType('mpaq_status'), 'amp');
  assert.equal(CategorizeType('ptz_ip_status'), 'bridge');
  assert.equal(CategorizeType('nc_110_status'), 'camera');
  assert.equal(CategorizeType('mpaq_amplifier'), 'amp');
  assert.equal(CategorizeType('widget_status'), 'other');
  // Not devices: DSP blocks, I/O cards, the Core itself, logic, phone lines.
  for (const type of [
    'gain',
    'ramp',
    'audio_file_player',
    'io_card_flex_in_core_8flex',
    'lcqln_line_in',
    'serial_port_usbbr',
    'usb_input',
    'amplifier_cxq_gpio',
    'core_status',
    'status_combiner',
    'pots_control_status_lcqln',
    null,
  ]) {
    assert.equal(CategorizeType(type), null, String(type));
  }
});

test('qsys-core discovers healthy design devices with one round trip for all of them', async () => {
  const qsys = load();
  await withCore({ components: DESIGN }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, result.DegradedReason);
    const names = result.Devices.map((d) => d.Name);
    // Only status components and Amp Outputs: the gain block and the I/O card
    // are not devices and are never read.
    assert.deepEqual(names, [
      'Amp-Stage-L',
      'AmpOut-Stage-L',
      'QIO-FOH',
      'Cam-Rear',
      'USB-Lectern',
      'TSC-Booth',
    ]);
    assert.deepEqual(result.DevicesUnmatched, []);

    // GetComponents with the documented example param, then the Amp Output by
    // GetControls and the rest by Component.Get of the status control only.
    const methods = core.received.map((m) => m.method);
    assert.deepEqual(methods.slice(0, 2), ['StatusGet', 'Component.GetComponents']);
    assert.equal(core.received[1].params, 'test');
    const getControls = core.received.filter((m) => m.method === 'Component.GetControls');
    assert.deepEqual(
      getControls.map((m) => m.params.Name),
      ['AmpOut-Stage-L']
    );
    assert.ok(!core.received.some((m) => m.params && m.params.Name === 'Flex-In'));
    const qio = core.received.find(
      (m) => m.method === 'Component.Get' && m.params.Name === 'QIO-FOH'
    );
    assert.deepEqual(qio.params.Controls, [{ Name: 'status' }]);
    const ids = core.received.slice(2).map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test('qsys-core names each device whose status is not OK and quotes its status text', async () => {
  const qsys = load();
  const components = withDesign({
    'Amp-Stage-L': { Controls: [statusControl(2, 'Fault - PSU over temperature')] },
    'Cam-Rear': { Controls: [statusControl(4, 'Missing')] },
    'TSC-Booth': { Controls: [statusControl(1, 'Compromised - LAN B not connected')] },
  });
  await withCore({ components }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true });
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(
      result.DegradedReason,
      'Amplifier "Amp-Stage-L" Fault - PSU over temperature; Camera "Cam-Rear" Missing; ' +
        'Touch panel "TSC-Booth" Compromised - LAN B not connected'
    );
  });
});

test('qsys-core reports lit amplifier channel faults, and can skip them', async () => {
  const qsys = load();
  const components = withDesign({
    'AmpOut-Stage-L': {
      Controls: [
        statusControl(0, 'OK'),
        { Name: 'channel.1.protect', Type: 'Boolean', Value: true, String: 'true' },
        { Name: 'channel.2.short', Type: 'Boolean', Value: 1, String: 'true' },
        { Name: 'channel.3.over.current', Type: 'Boolean', Value: 0, String: 'false' },
        // A meter with a fault-like name and the suppress button never count.
        { Name: 'channel.1.clip.meter', Type: 'Float', Value: 1, String: '1' },
        { Name: 'protect.suppress', Type: 'Boolean', Value: true, String: 'true' },
      ],
    },
  });
  await withCore({ components }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true });
    assert.equal(
      result.DegradedReason,
      'Amplifier "AmpOut-Stage-L" channel fault: channel.1.protect, channel.2.short'
    );
    const before = core.received.length;
    const off = await run(qsys, core, { CheckDevices: true, CheckAmpFaults: false });
    assert.ok(!off.Degraded, off.DegradedReason);
    // With faults off nothing asks for every control.
    const after = core.received.slice(before);
    assert.ok(!after.some((m) => m.method === 'Component.GetControls'));
  });
});

test('qsys-core treats Not Present as fine unless asked, and filters by category', async () => {
  const qsys = load();
  const components = withDesign({
    'QIO-FOH': { Controls: [statusControl(3, 'Not Present')] },
    'USB-Lectern': { Controls: [statusControl(2, 'Fault - no host')] },
  });
  await withCore({ components }, async (core) => {
    const base = { CheckDevices: true };
    const plain = await run(qsys, core, base);
    assert.equal(plain.DegradedReason, 'Bridge "USB-Lectern" Fault - no host');
    const flagged = await run(qsys, core, { ...base, FlagNotPresent: true });
    assert.match(flagged.DegradedReason, /I\/O "QIO-FOH" Not Present/);
    const noBridges = await run(qsys, core, { ...base, DeviceBridges: false });
    assert.ok(!noBridges.Degraded, noBridges.DegradedReason);
    assert.ok(!noBridges.Devices.some((d) => d.Name === 'USB-Lectern'));
  });
});

test('qsys-core Other devices picks up exposed components with a status control', async () => {
  const qsys = load();
  const components = [
    ...DESIGN,
    { Name: 'NV-Encoder', Type: 'vstreamer_status', Controls: [statusControl(2, 'Fault')] },
  ];
  await withCore({ components }, async (core) => {
    const off = await run(qsys, core, { CheckDevices: true });
    assert.ok(!off.Degraded, off.DegradedReason);
    assert.ok(off.DevicesUnmatched.some((c) => c.Name === 'NV-Encoder'));
    const on = await run(qsys, core, { CheckDevices: true, DeviceOther: true });
    // MainGain has no status control: read, then quietly not a device.
    assert.equal(on.DegradedReason, 'Device "NV-Encoder" Fault');
  });
});

test('qsys-core listed devices: found, missing, and without a status control', async () => {
  const qsys = load();
  const components = withDesign({ 'Cam-Rear': { Controls: [statusControl(5, 'Initializing')] } });
  await withCore({ components }, async (core) => {
    const result = await run(qsys, core, {
      CheckDevices: true,
      DeviceSource: 'list',
      DeviceNames: [' Cam-Rear ', 'Amp-Gone', 'MainGain', 'Cam-Rear', ''],
      // Categories do not filter a list.
      DeviceCameras: false,
    });
    assert.equal(result.Degraded, true);
    assert.deepEqual(
      result.Devices.map((d) => d.Name),
      ['Cam-Rear', 'Amp-Gone', 'MainGain']
    );
    assert.equal(
      result.DegradedReason,
      'Camera "Cam-Rear" Initializing; ' +
        'Device "Amp-Gone" not found (check its Code Name and that Script Access is External or All); ' +
        'Device "MainGain" has no "status" control'
    );

    const custom = await run(qsys, core, {
      CheckDevices: true,
      DeviceSource: 'list',
      DeviceNames: ['MainGain'],
      StatusControlName: 'gain',
      CheckAmpFaults: false,
    });
    assert.ok(!custom.Degraded, custom.DegradedReason);
    assert.equal(custom.Devices[0].StatusCode, 0);
    // No amp faults wanted: no GetComponents needed for a list.
    const last = core.received.slice(-1)[0];
    assert.equal(last.method, 'Component.Get');
    assert.deepEqual(last.params, { Name: 'MainGain', Controls: [{ Name: 'gain' }] });
  });
});

test('qsys-core a listed amplifier gets its fault controls read', async () => {
  const qsys = load();
  const components = withDesign({
    'AmpOut-Stage-L': {
      Controls: [
        statusControl(0, 'OK'),
        { Name: 'channel.4.over.current', Type: 'Boolean', Value: true, String: 'true' },
        // Limiter lights are signal level, not faults.
        { Name: 'channel.1.dac.limit', Type: 'Boolean', Value: true, String: 'true' },
        { Name: 'channel.2.limit', Type: 'Boolean', Value: true, String: 'true' },
      ],
    },
  });
  await withCore({ components }, async (core) => {
    const result = await run(qsys, core, {
      CheckDevices: true,
      DeviceSource: 'list',
      DeviceNames: ['AmpOut-Stage-L', 'Amp-Stage-L'],
    });
    assert.equal(
      result.DegradedReason,
      'Amplifier "AmpOut-Stage-L" channel fault: channel.4.over.current'
    );
    // The Status component is not an Amp Output: asked for its status only.
    const status = core.received.find(
      (m) => m.method === 'Component.Get' && m.params.Name === 'Amp-Stage-L'
    );
    assert.ok(status);
  });
});

test('qsys-core Unknown (3) is a fault unless the device says Not Present', async () => {
  const qsys = load();
  const components = withDesign({
    'TSC-Booth': { Controls: [statusControl(3, 'Unknown')] },
    'Amp-Stage-L': { Controls: [statusControl(4, 'Updating firmware')] },
  });
  await withCore({ components }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true });
    assert.equal(
      result.DegradedReason,
      'Amplifier "Amp-Stage-L" Updating firmware; Touch panel "TSC-Booth" Unknown'
    );
  });
});

test('qsys-core Amp Output faults count even without a status control', async () => {
  const qsys = load();
  const components = withDesign({
    'AmpOut-Stage-L': {
      Controls: [{ Name: 'channel.3.protect', Type: 'Boolean', Value: true, String: 'true' }],
    },
  });
  await withCore({ components }, async (core) => {
    const target = { Address: '127.0.0.1', Settings: { Port: core.port, CheckDevices: true } };
    const result = await qsys.Run(target);
    assert.equal(
      result.DegradedReason,
      'Amplifier "AmpOut-Stage-L" channel fault: channel.3.protect'
    );
    assert.match(qsys.Debug(result, target), /Channel fault/);
  });
});

test('qsys-core reads a large design a few devices at a time', async () => {
  const qsys = load();
  const many = Array.from({ length: 140 }, (_, i) => ({
    Name: `QIO-${i}`,
    Type: 'lcqln_status',
    Controls: [statusControl(0, 'OK')],
  }));
  // Count requests outstanding at the Core: answered only after a short delay.
  let inFlight = 0;
  let peak = 0;
  const server = await startRaw((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\0')) !== -1) {
        const msg = JSON.parse(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        const send = (body) =>
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\0');
        if (msg.method === 'StatusGet') send({ result: STATUS_OK });
        else if (msg.method === 'Component.GetComponents') {
          send({ result: many.map((c) => ({ ID: c.Name, Name: c.Name, Type: c.Type })) });
        } else {
          inFlight++;
          peak = Math.max(peak, inFlight);
          setTimeout(() => {
            inFlight--;
            send({ result: { Name: msg.params.Name, Controls: [statusControl(0, 'OK')] } });
          }, 2);
        }
      }
    });
  });
  try {
    const result = await qsys.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 5000, CheckDevices: true },
    });
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Devices.length, 128);
    assert.ok(result.Devices.every((d) => d.Read));
    assert.equal(result.DevicesOverLimit, 12);
    assert.ok(peak <= 8, `peak in flight ${peak}`);
  } finally {
    await server.close();
  }
});

test('qsys-core discovery: none exposed, listing refused, and capped reasons', async () => {
  const qsys = load();
  await withCore(
    { components: [{ Name: 'MainGain', Type: 'gain', Controls: [] }] },
    async (core) => {
      const result = await run(qsys, core, { CheckDevices: true });
      assert.equal(
        result.DegradedReason,
        'No design devices found (set Script Access to External or All)'
      );
    }
  );
  await withCore({ componentsError: { code: 10, message: 'Logon required' } }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true });
    assert.equal(result.DegradedReason, 'Could not list design devices: Logon required (10)');
  });
  const many = Array.from({ length: 8 }, (_, i) => ({
    Name: `QIO-${i}`,
    Type: 'lcqln_status',
    Controls: [statusControl(4, 'Missing')],
  }));
  await withCore({ components: many }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true });
    const parts = result.DegradedReason.split('; ');
    assert.equal(parts.length, 6);
    assert.equal(parts[5], '3 more device problems');
  });
});

test('qsys-core devices are only read on an Active Core', async () => {
  const qsys = load();
  const status = { ...STATUS_OK, State: 'Standby', IsRedundant: true };
  await withCore({ status, components: DESIGN }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true, RequireActive: false });
    assert.ok(!result.Degraded, result.DegradedReason);
    assert.equal(result.Devices, null);
    assert.match(result.DevicesSkipped, /Standby/);
    assert.ok(!core.received.some((m) => m.method.startsWith('Component.')));
    const html = qsys.Debug(result, {
      Address: '127.0.0.1',
      Settings: { CheckDevices: true },
    });
    assert.match(html, /Devices not read: Core is Standby/);
  });
});

test('qsys-core keeps the device answers that arrived inside the budget', async () => {
  const qsys = load();
  await withCore({ components: DESIGN, silentDevices: ['Cam-Rear'] }, async (core) => {
    const started = Date.now();
    const result = await run(qsys, core, { CheckDevices: true, Timeout: 700 });
    assert.ok(Date.now() - started < 1500, 'whole probe stays inside the budget');
    assert.equal(result.Success, true);
    assert.equal(result.Degraded, true);
    assert.equal(result.DegradedReason, 'The Core did not finish Component.Get in time');
    const cam = result.Devices.find((d) => d.Name === 'Cam-Rear');
    assert.equal(cam.Read, false);
    const qio = result.Devices.find((d) => d.Name === 'QIO-FOH');
    assert.equal(qio.Read, true);
    assert.equal(qio.StatusCode, 0);
    const html = qsys.Debug(result, { Address: '127.0.0.1', Settings: { CheckDevices: true } });
    assert.match(html, /Not read in time/);
  });
});

test('qsys-core survives fragmented device replies', async () => {
  const qsys = load();
  const components = withDesign({ 'QIO-FOH': { Controls: [statusControl(2, 'Fault')] } });
  await withCore({ components, fragment: true }, async (core) => {
    const result = await run(qsys, core, { CheckDevices: true, Timeout: 4000 });
    assert.equal(result.DegradedReason, 'I/O "QIO-FOH" Fault');
  });
});

test('qsys-core device parsing ignores hostile shapes', () => {
  const { ParseComponentList, ApplyDeviceResult, IsLitFault, CategorizeType } = load()._internal;
  const hostile = { toString: 1, valueOf: 1 };
  assert.deepEqual(ParseComponentList({ not: 'a list' }), []);
  assert.deepEqual(
    ParseComponentList([
      null,
      5,
      { Name: hostile, ID: 'Amp-1', Type: hostile },
      { Name: 'B', Type: 'x' },
    ]),
    [
      { Name: 'Amp-1', Type: null },
      { Name: 'B', Type: 'x' },
    ]
  );
  const reading = {
    Name: 'A',
    Type: null,
    Category: CategorizeType(null),
    Read: false,
    Found: false,
    HasStatus: false,
    StatusCode: null,
    StatusString: null,
    Faults: [],
    FaultsChecked: false,
    Error: null,
  };
  ApplyDeviceResult(
    reading,
    { Controls: [null, { Name: hostile }, { Name: 'Status', Value: hostile, String: hostile }] },
    'status',
    true
  );
  assert.equal(reading.Found, true);
  assert.equal(reading.HasStatus, true);
  assert.equal(reading.StatusCode, null);
  assert.equal(reading.StatusString, null);
  assert.equal(IsLitFault({ Name: 'protect', Type: 'Boolean', Value: hostile }), false);
  assert.equal(IsLitFault({ Name: 'protect', Type: 'Led', Value: 1 }), true);
  assert.equal(IsLitFault({ Name: 'protect', Type: 'Float', Value: 1 }), false);
});

test('qsys-core Debug renders the device table and escapes device strings', async () => {
  const qsys = load();
  const evil = '<img src=x onerror=alert(1)>';
  const components = [
    ...withDesign({ 'Amp-Stage-L': { Controls: [statusControl(2, evil)] } }),
    { Name: evil, Type: `${evil}_status`, Controls: [] },
  ];
  await withCore({ components }, async (core) => {
    const target = {
      Address: '127.0.0.1',
      Settings: { Port: core.port, Timeout: 1500, CheckDevices: true },
    };
    const result = await qsys.Run(target);
    const html = qsys.Debug(result, target);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    assert.match(html, /Design devices/);
    assert.match(html, /Amp-Stage-L/);
    assert.match(html, /TSC-Booth/);
    assert.match(html, /Touch panel · type touch_screen_status/);
    assert.match(html, /no channel faults/);
    // An uncategorised status component is listed (escaped) for Other devices.
    assert.match(html, /Not in a device category: &lt;img/);
    // Not status components: never read, never listed.
    assert.doesNotMatch(html, /Flex-In/);
    assert.doesNotMatch(html, /MainGain/);
  });
});

// --- Actions -------------------------------------------------------------------

function act(qsys, core, actionID, params, settings = {}) {
  return qsys.RunAction(
    { Address: '127.0.0.1', Settings: { Port: core.port, Timeout: 1500, ...settings } },
    actionID,
    params
  );
}

test('qsys-core declares Load Snapshot and Set Named Control, both confirmed first', () => {
  const qsys = load();
  const byId = Object.fromEntries(qsys.Actions.map((a) => [a.ID, a]));
  assert.deepEqual(Object.keys(byId), ['snapshot.load', 'control.set']);
  for (const action of qsys.Actions) {
    assert.equal(action.Destructive, true, action.ID);
    assert.ok(!action.AllowedWhileOffline, action.ID);
    assert.match(action.ID, /^[a-z]+(\.[a-z]+)+$/);
    assert.ok(action.Icon && !action.Icon.startsWith('bi-'));
  }
  // The trailing OSC value fills the first param.
  assert.deepEqual(
    byId['snapshot.load'].Params.map((p) => p.Key),
    ['Bank', 'Snapshot', 'Ramp']
  );
  assert.deepEqual(
    byId['control.set'].Params.map((p) => p.Key),
    ['Name', 'Value']
  );
  assert.equal(typeof qsys.RunAction, 'function');
});

test('qsys-core snapshot.load sends the documented Snapshot.Load after confirming Active', async () => {
  const qsys = load();
  await withCore({ banks: { Scenes: 8 } }, async (core) => {
    const result = await act(qsys, core, 'snapshot.load', {
      Bank: ' Scenes ',
      Snapshot: 3,
      Ramp: 2.5,
    });
    assert.deepEqual(result, {
      Success: true,
      Detail: 'Snapshot 3 loaded from "Scenes" over 2.5 s',
    });
    assert.deepEqual(
      core.received.map((m) => m.method),
      ['StatusGet', 'Snapshot.Load']
    );
    const sent = core.received[1];
    assert.equal(sent.jsonrpc, '2.0');
    assert.equal(typeof sent.id, 'number');
    // QRC: Name is the bank, Bank the snapshot number, Ramp optional seconds.
    assert.deepEqual(sent.params, { Name: 'Scenes', Bank: 3, Ramp: 2.5 });

    const instant = await act(qsys, core, 'snapshot.load', { Bank: 'Scenes', Snapshot: '8' });
    assert.equal(instant.Detail, 'Snapshot 8 loaded from "Scenes"');
    assert.deepEqual(core.received.at(-1).params, { Name: 'Scenes', Bank: 8 });

    const refused = await act(qsys, core, 'snapshot.load', { Bank: 'Scenes', Snapshot: 9 });
    assert.equal(refused.Success, false);
    assert.equal(
      refused.Error,
      'The Core did not load snapshot 9 from "Scenes": Invalid params (-32602)'
    );
  });
});

test('qsys-core snapshot.load validates its parameters before connecting', async () => {
  const qsys = load();
  await withCore({ banks: { Scenes: 8 } }, async (core) => {
    const cases = [
      [{ Bank: '', Snapshot: 1 }, 'Enter the snapshot bank name'],
      [{ Bank: 'Scenes', Snapshot: 0 }, 'The snapshot number must be a whole number from 1 up'],
      [{ Bank: 'Scenes', Snapshot: 1.5 }, 'The snapshot number must be a whole number from 1 up'],
      [{ Bank: 'Scenes', Snapshot: 'x' }, 'The snapshot number must be a whole number from 1 up'],
      [{ Bank: 'Scenes', Snapshot: 1, Ramp: -1 }, 'The ramp must be between 0 and 600 seconds'],
      [{ Bank: { evil: 1 }, Snapshot: 1 }, 'Enter the snapshot bank name'],
    ];
    for (const [params, error] of cases) {
      assert.deepEqual(await act(qsys, core, 'snapshot.load', params), {
        Success: false,
        Error: error,
      });
    }
    assert.equal(core.received.length, 0);
  });
});

test('qsys-core control.set sends Control.Set with a typed value', async () => {
  const qsys = load();
  const controls = { MainMute: { Value: 0 }, MainGain: { Value: 0 }, Source: { Value: 'A' } };
  await withCore({ controls }, async (core) => {
    assert.deepEqual(await act(qsys, core, 'control.set', { Name: 'MainMute', Value: 'TRUE' }), {
      Success: true,
      Detail: 'MainMute set to true',
    });
    assert.deepEqual(core.received.at(-1).params, { Name: 'MainMute', Value: true });
    await act(qsys, core, 'control.set', { Name: 'MainGain', Value: '-6.5' });
    assert.deepEqual(core.received.at(-1).params, { Name: 'MainGain', Value: -6.5 });
    await act(qsys, core, 'control.set', { Name: 'Source', Value: 'Lectern' });
    assert.deepEqual(core.received.at(-1).params, { Name: 'Source', Value: 'Lectern' });
    assert.equal(core.received.at(-1).method, 'Control.Set');

    const unknown = await act(qsys, core, 'control.set', { Name: 'Nope', Value: '1' });
    assert.deepEqual(unknown, {
      Success: false,
      Error: 'The Core has no Named Control called "Nope"',
    });
    const before = core.received.length;
    assert.deepEqual(await act(qsys, core, 'control.set', { Name: 'MainGain', Value: ' ' }), {
      Success: false,
      Error: 'Enter a value for "MainGain"',
    });
    assert.deepEqual(await act(qsys, core, 'control.set', { Value: '1' }), {
      Success: false,
      Error: 'Enter the Named Control to set',
    });
    assert.equal(core.received.length, before);
  });
});

test('qsys-core actions are only sent to an Active Core', async () => {
  const qsys = load();
  const status = { ...STATUS_OK, State: 'Standby', IsRedundant: true };
  await withCore({ status, banks: { Scenes: 8 } }, async (core) => {
    const result = await act(qsys, core, 'snapshot.load', { Bank: 'Scenes', Snapshot: 1 });
    assert.deepEqual(result, {
      Success: false,
      Error: 'The Core is Standby, not Active. Commands are only sent to the Active Core.',
    });
    assert.ok(!core.received.some((m) => m.method === 'Snapshot.Load'));
  });
  await withCore({ statusError: { code: -32604, message: 'Core is on Standby' } }, async (core) => {
    const result = await act(qsys, core, 'control.set', { Name: 'MainMute', Value: 'true' });
    assert.equal(
      result.Error,
      'The Core is on Standby. Commands are only sent to the Active Core.'
    );
    assert.ok(!core.received.some((m) => m.method === 'Control.Set'));
  });
  await withCore(
    { controls: { MainMute: { Value: 0 } }, commandError: { code: -32604 } },
    async (core) => {
      const result = await act(qsys, core, 'control.set', { Name: 'MainMute', Value: 'true' });
      assert.equal(
        result.Error,
        'The Core is on Standby. Commands are only sent to the Active Core.'
      );
    }
  );
});

test('qsys-core actions log on with the check credentials', async () => {
  const qsys = load();
  const creds = { User: 'showtrak', Password: '1234' };
  await withCore({ creds, banks: { Scenes: 2 } }, async (core) => {
    const ok = await act(qsys, core, 'snapshot.load', { Bank: 'Scenes', Snapshot: 2 }, creds);
    assert.equal(ok.Success, true);
    assert.deepEqual(
      core.received.map((m) => m.method),
      ['Logon', 'StatusGet', 'Snapshot.Load']
    );
    assert.deepEqual(core.received[0].params, creds);

    const bad = await act(
      qsys,
      core,
      'snapshot.load',
      { Bank: 'Scenes', Snapshot: 2 },
      { User: 'showtrak', Password: '9' }
    );
    assert.deepEqual(bad, {
      Success: false,
      Error: 'The Core refused the logon. Check the user and PIN on this check.',
    });
    const none = await act(qsys, core, 'snapshot.load', { Bank: 'Scenes', Snapshot: 2 });
    assert.equal(none.Error, 'The Core needs a logon. Set the user and PIN on this check.');
  });
});

test('qsys-core actions report offline, silent, non-Core and unknown actions', async () => {
  const qsys = load();
  assert.deepEqual(await qsys.RunAction({ Settings: {} }, 'snapshot.load', {}), {
    Success: false,
    Error: 'No address configured',
  });
  await withCore({}, async (core) => {
    assert.deepEqual(await act(qsys, core, 'power.off', {}), {
      Success: false,
      Error: 'Unknown Q-SYS action "power.off"',
    });
  });
  // Accepts the connection, never answers.
  const silent = await startRaw(() => {});
  try {
    const started = Date.now();
    const result = await qsys.RunAction(
      { Address: '127.0.0.1', Settings: { Port: silent.port, Timeout: 600 } },
      'control.set',
      { Name: 'MainMute', Value: 'true' }
    );
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(result, {
      Success: false,
      Error: 'No reply from the Q-SYS Core after 600ms',
    });
  } finally {
    await silent.close();
  }
  // Answers StatusGet, then never confirms the command.
  const stalls = await startRaw((socket) => {
    socket.on('data', (chunk) => {
      const msg = JSON.parse(chunk.toString('utf8').split('\0')[0]);
      if (msg.method === 'StatusGet') {
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: STATUS_OK }) + '\0');
      }
    });
  });
  try {
    const result = await qsys.RunAction(
      { Address: '127.0.0.1', Settings: { Port: stalls.port, Timeout: 600 } },
      'control.set',
      { Name: 'MainMute', Value: 'true' }
    );
    assert.equal(result.Error, 'The Core did not confirm the command within 600ms');
  } finally {
    await stalls.close();
  }
  const notCore = await startRaw((socket) => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
  try {
    const result = await qsys.RunAction(
      { Address: '127.0.0.1', Settings: { Port: notCore.port, Timeout: 600 } },
      'control.set',
      { Name: 'MainMute', Value: 'true' }
    );
    assert.equal(result.Error, 'The device did not answer as a Q-SYS Core');
  } finally {
    await notCore.close();
  }
});

test('qsys-core offers the Named Controls it reads and labels favourites', () => {
  const qsys = load();
  assert.deepEqual(qsys.GetActionOptions({ Success: true }), {});
  assert.deepEqual(qsys.GetActionOptions({ Success: true, Controls: 'junk' }), {});
  assert.deepEqual(
    qsys.GetActionOptions({
      Success: true,
      Controls: [
        { Name: 'MainMute', Found: true },
        { Name: 'MainGain', Found: false },
        { Name: 'MainMute', Found: true },
        null,
        { Name: { evil: 1 } },
      ],
    }),
    {
      Name: [
        { value: 'MainMute', label: 'MainMute' },
        { value: 'MainGain', label: 'MainGain' },
      ],
    }
  );
  assert.equal(
    qsys.DescribeAction('snapshot.load', { Bank: 'Scenes', Snapshot: 3, Ramp: 0 }),
    'Load Snapshot — Scenes 3'
  );
  assert.equal(
    qsys.DescribeAction('snapshot.load', { Bank: 'Scenes', Snapshot: 3, Ramp: 5 }),
    'Load Snapshot — Scenes 3 over 5 s'
  );
  assert.equal(
    qsys.DescribeAction('control.set', { Name: 'MainMute', Value: 'false' }),
    'Set MainMute — false'
  );
  assert.equal(qsys.DescribeAction('control.set', { Name: 'MainMute' }), null);
  assert.equal(qsys.DescribeAction('snapshot.load', {}), null);
  assert.equal(qsys.DescribeAction('nope', {}), null);
});

test('qsys-core the check itself never sends a command', async () => {
  const qsys = load();
  await withCore({ components: DESIGN, controls: { MainMute: { Value: 0 } } }, async (core) => {
    await run(qsys, core, {
      CheckDevices: true,
      CheckControls: true,
      ControlAssertions: ['MainMute=false'],
    });
    const reads = new Set([
      'StatusGet',
      'Control.Get',
      'Component.GetComponents',
      'Component.Get',
      'Component.GetControls',
    ]);
    assert.ok(core.received.every((m) => reads.has(m.method)));
  });
});

test('qsys-core keeps a UTF-8 character split across reads intact', async () => {
  const qsys = load();
  const design = 'SAF‐MainPA é';
  const server = await startRaw((socket) => {
    socket.on('data', (chunk) => {
      const msg = JSON.parse(chunk.toString('utf8').split('\0')[0]);
      const bytes = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { ...STATUS_OK, DesignName: design },
        }) + '\0'
      );
      // Split inside the three-byte hyphen.
      const cut = bytes.indexOf(Buffer.from('‐')) + 1;
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.write(bytes.subarray(cut)), 20);
    });
  });
  try {
    const result = await qsys.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 1500 },
    });
    assert.equal(result.DesignName, design);
  } finally {
    await server.close();
  }
});
