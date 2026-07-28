/**
 * agent-run.example.test.tsx — example-based unit tests for the rewired Agent
 * run path (task 4.3).
 *
 * These are the example (not property) tests called out in design.md
 * "Example-Based Unit Tests". They cover the integration-seam behaviors that
 * the property suite does not assert as universals:
 *
 *  - Run_Feed subscribes EXACTLY ONCE on mount (R3.1) — the injected
 *    `createStream` is invoked a single time when a consumer of
 *    `useAgentStream` mounts.
 *  - `done` marks the run complete while the stream KEEPS MONITORING for late
 *    events (R3.6) — after a `done` row arrives, a later event still appends and
 *    the underlying stream is never torn down.
 *    (Ask vs Agent row dispatch moved to the folded-trace reducer when the
 *    parallel event feed was removed; see agent-trace.test.ts.)
 *  - Submit targets the Gateway, not a legacy transport (R2.1 / R6.5) — the
 *    rewired store `sendUserMessage` calls the mocked gateway-client
 *    `postAgentRun` and touches no legacy agent run/message transport.
 *  - ApprovalRow renders approve + reject for an approval event (R5.1) and a
 *    budget-continuation approval resolves through the `/decision` client
 *    (R5.4).
 *
 * Requirements: 3.1, 3.6, 4.3, 4.4, 2.1, 6.5, 5.1, 5.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import type { AgentEvents } from "@zoc-studio/shared-types";

const tauriBridgeMock = vi.hoisted(() => ({
  isTauri: vi.fn(),
  gitCheckpointCommit: vi.fn(),
  gitStatus: vi.fn(),
}));

// The single agent transport is mocked so the store's submit path and the
// ApprovalRow's default decision client resolve to test doubles (R2.1, R5.4).
vi.mock("@/features/agent/gateway-client", () => ({
  postAgentRun: vi.fn(),
  postAgentDecision: vi.fn(),
  postAgentCancel: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri-bridge")>("@/lib/tauri-bridge");
  return {
    ...actual,
    isTauri: tauriBridgeMock.isTauri,
    gitCheckpointCommit: tauriBridgeMock.gitCheckpointCommit,
    gitStatus: tauriBridgeMock.gitStatus,
  };
});

import { ApprovalRow } from "./decision-rows";
import useAgentStream from "./useAgentStream";
import type { UseAgentStreamOptions } from "./useAgentStream";
import type { AgentEventStream } from "./useAgentStream";
import { postAgentRun, postAgentDecision, postAgentCancel } from "./gateway-client";
import { useApp } from "@/lib/store";
import * as agentClient from "@/lib/agent-client";

type AgentEvent = AgentEvents.AgentEvent;

const TS = "2024-01-01T00:00:00.000Z";

/** A minimal, drivable SSE stream double satisfying {@link AgentEventStream}. */
interface FakeStream extends AgentEventStream {
  close: ReturnType<typeof vi.fn>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
}

function makeFakeStream(): FakeStream {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  return {
    onopen: null,
    onmessage: null,
    onerror: null,
    listeners,
    addEventListener: vi.fn((type: string, listener: (ev: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  };
}

/** Push a frame through the stream's `onmessage`, wrapped in `act`. */
async function emit(stream: FakeStream, event: unknown): Promise<void> {
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify(event) });
  });
}

/** Push a frame through a named browser EventSource listener. */
async function emitNamed(stream: FakeStream, type: string, event: unknown): Promise<void> {
  await act(async () => {
    for (const listener of stream.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(event) });
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tauriBridgeMock.isTauri.mockReturnValue(false);
  tauriBridgeMock.gitCheckpointCommit.mockResolvedValue("checkpointabcdef");
  tauriBridgeMock.gitStatus.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  useApp.setState({
    trackedRuns: [],
    focusedRunId: null,
    runId: null,
    streaming: false,
    isRunning: false,
    activeRunMode: null,
    messageQueue: [],
    maxConcurrentRuns: 3,
  });
});


