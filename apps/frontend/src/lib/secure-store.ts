/**
 * Secure-store stub. In Phase 4 this will route to a Tauri command that wraps
 * the OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret
 * on Linux). For now we transparently shim to localStorage so the Settings UI
 * has a functional persistence layer in the browser-only preview.
 */
const PREFIX = "llama-studio.secret.";

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (
    typeof localStorage.getItem !== "function" ||
    typeof localStorage.setItem !== "function" ||
    typeof localStorage.removeItem !== "function"
  ) {
    return null;
  }
  return localStorage;
}

export const secureStore = {
  async get(key: string): Promise<string | null> {
    try {
      const tauri = await import("@tauri-apps/api/core").catch(() => null);
      if (tauri) {
        try {
          return (await tauri.invoke<string | null>("secret_get", { key })) ?? null;
        } catch {
          /* fall through */
        }
      }
    } catch {
      /* ignore */
    }
    const store = storage();
    if (!store) return null;
    return store.getItem(PREFIX + key);
  },
  async set(key: string, value: string): Promise<void> {
    try {
      const tauri = await import("@tauri-apps/api/core").catch(() => null);
      if (tauri) {
        try {
          await tauri.invoke("secret_set", { key, value });
          return;
        } catch {
          /* fall through */
        }
      }
    } catch {
      /* ignore */
    }
    const store = storage();
    if (store) store.setItem(PREFIX + key, value);
  },
  async clear(key: string): Promise<void> {
    try {
      const tauri = await import("@tauri-apps/api/core").catch(() => null);
      if (tauri) {
        try {
          await tauri.invoke("secret_clear", { key });
          return;
        } catch {
          /* fall through */
        }
      }
    } catch {
      /* ignore */
    }
    const store = storage();
    if (store) store.removeItem(PREFIX + key);
  },
};
