// Feature: @-context mentions — detect/apply pure helpers
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyMention, detectMentionQuery } from "../context-mentions";

describe("context-mentions", () => {
  it("detects a mention at the caret when @ starts the token", () => {
    expect(detectMentionQuery("@uti", 4)).toEqual({ start: 0, query: "uti" });
    expect(detectMentionQuery("hello @foo", 10)).toEqual({ start: 6, query: "foo" });
    expect(detectMentionQuery("see @", 5)).toEqual({ start: 4, query: "" });
  });

  it("returns null when not in a mention token", () => {
    expect(detectMentionQuery("hello world", 11)).toBeNull();
    // @ not preceded by whitespace (e.g. an email) is not a mention.
    expect(detectMentionQuery("a@b", 3)).toBeNull();
    // whitespace between @ and caret breaks the token.
    expect(detectMentionQuery("@foo bar", 8)).toBeNull();
  });

  it("applyMention replaces the token and positions the caret after it", () => {
    const r = applyMention("see @fo", 4, 7, "src/foo.ts");
    expect(r.text).toBe("see @src/foo.ts ");
    expect(r.caret).toBe(r.text.length);
    expect("see @src/foo.ts ".slice(0, r.caret)).toBe(r.text);
  });

  it("detect→apply round-trips: after applying, the caret is no longer in a mention", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z ]{0,20}$/),
        fc.stringMatching(/^[a-z]{0,8}$/),
        fc.stringMatching(/^[a-z/.]{1,15}$/),
        (prefix, q, repl) => {
          const base = prefix.endsWith(" ") || prefix === "" ? prefix : prefix + " ";
          const text = `${base}@${q}`;
          const caret = text.length;
          const m = detectMentionQuery(text, caret);
          expect(m).not.toBeNull();
          const applied = applyMention(text, m!.start, caret, repl);
          // Caret now sits after the trailing space → no active mention.
          expect(detectMentionQuery(applied.text, applied.caret)).toBeNull();
          expect(applied.text).toContain(`@${repl} `);
        },
      ),
      { numRuns: 200 },
    );
  });
});
