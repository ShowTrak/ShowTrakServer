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
      'forge.config.mjs',
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
    files: ['src/UI/js/app/**/*.js'],
    rules: {
      // Classic renderer scripts share globals across many files.
      // Keep lint coverage enabled while avoiding false positives.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    // Non-renderer source (main process, modules, bridges, tests, scripts).
    // Renderer files intentionally keep var/globals, so these rules are scoped
    // away from src/UI/js/app.
    files: [
      'src/Modules/**/*.js',
      'src/main.js',
      'src/main/**/*.js',
      'src/bridge_main.js',
      'src/bridge_preloader.js',
      'test/**/*.js',
      'test-support/**/*.js',
      'scripts/**/*.js',
    ],
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    // TypeScript source (main process, modules, renderer, shared types).
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
      // Inline `require('../X')` is the documented workaround for not-yet-
      // migrated managers with circular deps; removed in Phase 4.
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
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
  },
]);
