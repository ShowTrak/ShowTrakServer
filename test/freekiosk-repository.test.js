// The FreeKioskTerminals repository.
//
// It is a thin SQL layer, so what is worth pinning is the shape of the
// statements it emits and the two deliberate departures from "just write it":
// the API key is updated on its own statement, and a poll timestamp is written
// without dirty tracking.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CreateFreeKioskTerminalsRepository,
} = require('../dist/Modules/DB/repositories/freekiosk-terminals');

function createDb() {
  const runs = [];
  const quiet = [];
  return {
    runs,
    quiet,
    Repo: CreateFreeKioskTerminalsRepository({
      All: async (sql) => {
        runs.push([sql, undefined]);
        return [null, []];
      },
      Run: async (sql, params) => {
        runs.push([sql, params]);
        return [null, { changes: 1 }];
      },
      RunWithoutDirtyTracking: async (sql, params) => {
        quiet.push([sql, params]);
        return [null, { changes: 1 }];
      },
    }),
  };
}

test('reads every terminal in one statement', async () => {
  const { Repo, runs } = createDb();
  const [err, rows] = await Repo.GetAll();
  assert.equal(err, null);
  assert.deepEqual(rows, []);
  assert.equal(runs[0][0], 'SELECT * FROM FreeKioskTerminals');
});

test('insert binds every column in declaration order', async () => {
  const { Repo, runs } = createDb();
  const [err] = await Repo.Insert(
    'uuid-1',
    'Lobby Kiosk',
    '192.168.1.50',
    8080,
    'secret',
    30000,
    5000,
    '{"A_battery_level_On":true}',
    3,
    100,
    'lobby-kiosk',
    1700000000000
  );
  assert.equal(err, null);
  const [sql, params] = runs[0];
  assert.equal(
    sql,
    'INSERT INTO FreeKioskTerminals (UUID, Nickname, Address, Port, ApiKey, Interval, TimeoutMs, Settings, GroupID, Weight, Slug, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  assert.deepEqual(params, [
    'uuid-1',
    'Lobby Kiosk',
    '192.168.1.50',
    8080,
    'secret',
    30000,
    5000,
    '{"A_battery_level_On":true}',
    3,
    100,
    'lobby-kiosk',
    1700000000000,
  ]);
  // The placeholder count must match the bound parameters or sqlite throws at
  // runtime rather than at build time.
  assert.equal((sql.match(/\?/g) || []).length, params.length);
});

test('a details update never touches the API key', async () => {
  // The editor is never given the stored key back, so it cannot resubmit it. If
  // this statement carried ApiKey, every edit would silently clear it.
  const { Repo, runs } = createDb();
  await Repo.UpdateDetails('Lobby', '10.0.0.5', 8081, 60000, 4000, '{}', null, 'uuid-1');
  const [sql, params] = runs[0];
  assert.ok(!/ApiKey/.test(sql), 'UpdateDetails must not write ApiKey');
  assert.equal(params[params.length - 1], 'uuid-1');
  assert.equal((sql.match(/\?/g) || []).length, params.length);
});

test('the API key has its own statement so it can be set or cleared deliberately', async () => {
  const { Repo, runs } = createDb();
  await Repo.UpdateApiKey('new-key', 'uuid-1');
  await Repo.UpdateApiKey(null, 'uuid-1');
  assert.deepEqual(runs[0], [
    'UPDATE FreeKioskTerminals SET ApiKey = ? WHERE UUID = ?',
    ['new-key', 'uuid-1'],
  ]);
  assert.deepEqual(runs[1][1], [null, 'uuid-1']);
});

test('a successful poll is recorded without marking the show dirty', async () => {
  // Otherwise every terminal would prompt to save an unchanged document every
  // 30 seconds.
  const { Repo, runs, quiet } = createDb();
  await Repo.SetLastSuccessAt(1700000000000, 'uuid-1');
  assert.equal(runs.length, 0, 'must not go through the dirty-tracking path');
  assert.deepEqual(quiet[0], [
    'UPDATE FreeKioskTerminals SET LastSuccessAt = ? WHERE UUID = ?',
    [1700000000000, 'uuid-1'],
  ]);
});

test('poll timestamps fall back to Run on a stub without quiet writes', async () => {
  const runs = [];
  const Repo = CreateFreeKioskTerminalsRepository({
    Run: async (sql, params) => {
      runs.push([sql, params]);
      return [null, { changes: 1 }];
    },
  });
  const [err] = await Repo.SetLastSuccessAt(1, 'uuid-1');
  assert.equal(err, null);
  assert.equal(runs.length, 1);
});

test('group ordering statements match what the shared helper expects', async () => {
  const { Repo, runs } = createDb();
  await Repo.SetGroupAndWeight(4, 20, 'uuid-1');
  await Repo.ClearGroup('uuid-1');
  assert.deepEqual(runs[0], [
    'UPDATE FreeKioskTerminals SET GroupID = ?, Weight = ? WHERE UUID = ?',
    [4, 20, 'uuid-1'],
  ]);
  assert.deepEqual(runs[1], [
    'UPDATE FreeKioskTerminals SET GroupID = ? WHERE UUID = ?',
    [null, 'uuid-1'],
  ]);
});

test('slug and delete statements are keyed by UUID', async () => {
  const { Repo, runs } = createDb();
  await Repo.UpdateSlug('lobby-kiosk', 'uuid-1');
  await Repo.Delete('uuid-1');
  assert.deepEqual(runs[0], [
    'UPDATE FreeKioskTerminals SET Slug = ? WHERE UUID = ?',
    ['lobby-kiosk', 'uuid-1'],
  ]);
  assert.deepEqual(runs[1], ['DELETE FROM FreeKioskTerminals WHERE UUID = ?', ['uuid-1']]);
});
