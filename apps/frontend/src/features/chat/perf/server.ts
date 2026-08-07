/**
 * The `@perf` fixture's dev server — zoc-agent-chat-rebuild task 17.6.
 *
 * Feature: zoc-agent-chat-rebuild, task 17.6.
 *
 * Serves `fixture.html` through the app's own Vite config, so the modules the browser loads are
 * resolved, transformed, and aliased exactly as they are in development. Building a separate bundle
 * for the measurement would measure that bundle.
 *
 * Three overrides on top of the checked-in config, each closing a hole it would otherwise leave in a
 * headless run: a loopback host and an ephemeral port, so a developer's running `pnpm dev` does not
 * collide with the harness; HMR off, because the config points the HMR client at `wss://…:443` for
 * Replit's proxy and a failed WebSocket upgrade in the fixture page is noise at best; and no proxy, so
 * nothing in the page can reach for a backend that is not running.
 */

import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

/** Where the fixture page lives, relative to the Vite root. */
export const FIXTURE_PATH = "src/features/chat/perf/fixture.html";

export interface FixtureServer {
  /** The fixture page's absolute URL. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  // `perf` → `chat` → `features` → `src` → the Vite root.
  const root = path.resolve(import.meta.dirname, "../../../..");

  const server: ViteDevServer = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
      proxy: {},
      watch: null,
    },
  });

  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (base === undefined) {
    await server.close();
    throw new Error("The Vite dev server reported no local URL.");
  }

  return {
    url: new URL(FIXTURE_PATH, base).toString(),
    async close() {
      await server.close();
    },
  };
}
