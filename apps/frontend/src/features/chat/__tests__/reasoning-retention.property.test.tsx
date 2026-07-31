/**
 * Property 7: Reasoning content survives collapse. Validates R8.2, R8.4.
 *
 * The property is one sentence with two halves, and the second is the one an implementation
 * gets wrong: reaching a terminal Run state leaves the region collapsed, **and** expanding it
 * yields content equal to the concatenation of the delivered deltas.
 *
 * **"Retained" is about the text, not the DOM**, and the property is what settled that. Radix
 * unmounts a closed `Collapsible`'s children, so the collapsed region holds no nodes — and
 * `forceMount`, which looks like the fix, sets `present` unconditionally so the region never
 * collapses at all. Both halves cannot be satisfied by keeping nodes; they are satisfied by the
 * text living in `useChat`'s message parts and being re-rendered from the prop on expand. So
 * the assertions are written against what a *user* can reach — collapsed after terminal, and
 * the full text present once expanded — rather than against the DOM while hidden, which is what
 * an implementation detail would be.
 *
 * The deltas are generated because their *shape* is what varies in practice: a provider may
 * emit one long block or two hundred fragments, and reasoning routinely contains newlines,
 * markdown-looking punctuation, and trailing whitespace that a naive join would normalise.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { ReasoningRow } from "@/features/chat/ReasoningRow";
import { formatReasoningDuration } from "@/features/chat/reasoning-duration";

const RUNS = { numRuns: 100 } as const;

afterEach(cleanup);

/**
 * An arbitrary sequence of reasoning deltas.
 *
 * Deliberately includes the fragments that break a naive implementation: an empty delta, one
 * that is only whitespace, one carrying a newline, and one that looks like markdown — the
 * reasoning body is *not* markdown, so `**bold**` must survive as those nine characters.
 */
const deltas: fc.Arbitrary<string[]> = fc.array(
  fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.constantFrom("", " ", "\n", "\n\n", "**bold**", "  trailing  ", "- a list item"),
  ),
  { minLength: 1, maxLength: 60 },
);

function mount(props: {
  text: string;
  terminal?: boolean;
  streaming?: boolean;
  elapsedMs?: number;
  redacted?: boolean;
}) {
  return render(
    <ChatMotionProvider budget={null}>
      <ReasoningRow {...props} />
    </ChatMotionProvider>,
  );
}

/** The reasoning text currently in the DOM, or null while the region is collapsed. */
function reasoningTextOf(container: HTMLElement): string | null {
  return container.querySelector("[data-zoc-reasoning-text]")?.textContent ?? null;
}

function isCollapsed(container: HTMLElement): boolean {
  const content = container.querySelector("[data-zoc-reasoning-content]");
  // Radix marks a closed `forceMount`ed panel `hidden` rather than removing it, which is the
  // whole mechanism under test: hidden and present, not absent.
  return content !== null && content.hasAttribute("hidden");
}

function expand(container: HTMLElement): void {
  const trigger = container.querySelector("[data-zoc-reasoning-trigger]");
  if (trigger !== null) fireEvent.click(trigger);
}

