/**
 * `@`-mention parsing for the context picker.
 *
 * Detects the `@token` the user is currently typing (so the picker can open
 * and filter) and applies a chosen mention back into the text. Pure string
 * logic — the picker UI and candidate fetching live elsewhere.
 */

export interface MentionQuery {
  /** Index of the `@` in the text. */
  start: number;
  /** The text typed after `@`, up to the caret (may be empty). */
  query: string;
}

/**
 * If the caret sits inside an `@token`, return its start index + query text.
 * The `@` must be at the start of the input or preceded by whitespace, and the
 * token must not contain whitespace. Returns null otherwise.
 */
export function detectMentionQuery(text: string, caret: number): MentionQuery | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let i = pos - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") {
      const before = i === 0 ? "" : text[i - 1];
      if (i === 0 || /\s/.test(before)) {
        return { start: i, query: text.slice(i + 1, pos) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/**
 * Replace the active `@token` (from `start` to `caret`) with `@replacement `
 * (trailing space). Returns the new text and caret position.
 */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  replacement: string,
): { text: string; caret: number } {
  const lo = Math.max(0, Math.min(start, text.length));
  const hi = Math.max(lo, Math.min(caret, text.length));
  const insert = `@${replacement} `;
  const next = text.slice(0, lo) + insert + text.slice(hi);
  return { text: next, caret: lo + insert.length };
}
