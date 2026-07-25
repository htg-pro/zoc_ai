/**
 * terminal-cwd.ts — where a terminal should open, decided in one pure function.
 *
 * The renderer used to make this decision inline while spawning:
 *
 *     ...(cwd ? { cwd } : {})
 *
 * When `cwd` was null the request simply omitted it, and the sidecar spawned the
 * shell in *its own* working directory — which in a packaged build is the
 * application's install/bin path. That is the "terminal opens in the app
 * directory" bug. The omission was easy to miss precisely because it was one
 * expression buried in a spawn call.
 *
 * Pulling it out here makes the rule explicit, mirrors the gateway's
 * `resolve_terminal_cwd`, and makes the five cases that actually occur
 * testable without a PTY: workspace opened, workspace switched, terminal
 * reopened, no workspace, and a workspace folder that has gone away.
 *
 * The renderer's job is only to decide *whether to ask* and *what to ask for*;
 * the gateway independently validates and confines whatever it receives, so a
 * bug here cannot widen the security boundary.
 */

/** Reasons a terminal cannot be started. */
export type TerminalCwdRefusal = "no-workspace";

export type TerminalCwdDecision =
  | { ok: true; cwd: string }
  | { ok: false; reason: TerminalCwdRefusal; message: string };

/** Trailing-separator-insensitive comparison key for a root path. */
export function normalizeRoot(root: string): string {
  const trimmed = root.trim();
  if (!trimmed) return "";
  // Keep a bare "/" (and a bare drive root) intact while dropping any other
  // trailing separator, so "/ws" and "/ws/" compare equal.
  const stripped = trimmed.replace(/[\\/]+$/, "");
  return stripped || trimmed.slice(0, 1);
}

/**
 * Decide the cwd for a new terminal.
 *
 * Returns a refusal when no workspace is open: there is no verified directory to
 * start in, and the product rule is to ask the user to open a folder rather than
 * to start a shell somewhere arbitrary.
 */
export function resolveTerminalCwd(workspaceRoot: string | null | undefined): TerminalCwdDecision {
  const root = (workspaceRoot ?? "").trim();
  if (!root) {
    return {
      ok: false,
      reason: "no-workspace",
      message: "Open a project folder to start a terminal.",
    };
  }
  return { ok: true, cwd: root };
}

/**
 * Whether a terminal started in `existingCwd` still belongs to `workspaceRoot`.
 *
 * Used to decide if a live PTY may be reused after the user switches
 * workspaces. A terminal whose cwd belongs to the previous project must not be
 * silently reused: its shell is still sitting in the old directory, so every
 * subsequent command would run against the wrong project.
 */
export function terminalMatchesWorkspace(
  existingCwd: string | null | undefined,
  workspaceRoot: string | null | undefined,
): boolean {
  const wanted = resolveTerminalCwd(workspaceRoot);
  if (!wanted.ok) return false;
  if (existingCwd == null) return false;
  return normalizeRoot(existingCwd) === normalizeRoot(wanted.cwd);
}
