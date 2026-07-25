const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Exercises src/Modules/UpdateManager/index.ts — the LAN client-update cache:
// it downloads a ShowTrakClient release from GitHub, stores it, and serves it
// over HTTP to every client on the network.
//
// Two guards here are the security surface, and both are tested directly:
//
//   1. normalizeAssetName() — a GitHub asset name is attacker-influenced text
//      that becomes a FILENAME in the cache directory. It is reduced to a
//      basename and scrubbed to [A-Za-z0-9._-], so no asset can be written
//      outside the cache.
//   2. The public route's allowlist — /updates/client/latest/:fileName is
//      reachable by anything on the LAN. It basenames the request AND requires
//      the name to appear in the manifest, so the endpoint can only ever serve
//      files this server chose to download.
//
// Also pinned: a manifest is only "Ready" when every asset it lists is actually
// present on disk (a half-downloaded release must never be deployed), and the
// release list filters drafts and builds too old to LAN-update.
//
// `https` is stubbed with stream-accurate fakes so the real fs write/rename
// pipeline, redirect handling and progress reporting all run for real against a
// temporary cache directory.

const CacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-updates-'));
test.after(() => fs.rmSync(CacheRoot, { recursive: true, force: true }));

const CacheDir = path.join(CacheRoot, 'ClientUpdateCache');
const ManifestPath = path.join(CacheDir, 'manifest.json');

/** url -> { statusCode, headers, body } for the stubbed https layer. */
const routes = new Map();
const requested = [];

/** A Readable that also carries the bits of http.IncomingMessage this code reads. */
function fakeResponse({ statusCode = 200, headers = {}, body = '' }) {
  const Res = Readable.from([body]);
  Res.statusCode = statusCode;
  Res.headers = headers;
  // requestJson sets an encoding; Readable.from(string) already yields strings.
  Res.setEncoding = () => {};
  return Res;
}

function fakeRequest(url, callback) {
  requested.push(String(url));
  const Req = {
    setTimeout: () => Req,
    on: () => Req,
    end: () => Req,
    destroy: () => Req,
  };
  const Route = routes.get(String(url));
  // Deliver asynchronously, like a real request.
  setImmediate(() => {
    callback(fakeResponse(Route || { statusCode: 404, body: 'not found' }));
  });
  return Req;
}

const httpsStub = {
  request: (url, _options, callback) => fakeRequest(url, callback),
  get: (url, _options, callback) => fakeRequest(url, callback),
};

const restore = installModuleMocks([
  { match: matchesModule('electron/main'), value: {} },
  { match: matchesModule('electron'), value: {} },
  { match: (r) => r === 'https', value: httpsStub },
  {
    // NOTE the matcher shape. UpdateManager sits INSIDE src/Modules/, so it
    // imports its siblings as '../Logger' and '../AppData' — which do NOT end
    // with '/Modules/Logger' or '/Modules/AppData'. Matching only on the
    // '/Modules/...' suffix silently fails to mock them, the REAL AppDataManager
    // loads, and the tests then read and write the operator's actual
    // Storage/ClientUpdateCache. Match both spellings.
    match: (r) => r === '../Logger' || r.endsWith('/Modules/Logger'),
    value: {
      CreateLogger: () => ({
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        success: () => {},
        database: () => {},
        databaseError: () => {},
      }),
    },
  },
  {
    match: (r) => r === '../AppData' || r.endsWith('/Modules/AppData'),
    value: { Manager: { GetStorageDirectory: () => CacheRoot } },
  },
]);
test.after(() => restore());

const { Manager: UpdateManager } = require('../dist/Modules/UpdateManager');

// Fail loudly rather than silently operating on real app data: the module
// captures its cache path at load time, so if the AppData mock ever stops
// matching, every test below would read and write the operator's real
// Storage/ClientUpdateCache instead of the temp directory.
{
  const Probe = require('../dist/Modules/AppData');
  assert.equal(
    Probe.Manager.GetStorageDirectory(),
    CacheRoot,
    'AppData mock did not apply — refusing to run against real app data'
  );
}

