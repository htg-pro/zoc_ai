/**
 * run-presence.test.ts — the single derivation of "is a run happening".
 *
 * The header used to compute this inline while each card computed its own, and
 * the elapsed clock was measured from when the header noticed rather than from
 * the run's own start.
 */
import { describe, expect, it } from "vitest";

import { deriveRunPresence } from "@/features/agent/run-presence";
import type { TrackedRun } from "@/features/agent/agent-runs";

function run(over: Partial<TrackedRun> = {}): TrackedRun {
  return {
    runId: "r1",
    mode: "agent",
    phase: "running",
    title: "do the thing",
    startedAt: 1_000,
    ...over,
  };
}

const base = { streaming: false, agentMode: "agent" as const };

describe("deriveRunPresence", () => {
  it("is idle with nothing running", () => {
    const presence = deriveRunPresence({ ...base, trackedRuns: [] });
    expect(presence).toMatchObject({ active: false, phase: "idle", startedAt: null });
  });

  it("is active for a tracked run and reports its start time", () => {
    const presence = deriveRunPresence({ ...base, trackedRuns: [run({ startedAt: 5_000 })] });
    expect(presence.active).toBe(true);
    expect(presence.phase).toBe("running");
    // The run's own clock — not "now".
    expect(presence.startedAt).toBe(5_000);
  });

  it("keeps the focused run's start time when focus moves between runs", () => {
    const runs = [run({ runId: "a", startedAt: 1_000 }), run({ runId: "b", startedAt: 9_000 })];

    expect(deriveRunPresence({ ...base, trackedRuns: runs, focusedRunId: "a" }).startedAt).toBe(
      1_000,
    );
    expect(deriveRunPresence({ ...base, trackedRuns: runs, focusedRunId: "b" }).startedAt).toBe(
      9_000,
    );
  });

  it("counts an untracked stream, falling back to the store's run clock", () => {
    const presence = deriveRunPresence({
      ...base,
      trackedRuns: [],
      streaming: true,
      runStartedAt: 4_200,
    });
    expect(presence.active).toBe(true);
    expect(presence.startedAt).toBe(4_200);
  });

  it("does not count `streaming` once runs are tracked", () => {
    // A finished tracked run plus a stale `streaming` flag must read as idle,
    // which is the disagreement that let the header pulse over done cards.
    const presence = deriveRunPresence({
      ...base,
      trackedRuns: [run({ phase: "done", endedAt: 2_000 })],
      streaming: true,
    });
    expect(presence.active).toBe(false);
    expect(presence.phase).toBe("idle");
  });

  it("reports paused separately from idle", () => {
    const presence = deriveRunPresence({
      ...base,
      trackedRuns: [run()],
      agentPaused: true,
    });
    expect(presence).toMatchObject({ active: true, phase: "paused", statusText: "Paused" });
  });

  it("labels Ask as answering, Plan as planning, and Agent as building", () => {
    expect(
      deriveRunPresence({ ...base, trackedRuns: [run({ mode: "ask" })] }).statusText,
    ).toBe("Answering…");
    expect(
      deriveRunPresence({ ...base, trackedRuns: [run({ mode: "plan" })] }).statusText,
    ).toBe("Planning…");
    expect(deriveRunPresence({ ...base, trackedRuns: [run()] }).statusText).toBe("Building…");
  });

  it("says watching for a read-only viewer", () => {
    expect(
      deriveRunPresence({ ...base, trackedRuns: [run()], viewerReadOnly: true }).statusText,
    ).toBe("Watching…");
  });

  it("stays active while a review or test run is in flight", () => {
    expect(deriveRunPresence({ ...base, trackedRuns: [], reviewRunning: true }).active).toBe(true);
    expect(deriveRunPresence({ ...base, trackedRuns: [], testRunning: true }).active).toBe(true);
  });

  it("targets a stoppable run, never a terminal one", () => {
    const stoppable = deriveRunPresence({ ...base, trackedRuns: [run({ runId: "live" })] });
    expect(stoppable.stopRunId).toBe("live");

    const finished = deriveRunPresence({
      ...base,
      trackedRuns: [run({ runId: "gone", phase: "done", endedAt: 5 })],
      focusedRunId: "gone",
    });
    expect(finished.stopRunId).toBeUndefined();
  });
});
