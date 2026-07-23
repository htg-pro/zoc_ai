// Feature: monaco-lsp-integration, Property 5: Server lifecycle reconciliation
// Feature: monaco-lsp-integration, Property 6: Reuse is idempotent
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  LANGUAGE_SERVERS,
  activeLanguageIds,
  reconcile,
  requiredServers,
  serverForLanguage,
  type ServerName,
} from "../lsp-registry";

const MAPPED_IDS = Object.keys(LANGUAGE_SERVERS);
const SERVERS: ServerName[] = ["typescript-language-server", "pyright", "rust-analyzer"];

// Language ids: a mix of mapped ids, known-unmapped ids, arbitrary strings, and
// inherited object keys (prototype-safety regression guard).
const PROTO_KEYS = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"];
const languageIdArb = fc.oneof(
  fc.constantFrom(...MAPPED_IDS),
  fc.constantFrom("go", "json", "markdown", "css", "yaml", ""),
  fc.constantFrom(...PROTO_KEYS),
  fc.string(),
);
const openFilesArb = fc.array(fc.record({ language: languageIdArb }), { maxLength: 25 });

/** Apply one reconcile step, moving `running` toward `required`. */
function applyReconcile(
  running: ReadonlySet<ServerName>,
  required: ReadonlySet<ServerName>,
): Set<ServerName> {
  const { start, stop } = reconcile(running, required);
  const next = new Set(running);
  for (const s of stop) next.delete(s);
  for (const s of start) next.add(s);
  return next;
}

describe("lsp-registry language→server mappings (task 2.2)", () => {
  it("locks the six Language_Id → Server_Name mappings; unmapped ids yield undefined", () => {
    expect(serverForLanguage("typescript")).toBe("typescript-language-server");
    expect(serverForLanguage("typescriptreact")).toBe("typescript-language-server");
    expect(serverForLanguage("javascript")).toBe("typescript-language-server");
    expect(serverForLanguage("javascriptreact")).toBe("typescript-language-server");
    expect(serverForLanguage("python")).toBe("pyright");
    expect(serverForLanguage("rust")).toBe("rust-analyzer");
    expect(serverForLanguage("go")).toBeUndefined();
    expect(serverForLanguage("")).toBeUndefined();
    // Inherited object keys must not resolve to a prototype value (bug guard).
    for (const key of PROTO_KEYS) {
      expect(serverForLanguage(key)).toBeUndefined();
    }
  });
});

describe("lsp-registry reconciliation", () => {
  it("Property 5: Server lifecycle reconciliation — running after reconcile == requiredServers(openFiles)", () => {
    fc.assert(
      fc.property(
        openFilesArb,
        fc.array(fc.constantFrom(...SERVERS), { maxLength: 3 }),
        (openFiles, initialRunning) => {
          const required = requiredServers(openFiles);
          const next = applyReconcile(new Set(initialRunning), required);
          // Equals exactly the required set…
          expect([...next].sort()).toEqual([...required].sort());
          // …set-valued (≤1 per Server_Name is inherent to Set)…
          for (const s of next) expect(SERVERS).toContain(s);
          // …and no server survives for a Language_Id that maps to none.
          for (const id of new Set(openFiles.map((f) => f.language))) {
            if (serverForLanguage(id) === undefined) {
              // an unmapped id contributes no server
              expect([...required]).not.toContain(id as unknown as ServerName);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 6: Reuse is idempotent — reconcile(required, required) yields empty start/stop", () => {
    fc.assert(
      fc.property(openFilesArb, (openFiles) => {
        const required = requiredServers(openFiles);
        const { start, stop } = reconcile(required, required);
        expect(start).toEqual([]);
        expect(stop).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("activeLanguageIds yields only distinct mapped ids", () => {
    fc.assert(
      fc.property(openFilesArb, (openFiles) => {
        const ids = activeLanguageIds(openFiles);
        expect(new Set(ids).size).toBe(ids.length); // distinct
        for (const id of ids) expect(serverForLanguage(id)).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });
});
