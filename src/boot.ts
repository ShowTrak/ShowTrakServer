// Electron entry point (package.json "main"): prepares the process, then loads
// the main process, which ships as one esbuild bundle (scripts/build-main.js;
// the composition root is ./main.ts).
//
// This is a separate file because V8's compile cache only covers modules loaded
// after it is enabled. Enabled from inside the bundle, the bundle itself (the
// whole main process) would be parsed from scratch on every launch.

// Size libuv's thread pool before anything queues work on it: the pool is
// created on first use and reads the size then. DNS lookups for monitoring
// probes run on it alongside file I/O, zlib and crypto; at the default of 4, a
// few slow lookups to an unresponsive resolver stall all of it. An operator's
// own setting wins.
process.env.UV_THREADPOOL_SIZE ||= '16';

const { app } = require('electron/main');
// Cache V8's compiled code for the bundle (keyed by file content, so an update
// invalidates it). Best-effort: startup never depends on it.
try {
  require('node:module').enableCompileCache?.(
    require('node:path').join(app.getPath('userData'), 'compile-cache')
  );
} catch {
  /* intentional: an unavailable cache only costs the speed-up */
}

require('./main.bundle.js');
