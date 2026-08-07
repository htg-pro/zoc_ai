/**
 * Destructive-intent detection — one ruleset, shared by the gate and the composer's pre-flight warning (R11.6).
 *
 * Feature: zoc-agent-chat-rebuild, R11.6.
 *
 * **A copy, not a move** — zoc-agent-chat-rebuild task 8.1.
 *
 * The `lib` original at `apps/frontend/src/lib/destructive-intent.ts` stays in place until
 * task 26.2 deletes it, because the Legacy_Panel still imports from it. The
 * duplication is deliberate and time-boxed to the cutover.
 *
 * **While both copies exist, this one is authoritative for every gating
 * decision.** No code path consults both, so there is no divergence window: the
 * runtime gate reads only this module, and the legacy panel reads only the
 * original. Logic is unchanged from the original, so a diff between the two is a
 * bug in whichever one drifted.
 */

export interface DestructiveIntent {
  destructive: boolean;
  /** A short human label for the matched pattern, or `null` when none matched. */
  matched: string | null;
}

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdelete\s+all\b/i, "delete all"],
  [/\bdrop\s+(?:table|database|schema)\b/i, "drop table"],
  [/\btruncate\s+table\b/i, "truncate table"],
  [/\brm\s+-[a-z]*r[a-z]*f\b/i, "rm -rf"],
  [/\brm\s+-[a-z]*f[a-z]*r\b/i, "rm -rf"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f"],
  [/\bgit\s+push\b.*(?:--force\b|\s-f\b)/i, "git push --force"],
  [/\bmkfs\b/i, "mkfs"],
  [/\bformat\s+[a-z]:/i, "format drive"],
  [/\bdd\s+if=.*\bof=\/dev\//i, "dd to device"],
  [/\bDROP\s+DATABASE\b/i, "drop database"],
];

/** Scan `text` for destructive intent, returning the first matched pattern. */
export function detectDestructiveIntent(text: string): DestructiveIntent {
  for (const [pattern, label] of PATTERNS) {
    if (pattern.test(text)) return { destructive: true, matched: label };
  }
  return { destructive: false, matched: null };
}
