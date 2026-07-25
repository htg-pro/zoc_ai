import { afterEach, beforeEach, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";

import { AgentPanel } from "./AgentPanel";
import { AgentStreamContext } from "./agent-stream-context";
import { useApp } from "@/lib/store";

beforeEach(() => {
  window.history.replaceState({}, "", "/?token=share-secret&runId=run-viewer");
  useApp.setState({
    chat: [],
    runId: null,
    focusedRunId: null,
    trackedRuns: [],
    streaming: false,
    isRunning: false,
  });
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

test("shared session viewer is visibly and functionally read-only", () => {
  render(
    <AgentStreamContext.Provider
      value={{
        status: "open",
        events: [
          {
            type: "token",
            seq: 1,
            runId: "run-viewer",
            ts: "2026-01-01T00:00:00.000Z",
            text: "Shared answer",
          },
        ],
      }}
    >
      <AgentPanel />
    </AgentStreamContext.Provider>,
  );

  expect(screen.getByTestId("viewer-banner")).toHaveTextContent(
    "Viewing localhost:3000's session (read-only)",
  );
  expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
  expect(screen.getByText("Shared session controls are disabled (read-only).")).toBeInTheDocument();
  expect(screen.queryByText("Edit instructions")).not.toBeInTheDocument();
  expect(screen.queryByTitle("Stop run")).not.toBeInTheDocument();
  expect(screen.getByText("Shared answer")).toBeInTheDocument();
});
