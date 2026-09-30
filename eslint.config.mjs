import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      ".githooks/**",
      ".stryker-tmp/**",
      ".worktrees/**",
      "docs/**",
      "node_modules/**",
      "plugins/codex/.generated/**",
      "reports/**",
      "stryker.log",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-empty": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "preserve-caught-error": "off",
    },
  },
];
