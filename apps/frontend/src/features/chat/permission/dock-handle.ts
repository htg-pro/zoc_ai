/**
 * Reaching the approval dock from elsewhere — zoc-agent-chat-rebuild R11.8, R21.3, task 19.1.
 *
 * Two exports, both about the same small problem: the transcript's line for a pending request has to be
 * able to move focus to the dock, and the dock has to be able to move focus to the request inside it.
 *
 * Its own module rather than living beside either component, for the fast-refresh reason the rest of the
 * feature follows — a module exporting both a component and a function is a refresh boundary — and
 * because it keeps `PermissionWaitingRow` from importing `PermissionDock` just to read a string.
 *
 * The dock is *not* scrolled into view, because it is outside the transcript's scroll container by
 * construction (R11.8) and there is therefore nothing to scroll. Focus is the whole mechanism.
 */

/** The dom id the dock carries, and the target the transcript's `Review` control points at. */
export const PERMISSION_DOCK_ID = "zoc-permission-dock";

/**
 * Move focus to the pending request inside `dock`.
 *
 * The request — the row — rather than the dock itself, because the row is what carries the accessible
 * name R21.3 asks for and what handles `A` and `R`. The dock is a fallback for the moment between a
 * request arriving and its row committing, so focus never lands nowhere.
 */
export function focusRequest(dock: HTMLElement | null): void {
  const row = dock?.querySelector<HTMLElement>("[data-zoc-permission-row]");
  (row ?? dock)?.focus();
}
