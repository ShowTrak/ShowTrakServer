// Guard: a test that loads a module must stub every manager that module pulls in.
//
// This exists because the failure it prevents is invisible on a developer
// machine. A manager module requires ../DB and opens a live sqlite connection at
// load; locally that finds a real database under ~/Library/Application Support
// and the tests pass in milliseconds, while on CI there is no such database and
// the tests hang until they time out, or assert against a manager that never
// answered. Nothing in the diff looks wrong and the local run is green.
//
// It has now happened three times: TagManager first (see the comment in
// server.test.js), then FreeKioskManager across six modules and four test files
// during the FreeKiosk work. A comment saying "any manager added here needs a
// stub" was already in place and was still missed, so this asserts it.
//
// TO REPRODUCE CI LOCALLY, run `npm run test:isolated`. It points HOME at an
// empty directory, so the managers find no database — exactly the condition that
// separates a green laptop from a red CI job. That command, not this file, is
// the real check; this one just fails faster and says what to fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Every `<Name>Manager` a compiled module requires, whatever the path shape. */
function ManagersRequiredBy(RelativePath) {
  const Source = fs.readFileSync(path.join(ROOT, RelativePath), 'utf8');
  const Found = new Set();
  for (const Match of Source.matchAll(/require\(["'][^"']*?([A-Za-z]+Manager)["']\)/g)) {
    Found.add(Match[1]);
  }
  return [...Found].sort();
}

/**
 * Every manager a test file stubs anywhere in it.
 *
 * Matches both mock styles in this suite — loadWithMocks keys like
 * `'../FreeKioskManager':` and installModuleMocks matchers like
 * `matchesModule('/Modules/FreeKioskManager')`.
 *
 * Scanned whole rather than per call site: the mock maps are frequently a named
 * variable reused across several calls, so there is no reliable literal to
 * attribute to an individual one. The limit is deliberate — this catches a
 * manager stubbed NOWHERE, which is how this has gone wrong every time, but not
 * one missed in a single call site among several.
 */
function ManagersStubbedBy(RelativePath) {
  const Source = fs.readFileSync(path.join(ROOT, RelativePath), 'utf8');
  const Found = new Set();
  for (const Match of Source.matchAll(/["'][^"']*?[/]([A-Za-z]+Manager)["']/g)) {
    Found.add(Match[1]);
  }
  return Found;
}

// Compiled module -> the test that loads it. Maintained by hand: the tests build
// these paths with helpers, so there is no reliable way to infer the pairing.
const CASES = [
  ['dist/Modules/Server/webui-namespace.js', 'test/server.test.js'],
  ['dist/Modules/Server/sdk-namespace.js', 'test/sdk-namespace.test.js'],
  ['dist/main/broadcast-bridge.js', 'test/main-broadcast-bridge.test.js'],
  ['dist/main/shutdown-coordinator.js', 'test/main-shutdown-coordinator.test.js'],
  ['dist/main/registrars/groups.js', 'test/main-registrar-groups.test.js'],
  ['dist/Modules/ControlService/index.js', 'test/sdk-api.test.js'],
  ['dist/Modules/Bonjour/index.js', 'test/bonjour.test.js'],
];

for (const [Module, Test] of CASES) {
  test(`${Test} stubs every manager ${Module.split('/').slice(-2).join('/')} requires`, () => {
    const Required = ManagersRequiredBy(Module);
    assert.ok(Required.length > 0, `found no manager imports in ${Module} — has it moved?`);

    const Stubbed = ManagersStubbedBy(Test);
    const Missing = Required.filter((Name) => !Stubbed.has(Name));

    assert.deepEqual(
      Missing,
      [],
      `${Test} never stubs: ${Missing.join(', ')}.\n` +
        `Add a stub for each to its mock map. Unstubbed, the real manager opens a ` +
        `live sqlite connection at module load — green locally, broken on CI. ` +
        `Reproduce with: npm run test:isolated`
    );
  });
}