const RELEASES_URL = 'https://api.github.com/repos/ShowTrak/ShowTrakClient/releases?per_page=25';
const LATEST_URL = 'https://api.github.com/repos/ShowTrak/ShowTrakClient/releases/latest';
const BY_TAG_URL = 'https://api.github.com/repos/ShowTrak/ShowTrakClient/releases/tags/';

function resetCache() {
  fs.rmSync(CacheDir, { recursive: true, force: true });
  fs.mkdirSync(CacheDir, { recursive: true });
  routes.clear();
  requested.length = 0;
}
test.beforeEach(resetCache);

/** Write a manifest plus (optionally) the asset files it references. */
function seedManifest(manifest, { createFiles = true } = {}) {
  fs.mkdirSync(CacheDir, { recursive: true });
  fs.writeFileSync(ManifestPath, JSON.stringify(manifest), 'utf8');
  if (!createFiles) return;
  for (const Asset of manifest.assets || []) {
    // Some tests deliberately seed unusable entries; only the real ones get a file.
    if (!Asset || !Asset.name) continue;
    fs.writeFileSync(path.join(CacheDir, Asset.name), 'binary-content');
  }
}

/** Register a downloadable asset and return its GitHub-shaped descriptor. */
function asset(name, body = 'binary-content') {
  const Url = `https://objects.githubusercontent.com/${encodeURIComponent(name)}`;
  routes.set(Url, { statusCode: 200, body });
  return { name, size: Buffer.byteLength(body), browser_download_url: Url };
}

// --- GetPublicFeedURLPath ---------------------------------------------------

test('the public feed path is a trailing-slash directory URL', () => {
  // The client resolves asset URLs against this, so the trailing slash matters.
  assert.equal(UpdateManager.GetPublicFeedURLPath(), '/updates/client/latest/');
});

// --- GetStatus --------------------------------------------------------------

test('GetStatus reports not-ready with no manifest at all', async () => {
  const Status = await UpdateManager.GetStatus();
  assert.deepEqual(Status, {
    Ready: false,
    ReleaseVersion: null,
    ReleasedAt: null,
    DownloadedAt: null,
    Assets: [],
    FeedPath: '/updates/client/latest/',
  });
});

test('GetStatus reports ready when every listed asset is on disk', async () => {
  seedManifest({
    version: 'v3.14.0',
    releasedAt: '2026-07-01T00:00:00Z',
    downloadedAt: '2026-07-02T00:00:00Z',
    assets: [{ name: 'ShowTrakClient-Setup.exe', size: 1234 }],
  });

  const Status = await UpdateManager.GetStatus();
  assert.equal(Status.Ready, true);
  assert.equal(Status.ReleaseVersion, 'v3.14.0');
  assert.equal(Status.ReleasedAt, '2026-07-01T00:00:00Z');
  assert.deepEqual(Status.Assets, [
    {
      name: 'ShowTrakClient-Setup.exe',
      size: 1234,
      url: '/updates/client/latest/ShowTrakClient-Setup.exe',
    },
  ]);
});

test('GetStatus reports NOT ready when a listed asset is missing from disk', async () => {
  // A half-downloaded release must never be deployable; the registrar's
  // DeployRelease guard keys off exactly this flag.
  seedManifest(
    { version: 'v3.14.0', assets: [{ name: 'present.exe' }, { name: 'missing.exe' }] },
    { createFiles: false }
  );
  fs.writeFileSync(path.join(CacheDir, 'present.exe'), 'x');

  const Status = await UpdateManager.GetStatus();
  assert.equal(Status.Ready, false);
  // The version is still reported so the UI can say WHICH release is broken.
  assert.equal(Status.ReleaseVersion, 'v3.14.0');
});

