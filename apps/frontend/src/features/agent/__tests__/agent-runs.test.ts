import { describe, expect, it } from "vitest";
import {
  activeRuns,
  canStartRun,
  finishRun,
  isTerminal,
  orderRuns,
  resolveFocusedRun,
  runCountBadge,
  runDuration,
  runLabel,
  upsertRun,
  type TrackedRun,
} from "../agent-runs";

const run = (over: Partial<TrackedRun> = {}): TrackedRun => ({
  runId: "r1",
  mode: "agent",
  phase: "running",
  title: "Fix the parser",
  startedAt: 1000,
  ...over,
});

describe("isTerminal / activeRuns", () => {
  it("treats done, failed and cancelled as terminal", () => {
    expect(isTerminal(run({ phase: "done" }))).toBe(true);
    expect(isTerminal(run({ phase: "failed" }))).toBe(true);
    expect(isTerminal(run({ phase: "cancelled" }))).toBe(true);
    expect(isTerminal(run({ phase: "running" }))).toBe(false);
    expect(isTerminal(run({ phase: "paused" }))).toBe(false);
  });

  it("counts paused runs as still active", () => {
    const runs = [run({ runId: "a" }), run({ runId: "b", phase: "paused" }), run({ runId: "c", phase: "done" })];
    expect(activeRuns(runs).map((r) => r.runId)).toEqual(["a", "b"]);
  });
});

describe("orderRuns", () => {
  it("puts active runs first oldest-first, then finished newest-first", () => {
    const runs = [
      run({ runId: "old-done", phase: "done", startedAt: 1, endedAt: 10 }),
      run({ runId: "active-new", startedAt: 300 }),
      run({ runId: "new-done", phase: "done", startedAt: 5, endedAt: 90 }),
      run({ runId: "active-old", startedAt: 100 }),
    ];
    expect(orderRuns(runs).map((r) => r.runId)).toEqual([
      "active-old",
      "active-new",
      "new-done",
      "old-done",
    ]);
  });

  it("is stable for an empty list", () => {
    expect(orderRuns([])).toEqual([]);
  });
});

describe("runCountBadge", () => {
  it("only shows a badge when more than one run is active", () => {
    expect(runCountBadge([])).toBeNull();
    expect(runCountBadge([run()])).toBeNull();
    expect(runCountBadge([run({ runId: "a" }), run({ runId: "b" })])).toBe("2");
    // Finished runs are not counted.
    expect(
      runCountBadge([run({ runId: "a" }), run({ runId: "b", phase: "done" })]),
    ).toBeNull();
  });
});

describe("canStartRun", () => {
  it("allows a new run below the cap and blocks at it", () => {
    const two = [run({ runId: "a" }), run({ runId: "b" })];
    expect(canStartRun(two, 3)).toBe(true);
    expect(canStartRun(two, 2)).toBe(false);
    // Finished runs free capacity.
    expect(canStartRun([run({ runId: "a", phase: "done" })], 1)).toBe(true);
  });

  it("treats a nonsensical cap as at least one", () => {
    expect(canStartRun([], 0)).toBe(true);
    expect(canStartRun([run()], 0)).toBe(false);
  });
});

describe("upsertRun", () => {
  it("appends a new run and merges an existing one", () => {
    const initial = upsertRun([], run({ runId: "a" }));
    expect(initial).toHaveLength(1);

    const updated = upsertRun(initial, run({ runId: "a", stage: "apply_edits" }));
    expect(updated).toHaveLength(1);
    expect(updated[0].stage).toBe("apply_edits");
    expect(updated[0].title).toBe("Fix the parser");
  });

  it("does not mutate its input", () => {
    const initial = [run({ runId: "a" })];
    upsertRun(initial, run({ runId: "b" }));
    expect(initial).toHaveLength(1);
  });
});

describe("finishRun", () => {
  it("stamps the phase and end time once", () => {
    const runs = finishRun([run({ runId: "a" })], "a", "done", 5000);
    expect(runs[0].phase).toBe("done");
    expect(runs[0].endedAt).toBe(5000);

    const again = finishRun(runs, "a", "failed", 9000);
    expect(again[0].phase).toBe("failed");
    expect(again[0].endedAt).toBe(5000);
  });

  it("ignores an unknown run id", () => {
    const runs = finishRun([run({ runId: "a" })], "zzz", "done", 1);
    expect(runs[0].phase).toBe("running");
  });
});

describe("resolveFocusedRun", () => {
  it("keeps a still-present focus", () => {
    const runs = [run({ runId: "a" }), run({ runId: "b" })];
    expect(resolveFocusedRun(runs, "b")).toBe("b");
  });

  it("falls back to the first ordered run when the focus disappears", () => {
    const runs = [run({ runId: "a", startedAt: 10 }), run({ runId: "b", startedAt: 5 })];
    expect(resolveFocusedRun(runs, "gone")).toBe("b");
    expect(resolveFocusedRun(runs, null)).toBe("b");
  });

  it("returns null with no runs", () => {
    expect(resolveFocusedRun([], "a")).toBeNull();
  });
});

describe("runLabel / runDuration", () => {
  it("truncates long titles and handles empty ones", () => {
    expect(runLabel(run({ title: "short" }))).toBe("short");
    expect(runLabel(run({ title: "  " }))).toBe("Untitled run");
    const long = runLabel(run({ title: "x".repeat(80) }));
    expect(long).toHaveLength(48);
    expect(long.endsWith("…")).toBe(true);
  });

  it("formats seconds and minutes, freezing at endedAt", () => {
    expect(runDuration(run({ startedAt: 0 }), 5_000)).toBe("5s");
    expect(runDuration(run({ startedAt: 0 }), 64_000)).toBe("1m 04s");
    expect(runDuration(run({ startedAt: 0, endedAt: 3_000 }), 999_000)).toBe("3s");
  });
});
