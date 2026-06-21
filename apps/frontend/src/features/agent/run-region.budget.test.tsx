import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./useAgentStream";

import { useApp } from "@/lib/store";

const stream = vi.hoisted(() => ({ events: [] as AgentEvent[] }));

vi.mock("./useAgentStream", () => ({
  default: () => ({ events: stream.events, status: "open" }),
}));

vi.mock("@/lib/store", () => ({ useApp: vi.fn() }));

import { RunRegion } from "./RunRegion";

const mockUseApp = vi.mocked(useApp);

describe("RunRegion budget telemetry", () => {
  const updateRunBudget = vi.fn();

  beforeEach(() => {
    updateRunBudget.mockReset();
    stream.events = [
      {
        type: "budget",
        seq: 2,
        runId: "run-active",
        ts: "2026-06-21T00:00:00Z",
        tokensUsed: 3200,
        tokenLimit: 4000,
        iterations: 4,
        recoveries: 1,
      },
    ];
    const state = {
      chat: [],
      agentMode: "agent",
      activeRunMode: "agent",
      runId: "run-active",
      finishGatewayRun: vi.fn(),
      commitAskStreamMessage: vi.fn(),
      updateRunBudget,
    };
    mockUseApp.mockImplementation((selector) => selector(state as never));
  });

  it("stores the latest budget frame for the active run", async () => {
    render(<RunRegion />);

    await waitFor(() => expect(updateRunBudget).toHaveBeenCalledTimes(1));
    expect(updateRunBudget).toHaveBeenCalledWith(stream.events[0]);
  });
});
