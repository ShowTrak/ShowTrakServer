const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  startPJLinkServer,
  startSilentServer,
  HEALTHY_RESPONSES,
} = require('./helpers/pjlink-server');

function methodPath(name) {
  return path.join(__dirname, '..', 'dist', 'Modules', 'MonitoringMethods', name);
}

// Load the family fresh, sharing one _pjlink-shared instance (and thus one
// snapshot cache) between the methods — mirrors how the registry loads them.
function loadShared() {
  return require(methodPath('_pjlink-shared.js'));
}
function loadPjlink() {
  return require(methodPath('pjlink.js'));
}

// The snapshot cache is keyed on address|port|password|timeout, so two tests
// that happen to be handed the same ephemeral port within the ~1s TTL would
// share a snapshot — the second test then judges the first test's projector.
// Rare locally, common on CI where the kernel recycles ports quickly.
function resetSnapshotCache() {
  const { Manager } = require(path.join(__dirname, '..', 'dist', 'Modules', 'CacheManager'));
  Manager.ClearBucket('MonitoringMethods:PJLinkStatus');
}

beforeEach(resetSnapshotCache);

// --- Pure protocol helpers ---------------------------------------------------

test('ParseGreeting recognises both greeting forms', () => {
  const { _internal } = loadShared();
  assert.deepEqual(_internal.ParseGreeting('PJLINK 0'), { Auth: false });
  assert.deepEqual(_internal.ParseGreeting('PJLINK 1 498e4a67'), {
    Auth: true,
    Seed: '498e4a67',
  });
  assert.equal(_internal.ParseGreeting('HELLO WORLD'), null);
});

test('BuildAuthDigest matches the PJLink spec test vector', () => {
  const { _internal } = loadShared();
  assert.equal(
    _internal.BuildAuthDigest('498e4a67', 'JBMIAProjectorLink'),
    '5d8409bc1c3fa39749434aa3a5c38682'
  );
});

test('ParseResponseLine handles replies and the ERRA auth-failure line', () => {
  const { _internal } = loadShared();
  assert.deepEqual(_internal.ParseResponseLine('%1POWR=1'), {
    Kind: 'reply',
    Command: 'POWR',
    Value: '1',
  });
  assert.deepEqual(_internal.ParseResponseLine('PJLINK ERRA'), { Kind: 'auth-fail' });
  assert.equal(_internal.ParseResponseLine('garbage'), null);
});

test('ParseErst decodes the six fixed-position digits', () => {
  const { _internal } = loadShared();
  assert.deepEqual(_internal.ParseErst('012000'), {
    Fan: 0,
    Lamp: 1,
    Temperature: 2,
    Cover: 0,
    Filter: 0,
    Other: 0,
  });
  assert.equal(_internal.ParseErst('12345'), null); // too short
});

test('ErstReasons gates warnings and always reports errors', () => {
  const { _internal } = loadShared();
  const erst = { Fan: 0, Lamp: 1, Temperature: 2, Cover: 0, Filter: 0, Other: 0 };
  assert.deepEqual(_internal.ErstReasons(erst, false), ['Temperature error']);
  assert.deepEqual(_internal.ErstReasons(erst, true), ['Lamp warning', 'Temperature error']);
});

test('ParseLamps parses per-lamp hour/state pairs', () => {
  const { _internal } = loadShared();
  assert.deepEqual(_internal.ParseLamps('8262 1 13451 0'), [
    { Hours: 8262, On: true },
    { Hours: 13451, On: false },
  ]);
  assert.deepEqual(_internal.ParseLamps(''), []);
});

test('InputLabel maps a source code to a human label', () => {
  const { _internal } = loadShared();
  assert.equal(_internal.InputLabel('31'), 'Digital 1');
  assert.equal(_internal.InputLabel('11'), 'RGB 1');
});

// --- Run() against the mock projector ---------------------------------------

test('pjlink reports Online for a healthy projector', async () => {
  const pjlink = loadPjlink();
  assert.equal(pjlink.ID, 'pjlink');
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded, `unexpected degrade: ${result.DegradedReason}`);
    assert.equal(result.PowerLabel, 'On');
    assert.equal(result.Model, 'PX-1000');
    assert.equal(typeof result.LatencyMs, 'number');
  } finally {
    await server.close();
  }
});

