// Feature: editor-diagnostics-completions, Property 1: LSP → Diagnostic mapping is total and field-faithful
// Feature: editor-diagnostics-completions, Property 2: LSP severity maps by the fixed table, defaulting to error
// Feature: editor-diagnostics-completions, Property 5: Deleted-file cleanup clears only the named deleted LSP entries
// Feature: editor-diagnostics-completions, Property 3: Per-URI LSP diagnostics replace and isolate
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { Diagnostic } from "@/lib/problem-matchers";
import {
  type LspDiagnostic,
  createDiagnosticsBridge,
  isLspSourceKey,
  lspKeysForDeletedFiles,
  lspSourceKey,
  mapLspDiagnostic,
  mapPublishedDiagnostics,
  mapSeverity,
  uriToFsPath,
} from "../diagnostics-bridge";
import type { ServerName } from "../lsp-registry";

const SERVERS: ServerName[] = ["typescript-language-server", "pyright", "rust-analyzer"];

const codeArb = fc.oneof(
  fc.constant(undefined),
  fc.string(),
  fc.integer(),
  fc.record({ value: fc.oneof(fc.string(), fc.integer()) }),
);

const lspDiagnosticArb: fc.Arbitrary<LspDiagnostic> = fc.record(
  {
    range: fc.record({
      start: fc.record({
        line: fc.nat({ max: 100000 }),
        character: fc.nat({ max: 100000 }),
      }),
    }),
    severity: fc.oneof(fc.constant(undefined), fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<1 | 2 | 3 | 4>),
    message: fc.string(),
    source: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
    code: codeArb,
  },
  { requiredKeys: ["range", "message"] },
);

// A file URI (POSIX / Windows / UNC-ish) plus arbitrary strings, so the
// mapping/conversion is exercised across realistic and adversarial inputs.
const uriArb = fc.oneof(
  fc.constantFrom(
    "file:///src/app.ts",
    "file:///a/b%20c/space.py",
    "file:///C:/Users/dev/main.rs",
    "file://host/share/file.ts",
    "untitled:Untitled-1",
  ),
  fc.webUrl(),
  fc.string(),
);

