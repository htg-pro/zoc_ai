/**
 * Inline edit (Cmd-K) pure helpers.
 *
 * The Cmd-K flow: capture the editor selection (text + offsets + surrounding
 * context), ask the backend to rewrite it, splice the result back into the
 * file, and route the change through the normal diff-review/apply flow. The
 * string-manipulation core lives here so it's testable in isolation.
 */
import { createTwoFilesPatch } from "diff";
import type { DiffPatch } from "@llama-studio/shared-types";

/** Replace the half-open [start, end) range of `full` with `replacement`. */
export function spliceText(
  full: string,
  start: number,
  end: number,
  replacement: string,
): string {
  const lo = Math.max(0, Math.min(start, full.length));
  const hi = Math.max(lo, Math.min(end, full.length));
  return full.slice(0, lo) + replacement + full.slice(hi);
}

/**
 * Surrounding context for the model: up to `window` chars immediately before
 * and after the selection. Keeps the prompt focused without sending the whole
 * file.
 */
export function surroundingContext(
  full: string,
  start: number,
  end: number,
  window = 800,
): { prefix: string; suffix: string } {
  const lo = Math.max(0, Math.min(start, full.length));
  const hi = Math.max(lo, Math.min(end, full.length));
  return {
    prefix: full.slice(Math.max(0, lo - window), lo),
    suffix: full.slice(hi, Math.min(full.length, hi + window)),
  };
}

/**
 * Defensively unwrap a single Markdown code fence the model may add despite
 * instructions (```lang\n...\n```), preserving the inner code verbatim.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return text;
  const lines = trimmed.split("\n").slice(1);
  if (lines.length && lines[lines.length - 1].trim().startsWith("```")) {
    lines.pop();
  }
  return lines.join("\n");
}

/**
 * Build a `DiffPatch` for a whole-file change (original → edited), or `null`
 * when the content is unchanged. The unified diff is what the diff-review card
 * renders and what the Tauri `apply_patch` writes to disk.
 */
export function buildInlineEditPatch(
  filePath: string,
  originalFull: string,
  newFull: string,
  summary?: string,
): DiffPatch | null {
  if (originalFull === newFull) return null;
  const unified = createTwoFilesPatch(
    filePath,
    filePath,
    originalFull,
    newFull,
    "",
    "",
    { context: 3 },
  );
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `inline-${Date.now()}`,
    file_path: filePath,
    unified_diff: unified,
    summary: summary ?? "Inline edit",
  };
}
