const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CreateInstallSettingsStore } = require('../dist/Modules/SettingsManager/install-settings');

// The install-level store backs settings that belong to this machine rather
// than the open show file. It must start empty, round-trip values, keep other
// keys when one is written, and survive a corrupt file.

function tempStore() {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-install-settings-'));
  const FilePath = path.join(Dir, 'nested', 'install-settings.json');
  test.after(() => fs.rmSync(Dir, { recursive: true, force: true }));
  return { FilePath, Store: CreateInstallSettingsStore(() => FilePath) };
}

test('a missing file reads as no stored value', async () => {
  const { Store } = tempStore();
  assert.deepEqual(await Store.GetByKey('ANY'), [null, null]);
});

test('values round-trip and writing one key keeps the others', async () => {
  const { FilePath, Store } = tempStore();
  assert.deepEqual(await Store.Upsert('A', true), [null, true]);
  await Store.Upsert('B', 5);
  await Store.Upsert('A', false);

  assert.deepEqual(await Store.GetByKey('A'), [null, { Key: 'A', Value: false }]);
  assert.deepEqual(await Store.GetByKey('B'), [null, { Key: 'B', Value: 5 }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(FilePath, 'utf8')), { A: false, B: 5 });
  assert.equal(fs.existsSync(`${FilePath}.tmp`), false, 'temp file is renamed away');
});

test('a corrupt file reads as empty and is replaced on the next write', async () => {
  // Failing the read would stop the whole SettingsManager from initialising.
  const { FilePath, Store } = tempStore();
  fs.mkdirSync(path.dirname(FilePath), { recursive: true });
  fs.writeFileSync(FilePath, '{not json');
  assert.deepEqual(await Store.GetByKey('A'), [null, null]);

  await Store.Upsert('A', true);
  assert.deepEqual(JSON.parse(fs.readFileSync(FilePath, 'utf8')), { A: true });
});
