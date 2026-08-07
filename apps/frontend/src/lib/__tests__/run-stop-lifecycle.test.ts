/**
 * Stop-button and run-lifecycle behaviour in the store.
 *
 * The reported symptom was a run stuck on "Running…" after an error or a
 * cancellation. Its direct cause was in `cancelRunById`: a failed cancel request
 * appended an error and **returned early**, so the local run was never settled.
 * These tests pin that a stop always settles the run, whatever the transport
 * does, and that a benign race is not reported to the user as an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gateway-client", () => ({
  postAgentRun: vi.fn(),
  postAgentDecision: vi.fn(),
  postAgentCancel: vi.fn(),
}));

// Agent mode takes a pre-run Git checkpoint, which refuses outside the desktop app — so the submit
// test below would fail on the checkpoint before it ever reached the transport.
const tauriBridgeMock = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  gitCheckpointCommit: vi.fn(async () => "checkpointsha"),
}));
vi.mock("@/lib/tauri-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri-bridge")>("@/lib/tauri-bridge");
  return { ...actual, ...tauriBridgeMock };
});

vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(async () => undefined),
  trackEvent: vi.fn(async () => undefined),
  initTelemetry: vi.fn(async () => undefined),
}));

import { postAgentCancel, postAgentRun } from "@/lib/gateway-client";
import { isTerminal, canStopRun, isStopPending, runStatusLabel } from "@/lib/agent-runs";
import type { TrackedRun } from "@/lib/agent-runs";
import { validateRunRequest } from "@/lib/prepare-agent-run";
import { useApp } from "@/lib/store";
import type { AgentMode } from "@/lib/store";

function trackedRun(overrides: Partial<TrackedRun> = {}): TrackedRun {
  return {
    runId: "run-1",
    mode: "agent",
    phase: "running",
    title: "do the thing",
    startedAt: 1_000,
    ...overrides,
  };
}

/**
 * The system-role lines `appendSystemChat` emits, read off `agentItems`.
 *
 * It used to read the `chat` array, which task 26.6 deleted. Not a weaker
 * oracle: `appendSystemChat` always wrote both halves from the same string, and
 * `agentItems` is the half that survived — so this still fails if the message
 * stops being appended, which is what the three tests below are about.
 */
function systemMessages(): string[] {
  return useApp
    .getState()
    .agentItems.flatMap((item) => (item.type === "error" ? [item.error] : []));
}

describe("cancelRunById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({
      liveMode: true,
      agentItems: [],
      messageQueue: [],
      trackedRuns: [trackedRun()],
      runId: "run-1",
      focusedRunId: "run-1",
      streaming: true,
      isRunning: true,
    });
  });

  it("settles the run when the cancel request succeeds", async () => {
    vi.mocked(postAgentCancel).mockResolvedValue({
      runId: "run-1",
      cancelled: true,
      state: "cancelled",
      alreadyFinished: false,
    });

    await useApp.getState().cancelRunById("run-1");

    const run = useApp.getState().trackedRuns.find((r) => r.runId === "run-1");
    expect(run?.phase).toBe("cancelled");
    expect(isTerminal(run!)).toBe(true);
    expect(useApp.getState().isRunning).toBe(false);
    expect(useApp.getState().streaming).toBe(false);
  });

  it("still settles the run when the cancel request fails", async () => {
    // The regression this file exists for: the run must not stay "Running…".
    vi.mocked(postAgentCancel).mockRejectedValue(new Error("network down"));

    await useApp.getState().cancelRunById("run-1");

    const run = useApp.getState().trackedRuns.find((r) => r.runId === "run-1");
    expect(run?.phase).toBe("cancelled");
    expect(useApp.getState().isRunning).toBe(false);
  });

  it("does not show the user an 'unknown run' error for a normal race", async () => {
    vi.mocked(postAgentCancel).mockRejectedValue(
      Object.assign(new Error("The agent run ended before it could be attached. Please retry."), {
        code: "run_not_found",
      }),
    );

    await useApp.getState().cancelRunById("run-1");

    expect(systemMessages()).toHaveLength(0);
    expect(useApp.getState().trackedRuns[0].phase).toBe("cancelled");
  });

  it("surfaces a genuine failure while still settling the run", async () => {
    vi.mocked(postAgentCancel).mockRejectedValue(new Error("sidecar crashed"));

    await useApp.getState().cancelRunById("run-1");

    expect(systemMessages().join("\n")).toContain("sidecar crashed");
    expect(useApp.getState().trackedRuns[0].phase).toBe("cancelled");
  });

  it("never renders 'Error: undefined' when a non-Error is thrown", async () => {
    vi.mocked(postAgentCancel).mockRejectedValue(undefined);

    await useApp.getState().cancelRunById("run-1");

    const messages = systemMessages().join("\n");
    expect(messages).not.toContain("undefined");
    expect(useApp.getState().trackedRuns[0].phase).toBe("cancelled");
  });

  it("is idempotent: a second stop issues no second request", async () => {
    vi.mocked(postAgentCancel).mockResolvedValue({
      runId: "run-1",
      cancelled: true,
      state: "cancelled",
      alreadyFinished: false,
    });

    await useApp.getState().cancelRunById("run-1");
    await useApp.getState().cancelRunById("run-1");

    expect(postAgentCancel).toHaveBeenCalledTimes(1);
    expect(useApp.getState().trackedRuns[0].phase).toBe("cancelled");
  });

  it("is a no-op for a run that already completed", async () => {
    useApp.setState({ trackedRuns: [trackedRun({ phase: "done", endedAt: 2_000 })] });

    await useApp.getState().cancelRunById("run-1");

    expect(postAgentCancel).not.toHaveBeenCalled();
    // The completed outcome is preserved, not overwritten with "cancelled".
    expect(useApp.getState().trackedRuns[0].phase).toBe("done");
  });

  it("stops a run that is still initializing", async () => {
    useApp.setState({ trackedRuns: [trackedRun({ phase: "initializing" })] });
    vi.mocked(postAgentCancel).mockResolvedValue({
      runId: "run-1",
      cancelled: true,
      state: "cancelled",
      alreadyFinished: false,
    });

    await useApp.getState().cancelRunById("run-1");

    expect(useApp.getState().trackedRuns[0].phase).toBe("cancelled");
  });

  it("leaves the composer usable after a stop", async () => {
    vi.mocked(postAgentCancel).mockRejectedValue(new Error("boom"));

    await useApp.getState().cancelRunById("run-1");

    // Nothing may leave the input permanently blocked.
    expect(useApp.getState().isRunning).toBe(false);
    expect(useApp.getState().streaming).toBe(false);
    expect(useApp.getState().agentPaused).toBe(false);
  });
});

