const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installModuleMocks } = require('./helpers/main-mocks');

// Exercises src/Modules/SampleScripts/index.ts — the cached catalog of sample
// script templates fetched from the public ShowTrak/SampleScripts repository.
//
// The security surface is the pair of path guards. Entries in the repo tree are
// remote, third-party text that becomes a FOLDER NAME and FILE PATHS which the
// Script Manager later writes to disk when the operator creates a script from a
// template. `IsSafeSegment` and `IsSafeRelativePath` are what stop a crafted or
// compromised upstream tree from escaping the scripts directory, so both are
// driven through `BuildSamplesFromTree` with hostile entries.
//
// Also pinned: the sha check that avoids re-downloading an unchanged catalog,
// the in-flight coalescing that stops concurrent callers stampeding GitHub, and
// the 6-hour staleness window.
//
// NOTE the mock matchers below: this module lives inside src/Modules/, so it
// imports its siblings as '../Logger' / '../AppData' / '../Broadcast'. A
// suffix-only '/Modules/AppData' matcher does NOT match those and would let the
// real manager load — which means writing to the operator's live app data.

const CacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-samples-'));
test.after(() => fs.rmSync(CacheRoot, { recursive: true, force: true }));

const CatalogPath = path.join(CacheRoot, 'catalog.json');

const logs = { warns: [], errors: [] };
const broadcasts = [];

/** url -> { ok, status, statusText, json?, body? } */
const routes = new Map();
const fetched = [];

const SHA_URL = 'https://api.github.com/repos/ShowTrak/SampleScripts/commits/main';
const TREE_URL = 'https://api.github.com/repos/ShowTrak/SampleScripts/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/ShowTrak/SampleScripts/main/';

const OriginalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const Url = String(url);
  fetched.push(Url);
  const Route = routes.get(Url);
  if (!Route) {
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  if (Route.throws) throw new Error('network down');
  return {
    ok: Route.ok !== false,
    status: Route.status || 200,
    statusText: Route.statusText || 'OK',
    json: async () => Route.json,
    arrayBuffer: async () => {
      const Buf = Buffer.from(String(Route.body ?? ''), 'utf-8');
      return Buf.buffer.slice(Buf.byteOffset, Buf.byteOffset + Buf.byteLength);
    },
  };
};
test.after(() => {
  globalThis.fetch = OriginalFetch;
});

const restore = installModuleMocks([
  { match: (r) => r === 'electron' || r === 'electron/main', value: {} },
  {
    match: (r) => r === '../Logger' || r.endsWith('/Modules/Logger'),
    value: {
      CreateLogger: () => ({
        log: () => {},
        info: () => {},
        warn: (...args) => logs.warns.push(args),
        error: (...args) => logs.errors.push(args),
        debug: () => {},
        success: () => {},
        database: () => {},
        databaseError: () => {},
      }),
    },
  },
  {
    match: (r) => r === '../AppData' || r.endsWith('/Modules/AppData'),
    value: { Manager: { GetSampleScriptsDirectory: () => CacheRoot } },
  },
  {
    match: (r) => r === '../Broadcast' || r.endsWith('/Modules/Broadcast'),
    value: { Manager: { emit: (...args) => broadcasts.push(args) } },
  },
]);
test.after(() => restore());

// Refuse to run against real app data if a matcher ever stops matching.
{
  const Probe = require('../dist/Modules/AppData');
  assert.equal(
    Probe.Manager.GetSampleScriptsDirectory(),
    CacheRoot,
    'AppData mock did not apply — refusing to run against real app data'
  );
}

/** Re-require the module so its cached catalog/sha/timers start empty. */
function freshManager() {
  fs.rmSync(CacheRoot, { recursive: true, force: true });
  fs.mkdirSync(CacheRoot, { recursive: true });
  routes.clear();
  fetched.length = 0;
  logs.warns.length = 0;
  logs.errors.length = 0;
  broadcasts.length = 0;

  const Resolved = require.resolve('../dist/Modules/SampleScripts');
  delete require.cache[Resolved];
  return require(Resolved).Manager;
}

/** Register the sha endpoint. */
function withSha(sha) {
  routes.set(SHA_URL, { json: { sha } });
}

