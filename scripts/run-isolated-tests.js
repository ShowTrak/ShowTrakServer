// `npm test`: run the suite with no ShowTrak application data.
//
// Several managers require ../DB and open a live sqlite connection when their
// module is first loaded. Run against a developer's real app-data directory,
// that connection succeeds against (and migrates) the real working database,
// and a test that forgot to stub such a manager passes in milliseconds. CI has
// no such database, and the same test hangs until it times out, which is how a
// green local run has three times shipped a red pipeline.
//
// Pointing HOME (and the Windows/XDG equivalents) at an empty directory moves
// the app-data path somewhere that does not exist, so every run (local, CI and
// coverage) sees the same empty machine and never touches real show data.
//
// Extra arguments are passed through to `node --test`, so a single file runs as
// `npm test -- test/db.test.js`.
//
// Not named test-*.js: that matches node --test's default file pattern, so the
// suite would run this script as a test file of its own (spawning a recursive
// run that node skips with a warning).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-isolated-'));

try {
  const Result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      // Per file. The MX-8A suite waits out the unit's 1 s connection release
      // between sessions and runs past 30 s on Windows.
      '--test-timeout=60000',
      '--test-force-exit',
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: Sandbox,
        USERPROFILE: Sandbox,
        APPDATA: path.join(Sandbox, 'AppData', 'Roaming'),
        XDG_DATA_HOME: path.join(Sandbox, '.local', 'share'),
      },
    }
  );
  process.exitCode = Result.status == null ? 1 : Result.status;
} finally {
  // Retries: on Windows a just-exited child can hold a file handle briefly.
  fs.rmSync(Sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
