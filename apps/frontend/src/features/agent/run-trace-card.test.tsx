import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { RunTrace } from "./agent-trace";
import { useApp } from "@/lib/store";

const mockDecision = vi.hoisted(() => vi.fn());

vi.mock("./gateway-client", () => ({
  postAgentDecision: mockDecision,
}));

import { RunTraceCard } from "./RunTraceCard";

afterEach(() => {
  cleanup();
  mockDecision.mockReset();
  useApp.setState({
    agentRunCheckpoints: {},
    restoreAgentRunCheckpoint: useApp.getInitialState().restoreAgentRunCheckpoint,
  });
});

function reviewTrace(): RunTrace {
  return {
    runId: "run-review",
    startedSeq: 0,
    lastSeq: 4,
    status: "awaiting_review",
    stage: "review",
    checkpointId: "cp-1",
    planItems: [
      { id: "apply", label: "Apply changes in isolated workspace", status: "done" },
      { id: "review", label: "Review changes before applying", status: "active" },
    ],
    activities: [],
    review: {
      files: [
        { path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new", adds: 1, dels: 1 },
        { path: "src/b.ts", diff: "@@ -1 +1 @@\n-old\n+newer", adds: 1, dels: 1 },
      ],
      validation: {
        typecheck: { status: "pass" },
        build: { status: "skipped" },
        tests: { status: "skipped" },
      },
      checkpointId: "cp-1",
    },
  };
}

describe("RunTraceCard", () => {
  it("posts apply with only selected review files", async () => {
    mockDecision.mockResolvedValue(undefined);
    const trace = reviewTrace();

    render(<RunTraceCard trace={trace} />);
    expect(screen.getByTestId("diff-preview-modal")).toBeInTheDocument();
    expect(screen.getAllByText("Before").length).toBeGreaterThan(0);
    expect(screen.getAllByText("After").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("checkbox", { name: "Accept src/b.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept selected (1)" }));

    await waitFor(() => {
      expect(mockDecision).toHaveBeenCalledWith({
        runId: "run-review",
        decision: "apply",
        acceptedPaths: ["src/a.ts"],
      });
    });
  });

  it("posts accept all and reject all review decisions from the modal", async () => {
    mockDecision.mockResolvedValue(undefined);
    const { unmount } = render(<RunTraceCard trace={reviewTrace()} />);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));

    await waitFor(() => {
      expect(mockDecision).toHaveBeenCalledWith({
        runId: "run-review",
        decision: "apply",
        acceptedPaths: ["src/a.ts", "src/b.ts"],
      });
    });

    unmount();
    mockDecision.mockReset();
    render(<RunTraceCard trace={reviewTrace()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));

    await waitFor(() => {
      expect(mockDecision).toHaveBeenCalledWith({
        runId: "run-review",
        decision: "discard",
        acceptedPaths: [],
      });
    });
  });

  it("restores a git checkpoint commit from the trace header", async () => {
    const restore = vi.fn(async () => true);
    useApp.setState({
      agentRunCheckpoints: { "run-done": "abcdef1234567890" },
      restoreAgentRunCheckpoint: restore,
    });
    const trace: RunTrace = {
      runId: "run-done",
      startedSeq: 0,
      lastSeq: 4,
      status: "done",
      stage: "done",
      planItems: [],
      activities: [],
    };

    render(<RunTraceCard trace={trace} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore checkpoint" }));

    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith("run-done");
    });
  });

  it("shows compact pass and fail counts with failed output", () => {
    const trace: RunTrace = {
      runId: "run-tests",
      startedSeq: 0,
      lastSeq: 5,
      status: "paused",
      stage: "validate",
      planItems: [],
      activities: [],
      testResults: {
        status: "fail",
        command: "pnpm test",
        source: "package.json",
        passed: 7,
        failed: 2,
        exitCode: 1,
        output: "expected true, got false",
        durationMs: 1250,
        timedOut: false,
      },
    };

    render(<RunTraceCard trace={trace} />);

    expect(screen.getByTestId("test-results-panel")).toHaveAttribute(
      "data-test-status",
      "fail",
    );
    expect(screen.getByText("7 passed")).toBeInTheDocument();
    expect(screen.getByText("2 failed")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("Test output")).toBeInTheDocument();
  });
});
