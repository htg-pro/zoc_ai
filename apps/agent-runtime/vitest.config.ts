import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    // Property tests draw 100–200 cases; the default 5 s timeout is not enough
    // for the ones that exercise the tool loop against a stub model.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
  resolve: {
    alias: {
      "@zoc-studio/shared-types": new URL(
        "../../packages/shared-types/typescript/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
