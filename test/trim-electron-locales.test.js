const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { trimElectronLocales } = require('../scripts/trim-electron-locales');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-locales-'));
  for (const file of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  return root;
}

test('trim-electron-locales: keeps en-US/en-GB packs on Windows/Linux layouts', () => {
  const root = makeTree([
    'locales/en-US.pak',
    'locales/en-GB.pak',
    'locales/de.pak',
    'locales/zh-CN.pak',
    'locales/README.txt',
  ]);
  assert.equal(trimElectronLocales(root), 2);
  assert.deepEqual(fs.readdirSync(path.join(root, 'locales')).sort(), [
    'README.txt',
    'en-GB.pak',
    'en-US.pak',
  ]);
});

test('trim-electron-locales: keeps English lproj packs inside the macOS framework only', () => {
  const fw = 'App.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources';
  const root = makeTree([
    `${fw}/en.lproj/locale.pak`,
    `${fw}/en_GB.lproj/locale.pak`,
    `${fw}/en_GB_FEMININE.lproj/locale.pak`,
    `${fw}/de.lproj/locale.pak`,
    `${fw}/de_FEMININE.lproj/locale.pak`,
    `${fw}/MainMenu.nib/keep`,
    `${fw}/other.lproj/not-a-locale-pack`,
    'App.app/Contents/Resources/de.lproj/.keep',
  ]);
  assert.equal(trimElectronLocales(root), 2);
  assert.deepEqual(fs.readdirSync(path.join(root, fw)).sort(), [
    'MainMenu.nib',
    'en.lproj',
    'en_GB.lproj',
    'en_GB_FEMININE.lproj',
    'other.lproj',
  ]);
  // The app's own (empty) Resources/*.lproj are not Chromium's and stay.
  assert.ok(fs.existsSync(path.join(root, 'App.app/Contents/Resources/de.lproj')));
});

test('trim-electron-locales: refuses a pack directory without the en-US fallback', () => {
  const root = makeTree(['locales/de.pak']);
  assert.throws(() => trimElectronLocales(root), /no en-US\.pak/);
});
