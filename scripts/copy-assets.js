// Copies the static runtime assets TypeScript does NOT compile (the renderer
// UI, the served Web UI, images and icons) into dist/, through
// shared/scripts/copy-assets.js (shared with ShowTrak Timers), skipping the
// renderer sources and anything that would land on an esbuild output.
const path = require('node:path');
const { BUNDLES } = require('./build-renderer');
const { createAssetCopy } = require('../shared/scripts/copy-assets');

const Assets = createAssetCopy({
  root: path.resolve(__dirname, '..'),
  // Directories under src/ copied wholesale into dist/. Keep this in sync with
  // the `exclude` globs in tsconfig.json.
  directories: ['UI', 'WebUI', 'images', 'icons'],
  bundles: BUNDLES,
});

if (require.main === module) Assets.main();