test('GetStatus reports not ready for an empty asset list', async () => {
  seedManifest({ version: 'v3.14.0', assets: [] });
  assert.equal((await UpdateManager.GetStatus()).Ready, false);
});

test('a manifest containing an unusable asset entry reports not-ready, not a crash', async () => {
  // isManifestReady() guards each entry (`if (!asset || !asset.name) return false`);
  // buildPublicAssetList() used to map straight into `asset.name`, so a null
  // entry threw instead of producing that answer — the IPC handler turned the
  // throw into an error tuple and the public /status route 500'd.
  //
  // Not reachable from normal operation (DownloadRelease only ever writes
  // entries it built itself), so it takes a hand-edited or truncated
  // manifest.json to hit. Both now agree: unusable entries are dropped and the
  // manifest simply is not ready.
  for (const Assets of [[null], [undefined], [{}], [{ name: '' }]]) {
    seedManifest({ version: 'v3.14.0', assets: Assets }, { createFiles: false });

    const Status = await UpdateManager.GetStatus();
    assert.equal(Status.Ready, false, `assets ${JSON.stringify(Assets)}`);
    assert.deepEqual(Status.Assets, []);
    assert.equal(Status.ReleaseVersion, 'v3.14.0', 'the version should still be readable');
  }
});

test('a usable asset alongside an unusable one is still listed', async () => {
  seedManifest({ version: 'v3.14.0', assets: [null, { name: 'client.exe', size: 14 }] });

  const Status = await UpdateManager.GetStatus();
  assert.deepEqual(
    Status.Assets.map((A) => A.name),
    ['client.exe']
  );
});

test('GetStatus survives a corrupt manifest file', async () => {
  fs.mkdirSync(CacheDir, { recursive: true });
  fs.writeFileSync(ManifestPath, '{ not json', 'utf8');

  const Status = await UpdateManager.GetStatus();
  assert.equal(Status.Ready, false);
  assert.equal(Status.ReleaseVersion, null);
});

test('GetStatus rejects a manifest whose assets field is not an array', async () => {
  fs.mkdirSync(CacheDir, { recursive: true });
  fs.writeFileSync(ManifestPath, JSON.stringify({ version: 'v1', assets: 'nope' }), 'utf8');
  assert.equal((await UpdateManager.GetStatus()).ReleaseVersion, null);
});

test('GetStatus percent-encodes asset names in the public URL', async () => {
  seedManifest({ version: 'v1', assets: [{ name: 'Show Trak+Client.exe', size: 1 }] });
  const Status = await UpdateManager.GetStatus();
  assert.equal(Status.Assets[0].url, '/updates/client/latest/Show%20Trak%2BClient.exe');
});

// --- ListReleases -----------------------------------------------------------

test('ListReleases normalizes each release to the option shape', async () => {
  routes.set(RELEASES_URL, {
    statusCode: 200,
    body: JSON.stringify([
      {
        tag_name: 'v3.14.0',
        name: 'Release 3.14.0',
        published_at: '2026-07-01T00:00:00Z',
        prerelease: false,
      },
    ]),
  });

  assert.deepEqual(await UpdateManager.ListReleases(), [
    {
      tag: 'v3.14.0',
      name: 'Release 3.14.0',
      publishedAt: '2026-07-01T00:00:00Z',
      prerelease: false,
    },
  ]);
});

test('ListReleases drops drafts, tagless entries and builds below the minimum', async () => {
  // Clients older than 3.4.0 cannot LAN-update, so offering those builds would
  // give the operator a deployment that silently does nothing.
  routes.set(RELEASES_URL, {
    statusCode: 200,
    body: JSON.stringify([
      { tag_name: 'v3.14.0' },
      { tag_name: 'v3.4.0' }, // exactly the minimum: kept
      { tag_name: 'v3.3.9' }, // below: dropped
      { tag_name: 'v2.9.9' }, // below: dropped
      { tag_name: 'v3.15.0', draft: true }, // draft: dropped
      { tag_name: '' }, // tagless: dropped
      { name: 'no tag at all' }, // tagless: dropped
      { tag_name: 'not-a-version' }, // unparseable: dropped
      { tag_name: 'v3.14' }, // not a full triple: dropped
      null,
    ]),
  });

  assert.deepEqual(
    (await UpdateManager.ListReleases()).map((R) => R.tag),
    ['v3.14.0', 'v3.4.0']
  );
});

