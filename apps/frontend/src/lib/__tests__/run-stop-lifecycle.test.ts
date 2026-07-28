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

vi.mock("@/features/agent/gateway-client", () => ({
  postAgentRun: vi.fn(),
  postAgentDecision: vi.fn(),
  postAgentCancel: vi.fn(),
}));

vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(async () => undefined),
  trackEvent: vi.fn(async () => undefined),
  initTelemetry: vi.fn(async () => undefined),
}));

import { postAgentCancel } from "@/features/agent/gateway-client";
import { isTerminal, canStopRun, isStopPending, runStatusLabel } from "@/features/agent/agent-runs";
import type { TrackedRun } from "@/features/agent/agent-runs";
import { validateRunRequest, routeModeForPrompt } from "@/features/agent/prepare-agent-run";
import { useApp } from "@/lib/store";

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

function systemMessages(): string[] {
  return useApp
    .getState()
    .chat.flatMap((entry) =>
      entry.kind === "message" && entry.message?.role === "system"
        ? [entry.message.content]
        : [],
    );
}

describe("cancelRunById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({
      liveMode: true,
      chat: [],
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
  it("never promotes Ask or Plan to Agent", () => {
    // Whatever the prompt says, a read-only mode stays read-only.
    for (const prompt of ["create a file", "delete everything", "implement login"]) {
      expect(routeModeForPrompt(prompt, "ask")).toBe("ask");
      expect(routeModeForPrompt(prompt, "plan")).toBe("plan");
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
    expect(validateRunRequest({ input: "what is this?", mode: "ask", workspaceRoot: null }).ok).toBe(
      true,
    );
    // R1.4 — Plan reads files and stages diffs against real paths, so it now
    // requires an open folder like Agent.
    const plan = validateRunRequest({ input: "plan the change", mode: "plan", workspaceRoot: null });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe("no_workspace");
    }
  });

  it("rejects an unrecognised mode and an empty message", () => {
    expect(validateRunRequest({ input: "hi", mode: "sudo", workspaceRoot: "/ws" }).ok).toBe(false);
    expect(validateRunRequest({ input: "   ", mode: "agent", workspaceRoot: "/ws" }).ok).toBe(false);
  });
});
