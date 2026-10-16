// `npm start`: build once, then rebuild only what an edit touches.
//
// The old loop ran the whole production build (clean, two full tsc programs,
// both bundles, CSS, every asset, the Web UI) and restarted Electron on every
// save, so a one-line CSS change dropped every connected client and the open
// show's live state. Here each kind of source has its own incremental watcher:
//
//   main process (src/**/*.ts)    tsc --watch     -> restart Electron
//   renderer (src/UI/js/app)      esbuild watch   -> reload the window
//   markup / CSS / static assets  copy on change  -> reload the window
//   protocol runtime (shared/)    build:shared    -> tsc picks it up
//
// The window reload is done by the app itself (src/main/dev-reload.ts) when it
// sees dist/UI change, so the main process, and everything connected to it,
// survives a renderer edit. Renderer type errors are reported by a --noEmit
// watcher but never block a reload; CI and the pre-commit hook enforce them.
//
// `npm start -- --no-app` builds and watches without launching Electron, for when
// another instance already holds the app's single-instance lock.
//
// For a clean production build use `npm run build`.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { BUNDLES, bundleOptions } = require('./build-renderer');

const ROOT = path.resolve(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NO_APP = process.argv.includes('--no-app');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function log(message) {
  console.log(`[dev] ${message}`);
}

function runScript(script) {
  return spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: ROOT,
    stdio: 'inherit',
  }).status;
}

// Coalesce bursts of file events (an editor save is often several) into one run.
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

// --- Electron ---------------------------------------------------------------

let electron = null;
let restarting = false;
let shuttingDown = false;

function startElectron() {
  if (NO_APP) return;
  // This shell may export ELECTRON_RUN_AS_NODE, which would run the app as
  // plain Node with no window at all.
  const env = { ...process.env, SHOWTRAK_DEV_RELOAD: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(require('electron'), ['.'], { cwd: ROOT, stdio: 'inherit', env });
  electron.on('exit', (code) => {
    electron = null;
    if (restarting || shuttingDown) return;
    // The operator quit the app: end the session, as electron-forge start did.
    log(`Electron exited (${code == null ? 'signal' : code}); stopping.`);
    shutdown(0);
  });
}

function restartElectron() {
  if (NO_APP) return;
  if (!electron) {
    startElectron();
    return;
  }
  restarting = true;
  const old = electron;
  const kill = setTimeout(() => old.kill('SIGKILL'), 5000);
  old.once('exit', () => {
    clearTimeout(kill);
    restarting = false;
    startElectron();
  });
  old.kill('SIGTERM');
}

// --- Watchers ---------------------------------------------------------------

const children = [];

// Resolves after tsc's first pass, so Electron never starts while that pass is
// still rewriting dist/.
function watchMainProcess() {
  let firstPass;
  const ready = new Promise((resolve) => {
    firstPass = resolve;
  });
  const child = spawn(
    process.execPath,
    [TSC, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  children.push(child);
  let initial = true;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    for (const line of text.split(/\r?\n/)) if (line.trim()) console.log(`[tsc] ${line}`);
    const match = /Found (\d+) errors?\. Watching for file changes/.exec(text);
    if (!match) return;
    if (initial) {
      // The first pass only re-confirms the full build that already ran.
      initial = false;
      firstPass();
      return;
    }
    if (match[1] === '0') {
      log('Main process rebuilt; restarting Electron.');
      restartElectron();
    } else {
      log('Main process has type errors; keeping the running app.');
    }
  });
  return ready;
}

function watchRendererTypes() {
  const child = spawn(
    process.execPath,
    [TSC, '-p', 'tsconfig.renderer.json', '--noEmit', '--watch', '--preserveWatchOutput'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  children.push(child);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    // Only surface problems; a clean pass is the normal case and is noise.
    if (!/error TS|Found [1-9]\d* errors?/.test(text)) return;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) console.log(`[renderer-types] ${line}`);
    }
  });
}

async function watchRendererBundles() {
  const contexts = [];
  for (const bundle of BUNDLES) {
    const ctx = await esbuild.context({ ...bundleOptions(bundle), logLevel: 'warning' });
    await ctx.watch();
    contexts.push(ctx);
  }
  return contexts;
}

// Markup, CSS parts and static assets: copy into dist, which the app's own
// watcher turns into a reload. The Web UI is rebuilt alongside since it derives
// from the same markup and assets.
function watchStaticAssets() {
  const ui = path.join(ROOT, 'src', 'UI');
  let cssDirty = false;
  const sync = debounce(() => {
    if (cssDirty) {
      cssDirty = false;
      runScript('build-css.js');
    }
    runScript('copy-assets.js');
    runScript('build-webui.js');
  }, 150);
  return fs.watch(ui, { recursive: true }, (_event, file) => {
    if (!file) return;
    const rel = file.split(path.sep).join('/');
    // Bundled by esbuild above, or written by build-css itself.
    if (rel.startsWith('js/app/') || rel === 'css/main.css' || rel.endsWith('.ts')) return;
    if (rel.startsWith('css/parts/')) cssDirty = true;
    sync();
  });
}

function watchProtocolRuntime() {
  const runtime = path.join(ROOT, 'shared', 'src', 'runtime');
  if (!fs.existsSync(runtime)) return null;
  const rebuild = debounce(() => {
    log('Protocol runtime changed; rebuilding shared/.');
    spawnSync(NPM, ['run', 'build:shared'], { cwd: ROOT, stdio: 'inherit', shell: true });
  }, 150);
  return fs.watch(runtime, { recursive: true }, rebuild);
}

// --- Lifecycle --------------------------------------------------------------

let esbuildContexts = [];
const fsWatchers = [];

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const watcher of fsWatchers) watcher.close();
  for (const ctx of esbuildContexts) void ctx.dispose();
  for (const child of children) child.kill();
  if (electron) electron.kill('SIGTERM');
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  log('Full build…');
  const built = spawnSync(NPM, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (built.status !== 0) {
    log('Initial build failed; fix the errors above and run `npm start` again.');
    process.exit(built.status || 1);
  }

  const mainReady = watchMainProcess();
  watchRendererTypes();
  esbuildContexts = await watchRendererBundles();
  fsWatchers.push(watchStaticAssets());
  const protocol = watchProtocolRuntime();
  if (protocol) fsWatchers.push(protocol);

  await mainReady;
  startElectron();
  log(
    NO_APP
      ? 'Watching (--no-app: nothing is launched).'
      : 'Watching. Renderer edits reload the window; main-process edits restart the app.'
  );
}

main().catch((err) => {
  console.error('[dev] Failed:', err);
  shutdown(1);
});
