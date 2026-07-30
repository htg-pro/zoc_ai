// @ts-check
/**
 * Agent_Runtime lint config — zoc-agent-chat-rebuild R12.4, R22.5.
 *
 * Three rules beyond the recommended set carry policy rather than style:
 *   - `no-restricted-imports` refuses the banned agent frameworks at the source
 *     level, so a violation surfaces at lint time rather than waiting for
 *     `deps:policy` to catch it in the lockfile.
 *   - `no-restricted-syntax` refuses `require(` so the esbuild → pkg pipeline
 *     cannot silently drop a module (R4.3).
 *   - suppression discipline (R22.5, task 12.4): a `eslint-disable` that no longer
 *     suppresses anything is an error, and one without a reason is unreviewable.
 *     The first uses ESLint 9's own `linterOptions` rather than
 *     `eslint-comments/no-unused-disable`, which the plugin deprecated in 4.7.0 and
 *     removes in 5.0.0 in favour of exactly this setting.
 */

import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";

export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.config.ts", "**/*.config.js"] },
  {
    files: ["**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { project: false },
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        ReadableStream: "readonly",
        WritableStream: "readonly",
        TransformStream: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        URL: "readonly",
        crypto: "readonly",
        performance: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin, "eslint-comments": eslintComments },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "eslint-comments/require-description": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["langchain", "langchain/*", "@langchain/*", "mastra", "@mastra/*"],
              message:
                "Banned by R5.4. Zoc AI owns its tool loop on the AI SDK; see " +
                "design.md 'Library ownership'.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='require']",
          message:
            "A dynamic require survives into the esbuild output and pkg's snapshot " +
            "filesystem silently drops the module (R4.3). Use a static import.",
        },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      // The runtime's stdout is a protocol channel (the port line) and its
      // stderr is the supervisor's crash log. Ad-hoc console output corrupts
      // the first and pollutes the second, so it is refused outright.
      "no-console": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": "off",
    },
  },
];