describe("Feature: zoc-agent-chat-rebuild, Property 7: reasoning content survives collapse", () => {
  it("collapses on a terminal Run state and yields the deltas when expanded", () => {
    fc.assert(
      fc.property(deltas, fc.integer({ min: 0, max: 600_000 }), (parts, elapsedMs) => {
        cleanup();
        const text = parts.join("");
        const { container } = mount({ text, terminal: true, elapsedMs });

        // Half one: collapsed by default on terminal (R8.4).
        expect(isCollapsed(container)).toBe(true);

        // Half two: expanding yields the concatenation of the deltas, byte for byte. This is
        // the assertion that fails if the row ever derives its body from anything but the
        // `text` prop — a truncation, a trim, or a markdown pass would all show up here.
        expand(container);
        expect(isCollapsed(container)).toBe(false);
        expect(reasoningTextOf(container)).toBe(text);
      }),
      RUNS,
    );
  });

  it("retains the content across the streaming-to-terminal transition", () => {
    // The real sequence, not just the end state: the row is open while reasoning streams, the
    // Run ends, the row collapses — and the text must survive that collapse rather than the
    // component being freshly mounted with it.
    fc.assert(
      fc.property(deltas, (parts) => {
        cleanup();
        const text = parts.join("");
        const view = render(
          <ChatMotionProvider budget={null}>
            <ReasoningRow text={text} streaming elapsedMs={1200} />
          </ChatMotionProvider>,
        );

        expect(isCollapsed(view.container)).toBe(false);

        view.rerender(
          <ChatMotionProvider budget={null}>
            <ReasoningRow text={text} terminal elapsedMs={1800} />
          </ChatMotionProvider>,
        );

        expect(isCollapsed(view.container)).toBe(true);
        // And it is still reachable: the collapse discarded nodes, not content.
        expand(view.container);
        expect(reasoningTextOf(view.container)).toBe(text);
      }),
      RUNS,
    );
  });

  it("does not re-collapse a region the user reopened", () => {
    // The failure a *derived* `open` produces: deriving it from `terminal` would collapse the
    // region again on the next render, and the control would appear broken. The collapse is a
    // transition observed once, so the user's choice afterwards is theirs.
    const view = render(
      <ChatMotionProvider budget={null}>
        <ReasoningRow text="a thought" terminal elapsedMs={900} />
      </ChatMotionProvider>,
    );
    expand(view.container);
    expect(isCollapsed(view.container)).toBe(false);

    view.rerender(
      <ChatMotionProvider budget={null}>
        <ReasoningRow text="a thought" terminal elapsedMs={900} />
      </ChatMotionProvider>,
    );
    expect(isCollapsed(view.container)).toBe(false);
  });

  it("marks the collapsed region hidden rather than removing the disclosure", () => {
    // The region itself stays in the DOM and is `hidden`, so the trigger keeps its
    // `aria-controls` target and a screen reader is told there is something collapsed here
    // rather than finding a dangling reference (R21.4).
    const { container } = mount({ text: "retained", terminal: true });
    const content = container.querySelector("[data-zoc-reasoning-content]");
    const trigger = container.querySelector("[data-zoc-reasoning-trigger]");

    expect(content).not.toBeNull();
    expect(content?.hasAttribute("hidden")).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-controls")).toBe(content?.getAttribute("id"));
  });

  it("formats the elapsed duration at a precision a reader can use (R8.3)", () => {
    // Sub-second in milliseconds, because "0s" reads as "it did not happen" and the point of
    // the readout is that it did.
    expect(formatReasoningDuration(0)).toBe("0ms");
    expect(formatReasoningDuration(420)).toBe("420ms");
    expect(formatReasoningDuration(1_500)).toBe("1.5s");
    expect(formatReasoningDuration(94_000)).toBe("1m 34s");
    // A provider that reports nonsense must not render `NaNms`.
    expect(formatReasoningDuration(Number.NaN)).toBe("0ms");
    expect(formatReasoningDuration(-5)).toBe("0ms");
  });
});

describe("the redacted form (R8.4)", () => {
  it("states the duration and withholds the disclosure entirely", () => {
    // A provider that reports reasoning happened and declines to return it. Offering a control
    // that expands to an empty region would teach the user the UI is broken; stating the fact
    // tells them what actually happened.
    const { container } = mount({ text: "", redacted: true, elapsedMs: 2_400 });

    expect(container.querySelector("[data-zoc-reasoning-redacted]")).not.toBeNull();
    expect(container.querySelector("[data-zoc-reasoning-trigger]")).toBeNull();
    expect(container.querySelector("[data-zoc-reasoning-content]")).toBeNull();
    expect(container.querySelector("[data-zoc-reasoning-duration]")?.textContent).toContain("2.4s");
  });

  it("is a redacted row even while the reasoning is still streaming", () => {
    // The flag arrives with the first part, so the row must not offer a disclosure that would
    // vanish when the Run settles.
    const { container } = mount({ text: "", redacted: true, streaming: true, elapsedMs: 300 });
    expect(container.querySelector("[data-zoc-reasoning-trigger]")).toBeNull();
    expect(container.querySelector("[data-zoc-reasoning-live]")).not.toBeNull();
  });
});

describe("the live indicator (R8.3, R19.3)", () => {
  it("shows a live dot and the duration while streaming", () => {
    const { container } = mount({ text: "thinking", streaming: true, elapsedMs: 800 });
    expect(container.querySelector("[data-zoc-reasoning-live]")).not.toBeNull();
    expect(container.querySelector("[data-zoc-reasoning-duration]")?.textContent).toContain(
      "800ms",
    );
  });

  it("drops the dot once reasoning has finished, keeping the duration", () => {
    // The duration outlives the indicator: it is the only quantitative fact the region carries,
    // and a settled row that dropped it would lose the answer to "how long did it think".
    const { container } = mount({ text: "thought", elapsedMs: 1_800 });
    expect(container.querySelector("[data-zoc-reasoning-live]")).toBeNull();
    expect(container.querySelector("[data-zoc-reasoning-duration]")?.textContent).toContain("1.8s");
  });

  it("stays open while streaming, so the indicator indicates something visible", () => {
    const { container } = mount({ text: "thinking", streaming: true });
    expect(isCollapsed(container)).toBe(false);
  });
});
