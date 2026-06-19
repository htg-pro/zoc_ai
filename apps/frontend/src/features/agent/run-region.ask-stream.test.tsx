import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { useApp } from "@/lib/store";
import type { AgentEvent } from "./useAgentStream";

const mockStream = vi.hoisted(() => ({
  events: [] as AgentEvent[],
}));

vi.mock("./useAgentStream", () => ({
  default: () => ({ events: mockStream.events, status: "open" }),
}));

import { RunRegion } from "./RunRegion";

const TS = "2024-01-01T00:00:00.000Z";

beforeEach(() => {
  mockStream.events = [];
  useApp.setState({
    chat: [],
    agentMode: "ask",
    activeRunMode: null,
    runId: null,
    streaming: false,
    isRunning: false,
    messageQueue: [],
  });
});

afterEach(() => {
  cleanup();
});

describe("RunRegion Ask stream rendering", () => {
  it("renders streamed token chunks as one Agent bubble and finishes on terminal token", async () => {
    mockStream.events = [
      { type: "token", seq: 1, runId: "run-ask", ts: TS, text: "OK", done: false },
      { type: "token", seq: 2, runId: "run-ask", ts: TS, text: ".", done: false },
    ];
    useApp.setState({
      agentMode: "ask",
      runId: "run-ask",
      streaming: true,
      isRunning: true,
    });

    const { rerender } = render(<RunRegion />);

    expect(screen.getByText("OK.")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    mockStream.events = [
      ...mockStream.events,
      { type: "token", seq: 3, runId: "run-ask", ts: TS, text: "", done: true },
    ];
    rerender(<RunRegion />);

    await waitFor(() => {
      expect(useApp.getState().streaming).toBe(false);
      expect(useApp.getState().isRunning).toBe(false);
      expect(useApp.getState().runId).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByText("OK.")).toBeInTheDocument();
    });
    const persisted = useApp
      .getState()
      .chat.filter((entry) => entry.id === "ask-final-run-ask");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.message?.role).toBe("assistant");
    expect(persisted[0]?.message?.content).toBe("OK.");

    rerender(<RunRegion />);

    expect(
      useApp.getState().chat.filter((entry) => entry.id === "ask-final-run-ask"),
    ).toHaveLength(1);
  });
});