describe("diagnostics-bridge mapping (Property 1, Property 2)", () => {
  it("Property 1: mapping is total and field-faithful", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVERS),
        uriArb,
        fc.array(lspDiagnosticArb, { maxLength: 30 }),
        (server, uri, diags) => {
          const mapped = mapPublishedDiagnostics(server, uri, diags);
          expect(mapped).toHaveLength(diags.length); // total, length preserved
          for (let i = 0; i < diags.length; i++) {
            const d = diags[i];
            const m = mapped[i];
            expect(m.line).toBe(d.range.start.line + 1);
            expect(m.column).toBe(d.range.start.character + 1);
            expect(m.file).toBe(uriToFsPath(uri));
            expect(m.message).toBe(d.message); // verbatim
            // source: own source, else the Server_Name.
            expect(m.source).toBe(d.source && d.source.length > 0 ? d.source : server);
            // code: String(code) when present (incl. { value }), unset when absent.
            if (d.code === undefined || d.code === null) {
              expect("code" in m).toBe(false);
            } else if (typeof d.code === "object") {
              expect(m.code).toBe(String(d.code.value));
            } else {
              expect(m.code).toBe(String(d.code));
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 2: severity maps by the fixed table, defaulting to error", () => {
    expect(mapSeverity(1)).toBe("error");
    expect(mapSeverity(2)).toBe("warning");
    expect(mapSeverity(3)).toBe("info");
    expect(mapSeverity(4)).toBe("hint");
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVERS),
        uriArb,
        lspDiagnosticArb,
        (server, uri, d) => {
          const m = mapLspDiagnostic(server, uri, d);
          const expected =
            d.severity === 1
              ? "error"
              : d.severity === 2
                ? "warning"
                : d.severity === 3
                  ? "info"
                  : d.severity === 4
                    ? "hint"
                    : "error"; // absent → error
          expect(m.severity).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// A store made of a mix of lsp:* entries (each with its own file) and
// command-checker entries, for the deleted-file and per-URI properties.
const checkerKeyArb = fc.constantFrom("typescript", "eslint", "ruff", "cargo");
const pathArb = fc.constantFrom("/a.ts", "/b.ts", "/c/d.py", "/e.rs", "/f g.ts");

function diagAt(file: string, severity: Diagnostic["severity"] = "error"): Diagnostic {
  return { source: "x", file, line: 1, column: 1, severity, message: "m" };
}

const storeArb: fc.Arbitrary<Record<string, Diagnostic[]>> = fc
  .array(
    fc.oneof(
      fc.record({ kind: fc.constant("lsp" as const), uri: pathArb, file: pathArb }),
      fc.record({ kind: fc.constant("checker" as const), key: checkerKeyArb, file: pathArb }),
    ),
    { maxLength: 12 },
  )
  .map((entries) => {
    const store: Record<string, Diagnostic[]> = {};
    for (const e of entries) {
      if (e.kind === "lsp") store[lspSourceKey(e.uri)] = [diagAt(e.file)];
      else store[e.key] = [diagAt(e.file)];
    }
    return store;
  });

describe("diagnostics-bridge deleted-file selection (Property 5)", () => {
  it("Property 5: cleanup clears only the named deleted LSP entries", () => {
    fc.assert(
      fc.property(storeArb, fc.array(pathArb, { maxLength: 5 }), (store, deletedList) => {
        const deleted = new Set(deletedList);
        const keys = lspKeysForDeletedFiles(store, deleted);
        const keySet = new Set(keys);
        for (const [key, items] of Object.entries(store)) {
          const touchesDeleted = items.some((d) => deleted.has(d.file));
          if (!isLspSourceKey(key)) {
            expect(keySet.has(key)).toBe(false); // never a checker key
          } else if (touchesDeleted) {
            expect(keySet.has(key)).toBe(true); // deleted lsp entry selected
          } else {
            expect(keySet.has(key)).toBe(false); // still-existing lsp entry kept
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property 3 (per-URI replace/isolation) drives the effectful bridge. ──────
interface FakeStore {
  setDiagnostics: (source: string, items: Diagnostic[]) => void;
  clearDiagnostics: (source?: string) => void;
  getDiagnostics: () => Record<string, Diagnostic[]>;
}

function fakeStore(initial: Record<string, Diagnostic[]> = {}): FakeStore {
  let state: Record<string, Diagnostic[]> = { ...initial };
  return {
    setDiagnostics: (source, items) => {
      state = { ...state, [source]: items };
    },
    clearDiagnostics: (source) => {
      if (!source) {
        state = {};
        return;
      }
      const next = { ...state };
      delete next[source];
      state = next;
    },
    getDiagnostics: () => state,
  };
}

describe("diagnostics-bridge per-URI replace/isolation (Property 3)", () => {
  it("Property 3: per-URI LSP diagnostics replace and isolate", () => {
    fc.assert(
      fc.property(
        storeArb,
        fc.constantFrom(...SERVERS),
        pathArb,
        fc.array(lspDiagnosticArb, { maxLength: 6 }),
        (initial, server, uri, diags) => {
          const store = fakeStore(initial);
          const before = store.getDiagnostics();
          const otherBefore = Object.entries(before).filter(([k]) => k !== lspSourceKey(uri));

          const bridge = createDiagnosticsBridge({
            setDiagnostics: store.setDiagnostics,
            clearDiagnostics: store.clearDiagnostics,
            getDiagnostics: store.getDiagnostics,
            onFsChanged: async () => () => undefined,
            fsStat: async () => null,
          });
          bridge.onPublishDiagnostics(server, uri, diags);

          const after = store.getDiagnostics();
          const key = lspSourceKey(uri);
          if (diags.length > 0) {
            expect(after[key]).toEqual(mapPublishedDiagnostics(server, uri, diags));
          } else {
            expect(key in after).toBe(false); // empty publish clears the URI entry
          }
          // Every other entry is byte-identical (isolation).
          for (const [k, v] of otherBefore) {
            expect(after[k]).toEqual(v);
          }
          // The key is never a checker key nor another URI's key.
          expect(isLspSourceKey(key)).toBe(true);
          bridge.dispose();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("wires onFsChanged at construction and unsubscribes on dispose (R5.1/R5.5)", async () => {
    const unsub = vi.fn();
    const onFsChanged = vi.fn(async () => unsub);
    const store = fakeStore();
    const bridge = createDiagnosticsBridge({
      setDiagnostics: store.setDiagnostics,
      clearDiagnostics: store.clearDiagnostics,
      getDiagnostics: store.getDiagnostics,
      onFsChanged,
      fsStat: async () => null,
    });
    await Promise.resolve();
    expect(onFsChanged).toHaveBeenCalledTimes(1);
    bridge.dispose();
    await Promise.resolve();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
