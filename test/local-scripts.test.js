const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveContainedScriptFile,
  normalizeRelativePathForCompare,
  getLocalPlatformKey,
  parseArgumentString,
  normalizeVersionToken,
  resolveLocalScriptLauncher,
} = require('../dist/main/local-scripts');

test('resolveContainedScriptFile resolves paths inside the script folder', () => {
  const root = path.resolve('/tmp/showtrak-scripts');
  const [err, target] = resolveContainedScriptFile(root, 'Deploy', 'windows.bat');
  assert.equal(err, null);
  assert.equal(target, path.join(root, 'Deploy', 'windows.bat'));
});

test('resolveContainedScriptFile rejects traversal in the folder ID', () => {
  const root = path.resolve('/tmp/showtrak-scripts');
  assert.deepEqual(resolveContainedScriptFile(root, '../evil', 'x.sh'), [
    'Invalid script ID',
    null,
  ]);
  assert.deepEqual(resolveContainedScriptFile(root, 'a/b', 'x.sh'), ['Invalid script ID', null]);
  assert.deepEqual(resolveContainedScriptFile(root, '', 'x.sh'), ['Invalid script ID', null]);
  assert.deepEqual(resolveContainedScriptFile(root, 42, 'x.sh'), ['Invalid script ID', null]);
});

test('resolveContainedScriptFile rejects escaping or absolute relative paths', () => {
  const root = path.resolve('/tmp/showtrak-scripts');
  assert.deepEqual(resolveContainedScriptFile(root, 'Deploy', '../../etc/passwd'), [
    'Invalid file path',
    null,
  ]);
  assert.deepEqual(resolveContainedScriptFile(root, 'Deploy', path.resolve('/etc/passwd')), [
    'Invalid file path',
    null,
  ]);
  assert.deepEqual(resolveContainedScriptFile(root, 'Deploy', ''), ['Invalid file path', null]);
});

test('normalizeRelativePathForCompare normalizes slashes and leading ./', () => {
  assert.equal(normalizeRelativePathForCompare('.\\sub\\file.sh'), 'sub/file.sh');
  assert.equal(normalizeRelativePathForCompare('./a/b'), 'a/b');
  assert.equal(normalizeRelativePathForCompare('  a\\b  '), 'a/b');
  assert.equal(normalizeRelativePathForCompare(null), '');
});

test('getLocalPlatformKey maps the current platform', () => {
  const expected =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  assert.equal(getLocalPlatformKey(), expected);
});

test('parseArgumentString splits plain args on whitespace', () => {
  assert.deepEqual(parseArgumentString('a b   c'), ['a', 'b', 'c']);
  assert.deepEqual(parseArgumentString(''), []);
  assert.deepEqual(parseArgumentString(null), []);
});

test('parseArgumentString honours single and double quotes', () => {
  assert.deepEqual(parseArgumentString('"a b" c'), ['a b', 'c']);
  assert.deepEqual(parseArgumentString("'a b' c"), ['a b', 'c']);
  assert.deepEqual(parseArgumentString('a"b"c'), ['abc']);
});

test('parseArgumentString honours backslash escapes', () => {
  assert.deepEqual(parseArgumentString('a\\ b'), ['a b']);
  assert.deepEqual(parseArgumentString('a\\'), ['a\\']);
});

test('normalizeVersionToken strips leading v and lowercases', () => {
  assert.equal(normalizeVersionToken('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersionToken('V2.0.0'), '2.0.0');
  assert.equal(normalizeVersionToken('  1.0  '), '1.0');
});

test('resolveLocalScriptLauncher resolves by extension for the current platform', () => {
  const scriptPath = path.join('dir', 'script.sh');
  const launcher = resolveLocalScriptLauncher(scriptPath);
  assert.equal(typeof launcher.command, 'string');
  assert.ok(Array.isArray(launcher.args));

  if (process.platform === 'win32') {
    const bat = resolveLocalScriptLauncher('a.bat');
    assert.equal(bat.command, 'cmd.exe');
    assert.deepEqual(bat.args, ['/c', 'a.bat']);
  } else {
    const sh = resolveLocalScriptLauncher('a.sh');
    assert.equal(sh.command, '/bin/sh');
    assert.deepEqual(sh.args, ['a.sh']);
    const py = resolveLocalScriptLauncher('a.py');
    assert.equal(py.command, 'python3');
  }
});
