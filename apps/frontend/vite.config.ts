import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// Single source of truth for the app version: the frontend package.json,
// which `scripts/stamp_version.py` keeps in sync with the root VERSION file.
const appVersion = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as {
    version: string;
  }
).version;

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    // Listen on all interfaces so Replit's proxy can reach the dev server.
    host: "0.0.0.0",
    port: 5000,
    strictPort: false,
    // Allow any hostname (Replit uses a *.replit.dev proxy domain).
    allowedHosts: true as true,
    hmr: {
      // HMR over the same port — works through Replit's TLS proxy.
      clientPort: 443,
      protocol: "wss",
    },
    watch: {
      ignored: ["**/src-tauri/**", "**/legacy/**", "**/node_modules/**"],
    },
    // Proxy /v1, /api, /health to the Zoc AI backend server (port 3001).
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        // Forward SSE (text/event-stream) without buffering.
        configure: (proxy) => {
          proxy.on("proxyReq", (_proxyReq, req) => {
            if (req.headers.accept?.includes("text/event-stream")) {
              _proxyReq.setHeader("Accept", "text/event-stream");
            }
          });
        },
      },
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // Monaco workers use ES module syntax; keep IIFE for the rest.
  worker: { format: "es" },
  optimizeDeps: {
    // Pre-bundle the common runtime deps so the browser gets them quickly.
    include: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom",
      "react-dom/client",
      "zustand",
      "clsx",
      "tailwind-merge",
      "class-variance-authority",
      "lucide-react",
      "react-resizable-panels",
      "sonner",
      "cmdk",
      "diff",
      "fuse.js",
      "@radix-ui/react-slot",
      "@radix-ui/react-label",
      "@radix-ui/react-separator",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-select",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-collapsible",
    ],
    // Monaco, xterm, and the @codingame/* suite use dynamic ESM imports
    // that esbuild cannot tree-shake — exclude them from pre-bundling so
    // Vite serves them as-is (native ESM).
    exclude: [
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-editor-api",
      "monaco-editor",
      "monaco-languageclient",
      "vscode-ws-jsonrpc",
      "@xterm/xterm",
      "@xterm/addon-fit",
      "@monaco-editor/react",
    ],
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: "esbuild",
  },
}));