test('pjlink authenticates with a password and reports the ERRA failure', async () => {
  const pjlink = loadPjlink();

  const good = await startPJLinkServer({
    auth: { seed: '498e4a67', password: 'secret' },
    responses: HEALTHY_RESPONSES,
  });
  try {
    const ok = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: good.port, Password: 'secret', Timeout: 2000 },
    });
    assert.equal(ok.Success, true);
  } finally {
    await good.close();
  }

  const bad = await startPJLinkServer({
    auth: { seed: '498e4a67', password: 'secret' },
    responses: HEALTHY_RESPONSES,
  });
  try {
    const fail = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: bad.port, Password: 'wrong', Timeout: 2000 },
    });
    assert.equal(fail.Success, false);
    assert.match(String(fail.Error), /password/i);
  } finally {
    await bad.close();
  }
});

test('pjlink fails clearly when a password is required but none is set', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    auth: { seed: '498e4a67', password: 'secret' },
    responses: HEALTHY_RESPONSES,
  });
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.equal(result.Success, false);
    assert.match(String(result.Error), /password/i);
  } finally {
    await server.close();
  }
});

test('pjlink degrades in standby by default but can report Online', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    responses: { ...HEALTHY_RESPONSES, POWR: '0' },
  });
  try {
    const degraded = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, CheckPower: true },
    });
    assert.equal(degraded.Success, true);
    assert.equal(degraded.Degraded, true);
    assert.match(String(degraded.DegradedReason), /standby/i);

    const online = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, CheckPower: true, ExpectedPower: 'any' },
    });
    assert.equal(online.Success, true);
    assert.ok(!online.Degraded);
  } finally {
    await server.close();
  }
});

test('pjlink degrades on an ERST error and warns only when configured', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    responses: { ...HEALTHY_RESPONSES, ERST: '200100' }, // fan error, cover warning
  });
  try {
    const dflt = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, CheckErrors: true },
    });
    assert.equal(dflt.Degraded, true);
    assert.match(String(dflt.DegradedReason), /Fan error/);
    assert.doesNotMatch(String(dflt.DegradedReason), /warning/i);

    const warn = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, CheckErrors: true, WarningsDegrade: true },
    });
    assert.match(String(warn.DegradedReason), /Cover warning/);
  } finally {
    await server.close();
  }
});

test('pjlink tolerates ERR1 for LAMP (laser models)', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    responses: { ...HEALTHY_RESPONSES, LAMP: 'ERR1' },
  });
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.ok(!result.Degraded);
  } finally {
    await server.close();
  }
});

test('pjlink warns when a lamp passes the hour threshold', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    responses: { ...HEALTHY_RESPONSES, LAMP: '5000 1' },
  });
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, CheckLamp: true, LampWarnHours: 4000 },
    });
    assert.equal(result.Degraded, true);
    assert.match(String(result.DegradedReason), /Lamp 1/);
  } finally {
    await server.close();
  }
});

test('pjlink degrades when the active input is not the expected one', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES }); // INPT=31, POWR=1
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, CheckInput: true, ExpectedInput: '32' },
    });
    assert.equal(result.Degraded, true);
    assert.match(String(result.DegradedReason), /Input/);
  } finally {
    await server.close();
  }
});

test('pjlink is Offline when the projector never answers', async () => {
  const pjlink = loadPjlink();
  const server = await startSilentServer();
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 700 },
    });
    assert.equal(result.Success, false);
  } finally {
    await server.close();
  }
});

test('the pjlink family shares one connection per projector per tick', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  try {
    // Two checks against the same projector within the cache TTL must reuse the
    // single snapshot connection, not open a second session. The snapshot cache
    // is keyed per projector, so differing toggles still share one connection.
    const [a, b] = await Promise.all([
      pjlink.Run({ Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } }),
      pjlink.Run({
        Address: '127.0.0.1',
        Settings: { Port: server.port, Timeout: 2000, CheckPower: true, CheckLamp: true },
      }),
    ]);
    assert.equal(a.Success, true);
    assert.equal(b.Success, true);
    assert.equal(server.getConnectionCount(), 1);
  } finally {
    await server.close();
  }
});

test('pjlink Debug escapes a hostile projector name', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    responses: { ...HEALTHY_RESPONSES, NAME: '<script>alert(1)</script>' },
  });
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000 },
    });
    const html = pjlink.Debug(result, {
      Address: '127.0.0.1',
      Settings: { Port: server.port },
    });
    assert.equal(typeof html, 'string');
    assert.doesNotMatch(html, /<script>alert/);
  } finally {
    await server.close();
  }
});

// --- Control actions ---------------------------------------------------------

test('BuildSetCommand frames a set with the requested class prefix', () => {
  const { _internal } = loadShared();
  assert.equal(_internal.BuildSetCommand('POWR', '1', null).toString(), '%1POWR 1\r');
  // Class 2 commands (FREZ, SVOL) carry the %2 prefix per the spec.
  assert.equal(_internal.BuildSetCommand('FREZ', '1', null, 2).toString(), '%2FREZ 1\r');
  // The auth digest is prefixed to the first command of a session, exactly as
  // it is for a query.
  assert.equal(
    _internal.BuildSetCommand('AVMT', '31', 'abc123', 1).toString(),
    'abc123%1AVMT 31\r'
  );
});

