// Copies static runtime assets that TypeScript does NOT compile into the dist/ output
// so that __dirname-relative paths in the compiled main process resolve identically
// to the original src/ layout.
//
// TypeScript (tsconfig.json) compiles the Node-side code (src/Modules, src/main,
// src/main.js, src/bridge_*.js) into dist/. The renderer UI, the served Web UI, and
// image/icon assets are intentionally excluded from compilation and must be copied
// verbatim so the packaged app keeps working exactly as before.
const fs = require('node:fs');
const path = require('node:path');
const { copyDir } = require('./lib/copy-dir');

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

function main() {
  let copied = 0;
  for (const dir of ASSET_DIRECTORIES) {
    const source = path.join(SRC_ROOT, dir);
    const destination = path.join(DIST_ROOT, dir);
    if (fs.existsSync(source)) {
      copyDir(source, destination, { skipDirs });
      copied += 1;
    }
  }
  console.log(
    `[copy-assets] Copied ${copied} static asset director${copied === 1 ? 'y' : 'ies'} into dist/`
  );
}

main();
