const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// ServerIdentity persists a stable token to <Storage>/server-identity.json and
// caches it in-module. Each loadWithMocks() re-requires the module fresh, which
// resets that cache, so tests stay isolated.

function identityPath() {
  return path.join(__dirname, '..', 'dist', 'Modules', 'ServerIdentity', 'index.js');
}

// The module derives its storage path with path.join(), so the in-memory file
// store has to be keyed the same way — a hardcoded '/storage/...' literal misses
// entirely on platforms whose separator is not '/'.
function identityFilePath() {
  return path.join('/storage', 'server-identity.json');
}

// Builds fs/AppData/UUID mocks over an in-memory file store.
function loadManager({ files = {}, uuid = 'generated-token' } = {}) {
  const store = new Map(Object.entries(files));
  const writes = [];
  let initializeCalls = 0;
  let generateCalls = 0;

  const fsMock = {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
      return store.get(p);
    },
    writeFileSync: (p, data) => {
      writes.push({ path: p, data });
      store.set(p, data);
    },
  };

  const appDataMock = {
    Manager: {
      GetStorageDirectory: () => '/storage',
      Initialize: () => {
        initializeCalls += 1;
      },
    },
  };

  const uuidMock = {
    Manager: {
      Generate: () => {
        generateCalls += 1;
        return uuid;
      },
    },
  };

  const module = loadWithMocks(identityPath(), {
    fs: fsMock,
    '../AppData': appDataMock,
    '../UUID': uuidMock,
  });

  return {
    module,
    store,
    writes,
    stats: () => ({ initializeCalls, generateCalls }),
  };
}

test('GetIdentity generates and persists a new token when none exists on disk', () => {
  const { module, store, writes, stats } = loadManager({ uuid: 'fresh-token' });

  const identity = module.Manager.GetIdentity();
  assert.equal(identity.Token, 'fresh-token');
  assert.equal(typeof identity.CreatedAt, 'number');

  // It wrote the identity to <Storage>/server-identity.json.
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /server-identity\.json$/);
  const persisted = JSON.parse(store.get(writes[0].path));
  assert.equal(persisted.Token, 'fresh-token');

  // AppData was initialized and the UUID was generated exactly once.
  assert.deepEqual(stats(), { initializeCalls: 1, generateCalls: 1 });
});

test('GetIdentity caches within the module and does not re-read or re-generate', () => {
  const { module, writes, stats } = loadManager({ uuid: 'once' });

  const first = module.Manager.GetIdentity();
  const second = module.Manager.GetIdentity();

  assert.equal(first, second); // same cached object reference
  assert.equal(writes.length, 1); // only written on the first call
  assert.deepEqual(stats(), { initializeCalls: 1, generateCalls: 1 });
});

test('GetIdentity loads and trims an existing valid token from disk', () => {
  const filePath = identityFilePath();
  const { module, writes, stats } = loadManager({
    files: { [filePath]: JSON.stringify({ Token: '  existing-token  ', CreatedAt: 12345 }) },
  });

  const identity = module.Manager.GetIdentity();
  assert.equal(identity.Token, 'existing-token');
  assert.equal(identity.CreatedAt, 12345);

  // Existing token means no write and no generation.
  assert.equal(writes.length, 0);
  assert.deepEqual(stats(), { initializeCalls: 1, generateCalls: 0 });
});

test('GetIdentity defaults CreatedAt when the stored value is not a number', () => {
  const filePath = identityFilePath();
  const { module } = loadManager({
    files: { [filePath]: JSON.stringify({ Token: 'tok', CreatedAt: 'not-a-number' }) },
  });

  const identity = module.Manager.GetIdentity();
  assert.equal(identity.Token, 'tok');
  assert.equal(typeof identity.CreatedAt, 'number');
});

test('GetIdentity regenerates when the stored file is malformed or has an empty token', () => {
  const filePath = identityFilePath();

  // Corrupt JSON -> caught, treated as no identity, regenerated.
  const corrupt = loadManager({ files: { [filePath]: '{ not json' }, uuid: 'rebuilt' });
  assert.equal(corrupt.module.Manager.GetIdentity().Token, 'rebuilt');
  assert.equal(corrupt.writes.length, 1);

  // Blank token -> rejected, regenerated.
  const blank = loadManager({
    files: { [filePath]: JSON.stringify({ Token: '   ' }) },
    uuid: 'replacement',
  });
  assert.equal(blank.module.Manager.GetIdentity().Token, 'replacement');
  assert.equal(blank.writes.length, 1);
});

test('GetIdentityToken returns the token string', () => {
  const { module } = loadManager({ uuid: 'token-value' });
  assert.equal(module.Manager.GetIdentityToken(), 'token-value');
});
