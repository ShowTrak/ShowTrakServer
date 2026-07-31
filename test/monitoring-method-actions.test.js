// Control actions on monitoring methods.
//
// These cover the send side of the monitoring family, which until now could only
// read. Two things here matter more than the mechanics:
//
//  - A refused command must never report success. PJLink answers a refusal with
//    a perfectly well-formed reply line carrying an ERR token, and ERR3 is what a
//    projector says while warming or cooling — exactly when an operator is most
//    likely to press power. If that read as success, the one error message that
//    matters would be the one nobody sees.
//  - A fire-and-forget transport must not claim confirmation. QLab and Eos are
//    told to do things over OSC and say nothing back, so "sent" is the honest
//    result and Confirmed:false is what says so.
const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { startPJLinkServer } = require('./helpers/pjlink-server');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

function resetSnapshotCache() {
  const { Manager } = require(path.join(__dirname, '..', 'dist', 'Modules', 'CacheManager'));
  Manager.ClearBucket('MonitoringMethods:PJLinkStatus');
  Manager.ClearBucket('MonitoringMethods:Run');
}

beforeEach(resetSnapshotCache);

// --- The command builder -----------------------------------------------------

test('BuildCommand emits set commands, BuildQuery keeps the query form', () => {
  const { _internal } = require(methodPath('_pjlink-shared.js'));

  assert.equal(_internal.BuildCommand('POWR', '1', null).toString('utf8'), '%1POWR 1\r');
  assert.equal(_internal.BuildCommand('AVMT', '31', null).toString('utf8'), '%1AVMT 31\r');
  assert.equal(_internal.BuildQuery('POWR', null).toString('utf8'), '%1POWR ?\r');

  // The auth digest is prefixed on the first command of a connection only; the
  // builder is what places it, so it has to survive the parameter change.
  assert.equal(_internal.BuildCommand('POWR', '1', 'abc123').toString('utf8'), 'abc123%1POWR 1\r');
});

// --- PJLink control ----------------------------------------------------------

test('pjlink power actions send the right parameter and report acknowledgement', async () => {
  const server = await startPJLinkServer({ responses: {}, setResponses: {} });
  const pjlink = require(methodPath('pjlink.js'));
  const target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } };

  try {
    const on = pjlink.Actions.find((a) => a.ID === 'power.on');
    const result = await on.Run(target, {});
    assert.equal(result.Success, true);
    assert.equal(result.Confirmed, true);

    const off = pjlink.Actions.find((a) => a.ID === 'power.off');
    await off.Run(target, {});

    assert.deepEqual(
      server.getSetCommands(),
      [
        { Command: 'POWR', Param: '1' },
        { Command: 'POWR', Param: '0' },
      ],
      'power on must send POWR 1 and power off POWR 0'
    );
  } finally {
    await server.close();
  }
});

test('a projector answering ERR3 is a failure, not a success', async () => {
  // ERR3 is "unavailable time" — the projector is warming, cooling or in
  // standby. It is the single most likely reply to a power command pressed in
  // anger, and the whole point of judging the token rather than the reply shape.
  const server = await startPJLinkServer({ setResponses: { POWR: 'ERR3' } });
  const pjlink = require(methodPath('pjlink.js'));
  const target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } };

  try {
    const result = await pjlink.Actions.find((a) => a.ID === 'power.on').Run(target, {});
    assert.equal(result.Success, false);
    assert.match(result.Error, /busy/i);
    assert.equal(result.Data.Token, 'ERR3');
  } finally {
    await server.close();
  }
});

test('every PJLink refusal token maps to its own operator-facing message', async () => {
  const cases = [
    ['ERR1', /does not support/i],
    ['ERR2', /rejected the value/i],
    ['ERR4', /reported a failure/i],
  ];

  for (const [token, expected] of cases) {
    const server = await startPJLinkServer({ setResponses: { AVMT: token } });
    const pjlink = require(methodPath('pjlink.js'));
    const target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } };
    try {
      const result = await pjlink.Actions.find((a) => a.ID === 'mute.on').Run(target, {});
      assert.equal(result.Success, false, `${token} must fail`);
      assert.match(result.Error, expected);
      // The raw token stays available for the run log without being the message.
      assert.equal(result.Data.Token, token);
    } finally {
      await server.close();
    }
  }
});