test('ListReleases keeps prereleases but flags them', async () => {
  routes.set(RELEASES_URL, {
    statusCode: 200,
    body: JSON.stringify([
      { tag_name: 'v3.15.0-beta.1' },
      { tag_name: 'v3.15.0', prerelease: true },
    ]),
  });
  const Releases = await UpdateManager.ListReleases();
  // The -beta.1 suffix is not a bare triple, so it does not survive the filter.
  assert.deepEqual(
    Releases.map((R) => R.tag),
    ['v3.15.0']
  );
  assert.equal(Releases[0].prerelease, true);
});

test('ListReleases returns [] when GitHub does not return an array', async () => {
  routes.set(RELEASES_URL, { statusCode: 200, body: JSON.stringify({ message: 'rate limited' }) });
  assert.deepEqual(await UpdateManager.ListReleases(), []);
});

test('ListReleases rejects on a non-200 response', async () => {
  routes.set(RELEASES_URL, { statusCode: 403, body: 'forbidden' });
  await assert.rejects(() => UpdateManager.ListReleases(), /GitHub API request failed: 403/);
});

test('ListReleases rejects on an unparseable body', async () => {
  routes.set(RELEASES_URL, { statusCode: 200, body: '{ not json' });
  await assert.rejects(() => UpdateManager.ListReleases(), /Failed to parse GitHub response/);
});

// --- DownloadRelease --------------------------------------------------------

test('DownloadRelease fetches the latest release when no tag is given', async () => {
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v3.14.0', assets: [asset('client.exe')] }),
  });

  const Result = await UpdateManager.DownloadRelease();
  assert.deepEqual(Result, {
    ReleaseVersion: 'v3.14.0',
    FeedPath: '/updates/client/latest/',
    AssetCount: 1,
  });
  assert.ok(requested.includes(LATEST_URL));
});

test('DownloadRelease fetches a specific tag and URL-encodes it', async () => {
  const Tag = 'v3.14.0';
  routes.set(`${BY_TAG_URL}${encodeURIComponent(Tag)}`, {
    statusCode: 200,
    body: JSON.stringify({ tag_name: Tag, assets: [asset('client.exe')] }),
  });

  const Result = await UpdateManager.DownloadRelease(Tag);
  assert.equal(Result.ReleaseVersion, Tag);
});

test('DownloadRelease writes the assets and a manifest that GetStatus calls ready', async () => {
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({
      tag_name: 'v3.14.0',
      published_at: '2026-07-01T00:00:00Z',
      assets: [asset('client.exe', 'exe-bytes'), asset('client.dmg', 'dmg-bytes')],
    }),
  });

  await UpdateManager.DownloadRelease();

  assert.equal(fs.readFileSync(path.join(CacheDir, 'client.exe'), 'utf8'), 'exe-bytes');
  assert.equal(fs.readFileSync(path.join(CacheDir, 'client.dmg'), 'utf8'), 'dmg-bytes');

  const Manifest = JSON.parse(fs.readFileSync(ManifestPath, 'utf8'));
  assert.equal(Manifest.version, 'v3.14.0');
  assert.equal(Manifest.releasedAt, '2026-07-01T00:00:00Z');
  assert.ok(Manifest.downloadedAt, 'downloadedAt should be stamped');
  // Sizes come from the file actually written, not from what GitHub claimed.
  assert.deepEqual(Manifest.assets, [
    { name: 'client.exe', size: Buffer.byteLength('exe-bytes') },
    { name: 'client.dmg', size: Buffer.byteLength('dmg-bytes') },
  ]);

  const Status = await UpdateManager.GetStatus();
  assert.equal(Status.Ready, true);
});

