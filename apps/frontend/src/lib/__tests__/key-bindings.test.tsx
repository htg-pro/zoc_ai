// Feature: zoc-ai-agent-chat-overhaul, Task 19.5: global submit/cancel keybindings
//
// The global submit/cancel shortcuts registered in `lib/key-bindings.ts` must
// consult the SAME run gate the Send button uses (R20.3) and the active-run
// record (R20.4): a keyboard submit starts a run only when the gate admits it,
// and a keyboard cancel stops a run only while one is active.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { useApp } from "@/lib/store";
import {
  CANCEL_KEYBINDING,
  SUBMIT_KEYBINDING,
  runGateForKeyboard,
  useGlobalShortcuts,
} from "@/lib/key-bindings";
import type { AppState } from "@/lib/store";

function Harness(): null {
  useGlobalShortcuts();
  return null;
}

function press(key: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("global keyboard submit/cancel (Task 19.5)", () => {
  it("names the expected bindings", () => {
    expect(SUBMIT_KEYBINDING).toBe("mod+enter");
    expect(CANCEL_KEYBINDING).toBe("mod+.");
  });

  it("submit starts a run only when the gate admits it", () => {
    const sendMessage = vi.fn(async () => undefined);
    // Gate blocked: no model selected → keyboard submit must not send.
    useApp.setState({
      input: "do the thing",
      selectedModel: { provider: "llamacpp", model: "" },
      llamaCppStatus: null,
      workspaceRoot: "/ws",
      agentMode: "ask",
      trackedRuns: [],
      maxConcurrentRuns: 3,
      sendMessage,
    });
    expect(runGateForKeyboard(useApp.getState() as AppState).canStart).toBe(false);

    render(<Harness />);
    press("Enter");
    expect(sendMessage).not.toHaveBeenCalled();

    // Gate open: a ready model + an open workspace → the same keystroke sends.
    useApp.setState({ selectedModel: { provider: "mock", model: "mock-model" } });
    expect(runGateForKeyboard(useApp.getState() as AppState).canStart).toBe(true);
    press("Enter");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("cancel stops a run only while one is active", () => {
    const cancelRun = vi.fn(async () => undefined);
    useApp.setState({ trackedRuns: [], cancelRun });

    render(<Harness />);
    press(".");
    expect(cancelRun).not.toHaveBeenCalled();

    useApp.setState({
      trackedRuns: [
        { runId: "run-1", mode: "agent", phase: "running", title: "x", startedAt: 1 },
      ],
    });
    press(".");
    expect(cancelRun).toHaveBeenCalledTimes(1);
  });
});
