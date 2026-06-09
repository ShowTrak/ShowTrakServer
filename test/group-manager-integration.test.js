const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

function loggerStub() {
  const noop = () => {};
  return {
    CreateLogger: () => ({
      log: noop, info: noop, warn: noop, error: noop, debug: noop,
      trace: noop, success: noop, database: noop, databaseError: noop, silent: noop,
    }),
  };
}

async function buildRealDB() {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-group-db-'));
  const dbModule = loadWithMocks(path.join(__dirname, '..', 'src', 'Modules', 'DB', 'index.js'), {
    '../Logger': loggerStub(),
    '../AppData': { Manager: { GetStorageDirectory: () => storageDir } },
  });
  await dbModule.Manager.Ready();
  return dbModule;
}

async function loadGroupManager() {
  const dbModule = await buildRealDB();
  const movedClients = [];
  const movedTargets = [];
  const events = [];
  const groupManager = loadWithMocks(
    path.join(__dirname, '..', 'src', 'Modules', 'GroupManager', 'index.js'),
    {
      '../Logger': loggerStub(),
      '../DB': dbModule,
      '../Broadcast': { Manager: { emit: (e) => events.push(e) } },
      '../ClientManager': {
        Manager: {
          MoveGroupToNoGroup: async (id) => {
            movedClients.push(id);
            return [null, 0];
          },
          ReconcileOrphanedGroups: async () => [null, 0],
        },
      },
      '../MonitoringTargetManager': {
        Manager: {
          MoveGroupToNoGroup: async (id) => {
            movedTargets.push(id);
            return [null, 0];
          },
          ReconcileOrphanedGroups: async () => [null, 0],
        },
      },
    }
  );
  return { Manager: groupManager.Manager, DB: dbModule.Manager, events, movedClients, movedTargets };
}

test('GroupManager creates, lists, fetches, and updates groups', async () => {
  const { Manager, events } = await loadGroupManager();

  // Title is required.
  assert.match(String((await Manager.Create(''))[0]), /required/i);

  const [createErr] = await Manager.Create('Front of House');
  assert.equal(createErr, null);
  assert.ok(events.includes('GroupListChanged'));

  const [allErr, groups] = await Manager.GetAll();
  assert.equal(allErr, null);
  assert.equal(groups.length, 1);
  const groupId = groups[0].GroupID;
  assert.equal(groups[0].Title, 'Front of House');

  // Get returns a Group object; missing id is rejected.
  const [getErr, group] = await Manager.Get(groupId);
  assert.equal(getErr, null);
  assert.equal(group.GroupID, groupId);
  assert.match(String((await Manager.Get())[0]), /required/i);

  // Group setters persist.
  await group.SetTitle('Renamed');
  await group.SetWeight(250);
  const [, refetched] = await Manager.Get(groupId);
  assert.equal(refetched.Title, 'Renamed');
  assert.equal(refetched.Weight, 250);
});

test('GroupManager.Delete moves entities to no group and removes the row', async () => {
  const { Manager, movedClients, movedTargets } = await loadGroupManager();
  await Manager.Create('Temp');
  const [, groups] = await Manager.GetAll();
  const groupId = groups[0].GroupID;

  assert.match(String((await Manager.Delete())[0]), /required/i);

  const [delErr, msg] = await Manager.Delete(groupId);
  assert.equal(delErr, null);
  assert.match(String(msg), /deleted/i);
  assert.deepEqual(movedClients, [groupId]);
  assert.deepEqual(movedTargets, [groupId]);

  const [, afterGroups] = await Manager.GetAll();
  assert.equal(afterGroups.length, 0);
});

test('GroupManager.ReconcileOrphanedGroups delegates to entity managers', async () => {
  const { Manager } = await loadGroupManager();
  await Manager.Create('Keepers');
  const [err, ok] = await Manager.ReconcileOrphanedGroups();
  assert.equal(err, null);
  assert.equal(ok, true);
});
