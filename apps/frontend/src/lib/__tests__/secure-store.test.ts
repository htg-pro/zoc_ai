import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { SECRET_STORAGE_PREFIX, secureStore, subscribeSecrets } from "@/lib/secure-store";

/**
 * In the (non-Tauri) test environment secureStore must behave as a symmetric
 * localStorage-backed store: a value written with `set` is readable, and
 * `clear` removes it. This guards the regression where a saved provider key was
 * written to the localStorage shadow but never read back — leaving the model
 * picker stuck on "NO KEY" and the agent panel unable to connect.
 *
 * **These assertions read the shadow directly rather than through the façade.**
 * Task 26.3 removed `secureStore.get`, and `has` is the only remaining reader —
 * a boolean, which cannot tell "first" from "second" and would make the
 * overwrite and isolation cases pass without checking anything. Reading
 * `localStorage` under the exported prefix keeps a real oracle; the prefix is
 * imported rather than re-declared so a rename fails loudly instead of
 * silently reading `null` everywhere.
 *
 * The vitest jsdom localStorage shim here only implements get/setItem, so we
 * stub a full Map-backed Storage for these symmetry checks.
 */
const realLocalStorage = globalThis.localStorage;

/** What `set`/`clear` actually left in the browser-preview shadow tier. */
const shadow = (key: string): string | null => localStorage.getItem(SECRET_STORAGE_PREFIX + key);

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

  it("round-trips a written value, and `has` agrees with the shadow", async () => {
    expect(shadow("provider.groq.api_key")).toBeNull();
    expect(await secureStore.has("provider.groq.api_key")).toBe(false);
    await secureStore.set("provider.groq.api_key", "gsk_test_123");
    expect(shadow("provider.groq.api_key")).toBe("gsk_test_123");
    expect(await secureStore.has("provider.groq.api_key")).toBe(true);
  });

  it("overwrites an existing value", async () => {
    await secureStore.set("k", "first");
    await secureStore.set("k", "second");
    expect(shadow("k")).toBe("second");
  });

  it("clears a stored value", async () => {
    await secureStore.set("k", "value");
    await secureStore.clear("k");
    expect(shadow("k")).toBeNull();
    expect(await secureStore.has("k")).toBe(false);
  });

  it("isolates keys behind the namespacing prefix", async () => {
    await secureStore.set("a", "1");
    await secureStore.set("b", "2");
    expect(shadow("a")).toBe("1");
    expect(shadow("b")).toBe("2");
    await secureStore.clear("a");
    expect(shadow("a")).toBeNull();
    expect(shadow("b")).toBe("2");
  });

  it("exposes no read path for a key value (R14.2)", () => {
    expect(secureStore).not.toHaveProperty("get");
    expect(Object.keys(secureStore).sort()).toEqual(["clear", "has", "set", "status"]);
  });

  it("notifies subscribers with the exact key on set and clear", async () => {
    const cb = vi.fn();
    const unsub = subscribeSecrets(cb);
    await secureStore.set("provider.openai.api_key", "v");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith("provider.openai.api_key");
    await secureStore.clear("provider.openai.api_key");
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith("provider.openai.api_key");
    unsub();
    await secureStore.set("provider.openai.api_key", "v2");
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
