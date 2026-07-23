import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
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