/**
 * A minimal renderer over `useAgentStream`.
 *
 * These subscription assertions used to mount `AgentRunFeed`, the parallel run
 * feed that has since been removed in favour of the single folded-trace card.
 * The behaviour under test belongs to the hook, not to that component, so the
 * harness renders just enough DOM to assert on which events arrived.
 */
function StreamHarness({ options }: { options: UseAgentStreamOptions }): JSX.Element {
  const { events } = useAgentStream(options);
  return (
    <div>
      {events.map((event) => (
        <div key={`${event.seq}:${event.type}`} data-event-type={event.type}>
          {typeof (event as { text?: unknown }).text === "string"
            ? String((event as { text?: unknown }).text)
            : null}
        </div>
      ))}
    </div>
  );
}

describe("stream subscription (R3.1)", () => {
  it("subscribes to the Gateway SSE stream exactly once on mount", async () => {
    const streams: FakeStream[] = [];
    const createStream = vi.fn((_url: string) => {
      const next = makeFakeStream();
      streams.push(next);
      return next;
    });
    const resolveBaseUrl = vi.fn(async () => "");
    const recoverFromDiary = vi.fn(async () => [] as AgentEvent[]);

    render(
      <StreamHarness options={{ createStream, resolveBaseUrl, recoverFromDiary }} />,
    );

    // The hook resolves the base URL, then subscribes — exactly one connection.
    await waitFor(() => {
      expect(createStream).toHaveBeenCalledTimes(1);
    });
    expect(streams).toHaveLength(1);
    // The events endpoint is the subscription target (R3.1).
    expect(createStream).toHaveBeenCalledWith(expect.stringContaining("/v1/agent/events"));
  });
});

describe("done completion keeps the stream monitoring (R3.6)", () => {
  it("renders Gateway named SSE events delivered with addEventListener", async () => {
    const streams: FakeStream[] = [];
    const createStream = vi.fn((_url: string) => {
      const next = makeFakeStream();
      streams.push(next);
      return next;
    });

    const { container } = render(
      <StreamHarness
        options={{
          createStream,
          resolveBaseUrl: async () => "",
          recoverFromDiary: async () => [],
        }}
      />,
    );

    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams[0];
    expect(stream.addEventListener).toHaveBeenCalledWith("done", expect.any(Function));

    const doneEvent: AgentEvents.DoneEvent = {
      type: "done",
      seq: 9,
      runId: "run-named",
      ts: TS,
      ok: true,
      filesChanged: 0,
    };
    await emitNamed(stream, "done", doneEvent);

    expect(container.querySelector('[data-event-type="done"]')).not.toBeNull();
  });

  it("renders the done row yet still appends a later event without resubscribing", async () => {
    const streams: FakeStream[] = [];
    const createStream = vi.fn((_url: string) => {
      const next = makeFakeStream();
      streams.push(next);
      return next;
    });

    const { container } = render(
      <StreamHarness
        options={{
          createStream,
          resolveBaseUrl: async () => "",
          recoverFromDiary: async () => [],
        }}
      />,
    );

    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams[0];

    await act(async () => {
      stream.onopen?.({});
    });

    // The terminal `done` row arrives and the run is shown as completed.
    const doneEvent: AgentEvents.DoneEvent = {
      type: "done",
      seq: 5,
      runId: "run-1",
      ts: TS,
      ok: true,
      filesChanged: 0,
    };
    await emit(stream, doneEvent);

    await waitFor(() => {
      expect(container.querySelector('[data-event-type="done"]')).not.toBeNull();
    });

    // A LATE event for the same run still arrives and is appended — the feed
    // keeps monitoring after `done` (R3.6).
    const lateSummary: AgentEvents.SummaryEvent = {
      type: "summary",
      seq: 6,
      runId: "run-1",
      ts: TS,
      text: "late trailing summary",
    };
    await emit(stream, lateSummary);

    await waitFor(() => {
      expect(container.querySelector('[data-event-type="summary"]')).not.toBeNull();
    });
    expect(screen.getByText("late trailing summary")).toBeInTheDocument();

    // The stream was never torn down and no re-subscribe happened — still one
    // connection, still open.
    expect(stream.close).not.toHaveBeenCalled();
    expect(createStream).toHaveBeenCalledTimes(1);
  });
});

