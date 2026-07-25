import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { TerminalPane } from "../TerminalPane";
import { leaves, paneCount } from "@/lib/terminal-layout";
import { useApp } from "@/lib/store";

const mocks = vi.hoisted(() => ({
  events: [] as AgentEvents.CommandEvent[],
  disposeTerminal: vi.fn(async () => undefined),
  findInTerminal: vi.fn(() => true),
  killTerminal: vi.fn(async () => undefined),
  mountTerminal: vi.fn(),
  unmountTerminal: vi.fn(),
  writeToTerminal: vi.fn(),
}));

vi.mock("@/features/agent/agent-stream-context", () => ({
  useAgentStreamContext: () => ({ events: mocks.events, status: "open" }),
}));

vi.mock("@/lib/terminal-manager", () => ({
  createTerminal: vi.fn(async () => undefined),
  disposeTerminal: mocks.disposeTerminal,
  findInTerminal: mocks.findInTerminal,
  getTerminalOutput: () => "see src/main.ts:4:2\n5 passed, 0 failed",
  hasTerminal: () => true,
  killTerminal: mocks.killTerminal,
  mountTerminal: mocks.mountTerminal,
  setTerminalCallbacks: vi.fn(),
  subscribeTerminalOutput: () => () => undefined,
  unmountTerminal: mocks.unmountTerminal,
  writeToTerminal: mocks.writeToTerminal,
}));

function commandEvent(
  patch: Partial<AgentEvents.CommandEvent> = {},
): AgentEvents.CommandEvent {
  return {
    type: "command",
    seq: 1,
    runId: "run-1",
    ts: "2026-07-25T00:00:00Z",
    commandId: "command-1",
    command: "pnpm test",
    outputDelta: "5 passed, 0 failed\n",
    exitCode: 0,
    ...patch,
  };
}

beforeEach(() => {
  mocks.events = [];
  mocks.disposeTerminal.mockClear();
  mocks.findInTerminal.mockClear();
  mocks.killTerminal.mockClear();
  mocks.mountTerminal.mockClear();
  mocks.unmountTerminal.mockClear();
  mocks.writeToTerminal.mockClear();
  const profiles = useApp.getState().terminalProfiles;
  useApp.setState({
    terminals: [],
    activeTerminalId: null,
    terminalLayout: null,
    focusedPaneId: null,
    terminalProfiles: profiles,
    workspaceRoot: "/workspace",
  });
});

describe("live terminal dock integration", () => {
  test("seeds a pane and renders bounded right/down splits", async () => {
    render(<TerminalPane />);
    await waitFor(() => expect(document.querySelectorAll("[data-pane]")).toHaveLength(1));

    fireEvent.click(screen.getByLabelText("Split terminal right"));
    fireEvent.click(screen.getByLabelText("Split terminal down"));
    await waitFor(() => expect(document.querySelectorAll("[data-pane]")).toHaveLength(3));

    fireEvent.click(screen.getByLabelText("Split terminal right"));
    expect(paneCount(useApp.getState().terminalLayout)).toBe(4);
    expect(screen.getByLabelText("Split terminal right")).toBeDisabled();
    expect(screen.getByLabelText("Split terminal down")).toBeDisabled();
  });

  test("routes shared agent command output into the focused pane and shows completion", async () => {
    mocks.events = [commandEvent()];
    render(<TerminalPane />);

    await waitFor(() => expect(screen.getByText("exit 0")).toBeTruthy());
    const sessionId = leaves(useApp.getState().terminalLayout)[0].sessionId;
    expect(mocks.writeToTerminal).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining("pnpm test"),
    );
    expect(mocks.writeToTerminal).toHaveBeenCalledWith(sessionId, "5 passed, 0 failed\n");
    expect(mocks.writeToTerminal).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining("────────────────────────────────"),
    );
  });

  test("renders transcript insights and disposes a closed pane", async () => {
    render(<TerminalPane />);
    await waitFor(() => expect(screen.getByLabelText("Toggle output insights")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Toggle output insights"));

    expect(document.querySelector('[data-annotation="path"]')).toBeTruthy();
    expect(document.querySelector('[data-annotation="test-summary"]')?.textContent).toContain(
      "5 passed",
    );

    const pane = leaves(useApp.getState().terminalLayout)[0];
    fireEvent.click(screen.getAllByLabelText(/^Close /)[0]);
    await waitFor(() => expect(mocks.disposeTerminal).toHaveBeenCalledWith(pane.sessionId));
    expect(useApp.getState().terminalLayout).toBeNull();
    expect(useApp.getState().terminals).toHaveLength(0);
  });
});
