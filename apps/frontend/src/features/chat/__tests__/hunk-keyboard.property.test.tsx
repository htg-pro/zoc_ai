/**
 * Property 56: A hunk is identifiable and operable from the keyboard. R21.5, R10.3, R21.7.
 *
 * *For any* diff, every hunk in the rendered review is a list item with an accessible name carrying the
 * file path and the hunk's line range, is reachable by focus, and can be accepted, rejected, toggled,
 * navigated away from, and expanded without a pointer.
 *
 * ## Why the keyboard half is asserted through the rendered decision rather than the callback
 *
 * A handler that fires and a decision that lands are different claims, and only the second is what a
 * user experiences. The harness below holds the decision map in state and feeds it back, so pressing `A`
 * is asserted by the row reporting itself accepted — which is the same path the store takes in the panel,
 * with the store's own behaviour already covered by `store.test.ts`.
 *
 * ## Navigation is clamped, and the property says so
 *
 * `J` on the last hunk stays on the last hunk. A wrap would move a reviewer from the end of a twelve-hunk
 * file back to its start with nothing to tell them the list ended, which is a worse failure than a key
 * that appears not to work — so the clamp is part of the claim rather than an implementation detail.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import fc from "fast-check";

import { diffPart } from "./arbitraries";
import { DiffReview } from "@/features/chat/review/DiffReview";
import { HUNK_COLLAPSE_LINES } from "@/features/chat/review/hunk-lines";
import type { HunkDecision } from "@/features/chat/store";
import type { DiffPart, Hunk } from "@zoc-studio/shared-types";

const RUNS = { numRuns: 40 } as const;

afterEach(cleanup);

/** A stateful shell, so a keypress is asserted by what the row then reports about itself. */
function Harness({ diff, stale = false }: { diff: DiffPart; stale?: boolean }) {
  const [decisions, setDecisions] = useState<Record<string, HunkDecision>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  return (
    <DiffReview
      diff={diff}
      stale={stale}
      decisions={decisions}
      isExpanded={(hunkId) => expanded.has(hunkId)}
      onDecideHunk={(hunkId, decision) => {
        setDecisions((current) => ({ ...current, [hunkId]: decision }));
      }}
      onDecideFile={(decision) => {
        setDecisions((current) => ({ ...current, __file__: decision }));
      }}
      onExpandedChange={(hunkId, open) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (open) next.add(hunkId);
          else next.delete(hunkId);
          return next;
        });
      }}
    />
  );
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("listitem");
}

