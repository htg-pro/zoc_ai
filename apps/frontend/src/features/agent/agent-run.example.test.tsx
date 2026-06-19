/**
 * agent-run.example.test.tsx — example-based unit tests for the rewired Agent
 * run path (task 4.3).
 *
 * These are the example (not property) tests called out in design.md
 * "Example-Based Unit Tests". They cover the integration-seam behaviors that
 * the property suite does not assert as universals:
 *
 *  - Run_Feed subscribes EXACTLY ONCE on mount (R3.1) — the injected
 *    `createStream` is invoked a single time when `AgentRunFeed` mounts via the
 *    `useAgentStream` stream options.
 *  - `done` marks the run complete while the stream KEEPS MONITORING for late
 *    events (R3.6) — after a `done` row arrives, a later event still appends and
 *    the underlying stream is never torn down.
 *  - Ask vs Agent rendering at the feed level (R4.3 / R4.4) — Agent_Mode
 *    structured Event_Rows render as structured rows; an Ask_Mode raw `token`
 *    text-channel frame is NOT promoted to a structured row (it streams as
 *    markdown text on the separate channel, not as an Event_Row).
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

// The single agent transport is mocked so the store's submit path and the
// ApprovalRow's default decision client resolve to test doubles (R2.1, R5.4).
vi.mock("@/features/agent/gateway-client", () => ({
  postAgentRun: vi.fn(),
  postAgentDecision: vi.fn(),
}));

import AgentRunFeed, { AgentRunFeedView } from "./AgentRunFeed";
import { ApprovalRow, isRecognizedEvent } from "./rows";
import type { AgentEventStream } from "./useAgentStream";
import { postAgentRun, postAgentDecision } from "./gateway-client";
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
});

afterEach(() => {
  cleanup();
});

describe("AgentRunFeed mount/subscribe (R3.1)", () => {
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
      <AgentRunFeed
        streamOptions={{ createStream, resolveBaseUrl, recoverFromDiary }}
      />,
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
      <AgentRunFeed
        streamOptions={{
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
      <AgentRunFeed
        streamOptions={{
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

describe("Ask vs Agent rendering at the feed level (R4.3, R4.4)", () => {
  it("renders Agent_Mode structured Event_Rows, one per kind (R4.4)", () => {
    const events: AgentEvent[] = [
      {
        type: "intent",
        seq: 1,
        runId: "run-1",
        ts: TS,
        text: "Investigate the failing test",
        modelTier: "local-slm",
        contextWindowTokens: 8192,
      },
      { type: "edit-file", seq: 2, runId: "run-1", ts: TS, path: "src/foo.ts", diff: "@@ -1 +1 @@" },
      { type: "command", seq: 3, runId: "run-1", ts: TS, command: "pnpm test", exitCode: 0 },
    ];

    const { container } = render(<AgentRunFeedView events={events} />);

    // Each structured event renders as its own structured row (R4.4).
    expect(container.querySelector('[data-event-type="intent"]')).not.toBeNull();
    expect(container.querySelector('[data-event-type="edit-file"]')).not.toBeNull();
    expect(container.querySelector('[data-event-type="command"]')).not.toBeNull();
    expect(screen.getByText("Investigate the failing test")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
  });

  it("does NOT promote an Ask_Mode token text frame to a structured row (R4.3)", () => {
    // In Ask_Mode the Gateway streams raw `{ type: "token", text }` frames on
    // the markdown text channel — these are NOT one of the eight structured
    // Event_Rows, so the structured-row feed must discard them rather than
    // render a row for them (R4.3 / R3.5). A real structured `summary` row in
    // the same feed still renders, confirming only the Agent structured-row
    // channel produces rows.
    const tokenFrame = {
      type: "token",
      seq: 1,
      runId: "run-1",
      ts: TS,
      text: "**streamed markdown answer**",
    } as unknown as AgentEvent;
    const summary: AgentEvents.SummaryEvent = {
      type: "summary",
      seq: 2,
      runId: "run-1",
      ts: TS,
      text: "structured summary row",
    };

    // The token frame is not a recognized structured Event_Row.
    expect(isRecognizedEvent(tokenFrame)).toBe(false);

    const { container } = render(<AgentRunFeedView events={[tokenFrame, summary]} />);

    // No structured row was produced for the token frame.
    expect(container.querySelector('[data-event-type="token"]')).toBeNull();
    expect(screen.queryByText("**streamed markdown answer**")).toBeNull();
    // The genuine structured row still renders.
    expect(container.querySelector('[data-event-type="summary"]')).not.toBeNull();
    expect(screen.getByText("structured summary row")).toBeInTheDocument();
  });
});

describe("submit targets the Gateway, not a legacy transport (R2.1, R6.5)", () => {
  it("routes a Composer submit through the gateway-client postAgentRun and no legacy run transport", async () => {
    vi.mocked(postAgentRun).mockResolvedValue({ runId: "run-xyz" });

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
      workspaceRoot: null,
      activeSessionId: "",
    });

    await useApp.getState().sendUserMessage("investigate the failing test");

    // The run was routed to the Gateway control channel exactly once (R2.1).
    expect(postAgentRun).toHaveBeenCalledTimes(1);
    expect(postAgentRun).toHaveBeenCalledWith({
      input: "investigate the failing test",
      mode: "agent",
      model: "mock-model",
      provider: "mock",
      apiKey: null,
      baseUrl: null,
      workspaceRoot: null,
    });
    // The Gateway-issued runId is recorded on the store.
    expect(useApp.getState().runId).toBe("run-xyz");

    // No legacy agent run/message transport was touched (R6.5).
    expect(postMessage).not.toHaveBeenCalled();
    expect(runSlashCommand).not.toHaveBeenCalled();

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
    });

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
          entry.message?.content.includes("Select a local .gguf model"),
        ),
    ).toBe(true);

    vi.restoreAllMocks();
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
      expect(approve.disabled).toBe(true);
      expect(
        (screen.getByRole("button", { name: /reject/i }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });
});
