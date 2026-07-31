/**
 * Property 4: Streaming markdown repair is content-preserving and idempotent.
 * Validates R8.1, R8.5.
 *
 * The property's own wording is the shape of the test: for any prefix of a valid markdown
 * document, repairing it yields a document whose **visible text** equals the prefix's
 * visible text, and repairing an already-repaired document changes nothing.
 *
 * "Visible text" is the part that needs care, and this file computes it two ways on purpose.
 * `visibleText` strips markdown syntax with a small deliberate stripper; the *stronger*
 * check is that the repaired string **starts with the input, character for character**, so
 * the repair provably appends and never edits. The second subsumes the first for every
 * failure a repair function actually has — it just does not read like the property's
 * sentence, so both are asserted.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { repairStreamingMarkdown } from "@/features/chat/markdown/repair";
import { MARKDOWN_BODIES, truncatedMarkdown } from "./arbitraries";

/** Property 4 sits in the default 100-iteration set. */
const RUNS = { numRuns: 100 } as const;

/**
 * The characters a reader sees, with markdown syntax removed.
 *
 * A deliberate approximation rather than a second parser: it strips the delimiters this
 * repair function is allowed to append and nothing else. That is exactly the right scope —
 * the property is about *this* function's edits, and using `react-markdown` to derive the
 * comparison would make the test depend on the renderer it is trying to protect.
 *
 * The closing paren of a link target is **optional** in the pattern, and that is the
 * difference between a correct stripper and one that reports a false failure. A truncated
 * `[the docs](` has an unterminated target: those two characters are link *syntax*, not
 * content, so they must be stripped from the input exactly as `]()` is stripped from the
 * repaired output. Requiring the paren makes the input keep a `(` the output does not have,
 * and the test then reports the repair as losing content when it appended one character.
 */
function visibleText(markdown: string): string {
  return markdown
    .replace(/```+|~~~+/g, "")
    .replace(/\*\*\*|___|\*\*|__|[*_`]/g, "")
    .replace(/\]\([^)]*\)?/g, "")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, "");
}

describe("Feature: zoc-agent-chat-rebuild, Property 4: streaming markdown repair is content-preserving and idempotent", () => {
  it("appends only — the repaired string starts with the input, character for character", () => {
    // The strongest form of content preservation, and the one that actually rules out every
    // way a repair can lose text: an insertion, a deletion, or a reorder all break it.
    fc.assert(
      fc.property(truncatedMarkdown, (prefix) => {
        const repaired = repairStreamingMarkdown(prefix);
        expect(repaired.startsWith(prefix), JSON.stringify(prefix)).toBe(true);
      }),
      RUNS,
    );
  });

  it("preserves the visible text of the prefix", () => {
    // The property's own wording. Weaker than the prefix check above, and kept because it is
    // the claim R8.1 makes — that a reader sees the same words before and after repair.
    fc.assert(
      fc.property(truncatedMarkdown, (prefix) => {
        expect(visibleText(repairStreamingMarkdown(prefix))).toBe(visibleText(prefix));
      }),
      RUNS,
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(truncatedMarkdown, (prefix) => {
        const once = repairStreamingMarkdown(prefix);
        expect(repairStreamingMarkdown(once)).toBe(once);
      }),
      RUNS,
    );
  });

  it("appends only markdown syntax, never a character a reader reads as content", () => {
    // What "content-preserving" means for the *appended* half: the suffix is delimiters, a
    // newline, or the one synthetic href. A repair that appended a word would satisfy the
    // prefix check and still be putting words in the model's mouth.
    const PERMITTED_SUFFIX = /^[\s`~*_)\]([#]*$/;
    fc.assert(
      fc.property(truncatedMarkdown, (prefix) => {
        const suffix = repairStreamingMarkdown(prefix).slice(prefix.length);
        expect(PERMITTED_SUFFIX.test(suffix), JSON.stringify(suffix)).toBe(true);
      }),
      RUNS,
    );
  });

  it("leaves a complete document untouched", () => {
    // The control case. Every fixture is a valid document, so a repair that fired on
    // well-formed input would be adding delimiters to text that needs none — and the three
    // properties above would all still pass.
    for (const body of MARKDOWN_BODIES) {
      expect(repairStreamingMarkdown(body), body).toBe(body);
    }
  });

  it("closes what a prefix left open, rather than leaving it open", () => {
    // The direction the four properties above do not cover: a function that returned its
    // input unchanged would satisfy every one of them. This is what makes them non-vacuous.
    const repaired = [
      ["```ts\nconst a = 1;", "```"],
      ["A **bold", "**"],
      ["An _aside", "_"],
      ["Some `code", "`"],
      ["See [the docs", "](#)"],
      ["See [the docs](https://example.invalid", ")"],
    ] as const;

    for (const [prefix, expected] of repaired) {
      const result = repairStreamingMarkdown(prefix);
      expect(result.slice(prefix.length).trimStart(), prefix).toBe(expected);
    }
  });
});
