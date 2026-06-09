import js from '@eslint/js';
import globals from 'globals';
import markdown from '@eslint/markdown';
import prettier from 'eslint-config-prettier';

import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: [
      'src/UI/vendors/**',
      'src/WebUI/vendors/**',
      'coverage/**',
      'node_modules/**',
      'out/**',
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
    files: ['src/UI/js/app/**/*.js', 'src/WebUI/main.js'],
    rules: {
      // Classic renderer scripts share globals across many files.
      // Keep lint coverage enabled while avoiding false positives.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['**/*.md'],
    extends: [markdown.configs.recommended],
  },
]);
