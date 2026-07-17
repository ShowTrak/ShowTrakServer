const test = require('node:test');
const assert = require('node:assert/strict');

const { CreateClientsRepository } = require('../dist/Modules/DB/repositories/clients');

// UpdateColumn interpolates the column name into the SQL (SQLite cannot bind an
// identifier), so it must only ever emit a column from its allowlist. An unknown
// name has to be refused before it reaches the query string.
test('ClientsRepository.UpdateColumn persists an allowlisted column', async () => {
  const runs = [];
  const Repo = CreateClientsRepository({
    Run: async (sql, params) => {
      runs.push([sql, params]);
      return [null, { changes: 1 }];
    },
  });

  const [err] = await Repo.UpdateColumn('uuid-1', 'Nickname', 'Booth PC');
  assert.equal(err, null);
  assert.deepEqual(runs, [
    ['UPDATE Clients SET Nickname = ? WHERE UUID = ?', ['Booth PC', 'uuid-1']],
  ]);
});

test('ClientsRepository.UpdateColumn refuses an unknown column without touching the DB', async () => {
  let ran = false;
  const Repo = CreateClientsRepository({
    Run: async () => {
      ran = true;
      return [null, { changes: 1 }];
    },
  });

  // A SQL-injection attempt through the column name must be rejected outright.
  const [err] = await Repo.UpdateColumn('uuid-1', 'Nickname = ?; DROP TABLE Clients; --', 'x');
  assert.match(String(err), /unknown client column/i);
  assert.equal(ran, false, 'no query should be issued for a rejected column');
});
