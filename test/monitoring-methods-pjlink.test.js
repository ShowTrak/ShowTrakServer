const test = require('node:test');
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
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.equal(degraded.Success, true);
    assert.equal(degraded.Degraded, true);
    assert.match(String(degraded.DegradedReason), /standby/i);

    const online = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, TreatStandbyAs: 'ok' },
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
      Settings: { Port: server.port, Timeout: 2000 },
    });
    assert.equal(dflt.Degraded, true);
    assert.match(String(dflt.DegradedReason), /Fan error/);
    assert.doesNotMatch(String(dflt.DegradedReason), /warning/i);

    const warn = await pjlink.Run({
      Address: '127.0.0.1',
      Settings: { Port: server.port, Timeout: 2000, WarningsDegrade: true },
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
      Settings: { Port: server.port, Timeout: 2000, LampWarnHours: 4000 },
    });
    assert.equal(result.Degraded, true);
    assert.match(String(result.DegradedReason), /Lamp 1/);
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
  const pjlinkPower = require(methodPath('pjlink-power.js'));
  const server = await startPJLinkServer({ responses: HEALTHY_RESPONSES });
  try {
    const settings = { Port: server.port, Timeout: 2000 };
    // Two different checks against the same projector within the cache TTL must
    // reuse the single snapshot connection, not open a second session.
    const [a, b] = await Promise.all([
      pjlink.Run({ Address: '127.0.0.1', Settings: settings }),
      pjlinkPower.Run({ Address: '127.0.0.1', Settings: settings }),
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