describe("Feature: zoc-agent-chat-rebuild, Property 56: a hunk is identifiable and operable from the keyboard", () => {
  it("names every hunk with its path and line range, and makes it focusable (R21.5)", () => {
    fc.assert(
      fc.property(diffPart, (diff) => {
        cleanup();
        render(<Harness diff={diff} />);

        const listed = rows();
        expect(listed.length).toBe(diff.hunks.length);

        for (const row of listed) {
          const name = row.getAttribute("aria-label") ?? "";
          expect(name).toContain(diff.path);
          // A range, and a range that runs forwards: "lines 12–4" would be worse than no range at all,
          // and it is what the naive arithmetic produces for a zero-length pre-change side.
          const match = /lines (\d+)–(\d+)/.exec(name);
          expect(match).not.toBeNull();
          const from = Number(match?.[1] ?? "0");
          const to = Number(match?.[2] ?? "0");
          expect(to).toBeGreaterThanOrEqual(from);

          row.focus();
          expect(document.activeElement).toBe(row);
        }
      }),
      RUNS,
    );
  });

  it("accepts with A, rejects with R, and toggles with Space (R10.3)", () => {
    fc.assert(
      fc.property(diffPart, (diff) => {
        cleanup();
        render(<Harness diff={diff} />);
        const first = rows()[0];
        expect(first).toBeDefined();
        if (first === undefined) return;

        first.focus();
        expect(first.getAttribute("data-decision")).toBe("undecided");

        fireEvent.keyDown(first, { key: "a" });
        expect(rows()[0]?.getAttribute("data-decision")).toBe("accepted");

        fireEvent.keyDown(rows()[0] as HTMLElement, { key: "r" });
        expect(rows()[0]?.getAttribute("data-decision")).toBe("rejected");

        // Space flips acceptance rather than cycling: from rejected it accepts, and from accepted it
        // rejects. It never lands back on `undecided`, which is a state a review starts in.
        fireEvent.keyDown(rows()[0] as HTMLElement, { key: " " });
        expect(rows()[0]?.getAttribute("data-decision")).toBe("accepted");
        fireEvent.keyDown(rows()[0] as HTMLElement, { key: " " });
        expect(rows()[0]?.getAttribute("data-decision")).toBe("rejected");
      }),
      RUNS,
    );
  });

  it("moves between hunks with J/K and the arrows, clamped at both ends", () => {
    fc.assert(
      fc.property(
        diffPart.filter((diff) => diff.hunks.length >= 3),
        (diff) => {
          cleanup();
          render(<Harness diff={diff} />);
          const listed = rows();
          const last = listed.length - 1;

          listed[0]?.focus();
          fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j" });
          expect(document.activeElement).toBe(rows()[1]);

          fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
          expect(document.activeElement).toBe(rows()[2]);

          fireEvent.keyDown(document.activeElement as HTMLElement, { key: "k" });
          expect(document.activeElement).toBe(rows()[1]);

          fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
          expect(document.activeElement).toBe(rows()[0]);

          // Clamped at the top…
          fireEvent.keyDown(document.activeElement as HTMLElement, { key: "k" });
          expect(document.activeElement).toBe(rows()[0]);

          // …and at the bottom.
          rows()[last]?.focus();
          fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j" });
          expect(document.activeElement).toBe(rows()[last]);
        },
      ),
      RUNS,
    );
  });

  it("reveals a long body with Enter and offers nothing to expand on a short one", () => {
    const longHunk: Hunk = {
      hunkId: "h_long",
      oldStart: 1,
      oldLines: 60,
      newStart: 1,
      newLines: 60,
      patch: Array.from({ length: 60 }, (_, index) => ` line ${String(index)}`).join("\n"),
    };
    const diff: DiffPart = {
      type: "diff",
      seq: 1,
      runId: "run_1",
      messageId: "msg_1",
      ts: "2026-07-31T10:00:00.000Z",
      agentName: null,
      planId: "plan_1",
      path: "src/long.ts",
      action: "modify",
      sourcePath: null,
      language: "typescript",
      hunks: [longHunk],
      baseDigest: "sha256:abc",
      stale: false,
    };

    render(<Harness diff={diff} />);
    const row = rows()[0] as HTMLElement;

    const lineCount = () => row.querySelectorAll("[data-zoc-hunk-line]").length;
    expect(lineCount()).toBe(HUNK_COLLAPSE_LINES);

    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect((rows()[0] as HTMLElement).querySelectorAll("[data-zoc-hunk-line]").length).toBe(60);

    // And back, because the control is a toggle rather than a one-way reveal.
    fireEvent.keyDown(rows()[0] as HTMLElement, { key: "Enter" });
    expect((rows()[0] as HTMLElement).querySelectorAll("[data-zoc-hunk-line]").length).toBe(
      HUNK_COLLAPSE_LINES,
    );
  });

  it("offers no decision at all on a stale file, from the keyboard or otherwise (R10.8)", () => {
    fc.assert(
      fc.property(diffPart, (diff) => {
        cleanup();
        render(<Harness diff={diff} stale />);
        const first = rows()[0] as HTMLElement;

        // Absent rather than disabled, following the panel's rule: a disabled control invites a user to
        // work out why it is disabled, and the strip beside it already says.
        expect(first.querySelector("[data-zoc-hunk-accept]")).toBeNull();
        expect(first.querySelector("[data-zoc-hunk-reject]")).toBeNull();
        expect(screen.getByText("The file changed since this was proposed.")).toBeInTheDocument();

        first.focus();
        fireEvent.keyDown(first, { key: "a" });
        fireEvent.keyDown(rows()[0] as HTMLElement, { key: " " });
        expect(rows()[0]?.getAttribute("data-decision")).toBe("undecided");
      }),
      RUNS,
    );
  });

  it("carries added and removed lines with a glyph as well as a tint (R21.7)", () => {
    fc.assert(
      fc.property(diffPart, (diff) => {
        cleanup();
        render(<Harness diff={diff} />);

        const added = document.querySelectorAll('[data-zoc-hunk-line="add"]');
        const removed = document.querySelectorAll('[data-zoc-hunk-line="remove"]');
        for (const element of [...added, ...removed]) {
          const glyph = element.querySelector("[data-zoc-line-glyph]");
          expect(glyph).not.toBeNull();
          expect((glyph?.textContent ?? "").trim().length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });
});
