import { describe, expect, it } from "vitest";
import {
  STAGE_COLORS,
  UNKNOWN_STAGE_COLOR,
  buildRunTrace,
  buildSegments,
  criticalPath,
  formatDuration,
  formatOffset,
  serializeTrace,
  stageColor,
  stageForEventType,
  summarizeEvent,
  traceFilename,
} from "../run-trace";

const T0 = Date.parse("2026-07-25T05:00:00.000Z");

const ev = (seq: number, type: string, offsetMs: number, extra: Record<string, unknown> = {}) => ({
  seq,
  type,
  runId: "r1",
  ts: new Date(T0 + offsetMs).toISOString(),
  ...extra,
});

describe("stage mapping", () => {
  it("maps each event type to its FSM stage", () => {
    expect(stageForEventType("intent")).toBe("INTAKE");
    expect(stageForEventType("thinking")).toBe("ANALYZE");
    expect(stageForEventType("plan")).toBe("PLAN");
    expect(stageForEventType("edit-file")).toBe("APPLY");
    expect(stageForEventType("command")).toBe("VERIFY");
    expect(stageForEventType("summary")).toBe("SUMMARY");
  });

  it("falls back to UNKNOWN for an unmapped type", () => {
    expect(stageForEventType("brand-new-event")).toBe("UNKNOWN");
    expect(stageColor("UNKNOWN")).toBe(UNKNOWN_STAGE_COLOR);
  });

  it("uses the documented colour per stage", () => {
    expect(stageColor("INTAKE")).toBe(STAGE_COLORS.INTAKE);
    expect(stageColor("APPLY")).toBe(STAGE_COLORS.APPLY);
  });
});

describe("buildRunTrace", () => {
  it("computes offsets, durations and total duration", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "intent", 0),
      ev(2, "thinking", 500),
      ev(3, "done", 2000, { ok: true }),
    ] as never[]);

    expect(trace.durationMs).toBe(2000);
    expect(trace.events.map((e) => e.offsetMs)).toEqual([0, 500, 2000]);
    // Duration is the gap to the next event; the last event gets 0.
    expect(trace.events.map((e) => e.durationMs)).toEqual([500, 1500, 0]);
  });

  it("orders by seq regardless of input order", () => {
    const trace = buildRunTrace("r1", [
      ev(3, "done", 200, { ok: true }),
      ev(1, "intent", 0),
      ev(2, "thinking", 100),
    ] as never[]);
    expect(trace.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("handles an empty event list", () => {
    const trace = buildRunTrace("r1", []);
    expect(trace.events).toEqual([]);
    expect(trace.segments).toEqual([]);
    expect(trace.durationMs).toBe(0);
  });

  it("survives unparseable timestamps", () => {
    const trace = buildRunTrace("r1", [
      { seq: 1, type: "intent", runId: "r1", ts: "not a date" },
      ev(2, "done", 1000, { ok: true }),
    ] as never[]);
    expect(trace.events[0].offsetMs).toBe(0);
    expect(trace.durationMs).toBe(0);
  });

  it("takes the highest budget reading as the token total", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "budget", 0, { tokensUsed: 100, tokenLimit: 4000 }),
      ev(2, "budget", 10, { tokensUsed: 900, tokenLimit: 4000 }),
    ] as never[]);
    expect(trace.totalTokens).toBe(900);
  });

  it("ignores malformed entries instead of throwing", () => {
    const trace = buildRunTrace("r1", [null, { seq: 1 }, ev(2, "intent", 0)] as never[]);
    expect(trace.events).toHaveLength(1);
  });
});

