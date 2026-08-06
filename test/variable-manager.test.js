const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// VariableManager: show variables that reach a client's scripts as environment
// variables (GAME_VERSION arrives as %SHOWTRAK_VAR_GAME_VERSION%).
//
// Loaded against an in-memory repository so the manager's real logic runs —
// key normalization, default-vs-override resolution, environment building and
// cache invalidation — without a database.
//
// The properties pinned here are the ones whose failure is silent in a show:
//
//   1. KEY NORMALIZATION. The Windows environment is case-insensitive, so only
//      one spelling of a name may ever exist.
//   2. null IS NOT ''. An override of null inherits the default forever; an
//      override of '' pins the client to empty. Collapsing them makes clearing
//      a field quietly stop tracking the default.
//   3. EVERY VARIABLE IS ALWAYS EMITTED. An omitted one leaves the literal text
//      %SHOWTRAK_VAR_X% in a batch file.
//   4. THE CACHE IS DROPPED ON EVERY WRITE. A stale environment means a script
//      runs with the value the operator just changed away from.

const noopLogger = {
  CreateLogger: () => ({
    error: () => {},
    warn: () => {},
    log: () => {},
    debug: () => {},
    success: () => {},
  }),
};

function load() {
  // Mirrors the real tables: definitions, plus per-(UUID, VariableID) overrides.
  const variables = new Map(); // VariableID -> row
  const overrides = new Map(); // `${UUID}:${VariableID}` -> value
  const broadcasts = [];
  let nextID = 1;

  const repo = {
    GetAll: async () => [
      null,
      [...variables.values()].sort((a, b) => a.Weight - b.Weight || a.VariableID - b.VariableID),
    ],
    GetByID: async (id) => [null, variables.get(id) || null],
    GetByKey: async (key) => [
      null,
      [...variables.values()].find((v) => v.Key.toLowerCase() === String(key).toLowerCase()) ||
        null,
    ],
    Insert: async (Key, Description, DefaultValue, ExportToSystem, Weight, Timestamp) => {
      const VariableID = nextID++;
      variables.set(VariableID, {
        VariableID,
        Key,
        Description,
        DefaultValue,
        ExportToSystem,
        Weight,
        Timestamp,
      });
      return [null, {}];
    },
    UpdateKey: async (id, Key) => {
      variables.get(id).Key = Key;
      return [null, {}];
    },
    UpdateDescription: async (id, Description) => {
      variables.get(id).Description = Description;
      return [null, {}];
    },
    UpdateDefault: async (id, DefaultValue) => {
      variables.get(id).DefaultValue = DefaultValue;
      return [null, {}];
    },
    UpdateExport: async (id, ExportToSystem) => {
      variables.get(id).ExportToSystem = ExportToSystem;
      return [null, {}];
    },
    Delete: async (id) => {
      variables.delete(id);
      for (const key of [...overrides.keys()]) {
        if (key.endsWith(`:${id}`)) overrides.delete(key);
      }
      return [null, undefined];
    },
    GetForClient: async (UUID) => [
      null,
      [...variables.values()]
        .sort((a, b) => a.Weight - b.Weight || a.VariableID - b.VariableID)
        .map((v) => ({
          ...v,
          Value: overrides.has(`${UUID}:${v.VariableID}`)
            ? overrides.get(`${UUID}:${v.VariableID}`)
            : null,
        })),
    ],
    CountOverrides: async () => {
      const counts = new Map();
      for (const key of overrides.keys()) {
        const id = Number(key.split(':')[1]);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      return [
        null,
        [...counts.entries()].map(([VariableID, Overrides]) => ({ VariableID, Overrides })),
      ];
    },
    SetClientValue: async (UUID, VariableID, Value) => {
      overrides.set(`${UUID}:${VariableID}`, Value);
      return [null, {}];
    },
    ClearClientValue: async (UUID, VariableID) => {
      overrides.delete(`${UUID}:${VariableID}`);
      return [null, {}];
    },
    DeleteOrphaned: async () => [null, {}],
  };

  const mod = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'VariableManager', 'index.js'),
    {
      '../Logger': noopLogger,
      '../DB': { Manager: {} },
      '../DB/repositories/variables': { CreateVariablesRepository: () => repo },
      '../Broadcast': { Manager: { emit: (...args) => broadcasts.push(args) } },
    }
  );
  return { Manager: mod.Manager, NormalizeKey: mod.NormalizeKey, variables, overrides, broadcasts };
}

