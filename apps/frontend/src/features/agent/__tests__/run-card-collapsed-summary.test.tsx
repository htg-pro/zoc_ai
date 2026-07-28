// Feature: zoc-ai-agent-chat-overhaul, Task 14: collapsed completed cards still expose the outcome facts
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RunCardView } from "../RunCardView";
import type { TrackedRun } from "../agent-runs";

afterEach(cleanup);

const doneRun: TrackedRun = {
  runId: "r1",
  mode: "agent",
  phase: "done",
  title: "t",
  startedAt: 0,
  endedAt: 65_000,
  filesChanged: 3,
};

describe("collapsed run card summary (R8.2/R8.7/R8.8)", () => {
  it("exposes outcome, duration, and files changed while collapsed", () => {
    const { getByTestId } = render(
      <RunCardView card={{ runId: "r1", run: doneRun, rows: [] }} focused={false} collapsed />,
    );
    const summary = getByTestId("run-card-collapsed-summary").textContent ?? "";
    expect(summary).toContain("Completed");
    expect(summary).toContain("1m 05s");
    expect(summary).toContain("3 files changed");
  });

  it("names the zero-change reason for a collapsed agent run", () => {
    const zero: TrackedRun = {
      ...doneRun,
      runId: "r2",
      filesChanged: 0,
      outcomeReason: "the code already did that",
    };
    const { getByTestId } = render(
      <RunCardView card={{ runId: "r2", run: zero, rows: [] }} focused={false} collapsed />,
    );
    const summary = getByTestId("run-card-collapsed-summary").textContent ?? "";
    expect(summary).toContain("0 files changed");
    expect(summary).toContain("the code already did that");
  });

  it("offers Retry for a stalled run and Stop while it is still live", () => {
    const stalled: TrackedRun = {
      runId: "r3",
      mode: "agent",
      phase: "stalled",
      title: "t",
      startedAt: 0,
      stage: "edit",
    };
    const onRetry = vi.fn();
    const onStop = vi.fn();
    const { getByText } = render(
      <RunCardView
        card={{ runId: "r3", run: stalled, rows: [] }}
        focused
        collapsed={false}
        onRetry={onRetry}
        onStop={onStop}
      />,
    );
    // The card names the stalled state and its last stage.
    expect(getByText(/Stalled/)).toBeTruthy();
    fireEvent.click(getByText("Retry"));
    expect(onRetry).toHaveBeenCalledWith("r3");
    fireEvent.click(getByText("Stop"));
    expect(onStop).toHaveBeenCalledWith("r3");
  });
});


describe("mode-aware terminal summaries", () => {
  it("describes a stopped Plan without claiming files were changed", () => {
    const planRun: TrackedRun = {
      ...doneRun,
      runId: "plan-1",
      mode: "plan",
      phase: "cancelled",
      filesChanged: 0,
    };
    const { getByTestId, getByText } = render(
      <RunCardView
        card={{ runId: planRun.runId, run: planRun, rows: [] }}
        focused={false}
        collapsed
      />,
    );

    expect(getByText("Plan")).toBeInTheDocument();
    const summary = getByTestId("run-card-collapsed-summary").textContent ?? "";
    expect(summary).toContain("No changes applied");
    expect(summary).not.toContain("files changed");
  });

  it("omits file-change metadata for Ask", () => {
    const askRun: TrackedRun = {
      ...doneRun,
      runId: "ask-1",
      mode: "ask",
      filesChanged: 0,
    };
    const { getByTestId, getByText } = render(
      <RunCardView
        card={{ runId: askRun.runId, run: askRun, rows: [] }}
        focused={false}
        collapsed
      />,
    );

    expect(getByText("Ask")).toBeInTheDocument();
    const summary = getByTestId("run-card-collapsed-summary").textContent ?? "";
    expect(summary).not.toContain("file");
    expect(summary).not.toContain("No changes applied");
  });
});