/** Register a repo tree of blob paths. */
function withTree(paths) {
  routes.set(TREE_URL, {
    json: { tree: paths.map((P) => (typeof P === 'string' ? { type: 'blob', path: P } : P)) },
  });
}

/** Register a raw file's contents. */
function withFile(repoPath, body) {
  const Encoded = repoPath.split('/').map(encodeURIComponent).join('/');
  routes.set(`${RAW_BASE}${Encoded}`, { body });
}

/** A minimal valid sample: Script.json plus one script file. */
function seedSample(folder, config = {}) {
  withFile(`${folder}/Script.json`, JSON.stringify({ Name: folder, ...config }));
  withFile(`${folder}/run.sh`, '#!/bin/sh\n');
  return [`${folder}/Script.json`, `${folder}/run.sh`];
}

// --- Refresh: the happy path ------------------------------------------------

test('Refresh downloads the catalog, caches it and announces the update', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot', { Name: 'Reboot PC', Description: 'Restarts', Colour: 3 }));

  assert.deepEqual(await M.Refresh(), { ok: true, updated: true });

  const List = await M.GetSampleList();
  assert.deepEqual(List, [
    {
      id: 'reboot',
      name: 'Reboot PC',
      description: 'Restarts',
      colour: 3,
      confirm: false,
      platforms: {},
    },
  ]);
  assert.deepEqual(broadcasts, [['SampleScriptsUpdated']]);

  // Persisted for the next boot.
  const Cached = JSON.parse(fs.readFileSync(CatalogPath, 'utf-8'));
  assert.equal(Cached.sha, 'sha-1');
  assert.equal(Cached.samples.length, 1);
});

test('a sample carries its files base64-encoded', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot'));

  await M.Refresh();
  const Sample = await M.GetSample('reboot');

  const Run = Sample.files.find((F) => F.path === 'run.sh');
  assert.equal(Buffer.from(Run.content, 'base64').toString('utf-8'), '#!/bin/sh\n');
  // Paths are relative to the sample folder, not the repo root.
  assert.deepEqual(Sample.files.map((F) => F.path).sort(), ['Script.json', 'run.sh']);
});

test('config fields fall back to sane defaults', async () => {
  const M = freshManager();
  withSha('sha-1');
  withFile('bare/Script.json', JSON.stringify({}));
  withTree(['bare/Script.json']);

  await M.Refresh();
  const [Summary] = await M.GetSampleList();
  // The folder name stands in for a missing/blank Name.
  assert.equal(Summary.name, 'bare');
  assert.equal(Summary.description, '');
  assert.equal(Summary.colour, 6);
  assert.equal(Summary.confirm, false);
  assert.deepEqual(Summary.platforms, {});
});

test('samples are listed in name order, not repo order', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree([
    ...seedSample('zebra', { Name: 'Zebra' }),
    ...seedSample('alpha', { Name: 'Alpha' }),
    ...seedSample('middle', { Name: 'Middle' }),
  ]);

  await M.Refresh();
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.name),
    ['Alpha', 'Middle', 'Zebra']
  );
});

// --- Path safety ------------------------------------------------------------

test('a traversal folder name is dropped from the catalog', async () => {
  // The folder becomes a directory name under the scripts directory when the
  // operator creates a script from the template.
  const M = freshManager();
  withSha('sha-1');
  withFile('../escape/Script.json', '{}');
  withTree(['../escape/Script.json', ...seedSample('safe')]);

  await M.Refresh();
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['safe']
  );
});

test('nested traversal inside a sample path is dropped', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(['good/../../escape.sh', 'good/Script.json', ...seedSample('safe')]);
  withFile('good/Script.json', '{}');

  await M.Refresh();
  const Ids = (await M.GetSampleList()).map((S) => S.id);
  assert.ok(!Ids.includes('escape.sh'));
  // The traversal blob is skipped; the rest of that folder still loads.
  const Good = await M.GetSample('good');
  assert.deepEqual(
    Good.files.map((F) => F.path),
    ['Script.json']
  );
});

test('root-level files and empty path segments are ignored', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(['README.md', '.DS_Store', 'double//slash/Script.json', ...seedSample('safe')]);

  await M.Refresh();
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['safe']
  );
});

