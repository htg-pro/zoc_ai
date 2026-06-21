import { describe, expect, it } from "vitest";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { buildRunTraces } from "./agent-trace";

const TS = "2024-01-01T00:00:00.000Z";

describe("agent trace reducer", () => {
  it("folds plan updates, command streaming, review, summary, and done into one trace", () => {
    const events = [
      {
        type: "intent",
        seq: 0,
        runId: "run-1",
        ts: TS,
        text: "change the button",
        modelTier: "local-slm",
        contextWindowTokens: 4096,
      },
      {
        type: "plan",
        seq: 1,
        runId: "run-1",
        ts: TS,
        checkpointId: "cp-1",
        items: [
          { id: "apply", label: "Apply isolated changes", status: "active" },
          { id: "validate", label: "Run validation", status: "pending" },
        ],
      },
      { type: "plan-update", seq: 2, runId: "run-1", ts: TS, id: "apply", status: "done" },
      { type: "plan-update", seq: 3, runId: "run-1", ts: TS, id: "validate", status: "active" },
      {
        type: "command",
        seq: 4,
        runId: "run-1",
        ts: TS,
        command: "pnpm test",
        commandId: "checks",
        status: "running",
        outputDelta: "running",
      },
      {
        type: "command",
        seq: 5,
        runId: "run-1",
        ts: TS,
        command: "pnpm test",
        commandId: "checks",
        status: "pass",
        exitCode: 0,
        outputTail: "ok",
      },
      {
        type: "test-results",
        seq: 6,
        runId: "run-1",
        ts: TS,
        status: "pass",
        command: "pnpm test",
        source: "package.json",
        passed: 12,
        failed: 0,
        exitCode: 0,
        outputTail: "12 passed",
        durationMs: 900,
        timedOut: false,
      },
      {
        type: "review",
        seq: 7,
        runId: "run-1",
        ts: TS,
        checkpointId: "cp-1",
        files: [{ path: "src/App.tsx", diff: "@@ -1 +1 @@\n-old\n+new", adds: 1, dels: 1 }],
        validation: {
          typecheck: { status: "pass" },
          build: { status: "skipped" },
          tests: { status: "skipped" },
        },
      },
      { type: "summary", seq: 8, runId: "run-1", ts: TS, text: "Applied 1 reviewed file." },
      { type: "done", seq: 9, runId: "run-1", ts: TS, ok: true },
    ] satisfies AgentEvents.AgentEvent[];

    const [trace] = buildRunTraces(events);

    expect(trace.runId).toBe("run-1");
    expect(trace.status).toBe("done");
    expect(trace.checkpointId).toBe("cp-1");
    expect(trace.planItems).toEqual([
      { id: "apply", label: "Apply isolated changes", status: "done" },
      { id: "validate", label: "Run validation", status: "active" },
    ]);
    expect(trace.activities.find((activity) => activity.id === "command:checks")).toMatchObject({
      kind: "command",
      status: "pass",
      output: "ok",
    });
    expect(trace.review?.files[0]).toMatchObject({ path: "src/App.tsx", adds: 1, dels: 1 });
    expect(trace.testResults).toMatchObject({ status: "pass", passed: 12, failed: 0 });
    expect(trace.summary).toBe("Applied 1 reviewed file.");
  });
});
