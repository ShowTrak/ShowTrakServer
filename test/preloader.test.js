const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Covers the splash (preloader) window's page script, src/UI/preloader.ts,
// through the bundle the window actually loads: preloader.html asks for
// ./preloader.js, which esbuild writes to dist/UI/preloader.js. It runs here in
// a vm context holding a stub of the splash bridge (src/bridge_preloader.ts)
// and the one element the script writes to.

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'dist', 'UI', 'preloader.js');

async function footerFor(Config) {
  const footer = { innerText: '' };
  const context = vm.createContext({
    window: { API: { GetConfig: async () => Config } },
    document: { getElementById: (id) => (id === 'FOOTER' ? footer : null) },
  });
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, { filename: BUNDLE });
  await new Promise((resolve) => setImmediate(resolve));
  return footer.innerText;
}

test('the splash footer shows the app name and version from the bridge', async () => {
  const text = await footerFor({
    Application: { Name: 'ShowTrak Server', Version: '3.36.1', Port: 3000, IsPackaged: true },
    Shared: { Version: '0.1.0' },
  });
  assert.equal(text, 'ShowTrak Server v3.36.1');
});

test('the splash footer falls back to the plain name without a full config', async () => {
  assert.equal(await footerFor(null), 'ShowTrak Server');
  assert.equal(await footerFor({}), 'ShowTrak Server');
  assert.equal(await footerFor({ Application: { Name: 'ShowTrak Server' } }), 'ShowTrak Server');
  assert.equal(await footerFor({ Application: { Version: '3.36.1' } }), 'ShowTrak Server');
});

test('the splash page loads the bundled script, and no JavaScript copy is left in src', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'UI', 'preloader.html'), 'utf8');
  assert.match(html, /<script src="\.\/preloader\.js"><\/script>/);
  assert.ok(fs.existsSync(BUNDLE));
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'UI', 'preloader.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'WebUI', 'sw.js')), false);
  // The served copies are esbuild's, not files copied over them (scripts/copy-assets.js).
  assert.match(fs.readFileSync(BUNDLE, 'utf8'), /sourceMappingURL=preloader\.js\.map/);
  const worker = fs.readFileSync(path.join(ROOT, 'dist', 'WebUI', 'sw.js'), 'utf8');
  assert.match(worker, /sourceMappingURL=sw\.js\.map/);
});