describe("submit targets the Gateway, not a legacy transport (R2.1, R6.5)", () => {
  it("routes a Composer submit through the gateway-client postAgentRun and no legacy run transport", async () => {
    vi.mocked(postAgentRun).mockImplementation(async (req) => ({
      runId: req.runId ?? "run-xyz",
    }));
    tauriBridgeMock.isTauri.mockReturnValue(true);
    tauriBridgeMock.gitCheckpointCommit.mockResolvedValue("checkpointabcdef");

    // A legacy client double whose run/message transport must stay untouched.
    const postMessage = vi.fn();
    const runSlashCommand = vi.fn();
    const memoryStats = vi.fn().mockResolvedValue({
      context_window: 8192,
      tokens_used: 0,
      messages: 0,
      summaries: 0,
      facts: 0,
    });
    const fakeLegacy = { postMessage, runSlashCommand, memoryStats } as unknown as Awaited<
      ReturnType<typeof agentClient.getAgentClient>
    >;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fakeLegacy);

    useApp.setState({
      liveMode: true,
      agentMode: "agent",
      messageQueue: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      // Agent mode requires an open folder (validateRunRequest), so this test
      // models a user with a workspace open.
      workspaceRoot: "/ws",
      activeSessionId: "",
    });

    await useApp.getState().sendUserMessage("investigate the failing test");

    // The run was routed to the Gateway control channel exactly once (R2.1).
    expect(postAgentRun).toHaveBeenCalledTimes(1);
    const request = vi.mocked(postAgentRun).mock.calls[0][0];
    expect(request).toMatchObject({
      input: "investigate the failing test",
      mode: "agent",
      model: "mock-model",
      provider: "mock",
      apiKey: null,
      baseUrl: null,
      workspaceRoot: "/ws",
      reviewChanges: true,
    });
    expect(request.runId).toMatch(/^run-/);
    // R17.4 — the mock provider carries no effort parameter, so the field is
    // omitted entirely from the request (never defaulted).
    expect(request.reasoningEffort).toBeUndefined();
    expect(tauriBridgeMock.gitCheckpointCommit).toHaveBeenCalledWith(
      `zoc: checkpoint before run ${request.runId}`,
    );
    // The Gateway-issued runId is recorded on the store.
    expect(useApp.getState().runId).toBe(request.runId);
    expect(useApp.getState().agentRunCheckpoints[request.runId ?? ""]).toBe("checkpointabcdef");

    // No legacy agent run/message transport was touched (R6.5).
    expect(postMessage).not.toHaveBeenCalled();
    expect(runSlashCommand).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("blocks an Agent run when the checkpoint commit fails", async () => {
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "should-not-start" });
    tauriBridgeMock.isTauri.mockReturnValue(true);
    tauriBridgeMock.gitCheckpointCommit.mockRejectedValue(new Error("git identity missing"));
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
      liveMode: true,
      agentMode: "agent",
      messageQueue: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      // Agent mode requires an open folder, so the checkpoint failure — not the
      // workspace gate — is what must block this run.
      workspaceRoot: "/ws",
      activeSessionId: "",
      chat: [],
      agentItems: [],
      streaming: false,
      isRunning: false,
      runId: null,
    });

    await useApp.getState().sendUserMessage("fix the failing test");

    expect(tauriBridgeMock.gitCheckpointCommit).toHaveBeenCalled();
    expect(postAgentRun).not.toHaveBeenCalled();
    expect(useApp.getState().streaming).toBe(false);
    expect(useApp.getState().runId).toBeNull();
    expect(useApp.getState().chat.some((entry) => entry.message?.role === "system")).toBe(false);
    expect(useApp.getState().agentSurfaceError).toMatchObject({
      operation: "run",
      message: expect.stringContaining("git identity missing"),
    });

    vi.restoreAllMocks();
  });

  it("refuses an Agent submit with no workspace open, instead of running against a scratch dir", async () => {
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "should-not-start" });
    tauriBridgeMock.isTauri.mockReturnValue(true);
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
      liveMode: true,
      agentMode: "agent",
      messageQueue: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: null,
      sessions: [],
      activeSessionId: "",
      chat: [],
      agentItems: [],
      streaming: false,
      isRunning: false,
      runId: null,
    });

    await useApp.getState().sendUserMessage("add a login page");

    // No run was submitted, and no run state was left half-started.
    expect(postAgentRun).not.toHaveBeenCalled();
    expect(useApp.getState().streaming).toBe(false);
    expect(useApp.getState().isRunning).toBe(false);
    expect(useApp.getState().runId).toBeNull();
    // The user is told why, in plain language.
    expect(
      useApp
        .getState()
        .chat.some((entry) => entry.message?.content.includes("Open a project folder")),
    ).toBe(true);

    vi.restoreAllMocks();
  });

  it("says the agent is unreachable instead of fabricating an assistant reply", async () => {
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "should-not-start" });
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
      liveMode: false,
      agentMode: "ask",
      messageQueue: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: "/ws",
      activeSessionId: "",
      chat: [],
      agentItems: [],
      streaming: false,
      isRunning: false,
      runId: null,
    });

    await useApp.getState().sendUserMessage("what does this do?");

    const chat = useApp.getState().chat;
    // No canned assistant answer — that is indistinguishable from a real one.
    expect(chat.some((entry) => entry.message?.role === "assistant")).toBe(false);
    expect(
      chat.some(
        (entry) =>
          entry.message?.role === "system" &&
          entry.message.content.includes("Can't reach the agent service"),
      ),
    ).toBe(true);
    // Run state is released, not left spinning.
    expect(useApp.getState().streaming).toBe(false);
    expect(useApp.getState().isRunning).toBe(false);
    expect(postAgentRun).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("forwards the Ask toggle as mode=ask to the Gateway (R4.1 mapping on the submit path)", async () => {
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "run-ask" });
    const memoryStats = vi.fn().mockResolvedValue({
      context_window: 8192,
      tokens_used: 0,
      messages: 0,
      summaries: 0,
      facts: 0,
    });
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue({
      memoryStats,
    } as unknown as Awaited<ReturnType<typeof agentClient.getAgentClient>>);

    useApp.setState({
      liveMode: true,
      agentMode: "ask",
      messageQueue: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: null,
      activeSessionId: "",
    });

    await useApp.getState().sendUserMessage("what does this function do?");

    expect(postAgentRun).toHaveBeenCalledWith({
      input: "what does this function do?",
      mode: "ask",
      model: "mock-model",
      provider: "mock",
      apiKey: null,
      baseUrl: null,
      workspaceRoot: null,
      reviewChanges: false,
      // §12.1: Ask Mode carries the editor's active file so the gateway can
      // answer about the code the user is looking at. `activeFile` reflects the
      // file this suite opened earlier; there is no selection in jsdom.
      context: { activeFile: "/src/App.tsx" },
    });

    vi.restoreAllMocks();
  });

  it("passes selected @file mention paths to the Gateway while keeping the short token", async () => {
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "run-mention" });
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
      liveMode: true,
      agentMode: "ask",
      messageQueue: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: "/ws",
      activeSessionId: "",
      attachments: [
        {
          id: "att-mention",
          label: "/ws/src/config.ts",
          kind: "file",
          path: "/ws/src/config.ts",
          token: "config.ts",
        },
      ],
    });

    await useApp.getState().sendUserMessage("explain @config.ts");

    expect(postAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "explain @config.ts",
        mode: "ask",
        contextFiles: [{ token: "config.ts", path: "/ws/src/config.ts" }],
      }),
    );

    vi.restoreAllMocks();
  });

  it("blocks llama.cpp sends before the Gateway when no local .gguf model is selected", async () => {
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "should-not-start" });
    const memoryStats = vi.fn().mockResolvedValue({
      context_window: 8192,
      tokens_used: 0,
      messages: 0,
      summaries: 0,
      facts: 0,
    });
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue({
      memoryStats,
    } as unknown as Awaited<ReturnType<typeof agentClient.getAgentClient>>);

    useApp.setState({
      liveMode: true,
      agentMode: "ask",
      activeRunMode: null,
      messageQueue: [],
      selectedModel: { provider: "llamacpp", model: "" },
      llamaCppStatus: null,
      workspaceRoot: null,
      activeSessionId: "",
      chat: [],
      agentItems: [],
      streaming: false,
      isRunning: false,
      runId: null,
    });

    await useApp.getState().sendUserMessage("hi");

    expect(postAgentRun).not.toHaveBeenCalled();
    expect(useApp.getState().streaming).toBe(false);
    expect(useApp.getState().isRunning).toBe(false);
    expect(useApp.getState().runId).toBeNull();
    expect(useApp.getState().activeRunMode).toBeNull();
    expect(
      useApp
        .getState()
        .chat.some((entry) =>
          entry.message?.content.includes("Select a model to run"),
        ),
    ).toBe(true);

    vi.restoreAllMocks();
  });

  it("reuses the original user bubble when a failed run start is retried", async () => {
    const prompt = "plan the parser migration";
    vi.mocked(postAgentRun)
      .mockRejectedValueOnce({
        code: "context_window_exceeded",
        message: "Reduce attached context, then retry.",
        retryable: true,
      })
      .mockResolvedValueOnce({ runId: "run-retry" });
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
      liveMode: true,
      agentMode: "ask",
      trackedRuns: [],
      focusedRunId: null,
      runId: null,
      messageQueue: [],
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: null,
      activeSessionId: "",
      chat: [],
      agentItems: [],
      agentSurfaceError: null,
      pendingRunMessageId: null,
      boundMessageId: null,
    });

    await useApp.getState().sendUserMessage(prompt);

    const firstUsers = useApp
      .getState()
      .chat.filter((entry) => entry.message?.role === "user");
    expect(firstUsers).toHaveLength(1);
    expect(useApp.getState().chat.some((entry) => entry.message?.role === "system")).toBe(false);
    expect(useApp.getState().agentSurfaceError).toMatchObject({
      operation: "run",
      code: "context_window_exceeded",
    });
    const messageId = firstUsers[0].id;
    expect(useApp.getState().pendingRunMessageId).toBe(messageId);

    useApp.getState().requestComposerSubmit(prompt, { reuseMessageId: messageId });
    await useApp.getState().sendUserMessage(prompt);

    const retriedUsers = useApp
      .getState()
      .chat.filter((entry) => entry.message?.role === "user");
    expect(retriedUsers).toHaveLength(1);
    expect(retriedUsers[0].id).toBe(messageId);
    expect(useApp.getState().agentSurfaceError).toBeNull();
    expect(useApp.getState().trackedRuns).toContainEqual(
      expect.objectContaining({
        runId: "run-retry",
        prompt,
        messageId,
      }),
    );
  });
});

