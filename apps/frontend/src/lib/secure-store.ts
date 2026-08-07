/**
 * Renderer secret façade — zoc-agent-chat-rebuild R14.2, R14.3, R23.5.
 *
 * **R14.2 is structural as of task 26.3.** There is no `get`. The renderer can
 * ask whether a key exists, write one, and clear one; it cannot read one back,
 * and the `secret_get` capability behind that read is revoked in
 * `apps/desktop/capabilities/default.json`. Both halves matter — removing the
 * method alone leaves the door open, and revoking the capability alone would
 * have been *worse* than doing nothing, because `get`'s vault-unavailable
 * `catch` fell through to the `localStorage` shadow: every caller would have
 * silently started reading plaintext out of renderer-accessible storage while a
 * capability-set test reported success.
 *
 * The three callers that made this a real read path — `Providers.tsx`'s key
 * field, `active-model-context.ts`, and `store.ts`'s `resolveProviderCreds` —
 * were repointed first. Each of them wanted one of two things the value was
 * never needed for: whether a key exists (`has`), or a credential the service
 * on the other end resolves for itself (R7.8).
 *
 * What ships: `has(key)`, `set`/`clear` routed through the three-tier vault,
 * the backend-status query, and the one-shot migration that empties the
 * `localStorage` shadow (R14.3).
 *
 * The shadow is the thing being removed. Its own header comment used to explain
 * why it existed — a `secret_set` on Linux can report success against a session
 * keyring that is wiped on logout — and that reason was correct. The durability
 * problem is now solved on the Rust side by the vault's write-then-read-back
 * probe, so the renderer no longer needs to keep a plaintext copy in a store any
 * renderer-side script can read.
 */
import { isTauri } from "./tauri-bridge";

/**
 * Namespace for the browser-preview shadow.
 *
 * Exported for the tests that assert on the shadow tier directly. With `get`
 * gone they have no other way to observe what `set`/`clear` wrote, and a test
 * that re-declared this string would keep passing vacuously if the prefix ever
 * changed.
 */
export const SECRET_STORAGE_PREFIX = "zoc-studio.secret.";

const PREFIX = SECRET_STORAGE_PREFIX;

/** Set once the one-shot sweep has run, so it cannot run twice (R14.3). */
const MIGRATION_MARKER = "zoc-studio.secret-migration.v1";

export type SecretBackend = "keychain" | "vault" | "degraded";

export interface SecretStatus {
  backend: SecretBackend;
  degraded: boolean;
  reason: string | null;
}

export interface SecretWriteResult {
  backend: SecretBackend;
  durable: boolean;
}

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
  const value = store ? store.getItem(PREFIX + key) : null;
  return value && value !== "" ? value : null;
}

function shadowClear(key: string): void {
  storage()?.removeItem(PREFIX + key);
}

// Secrets are not a reactive store, but UI surfaces (the model picker's
// "key set / NO KEY" badge) need to refresh the moment a key is saved or cleared
// in Settings — without a page reload and without depending on an unrelated
// provider-config change. Writers notify; readers subscribe.
//
// Kept verbatim from the previous implementation: the badge's refresh path is
// working behaviour with existing subscribers, and rewriting it here would be a
// regression risk for no gain.
const listeners = new Set<(key: string) => void>();

function notifySecretsChanged(key: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(key);
    } catch {
      /* a misbehaving listener must not break a write */
    }
  }
}

