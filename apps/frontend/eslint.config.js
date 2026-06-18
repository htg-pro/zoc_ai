// ESLint v9 flat config for @zoc-studio/frontend.
//
// ESLint 9 no longer reads `.eslintrc.cjs` by default; this flat config
// restores `pnpm lint` (and `make lint`). It mirrors the previous eslintrc:
// the typescript-eslint recommended rule set plus the react-hooks and
// react-refresh rules, scoped to the TS/TSX sources.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "**/*.config.ts",
      "**/*.config.js",
      "**/*.config.cjs",
      ".ladle/**",
      "tsconfig.tsbuildinfo",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Hooks correctness (was plugin:react-hooks/recommended).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Fast-refresh friendliness for Vite.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Preserve the original eslintrc override.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // Test files: relax a couple of rules that are noisy in test scaffolding.
  {
    files: ["**/*.test.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
