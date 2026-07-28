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

// Feature: zoc-agent-chat-rebuild (R5.6, R19.6) — motion budget.
//
// `motion@12.42.2` is the single animation library, and it is consumed
// exclusively through `LazyMotion` + the `m` component: Motion documents that
// pairing as an initial render footprint just under 4.6 kB with the feature
// bundle loaded afterwards, where the full `motion` component is ~34 kB. The
// heavy exports are refused here so the budget is enforced by the Build_Gate
// rather than by review.
//
// The allow-list is the documented lightweight pattern plus the two pieces the
// reduced-motion gate needs (`MotionConfig` for R19.3's kill-switch,
// `AnimatePresence` for exits), and the type-only names a variant registry
// declares — types are erased at build and cost nothing.
const MOTION_LAZY_ALLOWED_IMPORTS = [
  "LazyMotion",
  "m",
  "domAnimation",
  "MotionConfig",
  "AnimatePresence",
  // Type-only exports.
  "Variant",
  "Variants",
  "Transition",
  "TargetAndTransition",
  "MotionProps",
  "HTMLMotionProps",
  "LazyFeatureBundle",
];

const MOTION_BUDGET_MESSAGE =
  "Import motion only through LazyMotion + the `m` component (R5.6): the full " +
  "`motion` component costs ~34 kB against the ~4.6 kB LazyMotion footprint. " +
  "Allowed: " +
  MOTION_LAZY_ALLOWED_IMPORTS.join(", ") +
  ".";

const MOTION_RESTRICTED_PATHS = ["motion", "motion/react"].map((name) => ({
  name,
  allowImportNames: MOTION_LAZY_ALLOWED_IMPORTS,
  message: MOTION_BUDGET_MESSAGE,
}));

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
  // Motion budget (R5.6, R19.6): every renderer source is held to the
  // LazyMotion + `m` pattern. Declared before the per-file blocks below,
  // because flat-config rule options replace rather than merge — any later
  // block that also configures `no-restricted-imports` restates these paths.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: MOTION_RESTRICTED_PATHS }],
    },
  },
  // Renderer seam (R9.6): the strict Chat_Renderer consumes `FeedRow` only.
  // It must not import the SSE stream or the wire event types — the normalizer
  // is the sole path an Agent_Event reaches the renderer.
  {
    files: ["src/features/agent/rows.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            // Restated from the motion-budget block above: flat-config rule
            // options replace rather than merge, so omitting them here would
            // exempt this file from the R5.6 budget.
            ...MOTION_RESTRICTED_PATHS,
            {
              name: "@zoc-studio/shared-types",
              message:
                "Renderer modules must consume FeedRow, not wire event types (R9.6).",
            },
            {
              name: "./useAgentStream",
              message: "Renderer modules must not import the SSE stream; use FeedRow (R9.6).",
            },
            {
              name: "@/features/agent/useAgentStream",
              message: "Renderer modules must not import the SSE stream; use FeedRow (R9.6).",
            },
          ],
          patterns: [
            {
              group: ["**/useAgentStream", "**/event-ingest"],
              message: "Renderer modules must not import the stream/ingest layer (R9.6).",
            },
          ],
        },
      ],
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