test('DownloadRelease leaves no .tmp files behind', async () => {
  // Assets are streamed to <name>.tmp and renamed on completion, so a partial
  // download can never be served as a real asset.
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v3.14.0', assets: [asset('client.exe')] }),
  });

  await UpdateManager.DownloadRelease();
  assert.deepEqual(
    fs.readdirSync(CacheDir).filter((F) => F.endsWith('.tmp')),
    []
  );
});

test('DownloadRelease sanitizes a hostile asset name into the cache directory', async () => {
  // The asset name comes from the GitHub release and becomes a filename. A path
  // separator or traversal here would write outside the cache.
  const Hostile = '../../../../tmp/pwned.exe';
  const Url = 'https://objects.githubusercontent.com/hostile';
  routes.set(Url, { statusCode: 200, body: 'x' });
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({
      tag_name: 'v3.14.0',
      assets: [{ name: Hostile, size: 1, browser_download_url: Url }],
    }),
  });

  await UpdateManager.DownloadRelease();

  const Manifest = JSON.parse(fs.readFileSync(ManifestPath, 'utf8'));
  // basename() strips the traversal; the scrub leaves only safe characters.
  assert.equal(Manifest.assets[0].name, 'pwned.exe');
  assert.ok(fs.existsSync(path.join(CacheDir, 'pwned.exe')));
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'pwned.exe')));
});

test('DownloadRelease scrubs shell and path characters out of asset names', async () => {
  const Url = 'https://objects.githubusercontent.com/odd';
  routes.set(Url, { statusCode: 200, body: 'x' });
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({
      tag_name: 'v3.14.0',
      assets: [{ name: 'Show Trak;rm -rf.exe', size: 1, browser_download_url: Url }],
    }),
  });

  await UpdateManager.DownloadRelease();
  const Manifest = JSON.parse(fs.readFileSync(ManifestPath, 'utf8'));
  assert.match(Manifest.assets[0].name, /^[A-Za-z0-9._-]+$/);
});

test('DownloadRelease prunes stale cache files but keeps the manifest', async () => {
  fs.mkdirSync(CacheDir, { recursive: true });
  fs.writeFileSync(path.join(CacheDir, 'old-release.exe'), 'stale');

  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v3.14.0', assets: [asset('client.exe')] }),
  });
  await UpdateManager.DownloadRelease();

  const Files = fs.readdirSync(CacheDir).sort();
  assert.deepEqual(Files, ['client.exe', 'manifest.json']);
});

test('DownloadRelease follows a redirect to the real asset host', async () => {
  // GitHub always 302s browser_download_url to an object store.
  const First = 'https://objects.githubusercontent.com/redirect-me';
  const Final = 'https://objects.githubusercontent.com/final-object';
  routes.set(First, { statusCode: 302, headers: { location: Final }, body: '' });
  routes.set(Final, { statusCode: 200, body: 'real-bytes' });
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({
      tag_name: 'v3.14.0',
      assets: [{ name: 'client.exe', size: 10, browser_download_url: First }],
    }),
  });

  await UpdateManager.DownloadRelease();
  assert.equal(fs.readFileSync(path.join(CacheDir, 'client.exe'), 'utf8'), 'real-bytes');
});

test('DownloadRelease fails on a failed asset download rather than writing a stub', async () => {
  const Url = 'https://objects.githubusercontent.com/gone';
  routes.set(Url, { statusCode: 404, body: 'nope' });
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({
      tag_name: 'v3.14.0',
      assets: [{ name: 'client.exe', size: 10, browser_download_url: Url }],
    }),
  });

  await assert.rejects(() => UpdateManager.DownloadRelease(), /Asset download failed \(404\)/);
  assert.ok(!fs.existsSync(path.join(CacheDir, 'client.exe')));
  // The previous manifest is untouched, so a working release stays deployable.
  assert.ok(!fs.existsSync(ManifestPath));
});

