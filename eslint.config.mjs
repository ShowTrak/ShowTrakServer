import js from "@eslint/js";
import globals from "globals";
import markdown from "@eslint/markdown";

import { defineConfig } from "eslint/config";

export default defineConfig([
	{
		ignores: ["src/UI/**", "node_modules/**", "out/**", "forge.config.mjs", ".vscode/**"],
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		extends: [
			js.configs.recommended, // Correct way to extend @eslint/js recommended config
		],
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
		rules: {
			// Correct way to configure options for the 'no-unused-vars' rule
			"no-unused-vars": [
				"error", // Or "warn", depending on your preference
				{
					argsIgnorePattern: "^_[^_].*$|^_$",
					varsIgnorePattern: "^_[^_].*$|^_$",
					caughtErrorsIgnorePattern: "^_[^_].*$|^_$",
				},
			],
		},
	},
	{
		files: ["**/*.md"],
		extends: [markdown.configs.recommended],
	},
]);
