const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Covers forge.config.ts through Electron Forge's own config loader, the one
// `electron-forge package` and `make` use: it finds forge.config.ts, loads it
// with jiti and resolves the plugins. The hooks are then run against temporary
// staged-app trees.

const ROOT = path.join(__dirname, '..');
// @electron-forge/core only exports its API entry point, so the loader module is
// imported by path.
const LOADER = path.join(
  ROOT,
  'node_modules',
  '@electron-forge',
  'core',
  'dist',
  'util',
  'forge-config.js'
);

let loaded = null;
function loadForgeConfig() {
  if (!loaded) {
    // Signing is configured from the environment; these tests cover an
    // unsigned build.
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('APPLE_')) delete process.env[name];
    }
    loaded = import(pathToFileURL(LOADER).href).then((loader) => loader.default(ROOT));
  }
  return loaded;
}

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-forge-'));
  for (const file of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

async function runHook(name, buildPath) {
  const config = await loadForgeConfig();
  return config.hooks[name](config, buildPath, '45.3.3', process.platform, process.arch);
}

test('Forge finds the TypeScript config, and no JavaScript one in front of it', () => {
  // Forge tries forge.config.js before forge.config.ts.
  assert.ok(fs.existsSync(path.join(ROOT, 'forge.config.ts')));
  for (const ext of ['.js', '.mjs', '.cjs']) {
    assert.equal(fs.existsSync(path.join(ROOT, `forge.config${ext}`)), false, ext);
  }
});

test("Forge's loader resolves every maker, plugin and hook", async () => {
  const config = await loadForgeConfig();

  assert.deepEqual(
    config.makers.map((maker) => [maker.name, [...maker.platforms]]),
    [
      ['@electron-forge/maker-squirrel', ['win32']],
      ['@electron-forge/maker-zip', ['darwin']],
      ['@electron-forge/maker-zip', ['linux']],
      ['@electron-forge/maker-deb', ['linux']],
      ['@electron-forge/maker-rpm', ['linux']],
    ]
  );
  assert.equal(config.makers[0].config.setupIcon, './src/images/icon.ico');
  assert.equal(config.makers[3].config.options.bin, 'showtrak-server');

  assert.deepEqual(
    config.plugins.map((plugin) => plugin.name),
    ['@electron-forge/plugin-auto-unpack-natives', 'fuses']
  );
  for (const hook of ['packageAfterExtract', 'packageAfterPrune', 'packageAfterCopy']) {
    assert.equal(typeof config.hooks[hook], 'function', hook);
  }

  const packager = config.packagerConfig;
  assert.ok(packager.asar);
  assert.equal(packager.derefSymlinks, true);
  assert.equal(packager.executableName, 'showtrak-server');
  assert.equal(packager.icon, './src/images/icon');
  assert.match(packager.extendInfo.NSLocalNetworkUsageDescription, /local network access/);
  assert.equal(packager.osxSign, undefined, 'unsigned without APPLE_SIGN_IDENTITY');
  assert.equal(packager.osxNotarize, undefined);
});

test('the packager leaves sources, configs and per-file output out of the app', async () => {
  const { packagerConfig } = await loadForgeConfig();
  const ignored = (file) => packagerConfig.ignore.some((pattern) => pattern.test(file));
  for (const file of [
    '/forge.config.ts',
    '/eslint.config.ts',
    '/tsconfig.tooling.json',
    '/tsconfig.service-worker.json',
    '/src/UI/preloader.ts',
    '/src/WebUI/sw.ts',
    '/dist/main.js',
    '/dist/Modules/DB/index.js',
    '/dist/WebUI/sw.js.map',
    '/scripts/build-main.js',
    '/shared/scripts/trim-electron-locales.js',
    '/node_modules/@showtrak/protocol/src/index.d.ts',
    '/node_modules/@showtrak/protocol/src/ui/toasts.ts',
    '/node_modules/@showtrak/protocol/scripts/dev.js',
    '/node_modules/@showtrak/protocol/spec/ui/toasts.spec.js',
    '/out',
    '/out/make/zip/darwin/arm64/ShowTrak Server.zip',
  ]) {
    assert.equal(ignored(file), true, `${file} should be left out`);
  }
  for (const file of [
    '/package.json',
    '/dist/boot.js',
    '/dist/main.bundle.js',
    '/dist/bridge_preloader.js',
    '/dist/UI/preloader.js',
    '/dist/WebUI/sw.js',
    '/node_modules/@showtrak/protocol/package.json',
    '/node_modules/@showtrak/protocol/dist/runtime/index.js',
  ]) {
    assert.equal(ignored(file), false, `${file} should ship`);
  }
});

test('packageAfterExtract drops every Chromium locale pack but the English ones', async (t) => {
  const build = tempTree([
    'locales/en-US.pak',
    'locales/en-GB.pak',
    'locales/de.pak',
    'locales/fr.pak',
  ]);
  const log = t.mock.method(console, 'log', () => {});
  await runHook('packageAfterExtract', build);
  assert.deepEqual(listTree(build), ['locales/en-GB.pak', 'locales/en-US.pak']);
  assert.deepEqual(log.mock.calls.at(-1).arguments, [
    '[forge] Removed 2 unused Chromium locale pack(s)',
  ]);
});

test('packageAfterPrune keeps only the addon of a compiled sqlite3', async () => {
  const build = tempTree([
    'node_modules/sqlite3/package.json',
    'node_modules/sqlite3/lib/sqlite3.js',
    'node_modules/sqlite3/bin/node_sqlite3.node',
    'node_modules/sqlite3/build/Makefile',
    'node_modules/sqlite3/build/deps/sqlite3.c',
    'node_modules/sqlite3/build/Release/node_sqlite3.node',
    'node_modules/sqlite3/build/Release/obj/database.o',
    'node_modules/sqlite3/build/Release/test_extension.node',
  ]);
  await runHook('packageAfterPrune', build);
  assert.deepEqual(listTree(build), [
    'node_modules/sqlite3/build/Release/node_sqlite3.node',
    'node_modules/sqlite3/lib/sqlite3.js',
    'node_modules/sqlite3/package.json',
  ]);
});

test('packageAfterPrune leaves a downloaded sqlite3 binary alone', async () => {
  const files = [
    'node_modules/sqlite3/package.json',
    'node_modules/sqlite3/lib/binding/napi-v6-darwin-unknown-arm64/node_sqlite3.node',
  ];
  const build = tempTree(files);
  await runHook('packageAfterPrune', build);
  assert.deepEqual(listTree(build), [...files].sort());
});

const STAGED_APP = [
  'package.json',
  'dist/boot.js',
  'dist/main.bundle.js',
  'node_modules/@showtrak/protocol/package.json',
  'node_modules/@showtrak/protocol/dist/runtime/index.js',
];

test('packageAfterCopy accepts a complete staged app', async () => {
  await runHook('packageAfterCopy', tempTree(STAGED_APP));
});

test('packageAfterCopy refuses a staged app the protocol package or the bundle is missing from', async () => {
  const without = (missing) => tempTree(STAGED_APP.filter((file) => !file.startsWith(missing)));
  await assert.rejects(
    runHook('packageAfterCopy', without('node_modules/@showtrak/protocol/')),
    /protocol is missing\. The @showtrak\/protocol dependency must be dereferenced/
  );
  await assert.rejects(
    runHook('packageAfterCopy', without('node_modules/@showtrak/protocol/dist/')),
    /index\.js is missing from the staged app\. require\("@showtrak\/protocol\/runtime"\) would throw/
  );
  await assert.rejects(
    runHook('packageAfterCopy', without('dist/main.bundle.js')),
    /main\.bundle\.js is missing from the staged app\. Run `npm run build`/
  );
});

test('packageAfterCopy refuses a protocol package that is still a link', async () => {
  const real = tempTree(['package.json', 'dist/runtime/index.js']);
  const build = tempTree(STAGED_APP.filter((file) => !file.startsWith('node_modules/')));
  fs.mkdirSync(path.join(build, 'node_modules', '@showtrak'), { recursive: true });
  // A junction on Windows, as npm makes one there (no privilege needed); a
  // symlink elsewhere.
  fs.symlinkSync(real, path.join(build, 'node_modules', '@showtrak', 'protocol'), 'junction');
  await assert.rejects(runHook('packageAfterCopy', build), /is a link, not a real directory/);
});