test('DownloadRelease rejects a release with no version or no assets', async () => {
  routes.set(LATEST_URL, { statusCode: 200, body: JSON.stringify({ assets: [asset('a.exe')] }) });
  await assert.rejects(() => UpdateManager.DownloadRelease(), /missing version/);

  routes.set(LATEST_URL, { statusCode: 200, body: JSON.stringify({ tag_name: 'v3.14.0' }) });
  await assert.rejects(() => UpdateManager.DownloadRelease(), /has no downloadable assets/);
});

test('DownloadRelease rejects when every asset lacks a download URL', async () => {
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v3.14.0', assets: [{ name: 'a.exe', size: 1 }] }),
  });
  await assert.rejects(() => UpdateManager.DownloadRelease(), /No release assets were downloaded/);
});

test('DownloadRelease reports monotonic progress ending at complete', async () => {
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({
      tag_name: 'v3.14.0',
      assets: [asset('a.exe', 'aaaa'), asset('b.exe', 'bbbb')],
    }),
  });

  const Progress = [];
  await UpdateManager.DownloadRelease(null, { onProgress: (P) => Progress.push(P) });

  assert.equal(Progress[0].phase, 'preparing');
  assert.equal(Progress.at(-1).phase, 'complete');
  assert.equal(Progress.at(-1).percent, 100);
  assert.match(Progress.at(-1).message, /Downloaded release v3\.14\.0/);
  for (const Entry of Progress) {
    assert.ok(Entry.percent >= 0 && Entry.percent <= 100, `percent out of range: ${Entry.percent}`);
    assert.equal(Number.isInteger(Entry.percent), true);
  }
});

test('a throwing progress callback never aborts the download', async () => {
  // Progress goes to a renderer that may have gone away mid-download.
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v3.14.0', assets: [asset('client.exe')] }),
  });

  const Result = await UpdateManager.DownloadRelease(null, {
    onProgress: () => {
      throw new Error('renderer gone');
    },
  });
  assert.equal(Result.AssetCount, 1);
  assert.ok(fs.existsSync(path.join(CacheDir, 'client.exe')));
});

test('DownloadLatestRelease delegates to DownloadRelease with no tag', async () => {
  routes.set(LATEST_URL, {
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v3.14.0', assets: [asset('client.exe')] }),
  });
  const Result = await UpdateManager.DownloadLatestRelease();
  assert.equal(Result.ReleaseVersion, 'v3.14.0');
  assert.ok(requested.includes(LATEST_URL));
});

// --- RegisterRoutes: the public LAN endpoint --------------------------------

/** Collect the handlers RegisterRoutes installs on a fake express app. */
function registerRoutes() {
  const Handlers = new Map();
  UpdateManager.RegisterRoutes({ get: (route, handler) => Handlers.set(route, handler) });
  return {
    status: Handlers.get('/updates/client/latest/status'),
    file: Handlers.get('/updates/client/latest/:fileName'),
  };
}

/** Minimal express response recorder. */
function fakeRes() {
  const Res = {
    statusCode: 200,
    jsonBody: null,
    sentFile: null,
    status(code) {
      Res.statusCode = code;
      return Res;
    },
    json(body) {
      Res.jsonBody = body;
      return Res;
    },
    sendFile(file) {
      Res.sentFile = file;
      return Res;
    },
  };
  return Res;
}

test('RegisterRoutes requires an express-like app', () => {
  assert.throws(() => UpdateManager.RegisterRoutes(null), /requires an express app/);
  assert.throws(() => UpdateManager.RegisterRoutes({}), /requires an express app/);
});

