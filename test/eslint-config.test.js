const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

// Covers eslint.config.ts: ESLint loads it (through jiti), the rules against
// implicit `any` apply as errors with type information to every TypeScript
// program in the repo, and shared/ (ShowTrak-Protocol, which lints itself)
// stays out of them.

const ROOT = path.join(__dirname, '..');
const UNSAFE_RULES = [
  'no-unsafe-argument',
  'no-unsafe-assignment',
  'no-unsafe-call',
  'no-unsafe-declaration-merging',
  'no-unsafe-enum-comparison',
  'no-unsafe-function-type',
  'no-unsafe-member-access',
  'no-unsafe-return',
  'no-unsafe-unary-minus',
].map((Rule) => `@typescript-eslint/${Rule}`);
const PROGRAMS = [
  './tsconfig.json',
  './tsconfig.renderer.json',
  './tsconfig.preloader.json',
  './tsconfig.service-worker.json',
  './tsconfig.tooling.json',
];

const eslint = new ESLint({ cwd: ROOT });
const configFor = (file) => eslint.calculateConfigForFile(path.join(ROOT, file));
const severity = (entry) => (Array.isArray(entry) ? entry[0] : entry);

test('every TypeScript program is linted against implicit any, with type information', async () => {
  for (const file of [
    'src/main.ts',
    'src/bridge_main.ts',
    'src/Modules/DB/index.ts',
    'src/UI/js/app/init.ts',
    'src/UI/preloader.ts',
    'src/WebUI/sw.ts',
    'forge.config.ts',
    'eslint.config.ts',
  ]) {
    const config = await configFor(file);
    for (const rule of UNSAFE_RULES) {
      assert.equal(severity(config.rules[rule]), 2, `${rule} is an error for ${file}`);
    }
    assert.equal(config.rules['@typescript-eslint/no-explicit-any'][0], 2);
    assert.deepEqual(config.languageOptions.parserOptions.project, PROGRAMS, file);
    assert.equal(config.languageOptions.parserOptions.tsconfigRootDir, ROOT);
  }
});

test('shared/ keeps the rules it had, without the type-aware ones', async () => {
  const config = await configFor('shared/src/runtime/index.ts');
  for (const rule of UNSAFE_RULES.filter(
    (Rule) => !/declaration-merging|function-type/.test(Rule)
  )) {
    assert.equal(config.rules[rule], undefined, rule);
  }
  assert.equal(config.languageOptions.parserOptions?.project, undefined);
  assert.equal(config.rules['@typescript-eslint/no-explicit-any'][0], 2);
});

test('the JavaScript left in the repo is linted as before', async () => {
  for (const file of ['scripts/build-renderer.js', 'test/local-scripts.test.js']) {
    const config = await configFor(file);
    assert.equal(config.rules.eqeqeq[0], 2, file);
    assert.equal(config.rules['no-var'][0], 2, file);
    assert.equal(config.rules['@typescript-eslint/no-unsafe-assignment'], undefined, file);
  }
});
