/**
 * Task discovery & parsing (develop.md Phase 6).
 *
 * Pure functions that turn project config/manifests into a normalized `Task[]`:
 * VS Code `.vscode/tasks.json`, the Zoc `.zoc/tasks.json` fallback, and
 * auto-detected npm scripts, Cargo commands, Makefile targets, and Python
 * (pytest/ruff). Dependency-free so they're unit-testable without disk.
 */

export type TaskGroup = "build" | "test" | "none";
export type TaskSource = "vscode" | "zoc" | "npm" | "cargo" | "make" | "python";

export interface Task {
  /** Stable id: `${source}:${label}`. */
  id: string;
  label: string;
  source: TaskSource;
  command: string;
  args: string[];
  /** Workspace-relative working directory, when the task pins one. */
  cwd?: string | null;
  group: TaskGroup;
  isBackground?: boolean;
  /** Problem-matcher kind ("tsc"|"eslint"|"ruff"|"cargo") or null. */
  problemMatcher?: string | null;
}

/** Strip `//` and block comments (JSONC) outside strings, plus trailing commas,
 *  then it's safe to `JSON.parse`. */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

function normalizeMatcher(pm: unknown): string | null {
  // VS Code uses "$tsc", "$eslint-stylish", "$rustc"; map to our kinds.
  const one = Array.isArray(pm) ? pm[0] : pm;
  const name = typeof one === "string" ? one : (one as { base?: string })?.base;
  if (!name) return null;
  const v = String(name).replace(/^\$/, "").toLowerCase();
  if (v.startsWith("tsc")) return "tsc";
  if (v.startsWith("eslint")) return "eslint";
  if (v.startsWith("ruff")) return "ruff";
  if (v.startsWith("rustc") || v.startsWith("cargo")) return "cargo";
  return null;
}

function groupOf(raw: unknown): TaskGroup {
  if (typeof raw === "string") return raw === "build" || raw === "test" ? raw : "none";
  const kind = (raw as { kind?: string })?.kind;
  return kind === "build" || kind === "test" ? kind : "none";
}

/** Parse a VS Code / Zoc `tasks.json` document. */
export function parseTasksJson(text: string, source: "vscode" | "zoc"): Task[] {
  const doc = safeParse(text) as { tasks?: unknown[] } | null;
  if (!doc || !Array.isArray(doc.tasks)) return [];
  const out: Task[] = [];
  for (const t of doc.tasks) {
    const task = t as Record<string, unknown>;
    const label = String(task.label ?? task.taskName ?? "").trim();
    if (!label) continue;
    let command = "";
    let args: string[] = [];
    if (task.type === "npm" && typeof task.script === "string") {
      command = "npm";
      args = ["run", task.script];
    } else {
      command = String(task.command ?? "");
      args = Array.isArray(task.args) ? task.args.map(String) : [];
    }
    if (!command) continue;
    const options = task.options as { cwd?: string } | undefined;
    out.push({
      id: `${source}:${label}`,
      label,
      source,
      command,
      args,
      cwd: options?.cwd ?? null,
      group: groupOf(task.group),
      isBackground: Boolean(task.isBackground),
      problemMatcher: normalizeMatcher(task.problemMatcher),
    });
  }
  return out;
}

/** Detect tasks from a package.json `scripts` map. */
export function detectNpmScripts(text: string, cwd: string | null = null): Task[] {
  const doc = safeParse(text) as { scripts?: Record<string, string> } | null;
  if (!doc || !doc.scripts) return [];
  return Object.keys(doc.scripts).map((name) => ({
    id: `npm:${name}`,
    label: `npm: ${name}`,
    source: "npm" as const,
    command: "npm",
    args: ["run", name],
    cwd,
    group: name === "build" ? "build" : /(^|:)test(:|$)|test$/.test(name) ? "test" : "none",
    problemMatcher: null,
  }));
}

/** Detect cargo build/test/check from a Cargo.toml. */
export function detectCargo(text: string): Task[] {
  if (!/\[package\]|\[workspace\]/.test(text)) return [];
  const mk = (label: string, sub: string, group: TaskGroup): Task => ({
    id: `cargo:${label}`,
    label: `cargo: ${label}`,
    source: "cargo",
    command: "cargo",
    args: [sub],
    group,
    problemMatcher: "cargo",
  });
  return [mk("build", "build", "build"), mk("test", "test", "test"), mk("check", "check", "none")];
}

/** Detect targets from a Makefile. */
export function detectMake(text: string): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z0-9_][\w.-]*)\s*:(?!=)/.exec(line);
    if (!m) continue;
    const target = m[1];
    if (target === ".PHONY" || seen.has(target)) continue;
    seen.add(target);
    out.push({
      id: `make:${target}`,
      label: `make: ${target}`,
      source: "make",
      command: "make",
      args: [target],
      group: target === "build" || target === "all" ? "build" : /test/.test(target) ? "test" : "none",
      problemMatcher: null,
    });
  }
  return out;
}

/** Detect Python test/lint tasks from a pyproject.toml. */
export function detectPython(text: string): Task[] {
  const out: Task[] = [];
  if (/\[tool\.pytest|pytest/.test(text)) {
    out.push({
      id: "python:pytest",
      label: "python: pytest",
      source: "python",
      command: "pytest",
      args: [],
      group: "test",
      problemMatcher: null,
    });
  }
  if (/\[tool\.ruff|ruff/.test(text)) {
    out.push({
      id: "python:ruff",
      label: "python: ruff check",
      source: "python",
      command: "ruff",
      args: ["check"],
      group: "none",
      problemMatcher: "ruff",
    });
  }
  return out;
}

/** De-duplicate by id, keeping the first occurrence (config sources win when
 *  callers list them before detected ones). */
export function dedupeTasks(tasks: Task[]): Task[] {
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const t of tasks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** The default build task: a config task in the build group wins, else the
 *  first build-group task, else null. */
export function defaultBuildTask(tasks: Task[]): Task | null {
  return pickDefault(tasks, "build");
}

export function defaultTestTask(tasks: Task[]): Task | null {
  return pickDefault(tasks, "test");
}

function pickDefault(tasks: Task[], group: TaskGroup): Task | null {
  const inGroup = tasks.filter((t) => t.group === group);
  if (inGroup.length === 0) return null;
  const fromConfig = inGroup.find((t) => t.source === "vscode" || t.source === "zoc");
  return fromConfig ?? inGroup[0];
}
