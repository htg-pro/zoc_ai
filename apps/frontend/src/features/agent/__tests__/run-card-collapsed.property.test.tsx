// Feature: zoc-ai-agent-chat-overhaul, Property 37: A collapsed run card duplicates no separately rendered content
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { type FeedRow } from "../normalize";
import { renderRow } from "../rows";
import { RunCardView, summarizeSteps } from "../RunCardView";
import type { RunCard } from "../run-cards";
import type { TrackedRun } from "../agent-runs";

afterEach(cleanup);

function distinctiveRows(seed: number): FeedRow[] {
  return [
    { kind: "assistant-message", id: `am:${seed}`, seq: 1, runId: "r", messageId: `m${seed}`, text: `UNIQUEANSWER${seed}`, streaming: false },
    { kind: "tool-call", id: `tc:${seed}`, seq: 2, runId: "r", tool: "shell", target: `UNIQUECMD${seed}`, status: "succeeded", result: "ok", failure: null, key: `k${seed}` },
    { kind: "diff", id: `d:${seed}`, seq: 3, runId: "r", files: [{ path: `UNIQUEFILE${seed}.ts`, adds: 1, dels: 0, diff: "@@\n+x", baseHash: null }], decision: "applied" },
  ];
}

describe("collapsed run card (Property 37)", () => {
  it("renders no row content when collapsed — disjoint from standalone rows", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9999 }), (seed) => {
        const rows = distinctiveRows(seed);
        const run: TrackedRun = {
          runId: "r",
          mode: "agent",
          phase: "done",
          title: "t",
          startedAt: 0,
          endedAt: 10,
        };
        const card: RunCard = { runId: "r", rows, run };

        const collapsed = render(<RunCardView card={card} focused={false} collapsed />);
        const collapsedText = collapsed.container.textContent ?? "";

        // The standalone row text set.
        const standalone = render(<div>{rows.map((r) => <div key={r.id}>{renderRow(r)}</div>)}</div>);
        const standaloneText = standalone.container.textContent ?? "";

        // Collapsed card shows a step summary...
        expect(collapsedText).toContain(`${summarizeSteps(rows)} step`);
        // ...and none of the distinctive standalone content.
        for (const token of [`UNIQUEANSWER${seed}`, `UNIQUECMD${seed}`, `UNIQUEFILE${seed}`]) {
          expect(standaloneText).toContain(token);
          expect(collapsedText).not.toContain(token);
        }

        collapsed.unmount();
        standalone.unmount();
      }),
      { numRuns: 60 },
    );
  });
});
