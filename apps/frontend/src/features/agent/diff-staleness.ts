/**
 * diff-staleness.ts — decide whether a proposed diff is stale by comparing the
 * file's *current* content hash / existence to the recorded `baseHash` (R12.7).
 *
 * The prior implementation derived "stale" from an `edit-file` frame's `failed`
 * status, which is wrong on two counts: a failed apply is not the same as the
 * user's working tree drifting under a still-pending review, and a genuinely
 * stale file whose edit never failed was never flagged. Staleness is a property
 * of the file on disk relative to the baseline the proposal was computed
 * against, so it is decided here — from a probe of the current file — not from
 * any run-status field.
 *
 * Pure and injectable: the probe (existence + SHA-256 of the current content)
 * is supplied by the caller, so the decision is testable without a filesystem
 * and the production probe (`@/lib/tauri-bridge` read + Web Crypto) lives at the
 * edge.
 */

/** A probe of the current on-disk file the diff was proposed against. */
export interface FileProbe {
  /** Whether the file currently exists. */
  exists: boolean;
  /** SHA-256 (lowercase hex) of the current content, or null if unreadable. */
  sha256: string | null;
}

/**
 * Whether a single proposed file is stale relative to its recorded baseline.
 *
 * Decision table (R12.7):
 *  - No recorded `baseHash` → cannot compare → NOT stale (we never invent
 *    staleness, and never derive it from a failed status).
 *  - `baseHash` recorded, file now missing → stale (the baseline is gone).
 *  - `baseHash` recorded, current hash known and differs → stale.
 *  - `baseHash` recorded, current hash known and equal → NOT stale.
 *  - `baseHash` recorded, current hash unknown (unreadable) but file exists →
 *    NOT stale (no positive evidence of divergence; avoid false alarms).
 */
export function fileStale(baseHash: string | null, probe: FileProbe | null): boolean {
  if (!baseHash) return false;
  if (!probe) return false;
  if (!probe.exists) return true;
  if (probe.sha256 === null) return false;
  return probe.sha256.toLowerCase() !== baseHash.toLowerCase();
}

/** Whether any file in a diff is stale, given a probe map keyed by path. */
export function anyFileStale(
  files: readonly { path: string; baseHash: string | null }[],
  probes: ReadonlyMap<string, FileProbe | null>,
): boolean {
  return files.some((file) => fileStale(file.baseHash, probes.get(file.path) ?? null));
}

/**
 * Compute the SHA-256 (lowercase hex) of a string using Web Crypto. Returns
 * null when Web Crypto is unavailable (e.g. a non-secure context), so callers
 * treat the file as "hash unknown" rather than diverged.
 */
export async function sha256Hex(content: string): Promise<string | null> {
  const subtle =
    typeof globalThis.crypto !== "undefined" ? globalThis.crypto.subtle : undefined;
  if (!subtle) return null;
  try {
    const bytes = new TextEncoder().encode(content);
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}