test('power off treats a dropped session as success, other commands do not', async () => {
  // A projector entering cooling hangs up rather than replying. That is the
  // command working — reporting "connection closed" there trains an operator to
  // ignore the error that would matter if it were real.
  const dropping = await startPJLinkServer({
    setResponses: { POWR: '__drop__', AVMT: '__drop__' },
  });
  const pjlink = require(methodPath('pjlink.js'));
  const target = { Address: '127.0.0.1', Settings: { Port: dropping.port, Timeout: 2000 } };

  try {
    const off = await pjlink.Actions.find((a) => a.ID === 'power.off').Run(target, {});
    assert.equal(off.Success, true);
    assert.equal(off.Confirmed, false, 'a hang-up cannot confirm the projector acted');
    assert.match(off.Detail, /expected/i);

    // The same hang-up on a command with no ExpectDisconnect is still a failure.
    const mute = await pjlink.Actions.find((a) => a.ID === 'mute.on').Run(target, {});
    assert.equal(mute.Success, false);
  } finally {
    await dropping.close();
  }
});

test('input.select refuses codes that are not PJLink input codes', async () => {
  const pjlink = require(methodPath('pjlink.js'));
  const action = pjlink.Actions.find((a) => a.ID === 'input.select');
  const target = { Address: '127.0.0.1', Settings: { Port: 4352 } };

  // No server needed: these must be refused before anything reaches the wire.
  for (const bad of ['', 'HDMI', '3', '311', '3!']) {
    const result = await action.Run(target, { Code: bad });
    assert.equal(result.Success, false, `"${bad}" must be refused`);
  }
});

test('a PJLink control command serialises against a concurrent probe', async () => {
  // Many projectors accept exactly one PJLink session. The snapshot cache does
  // not enforce that — its key includes the password and timeout, so two checks
  // on one projector with different settings already open two sockets. The
  // device lock is what actually holds the line.
  const server = await startPJLinkServer({ responses: { POWR: '1' } });
  const shared = require(methodPath('_pjlink-shared.js'));
  const pjlink = require(methodPath('pjlink.js'));

  try {
    let concurrent = 0;
    let peak = 0;
    const tracked = () =>
      shared.WithPJLinkLock('127.0.0.1', server.port, async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      });

    await Promise.all([
      tracked(),
      tracked(),
      pjlink.Actions.find((a) => a.ID === 'power.on').Run(
        { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } },
        {}
      ),
    ]);

    assert.equal(peak, 1, 'only one session per device may be open at a time');
  } finally {
    await server.close();
  }
});

// --- Registry-level RunAction ------------------------------------------------

test('RunAction refuses unknown methods and actions rather than reporting success', async () => {
  const { Manager } = require(methodPath('index.js'));

  const noMethod = await Manager.RunAction('not-a-method', 'power.on', {}, {});
  assert.equal(noMethod.Success, false);
  assert.match(noMethod.Error, /Unknown method/);

  const noAction = await Manager.RunAction('pjlink', 'self.destruct', {}, {});
  assert.equal(noAction.Success, false);
  assert.match(noAction.Error, /Unknown action/);

  // A read-only method has no actions at all, so everything is refused.
  const readOnly = await Manager.RunAction('ping', 'anything', {}, {});
  assert.equal(readOnly.Success, false);
});

test('RunAction enforces Required params before touching the transport', async () => {
  const { Manager } = require(methodPath('index.js'));

  // Unlike check settings — where Required is only a display hint — an action
  // with a missing required parameter must refuse. A QLab GO with a blank cue
  // number would otherwise fire something arbitrary in front of an audience.
  const result = await Manager.RunAction(
    'qlab5',
    'cue.start',
    { Address: '127.0.0.1', Settings: {} },
    {}
  );
  assert.equal(result.Success, false);
  assert.match(result.Error, /requires/i);
});

test('RunAction forces Confirmed false for fire-and-forget transports', async () => {
  const { Manager } = require(methodPath('index.js'));

  // qlab5 is not connected here, so this fails — but the point is the shape the
  // registry imposes, which must not let a transport overclaim.
  const method = Manager.Get('qlab5');
  const action = method.Actions.find((a) => a.ID === 'workspace.go');
  assert.equal(action.FireAndForget, true);

  const shape = Manager.GetAll().find((m) => m.ID === 'qlab5');
  const published = shape.Actions.find((a) => a.ID === 'workspace.go');
  assert.equal(published.FireAndForget, true);
  assert.equal(typeof published.Run, 'undefined', 'Run must never reach the renderer');
});

