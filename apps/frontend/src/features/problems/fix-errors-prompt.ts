/**
 * "Run agent to fix N errors" prompt builder (design.md §3.2, Requirement 6).
 *
 * Pure helpers the Problems_Panel uses to offer a per-file action that hands a
 * file's error-severity diagnostics to the agent. The builder names the file
 * and enumerates ONLY its `error`-severity diagnostics (each with its line,
 * column, and message), deliberately omitting warning/info/hint findings so the
 * agent is pointed at the errors the Developer wants fixed.
 */

import type { Diagnostic } from "@/lib/problem-matchers";

/** R6.1: N — the count of a file's `error`-severity diagnostics. */
export function errorCount(diagnostics: Diagnostic[]): number {
  let n = 0;
  for (const d of diagnostics) if (d.severity === "error") n += 1;
  return n;
}

/**
 * R6.1/R6.2/R6.3: build the Composer draft prompt for a file. Identifies the
 * file by its `file` path and lists each `error`-severity diagnostic's `line`,
 * `column`, and `message`; every `warning`/`info`/`hint` diagnostic is omitted.
 */
export function buildFixErrorsPrompt(file: string, diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error");
  const n = errors.length;
  const header =
    n === 1
      ? `Fix the following error in ${file}:`
      : `Fix the following ${n} errors in ${file}:`;
  const lines = errors.map((d) => `- Line ${d.line}, column ${d.column}: ${d.message}`);
  return [header, ...lines].join("\n");
}
