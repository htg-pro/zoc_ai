// Feature: zoc-ai-agent-chat-overhaul, Task 20.2: foreign-session confirmation
//
// A session bound to a different workspace must not silently retarget the agent
// (R15.7): activating it requires explicit confirmation, and declining leaves
// the current session active. A session in the resolved workspace is activated
// with no prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@zoc-studio/shared-types";
import { useApp } from "@/lib/store";

function mkSession(id: string, root: string): Session {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: id,
    status: "active",
    workspace_root: root,
    provider: null,
    model: null,
    created_at: at,
    updated_at: at,
    messages: [],
    plan: null,
    tool_calls: [],
  } as unknown as Session;
}

beforeEach(() => {
  useApp.setState({
    liveMode: false,
    workspaceRoot: "/ws-a",
    sessions: [mkSession("s-current", "/ws-a"), mkSession("s-foreign", "/ws-b")],
    activeSessionId: "s-current",
    chat: [],
    agentItems: [],
    plan: null,
    // selectSession fires these unawaited; stub so it never reaches a client.
    loadMemoryStats: async () => {},
    loadProjectRules: async () => {},
    loadCheckpoints: async () => {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("foreign-session confirmation (Task 20.2)", () => {
  it("prompts and aborts when the user declines a foreign session", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await useApp.getState().selectSession("s-foreign");
    expect(confirm).toHaveBeenCalledTimes(1);
    // The switch was refused: the current session stays active.
    expect(useApp.getState().activeSessionId).toBe("s-current");
  });

  it("activates a foreign session when the user confirms", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await useApp.getState().selectSession("s-foreign");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useApp.getState().activeSessionId).toBe("s-foreign");
  });

  it("does not prompt for a session in the resolved workspace", async () => {
    useApp.setState({ activeSessionId: "s-foreign" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await useApp.getState().selectSession("s-current");
    expect(confirm).not.toHaveBeenCalled();
    expect(useApp.getState().activeSessionId).toBe("s-current");
  });
});