describe("stop affordance", () => {
  it("is offered only for live phases", () => {
    expect(canStopRun({ phase: "initializing" })).toBe(true);
    expect(canStopRun({ phase: "running" })).toBe(true);
    expect(canStopRun({ phase: "stopping" })).toBe(true);
    expect(canStopRun({ phase: "done" })).toBe(false);
    expect(canStopRun({ phase: "cancelled" })).toBe(false);
    expect(canStopRun({ phase: "failed" })).toBe(false);
  });

  it("is disabled during the stopping transition", () => {
    expect(isStopPending({ phase: "running" })).toBe(false);
    expect(isStopPending({ phase: "stopping" })).toBe(true);
  });

  it("labels every phase in plain language", () => {
    expect(runStatusLabel({ phase: "initializing" })).toBe("Starting…");
    expect(runStatusLabel({ phase: "stopping" })).toBe("Stopping…");
    expect(runStatusLabel({ phase: "cancelled" })).toBe("Stopped");
    expect(runStatusLabel({ phase: "failed" })).toBe("Failed");
  });
});

describe("mode isolation at the submit boundary", () => {
  /** Enough state for `sendUserMessage` to reach the transport in any of the three modes. */
  function submitReady(mode: AgentMode) {
    return {
      liveMode: true,
      agentMode: mode,
      agentItems: [],
      messageQueue: [],
      trackedRuns: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: "/ws",
      activeSessionId: "",
    };
  }

  it("sends the mode the user selected, even when the prompt reads like a question", async () => {
    // Task 25.5 removed `routeModeForPrompt` from the store's send path: it used to rewrite an Agent
    // submit to Ask whenever the text looked like a question, which is the silent downgrade
    // Amendment 1 / R7.11 forbids. A question-shaped prompt is the case that used to be rewritten, so
    // it is the case worth pinning.
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "run-verbatim" });
    useApp.setState(submitReady("agent"));

    await useApp.getState().sendUserMessage("what does this do?");

    expect(postAgentRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "agent" }));
  });

  it("never promotes Ask or Plan to Agent", async () => {
    // Asserted through the store rather than through `routeModeForPrompt`: task 25.6 repointed this
    // file off `features/agent`, and that router dies with the folder at 26.1. The guarantee it stood
    // for — a read-only mode stays read-only whatever the prompt says — now has exactly one path that
    // could break it, so that is where it is pinned. An edit-intent prompt is the input the old router
    // would have reacted to.
    for (const mode of ["ask", "plan"] as const) {
      vi.mocked(postAgentRun).mockClear();
      vi.mocked(postAgentRun).mockResolvedValue({ runId: `run-${mode}` });
      useApp.setState(submitReady(mode));

      await useApp.getState().sendUserMessage("create a file and delete everything");

      expect(postAgentRun).toHaveBeenCalledWith(expect.objectContaining({ mode }));
    }
  });

  it("blocks Agent mode without a workspace, with a readable reason", () => {
    const check = validateRunRequest({ input: "add a file", mode: "agent", workspaceRoot: null });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.code).toBe("no_workspace");
      expect(check.message).toContain("Open a project folder");
    }
  });

  it("allows Ask, refuses Plan without a workspace", () => {
    // R1.7 — Ask is the one rootless mode.
    expect(
      validateRunRequest({ input: "what is this?", mode: "ask", workspaceRoot: null }).ok,
    ).toBe(true);
    // R1.4 — Plan reads files and stages diffs against real paths, so it now
    // requires an open folder like Agent.
    const plan = validateRunRequest({
      input: "plan the change",
      mode: "plan",
      workspaceRoot: null,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("no_workspace");
    }
  });

  it("rejects an unrecognised mode and an empty message", () => {
    expect(validateRunRequest({ input: "hi", mode: "sudo", workspaceRoot: "/ws" }).ok).toBe(false);
    expect(validateRunRequest({ input: "   ", mode: "agent", workspaceRoot: "/ws" }).ok).toBe(
      false,
    );
  });
});
