/**
 * session-origin.ts — the pure foreign-session predicate (R15.7).
 *
 * A session created against another workspace must be marked foreign and
 * require explicit confirmation before it is activated, so a session scoped to
 * a different project cannot silently retarget the agent.
 */

export type SessionOrigin =
  | { kind: "current" }
  | { kind: "foreign"; basename: string; requiresConfirmation: true };

/** Trailing path segment of a workspace root, for the confirmation label. */
export function rootBasename(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, "");
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  const base = trimmed.split(sep).pop() ?? "";
  if (base.length > 0) return base;
  // Degenerate root (only separators, or empty after trimming): fall back to
  // the original root so the label is never empty.
  return root.trim().length > 0 ? root : "workspace";
}

function canonical(root: string): string {
  return root.replace(/[/\\]+$/, "");
}

/**
 * The three facts a session row must display (R15.3): its title, its
 * last-activity timestamp, and the basename of the workspace it is bound to.
 * Pure so the list rendering and its property test share one projection.
 */
export interface SessionListItem {
  id: string;
  title: string;
  /** ISO timestamp shown as the last-activity label. */
  lastActivity: string;
  /** Trailing segment of the session's workspace root; never empty. */
  rootBasename: string;
}

export function sessionListItem(session: {
  id: string;
  title: string;
  updated_at: string;
  workspace_root: string;
}): SessionListItem {
  return {
    id: session.id,
    title: session.title,
    lastActivity: session.updated_at,
    rootBasename: rootBasename(session.workspace_root ?? ""),
  };
}

/**
 * Classify a session against the resolved workspace root. Foreign exactly when
 * the roots differ (including when no root is currently resolved).
 */
export function sessionOrigin(sessionRoot: string, resolvedRoot: string | null): SessionOrigin {
  if (resolvedRoot !== null && canonical(sessionRoot) === canonical(resolvedRoot)) {
    return { kind: "current" };
  }
  return { kind: "foreign", basename: rootBasename(sessionRoot), requiresConfirmation: true };
}