test('keys are normalized to upper snake case', () => {
  const { NormalizeKey } = load();
  assert.equal(NormalizeKey('game version'), 'GAME_VERSION');
  assert.equal(NormalizeKey('Game-Version'), 'GAME_VERSION');
  assert.equal(NormalizeKey('  game.version  '), 'GAME_VERSION');
  assert.equal(NormalizeKey('game__version'), 'GAME_VERSION');
  assert.equal(NormalizeKey('_GAME_VERSION_'), 'GAME_VERSION');
  // Anything outside [A-Z0-9_] is dropped rather than rejected: operators paste
  // names with punctuation and expect the obvious result.
  assert.equal(NormalizeKey('game(version)!'), 'GAMEVERSION');
});

test('a leading digit is prefixed, because %1ABC% is a batch parameter', () => {
  const { NormalizeKey } = load();
  assert.equal(NormalizeKey('1st_show'), '_1ST_SHOW');
});

test('a key with nothing usable is rejected rather than silently becoming "_"', () => {
  const { NormalizeKey } = load();
  assert.equal(NormalizeKey('!!!'), null);
  assert.equal(NormalizeKey('   '), null);
  assert.equal(NormalizeKey(''), null);
  assert.equal(NormalizeKey(null), null);
});

test('the reserved SHOWTRAK_ namespace is refused with a useful message', async () => {
  const { Manager } = load();
  const [created] = await Manager.Create('GAME_VERSION');
  assert.equal(created, null);

  // Pasting the fully-qualified name out of a script is the common mistake;
  // accepting it would produce %SHOWTRAK_VAR_SHOWTRAK_VAR_GAME_VERSION%.
  const [prefixErr] = await Manager.SetKey(1, 'SHOWTRAK_VAR_GAME_VERSION');
  assert.match(String(prefixErr), /without the SHOWTRAK_VAR_ prefix/);

  const [reservedErr] = await Manager.SetKey(1, 'SHOWTRAK_CLIENT_UUID');
  assert.match(String(reservedErr), /reserved/);
});

test('a duplicate name is refused case-insensitively', async () => {
  const { Manager } = load();
  await Manager.Create('GAME_VERSION');
  const [, second] = await Manager.Create('ROOM');

  // Windows would treat these as one variable, so two rows must never exist.
  const [Err] = await Manager.SetKey(second.VariableID, 'game_version');
  assert.match(String(Err), /already exists/);
});

test('creating with a colliding name de-collides instead of failing', async () => {
  const { Manager } = load();
  const [, first] = await Manager.Create('ROOM');
  const [, second] = await Manager.Create('ROOM');
  // Creation is a button press with no name typed yet — the operator renames it.
  assert.equal(first.Key, 'ROOM');
  assert.equal(second.Key, 'ROOM_2');
});

test('renaming keeps every client value, because overrides key on VariableID', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetClientValues('client-1', { [created.VariableID]: 'TEST_GAME' });

  await Manager.SetKey(created.VariableID, 'BUILD_NAME');

  const Environment = (await Manager.GetPayload('client-1')).Environment;
  assert.deepEqual(Environment, { SHOWTRAK_VAR_BUILD_NAME: 'TEST_GAME' });
});

test('a client with no override resolves to the default', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetDefault(created.VariableID, 'RETAIL');

  const { Environment } = await Manager.GetPayload('client-1');
  assert.deepEqual(Environment, { SHOWTRAK_VAR_GAME_VERSION: 'RETAIL' });
});

