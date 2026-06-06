const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function createLoggerStub() {
  return {
    log: () => {},
    debug: () => {},
    error: () => {},
  };
}

test('AdoptionManager tracks, updates, and removes pending clients', async () => {
  const events = [];
  const existingUUIDs = new Set(['already-adopted']);

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'AdoptionManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../Broadcast': { Manager: { emit: (...args) => events.push(args) } },
    '../ClientManager': { Manager: { Exists: async (uuid) => existingUUIDs.has(uuid) } },
  });

  await Manager.ClearAllDevicesPendingAdoption();

  await Manager.AddClientPendingAdoption('client-1', '10.0.0.10', { Hostname: 'pc-1' });
  await Manager.AddClientPendingAdoption('client-1', '10.0.0.10', { Hostname: 'pc-1' });
  await Manager.SetState('client-1', 'Adopting');

  const pending = Manager.GetClientsPendingAdoption();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].State, 'Adopting');

  await Manager.AddClientPendingAdoption('already-adopted', '10.0.0.11', { Hostname: 'pc-2' });
  assert.equal(Manager.GetClientsPendingAdoption().length, 1);

  Manager.RemoveClientPendingAdoption('client-1');
  assert.equal(Manager.GetClientsPendingAdoption().length, 0);

  const readoptEvent = events.find((entry) => entry[0] === 'ReadoptDevice');
  assert.ok(readoptEvent);
  assert.equal(readoptEvent[1], 'already-adopted');
});

test('GroupManager creates, fetches, updates, and deletes groups', async () => {
  const runs = [];
  const events = [];
  let movedClientGroup = null;
  let movedMonitorGroup = null;
  let reconciledClientGroups = null;
  let reconciledMonitorGroups = null;
  let groupRows = [{ GroupID: 12, Title: 'Group A', Weight: 100 }];

  const dbMock = {
    Manager: {
      Run: async (sql, params) => {
        runs.push([sql, params]);
        if (sql.includes('INSERT INTO Groups')) return [null, { lastID: 12 }];
        if (sql.includes('DELETE FROM Groups')) return [null, { changes: 1 }];
        if (sql.includes('UPDATE Groups SET Title')) return [null, { changes: 1 }];
        if (sql.includes('UPDATE Groups SET Weight')) return [null, { changes: 1 }];
        return [null, { changes: 1 }];
      },
      Get: async () => [null, groupRows[0]],
      All: async () => [null, groupRows],
    },
  };

  const clients = [{ SetGroupID: async () => {} }, { SetGroupID: async () => {} }];

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'GroupManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createLoggerStub() },
    '../DB': dbMock,
    '../Broadcast': { Manager: { emit: (event) => events.push(event) } },
    '../ClientManager': {
      Manager: {
        GetClientsInGroup: async () => clients,
        MoveGroupToNoGroup: async (id) => {
          movedClientGroup = id;
          return [null, 2];
        },
        ReconcileOrphanedGroups: async (groupIDs) => {
          reconciledClientGroups = groupIDs;
          return [null, 0];
        },
      },
    },
    '../MonitoringTargetManager': {
      Manager: {
        MoveGroupToNoGroup: async (id) => {
          movedMonitorGroup = id;
          return [null, 1];
        },
        ReconcileOrphanedGroups: async (groupIDs) => {
          reconciledMonitorGroups = groupIDs;
          return [null, 0];
        },
      },
    },
    '../Utils': require('../src/Modules/Utils'),
  });

  const [createErr] = await Manager.Create('New Group');
  assert.equal(createErr, null);

  const [getErr, group] = await Manager.Get(12);
  assert.equal(getErr, null);
  assert.equal(group.Title, 'Group A');

  await group.SetTitle('Renamed Group');
  await group.SetWeight(250);

  const [allErr, allGroups] = await Manager.GetAll();
  assert.equal(allErr, null);
  assert.equal(allGroups.length, 1);

  const [delErr, delMsg] = await Manager.Delete(12);
  assert.equal(delErr, null);
  assert.match(delMsg, /deleted/i);
  assert.equal(movedClientGroup, 12);
  assert.equal(movedMonitorGroup, 12);

  const [reconcileErr, reconcileResult] = await Manager.ReconcileOrphanedGroups();
  assert.equal(reconcileErr, null);
  assert.equal(reconcileResult, true);
  assert.deepEqual(reconciledClientGroups, [12]);
  assert.deepEqual(reconciledMonitorGroups, [12]);

  assert.ok(runs.some(([sql]) => sql.includes('INSERT INTO Groups')));
  assert.ok(runs.some(([sql]) => sql.includes('DELETE FROM Groups')));
  assert.ok(runs.some(([sql]) => sql.includes('UPDATE Groups SET Title')));
  assert.ok(runs.some(([sql]) => sql.includes('UPDATE Groups SET Weight')));
  assert.ok(events.filter((e) => e === 'GroupListChanged').length >= 2);

  groupRows = [];
  const [missingErr, missingGroup] = await Manager.Get(99);
  assert.equal(missingErr, null);
  assert.equal(missingGroup, null);
});
