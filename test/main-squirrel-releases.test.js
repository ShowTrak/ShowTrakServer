const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercises src/main/squirrel-releases.ts: recovering the incoming version and
// download progress that Electron's Squirrel.Windows updater does not report.

const {
  parseSquirrelReleases,
  newestSquirrelPackages,
  readSquirrelDownloadPercent,
} = require('../dist/main/squirrel-releases');

test('parseSquirrelReleases reads a BOM-prefixed RELEASES manifest', () => {
  const text =
    '\uFEFF02DAA88F39932D3926C4FE3FD39106A390D16352 showtrak_server-3.26.1-full.nupkg 156439083\r\n';
  assert.deepEqual(parseSquirrelReleases(text), [
    { fileName: 'showtrak_server-3.26.1-full.nupkg', version: '3.26.1', size: 156439083 },
  ]);
});

test('parseSquirrelReleases skips malformed lines', () => {
  const text = ['', 'garbage', 'ABC notapackage.zip 10', 'ABC app-1.0.0-full.nupkg NaN'].join('\n');
  assert.deepEqual(parseSquirrelReleases(text), []);
});

test('newestSquirrelPackages keeps full and delta packages of the newest version', () => {
  const packages = parseSquirrelReleases(
    [
      'A showtrak_server-3.9.0-full.nupkg 100',
      'B showtrak_server-3.10.0-delta.nupkg 20',
      'C showtrak_server-3.10.0-full.nupkg 110',
    ].join('\n')
  );
  assert.deepEqual(
    newestSquirrelPackages(packages).map((p) => p.fileName),
    ['showtrak_server-3.10.0-delta.nupkg', 'showtrak_server-3.10.0-full.nupkg']
  );
  assert.deepEqual(newestSquirrelPackages([]), []);
});

test('readSquirrelDownloadPercent measures the partial package on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squirrel-'));
  try {
    const packages = [{ fileName: 'app-2.0.0-full.nupkg', version: '2.0.0', size: 200 }];
    assert.equal(readSquirrelDownloadPercent(root, packages), null);

    fs.mkdirSync(path.join(root, 'packages'));
    fs.writeFileSync(path.join(root, 'packages', 'app-2.0.0-full.nupkg'), Buffer.alloc(50));
    assert.equal(readSquirrelDownloadPercent(root, packages), 25);

    fs.writeFileSync(path.join(root, 'packages', 'app-2.0.0-full.nupkg'), Buffer.alloc(300));
    assert.equal(readSquirrelDownloadPercent(root, packages), 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