test('non-blob tree entries are ignored', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree([
    { type: 'tree', path: 'reboot' },
    { type: 'blob', path: 'reboot/Script.json' },
    { type: 'blob', path: 'reboot/run.sh' },
    { type: 'blob' }, // no path
    'not-an-object-with-two-parts',
    null,
  ]);
  withFile('reboot/Script.json', '{}');
  withFile('reboot/run.sh', 'x');

  await M.Refresh();
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['reboot']
  );
});

test('GetSample refuses an unsafe id without touching the catalog', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot'));
  await M.Refresh();

  for (const Bad of ['../reboot', 'a/b', 'a\\b', '', null, undefined, 42]) {
    assert.equal(await M.GetSample(Bad), null, `expected null for ${JSON.stringify(Bad)}`);
  }
  assert.equal(await M.GetSample('nope'), null);
  assert.ok(await M.GetSample('reboot'));
});

// --- Catalog construction edge cases ---------------------------------------

test('a folder without Script.json is not a sample', async () => {
  const M = freshManager();
  withSha('sha-1');
  withFile('loose/run.sh', 'x');
  withTree(['loose/run.sh', ...seedSample('safe')]);

  await M.Refresh();
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['safe']
  );
});

test('a sample with unparseable Script.json is skipped, not half-imported', async () => {
  const M = freshManager();
  withSha('sha-1');
  withFile('broken/Script.json', '{ not json');
  withTree(['broken/Script.json', ...seedSample('safe')]);

  await M.Refresh();
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['safe']
  );
  assert.ok(logs.errors.some((E) => /invalid Script\.json/i.test(String(E[0]))));
});

test('a failed file download fails the whole refresh rather than caching a partial sample', async () => {
  // Importing a template that is missing half its files would produce a script
  // that cannot run.
  const M = freshManager();
  withSha('sha-1');
  withTree(['reboot/Script.json', 'reboot/run.sh']);
  withFile('reboot/Script.json', '{}');
  // run.sh is deliberately not registered -> 404.

  assert.deepEqual(await M.Refresh(), {
    ok: false,
    error: 'Failed to download one or more sample scripts',
  });
  assert.deepEqual(await M.GetSampleList(), []);
  assert.deepEqual(broadcasts, [], 'a failed refresh must not announce an update');
});

// --- The sha check ----------------------------------------------------------

test('booting with an up-to-date cache checks the sha and downloads nothing else', async () => {
  // The common case on every startup: the cached catalog is current, so the
  // whole repo crawl (tree + one raw request per file) must be skipped.
  fs.mkdirSync(CacheRoot, { recursive: true });
  fs.writeFileSync(
    CatalogPath,
    JSON.stringify({
      sha: 'sha-1',
      samples: [
        {
          id: 'cached',
          name: 'Cached',
          description: '',
          colour: 6,
          confirm: false,
          platforms: {},
          files: [],
        },
      ],
    }),
    'utf-8'
  );

  const Resolved = require.resolve('../dist/Modules/SampleScripts');
  delete require.cache[Resolved];
  routes.clear();
  fetched.length = 0;
  broadcasts.length = 0;
  const M = require(Resolved).Manager;

  withSha('sha-1'); // upstream unchanged
  withTree(seedSample('reboot')); // registered but must NOT be requested

  await M.Initialize();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fetched, [SHA_URL], 'only the cheap sha check should have run');
  assert.deepEqual(broadcasts, [], 'nothing changed, so nothing to announce');
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['cached']
  );
});

test('an explicit Refresh re-downloads even when the sha is unchanged', async () => {
  // The manual "refresh" button must be able to repair a corrupted local cache.
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot'));
  await M.Refresh();

  fetched.length = 0;
  await M.Refresh();
  assert.ok(fetched.includes(TREE_URL));
});

test('a changed sha triggers a rebuild', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot', { Name: 'Reboot' }));
  await M.Refresh();

  withSha('sha-2');
  withTree(seedSample('shutdown', { Name: 'Shutdown' }));
  assert.deepEqual(await M.Refresh(), { ok: true, updated: true });
  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['shutdown']
  );
});

// --- Network failure handling ----------------------------------------------

