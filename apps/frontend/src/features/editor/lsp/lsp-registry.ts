/**
 * Language→Server map and the pure reconciliation core of the LSP registry
 * (design.md "lsp/lsp-registry.ts — Language→Server map and per-language
 * lifecycle").
 *
 * These functions own the mapping from an editor Language_Id to a logical
 * Server_Name and the pure set arithmetic that decides which servers to start
 * and stop. `createLspRegistry` wires that reconciliation to the Zustand store
 * so servers start/stop on demand as files open and close.
 */

import { useApp } from "@/lib/store";
import type { LspClient } from "./lsp-client";

/** The three allowlisted logical language-server names (mirrors `lsp.py`). */
export type ServerName =
  | "typescript-language-server"
  | "pyright"
  | "rust-analyzer";

/** Language_Id → Server_Name (R2.1). The four TS/JS ids share one server. */
export const LANGUAGE_SERVERS: Readonly<Record<string, ServerName>> = {
  typescript: "typescript-language-server",
  typescriptreact: "typescript-language-server",
  javascript: "typescript-language-server",
  javascriptreact: "typescript-language-server",
  python: "pyright",
  rust: "rust-analyzer",
};

/** Pure: the Server_Name for a Language_Id, or undefined when unmapped (R2.6).
 *  The `Object.hasOwn` guard prevents inherited object keys ("toString",
 *  "constructor", …) from resolving to a prototype value. */
export function serverForLanguage(languageId: string): ServerName | undefined {
  return Object.hasOwn(LANGUAGE_SERVERS, languageId) ? LANGUAGE_SERVERS[languageId] : undefined;
}

/** Pure: distinct Server_Names required by a set of open files (R2.2/2.4/2.5/2.6). */
export function requiredServers(
  openFiles: ReadonlyArray<{ language: string }>,
): ReadonlySet<ServerName> {
  const out = new Set<ServerName>();
  for (const f of openFiles) {
    const server = serverForLanguage(f.language);
    if (server) out.add(server);
  }
  return out;
}

/** Pure: distinct mapped Language_Ids among open files (drives indicators, R5.5/5.6). */
export function activeLanguageIds(
  openFiles: ReadonlyArray<{ language: string }>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const f of openFiles) {
    if (serverForLanguage(f.language) && !seen.has(f.language)) seen.add(f.language);
  }
  return [...seen];
}

/** Pure reconcile: given what is running now and what is required, the set of
 *  servers to start and to stop. `start`/`stop` are disjoint; a server that is
 *  running and still required is reused, not restarted (R2.3 idempotence). */
export function reconcile(
  running: ReadonlySet<ServerName>,
  required: ReadonlySet<ServerName>,
): { start: ServerName[]; stop: ServerName[] } {
  const start = [...required].filter((s) => !running.has(s)); // R2.2
  const stop = [...running].filter((s) => !required.has(s)); // R2.4
  return { start, stop };
}

/** The store-subscribed registry: reconciles running servers against
 *  `store.openFiles` and tears everything down on dispose. */
export interface LspRegistry {
  /** Unsubscribe from the store and stop all running servers. */
  dispose(): void;
}

/**
 * Wire reconciliation to the store (R2.2, R2.4). Called once from the editor
 * feature. On creation it applies once against the current `openFiles`, then on
 * every `openFiles` change it computes `reconcile(running, required)` and
 * starts/stops the difference (a still-required running server is reused, not
 * restarted — R2.3, enforced by `reconcile`). `dispose()` unsubscribes and
 * stops every running server.
 */
export function createLspRegistry(client: LspClient): LspRegistry {
  const apply = (openFiles: ReadonlyArray<{ language: string }>): void => {
    const { start, stop } = reconcile(client.runningServers(), requiredServers(openFiles));
    for (const server of stop) client.stop(server); // R2.4 (also disposes connection)
    for (const server of start) client.start(server); // R2.2 (reuse handled by reconcile → R2.3)
  };
  // Apply once against the current open files on creation.
  apply(useApp.getState().openFiles);
  // Reconcile whenever the open-file set changes (identity compare is enough —
  // the store replaces the array on every mutation).
  const unsubscribe = useApp.subscribe((state, prev) => {
    if (state.openFiles !== prev.openFiles) apply(state.openFiles);
  });
  return {
    dispose() {
      unsubscribe();
      for (const server of client.runningServers()) client.stop(server);
    },
  };
}