/** Subscribe to secret writes/clears. The callback receives the changed key. */
export function subscribeSecrets(cb: (key: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const secureStore = {
  /**
   * Does a key exist? This is what `hasKey` is built on (R14.2).
   *
   * A boolean rather than a nullable string is the whole point: the renderer's
   * legitimate need is to know whether a provider is configured, and that need
   * never requires the value.
   */
  async has(key: string): Promise<boolean> {
    if (isTauri()) {
      try {
        return await tauriInvoke<boolean>("secret_has", { key });
      } catch {
        /* fall through */
      }
    }
    return shadowGet(key) !== null;
  },

  /**
   * Store a key through the three-tier vault.
   *
   * No `localStorage` mirror. The vault's durability probe is what replaced it:
   * a write only reports success once it has been read back through a fresh
   * handle, so the renderer has nothing to compensate for.
   */
  async set(key: string, value: string): Promise<SecretWriteResult> {
    if (isTauri()) {
      const result = await tauriInvoke<SecretWriteResult>("secret_set", { key, value });
      notifySecretsChanged(key);
      return result;
    }
    // Browser-only preview: there is no vault, and a key still has to be
    // storable for the preview to be usable at all. This path is the one place
    // `localStorage` still holds a value, and it is not reachable in the
    // packaged app.
    storage()?.setItem(PREFIX + key, value);
    notifySecretsChanged(key);
    return { backend: "degraded", durable: false };
  },

  async clear(key: string): Promise<void> {
    if (isTauri()) {
      try {
        await tauriInvoke<void>("secret_clear", { key });
      } catch {
        /* ignore: the shadow clear below still runs */
      }
    }
    shadowClear(key);
    notifySecretsChanged(key);
  },

  /** Backend label and degraded reason for the settings notice (R14.8). */
  async status(): Promise<SecretStatus> {
    if (isTauri()) {
      try {
        return await tauriInvoke<SecretStatus>("secret_backend_status", {});
      } catch {
        /* fall through */
      }
    }
    return {
      backend: "degraded",
      degraded: true,
      reason: "Running outside the desktop app, so keys are not stored securely.",
    };
  },
};

// ── One-shot migration off the localStorage shadow (R14.3, R23.5) ──────────

export interface MigrationOutcome {
  /** Keys moved into the vault. */
  migrated: string[];
  /** Keys that could not be moved, so were left in place rather than lost. */
  failed: string[];
  /** True when the marker was already set and nothing was attempted. */
  skipped: boolean;
}

/**
 * Move every `zoc-studio.secret.*` value into the vault and remove it.
 *
 * Values pass through the renderer exactly once, during this sweep — and they
 * are already sitting in the renderer's own storage, so the migration *reduces*
 * exposure rather than creating it. That asymmetry is why the sweep is allowed
 * to touch values at all when R14.2 otherwise forbids it.
 *
 * A key is removed from `localStorage` only after `secret_set` reports success.
 * The alternative ordering — remove then store — turns a vault write failure
 * into a lost credential.
 */
export async function migrateSecretShadow(): Promise<MigrationOutcome> {
  const store = storage();
  if (!store || !isTauri()) return { migrated: [], failed: [], skipped: true };
  if (store.getItem(MIGRATION_MARKER) !== null) {
    return { migrated: [], failed: [], skipped: true };
  }

  const shadowed: Array<{ storageKey: string; key: string; value: string }> = [];
  for (let i = 0; i < store.length; i += 1) {
    const storageKey = store.key(i);
    if (storageKey === null || !storageKey.startsWith(PREFIX)) continue;
    const value = store.getItem(storageKey);
    if (value === null || value === "") continue;
    shadowed.push({ storageKey, key: storageKey.slice(PREFIX.length), value });
  }

  const migrated: string[] = [];
  const failed: string[] = [];
  for (const entry of shadowed) {
    try {
      await tauriInvoke<SecretWriteResult>("secret_set", {
        key: entry.key,
        value: entry.value,
      });
      store.removeItem(entry.storageKey);
      migrated.push(entry.key);
    } catch {
      // Left in place on purpose. A key that failed to migrate is still a key
      // the user needs, and the sweep runs again on the next boot because the
      // marker is only written when nothing failed.
      failed.push(entry.key);
    }
  }

  if (failed.length === 0) {
    store.setItem(MIGRATION_MARKER, new Date().toISOString());
  }
  for (const key of migrated) notifySecretsChanged(key);

  return { migrated, failed, skipped: false };
}

/**
 * Fail loudly if any shadow key survives.
 *
 * Called from the integration test rather than from app startup: in the app a
 * surviving key is a degraded state to retry, but in the test it is the
 * assertion that R14.3 actually happened.
 */
export function assertNoSecretShadow(): void {
  const store = storage();
  if (!store) return;
  const leftover: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key !== null && key.startsWith(PREFIX)) leftover.push(key);
  }
  if (leftover.length > 0) {
    // Key *names*, never values — this message can reach a log.
    throw new Error(
      `R14.3 violated: ${leftover.length} secret(s) remain in localStorage ` +
        `(${leftover.join(", ")}). The migration sweep did not complete.`,
    );
  }
}