describe("ApprovalRow approve/reject and budget-continuation via /decision (R5.1, R5.4)", () => {
  it("renders both approve and reject actions, enabled, for an approval event (R5.1)", () => {
    const approval: AgentEvents.ApprovalEvent = {
      type: "approval",
      seq: 1,
      runId: "run-1",
      ts: TS,
      prompt: "Apply the proposed edit to src/foo.ts?",
    };

    render(<ApprovalRow event={approval} onDecision={vi.fn()} />);

    const approve = screen.getByRole("button", { name: /approve/i }) as HTMLButtonElement;
    const reject = screen.getByRole("button", { name: /reject/i }) as HTMLButtonElement;
    expect(approve).toBeInTheDocument();
    expect(reject).toBeInTheDocument();
    expect(approve.disabled).toBe(false);
    expect(reject.disabled).toBe(false);
  });

  it("resolves a budget-continuation approval through the /decision client (R5.4)", async () => {
    // The Gateway delivers a budget-exceeded pause as an `approval` Event_Row;
    // the same ApprovalRow + the same decision client (`postAgentDecision`,
    // which POSTs to /v1/agent/decision) resolve it. Here the default
    // (un-injected) decision client is the mocked gateway-client.
    vi.mocked(postAgentDecision).mockResolvedValue(undefined);

    const budgetApproval: AgentEvents.ApprovalEvent = {
      type: "approval",
      seq: 7,
      runId: "run-budget",
      ts: TS,
      prompt: "Execution budget exceeded — continue this run?",
    };

    render(<ApprovalRow event={budgetApproval} />);

    const approve = screen.getByRole("button", { name: /approve/i }) as HTMLButtonElement;
    fireEvent.click(approve);

    // Exactly one decision posted to the single /decision client, carrying the
    // row's runId and the chosen verdict; both actions disable afterward.
    await waitFor(() => {
      expect(postAgentDecision).toHaveBeenCalledTimes(1);
    });
    expect(postAgentDecision).toHaveBeenCalledWith({
      runId: "run-budget",
      decision: "approve",
    });
    await waitFor(() => {
      expect(screen.getByText("Approved")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
  });
});


describe("parallel Gateway runs (§12.3)", () => {
  it("starts a second run without cancelling or queueing the first", async () => {
    vi.mocked(postAgentRun).mockImplementation(async (request) => ({
      runId: request.input.includes("second") ? "run-second" : "run-first",
    }));
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
      liveMode: true,
      agentMode: "ask",
      trackedRuns: [],
      focusedRunId: null,
      runId: null,
      messageQueue: [],
      maxConcurrentRuns: 3,
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: null,
      activeSessionId: "",
    });

    await useApp.getState().sendUserMessage("first task");
    await useApp.getState().sendUserMessage("second task");

    expect(postAgentRun).toHaveBeenCalledTimes(2);
    expect(useApp.getState().trackedRuns.map((run) => run.runId)).toEqual([
      "run-first",
      "run-second",
    ]);
    expect(useApp.getState().messageQueue).toEqual([]);
    expect(useApp.getState().streaming).toBe(true);
  });

  it("cancels a live peer behind terminal focus and releases one queued run", async () => {
    vi.mocked(postAgentCancel).mockResolvedValue({
      runId: "run-c",
      cancelled: true,
      state: "cancelled",
      alreadyFinished: false,
    });
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "run-queued" });
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
      liveMode: true,
      agentMode: "ask",
      activeRunMode: "ask",
      runId: "run-finished",
      focusedRunId: "run-finished",
      trackedRuns: [
        { runId: "run-finished", mode: "ask", phase: "done", title: "done", startedAt: 1 },
        { runId: "run-a", mode: "ask", phase: "running", title: "a", startedAt: 2 },
        { runId: "run-b", mode: "ask", phase: "running", title: "b", startedAt: 3 },
        { runId: "run-c", mode: "ask", phase: "running", title: "c", startedAt: 4 },
      ],
      messageQueue: [{ id: "queued-1", content: "queued task" }],
      maxConcurrentRuns: 3,
      selectedModel: { provider: "mock", model: "mock-model" },
      llamaCppStatus: null,
      workspaceRoot: null,
      activeSessionId: "",
    });

    await useApp.getState().cancelRun();

    expect(postAgentCancel).toHaveBeenCalledWith("run-c");
    expect(useApp.getState().trackedRuns.find((run) => run.runId === "run-c")?.phase)
      .toBe("cancelled");
    expect(useApp.getState().trackedRuns.find((run) => run.runId === "run-a")?.phase)
      .toBe("running");
    await waitFor(() => expect(postAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ input: "queued task" }),
    ));
    await waitFor(() => expect(
      useApp.getState().trackedRuns.some((run) => run.runId === "run-queued"),
    ).toBe(true));
    expect(useApp.getState().messageQueue).toEqual([]);
  });
});
