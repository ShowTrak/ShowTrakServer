// `npm test`: run the suite with no ShowTrak application data, through
// shared/scripts/run-isolated-tests.js (shared with ShowTrak Timers).
//
// Several managers require ../DB and open a live sqlite connection when their
// module is first loaded. Run against a developer's real app-data directory,
// that connection succeeds against (and migrates) the real working database,
// and a test that forgot to stub such a manager passes in milliseconds. CI has
// no such database, and the same test hangs until it times out. So HOME (and
// the Windows/XDG equivalents) point at an empty sandbox for every run.
//
// Extra arguments are passed through to `node --test`, so a single file runs as
// `npm test -- test/db.test.js`.
//
// Not named test-*.js: that matches node --test's default file pattern, so the
// suite would run this script as a test file of its own (spawning a recursive
// run that node skips with a warning).
require('../shared/scripts/run-isolated-tests').main();
