// Feature: zoc-ai-agent-chat-overhaul, Task 21.3: end-to-end integration
//
// Onboarding commits a workspace and registers a model, the model reaches a
// ready state, a run starts and reaches a terminal state, and the run's summary
// is rendered (R2.1, R2.4, R3.1, R5.3, R8.7). This exercises the full wired
// path — the onboarding commit reducers → the store → the run gate → the run
// lifecycle → the normalizer → the strict renderer — rather than any one seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const tauriBridgeMock = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  gitCheckpointCommit: vi.fn(async () => "checkpointhash"),
  gitStatus: vi.fn(async () => null),
  setWorkspaceRoot: vi.fn(async () => true),
}));

const streamMock = vi.hoisted(() => ({
  events: [] as unknown[],
  status: "open" as string,
}));

vi.mock("@/features/agent/gateway-client", () => ({
  postAgentRun: vi.fn(),
  postAgentDecision: vi.fn(),
  postAgentCancel: vi.fn(),
}));

vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(async () => undefined),
  trackEvent: vi.fn(async () => undefined),
  initTelemetry: vi.fn(async () => undefined),
  invalidateConsent: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri-bridge")>("@/lib/tauri-bridge");
  return {
    ...actual,
    isTauri: tauriBridgeMock.isTauri,
    gitCheckpointCommit: tauriBridgeMock.gitCheckpointCommit,
    gitStatus: tauriBridgeMock.gitStatus,
    setWorkspaceRoot: tauriBridgeMock.setWorkspaceRoot,
  };
});

vi.mock("@/features/agent/useAgentStream", () => ({
  default: () => ({ events: streamMock.events, status: streamMock.status }),
}));

import { RunRegion } from "@/features/agent/RunRegion";
import { postAgentRun } from "@/features/agent/gateway-client";
import { commitModelStep, commitWorkspaceStep } from "@/features/onboarding/wizard-steps";
import { loadLocalModels, saveLocalModels, makeModelId } from "@/lib/local-models";
import type { LlamaCppStatus } from "@/lib/tauri-bridge";
import { selectedModelAvailability } from "@/features/agent/model-availability";
import { useApp } from "@/lib/store";
import * as agentClient from "@/lib/agent-client";

const TS = "2026-01-01T00:00:00.000Z";
const MODEL_PATH = "/models/qwen.gguf";
const MODEL_ID = makeModelId(MODEL_PATH);

function readyStatus(): LlamaCppStatus {
  return {
    running: true,
    state: "ready",
    host: "127.0.0.1",
    port: 8080,
    base_url: "http://127.0.0.1:8080",
    loaded_model_id: MODEL_ID,
    loaded_model_path: MODEL_PATH,
    n_gpu_layers: 999,
    n_ctx: null,
    n_threads: null,
    n_batch: null,
    temperature: null,
    top_p: null,
    top_k: null,
    repeat_penalty: null,
    max_tokens: null,
    flash_attn: null,
    last_error: null,
    log_tail: [],
  } as unknown as LlamaCppStatus;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveLocalModels([]);
  streamMock.events = [];
  streamMock.status = "open";
  tauriBridgeMock.isTauri.mockReturnValue(true);
  tauriBridgeMock.gitCheckpointCommit.mockResolvedValue("checkpointhash");
  tauriBridgeMock.gitStatus.mockResolvedValue(null);
  vi.spyOn(agentClient, "getAgentClient").mockResolvedValue({
    memoryStats: vi.fn().mockResolvedValue({
      context_window: 8192,
      tokens_used: 0,
      messages: 0,
      summaries: 0,
      facts: 0,
    }),
  } as unknown as Awaited<ReturnType<typeof agentClient.getAgentClient>>);
  useApp.setState({
    chat: [],
    agentItems: [],
    trackedRuns: [],
    focusedRunId: null,
    runId: null,
    streaming: false,
    isRunning: false,
    activeRunMode: null,
    messageQueue: [],
    maxConcurrentRuns: 3,
    liveMode: true,
    activeSessionId: "",
    workspaceRoot: null,
    llamaCppStatus: null,
    selectedModel: { provider: "llamacpp", model: "" },
    agentSurfaceError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("onboarding → ready model → run → terminal summary (Task 21.3)", () => {
  it("commits a workspace and a model, then a run reaches a terminal summary", async () => {
    // ── 1. Onboarding commits a workspace (R2.1) ──────────────────────────
    for (const effect of commitWorkspaceStep({
      step: "workspace",
      workspace: "/ws",
      modelChoice: null,
      modelPath: "",
      cloudProvider: "openai",
      cloudKey: "",
      telemetry: false,
    })) {
      if (effect.kind === "mirror-workspace") {
        await useApp.getState().setWorkspaceRoot(effect.root);
      }
    }
    expect(useApp.getState().workspaceRoot).toBe("/ws");

    // ── 2. Onboarding registers a model (R3.1) ────────────────────────────
    for (const effect of commitModelStep({
      step: "model",
      workspace: "/ws",
      modelChoice: "local",
      modelPath: MODEL_PATH,
      cloudProvider: "openai",
      cloudKey: "",
      telemetry: false,
    })) {
      if (effect.kind === "register-local-model") {
        saveLocalModels([...loadLocalModels(), effect.model]);
      }
    }
    expect(loadLocalModels().some((m) => m.path === MODEL_PATH)).toBe(true);

    // ── 3. The model reaches a ready state (R2.4) ─────────────────────────
    useApp.setState({
      selectedModel: { provider: "llamacpp", model: MODEL_ID },
      llamaCppStatus: readyStatus(),
      agentMode: "agent",
    });
    const availability = selectedModelAvailability(
      { provider: "llamacpp", model: MODEL_ID },
      useApp.getState().llamaCppStatus,
    );
    expect(availability?.kind).toBe("ready");

    // ── 4. A run starts and is accepted by the Gateway (R5.3) ─────────────
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "run-e2e" });
    await useApp.getState().sendUserMessage("add a health-check endpoint");
    expect(postAgentRun).toHaveBeenCalledTimes(1);
    expect(useApp.getState().runId).toBe("run-e2e");
    expect(useApp.getState().trackedRuns.some((r) => r.runId === "run-e2e")).toBe(true);

    // ── 5. The run reaches a terminal state with a rendered summary (R8.7) ─
    streamMock.events = [
      { type: "done", seq: 1, runId: "run-e2e", ts: TS, ok: true, filesChanged: 2 },
    ];
    const { container } = render(<RunRegion />);

    await waitFor(() => {
      const run = useApp.getState().trackedRuns.find((r) => r.runId === "run-e2e");
      expect(run?.phase).toBe("done");
    });
    // A finished, unfocused run collapses to a step-count header; focusing it
    // reveals its rendered summary (outcome, elapsed, files-changed — R8.7).
    act(() => {
      useApp.getState().focusRun("run-e2e");
    });
    await waitFor(() => {
      const summary = container.querySelector('[data-row-kind="run-summary"]');
      expect(summary).not.toBeNull();
      expect(summary?.textContent).toContain("2 files changed");
    });
    // Follow-up chips derived from the terminal run are offered (R21.1–R21.4).
    expect(container.querySelector('[data-row-kind="follow-ups"]')).not.toBeNull();
  });
});
