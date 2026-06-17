/**
 * Launch-configuration parsing (develop.md Phase 7).
 *
 * Pure parser for `.vscode/launch.json` / `.zoc/launch.json` into normalized
 * `LaunchConfig[]`. Dependency-free and unit-testable. The actual debug-adapter
 * (DAP) session that consumes these is wired separately and depends on the
 * long-lived process runtime (see doc/dev/run-and-debug.md).
 */
import { stripJsonComments } from "./tasks";

export interface LaunchConfig {
  /** Display name (`configurations[].name`). */
  name: string;
  /** Adapter type: "node" | "python" | "lldb" | "cppdbg" | … */
  type: string;
  /** "launch" | "attach". */
  request: string;
  program?: string | null;
  args?: string[];
  cwd?: string | null;
  /** Coarse family used to pick an adapter + icon. */
  kind: "node" | "python" | "rust" | "go" | "other";
}

function familyOf(type: string): LaunchConfig["kind"] {
  const t = type.toLowerCase();
  if (t.includes("node") || t === "pwa-node" || t.includes("chrome") || t.includes("js")) return "node";
  if (t.includes("python") || t === "debugpy") return "python";
  if (t.includes("lldb") || t.includes("cppdbg") || t.includes("gdb") || t === "cargo") return "rust";
  if (t.includes("go") || t === "delve") return "go";
  return "other";
}

export function parseLaunchJson(text: string): LaunchConfig[] {
  let doc: { configurations?: unknown[] } | null = null;
  try {
    doc = JSON.parse(stripJsonComments(text));
  } catch {
    return [];
  }
  if (!doc || !Array.isArray(doc.configurations)) return [];
  const out: LaunchConfig[] = [];
  for (const c of doc.configurations) {
    const cfg = c as Record<string, unknown>;
    const name = String(cfg.name ?? "").trim();
    const type = String(cfg.type ?? "").trim();
    if (!name || !type) continue;
    out.push({
      name,
      type,
      request: String(cfg.request ?? "launch"),
      program: typeof cfg.program === "string" ? cfg.program : null,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
      cwd: typeof cfg.cwd === "string" ? cfg.cwd : null,
      kind: familyOf(type),
    });
  }
  return out;
}
