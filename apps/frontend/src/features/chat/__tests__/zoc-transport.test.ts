/**
 * `ZocChatTransport` — zoc-agent-chat-rebuild task 11.1 (R5.2, R7.7, R7.8, R16.1,
 * R16.3, R16.4, R16.5).
 *
 * A stub `fetch` and a stub clock throughout: what the transport owns is protocol
 * behaviour — which frames reach `useChat`, when a re-attach happens, what the request
 * body contains — and none of that is a claim about a real socket. The two integration
 * claims that *are* about a socket (the runtime's own framing, and admission) belong to
 * the runtime's suite and are already covered there.
 *
 * The assertions with teeth are the negative ones: no duplicate reaches the hook, no
 * out-of-order part reaches it, no credential reaches the wire, and a stream that cannot
 * be recovered ends with exactly one interrupted row rather than simply stopping.
 */

import { describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import type { RunLifecyclePart } from "@zoc-studio/shared-types";

import {
  MAX_REATTACH_ATTEMPTS,
  REATTACH_BASE_DELAYS_MS,
  RuntimeRequestError,
  ZocChatTransport,
  type ActiveRun,
  type SubmissionContext,
  type ZocTransportOptions,
} from "@/features/chat/wire/zoc-transport";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

const BASE = "http://127.0.0.1:41000";
const TOKEN = "launch-token-0123456789abcdef";

/** One SSE frame as the runtime writes it. */
function frame(seq: number, chunk: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify(chunk)}\n\n`;
}

function textChunk(seq: number, text: string): unknown {
  return { type: "text-delta", id: `t${seq}`, delta: text };
}

function lifecycle(seq: number, state: RunLifecyclePart["state"]): unknown {
  return {
    type: "data-zoc-run",
    id: "run_1",
    data: {
      type: "run-lifecycle",
      seq,
      runId: "run_1",
      messageId: "msg_1",
      ts: "2026-07-30T00:00:00.000Z",
      agentName: null,
      state,
    },
  };
}

/** An SSE response body from a list of pre-rendered frames. */
function sse(frames: readonly string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const text of frames) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function submission(overrides: Partial<SubmissionContext> = {}): SubmissionContext {
  return {
    mode: "agent",
    permissionMode: "ask",
    modelRef: { provider: "openai", modelId: "gpt-4o" },
    mentions: [],
    ...overrides,
  };
}

function userMessage(text: string): ZocUIMessage {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] } as ZocUIMessage;
}

interface Harness {
  transport: ZocChatTransport;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  sleeps: number[];
  progress: Array<ActiveRun & { sessionId: string }>;
}

/**
 * A transport over a scripted `fetch`.
 *
 * `streamResponses` is consumed one per stream attempt, so a test scripts a drop simply by
 * listing a short body followed by a longer one — which is what a re-attach observes.
 */
function harness(options: {
  streamResponses: Array<() => Response>;
  runResponse?: () => Response;
  activeRun?: ActiveRun | null;
  submissionContext?: SubmissionContext;
}): Harness {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sleeps: number[] = [];
  const progress: Array<ActiveRun & { sessionId: string }> = [];
  let streamIndex = 0;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/runs")) {
      return (
        options.runResponse?.() ??
        new Response(JSON.stringify({ runId: "run_1", streamUrl: "/v1/runs/run_1/stream" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    if (url.includes("/cancel")) return new Response(JSON.stringify({ accepted: true }));
    const next = options.streamResponses[streamIndex];
    streamIndex += 1;
    return next?.() ?? sse([]);
  });

  const transportOptions: ZocTransportOptions = {
    endpoint: async () => ({ baseUrl: BASE, token: TOKEN }),
    submission: () => options.submissionContext ?? submission(),
    activeRun: () => options.activeRun ?? null,
    onRunProgress: (run) => progress.push(run),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // No real waiting: the jitter's *bound* is what the contract states, and the schedule
    // is asserted from what was requested rather than from elapsed time.
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    // Maximum jitter, so each recorded sleep equals its base and the schedule is readable.
    random: () => 0.999_999,
  };

  return { transport: new ZocChatTransport(transportOptions), calls, sleeps, progress };
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

const seqsOf = (chunks: readonly UIMessageChunk[]): Array<number | undefined> =>
  chunks.map((chunk) => (chunk as { data?: { seq?: number } }).data?.seq);

async function send(harnessed: Harness): Promise<UIMessageChunk[]> {
  const stream = await harnessed.transport.sendMessages({
    trigger: "submit-message",
    chatId: "s1",
    messageId: undefined,
    messages: [userMessage("explain this file")],
    abortSignal: undefined,
  });
  return collect(stream);
}

describe("the run request (R7.8)", () => {
  it("sends only the six declared fields", async () => {
    const harnessed = harness({
      streamResponses: [() => sse([frame(1, lifecycle(1, "completed"))])],
      submissionContext: submission({
        mode: "plan",
        permissionMode: "auto",
        mentions: [{ kind: "file", ref: "src/a.ts", label: "a.ts" }],
      }),
    });
    await send(harnessed);

    const submit = harnessed.calls.find((call) => call.url.endsWith("/v1/runs"));
    const body = JSON.parse(String(submit?.init?.body)) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "mentions",
      "mode",
      "modelRef",
      "permissionMode",
      "prompt",
      "sessionId",
    ]);
    expect(body.sessionId).toBe("s1");
    expect(body.prompt).toBe("explain this file");
    expect(body.mode).toBe("plan");
    expect(body.permissionMode).toBe("auto");
    expect(body.mentions).toEqual([{ kind: "file", ref: "src/a.ts", label: "a.ts" }]);
  });

  it("never carries a credential, and never carries the transcript", async () => {
    const harnessed = harness({
      streamResponses: [() => sse([frame(1, lifecycle(1, "completed"))])],
    });
    await send(harnessed);

    const submit = harnessed.calls.find((call) => call.url.endsWith("/v1/runs"));
    const raw = String(submit?.init?.body);
    for (const forbidden of ["apiKey", "api_key", "token", "authorization", "messages"]) {
      expect(raw).not.toContain(forbidden);
    }
    // The token travels as a header, which is where a per-launch credential belongs.
    const headers = submit?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends the newest user message even when assistant turns follow in the list", async () => {
    const harnessed = harness({
      streamResponses: [() => sse([frame(1, lifecycle(1, "completed"))])],
    });
    const stream = await harnessed.transport.sendMessages({
      trigger: "submit-message",
      chatId: "s1",
      messageId: undefined,
      messages: [
        userMessage("first question"),
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "an answer" }],
        } as ZocUIMessage,
        userMessage("second question"),
      ],
      abortSignal: undefined,
    });
    await collect(stream);

    const submit = harnessed.calls.find((call) => call.url.endsWith("/v1/runs"));
    expect(JSON.parse(String(submit?.init?.body)).prompt).toBe("second question");
  });

  it("throws the runtime's envelope rather than a bare failure", async () => {
    const harnessed = harness({
      streamResponses: [],
      runResponse: () =>
        new Response(
          JSON.stringify({
            code: "no_key_configured",
            message: "OpenAI needs an API key before it can be used. Add one in Settings.",
            details: null,
            retryable: false,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(send(harnessed)).rejects.toThrow(RuntimeRequestError);
    await expect(send(harnessed)).rejects.toMatchObject({
      status: 400,
      envelope: { code: "no_key_configured", retryable: false },
    });
  });

  it("does not pass the hook's abort signal to the submission", async () => {
    // Aborting the submit would leave a Run the runtime already admitted with no reader.
    // Cancellation is `cancel()`, out of band (R16.1).
    const harnessed = harness({
      streamResponses: [() => sse([frame(1, lifecycle(1, "completed"))])],
    });
    const controller = new AbortController();
    const stream = await harnessed.transport.sendMessages({
      trigger: "submit-message",
      chatId: "s1",
      messageId: undefined,
      messages: [userMessage("hi")],
      abortSignal: controller.signal,
    });
    await collect(stream);

    const submit = harnessed.calls.find((call) => call.url.endsWith("/v1/runs"));
    expect(submit?.init?.signal).toBeUndefined();
  });
});

describe("the sequence contract (R7.7, R16.4)", () => {
  it("forwards a gapless stream in order and ends on the terminal part", async () => {
    const harnessed = harness({
      streamResponses: [
        () =>
          sse([
            frame(1, lifecycle(1, "running")),
            frame(2, textChunk(2, "hello")),
            frame(3, lifecycle(3, "completed")),
          ]),
      ],
    });

    const chunks = await send(harnessed);
    expect(chunks).toHaveLength(3);
    expect(seqsOf(chunks)).toEqual([1, undefined, 3]);
  });

  it("drops a duplicate rather than rendering the part twice", async () => {
    const harnessed = harness({
      streamResponses: [
        () =>
          sse([
            frame(1, lifecycle(1, "running")),
            frame(1, lifecycle(1, "running")),
            frame(2, textChunk(2, "hello")),
            frame(2, textChunk(2, "hello")),
            frame(3, lifecycle(3, "completed")),
          ]),
      ],
    });

    const chunks = await send(harnessed);
    expect(chunks).toHaveLength(3);
  });

  it("skips a keepalive comment without counting it as a part", async () => {
    const harnessed = harness({
      streamResponses: [
        () =>
          sse([
            frame(1, lifecycle(1, "running")),
            ": keepalive\n\n",
            frame(2, lifecycle(2, "completed")),
          ]),
      ],
    });
    expect(await send(harnessed)).toHaveLength(2);
  });

  it("re-attaches on a gap rather than rendering out of order", async () => {
    // The first connection jumps from 1 to 3. Rendering `seq 3` would paint something the
    // renderer cannot un-paint when `seq 2` arrives, so the connection is torn down.
    const harnessed = harness({
      streamResponses: [
        () => sse([frame(1, lifecycle(1, "running")), frame(3, textChunk(3, "late"))]),
        () =>
          sse([
            frame(2, textChunk(2, "middle")),
            frame(3, textChunk(3, "late")),
            frame(4, lifecycle(4, "completed")),
          ]),
      ],
    });

    const chunks = await send(harnessed);
    // Exactly one of each, in order: 1 from the first attempt, 2–4 from the second.
    expect(chunks).toHaveLength(4);
    expect((chunks[1] as { delta?: string }).delta).toBe("middle");
    expect((chunks[2] as { delta?: string }).delta).toBe("late");

    // And the re-attach asked to resume from what was rendered, not from zero.
    const streams = harnessed.calls.filter((call) => call.url.includes("/stream"));
    expect(streams[0]?.url).toContain("fromSeq=0");
    expect(streams[1]?.url).toContain("fromSeq=1");
  });

  it("resumes from the highest rendered seq after a dropped socket", async () => {
    const harnessed = harness({
      streamResponses: [
        () => sse([frame(1, lifecycle(1, "running")), frame(2, textChunk(2, "partial"))]),
        () => sse([frame(3, lifecycle(3, "completed"))]),
      ],
    });

    const chunks = await send(harnessed);
    expect(chunks).toHaveLength(3);
    const streams = harnessed.calls.filter((call) => call.url.includes("/stream"));
    expect(streams[1]?.url).toContain("fromSeq=2");
  });

  it("reports progress so the surface can persist the resume point", async () => {
    const harnessed = harness({
      streamResponses: [
        () => sse([frame(1, lifecycle(1, "running")), frame(2, lifecycle(2, "completed"))]),
      ],
    });
    await send(harnessed);

    expect(harnessed.progress.map((run) => run.lastRenderedSeq)).toEqual([0, 1, 2]);
    expect(harnessed.progress.every((run) => run.sessionId === "s1")).toBe(true);
    expect(harnessed.progress.every((run) => run.runId === "run_1")).toBe(true);
  });
});

describe("bounded re-attach (R16.3, R16.5)", () => {
  it("retries at most five times, with full jitter over the documented bases", async () => {
    const harnessed = harness({
      // Every attempt drops with no terminal part.
      streamResponses: Array.from({ length: 10 }, () => () => sse([])),
    });

    await send(harnessed);

    // Six connections: the first plus five re-attaches.
    const streams = harnessed.calls.filter((call) => call.url.includes("/stream"));
    expect(streams).toHaveLength(MAX_REATTACH_ATTEMPTS + 1);
    // `random()` is pinned near 1, so each requested delay is its base.
    expect(harnessed.sleeps).toEqual(REATTACH_BASE_DELAYS_MS.map((base) => base - 1));
  });

  it("emits exactly one interrupted row when the budget is exhausted", async () => {
    const harnessed = harness({
      streamResponses: Array.from({ length: 10 }, () => () => sse([])),
    });

    const chunks = await send(harnessed);
    expect(chunks).toHaveLength(1);
    const part = (chunks[0] as { data?: RunLifecyclePart }).data;
    expect(part?.state).toBe("interrupted");
    expect(part?.code).toBe("stream_lost");
    // A data part, not an `error` chunk: the surface reconciles the lifecycle row by
    // `runId`, so this updates the row the user is watching rather than adding an
    // unexplained error beneath it.
    expect((chunks[0] as { type?: string }).type).toBe("data-zoc-run");
  });

  it("keeps the parts that did arrive before giving up", async () => {
    const harnessed = harness({
      streamResponses: [
        () => sse([frame(1, lifecycle(1, "running")), frame(2, textChunk(2, "half an answer"))]),
        ...Array.from({ length: 9 }, () => () => sse([])),
      ],
    });

    const chunks = await send(harnessed);
    expect(chunks).toHaveLength(3);
    expect((chunks[1] as { delta?: string }).delta).toBe("half an answer");
    expect((chunks[2] as { data?: RunLifecyclePart }).data?.state).toBe("interrupted");
    // The interrupted part's `seq` continues the space rather than restarting it.
    expect((chunks[2] as { data?: RunLifecyclePart }).data?.seq).toBe(3);
  });

  it("does not retry a 409, because the gap can never be closed", async () => {
    const harnessed = harness({
      streamResponses: [
        () =>
          new Response(JSON.stringify({ code: "resume_window_expired", retryable: false }), {
            status: 409,
          }),
        () => sse([frame(1, lifecycle(1, "completed"))]),
      ],
    });

    const chunks = await send(harnessed);
    expect(harnessed.calls.filter((call) => call.url.includes("/stream"))).toHaveLength(1);
    expect(harnessed.sleeps).toEqual([]);
    expect((chunks[0] as { data?: RunLifecyclePart }).data?.code).toBe("stream_lost");
  });

  it("does not retry a 404 either", async () => {
    const harnessed = harness({
      streamResponses: [
        () => new Response(JSON.stringify({ code: "run_not_found" }), { status: 404 }),
        () => sse([frame(1, lifecycle(1, "completed"))]),
      ],
    });

    await send(harnessed);
    expect(harnessed.calls.filter((call) => call.url.includes("/stream"))).toHaveLength(1);
  });

  it("recovers within the budget rather than reporting interruption", async () => {
    const harnessed = harness({
      streamResponses: [
        () => sse([]),
        () => sse([]),
        () => sse([frame(1, lifecycle(1, "completed"))]),
      ],
    });

    const chunks = await send(harnessed);
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { data?: RunLifecyclePart }).data?.state).toBe("completed");
    expect(harnessed.sleeps).toHaveLength(2);
  });
});

describe("reconnectToStream (R16.3)", () => {
  it("answers null when the Session has no active Run", async () => {
    const harnessed = harness({ streamResponses: [], activeRun: null });
    expect(await harnessed.transport.reconnectToStream({ chatId: "s1" })).toBeNull();
    expect(harnessed.calls).toEqual([]);
  });

  it("resumes from the surface's lastRenderedSeq, not from zero", async () => {
    const harnessed = harness({
      streamResponses: [() => sse([frame(8, lifecycle(8, "completed"))])],
      activeRun: { runId: "run_1", streamUrl: "/v1/runs/run_1/stream", lastRenderedSeq: 7 },
    });

    const stream = await harnessed.transport.reconnectToStream({ chatId: "s1" });
    expect(stream).not.toBeNull();
    const chunks = await collect(stream as ReadableStream<UIMessageChunk>);

    expect(chunks).toHaveLength(1);
    expect(harnessed.calls[0]?.url).toContain("fromSeq=7");
    // No `POST /v1/runs`: a reconnect must not open a second Run for one turn.
    expect(harnessed.calls.some((call) => call.url.endsWith("/v1/runs"))).toBe(false);
  });
});

describe("cancel (R16.1)", () => {
  it("posts to the cancel route and never aborts the stream", async () => {
    const harnessed = harness({ streamResponses: [] });
    await harnessed.transport.cancel("run_1");

    expect(harnessed.calls).toHaveLength(1);
    expect(harnessed.calls[0]?.url).toBe(`${BASE}/v1/runs/run_1/cancel`);
    expect(harnessed.calls[0]?.init?.method).toBe("POST");
  });

  it("swallows a failed cancel, because the Run's own row is the report", async () => {
    const options: ZocTransportOptions = {
      endpoint: async () => ({ baseUrl: BASE, token: TOKEN }),
      submission,
      fetchImpl: (async () => {
        throw new Error("socket closed");
      }) as unknown as typeof fetch,
    };
    await expect(new ZocChatTransport(options).cancel("run_1")).resolves.toBeUndefined();
  });
});
