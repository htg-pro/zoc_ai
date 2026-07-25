/**
 * Pure helpers for the status bar (develop.md Phase 14).
 *
 * The status bar reads a lot of store state; these small, pure formatters keep
 * the label/derivation logic out of the component so it's unit-testable.
 */
import type { CursorPosition } from "./editor-actions";

export interface AgentStateView {
  label: string;
  tone: "idle" | "busy" | "ask" | "plan";
}

/** Human label + tone for the agent state indicator. */
export function agentStateLabel(s: {
  streaming: boolean;
  isRunning: boolean;
  agentMode: "ask" | "plan" | "agent";
}): AgentStateView {
  if (s.streaming || s.isRunning) return { label: "Running", tone: "busy" };
  if (s.agentMode === "ask") return { label: "Ask", tone: "ask" };
  if (s.agentMode === "plan") return { label: "Plan", tone: "plan" };
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

// ── Hardware monitor (§16.2) ────────────────────────────────────────────────

/** Mirrors the gateway's `HardwareSnapshot` wire payload. */
export interface HardwareSnapshot {
  cpu_percent: number | null;
  ram_used_gb: number | null;
  ram_total_gb: number | null;
  gpu_vram_used_mb: number | null;
  gpu_vram_total_mb: number | null;
  llm_tokens_per_second: number | null;
  llm_inference_active: boolean;
}

/** Only surface CPU when it is high enough to be worth the user's attention. */
export const CPU_ALERT_THRESHOLD = 80;

export interface Gauge {
  label: string;
  /** 0–1 fill ratio, clamped. */
  ratio: number;
  detail: string;
}

function clampRatio(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, used / total));
}

/**
 * RAM gauge, or `null` when memory could not be read.
 *
 * Returning `null` rather than a zeroed gauge matters: a 0 %-full RAM bar would
 * be a lie, while a missing bar correctly says "unknown".
 */
export function ramGauge(snapshot: HardwareSnapshot | null): Gauge | null {
  if (!snapshot?.ram_total_gb || snapshot.ram_used_gb === null) return null;
  return {
    label: "RAM",
    ratio: clampRatio(snapshot.ram_used_gb, snapshot.ram_total_gb),
    detail: `${snapshot.ram_used_gb.toFixed(1)} / ${snapshot.ram_total_gb.toFixed(1)} GB`,
  };
}

/** VRAM gauge, or `null` when there is no (readable) GPU. */
export function vramGauge(snapshot: HardwareSnapshot | null): Gauge | null {
  if (!snapshot?.gpu_vram_total_mb) return null;
  const used = snapshot.gpu_vram_used_mb ?? 0;
  const toGb = (mb: number) => (mb / 1024).toFixed(1);
  return {
    label: "VRAM",
    ratio: clampRatio(used, snapshot.gpu_vram_total_mb),
    detail: `${toGb(used)} / ${toGb(snapshot.gpu_vram_total_mb)} GB`,
  };
}

/** "32 t/s" while the model is generating, otherwise `null`. */
export function tokensPerSecondLabel(snapshot: HardwareSnapshot | null): string | null {
  if (!snapshot?.llm_inference_active) return null;
  const tps = snapshot.llm_tokens_per_second;
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return null;
  return `${Math.round(tps)} t/s`;
}

/** "91%" only when CPU load is above {@link CPU_ALERT_THRESHOLD}. */
export function cpuAlertLabel(snapshot: HardwareSnapshot | null): string | null {
  const cpu = snapshot?.cpu_percent;
  if (cpu === null || cpu === undefined || !Number.isFinite(cpu)) return null;
  return cpu > CPU_ALERT_THRESHOLD ? `${Math.round(cpu)}%` : null;
}
