const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('../test-support/load-with-mocks');

// Exercises the execution half of src/main/local-scripts.ts.
//
// local-scripts.test.js covers the pure helpers (containment, path and version
// normalising, argument splitting). This covers what was left: choosing HOW to
// launch a file, and actually running it — previously 0%, and the part that
// touches the host OS.
//
// A "local script" runs on the ShowTrak Server machine itself, triggered from
// the script manager. So the launcher table is what decides whether a .ps1 runs
// through PowerShell or is handed to cmd as an opaque file, and the run wrapper
// decides what the operator is told when it fails. A script that silently
// "succeeds" while having done nothing is the failure that matters here.

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'local-scripts.js');

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

/**
 * Load local-scripts with a scripted OS, and KEEP that OS in place.
 *
 * The platform must stay forced for the duration of the test, not just the
 * load: resolveLocalScriptLauncher reads `process.platform` when it is CALLED.
 * Restoring it straight after require made every Windows assertion run against
 * the host's own table — and one of them still passed, because `.exe` happens
 * to hit the same "run it directly" default on POSIX. That is a false pass of
 * exactly the kind that made the Client's recovery suite green on macOS while
 * being broken everywhere else, so it is worth naming here.
 *
 * `test.afterEach` puts the real platform back.
 */
function load({ platform = process.platform, exec, chmodThrows = false } = {}) {
  const Calls = { exec: [], chmod: [] };

  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  const Mod = loadWithMocks(MODULE_PATH, {
    '../Modules/Logger': loggerStub,
    path: require('node:path'),
    fs: {
      chmodSync: (Target, Mode) => {
        Calls.chmod.push([Target, Mode]);
        if (chmodThrows) throw new Error('EROFS: read-only file system');
      },
    },
    child_process: {
      execFile: (Command, Args, Options, Callback) => {
        Calls.exec.push({ Command, Args, Options });
        const Result = exec ? exec(Command, Args) : { error: null, stdout: '', stderr: '' };
        setImmediate(() => Callback(Result.error, Result.stdout || '', Result.stderr || ''));
      },
    },
  });

  return { Mod, calls: Calls };
}

test.afterEach(() => {
  if (REAL_PLATFORM) Object.defineProperty(process, 'platform', REAL_PLATFORM);
});

// --- Launcher resolution ----------------------------------------------------

test('Windows scripts are handed to the right interpreter', () => {
  const { Mod } = load({ platform: 'win32' });
  const Resolve = Mod.resolveLocalScriptLauncher;

  assert.deepEqual(Resolve('C:\\s\\run.bat'), {
    command: 'cmd.exe',
    args: ['/c', 'C:\\s\\run.bat'],
  });
  assert.deepEqual(Resolve('C:\\s\\run.cmd'), {
    command: 'cmd.exe',
    args: ['/c', 'C:\\s\\run.cmd'],
  });

  // -ExecutionPolicy Bypass is the point: the default policy blocks unsigned
  // scripts outright, so without it every .ps1 an operator writes would fail.
  const Ps = Resolve('C:\\s\\run.ps1');
  assert.equal(Ps.command, 'powershell.exe');
  assert.deepEqual(Ps.args, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\s\\run.ps1',
  ]);
});

test('a Windows executable is run directly, not through a shell', () => {
  // Wrapping an .exe in `cmd /c` would break its exit code and argument
  // handling.
  //
  // Asserted alongside a .bat in the same load, because "run it directly" is
  // ALSO the POSIX default — on its own this assertion passes even when the
  // platform is not actually win32, and would prove nothing.
  const { Mod } = load({ platform: 'win32' });

  assert.deepEqual(Mod.resolveLocalScriptLauncher('C:\\s\\tool.exe'), {
    command: 'C:\\s\\tool.exe',
    args: [],
  });
  assert.equal(
    Mod.resolveLocalScriptLauncher('C:\\s\\run.bat').command,
    'cmd.exe',
    'this load is not on the Windows branch at all'
  );
});

test('an unknown Windows extension falls back to cmd', () => {
  // cmd honours the file association, which is the closest thing to "just open
  // it" that still reports an exit code.
  const { Mod } = load({ platform: 'win32' });
  assert.deepEqual(Mod.resolveLocalScriptLauncher('C:\\s\\thing.vbs'), {
    command: 'cmd.exe',
    args: ['/c', 'C:\\s\\thing.vbs'],
  });
});

test('POSIX shells are chosen per extension', () => {
  // .sh gets /bin/sh and .bash gets /bin/bash deliberately: bashisms in a file
  // the author named .bash must not be run by a stricter shell.
  for (const Platform of ['darwin', 'linux']) {
    const { Mod } = load({ platform: Platform });
    const Resolve = Mod.resolveLocalScriptLauncher;

    assert.deepEqual(Resolve('/s/run.sh'), { command: '/bin/sh', args: ['/s/run.sh'] });
    assert.deepEqual(Resolve('/s/run.command'), { command: '/bin/sh', args: ['/s/run.command'] });
    assert.deepEqual(Resolve('/s/run.bash'), { command: '/bin/bash', args: ['/s/run.bash'] });
    assert.deepEqual(Resolve('/s/run.zsh'), { command: '/bin/bash', args: ['/s/run.zsh'] });
  }
});

test('python and node scripts get their own runtimes', () => {
  const { Mod } = load({ platform: 'darwin' });
  assert.deepEqual(Mod.resolveLocalScriptLauncher('/s/run.py'), {
    command: 'python3',
    args: ['/s/run.py'],
  });
  assert.deepEqual(Mod.resolveLocalScriptLauncher('/s/run.js'), {
    command: 'node',
    args: ['/s/run.js'],
  });
});

