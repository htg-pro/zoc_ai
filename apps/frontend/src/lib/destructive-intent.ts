/**
 * Destructive-intent detection (Part 7.1). A pure scan of the user's composer
 * text for phrasing that implies a dangerous operation, so the UI can drop to a
 * cautious autonomy level and warn before running. Dependency-free and
 * unit-testable; the Composer consumes the result to gate its run mode.
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