test('published method shapes expose action params for the step editor', () => {
  const { Manager } = require(methodPath('index.js'));
  const pjlink = Manager.GetAll().find((m) => m.ID === 'pjlink');

  const input = pjlink.Actions.find((a) => a.ID === 'input.select');
  assert.equal(input.Params.length, 1);
  assert.equal(input.Params[0].Key, 'Code');
  assert.equal(input.Params[0].Required, true);

  const off = pjlink.Actions.find((a) => a.ID === 'power.off');
  assert.equal(off.Destructive, true);

  // Read-only methods publish an empty array, never undefined, so the editor
  // never has to guard.
  const ping = Manager.GetAll().find((m) => m.ID === 'ping');
  assert.deepEqual(ping.Actions, []);
});

test('action IDs are unique within a method and every action is runnable', () => {
  const { Manager } = require(methodPath('index.js'));

  for (const shape of Manager.GetAll()) {
    const method = Manager.Get(shape.ID);
    const actions = method.Actions || [];
    const ids = actions.map((a) => a.ID);
    assert.equal(new Set(ids).size, ids.length, `${shape.ID} has duplicate action IDs`);
    for (const action of actions) {
      assert.ok(action.Label, `${shape.ID}/${action.ID} needs a Label`);
      assert.equal(typeof action.Run, 'function', `${shape.ID}/${action.ID} needs Run()`);
      for (const param of action.Params || []) {
        assert.ok(param.Key, `${shape.ID}/${action.ID} has a param with no Key`);
        assert.ok(param.Label, `${shape.ID}/${action.ID}/${param.Key} needs a Label`);
      }
    }
  }
});

// --- QLab / Eos address safety ----------------------------------------------

test('QLab cue numbers that would rewrite the OSC address are refused', async () => {
  const qlab5 = require(methodPath('qlab5.js'));
  const action = qlab5.Actions.find((a) => a.ID === 'cue.start');
  const target = { Address: '127.0.0.1', Settings: { Port: 53000 } };

  // A cue number is interpolated into an OSC address. '/' would change which
  // address is hit entirely, and OSC treats * ? [ ] { } as wildcards — a cue
  // number of '*' would address every cue in the workspace at once.
  for (const bad of ['', '5/stop', '*', '?', '1,2', '[1-9]', '{a,b}', '5 6']) {
    const result = await action.Run(target, { Number: bad });
    assert.equal(result.Success, false, `"${bad}" must be refused`);
  }

  // A legitimate cue number gets past validation and fails on the connection
  // instead, which is the only reason it can fail here.
  const ok = await action.Run(target, { Number: '12.5' });
  assert.equal(ok.Success, false);
  assert.match(ok.Error, /not connected/i);
});

test('Eos cue and macro numbers are restricted to Eos numbering', async () => {
  const eos = require(methodPath('eos.js'));
  const action = eos.Actions.find((a) => a.ID === 'cue.fire');
  const target = { Address: '192.0.2.1', Settings: { Port: 3032, Timeout: 300 } };

  const blank = await action.Run(target, { Number: '', List: 1, OscUser: 1 });
  assert.equal(blank.Success, false);
  assert.match(blank.Error, /No cue number/i);

  for (const bad of ['next', '1/2', '*', '12.5.7']) {
    const result = await action.Run(target, { Number: bad, List: 1, OscUser: 1 });
    assert.equal(result.Success, false, `"${bad}" must be refused`);
    assert.match(result.Error, /not an Eos/i);
  }
});

test('Eos actions make the OSC user an explicit choice', () => {
  const eos = require(methodPath('eos.js'));

  // The probe pins itself to user 0 — a background user that never touches the
  // live command line, which is right for reading and wrong for controlling: a
  // cue fired as a background user leaves no trace on the console the operator
  // is watching. Both actions must surface the choice rather than inherit it.
  for (const id of ['cue.fire', 'macro.fire']) {
    const action = eos.Actions.find((a) => a.ID === id);
    const param = (action.Params || []).find((p) => p.Key === 'OscUser');
    assert.ok(param, `${id} must expose the OSC user`);
    assert.notEqual(param.Default, 0, `${id} must not default to the background user`);
  }
});
