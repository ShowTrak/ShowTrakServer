const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  FOG_TASK_TYPES,
  GetFogTaskType,
  FogTaskPermissionKey,
  GetFogTaskStateName,
} = require('../dist/Modules/Config/fog');
const {
  CheckHealth,
  FogRequest,
  ParseJson,
  ToNumber,
  ConfigIsComplete,
  DescribeConfigGaps,
} = require('../dist/Modules/FogManager/client');
const { Manager: IPCValidation } = require('../dist/Modules/IPCValidation');
const { CreateFogRepository } = require('../dist/Modules/DB/repositories/fog');

// Covers the FOG Project integration's transport and catalogue.
//
// The catalogue assertions are deliberately specific: FOG's published docs
// contradict its own schema on several of these points, so these tests pin the
// schema-verified answers and will fail loudly if someone "corrects" them to match
// the docs.

// ---- Task type catalogue ---------------------------------------------------

test('task type catalogue matches the FOG schema, not the docs', () => {
  // FOG's news post claims 12 = Single Snapin and 13 = All Snapins. The schema
  // (and the news post's own curl example) say the opposite.
  assert.equal(GetFogTaskType(12).Name, 'All Snapins');
  assert.equal(GetFogTaskType(13).Name, 'Single Snapin');
  assert.equal(GetFogTaskType(13).RequiresSnapinID, true);

  // There is genuinely no task type 9.
  assert.equal(GetFogTaskType(9), null);

  // Type 8 (Multi-Cast) is group-only in the schema. The API does not enforce
  // that, so it must not be offered for host scheduling.
  assert.equal(GetFogTaskType(8), null);

  assert.equal(GetFogTaskType(9999), null);
});

test('every task type has a permission key and destructive types are flagged', () => {
  for (const Type of FOG_TASK_TYPES) {
    assert.equal(FogTaskPermissionKey(Type.TaskTypeID), `FOG_ALLOW_TASK_${Type.TaskTypeID}`);
    assert.equal(typeof Type.Destructive, 'boolean');
  }

  // Anything that images or erases a disk must be marked destructive so the UI
  // warns before scheduling it.
  for (const ID of [1, 2, 18, 19, 20, 11]) {
    assert.equal(GetFogTaskType(ID).Destructive, true, `task type ${ID} should be destructive`);
  }
  for (const ID of [14, 10, 4]) {
    assert.equal(
      GetFogTaskType(ID).Destructive,
      false,
      `task type ${ID} should not be destructive`
    );
  }
});

test('every permitted task type appears as a setting default', () => {
  const { DefaultSettings } = require('../dist/Modules/SettingsManager/DefaultSettings');
  for (const Type of FOG_TASK_TYPES) {
    const Key = FogTaskPermissionKey(Type.TaskTypeID);
    const Setting = DefaultSettings.find((S) => S.Key === Key);
    assert.ok(Setting, `missing setting for ${Key}`);
    // Enabling the integration must not, on its own, permit anything.
    assert.equal(Setting.DefaultValue, false, `${Key} must default to off`);
    assert.equal(Setting.Group, 'FOG Permitted Actions');
  }
});

test('task state names cover the FOG state table', () => {
  assert.equal(GetFogTaskStateName(1), 'Queued');
  assert.equal(GetFogTaskStateName(3), 'In Progress');
  assert.equal(GetFogTaskStateName(4), 'Complete');
  assert.equal(GetFogTaskStateName(5), 'Cancelled');
  assert.match(GetFogTaskStateName(99), /Unknown/);
});

// ---- Config gating ---------------------------------------------------------

test('config completeness requires an address and both tokens', () => {
  const Base = { Protocol: 'http', Host: 'fog.local', Port: 0, ApiToken: 'a', UserToken: 'u' };
  assert.equal(ConfigIsComplete(Base), true);
  assert.equal(DescribeConfigGaps(Base), null);

  assert.equal(ConfigIsComplete({ ...Base, Host: '' }), false);
  assert.match(DescribeConfigGaps({ ...Base, Host: '' }), /address/i);
  assert.match(DescribeConfigGaps({ ...Base, ApiToken: '' }), /API token/i);
  assert.match(DescribeConfigGaps({ ...Base, UserToken: '' }), /user token/i);
});

test('CheckHealth refuses to probe an incomplete config', async () => {
  const Problem = await CheckHealth({
    Protocol: 'http',
    Host: '',
    Port: 0,
    ApiToken: '',
    UserToken: '',
  });
  assert.match(Problem, /address/i);
});

// ---- Transport against a stub FOG server -----------------------------------

