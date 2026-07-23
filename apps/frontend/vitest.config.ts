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
    exclude: ["node_modules", "dist"],
  },
});
