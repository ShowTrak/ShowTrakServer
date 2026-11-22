import js from '@eslint/js';
import globals from 'globals';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: [
      'src/UI/vendors/**',
      'src/WebUI/vendors/**',
      'coverage/**',
      'node_modules/**',
      'out/**',
      'dist/**',
      'dist-test/**',
      '.vscode/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [
      js.configs.recommended, // Correct way to extend @eslint/js recommended config
      prettier,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Correct way to configure options for the 'no-unused-vars' rule
      'no-unused-vars': [
        'error', // Or "warn", depending on your preference
        {
          caughtErrors: 'none',
          argsIgnorePattern: '^_[^_].*$|^_$',
          varsIgnorePattern: '^_[^_].*$|^_$',
          caughtErrorsIgnorePattern: '^_[^_].*$|^_$',
        },
      ],
    },
  },
  {
    // The JavaScript left in the repo: tests, their support code and the build
    // scripts. Everything under src/ is TypeScript.
    files: ['test/**/*.js', 'test-support/**/*.js', 'scripts/**/*.js'],
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    // TypeScript source (main process, modules, renderer, shared types) and
    // the tool configs (this file and forge.config.ts).
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The JS→TS migration is complete: the whole tree (server + renderer) is
      // free of explicit `any`, so this is now enforced as an error to prevent
      // regressions. If you truly need a dynamic value, use `unknown` and narrow.
      '@typescript-eslint/no-explicit-any': 'error',
      // A require() stays where a module is loaded lazily on purpose (start-up
      // cost, a circular dependency), typed as `require('x') as typeof
      // import('x')`; every other module is imported.
      '@typescript-eslint/no-require-imports': 'off',
      // jQuery handler patterns legitimately alias `this` (e.g. into rAF closures).
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          caughtErrors: 'none',
          argsIgnorePattern: '^_[^_].*$|^_$',
          varsIgnorePattern: '^_[^_].*$|^_$',
        },
      ],
    },
  },
  {
    // No value typed `any` may be used unchecked. Explicit `any` is banned
    // above; these rules catch the implicit kind: an untyped require(), a
    // JSON.parse result, Array.isArray on an unknown value, jQuery's .data(), a
    // library callback typed loosely. Type such a value as `unknown` and narrow
    // it (src/Modules/Utils/guards.ts, src/UI/js/app/lib/guards.ts).
    //
    // They need type information, so every TypeScript file linted here must
    // belong to one of these programs. shared/ (the ShowTrak-Protocol
    // submodule) lints itself and keeps only the rules above.
    files: ['**/*.ts'],
    ignores: ['shared/**'],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
          './tsconfig.renderer.json',
          './tsconfig.preloader.json',
          './tsconfig.service-worker.json',
          './tsconfig.tooling.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
    },
  },
  {
    // src/common is compiled into both the main process and the renderer, so
    // it imports neither Node, the DOM, nor either side's own modules
    // (tsconfig.common.json checks the globals it uses).
    files: ['src/common/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\./)',
              message: 'src/common only imports its own modules (it runs in both processes).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
  },
  {
    // eslint 10 added `no-useless-assignment` to js.configs.recommended. The
    // codebase deliberately uses declare-with-default then assign-in-all-branches
    // (e.g. `let x = null; try { x = ... } catch { x = ... }`) for readability and
    // safe fallbacks, so the "dead" initializer is intentional. Keep it off to
    // preserve that style; revisit if we ever want to enforce it and fix the sites.
    files: ['**/*.{js,mjs,cjs,ts}'],
    rules: {
      'no-useless-assignment': 'off',
    },
  },
]);
