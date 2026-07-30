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
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";

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

// Feature: zoc-agent-chat-rebuild (R17.1) — no hard-coded colour in component
// source.
//
// R17.1 requires every colour, radius, spacing, and elevation value to come
// from a CSS custom property, and the repo's own history is why it is a lint
// rule rather than a review note: three competing violets accumulated across
// `rows.tsx`, `ToolCallCard.tsx`, and the Monaco rules precisely because nothing
// stopped a literal being typed.
//
// Scoped to `features/chat/**` and not the whole tree, because `features/agent`
// is full of the literals this rebuild is replacing and lives until 26.2 — a
// repo-wide rule would fail the Build_Gate on code that is already scheduled for
// deletion.
//
// Matched on the *literal node* rather than on the file text, so it fires for a
// hex in a `className`, in a style object, in a `fill`, and in a plain string
// constant alike, and does not fire for one inside a comment. The `#rgb` and
// `#rrggbbaa` forms are included because a three-digit literal is the one a
// reviewer's eye skips.
const COLOUR_LITERAL = String.raw`/(^|[^&\w])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\brgba?\s*\(|\bhsla?\s*\(/`;

const COLOUR_LITERAL_MESSAGE =
  "Hard-coded colour literal (R17.1). Every colour in features/chat comes from a " +
  "CSS custom property: use var(--zoc-*) or an existing hsl(var(--*)) token, and " +
  "add the token to globals.css plus features/chat/tokens.ts if it does not exist.";

const NO_COLOUR_LITERALS = [
  {
    selector: `Literal[value=${COLOUR_LITERAL}]`,
    message: COLOUR_LITERAL_MESSAGE,
  },
  {
    // A template literal's static text, which is where a literal hides when a
    // class string is interpolated.
    selector: `TemplateElement[value.raw=${COLOUR_LITERAL}]`,
    message: COLOUR_LITERAL_MESSAGE,
  },
  {
    selector: `JSXText[value=${COLOUR_LITERAL}]`,
    message: COLOUR_LITERAL_MESSAGE,
  },
];

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
  // Token discipline (R17.1) and suppression discipline (R22.5), scoped to the
  // Chat_Surface. Declared last so it wins for these files: flat-config rules are
  // merged per-key in declaration order, and `no-restricted-syntax` is configured
  // nowhere above.
  //
  // The colour rule covers the tests too, deliberately. A property test that
  // asserts against a literal hex is asserting against a value that is no longer
  // the token's — which is exactly the drift `tokens.ts` and its stylesheet check
  // exist to catch — so the two files that legitimately hold literals declare
  // them there and nowhere else.
  //
  // **Suppression discipline uses ESLint's own `linterOptions`, not the plugin's
  // `eslint-comments/no-unused-disable`.** 12.4 names that rule and the package is
  // installed, but it is deprecated as of the plugin's 4.7.0 and removed in 5.0.0:
  // ESLint 9 reports unused directives natively, and `reportUnusedDisableDirectives`
  // is the replacement its own deprecation notice points at. Taking the deprecated
  // path would mean a Build_Gate rule that breaks on the next major. `"error"`
  // rather than the default `"warn"`, because R22.5 asks for a gate.
  {
    files: ["src/features/chat/**/*.{ts,tsx}"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "eslint-comments": eslintComments },
    rules: {
      "no-restricted-syntax": ["error", ...NO_COLOUR_LITERALS],
      // The second half of R22.5, and the half that is not deprecated: a bare
      // `eslint-disable` asserts a rule was in the way without saying why, which is
      // unreviewable. Every suppression in this tree carries its reason.
      "eslint-comments/require-description": "error",
    },
  },
  // `tokens.ts` is the one file in the tree that holds colour literals, because
  // it is the mirror of `globals.css` that the contrast property measures — the
  // value has to be a number somewhere, and here it is checked against the
  // stylesheet rather than asserted. Its own test reads the same literals for the
  // same reason.
  {
    files: [
      "src/features/chat/tokens.ts",
      "src/features/chat/__tests__/tokens.property.test.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // Suppression discipline in the runtime, on the same terms. The runtime has its
  // own `eslint.config.js`, so this block covers the case where the frontend's
  // config is run across the workspace root; the runtime's own config carries the
  // same two settings.
  {
    files: ["../agent-runtime/src/**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "eslint-comments": eslintComments },
    rules: {
      "eslint-comments/require-description": "error",
    },
  },
];
