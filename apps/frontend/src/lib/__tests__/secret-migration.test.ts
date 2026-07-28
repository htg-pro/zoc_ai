/**
 * localStorage shadow migration — zoc-agent-chat-rebuild R14.3, R23.5.
 *
 * The sweep's two failure modes are worth more than its happy path, and both are
 * asserted here: a key must not be removed from `localStorage` before the vault
 * has accepted it, and the marker must not be written while any key still
 * failed — otherwise the retry never happens and the key is stranded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PREFIX = "zoc-studio.secret.";
const MARKER = "zoc-studio.secret-migration.v1";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => invoke(cmd, args),
}));

async function loadModule() {
  vi.resetModules();
  return await import("../secure-store");
}

/**
 * A real Storage, installed explicitly.
 *
 * Not relying on jsdom's: the shared setup file and sibling suites both touch
 * the global, and this suite's assertions are about exact key presence, so it
 * needs a store it fully owns.
 */
function installStorage(): Storage {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
    writable: true,
  });
  return store;
}

function pretendTauri(present: boolean): void {
  if (present) {
    const scope = globalThis as unknown as { window?: Record<string, unknown> };
    scope.window ??= {};
    (scope.window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

beforeEach(() => {
  installStorage();
  invoke.mockReset();
  pretendTauri(true);
});

afterEach(() => {
  pretendTauri(false);
});

describe("migrateSecretShadow (R14.3)", () => {
  it("moves every shadowed key into the vault and removes it", async () => {
    localStorage.setItem(`${PREFIX}provider.openai`, "sk-openai");
    localStorage.setItem(`${PREFIX}provider.groq`, "gsk-groq");
    localStorage.setItem("unrelated.key", "keep-me");
    invoke.mockResolvedValue({ backend: "keychain", durable: true });

    const { migrateSecretShadow, assertNoSecretShadow } = await loadModule();
    const outcome = await migrateSecretShadow();

    expect(outcome.skipped).toBe(false);
    expect(outcome.migrated.sort()).toEqual(["provider.groq", "provider.openai"]);
    expect(outcome.failed).toEqual([]);
    expect(localStorage.getItem(`${PREFIX}provider.openai`)).toBeNull();
    expect(localStorage.getItem(`${PREFIX}provider.groq`)).toBeNull();
    // An unrelated key is not the sweep's business.
    expect(localStorage.getItem("unrelated.key")).toBe("keep-me");
    expect(localStorage.getItem(MARKER)).not.toBeNull();
    expect(() => assertNoSecretShadow()).not.toThrow();

    expect(invoke).toHaveBeenCalledWith("secret_set", {
      key: "provider.openai",
      value: "sk-openai",
    });
  });

  it("does not run twice", async () => {
    localStorage.setItem(MARKER, "2026-01-01T00:00:00.000Z");
    localStorage.setItem(`${PREFIX}provider.openai`, "sk-openai");
    const { migrateSecretShadow } = await loadModule();

    const outcome = await migrateSecretShadow();

    expect(outcome.skipped).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(`${PREFIX}provider.openai`)).toBe("sk-openai");
  });

  it("leaves a key in place when the vault write fails", async () => {
    localStorage.setItem(`${PREFIX}provider.openai`, "sk-openai");
    invoke.mockRejectedValue(new Error("vault unavailable"));

    const { migrateSecretShadow, assertNoSecretShadow } = await loadModule();
    const outcome = await migrateSecretShadow();

    expect(outcome.failed).toEqual(["provider.openai"]);
    expect(outcome.migrated).toEqual([]);
    expect(localStorage.getItem(`${PREFIX}provider.openai`)).toBe("sk-openai");
    // No marker: the sweep must be retried on the next boot.
    expect(localStorage.getItem(MARKER)).toBeNull();
    expect(() => assertNoSecretShadow()).toThrow(/R14\.3 violated/);
  });

  it("migrates the keys it can and retries the rest next boot", async () => {
    localStorage.setItem(`${PREFIX}a`, "va");
    localStorage.setItem(`${PREFIX}b`, "vb");
    invoke.mockImplementation((_cmd: string, args: Record<string, unknown>) =>
      args.key === "a"
        ? Promise.resolve({ backend: "vault", durable: true })
        : Promise.reject(new Error("nope")),
    );

    const { migrateSecretShadow } = await loadModule();
    const outcome = await migrateSecretShadow();

    expect(outcome.migrated).toEqual(["a"]);
    expect(outcome.failed).toEqual(["b"]);
    expect(localStorage.getItem(`${PREFIX}a`)).toBeNull();
    expect(localStorage.getItem(`${PREFIX}b`)).toBe("vb");
    expect(localStorage.getItem(MARKER)).toBeNull();
  });

  it("skips empty shadow values rather than storing a blank key", async () => {
    localStorage.setItem(`${PREFIX}provider.openai`, "");
    invoke.mockResolvedValue({ backend: "keychain", durable: true });

    const { migrateSecretShadow } = await loadModule();
    const outcome = await migrateSecretShadow();

    expect(outcome.migrated).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is a no-op outside the desktop shell", async () => {
    pretendTauri(false);
    localStorage.setItem(`${PREFIX}provider.openai`, "sk-openai");
    const { migrateSecretShadow } = await loadModule();

    expect((await migrateSecretShadow()).skipped).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("has() replaces get() for the renderer (R14.2)", () => {
  it("asks secret_has and never secret_get", async () => {
    invoke.mockResolvedValue(true);
    const { secureStore } = await loadModule();

    await expect(secureStore.has("provider.openai")).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("secret_has", { key: "provider.openai" });
    expect(invoke).not.toHaveBeenCalledWith("secret_get", expect.anything());
  });

  it("does not mirror a value into localStorage on set", async () => {
    invoke.mockResolvedValue({ backend: "keychain", durable: true });
    const { secureStore } = await loadModule();

    await secureStore.set("provider.openai", "sk-openai");

    // The shadow is what R14.3 removes; a write must not recreate it.
    expect(localStorage.getItem(`${PREFIX}provider.openai`)).toBeNull();
  });

  it("reports a degraded backend so the notice can render", async () => {
    invoke.mockResolvedValue({
      backend: "degraded",
      degraded: true,
      reason: "No OS secret service is available on this system.",
    });
    const { secureStore } = await loadModule();

    const status = await secureStore.status();

    expect(status.degraded).toBe(true);
    expect(status.reason).not.toContain("/");
  });
});
