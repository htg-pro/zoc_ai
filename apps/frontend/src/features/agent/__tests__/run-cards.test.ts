/**
 * run-cards.test.ts — which run cards the run region shows, and in what order.
 *
 * Built on the single seam: `assembleRunCards` groups `FeedRow[]` by `runId`.
 */
import { describe, expect, it } from "vitest";

import { assembleRunCards } from "@/features/agent/run-cards";
import type { FeedRow } from "@/features/agent/normalize";
import type { TrackedRun } from "@/features/agent/agent-runs";

function tracked(runId: string, over: Partial<TrackedRun> = {}): TrackedRun {
  return {
    runId,
    mode: "agent",
    phase: "running",
    title: `run ${runId}`,
    startedAt: 1_000,
    ...over,
  };
}

function metaRow(runId: string): FeedRow {
  return {
    kind: "run-metadata",
    id: `run-metadata:${runId}:0`,
    seq: 0,
    runId,
    modelTier: "local-slm",
    contextWindowTokens: 4096,
    fallbackReason: null,
  };
}

function assistantRow(runId: string, text: string): FeedRow {
  return {
    kind: "assistant-message",
    id: `assistant:${runId}`,
    seq: 1,
    runId,
    messageId: `assistant:${runId}`,
    text,
    streaming: false,
  };
}

describe("assembleRunCards", () => {
  it("pairs a tracked run with its rows from the feed", () => {
    const cards = assembleRunCards({
      rows: [metaRow("run-1")],
      trackedRuns: [tracked("run-1")],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].run?.runId).toBe("run-1");
    expect(cards[0].rows).toHaveLength(1);
    expect(cards[0].rows[0].kind).toBe("run-metadata");
  });

  it("shows an empty card for a tracked run whose first event has not arrived", () => {
    const cards = assembleRunCards({ rows: [], trackedRuns: [tracked("run-2")] });
    expect(cards).toHaveLength(1);
    expect(cards[0].runId).toBe("run-2");
    expect(cards[0].rows).toEqual([]);
    expect(cards[0].run?.phase).toBe("running");
  });

  it("shows a card for a run seen only in the feed", () => {
    const cards = assembleRunCards({
      rows: [assistantRow("run-remote", "answer")],
      trackedRuns: [],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].run).toBeUndefined();
    expect(cards[0].runId).toBe("run-remote");
  });

  it("hoists the focused run to the top", () => {
    const cards = assembleRunCards({
      rows: [],
      trackedRuns: [tracked("a"), tracked("b"), tracked("c")],
      focusedRunId: "c",
    });
    expect(cards.map((card) => card.runId)[0]).toBe("c");
    expect(cards).toHaveLength(3);
  });

  it("never emits two cards for the same run", () => {
    const cards = assembleRunCards({
      rows: [metaRow("run-1"), assistantRow("run-1", "hi")],
      trackedRuns: [tracked("run-1")],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].rows).toHaveLength(2);
  });
});
