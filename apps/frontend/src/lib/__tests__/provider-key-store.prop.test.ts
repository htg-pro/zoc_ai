// Feature: zoc-ai-agent-chat-overhaul, Property 10: Provider keys round-trip and never appear in diagnostics
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { secureStore } from "../secure-store";
import { loadProviders, saveProviders } from "../providers";

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

const keyName = (id: string): string => `provider.${id}.api_key`;

describe("provider key round-trip (Property 10)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
  });

  it("stores and reads a key back under its provider id, leaving others absent", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).map((s) => s.replace(/[^a-z0-9-]/gi, "") || "openai"),
        fc.hexaString({ minLength: 16, maxLength: 48 }).map((s) => `sk-${s}`),
        async (providerId, key) => {
          await secureStore.set(keyName(providerId), key);
          const readBack = await secureStore.get(keyName(providerId));
          expect(readBack).toBe(key);

          // A different provider id has no key.
          const other = `${providerId}-other`;
          expect(await secureStore.get(keyName(other))).toBeNull();

          // The key never lands in the persisted provider *config* — the shape
          // that is serialized into diagnostics/telemetry payloads.
          const providers = loadProviders();
          const serialized = JSON.stringify(providers);
          expect(serialized.includes(key)).toBe(false);

          await secureStore.clear(keyName(providerId));
          expect(await secureStore.get(keyName(providerId))).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps the key out of a saved provider catalogue", () => {
    saveProviders(loadProviders());
    const raw = localStorage.getItem("zoc-studio.providers.v1") ?? "";
    expect(raw.includes("api_key")).toBe(false);
  });
});