test('an override beats the default, and clearing it goes back to inheriting', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetDefault(created.VariableID, 'RETAIL');

  await Manager.SetClientValues('client-1', { [created.VariableID]: 'TEST_GAME' });
  assert.equal(
    (await Manager.GetPayload('client-1')).Environment.SHOWTRAK_VAR_GAME_VERSION,
    'TEST_GAME'
  );

  // null means "inherit again" — and must keep tracking later default changes.
  await Manager.SetClientValues('client-1', { [created.VariableID]: null });
  assert.equal(
    (await Manager.GetPayload('client-1')).Environment.SHOWTRAK_VAR_GAME_VERSION,
    'RETAIL'
  );
  await Manager.SetDefault(created.VariableID, 'BETA');
  assert.equal(
    (await Manager.GetPayload('client-1')).Environment.SHOWTRAK_VAR_GAME_VERSION,
    'BETA'
  );
});

test('an empty-string override pins the client, unlike null', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetDefault(created.VariableID, 'RETAIL');

  await Manager.SetClientValues('client-1', { [created.VariableID]: '' });
  // Deliberately empty is a real choice and must not fall back to the default.
  assert.equal((await Manager.GetPayload('client-1')).Environment.SHOWTRAK_VAR_GAME_VERSION, '');
});

test('a variable with no value anywhere is still emitted', async () => {
  const { Manager } = load();
  await Manager.Create('GAME_VERSION');

  // Omitting it would leave the literal text %SHOWTRAK_VAR_GAME_VERSION% in a
  // batch file — the single most confusing failure this feature has.
  const { Environment } = await Manager.GetPayload('client-1');
  assert.equal(Object.hasOwn(Environment, 'SHOWTRAK_VAR_GAME_VERSION'), true);
  assert.equal(Environment.SHOWTRAK_VAR_GAME_VERSION, '');
});

test('only variables marked for export are listed as exported', async () => {
  const { Manager } = load();
  const [, exported] = await Manager.Create('EXPORTED');
  const [, internal] = await Manager.Create('INTERNAL');
  await Manager.SetExport(internal.VariableID, false);

  const Payload = await Manager.GetPayload('client-1');
  assert.deepEqual(Payload.Exported, ['SHOWTRAK_VAR_EXPORTED']);
  // Both still reach the client's scripts; only the registry mirror differs.
  assert.equal(Object.keys(Payload.Environment).length, 2);
  assert.equal(exported.ExportToSystem, true);
});

test('control characters are stripped from values', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('MESSY');
  await Manager.SetDefault(created.VariableID, 'a b\nc\r\td');

  assert.equal((await Manager.GetPayload('c1')).Environment.SHOWTRAK_VAR_MESSY, 'abcd');
});

test('an over-long value is truncated rather than rejected', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('BIG');
  await Manager.SetDefault(created.VariableID, 'x'.repeat(10000));

  const Value = (await Manager.GetPayload('c1')).Environment.SHOWTRAK_VAR_BIG;
  // Comfortably under the Windows per-variable ceiling, so a paste accident
  // cannot make a client's whole environment fail to build.
  assert.equal(Value.length, 4096);
});

test('changing a default invalidates the resolved cache', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetDefault(created.VariableID, 'FIRST');

  // Prime the cache, then move the value out from under it.
  assert.equal((await Manager.GetPayload('c1')).Environment.SHOWTRAK_VAR_GAME_VERSION, 'FIRST');
  await Manager.SetDefault(created.VariableID, 'SECOND');
  assert.equal((await Manager.GetPayload('c1')).Environment.SHOWTRAK_VAR_GAME_VERSION, 'SECOND');
});

test('setting a client value invalidates only what it should', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetDefault(created.VariableID, 'RETAIL');

  assert.equal((await Manager.GetPayload('c1')).Environment.SHOWTRAK_VAR_GAME_VERSION, 'RETAIL');
  assert.equal((await Manager.GetPayload('c2')).Environment.SHOWTRAK_VAR_GAME_VERSION, 'RETAIL');

  await Manager.SetClientValues('c1', { [created.VariableID]: 'TEST_GAME' });
  assert.equal((await Manager.GetPayload('c1')).Environment.SHOWTRAK_VAR_GAME_VERSION, 'TEST_GAME');
  assert.equal((await Manager.GetPayload('c2')).Environment.SHOWTRAK_VAR_GAME_VERSION, 'RETAIL');
});

