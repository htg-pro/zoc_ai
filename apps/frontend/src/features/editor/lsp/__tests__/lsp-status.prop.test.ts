// Feature: monaco-lsp-integration, Property 8: LSP features are gated on a connected server
// Feature: monaco-lsp-integration, Property 9: Status view derivation
// Feature: monaco-lsp-integration, Property 10: One indicator per open Language_Id
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  LANGUAGE_SERVERS,
  activeLanguageIds,
  serverForLanguage,
  type ServerName,
} from "../lsp-registry";
import type { LanguageServerState } from "../lsp-connection";
import { formatLspStatus, isLspActive, lspIndicatorViews } from "../lsp-status";

const STATES: LanguageServerState[] = ["starting", "connected", "error"];
const MAPPED_IDS = Object.keys(LANGUAGE_SERVERS);
const SERVERS: ServerName[] = ["typescript-language-server", "pyright", "rust-analyzer"];

const languageIdArb = fc.oneof(
  fc.constantFrom(...MAPPED_IDS),
  fc.constantFrom("go", "json", "css", ""),
  fc.constantFrom("toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"),
  fc.string(),
);
const openFilesArb = fc.array(fc.record({ language: languageIdArb }), { maxLength: 25 });
const serverStatesArb = fc
  .array(fc.tuple(fc.constantFrom(...SERVERS), fc.constantFrom(...STATES)), { maxLength: 3 })
  .map((pairs) => new Map<ServerName, LanguageServerState>(pairs));

describe("lsp-status formatter", () => {
  it("Property 9: Status view derivation — non-empty label + tone busy/ok/error", () => {
    fc.assert(
      fc.property(fc.constantFrom(...MAPPED_IDS), fc.constantFrom(...STATES), (id, state) => {
        const view = formatLspStatus(id, state);
        expect(view.label.length).toBeGreaterThan(0);
        expect(view.state).toBe(state);
        const expectedTone =
          state === "connected" ? "ok" : state === "error" ? "error" : "busy";
        expect(view.tone).toBe(expectedTone);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 8: LSP features gated on a connected server", () => {
    fc.assert(
      fc.property(languageIdArb, serverStatesArb, (id, serverStates) => {
        const server = serverForLanguage(id);
        const expected = server !== undefined && serverStates.get(server) === "connected";
        expect(isLspActive(id, serverStates)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 10: exactly one indicator per distinct mapped Language_Id, none otherwise", () => {
    fc.assert(
      fc.property(openFilesArb, serverStatesArb, (openFiles, serverStates) => {
        const views = lspIndicatorViews(openFiles, serverStates);
        const ids = views.map((v) => v.languageId);
        // distinct
        expect(new Set(ids).size).toBe(ids.length);
        // exactly the distinct mapped ids among the open files
        expect([...ids].sort()).toEqual([...activeLanguageIds(openFiles)].sort());
        // none for unmapped ids
        for (const v of views) expect(serverForLanguage(v.languageId)).toBeDefined();
        // each view reflects its mapped server's state (default starting)
        for (const v of views) {
          const server = serverForLanguage(v.languageId) as ServerName;
          expect(v.state).toBe(serverStates.get(server) ?? "starting");
        }
      }),
      { numRuns: 200 },
    );
  });
});
