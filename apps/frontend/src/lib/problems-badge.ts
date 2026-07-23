/**
 * Problems_Badge derivation (design.md §3.2, Requirement 4).
 *
 * A single pure function the badge surfaces share (the Bottom_Dock "Problems"
 * pill and the StatusBar diagnostics indicator), so count, color, and
 * visibility are one deterministic function of the Diagnostics_Store contents.
 * Because it is recomputed on every store change, R4.6 (the badge updates when
 * the store changes) falls out for free at the call sites.
 */

import type { Diagnostic } from "@/lib/problem-matchers";

export type BadgeColor = "error" | "warning" | "none";

export interface ProblemsBadge {
  /** R4.1: total error + warning diagnostics across all sources. */
  count: number;
  /** R4.3/R4.4/R4.5: error if any error, else warning if any warning, else none. */
  color: BadgeColor;
  /** R4.2/R4.5: visible iff count > 0. */
  visible: boolean;
}

/**
 * R4.1–R4.6: derive the badge from the whole Diagnostics_Store. Errors and
 * warnings are summed across every entry — both the per-`uri` `lsp:*` LSP
 * entries and every Command_Checker source entry — while `info` and `hint`
 * severities are excluded from the count and never make the badge visible.
 */
export function problemsBadge(diagnostics: Record<string, Diagnostic[]>): ProblemsBadge {
  let errors = 0;
  let warnings = 0;
  for (const items of Object.values(diagnostics)) {
    for (const d of items) {
      if (d.severity === "error") errors += 1;
      else if (d.severity === "warning") warnings += 1;
    }
  }
  const count = errors + warnings;
  const color: BadgeColor = errors > 0 ? "error" : warnings > 0 ? "warning" : "none";
  return { count, color, visible: count > 0 };
}
