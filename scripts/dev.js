// `npm start`: build once, then rebuild only what an edit touches, through
// shared/scripts/dev.js (shared with ShowTrak Timers):
//
//   main process (src/**/*.ts)    tsc --watch,    -> restart Electron
//                                 then the bundle (scripts/build-main.js)
//   renderer (src/UI/js/app),     esbuild watch   -> reload the window
//   splash script, service worker
//   markup / CSS / static assets  copy on change  -> reload the window
//   (src/UI)                      and rebuild the Web UI
//   shared code (shared/src)      build:shared    -> tsc and esbuild pick it up
//
// The window reload is done by the app itself (StartDevReload in main.ts) when
// it sees dist/UI change, so the main process, and everything connected to it,
// survives a renderer edit.
//
// `npm start -- --no-app` builds and watches without launching Electron, for when
// another instance already holds the app's single-instance lock.
//
// For a clean production build use `npm run build`.
const path = require('node:path');

require('../shared/scripts/dev').main({
  root: path.resolve(__dirname, '..'),
  renderer: require('./build-renderer'),
  rendererTsconfigs: [
    'tsconfig.renderer.json',
    'tsconfig.preloader.json',
    'tsconfig.service-worker.json',
  ],
  assetDirs: ['src/UI'],
  assetScripts: ['copy-assets.js', 'build-webui.js'],
});
