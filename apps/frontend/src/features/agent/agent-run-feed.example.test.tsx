/**
 * agent-run-feed.example.test.tsx — example-based tests for the Run_Feed
 * mount/subscribe contract and mode rendering (task 4.3).
 *
 * These are example (not property) tests. They exercise the integration seam of
 * `AgentRunFeed` / `useAgentStream` with INJECTED transport stubs only — no real
 * `EventSource`, `fetch`, or sidecar is touched. Each case drives the injected
 * fake stream handlers directly and asserts synchronously / via testing-library
 * auto-waiting (`findBy*` / `waitFor`).
 *
 * Cases:
 *  - Run_Feed subscribes EXACTLY ONCE on mount (R3.1) — the injected
 *    `createStream` is invoked a single time when `AgentRunFeed` mounts, against
 *    the `/v1/agent/events` endpoint.
 *  - A `done` event renders the DoneRow / marks completion while the feed KEEPS
 *    the subscription (R3.6) — after `done` a later event still appends and the
 *    stream is never torn down or resubscribed.
 *  - A small recognized-event sequence renders structured rows IN ORDER (R4.4).
 *  - An `approval` event renders the ApprovalRow with both approve + reject
 *    actions (R5.1).
 *
 * Requirements: 3.1, 3.6, 4.4, 5.1
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import type { AgentEvents } from "@zoc-studio/shared-types";

// The single decision client is mocked so the default ApprovalRow transport
// never reaches a real network in this example suite.
vi.mock("@/features/agent/gateway-client", () => ({
  postAgentRun: vi.fn(),
  postAgentDecision: vi.fn(),
}));

import AgentRunFeed from "./AgentRunFeed";
import type { AgentEventStream } from "./useAgentStream";

type AgentEvent = AgentEvents.AgentEvent;

const TS = "2024-01-01T00:00:00.000Z";

/** A minimal, drivable SSE stream double satisfying {@link AgentEventStream}. */
interface FakeStream extends AgentEventStream {
  close: ReturnType<typeof vi.fn>;
}

function makeFakeStream(): FakeStream {
  return { onopen: null, onmessage: null, onerror: null, close: vi.fn() };
}

/** Push a JSON frame through the stream's `onmessage`, wrapped in `act`. */
async function emit(stream: FakeStream, event: unknown): Promise<void> {
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify(event) });
  });
}

/** Renders `AgentRunFeed` with injected stubs and returns the captured streams. */
function renderFeed() {
  const streams: FakeStream[] = [];
  const createStream = vi.fn((_url: string) => {
    const next = makeFakeStream();
    streams.push(next);
    return next;
  });
  const resolveBaseUrl = vi.fn(async () => "");
  const recoverFromDiary = vi.fn(async () => [] as AgentEvent[]);

  const utils = render(
    <AgentRunFeed
      streamOptions={{ createStream, resolveBaseUrl, recoverFromDiary }}
    />,
  );
  return { ...utils, streams, createStream, resolveBaseUrl, recoverFromDiary };
}

afterEach(() => {
  cleanup();
});

describe("Run_Feed mount/subscribe (R3.1)", () => {
  it("subscribes to the Gateway SSE stream exactly once on mount", async () => {
    const { streams, createStream } = renderFeed();

    // The hook resolves the base URL, then opens exactly one connection.
    await waitFor(() => {
      expect(createStream).toHaveBeenCalledTimes(1);
    });
    expect(streams).toHaveLength(1);
    // The events endpoint is the subscription target (R3.1).
    expect(createStream).toHaveBeenCalledWith(
      expect.stringContaining("/v1/agent/events"),
    );
  });
});

describe("done completion keeps the subscription (R3.6)", () => {
  it("renders the DoneRow yet still appends a later event without resubscribing", async () => {
    const { container, streams, createStream } = renderFeed();

    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams[0];

    await act(async () => {
      stream.onopen?.({});
    });

    // The terminal `done` event arrives and renders the DoneRow.
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
    expect(screen.getByText("Done")).toBeInTheDocument();

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
      expect(
        container.querySelector('[data-event-type="summary"]'),
      ).not.toBeNull();
    });
    expect(screen.getByText("late trailing summary")).toBeInTheDocument();

    // The stream was never torn down and no re-subscribe happened.
    expect(stream.close).not.toHaveBeenCalled();
    expect(createStream).toHaveBeenCalledTimes(1);
  });
});

describe("recognized-event sequence renders structured rows in order (R4.4)", () => {
  it("appends Agent_Mode structured rows in emission order", async () => {
    const { container, streams } = renderFeed();

    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams[0];
    await act(async () => {
      stream.onopen?.({});
    });

    const intent: AgentEvents.IntentEvent = {
      type: "intent",
      seq: 1,
      runId: "run-1",
      ts: TS,
      text: "Investigate the failing test",
      modelTier: "local-slm",
      contextWindowTokens: 8192,
    };
    const edit: AgentEvents.EditFileEvent = {
      type: "edit-file",
      seq: 2,
      runId: "run-1",
      ts: TS,
      path: "src/foo.ts",
      diff: "@@ -1 +1 @@",
      adds: 0,
      dels: 0,
      status: "done",
    };
    const command: AgentEvents.CommandEvent = {
      type: "command",
      seq: 3,
      runId: "run-1",
      ts: TS,
      command: "pnpm test",
      exitCode: 0,
    };

    await emit(stream, intent);
    await emit(stream, edit);
    await emit(stream, command);

    // Each structured event renders as its own structured row (R4.4).
    await waitFor(() => {
      expect(
        container.querySelectorAll("[data-event-type]"),
      ).toHaveLength(3);
    });
    const renderedTypes = Array.from(
      container.querySelectorAll("[data-event-type]"),
    ).map((el) => el.getAttribute("data-event-type"));
    // Rows appear in emission/seq order without altering prior rows.
    expect(renderedTypes).toEqual(["intent", "edit-file", "command"]);
    expect(screen.getByText("Investigate the failing test")).toBeInTheDocument();
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
  });
});

describe("approval event renders the ApprovalRow with approve + reject (R5.1)", () => {
  it("renders both decision actions, enabled, for an approval event", async () => {
    const { container, streams } = renderFeed();

    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams[0];
    await act(async () => {
      stream.onopen?.({});
    });

    const approval: AgentEvents.ApprovalEvent = {
      type: "approval",
      seq: 1,
      runId: "run-1",
      ts: TS,
      prompt: "Apply the proposed edit to src/foo.ts?",
    };
    await emit(stream, approval);

    await waitFor(() => {
      expect(
        container.querySelector('[data-event-type="approval"]'),
      ).not.toBeNull();
    });

    const approve = screen.getByRole("button", {
      name: /approve/i,
    }) as HTMLButtonElement;
    const reject = screen.getByRole("button", {
      name: /reject/i,
    }) as HTMLButtonElement;
    expect(approve).toBeInTheDocument();
    expect(reject).toBeInTheDocument();
    // Both actions are enabled before any selection (R5.1).
    expect(approve.disabled).toBe(false);
    expect(reject.disabled).toBe(false);
  });
});
