// Feature: zoc-ai-agent-chat-overhaul, Property 6: Local model records survive a persistence round trip
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { type LocalModel, saveLocalModels } from "../local-models";

const MODELS_KEY = "zoc-studio.local-models.v1";

const realLocalStorage = globalThis.localStorage;
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** Read the persisted records straight from storage — a "fresh registry". */
function readPersisted(): LocalModel[] {
  const raw = localStorage.getItem(MODELS_KEY);
  return raw ? (JSON.parse(raw) as LocalModel[]) : [];
}

describe("local model persistence (Property 6)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
  });

  it("round-trips absolute path, display name, and readiness override", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1 }),
            name: fc.string({ minLength: 1 }),
            path: fc.string({ minLength: 1 }).map((s) => `/models/${s.replace(/\//g, "_")}.gguf`),
            readiness_deadline_secs: fc.option(fc.integer({ min: 30, max: 600 }), { nil: undefined }),
          }),
          { maxLength: 12 },
        ),
        (records) => {
          // De-dupe by id so the round-trip comparison is unambiguous.
          const byId = new Map(records.map((r) => [r.id, r]));
          const models = Array.from(byId.values()) as LocalModel[];

          saveLocalModels(models);
          const readBack = readPersisted();

          expect(readBack.length).toBe(models.length);
          const readById = new Map(readBack.map((m) => [m.id, m]));
          for (const original of models) {
            const round = readById.get(original.id);
            expect(round).toBeDefined();
            expect(round?.path).toBe(original.path);
            expect(round?.name).toBe(original.name);
            expect(round?.readiness_deadline_secs).toBe(original.readiness_deadline_secs);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
