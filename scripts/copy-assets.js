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

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

// Directories (relative to src/) copied wholesale into dist/.
// Keep this in sync with the `exclude` globs in tsconfig.json.
const ASSET_DIRECTORIES = ['UI', 'WebUI', 'images', 'icons'];

// Renderer TypeScript sources bundled by scripts/build-renderer.js (esbuild).
// Once a surface has a TS entry, esbuild owns its compiled output
// (dist/UI/js/app/bundle.js, dist/WebUI/main.js) and copy-assets must NOT ship
// the authored sources. Until the entry exists the legacy .js is copied verbatim
// so the app keeps running mid-migration. Each surface flips independently.
const DESKTOP_ENTRY = path.resolve(SRC_ROOT, 'UI', 'js', 'app', 'main.ts');

const skippedDirs = new Set();
const skippedFiles = new Set();
if (fs.existsSync(DESKTOP_ENTRY)) {
  skippedDirs.add(path.resolve(SRC_ROOT, 'UI', 'js', 'app'));
  skippedDirs.add(path.resolve(SRC_ROOT, 'UI', 'types'));
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (skippedDirs.has(path.resolve(srcDir))) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const source = path.join(srcDir, entry.name);
    const destination = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(source, destination);
    } else if (entry.isFile()) {
      // Never ship TypeScript sources; esbuild owns compiled bundles.
      if (entry.name.endsWith('.ts')) continue;
      if (skippedFiles.has(path.resolve(source))) continue;
      fs.copyFileSync(source, destination);
    }
  }
}

function main() {
  let copied = 0;
  for (const dir of ASSET_DIRECTORIES) {
    const source = path.join(SRC_ROOT, dir);
    const destination = path.join(DIST_ROOT, dir);
    if (fs.existsSync(source)) {
      copyDir(source, destination);
      copied += 1;
    }
  }
  console.log(
    `[copy-assets] Copied ${copied} static asset director${copied === 1 ? 'y' : 'ies'} into dist/`
  );
}

main();
