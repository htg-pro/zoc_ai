/**
 * Pure LSP status formatter (design.md "lsp/lsp-status.ts — pure formatter +
 * status slice"), in the exact style of `src/lib/status-bar.ts`: no React,
 * unit-testable in isolation. It derives the per-language status-bar views from
 * the open files and the per-server state slice.
 */
import { activeLanguageIds, serverForLanguage } from "./lsp-registry";
import type { ServerName } from "./lsp-registry";
import type { LanguageServerState } from "./lsp-connection";

/** The display view for one language's server state (drives one indicator). */
export interface LspStatusView {
  languageId: string;
  /** Human label, e.g. "TypeScript", "Python" (reuses the status-bar labels). */
  label: string;
  state: LanguageServerState;
  /** Display tone, mirroring the `status-bar.ts` tone vocabulary. */
  tone: "busy" | "ok" | "error";
}

/** Language display labels, matching `status-bar.ts` (R5.1 reuse). */
const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript JSX",
  javascript: "JavaScript",
  javascriptreact: "JavaScript JSX",
  python: "Python",
  rust: "Rust",
};

/**
 * Pure: derive the display view for one language's server state (R5.1–5.4).
 *
 * The tone is `busy` while `starting` (the connection also reports `starting`
 * while reconnecting), `ok` when `connected`, and `error` on failure. The label
 * is always non-empty.
 */
export function formatLspStatus(
  languageId: string,
  state: LanguageServerState,
): LspStatusView {
  const label = LANGUAGE_LABELS[languageId] ?? languageId;
  const tone: LspStatusView["tone"] =
    state === "connected" ? "ok" : state === "error" ? "error" : "busy";
  return { languageId, label, state, tone };
}

/**
 * Pure: the indicator views to render (R5.5, R5.6). One view per distinct
 * mapped Language_Id among the open files; each reflects its mapped server's
 * state (defaulting to `starting` before the first state is reported). None for
 * unmapped ids or ids with no open file.
 */
export function lspIndicatorViews(
  openFiles: ReadonlyArray<{ language: string }>,
  serverStates: ReadonlyMap<ServerName, LanguageServerState>,
): LspStatusView[] {
  return activeLanguageIds(openFiles).map((languageId) => {
    // `activeLanguageIds` only yields mapped ids, so this lookup is defined.
    const server = serverForLanguage(languageId) as ServerName;
    const state = serverStates.get(server) ?? "starting";
    return formatLspStatus(languageId, state);
  });
}

/**
 * Pure: are LSP features active for this Language_Id? (R4.5, R4.6.) True iff the
 * id maps to a Server_Name whose state is `connected`.
 */
export function isLspActive(
  languageId: string,
  serverStates: ReadonlyMap<ServerName, LanguageServerState>,
): boolean {
  const server = serverForLanguage(languageId);
  return server !== undefined && serverStates.get(server) === "connected";
}