// Spin up a throwaway HTTP server that impersonates the handful of FOG responses
// the integration depends on, so the transport's interpretation of them is tested
// rather than assumed.
function startStubFog(handler) {
  return new Promise((resolve) => {
    const Server = http.createServer(handler);
    Server.listen(0, '127.0.0.1', () => {
      const { port } = Server.address();
      resolve({
        Server,
        Config: {
          Protocol: 'http',
          Host: '127.0.0.1',
          Port: port,
          ApiToken: 'api-token-value',
          UserToken: 'user-token-value',
        },
        close: () => new Promise((done) => Server.close(done)),
      });
    });
  });
}

test('health check accepts the bare "success" body FOG actually returns', async () => {
  const Received = [];
  const Stub = await startStubFog((Req, Res) => {
    Received.push({ url: Req.url, headers: Req.headers });
    // FOG sends a JSON content-type even though the body is plain text.
    Res.writeHead(200, { 'Content-Type': 'application/json' });
    Res.end('success\n');
  });

  try {
    assert.equal(await CheckHealth(Stub.Config), null);

    // Path is prefixed with /fog, and both tokens ride as lowercase-hyphen headers.
    assert.equal(Received[0].url, '/fog/system/info');
    assert.equal(Received[0].headers['fog-api-token'], 'api-token-value');
    assert.equal(Received[0].headers['fog-user-token'], 'user-token-value');
  } finally {
    await Stub.close();
  }
});

test('API token is sent verbatim, never re-encoded', async () => {
  // FOG base64-decodes the header before comparing it to the stored token, and the
  // web UI already shows it encoded. Encoding it again here would cause a 403.
  const Token = 'c2hvd3RyYWstdG9rZW4=';
  let Seen = null;
  const Stub = await startStubFog((Req, Res) => {
    Seen = Req.headers['fog-api-token'];
    Res.writeHead(200);
    Res.end('success');
  });

  try {
    await CheckHealth({ ...Stub.Config, ApiToken: Token });
    assert.equal(Seen, Token);
  } finally {
    await Stub.close();
  }
});

test('a 302 to the login page is reported as the API being disabled', async () => {
  // This is the trap: FOG answers every route with a redirect when the API is off.
  // Following it would yield a 200 full of HTML and a false healthy.
  const Stub = await startStubFog((Req, Res) => {
    Res.writeHead(302, { Location: '/fog/management/index.php' });
    Res.end();
  });

  try {
    const Problem = await CheckHealth(Stub.Config);
    assert.match(Problem, /API is not enabled/i);
  } finally {
    await Stub.close();
  }
});

test('403 and 401 name the token at fault', async () => {
  const Stub403 = await startStubFog((Req, Res) => {
    Res.writeHead(403);
    Res.end();
  });
  try {
    assert.match(await CheckHealth(Stub403.Config), /API token/i);
  } finally {
    await Stub403.close();
  }

  const Stub401 = await startStubFog((Req, Res) => {
    Res.writeHead(401);
    Res.end();
  });
  try {
    assert.match(await CheckHealth(Stub401.Config), /user token/i);
  } finally {
    await Stub401.close();
  }
});

test('a 200 that is not the API reply is rejected', async () => {
  // e.g. a reverse proxy or captive portal answering instead of FOG.
  const Stub = await startStubFog((Req, Res) => {
    Res.writeHead(200, { 'Content-Type': 'text/html' });
    Res.end('<html><body>Login</body></html>');
  });

  try {
    assert.match(await CheckHealth(Stub.Config), /not with the expected API reply/i);
  } finally {
    await Stub.close();
  }
});

test('an unreachable server surfaces the connection error rather than throwing', async () => {
  const Problem = await CheckHealth({
    Protocol: 'http',
    // Port 1 on loopback refuses immediately, so this stays fast.
    Host: '127.0.0.1',
    Port: 1,
    ApiToken: 'a',
    UserToken: 'u',
  });
  assert.ok(Problem, 'expected an error message');
  assert.equal(typeof Problem, 'string');
});

test('task creation succeeds on a 200 whose body is the literal string null', async () => {
  // FOG returns `null` and no task ID; success must be read from the status code.
  let SeenBody = '';
  const Stub = await startStubFog((Req, Res) => {
    const Chunks = [];
    Req.on('data', (C) => Chunks.push(C));
    Req.on('end', () => {
      SeenBody = Buffer.concat(Chunks).toString('utf8');
      Res.writeHead(200, { 'Content-Type': 'application/json' });
      Res.end('null');
    });
  });

  try {
    const Response = await FogRequest(Stub.Config, '/host/7/task', 'POST', { taskTypeID: 1 });
    assert.equal(Response.Success, true);
    assert.equal(Response.BodyText, 'null');
    assert.equal(ParseJson(Response), null);
    // The body key is taskTypeID; the docs' "taskType" is wrong.
    assert.deepEqual(JSON.parse(SeenBody), { taskTypeID: 1 });
  } finally {
    await Stub.close();
  }
});

