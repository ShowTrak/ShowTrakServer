// Copies static runtime assets that TypeScript does NOT compile into the dist/ output
// so that __dirname-relative paths in the compiled main process resolve identically
// to the original src/ layout.
//
// TypeScript (tsconfig.json) compiles the Node-side code (src/Modules, src/main,
// src/main.ts, src/bridge_*.ts) into dist/. The renderer UI, the served Web UI, and
// image/icon assets are intentionally excluded from compilation and must be copied
// verbatim so the packaged app keeps working exactly as before.
const fs = require('node:fs');
const path = require('node:path');
const { copyDir } = require('./lib/copy-dir');
const { BUNDLES } = require('./build-renderer');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

// Directories (relative to src/) copied wholesale into dist/.
// Keep this in sync with the `exclude` globs in tsconfig.json.
const ASSET_DIRECTORIES = ['UI', 'WebUI', 'images', 'icons'];

// The renderer TypeScript sources are bundled by scripts/build-renderer.js
// (esbuild owns dist/UI/js/app/bundle.js). Skip those source dirs entirely so
// copy-assets never ships them or creates empty mirror folders. Individual `.ts`
// files are also skipped by copyDir, but skipping the dirs avoids empty output.
const skipDirs = new Set([
  path.resolve(SRC_ROOT, 'UI', 'js', 'app'),
  path.resolve(SRC_ROOT, 'UI', 'types'),
]);

// Nothing copied from src/ may land on an esbuild output. The splash window's
// script (dist/UI/preloader.js) and the Web UI service worker (dist/WebUI/sw.js)
// were plain JavaScript under src/ until they became TypeScript; a leftover copy
// of either (an older checkout's file, never deleted) would otherwise be copied
// over the freshly bundled script, since this step runs after the bundling.
const skipFiles = new Set(
  BUNDLES.map((bundle) => path.resolve(SRC_ROOT, path.relative(DIST_ROOT, bundle.outfile)))
);

function main() {
  let copied = 0;
  for (const dir of ASSET_DIRECTORIES) {
    const source = path.join(SRC_ROOT, dir);
    const destination = path.join(DIST_ROOT, dir);
    if (fs.existsSync(source)) {
      copyDir(source, destination, { skipDirs, skipFiles });
      copied += 1;
    }
  }
  console.log(
    `[copy-assets] Copied ${copied} static asset director${copied === 1 ? 'y' : 'ies'} into dist/`
  );
}

main();