test('ParseInputList keeps the two-character codes and drops anything else', () => {
  const { _internal } = loadShared();
  assert.deepEqual(_internal.ParseInputList('11 31 32 51'), ['11', '31', '32', '51']);
  // Duplicates collapse; short/long junk is not offered as a switchable input.
  assert.deepEqual(_internal.ParseInputList('11 11 3 456 2a'), ['11', '2A']);
  assert.deepEqual(_internal.ParseInputList(''), []);
  assert.deepEqual(_internal.ParseInputList(null), []);
});

test('the status snapshot reports the projector-declared input list', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.deepEqual(result.Inputs, ['11', '31', '32', '51']);
    // Which becomes the Set Input control's choices, labelled for a human.
    assert.deepEqual(pjlink.GetActionOptions(result).Input, [
      { value: '11', label: 'RGB 1 (11)' },
      { value: '31', label: 'Digital 1 (31)' },
      { value: '32', label: 'Digital 2 (32)' },
      { value: '51', label: 'Network 1 (51)' },
    ]);
  } finally {
    await server.close();
  }
});

test('a projector that will not list its inputs offers no choices', async () => {
  const pjlink = loadPjlink();
  // INST absent from the map, so the mock answers ERR1 (unsupported).
  const responses = { ...HEALTHY_RESPONSES };
  delete responses.INST;
  const server = await startPJLinkServer({ responses });
  try {
    const result = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.equal(result.Success, true);
    assert.equal(result.Inputs, null);
    // No options means the control falls back to its free-text field rather
    // than presenting an empty dropdown.
    assert.deepEqual(pjlink.GetActionOptions(result), {});
  } finally {
    await server.close();
  }
});

test('power, shutter and mute actions send the PJLink command the spec defines', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  const Target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } };
  try {
    const cases = [
      ['power.on', 1, 'POWR', '1'],
      ['power.off', 1, 'POWR', '0'],
      ['shutter.close', 1, 'AVMT', '31'],
      ['shutter.open', 1, 'AVMT', '30'],
      ['video.mute.on', 1, 'AVMT', '11'],
      ['audio.mute.off', 1, 'AVMT', '20'],
      // Class 2 commands carry the %2 prefix.
      ['image.freeze', 2, 'FREZ', '1'],
      ['volume.down', 2, 'SVOL', '0'],
    ];
    for (const [actionID] of cases) {
      const result = await pjlink.RunAction(Target, actionID, {});
      assert.equal(result.Success, true, `${actionID} should succeed`);
    }
    assert.deepEqual(
      server.getSetCommands(),
      cases.map(([, klass, command, param]) => ({ class: klass, command, param }))
    );
  } finally {
    await server.close();
  }
});

test('input.set sends the requested code and names it back', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  try {
    const result = await pjlink.RunAction(
      { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } },
      'input.set',
      { Input: '32' }
    );
    assert.equal(result.Success, true);
    assert.equal(result.Detail, 'Input set to Digital 2');
    assert.deepEqual(server.getSetCommands(), [{ class: 1, command: 'INPT', param: '32' }]);
  } finally {
    await server.close();
  }
});

test('input.set refuses a malformed code without touching the projector', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  try {
    const Target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } };
    // 'zz' is the one that matters: it is two characters, so a length-only
    // check would have let it through to the projector as a bare ERR2.
    for (const bad of ['', '3', '311', 'hdmi', 'zz', '71']) {
      const result = await pjlink.RunAction(Target, 'input.set', { Input: bad });
      assert.equal(result.Success, false, `"${bad}" should be refused`);
      assert.match(String(result.Error), /source type/i);
    }
    // Nothing was sent: a bare ERR2 from the projector would explain nothing.
    assert.deepEqual(server.getSetCommands(), []);
  } finally {
    await server.close();
  }
});

test('an ERR token from a set command is reported in plain language', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    responses: HEALTHY_RESPONSES,
    setResponses: { POWR: 'ERR3', FREZ: 'ERR1' },
  });
  try {
    const Target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } };

    const busy = await pjlink.RunAction(Target, 'power.on', {});
    assert.equal(busy.Success, false);
    // ERR3 on a set is the one an operator hits most — warming up or cooling.
    assert.match(String(busy.Error), /ERR3/);
    assert.match(String(busy.Error), /busy/i);

    // A Class 1 projector refusing a Class 2 command IS the capability gate.
    const frozen = await pjlink.RunAction(Target, 'image.freeze', {});
    assert.equal(frozen.Success, false);
    assert.match(String(frozen.Error), /does not support/i);
  } finally {
    await server.close();
  }
});