test("a 500 surfaces FOG's own error message", async () => {
  const Stub = await startStubFog((Req, Res) => {
    Res.writeHead(500, { 'Content-Type': 'application/json' });
    Res.end(JSON.stringify({ error: 'No image assigned to this host' }));
  });

  try {
    const Response = await FogRequest(Stub.Config, '/host/7/task', 'POST', { taskTypeID: 1 });
    assert.equal(Response.Success, false);
    assert.match(Response.Error, /No image assigned to this host/);
  } finally {
    await Stub.close();
  }
});

test('an invalid task type is reported as such (FOG answers 501)', async () => {
  const Stub = await startStubFog((Req, Res) => {
    Res.writeHead(501, { 'Content-Type': 'application/json' });
    Res.end(JSON.stringify({ error: 'Invalid tasking type passed' }));
  });

  try {
    const Response = await FogRequest(Stub.Config, '/host/7/task', 'POST', { taskTypeID: 999 });
    assert.equal(Response.Success, false);
    assert.match(Response.Error, /task type/i);
  } finally {
    await Stub.close();
  }
});

test('FOG string scalars are coerced at the boundary', () => {
  // FOG serialises every scalar as a string, IDs included.
  assert.equal(ToNumber('42'), 42);
  assert.equal(ToNumber('not a number'), 0);
  assert.equal(ToNumber(undefined, -1), -1);
  assert.equal(ToNumber('0'), 0);
});

// ---- IPC validators --------------------------------------------------------

test('FogHostIDOrNull treats empty values as an unlink rather than an error', () => {
  assert.equal(IPCValidation.FogHostIDOrNull(null), null);
  assert.equal(IPCValidation.FogHostIDOrNull(''), null);
  assert.equal(IPCValidation.FogHostIDOrNull(0), null);
  assert.equal(IPCValidation.FogHostIDOrNull('0'), null);
  assert.equal(IPCValidation.FogHostIDOrNull('12'), 12);
  assert.equal(IPCValidation.FogHostIDOrNull(12), 12);
  assert.throws(() => IPCValidation.FogHostIDOrNull('abc'), /numeric/i);
});

test('FogTaskTypeID and FogSnapinID reject non-positive and malformed values', () => {
  assert.equal(IPCValidation.FogTaskTypeID('13'), 13);
  assert.throws(() => IPCValidation.FogTaskTypeID(0), /positive integer/i);
  assert.throws(() => IPCValidation.FogTaskTypeID(-1), /positive integer/i);
  assert.throws(() => IPCValidation.FogTaskTypeID(1.5), /positive integer/i);
  assert.throws(() => IPCValidation.FogTaskTypeID({}), /invalid/i);

  assert.equal(IPCValidation.FogSnapinID(null), null);
  assert.equal(IPCValidation.FogSnapinID('6'), 6);
  assert.throws(() => IPCValidation.FogSnapinID('0'), /positive integer/i);
});

// ---- Task history pruning --------------------------------------------------

// The Clear button in the tasks tray routes here. Deleting a row for a task that
// is still running in FOG would orphan it — the poller would have nothing left to
// reconcile against, so the task would vanish from the panel while continuing to
// image the machine. Both the age-based pruner and the operator-triggered clear
// must therefore filter on state, not just on age.
test('clearing finished tasks leaves open tasks in place', async () => {
  const runs = [];
  const Repo = CreateFogRepository({
    Run: async (sql, params) => {
      runs.push([sql, params]);
      return [null, { changes: 0 }];
    },
  });

  await Repo.DeleteFinishedTasks();
  assert.equal(runs.length, 1);

  const [sql, params] = runs[0];
  assert.equal(params, undefined, 'the clear takes no parameters');
  // States 0-3 are the non-terminal ones (see FOG_TASK_STATES); every one of them
  // must be excluded from the delete.
  assert.match(sql, /^DELETE FROM FogTasks WHERE StateID NOT IN \(0, 1, 2, 3\)$/);
  assert.doesNotMatch(sql, /UpdatedAt/, 'the operator clear ignores the retention age');
});

test('age-based pruning also spares open tasks', async () => {
  const runs = [];
  const Repo = CreateFogRepository({
    Run: async (sql, params) => {
      runs.push([sql, params]);
      return [null, { changes: 0 }];
    },
  });

  await Repo.PruneFinishedTasksBefore(1000);
  const [sql, params] = runs[0];
  assert.match(sql, /StateID NOT IN \(0, 1, 2, 3\)/);
  assert.match(sql, /UpdatedAt < \?/);
  assert.deepEqual(params, [1000]);
});