test('an unreachable repository reports a friendly error and keeps the cache', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot'));
  await M.Refresh();

  routes.set(SHA_URL, { throws: true });
  assert.deepEqual(await M.Refresh(), {
    ok: false,
    error: 'Unable to reach the sample scripts repository',
  });
  // The previously cached catalog survives — the panel still lists templates.
  assert.equal((await M.GetSampleList()).length, 1);
});

test('a failed tree download reports its own error', async () => {
  const M = freshManager();
  withSha('sha-1');
  routes.set(TREE_URL, { throws: true });

  assert.deepEqual(await M.Refresh(), {
    ok: false,
    error: 'Unable to download the sample scripts catalog',
  });
});

test('a non-200 from GitHub is surfaced as a failure, not an empty catalog', async () => {
  const M = freshManager();
  routes.set(SHA_URL, { ok: false, status: 403, statusText: 'rate limited' });

  const Result = await M.Refresh();
  assert.equal(Result.ok, false);
  assert.ok(logs.warns.some((W) => /403/.test(String(W[0]))));
});

test('a tree response with no tree array yields an empty catalog rather than throwing', async () => {
  const M = freshManager();
  withSha('sha-1');
  routes.set(TREE_URL, { json: { message: 'nope' } });

  assert.deepEqual(await M.Refresh(), { ok: true, updated: true });
  assert.deepEqual(await M.GetSampleList(), []);
});

// --- Disk cache -------------------------------------------------------------

test('Initialize loads a catalog written by a previous run', async () => {
  fs.mkdirSync(CacheRoot, { recursive: true });
  fs.writeFileSync(
    CatalogPath,
    JSON.stringify({
      sha: 'sha-cached',
      samples: [
        {
          id: 'cached',
          name: 'Cached',
          description: '',
          colour: 6,
          confirm: false,
          platforms: {},
          files: [],
        },
      ],
    }),
    'utf-8'
  );

  const Resolved = require.resolve('../dist/Modules/SampleScripts');
  delete require.cache[Resolved];
  routes.clear();
  const M = require(Resolved).Manager;
  // No routes registered: the refresh will fail, which must not lose the cache.
  await M.Initialize();

  assert.deepEqual(
    (await M.GetSampleList()).map((S) => S.id),
    ['cached']
  );
});

test('a corrupt or malformed cache file is ignored rather than fatal', async () => {
  for (const Bad of ['{ not json', JSON.stringify({ samples: 'nope' }), JSON.stringify({})]) {
    fs.mkdirSync(CacheRoot, { recursive: true });
    fs.writeFileSync(CatalogPath, Bad, 'utf-8');

    const Resolved = require.resolve('../dist/Modules/SampleScripts');
    delete require.cache[Resolved];
    routes.clear();
    const M = require(Resolved).Manager;

    await M.Initialize();
    assert.deepEqual(await M.GetSampleList(), []);
  }
});

// --- Refresh coalescing and staleness ---------------------------------------

test('concurrent callers share one in-flight refresh', async () => {
  // Three panels opening at once must not trigger three GitHub crawls.
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot'));

  const [A, B, C] = await Promise.all([M.GetSampleList(), M.GetSampleList(), M.GetSampleList()]);
  assert.equal(A.length, 1);
  assert.equal(B.length, 1);
  assert.equal(C.length, 1);

  assert.equal(
    fetched.filter((U) => U === SHA_URL).length,
    1,
    'the sha endpoint should be hit once, not once per caller'
  );
});

test('a second list within the staleness window does not re-check GitHub', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot'));
  await M.GetSampleList();

  fetched.length = 0;
  await M.GetSampleList();
  assert.deepEqual(fetched, [], 'the 6-hour window should suppress a second check');
});

test('GetSample triggers a refresh when the catalog is empty', async () => {
  const M = freshManager();
  withSha('sha-1');
  withTree(seedSample('reboot'));

  const Sample = await M.GetSample('reboot');
  assert.equal(Sample.id, 'reboot');
});

test('Initialize never rejects when the background refresh fails', async () => {
  const M = freshManager();
  routes.set(SHA_URL, { throws: true });
  await assert.doesNotReject(() => M.Initialize());
});
