/**
 * Secure store for API keys. On the Tauri desktop it routes to the OS keychain
 * (Keychain / Credential Manager / libsecret) via `secret_*` commands.
 *
 * The OS keychain is unreliable on Linux desktops: a `secret_set` may appear to
 * succeed against a *session* keyring that is wiped on logout/restart, or the
 * secret service may be missing entirely. To guarantee a key is always read
 * back — both later in the same session and after an app restart — every write
 * is ALSO mirrored to a durable localStorage shadow, and reads fall back to the
 * shadow whenever the keychain has no entry. The keychain stays the preferred
 * source when it works; the shadow is the safety net. In the browser-only
 * preview localStorage is the only backend.
 */
import { isTauri } from "./tauri-bridge";

const PREFIX = "zoc-studio.secret.";

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

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

function shadowGet(key: string): string | null {
  const store = storage();
  const v = store ? store.getItem(PREFIX + key) : null;
  return v && v !== "" ? v : null;
}

function shadowSet(key: string, value: string): void {
  storage()?.setItem(PREFIX + key, value);
}

function shadowClear(key: string): void {
  storage()?.removeItem(PREFIX + key);
}

// Secrets are not a reactive store, but UI surfaces (e.g. the model picker's
// "key set / NO KEY" badge) need to refresh the moment a key is saved or
// cleared in Settings — without a page reload and without depending on an
// unrelated provider-config change. Writers notify; readers subscribe.
const listeners = new Set<() => void>();

function notifySecretsChanged(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* a misbehaving listener must not break a write */
    }
  }
}

/** Subscribe to secret writes/clears. Returns an unsubscribe fn. */
export function subscribeSecrets(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const secureStore = {
  async get(key: string): Promise<string | null> {
    if (isTauri()) {
      try {
        const v = await tauriInvoke<string | null>("secret_get", { key });
        // Keychain hit wins; a miss (null) or failure falls back to the durable
        // shadow so a key is found even when the keychain is flaky or was wiped
        // (e.g. a Linux session keyring cleared on restart).
        if (v != null && v !== "") return v;
      } catch {
        /* keychain unavailable — use the shadow */
      }
    }
    return shadowGet(key);
  },
  async set(key: string, value: string): Promise<void> {
    // Always persist to the durable shadow first so the key survives a flaky or
    // non-persistent keychain. Then best-effort write the OS keychain too.
    shadowSet(key, value);
    if (isTauri()) {
      try {
        await tauriInvoke("secret_set", { key, value });
      } catch {
        /* keychain unavailable — the shadow already holds the value */
      }
    }
    notifySecretsChanged();
  },
  async clear(key: string): Promise<void> {
    if (isTauri()) {
      try {
        await tauriInvoke("secret_clear", { key });
      } catch {
        /* ignore */
      }
    }
    // Always clear the shadow too, regardless of backend.
    shadowClear(key);
    notifySecretsChanged();
  },
};
