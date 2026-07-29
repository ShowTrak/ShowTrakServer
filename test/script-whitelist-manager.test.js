const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

const noopLogger = { CreateLogger: () => ({ error: () => {}, warn: () => {}, log: () => {} }) };

// Load the manager with an in-memory repository so we exercise the manager's
// scope parsing/normalization/resolution logic without a real database.
function load() {
  const store = new Map(); // ScriptID -> Scope JSON string
  const repo = {
    LoadAll: async () => [
      null,
      [...store.entries()].map(([ScriptID, Scope]) => ({ ScriptID, Scope, UpdatedAt: 1 })),
    ],
    Get: async (id) => [
      null,
      store.has(id) ? { ScriptID: id, Scope: store.get(id), UpdatedAt: 1 } : null,
    ],
    Set: async (id, scope) => {
      store.set(id, scope);
      return [null, {}];
    },
    Delete: async (id) => {
      store.delete(id);
      return [null, {}];
    },
    Rename: async (oldId, newId) => {
      if (store.has(oldId)) {
        store.set(newId, store.get(oldId));
        store.delete(oldId);
      }
      return [null, {}];
    },
  };
  const mod = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'ScriptWhitelistManager', 'index.js'),
    {
      '../Logger': noopLogger,
      '../DB': { Manager: {} },
      '../DB/repositories/script-whitelists': { CreateScriptWhitelistRepository: () => repo },
    }
  );
  return { Manager: mod.Manager, store };
}

test('IsClientAllowed: unrestricted (null scope or Workspace) admits everyone', () => {
  const { Manager } = load();
  const client = { UUID: 'a', GroupID: 5 };
  assert.equal(Manager.IsClientAllowed(null, client), true);
  assert.equal(Manager.IsClientAllowed(undefined, client), true);
  assert.equal(Manager.IsClientAllowed({ Workspace: true, Groups: [], Clients: [] }, client), true);
});

test('IsClientAllowed: restricted scope matches by client UUID or group', () => {
  const { Manager } = load();
  const scope = { Workspace: false, Groups: [7], Clients: ['keep'] };
  assert.equal(
    Manager.IsClientAllowed(scope, { UUID: 'keep', GroupID: null }),
    true,
    'explicit client'
  );
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'other', GroupID: 7 }), true, 'group member');
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'other', GroupID: 9 }), false, 'wrong group');
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'other', GroupID: null }), false, 'no match');
});

test('IsClientAllowed: empty restricted scope admits nobody', () => {
  const { Manager } = load();
  const scope = { Workspace: false, Groups: [], Clients: [] };
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'a', GroupID: 1 }), false);
});

test('GetScope: absent row is unrestricted (null)', async () => {
  const { Manager } = load();
  assert.equal(await Manager.GetScope('nope'), null);
});

test('SetScope: Workspace collapses to the no-row unrestricted default', async () => {
  const { Manager, store } = load();
  await Manager.SetScope('s1', { Workspace: false, Groups: [1], Clients: ['x'] });
  assert.ok(store.has('s1'), 'restricted scope is stored');
  assert.deepEqual(await Manager.GetScope('s1'), {
    Workspace: false,
    Groups: [1],
    Clients: ['x'],
    Tags: [],
  });

  // Re-selecting "All Clients" must delete the row so new clients keep access.
  await Manager.SetScope('s1', { Workspace: true, Groups: [], Clients: [] });
  assert.equal(store.has('s1'), false, 'workspace scope deletes the row');
  assert.equal(await Manager.GetScope('s1'), null);
});

test('SetScope: normalizes group/client entries', async () => {
  const { Manager } = load();
  await Manager.SetScope('s2', {
    Workspace: false,
    Groups: ['3', 3, 'bad'],
    Clients: [' u1 ', ''],
  });
  const scope = await Manager.GetScope('s2');
  assert.deepEqual(scope.Groups, [3], 'dedupes + coerces numeric groups, drops NaN');
  assert.deepEqual(scope.Clients, ['u1'], 'trims and drops empty client entries');
});

test('DeleteForScript and RenameScript', async () => {
  const { Manager, store } = load();
  await Manager.SetScope('old', { Workspace: false, Groups: [1], Clients: [] });
  await Manager.RenameScript('old', 'new');
  assert.equal(store.has('old'), false);
  assert.deepEqual(await Manager.GetScope('new'), {
    Workspace: false,
    Groups: [1],
    Clients: [],
    Tags: [],
  });

  await Manager.DeleteForScript('new');
  assert.equal(await Manager.GetScope('new'), null);
});

test('GetScope: malformed stored JSON fails open (unrestricted)', async () => {
  const { Manager, store } = load();
  store.set('corrupt', '{not valid json');
  assert.equal(await Manager.GetScope('corrupt'), null);
});

test('IsClientAllowed: a whitelisted tag admits its members, through nesting', () => {
  const { Manager } = load();
  // "all-foh" absorbs "foh", which names one client outright and one by group.
  const tags = [
    { TagID: 1, Scope: { Workspace: false, Groups: [], Clients: [], Tags: [2] } },
    { TagID: 2, Scope: { Workspace: false, Groups: [7], Clients: ['named'], Tags: [] } },
  ];
  const scope = { Workspace: false, Groups: [], Clients: [], Tags: [1] };

  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'named', GroupID: null }, tags), true);
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'other', GroupID: 7 }, tags), true);
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'other', GroupID: 9 }, tags), false);
  // Without the tag list the reference cannot be expanded, so nobody matches.
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'named', GroupID: null }), false);
});

test('IsClientAllowed: a cycle between tags terminates instead of hanging', () => {
  const { Manager } = load();
  // Two tags that name each other — reachable by editing each in turn, so it
  // has to resolve, not spin.
  const tags = [
    { TagID: 1, Scope: { Workspace: false, Groups: [], Clients: [], Tags: [2] } },
    { TagID: 2, Scope: { Workspace: false, Groups: [], Clients: ['in'], Tags: [1] } },
  ];
  const scope = { Workspace: false, Groups: [], Clients: [], Tags: [1] };
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'in', GroupID: null }, tags), true);
  assert.equal(Manager.IsClientAllowed(scope, { UUID: 'out', GroupID: null }, tags), false);
});

test('SetScope: normalizes tag entries', async () => {
  const { Manager } = load();
  await Manager.SetScope('s3', {
    Workspace: false,
    Groups: [],
    Clients: [],
    Tags: ['4', 4, 0, -1, 'bad'],
  });
  const scope = await Manager.GetScope('s3');
  assert.deepEqual(scope.Tags, [4], 'dedupes + coerces numeric tags, drops junk');
});

test('DecorateCatalog attaches Whitelist (null when unrestricted)', async () => {
  const { Manager } = load();
  await Manager.SetScope('restricted', { Workspace: false, Groups: [2], Clients: [] });
  const catalog = [
    { ID: 'restricted', Name: 'R' },
    { ID: 'free', Name: 'F' },
  ];
  const decorated = await Manager.DecorateCatalog(catalog);
  assert.deepEqual(decorated[0].Whitelist, {
    Workspace: false,
    Groups: [2],
    Clients: [],
    Tags: [],
  });
  assert.equal(decorated[1].Whitelist, null);
  // Must not mutate the source catalog entries.
  assert.equal('Whitelist' in catalog[0], false);
});
