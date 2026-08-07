/** Property 91: citations resolve to their source and degrade without corrupting text. */
/** Feature: zoc-agent-chat-rebuild, Property 91 (R33.6, R33.7). */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import type { Citation, SourcePart } from "@zoc-studio/shared-types";
import { AnswerRow } from "../AnswerRow";
import { SourcesRow } from "../SourcesRow";
import { resolveCitations } from "../citation-resolution";

afterEach(cleanup);

const source = {
  sourceId: "source-1",
  kind: "url" as const,
  url: "https://example.test/source",
  title: "Example source",
  mediaType: "text/html",
};

const words = fc
  .array(fc.stringMatching(/^[A-Za-z0-9]+$/), { minLength: 3, maxLength: 8 })
  .map((parts) => parts.join(" "));

function citation(overrides: Partial<Citation>): Citation {
  return {
    sourceId: source.sourceId,
    partId: "answer-1",
    start: 0,
    end: 0,
    quote: "",
    ...overrides,
  };
}

describe("Property 91: citation degradation", () => {
  it("preserves answer text through offset, quote, and trailing branches", () => {
    fc.assert(
      fc.property(
        words,
        fc.constantFrom("offset", "quote", "trailing" as const),
        (text, branch) => {
          const firstWord = text.split(" ")[0] ?? text;
          const value =
            branch === "offset"
              ? citation({ start: 0, end: firstWord.length, quote: firstWord })
              : branch === "quote"
                ? citation({ start: text.length + 10, end: text.length + 20, quote: firstWord })
                : citation({
                    start: text.length + 10,
                    end: text.length + 20,
                    quote: "absent quote",
                  });
          const resolved = resolveCitations(text, [value], [source]);
          expect(resolved.inline[0]?.mode ?? resolved.trailing[0]?.mode).toBe(branch);

          const view = render(<AnswerRow text={text} citations={[value]} sources={[source]} />);
          expect(view.container.textContent).toBe(text);
          expect(
            view.container.querySelector('a[href="https://example.test/source"]'),
          ).not.toBeNull();
          view.unmount();
        },
      ),
      { numRuns: 60 },
    );
  });

  it("renders the collapsed source count and safe title-and-host links", () => {
    const part: SourcePart = {
      type: "source",
      seq: 1,
      runId: "run-1",
      messageId: "message-1",
      ts: new Date(0).toISOString(),
      toolName: "web_search",
      sources: [source],
      citations: [],
    };
    render(<SourcesRow source={part} />);
    fireEvent.click(screen.getByRole("button", { name: "Searched the web · 1 source" }));
    const link = screen.getByRole("link", { name: /Example source/ });
    expect(link.getAttribute("href")).toBe("https://example.test/source");
    expect(link.textContent).toContain("example.test");
  });
});
