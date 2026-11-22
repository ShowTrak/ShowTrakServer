// Bundles the Electron main process into one file: dist/main.bundle.js, which
// dist/boot.js (src/boot.ts) loads. How, and why the input is tsc's CommonJS
// output rather than the sources, is shared/scripts/build-main.js (shared with
// ShowTrak Timers); the Server's part is what stays external.
//
// Loaded from node_modules at runtime rather than bundled: the native sqlite3
// addon, and electron-updater and mqtt, which are large and only ever required
// lazily, on first use (bundled, every launch would read and parse code most
// never run). Each must resolve from dist/; the build fails if one does not.
const path = require('node:path');
const { createMainBundle } = require('../shared/scripts/build-main');

const Bundle = createMainBundle({
  root: path.resolve(__dirname, '..'),
  requiredExternals: ['sqlite3', 'electron-updater', 'mqtt'],
});

module.exports = { mainBundleOptions: Bundle.mainBundleOptions, MAIN_BUNDLE: Bundle.MAIN_BUNDLE };

if (require.main === module) Bundle.main();
