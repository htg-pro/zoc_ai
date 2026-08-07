// Feature: zoc-ai-agent-chat-overhaul, Property 10: Provider keys round-trip and never appear in diagnostics
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { SECRET_STORAGE_PREFIX, secureStore } from "../secure-store";
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

/**
 * Read the stored value back out of the browser-preview shadow tier.
 *
 * Property 10 is a *round-trip* property, so it needs the value. Task 26.3
 * removed `secureStore.get` — the renderer has no read path any more (R14.2) —
 * and `has` would reduce the round-trip to "something is there", which the
 * property already asserts elsewhere. The prefix is imported so this stays
 * pinned to the real namespace.
 */
const shadow = (key: string): string | null => localStorage.getItem(SECRET_STORAGE_PREFIX + key);

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
          expect(shadow(keyName(providerId))).toBe(key);
          expect(await secureStore.has(keyName(providerId))).toBe(true);

          // A different provider id has no key.
          const other = `${providerId}-other`;
          expect(shadow(keyName(other))).toBeNull();
          expect(await secureStore.has(keyName(other))).toBe(false);

          // The key never lands in the persisted provider *config* — the shape
          // that is serialized into diagnostics/telemetry payloads.
          const providers = loadProviders();
          const serialized = JSON.stringify(providers);
          expect(serialized.includes(key)).toBe(false);

          await secureStore.clear(keyName(providerId));
          expect(shadow(keyName(providerId))).toBeNull();
          expect(await secureStore.has(keyName(providerId))).toBe(false);
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
