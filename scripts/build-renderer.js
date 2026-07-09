// Bundles the TypeScript renderer sources (desktop UI + Web UI) with esbuild.
//
// The Node-side code is compiled by `tsc` (tsconfig.json) into dist/. The
// renderer runs in a browser/Electron-renderer context and is authored as ES
// modules that are bundled here into a single classic script per surface:
//   src/UI/js/app/main.ts      -> dist/UI/js/app/bundle.js   (Electron renderer)
//   src/UI/js/app/web-main.ts  -> dist/WebUI/main.js          (served Web UI)
//
// Both entries bundle the SAME shared renderer modules; web-main.ts additionally
// installs the Socket.IO-backed `window.API` shim + capability profile.
//
// Type-checking is performed separately by `tsc --noEmit` against
// tsconfig.renderer.json; esbuild only transpiles+bundles.
//
// Vendor libraries (jQuery, Bootstrap, Toastify, Howler, QRCode, socket.io) stay
// as external <script> globals for offline use, so they are NOT imported/bundled.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** @type {Array<{name: string, entry: string, outfile: string}>} */
const BUNDLES = [
  {
    name: 'Desktop UI',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'main.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'bundle.js'),
  },
  {
    name: 'Web UI',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'web-main.ts'),
    outfile: path.join(ROOT, 'dist', 'WebUI', 'main.js'),
  },
];

async function buildBundle({ name, entry, outfile }) {
  if (!fs.existsSync(entry)) {
    // Entry not migrated to TypeScript yet; copy-assets still ships the .js.
    console.log(`[build-renderer] Skipping ${name} (no TS entry at ${path.relative(ROOT, entry)})`);
    return false;
  }
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info',
  });
  console.log(`[build-renderer] Bundled ${name} -> ${path.relative(ROOT, outfile)}`);
  return true;
}

async function main() {
  let built = 0;
  for (const bundle of BUNDLES) {
    if (await buildBundle(bundle)) built += 1;
  }
  console.log(`[build-renderer] Completed (${built} bundle${built === 1 ? '' : 's'})`);
}

main().catch((err) => {
  console.error('[build-renderer] Failed:', err);
  process.exit(1);
});