test('an action authenticates, and reports a wrong password as such', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({
    auth: { seed: '498e4a67', password: 'secret' },
    responses: HEALTHY_RESPONSES,
  });
  try {
    const ok = await pjlink.RunAction(
      { Address: '127.0.0.1', Settings: { Port: server.port, Password: 'secret', Timeout: 2000 } },
      'power.on',
      {}
    );
    assert.equal(ok.Success, true);
    assert.deepEqual(server.getSetCommands(), [{ class: 1, command: 'POWR', param: '1' }]);

    const bad = await pjlink.RunAction(
      { Address: '127.0.0.1', Settings: { Port: server.port, Password: 'wrong', Timeout: 2000 } },
      'power.on',
      {}
    );
    assert.equal(bad.Success, false);
    assert.match(String(bad.Error), /password/i);
  } finally {
    await server.close();
  }
});

test('an action against an unconfigured or unreachable target fails cleanly', async () => {
  const pjlink = loadPjlink();
  const noAddress = await pjlink.RunAction({ Address: '', Settings: {} }, 'power.on', {});
  assert.equal(noAddress.Success, false);
  assert.match(String(noAddress.Error), /address/i);

  const badPort = await pjlink.RunAction(
    { Address: '127.0.0.1', Settings: { Port: 0 } },
    'power.on',
    {}
  );
  assert.equal(badPort.Success, false);
  assert.match(String(badPort.Error), /port/i);

  const unknown = await pjlink.RunAction(
    { Address: '127.0.0.1', Settings: { Port: 4352 } },
    'not-a-real-action',
    {}
  );
  assert.equal(unknown.Success, false);
  assert.match(String(unknown.Error), /Unknown PJLink action/);
});

test('a projector that is not there reports the connection failure, not a hang', async () => {
  const pjlink = loadPjlink();
  const silent = await startSilentServer();
  try {
    const result = await pjlink.RunAction(
      { Address: '127.0.0.1', Settings: { Port: silent.port, Timeout: 700 } },
      'power.on',
      {}
    );
    assert.equal(result.Success, false);
    assert.ok(String(result.Error).length > 0);
  } finally {
    await silent.close();
  }
});

test('DescribeAction binds the chosen input into a favourite label', () => {
  const pjlink = loadPjlink();
  assert.equal(pjlink.DescribeAction('input.set', { Input: '31' }), 'Set Input — Digital 1 (31)');
  // Everything else has no parameters, so its plain label already says it all.
  assert.equal(pjlink.DescribeAction('power.on', {}), null);
  assert.equal(pjlink.DescribeAction('input.set', {}), null);
});

test('an action invalidates the snapshot the next probe would otherwise replay', async () => {
  const pjlink = loadPjlink();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  const Target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 2000 } };
  try {
    await pjlink.Run(Target);
    const before = server.getConnectionCount();
    // Within the cache TTL, a second probe reuses the snapshot...
    await pjlink.Run(Target);
    assert.equal(server.getConnectionCount(), before, 'the cached snapshot should be reused');
    // ...but once the device's state has been changed, it must not be.
    pjlink.InvalidateCaches(Target);
    await pjlink.Run(Target);
    assert.equal(server.getConnectionCount(), before + 1, 'the probe must re-read the projector');
  } finally {
    await server.close();
  }
});

test('concurrent PJLink work against one projector is serialized to one session', async () => {
  const pjlink = loadPjlink();
  const shared = loadShared();
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  const Target = { Address: '127.0.0.1', Settings: { Port: server.port, Timeout: 3000 } };
  try {
    // Many projectors accept a single session at a time, so a probe and three
    // actions fired together must queue rather than race four sockets at it.
    const results = await Promise.all([
      shared.QueryProjectorStatus('127.0.0.1', server.port, '', 3000),
      pjlink.RunAction(Target, 'power.on', {}),
      pjlink.RunAction(Target, 'shutter.close', {}),
      pjlink.RunAction(Target, 'shutter.open', {}),
    ]);
    assert.equal(results[0].Reachable, true);
    for (const result of results.slice(1)) assert.equal(result.Success, true);
    // Ordering is the point: the lock preserves the order they were queued in.
    assert.deepEqual(server.getSetCommands(), [
      { class: 1, command: 'POWR', param: '1' },
      { class: 1, command: 'AVMT', param: '31' },
      { class: 1, command: 'AVMT', param: '30' },
    ]);
  } finally {
    await server.close();
  }
});
