// Run the test suite the way CI does: with no ShowTrak application data.
//
// Several managers require ../DB and open a live sqlite connection when their
// module is first loaded. On a developer machine that connection succeeds
// against the real database under the app-data directory, so a test that forgot
// to stub such a manager passes in milliseconds. CI has no such database, and
// the same test hangs until it times out — which is how a green local run has
// three times shipped a red pipeline.
//
// Pointing HOME (and the Windows/XDG equivalents) at an empty directory moves
// the app-data path somewhere that does not exist, reproducing CI exactly
// without needing CI.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-isolated-'));

try {
  // The same flags the `test` script uses. An isolated run that differed from
  // the real one in concurrency or timeout would be answering a question nobody
  // asked.
  const Result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-timeout=30000', '--test-force-exit'],
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
  process.exit(Result.status == null ? 1 : Result.status);
} finally {
  fs.rmSync(Sandbox, { recursive: true, force: true });
}
