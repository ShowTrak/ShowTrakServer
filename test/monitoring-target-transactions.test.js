const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');
const {
  CreateMonitoringTargetsRepository,
} = require('../dist/Modules/DB/repositories/monitoring-targets');

// A WithTransaction stub that mirrors the real one: it hands `fn` a `run` that
// records every statement, commits by returning [null, value], and rolls back
// (returns [err, null]) when `fn` throws. `failOn` forces a given SQL fragment
// to fail so we can exercise the rollback path.
function makeTxDB({ failOn } = {}) {
  const runCalls = [];
  const Manager = {
    Run: async (sql, params) => {
      runCalls.push([sql, params]);
      if (failOn && sql.includes(failOn)) return ['boom', null];
      if (sql.includes('INSERT INTO MonitoringTargets')) return [null, { lastID: 500 }];
      if (sql.includes('INSERT INTO MonitoringChecks')) return [null, { lastID: 600 }];
      return [null, { changes: 1 }];
    },
    RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
    WithTransaction: async (fn) => {
      try {
        return [null, await fn(Manager.Run)];
      } catch (err) {
        return [err, null];
      }
    },
  };
  return { Manager, runCalls };
}

test('DeleteTargetCascade deletes checks then the target in one transaction', async () => {
  const { Manager, runCalls } = makeTxDB();
  const Repo = CreateMonitoringTargetsRepository(Manager);

  const [err] = await Repo.DeleteTargetCascade(42);
  assert.equal(err, null);

  const deletes = runCalls.filter(([sql]) => sql.startsWith('DELETE'));
  assert.deepEqual(deletes, [
    ['DELETE FROM MonitoringChecks WHERE TargetID = ?', [42]],
    ['DELETE FROM MonitoringTargets WHERE TargetID = ?', [42]],
  ]);
});

test('DeleteTargetCascade surfaces the error when the target delete fails', async () => {
  const { Manager } = makeTxDB({ failOn: 'DELETE FROM MonitoringTargets' });
  const Repo = CreateMonitoringTargetsRepository(Manager);

  const [err, value] = await Repo.DeleteTargetCascade(42);
  // The checks delete already ran, but the failing target delete rolls the whole
  // transaction back — the caller must see the failure, not a silent partial.
  assert.equal(value, null);
  assert.ok(err, 'a failed cascade must surface an error');
});

test('MonitoringTargetManager.Create rolls back the target when a check insert fails', async () => {
  const events = [];
  let checkInserts = 0;

  const dbMock = {
    Manager: {
      All: async () => [null, []],
      Run: async (sql) => {
        if (sql.includes('INSERT INTO MonitoringTargets')) return [null, { lastID: 77 }];
        if (sql.includes('INSERT INTO MonitoringChecks')) {
          checkInserts += 1;
          // First check inserts, the second fails mid-batch.
          if (checkInserts === 2) return ['insert failed', null];
          return [null, { lastID: 800 + checkInserts }];
        }
        return [null, { changes: 1 }];
      },
      RunWithoutDirtyTracking: async () => [null, { changes: 1 }],
      WithTransaction: async (fn) => {
        try {
          return [null, await fn(dbMock.Manager.Run)];
        } catch (err) {
          return [err, null];
        }
      },
    },
  };

  const modulePath = path.join(
    __dirname,
    '..',
    'dist',
    'Modules',
    'MonitoringTargetManager',
    'index.js'
  );
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => ({ error: () => {} }) },
    '../DB': dbMock,
    '../Broadcast': { Manager: { emit: (event) => events.push(event) } },
    '../MonitoringMethods': {
      Manager: {
        Has: () => true,
        NormalizeSettings: (_id, settings) => settings,
        Run: async () => ({ Success: true, LatencyMs: 5 }),
      },
    },
    '../Utils': require('../dist/Modules/Utils'),
  });

  await Manager.Init();
  events.length = 0; // Init broadcasts a list-changed event; only watch Create's.

  const [err, value] = await Manager.Create({
    Nickname: 'Two Checks',
    Interval: 5000,
    Checks: [
      { Address: 'a.local', Method: 'ping', Settings: {} },
      { Address: 'b.local', Method: 'ping', Settings: {} },
    ],
  });

  assert.match(String(err), /Failed to create monitoring target/i);
  assert.equal(value, null);

  // The partially-inserted target must not have been adopted into the runtime
  // list, and no list-changed event should have fired for it.
  const [, all] = await Manager.GetAll();
  assert.equal(all.length, 0, 'a rolled-back create must not leave a runtime target');
  assert.equal(
    events.includes('MonitoringTargetListChanged'),
    false,
    'no list-changed broadcast for a failed create'
  );
});