test('an extensionless or unknown POSIX file is executed directly', () => {
  // Relies on the shebang, which is why the executable bit is set below.
  const { Mod } = load({ platform: 'linux' });
  assert.deepEqual(Mod.resolveLocalScriptLauncher('/s/run'), { command: '/s/run', args: [] });
  assert.deepEqual(Mod.resolveLocalScriptLauncher('/s/run.pl'), { command: '/s/run.pl', args: [] });
});

test('extension matching is case-insensitive', () => {
  // Windows filesystems routinely hand back RUN.BAT.
  const { Mod: Win } = load({ platform: 'win32' });
  assert.equal(Win.resolveLocalScriptLauncher('C:\\s\\RUN.PS1').command, 'powershell.exe');

  const { Mod: Posix } = load({ platform: 'darwin' });
  assert.equal(Posix.resolveLocalScriptLauncher('/s/RUN.SH').command, '/bin/sh');
});

// --- Running ----------------------------------------------------------------

test('a script that exits cleanly resolves to null', () => {
  // null is the success signal the caller checks; anything else is shown to the
  // operator as an error.
  const { Mod } = load({ platform: 'darwin' });
  return Mod.runLocalScriptFile('/s/run.sh').then((Result) => assert.equal(Result, null));
});

test('a failing script reports its stderr, which is what the author wrote', async () => {
  const { Mod } = load({
    platform: 'darwin',
    exec: () => ({ error: new Error('Command failed'), stderr: 'projector did not answer\n' }),
  });

  const Result = await Mod.runLocalScriptFile('/s/run.sh');
  assert.equal(Result, 'projector did not answer');
});

test('with no stderr the process error is reported instead', async () => {
  // ENOENT for a missing interpreter is the common case, and "Script execution
  // failed" would tell the operator nothing about it.
  const { Mod } = load({
    platform: 'darwin',
    exec: () => ({ error: new Error('spawn python3 ENOENT'), stderr: '   ' }),
  });

  const Result = await Mod.runLocalScriptFile('/s/run.py');
  assert.equal(Result, 'spawn python3 ENOENT');
});

test('a failure with nothing to say still says something', async () => {
  const { Mod } = load({
    platform: 'darwin',
    exec: () => ({ error: Object.assign(new Error(''), { message: '' }), stderr: '' }),
  });

  assert.equal(await Mod.runLocalScriptFile('/s/run.sh'), 'Script execution failed');
});

test('stderr on a SUCCESSFUL run is not treated as a failure', async () => {
  // Plenty of tools write progress and warnings to stderr. Failing on that
  // would make ordinary scripts look broken.
  const { Mod } = load({
    platform: 'darwin',
    exec: () => ({ error: null, stdout: 'done', stderr: 'warning: deprecated flag' }),
  });

  assert.equal(await Mod.runLocalScriptFile('/s/run.sh'), null);
});

test('extra arguments are appended after the launcher’s own', async () => {
  // Order matters: `/bin/sh script.sh --force` runs the script with --force,
  // while the reverse would try to run --force as the script.
  const { Mod, calls } = load({ platform: 'darwin' });

  await Mod.runLocalScriptFile('/s/run.sh', ['--force', 'client-1']);
  assert.deepEqual(calls.exec[0].Args, ['/s/run.sh', '--force', 'client-1']);
});

test('a script runs in its own folder', async () => {
  // Scripts routinely reference files beside them by relative path; inheriting
  // the app's cwd would break every one of those.
  const { Mod, calls } = load({ platform: 'darwin' });

  await Mod.runLocalScriptFile('/scripts/restart-qlab/run.sh');
  assert.equal(calls.exec[0].Options.cwd, '/scripts/restart-qlab');
});

test('no console window is flashed on Windows', async () => {
  // A console popping up over a show output is its own kind of failure.
  const { Mod, calls } = load({ platform: 'win32' });

  await Mod.runLocalScriptFile('C:\\s\\run.bat');
  assert.equal(calls.exec[0].Options.windowsHide, true);
});

test('the output buffer is generous enough for a chatty script', async () => {
  // The default is 1MB; a verbose script exceeding it is killed mid-run and
  // reported as a failure it did not actually have.
  const { Mod, calls } = load({ platform: 'darwin' });

  await Mod.runLocalScriptFile('/s/run.sh');
  assert.ok(calls.exec[0].Options.maxBuffer >= 10 * 1024 * 1024);
});

// --- The executable bit -----------------------------------------------------

test('POSIX scripts are made executable before running', async () => {
  // A script copied out of a zip or synced from Windows arrives without the
  // executable bit, and would fail with EACCES every time.
  const { Mod, calls } = load({ platform: 'darwin' });

  await Mod.runLocalScriptFile('/s/run.sh');
  assert.deepEqual(calls.chmod, [['/s/run.sh', 0o755]]);
});

test('a chmod failure does not stop the script running', async () => {
  // On a read-only volume or a network share the bit may already be correct, or
  // simply unsettable. Refusing to run would turn a working script into a
  // permanent failure.
  const { Mod, calls } = load({ platform: 'darwin', chmodThrows: true });

  const Result = await Mod.runLocalScriptFile('/s/run.sh');
  assert.equal(Result, null);
  assert.equal(calls.exec.length, 1, 'the script was never launched');
});

test('Windows never attempts chmod', async () => {
  // There is no executable bit, and calling it would throw on every run.
  const { Mod, calls } = load({ platform: 'win32' });

  await Mod.runLocalScriptFile('C:\\s\\run.bat');
  assert.deepEqual(calls.chmod, []);
});
