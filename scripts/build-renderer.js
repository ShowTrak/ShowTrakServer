// Bundles the TypeScript browser-side sources with esbuild, through
// shared/scripts/build-renderer.js (shared with ShowTrak Timers). The surfaces,
// each bundled to the path its page loads it from:
//   src/UI/js/app/main.ts      -> dist/UI/js/app/bundle.js   (Electron renderer)
//   src/UI/js/app/web-main.ts  -> dist/WebUI/main.js          (served Web UI)
//   src/UI/preloader.ts        -> dist/UI/preloader.js        (splash window)
//   src/WebUI/sw.ts            -> dist/WebUI/sw.js            (Web UI service worker)
//
// The first two bundle the SAME renderer modules; web-main.ts additionally
// installs the Socket.IO-backed `window.API` shim + capability profile.
// Type-checking is done separately (tsconfig.renderer.json,
// tsconfig.preloader.json, tsconfig.service-worker.json); esbuild only
// transpiles and bundles. Vendor libraries (jQuery, Bootstrap, Howler,
// socket.io) stay external <script> globals for offline use.
const path = require('node:path');
const Renderer = require('../shared/scripts/build-renderer');

const ROOT = path.resolve(__dirname, '..');

/**
 * `minify` and `keepNames` default to true.
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

// esbuild options for one bundle. Also used by scripts/dev.js, whose watch mode
// must produce exactly what a full build does.
function bundleOptions(bundle) {
  return Renderer.rendererBundleOptions(bundle, { root: ROOT });
}

module.exports = { BUNDLES, bundleOptions };

if (require.main === module) Renderer.main({ root: ROOT, bundles: BUNDLES });