test('a definition change fans out to every client, an override change to one', async () => {
  const { Manager, broadcasts } = load();
  const [, created] = await Manager.Create('GAME_VERSION');

  broadcasts.length = 0;
  await Manager.SetDefault(created.VariableID, 'RETAIL');
  // null UUID means "re-push to everyone": a default moves every client that
  // has not overridden it.
  assert.deepEqual(
    broadcasts.filter(([e]) => e === 'ClientVariablesChanged'),
    [['ClientVariablesChanged', null]]
  );

  broadcasts.length = 0;
  await Manager.SetClientValues('client-1', { [created.VariableID]: 'TEST_GAME' });
  assert.deepEqual(
    broadcasts.filter(([e]) => e === 'ClientVariablesChanged'),
    [['ClientVariablesChanged', 'client-1']]
  );
});

test('deleting a variable notifies clients so exported values are cleaned up', async () => {
  const { Manager, broadcasts, overrides } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetClientValues('client-1', { [created.VariableID]: 'TEST_GAME' });

  broadcasts.length = 0;
  await Manager.Delete(created.VariableID);

  // Without this push, a client that had exported the value would keep it in its
  // Windows registry for the life of the machine.
  assert.deepEqual(
    broadcasts.filter(([e]) => e === 'ClientVariablesChanged'),
    [['ClientVariablesChanged', null]]
  );
  // The override goes with the definition.
  assert.equal(overrides.size, 0);
  assert.deepEqual((await Manager.GetPayload('client-1')).Environment, {});
});

test('turning export off is pushed, not just turning it on', async () => {
  const { Manager, broadcasts } = load();
  const [, created] = await Manager.Create('GAME_VERSION');

  broadcasts.length = 0;
  await Manager.SetExport(created.VariableID, false);
  // The client has to hear about it to REMOVE the value it already wrote.
  assert.deepEqual(
    broadcasts.filter(([e]) => e === 'ClientVariablesChanged'),
    [['ClientVariablesChanged', null]]
  );
});

test('an unknown VariableID in a save is skipped, not fatal', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');

  // A client editor left open while a variable was deleted elsewhere must still
  // save the rows that do still exist.
  const [Err] = await Manager.SetClientValues('client-1', {
    [created.VariableID]: 'TEST_GAME',
    9999: 'ghost',
  });
  assert.equal(Err, null);
  assert.deepEqual((await Manager.GetPayload('client-1')).Environment, {
    SHOWTRAK_VAR_GAME_VERSION: 'TEST_GAME',
  });
});

test('the client editor view distinguishes inherited from overridden', async () => {
  const { Manager } = load();
  const [, inherited] = await Manager.Create('INHERITED');
  const [, overridden] = await Manager.Create('OVERRIDDEN');
  await Manager.SetDefault(inherited.VariableID, 'DEFAULT_A');
  await Manager.SetDefault(overridden.VariableID, 'DEFAULT_B');
  await Manager.SetClientValues('client-1', { [overridden.VariableID]: 'MINE' });

  const Views = await Manager.GetClientViews('client-1');
  const A = Views.find((V) => V.Key === 'INHERITED');
  const B = Views.find((V) => V.Key === 'OVERRIDDEN');

  // Value === null is what the editor renders as an empty box with the default
  // as its placeholder; ResolvedValue is what the script will actually see.
  assert.equal(A.Value, null);
  assert.equal(A.ResolvedValue, 'DEFAULT_A');
  assert.equal(A.EnvironmentKey, 'SHOWTRAK_VAR_INHERITED');
  assert.equal(B.Value, 'MINE');
  assert.equal(B.ResolvedValue, 'MINE');
});

test('the manager list reports how many clients override each variable', async () => {
  const { Manager } = load();
  const [, created] = await Manager.Create('GAME_VERSION');
  await Manager.SetClientValues('c1', { [created.VariableID]: 'A' });
  await Manager.SetClientValues('c2', { [created.VariableID]: 'B' });

  const Views = await Manager.GetAllViews();
  assert.equal(Views[0].OverrideCount, 2);
});
