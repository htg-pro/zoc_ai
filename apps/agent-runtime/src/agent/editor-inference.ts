/**
 * Editor inference: completion and inline-edit prompt construction — R6.2, 9.7.
 *
 * Every helper here is a port of the retained Gateway's own, kept behaviour-for-
 * behaviour rather than reimagined: `routes/completions.py` and `routes/inline.py`
 * are the shapes the editor already speaks, and R6.2 moves *where the call happens*
 * without changing *what is asked*. Same FIM marker list, same two prompts, same
 * two stop sequences, same 30-second cache window, same fence stripping.
 *
 * **Ported rather than proxied.** A runtime that forwarded to the Gateway would
 * leave editor autocomplete on Workspace_Services, which is exactly what R6.2
 * forbids — the point of the move is that provider inference happens in one
 * process. So the pure parts come across and the model call becomes the runtime's.
 *
 * **Ported rather than shared.** These functions cannot be imported from Python,
 * and the alternative — deleting the Gateway's copies now — would break editor
 * autocomplete for every build between this task and 22.11's caller repoint. The
 * duplication is therefore deliberate and temporary, and 26.1 removes the other
 * half. Divergence in the meantime would be a real bug, which is why the fixtures
 * in the tests are the Python docstrings' own examples.
 */

/** Fixed completion sampling, both paths. */
export const COMPLETION_TEMPERATURE = 0.1;
export const COMPLETION_MAX_TOKENS = 128;

/** Completion_Cache freshness window. */
export const CACHE_TTL_MS = 30_000;

/** Deterministic, bounded inline-edit sampling. */
export const INLINE_EDIT_TEMPERATURE = 0.1;
export const INLINE_EDIT_MAX_TOKENS = 512;

export const INLINE_EDIT_SYSTEM =
  "You are a code editor. The user selected code and gave an instruction. " +
  "Return ONLY the replacement code — no markdown, no code fences, no explanation.";

/**
 * Case-insensitive markers of model ids known to do fill-in-the-middle.
 *
 * An unknown or absent id is treated as *not* FIM, so the fallback prompt is used
 * unless a model is known to support it. The asymmetry is the safe direction: a
 * FIM-capable model given the fallback prompt still completes, whereas a chat model
 * given `<PRE>…<SUF>…<MID>` emits the markers back.
 */
const FIM_MODEL_MARKERS: readonly string[] = [
  "codellama",
  "starcoder",
  "deepseek-coder",
  "codegemma",
  "codestral",
  "stable-code",
  "granite-code",
];

/** Whether the active model does fill-in-the-middle. A pure predicate; no probe. */
export function modelSupportsFim(modelId: string | null | undefined): boolean {
  if (modelId === null || modelId === undefined || modelId.length === 0) return false;
  const identifier = modelId.toLowerCase();
  if (FIM_MODEL_MARKERS.some((marker) => identifier.includes(marker))) return true;
  // Qwen coder variants (`qwen2.5-coder`) do FIM; plain Qwen does not.
  return identifier.includes("qwen") && identifier.includes("coder");
}

export function buildFimPrompt(prefix: string, suffix: string): string {
  return `<PRE>${prefix}<SUF>${suffix}<MID>`;
}

/** A "complete at the cursor" prompt for a model without FIM support. */
export function buildFallbackPrompt(prefix: string, suffix: string, language: string): string {
  const lang = language.length > 0 ? language : "code";
  return (
    `You are a code completion engine for ${lang}. ` +
    "Complete the code at the cursor marked <CURSOR>. " +
    "Reply with ONLY the code that should be inserted at the cursor — " +
    "no explanation, no markdown fences, no repetition of the surrounding code.\n\n" +
    `${prefix}<CURSOR>${suffix}`
  );
}

/**
 * At least one stop sequence for the completion call.
 *
 * A double newline ends the completion at a blank line, and a fence stops a chat
 * model wrapping the snippet in markdown. `language` is accepted for per-language
 * tuning later; the contract only requires one sequence.
 */
export function completionStopSequences(language: string): readonly string[] {
  void language;
  return ["\n\n", "```"];
}

export interface CompletionCacheKey {
  readonly prefix: string;
  readonly suffix: string;
  readonly modelId: string;
}

/**
 * In-process completion cache, keyed by prefix, suffix, and model.
 *
 * Three rules carried over verbatim, each of which a naive cache gets wrong: an
 * empty completion is never stored, a read past the TTL is a miss rather than a
 * stale hit, and a read never rewrites the stored timestamp — so a cursor sitting
 * still cannot keep an entry alive indefinitely.
 */
export class CompletionCache {
  private readonly entries = new Map<string, { text: string; storedAtMs: number }>();

  get size(): number {
    return this.entries.size;
  }

  get(key: CompletionCacheKey, nowMs: number): string | null {
    const entry = this.entries.get(serialiseKey(key));
    if (entry === undefined) return null;
    if (nowMs - entry.storedAtMs >= CACHE_TTL_MS) return null;
    return entry.text;
  }

  put(key: CompletionCacheKey, text: string, nowMs: number): void {
    if (text.length === 0) return;
    this.entries.set(serialiseKey(key), { text, storedAtMs: nowMs });
  }
}

function serialiseKey(key: CompletionCacheKey): string {
  // JSON rather than a joined string: a prefix ending in the separator would
  // otherwise collide with a suffix beginning with it, and code contains every
  // separator worth choosing.
  return JSON.stringify([key.prefix, key.suffix, key.modelId]);
}

export interface InlineEditInput {
  readonly instruction: string;
  /** The selected code to transform. */
  readonly code: string;
  /** Up to ~200 characters before the selection. */
  readonly prefix: string;
  /** Up to ~200 characters after the selection. */
  readonly suffix: string;
  readonly language: string;
}

export function buildInlineEditPrompt(input: InlineEditInput): string {
  const parts: string[] = [INLINE_EDIT_SYSTEM, ""];
  if (input.language.length > 0) parts.push(`Language: ${input.language}`);
  if (input.prefix.length > 0) parts.push(`Context before:\n${input.prefix}`);
  parts.push(`Selected code:\n${input.code}`);
  if (input.suffix.length > 0) parts.push(`Context after:\n${input.suffix}`);
  parts.push(`Instruction: ${input.instruction}`);
  parts.push("Replacement code:");
  return parts.join("\n");
}

const FENCE_RE = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/;

/** Unwrap a ``` fence a model added despite being told not to; else unchanged. */
export function stripCodeFences(text: string): string {
  const match = FENCE_RE.exec(text);
  return match?.[1] ?? text;
}