describe("buildSegments", () => {
  it("collapses consecutive same-stage events into one band", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "thinking", 0),
      ev(2, "map-files", 100),
      ev(3, "read-files", 200),
      ev(4, "edit-file", 300, { path: "a.ts" }),
    ] as never[]);

    expect(trace.segments.map((s) => s.stage)).toEqual(["ANALYZE", "APPLY"]);
    expect(trace.segments[0].eventCount).toBe(3);
  });

  it("emits a second band when a stage is re-entered", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "plan", 0),
      ev(2, "edit-file", 100, { path: "a.ts" }),
      ev(3, "plan", 200),
    ] as never[]);
    expect(trace.segments.map((s) => s.stage)).toEqual(["PLAN", "APPLY", "PLAN"]);
  });

  it("ratios sum to at most one and are zero for a zero-length run", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "intent", 0),
      ev(2, "edit-file", 1000, { path: "a.ts" }),
    ] as never[]);
    const total = trace.segments.reduce((sum, s) => sum + s.ratio, 0);
    expect(total).toBeLessThanOrEqual(1.0001);

    expect(buildSegments([], 0)).toEqual([]);
  });

  it("attributes budget deltas to the stage active at each snapshot", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "thinking", 0),
      ev(2, "budget", 10, { tokensUsed: 100, tokenLimit: 1000 }),
      ev(3, "edit-file", 20, { path: "a.ts" }),
      ev(4, "budget", 30, { tokensUsed: 275, tokenLimit: 1000 }),
      ev(5, "done", 40, { ok: true }),
    ] as never[]);

    expect(trace.segments.find((segment) => segment.stage === "ANALYZE")?.tokenCount).toBe(100);
    expect(trace.segments.find((segment) => segment.stage === "APPLY")?.tokenCount).toBe(175);
  });
});

describe("criticalPath", () => {
  it("selects the slowest events covering most of the duration", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "intent", 0), // 10ms
      ev(2, "thinking", 10), // 4990ms  ← dominant
      ev(3, "edit-file", 5000, { path: "a.ts" }), // 10ms
      ev(4, "done", 5010, { ok: true }), // 0
    ] as never[]);

    expect(criticalPath(trace)).toEqual([2]);
  });

  it("returns nothing when no event has a measurable duration", () => {
    const trace = buildRunTrace("r1", [ev(1, "intent", 0)] as never[]);
    expect(criticalPath(trace)).toEqual([]);
    expect(criticalPath(buildRunTrace("r1", []))).toEqual([]);
  });

  it("returns seqs in ascending order", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "intent", 0),
      ev(2, "thinking", 1000),
      ev(3, "edit-file", 3000, { path: "a.ts" }),
      ev(4, "done", 4000, { ok: true }),
    ] as never[]);
    const path = criticalPath(trace, 0.99);
    expect(path).toEqual([...path].sort((a, b) => a - b));
  });
});

describe("summarizeEvent", () => {
  it("describes each event type usefully", () => {
    expect(summarizeEvent({ type: "intent", text: "first line\nsecond" })).toBe("first line");
    expect(summarizeEvent({ type: "edit-file", path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeEvent({ type: "command", command: "pytest -q" })).toBe("pytest -q");
    expect(summarizeEvent({ type: "read-files", readList: [1, 2] })).toBe("2 files");
    expect(summarizeEvent({ type: "read-files", readList: [1] })).toBe("1 file");
    expect(summarizeEvent({ type: "done", ok: true })).toBe("completed");
    expect(summarizeEvent({ type: "done", ok: false, reason: "boom" })).toBe("failed: boom");
    expect(summarizeEvent({ type: "budget", tokensUsed: 10, tokenLimit: 20 })).toBe(
      "10 / 20 tokens",
    );
  });

  it("falls back to the type for anything unknown", () => {
    expect(summarizeEvent({ type: "mystery" })).toBe("mystery");
  });
});

describe("formatting", () => {
  it("scales units by magnitude", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(-5)).toBe("0ms");
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  it("prefixes offsets", () => {
    expect(formatOffset(1500)).toBe("+1.5s");
  });
});

describe("export", () => {
  it("serialises a complete, re-parseable trace", () => {
    const trace = buildRunTrace("r1", [
      ev(1, "intent", 0),
      ev(2, "done", 100, { ok: true }),
    ] as never[]);

    const parsed = JSON.parse(serializeTrace(trace));
    expect(parsed.runId).toBe("r1");
    expect(parsed.durationMs).toBe(100);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({ seq: 1, type: "intent", stage: "INTAKE" });
    expect(parsed.segments.length).toBeGreaterThan(0);
    expect(parsed.startedAt).toBe("2026-07-25T05:00:00.000Z");
  });

  it("builds a filesystem-safe filename", () => {
    expect(traceFilename("run/../etc")).toBe("zoc-trace-run-..-etc.json");
    expect(traceFilename("")).toBe("zoc-trace-run.json");
  });
});
