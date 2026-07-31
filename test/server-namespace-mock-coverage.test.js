// Guard: every manager the server namespaces require must be stubbed by the
// test that loads them.
//
// This exists because the failure it prevents is invisible locally. A manager
// module requires ../DB at load and opens a live sqlite connection; on a
// developer machine that succeeds against a real database and the tests pass in
// milliseconds, while on Linux CI there is no such database and the file hangs
// until every test in it times out at 30 seconds. Nothing about the diff looks
// wrong, and the local run is green.
//
// It has now happened twice — TagManager first (see the comment in
// server.test.js), then FreeKioskManager, which was added to both namespaces
// during the FreeKiosk work and stubbed in neither test. A comment saying "any
// manager added here needs a stub" was already in place and was still missed,
// so this asserts it instead of asking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Every `../<Name>Manager` a compiled module requires. */
function ManagersRequiredBy(RelativePath) {
  const Source = fs.readFileSync(path.join(ROOT, RelativePath), 'utf8');
  const Found = new Set();
  for (const Match of Source.matchAll(/require\(["']\.\.\/([A-Za-z]+Manager)["']\)/g)) {
    Found.add(Match[1]);
  }
  return [...Found].sort();
}

/**
 * Every manager a test file stubs anywhere in it.
 *
 * Read as text and scanned whole rather than per loadWithMocks call: these mock
 * maps are frequently a named variable reused across several call sites, so
 * there is no reliable literal to attribute to an individual call.
 *
 * The limit that follows is deliberate and worth stating. This catches a manager
 * stubbed NOWHERE — which is what has actually gone wrong twice, a new import
 * added to a namespace and never mocked. It will NOT catch a manager stubbed in
 * some call sites but missed in one. That narrower slip is still possible; this
 * is a cheap net under the common case, not a proof.
 */
function ManagersStubbedBy(RelativePath) {
  const Source = fs.readFileSync(path.join(ROOT, RelativePath), 'utf8');
  const Found = new Set();
  for (const Match of Source.matchAll(/["']\.\.\/([A-Za-z]+Manager)["']\s*:/g)) {
    Found.add(Match[1]);
  }
  return Found;
}

// Test file -> the compiled modules whose manager imports it must cover.
const CASES = [
  { Test: 'test/server.test.js', Module: 'dist/Modules/Server/webui-namespace.js' },
  { Test: 'test/sdk-namespace.test.js', Module: 'dist/Modules/Server/sdk-namespace.js' },
];

for (const Case of CASES) {
  test(`${Case.Test} stubs every manager ${Case.Module.split('/').pop()} requires`, () => {
    const Required = ManagersRequiredBy(Case.Module);
    assert.ok(Required.length > 0, `found no manager imports in ${Case.Module}`);

    const Stubbed = ManagersStubbedBy(Case.Test);
    const Missing = Required.filter((Name) => !Stubbed.has(Name));

    assert.deepEqual(
      Missing,
      [],
      `${Case.Test} never stubs: ${Missing.join(', ')}.\n` +
        `Add "'../<Name>': { Manager: { GetAll: async () => [null, []] } }" to its ` +
        `loadWithMocks maps. Unstubbed, the real manager opens a live sqlite ` +
        `connection at module load: green locally, hangs until timeout on Linux CI.`
    );
  });
}
