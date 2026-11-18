// The built app's root folder (dist/), for main-process code that reads the
// assets built next to it (dist/UI, dist/WebUI).
//
// The app runs the main process as a single esbuild bundle, dist/main.bundle.js
// (scripts/build-main.js), so every module's __dirname there is dist/ itself.
// The per-file tsc build that the test suite loads keeps each module in its own
// folder, this one at dist/Modules/Config. A path written relative to a
// module's own __dirname would be right in only one of the two; this is right
// in both. The bundle defines __SHOWTRAK_BUNDLED__ as true.
import path from 'path';

declare const __SHOWTRAK_BUNDLED__: boolean | undefined;

export const DIST_ROOT: string =
  typeof __SHOWTRAK_BUNDLED__ !== 'undefined' && __SHOWTRAK_BUNDLED__
    ? __dirname
    : path.join(__dirname, '..', '..');
