/**
 * Pure helpers for the status bar (develop.md Phase 14).
 *
 * The status bar reads a lot of store state; these small, pure formatters keep
 * the label/derivation logic out of the component so it's unit-testable.
 */
import type { CursorPosition } from "./editor-actions";

export interface AgentStateView {
  label: string;
  tone: "idle" | "busy" | "ask";
}

/** Human label + tone for the agent state indicator. */
export function agentStateLabel(s: {
  streaming: boolean;
  isRunning: boolean;
  agentMode: "ask" | "agent";
}): AgentStateView {
  if (s.streaming || s.isRunning) return { label: "Running", tone: "busy" };
  if (s.agentMode === "ask") return { label: "Ask", tone: "ask" };
  return { label: "Agent", tone: "idle" };
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript JSX",
  javascript: "JavaScript",
  javascriptreact: "JavaScript JSX",
  python: "Python",
  rust: "Rust",
  go: "Go",
  json: "JSON",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  shell: "Shell",
  yaml: "YAML",
  toml: "TOML",
  sql: "SQL",
  plaintext: "Plain Text",
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
};

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Display label for a file's language mode (from its language id or name). */
export function languageLabel(file: { language?: string; name?: string } | null): string {
  if (!file) return "—";
  let id = (file.language ?? "").toLowerCase();
  if ((!id || id === "plaintext") && file.name) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext && EXT_TO_LANGUAGE[ext]) id = EXT_TO_LANGUAGE[ext];
  }
  if (!id) return "Plain Text";
  return LANGUAGE_LABELS[id] ?? capitalize(id);
}

/** "Ln 12, Col 5" or "—" when there's no caret. */
export function formatCursor(pos: CursorPosition | null): string {
  if (!pos) return "—";
  return `Ln ${pos.line}, Col ${pos.column}`;
}

/** Compact model label, preferring the loaded local model when running. */
export function modelLabel(
  selected: { provider: string; model: string },
  loadedModelId: string | null,
): string {
  const name = (loadedModelId || selected.model || "").trim();
  if (!name) return "No model";
  // Strip any path / org prefix for a compact label.
  const short = name.split(/[/\\]/).pop() ?? name;
  return short;
}

/** "3 errors, 1 warning" style summary (or "No problems"). */
export function diagnosticsLabel(errors: number, warnings: number): string {
  if (errors === 0 && warnings === 0) return "No problems";
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return parts.join(", ");
}
