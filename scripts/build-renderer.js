// Bundles the TypeScript browser-side sources with esbuild.
//
// The Node-side code is compiled by `tsc` (tsconfig.json) into dist/. The
// renderer runs in a browser/Electron-renderer context and is authored as ES
// modules that are bundled here into a single classic script per surface:
//   src/UI/js/app/main.ts      -> dist/UI/js/app/bundle.js   (Electron renderer)
//   src/UI/js/app/web-main.ts  -> dist/WebUI/main.js          (served Web UI)
//   src/UI/preloader.ts        -> dist/UI/preloader.js        (splash window)
//   src/WebUI/sw.ts            -> dist/WebUI/sw.js            (Web UI service worker)
//
// The first two bundle the SAME shared renderer modules; web-main.ts additionally
// installs the Socket.IO-backed `window.API` shim + capability profile. Each
// output keeps the path its page loads it from, so no markup changes.
//
// Type-checking is performed separately by `tsc --noEmit` against
// tsconfig.renderer.json, tsconfig.preloader.json and
// tsconfig.service-worker.json; esbuild only transpiles+bundles.
//
// Vendor libraries (jQuery, Bootstrap, Howler, socket.io) stay
// as external <script> globals for offline use, so they are NOT imported/bundled.
const esbuild = require('esbuild');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * `minify` and `keepNames` default to true (see bundleOptions).
 * @type {Array<{name: string, entry: string, outfile: string, minify?: boolean, keepNames?: boolean}>}
 */
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
  {
    name: 'Preloader',
    entry: path.join(ROOT, 'src', 'UI', 'preloader.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'preloader.js'),
  },
  {
    name: 'Web UI service worker',
    entry: path.join(ROOT, 'src', 'WebUI', 'sw.ts'),
    outfile: path.join(ROOT, 'dist', 'WebUI', 'sw.js'),
    // The worker embeds a function into its offline splash page as source text
    // (src/WebUI/offline-splash.ts), which the page then runs on its own.
    // keepNames would add calls to a bundle-level __name() helper inside that
    // function, which the page does not have. Unminified, as it always was: it
    // is a few KB, and readable in the browser's service worker inspector.
    minify: false,
    keepNames: false,
  },
];

// esbuild options for one bundle. Shared with scripts/dev.js, whose watch mode
// must produce exactly what a full build does.
function bundleOptions({ entry, outfile, minify = true, keepNames = true }) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    // Minified: the bundles were ~1 MB each, parsed on every launch and served
    // to every browser/phone opening the Web UI. The external source maps keep
    // stack traces and DevTools mapped to the TypeScript, and keepNames keeps
    // function/class names readable in error logs.
    minify,
    keepNames,
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info',
  };
}

async function buildBundle(bundle) {
  await esbuild.build(bundleOptions(bundle));
  console.log(`[build-renderer] Bundled ${bundle.name} -> ${path.relative(ROOT, bundle.outfile)}`);
}

async function main() {
  for (const bundle of BUNDLES) {
    await buildBundle(bundle);
  }
  console.log(`[build-renderer] Completed (${BUNDLES.length} bundles)`);
}

module.exports = { BUNDLES, bundleOptions };

if (require.main === module) {
  main().catch((err) => {
    console.error('[build-renderer] Failed:', err);
    process.exit(1);
  });
}