test('the status route returns the same payload as GetStatus', async () => {
  seedManifest({ version: 'v3.14.0', assets: [{ name: 'client.exe', size: 5 }] });
  const Routes = registerRoutes();
  const Res = fakeRes();

  await Routes.status({}, Res);
  assert.equal(Res.jsonBody.Ready, true);
  assert.equal(Res.jsonBody.ReleaseVersion, 'v3.14.0');
  assert.equal(Res.jsonBody.FeedPath, '/updates/client/latest/');
});

test('the file route serves an asset listed in the manifest', () => {
  seedManifest({ version: 'v3.14.0', assets: [{ name: 'client.exe', size: 5 }] });
  const Routes = registerRoutes();
  const Res = fakeRes();

  Routes.file({ params: { fileName: 'client.exe' } }, Res);
  assert.equal(Res.sentFile, path.join(CacheDir, 'client.exe'));
});

test('the file route refuses anything not in the manifest', () => {
  // This endpoint is reachable by anything on the LAN, so the manifest is an
  // allowlist: only files this server chose to download can ever be served.
  seedManifest({ version: 'v3.14.0', assets: [{ name: 'client.exe', size: 5 }] });
  fs.writeFileSync(path.join(CacheDir, 'secret.txt'), 'not for you');

  const Routes = registerRoutes();
  const Res = fakeRes();

  Routes.file({ params: { fileName: 'secret.txt' } }, Res);
  assert.equal(Res.statusCode, 404);
  assert.equal(Res.sentFile, null);
});

test('the file route strips path traversal before the allowlist check', () => {
  seedManifest({ version: 'v3.14.0', assets: [{ name: 'client.exe', size: 5 }] });
  const Routes = registerRoutes();

  for (const Hostile of [
    '../../../../etc/passwd',
    '..%2F..%2Fetc%2Fpasswd',
    '/etc/passwd',
    '../manifest.json',
  ]) {
    const Res = fakeRes();
    Routes.file({ params: { fileName: Hostile } }, Res);
    assert.equal(Res.sentFile, null, `served a traversal path: ${Hostile}`);
    assert.equal(Res.statusCode, 404);
  }
});

test('a directory-prefixed request collapses to the allowlisted file in the cache', () => {
  // basename() reduces "nested/client.exe" to "client.exe", which IS allowlisted,
  // so this serves the legitimate cached asset. That is safe rather than a
  // traversal: the resolved path is always <cache>/<basename>, and the manifest
  // allowlist still gates which basenames are reachable at all.
  seedManifest({ version: 'v3.14.0', assets: [{ name: 'client.exe', size: 5 }] });
  const Routes = registerRoutes();
  const Res = fakeRes();

  Routes.file({ params: { fileName: 'nested/client.exe' } }, Res);
  assert.equal(Res.sentFile, path.join(CacheDir, 'client.exe'));
});

test('the file route 404s an empty filename', () => {
  seedManifest({ version: 'v3.14.0', assets: [{ name: 'client.exe', size: 5 }] });
  const Routes = registerRoutes();

  for (const Empty of ['', null, undefined]) {
    const Res = fakeRes();
    Routes.file({ params: { fileName: Empty } }, Res);
    assert.equal(Res.statusCode, 404);
    assert.equal(Res.sentFile, null);
  }
});

test('the file route 404s a manifest entry whose file has been deleted', () => {
  // Allowlisted but gone from disk: report missing rather than handing express
  // a path that does not exist.
  seedManifest(
    { version: 'v3.14.0', assets: [{ name: 'client.exe', size: 5 }] },
    { createFiles: false }
  );
  const Routes = registerRoutes();
  const Res = fakeRes();

  Routes.file({ params: { fileName: 'client.exe' } }, Res);
  assert.equal(Res.statusCode, 404);
  assert.deepEqual(Res.jsonBody, { error: 'File not found' });
});

test('the file route serves nothing at all when there is no manifest', () => {
  const Routes = registerRoutes();
  const Res = fakeRes();
  Routes.file({ params: { fileName: 'client.exe' } }, Res);
  assert.equal(Res.statusCode, 404);
});
