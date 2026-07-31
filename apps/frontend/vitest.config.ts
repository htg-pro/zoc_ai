import { defineConfig } from "vitest/config";
import path from "node:path";
import fs from "node:fs";

// Mirror the vite.config.ts `define` so `__APP_VERSION__` resolves under test.
const appVersion = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as {
    version: string;
  }
).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    setupFiles: ["./src/__tests__/setup.ts"],
    // `*.perf.test.*` is the `@perf` tier (zoc-agent-chat-rebuild task 17.6): budgets 19.4 and 20.5
    // launch a headless Chromium and stream for tens of seconds, which is both too slow for the
    // default gate and too sensitive to a loaded developer machine to be a reliable signal there.
    // `pnpm test:perf` runs them on a fixed runner.
    exclude: ["node_modules", "dist", "**/*.perf.test.*"],
  },
});
