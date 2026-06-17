import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { secureStore, subscribeSecrets } from "@/lib/secure-store";

/**
 * In the (non-Tauri) test environment secureStore must behave as a symmetric
 * localStorage-backed store: a value written with `set` is read back by `get`,
 * and `clear` removes it. This guards the regression where a saved provider key
 * was written to the localStorage shadow but `get` never consulted it — leaving
 * the model picker stuck on "NO KEY" and the agent panel unable to connect.
 *
 * The vitest jsdom localStorage shim here only implements get/setItem, so we
 * stub a full Map-backed Storage for these symmetry checks.
 */
const realLocalStorage = globalThis.localStorage;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  } as Storage;
}

describe("secureStore (browser fallback)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
  });

  it("round-trips a written value through get", async () => {
    expect(await secureStore.get("provider.groq.api_key")).toBeNull();
    await secureStore.set("provider.groq.api_key", "gsk_test_123");
    expect(await secureStore.get("provider.groq.api_key")).toBe("gsk_test_123");
  });

  it("overwrites an existing value", async () => {
    await secureStore.set("k", "first");
    await secureStore.set("k", "second");
    expect(await secureStore.get("k")).toBe("second");
  });

  it("clears a stored value", async () => {
    await secureStore.set("k", "value");
    await secureStore.clear("k");
    expect(await secureStore.get("k")).toBeNull();
  });

  it("isolates keys behind the namespacing prefix", async () => {
    await secureStore.set("a", "1");
    await secureStore.set("b", "2");
    expect(await secureStore.get("a")).toBe("1");
    expect(await secureStore.get("b")).toBe("2");
    await secureStore.clear("a");
    expect(await secureStore.get("a")).toBeNull();
    expect(await secureStore.get("b")).toBe("2");
  });

  it("notifies subscribers on set and clear", async () => {
    const cb = vi.fn();
    const unsub = subscribeSecrets(cb);
    await secureStore.set("k", "v");
    expect(cb).toHaveBeenCalledTimes(1);
    await secureStore.clear("k");
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    await secureStore.set("k", "v2");
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
