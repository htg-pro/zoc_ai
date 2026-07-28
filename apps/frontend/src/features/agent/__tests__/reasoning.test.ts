/**
 * reasoning.test.ts — the answer/reasoning split at the render + commit boundary.
 *
 * A model that emits its scratchpad inline in the answer channel must never have
 * that text rendered as the answer. Both the closed and the still-streaming
 * (dangling `<think>`) shapes are covered, because the dangling case is the one
 * that used to flash raw reasoning into the chat window mid-stream.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { splitReasoning, stripReasoning } from "@/features/agent/reasoning";

describe("splitReasoning", () => {
  it("leaves text with no reasoning untouched", () => {
    expect(splitReasoning("Here is the fix.")).toEqual({
      answer: "Here is the fix.",
      reasoning: "",
    });
    expect(splitReasoning("")).toEqual({ answer: "", reasoning: "" });
  });

  it("removes a closed block and keeps the answer", () => {
    const { answer, reasoning } = splitReasoning(
      "<think>the parser is in src/parse.ts</think>Update `parse()` to handle empty input.",
    );
    expect(answer).toBe("Update `parse()` to handle empty input.");
    expect(reasoning).toBe("the parser is in src/parse.ts");
  });

  it("treats a dangling block as reasoning, not as an answer", () => {
    // Mid-stream: the close tag has not arrived. Nothing here is an answer yet.
    const { answer, reasoning } = splitReasoning("<think>still weighing the options");
    expect(answer).toBe("");
    expect(reasoning).toBe("still weighing the options");
  });

  it("handles multiple blocks and text between them", () => {
    const { answer, reasoning } = splitReasoning(
      "<think>first</think>Step one.<think>second</think>Step two.",
    );
    expect(answer).toBe("Step one.Step two.");
    expect(reasoning).toBe("first\n\nsecond");
  });

  it("is case-insensitive and spans newlines", () => {
    const { answer, reasoning } = splitReasoning("<THINK>line one\nline two</THINK>Done.");
    expect(answer).toBe("Done.");
    expect(reasoning).toBe("line one\nline two");
  });

  it("preserves markdown structure in the answer", () => {
    const source = "<think>x</think># Title\n\n```ts\nconst a = 1;\n```\n";
    expect(splitReasoning(source).answer).toBe("# Title\n\n```ts\nconst a = 1;\n```");
  });

  it("never leaks a think tag into the answer, for any input", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (before, inner, after) => {
        const text = `${before}<think>${inner}</think>${after}`;
        const { answer } = splitReasoning(text);
        // The only way a tag can survive is if the caller's own text contained
        // one, which the fuzzed `before`/`inner`/`after` may do; assert on the
        // property that matters instead: no *unconsumed* tag pair remains.
        expect(/<think>[\s\S]*<\/think>/i.test(answer)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("stripReasoning", () => {
  it("returns only the answer half", () => {
    expect(stripReasoning("<think>private</think>public")).toBe("public");
  });
});
