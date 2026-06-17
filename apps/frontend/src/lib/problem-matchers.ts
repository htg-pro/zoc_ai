/**
 * Problem matchers (develop.md Phase 5).
 *
 * Pure parsers that turn a checker's raw stdout/stderr into structured
 * `Diagnostic[]`. One per supported tool (TypeScript, ESLint, ruff, cargo).
 * Dependency-free so they can be unit-tested without a DOM or a real checker.
 */

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  /** Tool that produced it: "typescript" | "eslint" | "ruff" | "cargo" | … */
  source: string;
  /** File path as emitted by the tool (may be relative to the workspace). */
  file: string;
  line: number;
  column: number;
  severity: Severity;
  message: string;
  code?: string;
}

export type CheckKind = "tsc" | "eslint" | "ruff" | "cargo";

export function sourceForKind(kind: CheckKind): string {
  switch (kind) {
    case "tsc":
      return "typescript";
    case "eslint":
      return "eslint";
    case "ruff":
      return "ruff";
    case "cargo":
      return "cargo";
  }
}

function normSeverity(s: string): Severity {
  const v = s.toLowerCase();
  if (v.startsWith("err")) return "error";
  if (v.startsWith("warn")) return "warning";
  if (v === "info" || v === "note") return "info";
  if (v === "hint" || v === "help") return "hint";
  return "warning";
}

/** TypeScript `tsc --noEmit` / `--pretty false`:
 *  `src/app.ts(12,5): error TS2322: Type 'x' is not assignable…` */
export function parseTsc(output: string): Diagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message)\s+(TS\d+):\s+(.*)$/;
  const out: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    out.push({
      source: "typescript",
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: normSeverity(m[4]),
      code: m[5],
      message: m[6].trim(),
    });
  }
  return out;
}

/** ESLint default "stylish" formatter:
 *    /abs/path/file.ts
 *      12:5   error    'x' is assigned but never used   no-unused-vars
 *      14:1   warning  Missing semicolon                semi
 */
export function parseEslint(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let file: string | null = null;
  const rowRe = /^(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([\w@/-]+))?$/;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const trimmed = line.trim();
    const row = rowRe.exec(trimmed);
    if (row && file) {
      out.push({
        source: "eslint",
        file,
        line: Number(row[1]),
        column: Number(row[2]),
        severity: normSeverity(row[3]),
        message: row[4].trim(),
        code: row[5],
      });
      continue;
    }
    // A non-indented, non-summary line that isn't a row is a file header.
    if (!/^\s/.test(raw) && !/problems?\b/i.test(trimmed) && !/^✖/.test(trimmed)) {
      file = trimmed;
    }
  }
  return out;
}

/** ruff default text output: `path:line:col: CODE message`
 *  e.g. `src/a.py:3:1: F401 [*] 'os' imported but unused` */
export function parseRuff(output: string): Diagnostic[] {
  const re = /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(?:\[\*\]\s+)?(.*)$/;
  const out: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    // E9xx are syntax errors; everything else is a lint warning.
    const code = m[4];
    out.push({
      source: "ruff",
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: code.startsWith("E9") ? "error" : "warning",
      code,
      message: m[5].trim(),
    });
  }
  return out;
}

/** cargo `check --message-format=short`:
 *  `src/main.rs:10:5: error[E0382]: borrow of moved value`
 *  `src/main.rs:3:9: warning: unused variable: x` */
export function parseCargo(output: string): Diagnostic[] {
  const re = /^(.+?\.rs):(\d+):(\d+):\s+(error|warning)(?:\[([A-Z0-9]+)\])?:\s+(.*)$/;
  const out: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    out.push({
      source: "cargo",
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: normSeverity(m[4]),
      code: m[5],
      message: m[6].trim(),
    });
  }
  return out;
}

export function parseByKind(kind: CheckKind, output: string): Diagnostic[] {
  switch (kind) {
    case "tsc":
      return parseTsc(output);
    case "eslint":
      return parseEslint(output);
    case "ruff":
      return parseRuff(output);
    case "cargo":
      return parseCargo(output);
  }
}

/** Count errors/warnings across a flat diagnostic list. */
export function countBySeverity(items: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of items) {
    if (d.severity === "error") errors += 1;
    else if (d.severity === "warning") warnings += 1;
  }
  return { errors, warnings };
}
