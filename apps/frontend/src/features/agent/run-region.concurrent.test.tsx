import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AgentStreamContext } from "./agent-stream-context";
import { RunRegion } from "./RunRegion";
import { useApp } from "@/lib/store";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  useApp.setState({
    chat: [],
    runId: "run-a",
    focusedRunId: "run-a",
    agentMode: "agent",
    activeRunMode: "agent",
    trackedRuns: [
      {
        runId: "run-a",
        mode: "agent",
        phase: "running",
        title: "Active A",
        startedAt: 1,
        stage: "apply",
        tokensUsed: 320,
        tokenLimit: 4096,
      },
      {
        runId: "run-b",
        mode: "ask",
        phase: "done",
        title: "Finished B",
        startedAt: 2,
        endedAt: 3,
      },
    ],
  });
});

test("renders a focused run stack with per-run controls", () => {
  const cancelRunById = vi.fn(async () => undefined);
  useApp.setState({ cancelRunById });

  const { container } = render(
    <AgentStreamContext.Provider
      value={{
        status: "open",
        events: [
          {
            type: "token",
            seq: 1,
            runId: "run-a",
            ts: "2026-01-01T00:00:00.000Z",
            text: "working",
          },
          {
            type: "token",
            seq: 1,
            runId: "run-b",
            ts: "2026-01-01T00:00:01.000Z",
            text: "finished answer",
            done: true,
          },
        ],
      }}
    >
      <RunRegion />
    </AgentStreamContext.Provider>,
  );

  const cards = container.querySelectorAll<HTMLElement>("[data-testid='run-trace-card']");
  expect(cards).toHaveLength(2);
  expect(cards[0]).toHaveAttribute("data-run-id", "run-a");
  expect(cards[0]).toHaveAttribute("data-focused", "true");
  expect(screen.getByTitle("320 of 4,096 tokens")).toBeInTheDocument();
  expect(screen.getByLabelText("Expand run")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Stop Active A"));
  expect(cancelRunById).toHaveBeenCalledWith("run-a");
});
