/**
 * Auto-update client (§11.3).
 *
 * Wraps Tauri's updater plugin behind a small, testable surface. Two design
 * choices matter:
 *
 * - **Non-blocking.** The check runs in the background and its only effect is a
 *   dismissible notification bar. A failed or disabled updater is
 *   indistinguishable from "no update", so a broken release channel can never
 *   block the app from starting.
 * - **Respects a dismissal.** Choosing "later" suppresses the bar for
 *   {@link DISMISS_WINDOW_MS} (24 h), persisted per version so a *newer* release
 *   still gets to announce itself.
 *
 * The plugin is imported dynamically because it only exists inside the desktop
 * shell; in the browser preview every function degrades to a no-op.
 */

/** How long a dismissal suppresses the update bar. */
export const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;

const DISMISS_KEY = "zoc:update-dismissed";

/** GitHub releases page opened by "Release notes". */
export const RELEASES_URL = "https://github.com/zoc-studio/zoc-studio/releases";

/** GitHub API endpoint for the release notes of a specific tag. */
export function releaseNotesApiUrl(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://api.github.com/repos/zoc-studio/zoc-studio/releases/tags/${tag}`;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

/** Minimal shape we need from the updater plugin's `Update` object. */
interface UpdateHandle {
  available?: boolean;
  version: string;
  currentVersion: string;
  body?: string | null;
  date?: string | null;
  downloadAndInstall: () => Promise<void>;
}

let pending: UpdateHandle | null = null;

async function updaterModule(): Promise<{
  check: () => Promise<UpdateHandle | null>;
} | null> {
  try {
    return (await import("@tauri-apps/plugin-updater")) as unknown as {
      check: () => Promise<UpdateHandle | null>;
    };
  } catch {
    // Plugin not installed / not in the desktop shell.
    return null;
  }
}

interface DismissRecord {
  version: string;
  at: number;
}

function readDismissal(storage: Pick<Storage, "getItem">): DismissRecord | null {
  try {
    const raw = storage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DismissRecord;
    if (typeof parsed?.version !== "string" || typeof parsed?.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Whether the bar for `version` is currently suppressed.
 *
 * Keyed by version *and* timestamp: a dismissal only silences the release it was
 * made for, and only for the window — so a user who says "later" is asked again
 * tomorrow, and immediately for a newer build.
 */
export function isDismissed(
  version: string,
  now: number,
  storage: Pick<Storage, "getItem">,
): boolean {
  const record = readDismissal(storage);
  if (!record || record.version !== version) return false;
  return now - record.at < DISMISS_WINDOW_MS;
}

/** Suppress the bar for `version` for the next 24 h. */
export function dismissUpdate(
  version: string,
  now: number,
  storage: Pick<Storage, "setItem">,
): void {
  try {
    storage.setItem(DISMISS_KEY, JSON.stringify({ version, at: now }));
  } catch {
    /* private mode / storage disabled — worst case the bar reappears */
  }
}

/**
 * Check for an update.
 *
 * Returns `null` when up to date, when the updater is disabled or unconfigured,
 * or when the endpoint is unreachable. All three are the same to the caller by
 * design: an update check must never surface an error to the user.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const mod = await updaterModule();
  if (!mod) return null;
  try {
    const update = await mod.check();
    if (!update || update.available === false) {
      pending = null;
      return null;
    }
    pending = update;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? null,
      date: update.date ?? null,
    };
  } catch {
    pending = null;
    return null;
  }
}

/**
 * Download + install the pending update, then relaunch.
 *
 * Throws on failure so the caller can surface it: unlike the check, an update
 * the user explicitly asked for must report when it did not work.
 */
export async function installUpdate(): Promise<void> {
  if (!pending) throw new Error("No update is pending");
  await pending.downloadAndInstall();
  const process = await import("@tauri-apps/plugin-process").catch(() => null);
  if (process) await process.relaunch();
}

/** Open the releases page in the system browser. */
export async function openReleaseNotes(): Promise<void> {
  try {
    const shell = await import("@tauri-apps/plugin-shell");
    await shell.open(RELEASES_URL);
  } catch {
    if (typeof window !== "undefined") window.open(RELEASES_URL, "_blank", "noopener");
  }
}

/**
 * Fetch the release notes body for `version` from the GitHub API.
 *
 * Returns `null` on any failure (rate limit, offline, unknown tag) — release
 * notes are a nicety, not something worth an error state for.
 */
export async function fetchReleaseNotes(version: string): Promise<string | null> {
  try {
    const res = await fetch(releaseNotesApiUrl(version), {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { body?: string };
    return body.body?.trim() || null;
  } catch {
    return null;
  }
}

/** Test seam: clear the cached pending update. */
export function __resetUpdateStateForTests(): void {
  pending = null;
}
