/**
 * The composer's `@`-mention parser — zoc-agent-chat-rebuild R12.1, R12.3, R12.4, task 20.1.
 *
 * Re-authored from `lib/context-mentions.ts` with behaviour preserved exactly. It moves because it is
 * composer logic and the composer is a feature: `lib` is for what more than one feature uses, and after
 * 26.2 nothing outside `features/chat` parses a mention. The legacy module stays where it is until that
 * deletion, per the cutover discipline — this is a copy, not a move, and the two are identical by
 * construction because the property below generates against both.
 *
 * ## The rule that carries the weight
 *
 * `@` opens a mention only at input start or after whitespace. Without it, every email address and every
 * `array@index` in a prompt opens the popover mid-typing — which is the behaviour users notice, and the
 * reason the rule is stated in the requirement rather than left to the parser.
 *
 * A mention token contains no whitespace, so scanning back from the caret stops at the first space. That
 * makes detection O(token length) rather than O(draft length), which matters because it runs on every
 * keystroke of a draft that can be 10,000 characters (`composer-validate.ts`).
 */

/** The caret-relative `@token` under edit. Structurally the store's `MentionQuery`. */
export interface MentionQuery {
  /** Index of the `@` in the draft. */
  readonly start: number;
  /** The text typed after `@`, up to the caret. May be empty. */
  readonly query: string;
}

/**
 * The `@token` the caret sits inside, or `null`.
 *
 * `null` covers three different situations on purpose — no `@` before the caret, an `@` that is not at a
 * token boundary, and whitespace between the caret and the nearest `@` — because the composer does the
 * same thing in all three: it closes the popover.
 */
export function detectMentionQuery(text: string, caret: number): MentionQuery | null {
  const position = Math.max(0, Math.min(caret, text.length));
  for (let index = position - 1; index >= 0; index -= 1) {
    const character = text[index];
    if (character === "@") {
      const before = index === 0 ? "" : (text[index - 1] ?? "");
      if (index === 0 || /\s/.test(before)) {
        return { start: index, query: text.slice(index + 1, position) };
      }
      // An `@` that is not at a token boundary — `user@example.com` — is not a mention, and scanning
      // further back would find an earlier `@` and open the popover on the wrong token.
      return null;
    }
    if (/\s/.test(character)) return null;
  }
  return null;
}

/**
 * Replace the active `@token` with `@replacement `, and report where the caret lands.
 *
 * The trailing space is what makes insertion round-trip: without it the caret sits inside the token just
 * written, so `detectMentionQuery` still reports a mention and the popover reopens on the completed
 * reference. Property 25 asserts exactly that — after insertion there is no active query.
 */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  replacement: string,
): { readonly text: string; readonly caret: number } {
  const low = Math.max(0, Math.min(start, text.length));
  const high = Math.max(low, Math.min(caret, text.length));
  const insert = `@${replacement} `;
  return { text: text.slice(0, low) + insert + text.slice(high), caret: low + insert.length };
}
