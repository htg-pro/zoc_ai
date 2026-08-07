/**
 * The three Run routes over real HTTP — zoc-agent-chat-rebuild R5.1, R16.1, R16.3.
 *
 * Feature: zoc-agent-chat-rebuild, R5.1, R16.1, R16.3.
 *
 * Driven through the real router, the real admission gate, and a real socket, for
 * the reason 9.7's contract is written in HTTP: the facts under test are which
 * status each refusal answers with and what the SSE frames look like on the wire.
 * Calling the handlers directly would assert neither.
 *
 * `plan` and the chunk stream are fixtures. No provider is reached, no history is
 * read, and the `RunManager` is the real one — because admission, the queue, and
 * the resume window are exactly what these routes are a surface over.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdmission } from "../admission.ts";
import { createRequestListener } from "../../main.ts";
import { buildRoutes } from "../routes.ts";
import { registerRunRoutes, type RunPlan, type RunRoutesDeps } from "../run-routes.ts";
import { RunManager } from "../../agent/run-driver.ts";
import { RunStore, SlotManager, RESUME_RING_CAPACITY } from "../../agent/run-store.ts";
import { ErrorCode, HttpError } from "../errors.ts";
import type { ZocUIChunk } from "../../agent/build-agent.ts";

const TOKEN = "run-routes-token-0123456789ab";

let server: Server;
let port = 0;
let manager: RunManager;
let sources: Map<string, ReturnType<typeof controllable>>;
let plan: (() => Promise<RunPlan>) | null;
let runIds: string[];

function controllable(): {
  stream: ReadableStream<ZocUIChunk>;
  push: (chunk: ZocUIChunk) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<ZocUIChunk>;
  const stream = new ReadableStream<ZocUIChunk>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
}

function textChunk(text: string): ZocUIChunk {
  return { type: "text-delta", id: "t1", delta: text } as unknown as ZocUIChunk;
}

function terminal(): ZocUIChunk {
  return {
    type: "data-zoc-run",
    id: "run",
    data: {
      type: "run-lifecycle",
      seq: 0,
      runId: "run",
      messageId: "msg",
      ts: new Date(0).toISOString(),
      agentName: null,
      state: "completed",
    },
  } as unknown as ZocUIChunk;
}

const body = {
  sessionId: "s1",
  prompt: "explain this file",
  mentions: [{ kind: "file" as const, ref: "src/index.ts" }],
  mode: "agent" as const,
  permissionMode: "ask" as const,
  modelRef: { provider: "openai", modelId: "gpt-4o" },
};

function listen(configure: (deps: RunRoutesDeps) => RunRoutesDeps = (d) => d): Promise<void> {
  const deps: RunRoutesDeps = configure({
    manager,
    plan: async () =>
      plan === null
        ? {
            provider: "openai",
            model: "gpt-4o",
            open: (binding) => {
              const source = controllable();
              sources.set(binding.runId, source);
              return source.stream;
            },
          }
        : plan(),
    newRunId: () => {
      const id = `run_${runIds.length + 1}`;
      runIds.push(id);
      return id;
    },
    newMessageId: () => "msg_1",
    keepaliveMs: 50,
  });

  const route = buildRoutes(
    { token: TOKEN, workspaceServicesUrl: "http://127.0.0.1:1", workspaceRoot: "/tmp" },
    (router) => registerRunRoutes(router, deps),
  );
  server = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
}

beforeEach(() => {
  sources = new Map();
  runIds = [];
  plan = null;
  manager = new RunManager({
    store: new RunStore(),
    slots: new SlotManager({ capacity: 1, queueLimit: 1, isLocal: () => false }),
    graceMs: 20,
  });
});

afterEach(async () => {
  for (const source of sources.values()) {
    try {
      source.close();
    } catch {
      /* already closed */
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(
  path: string,
  payload?: unknown,
  init: { token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = init.token === undefined ? TOKEN : init.token;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** Open the stream and read every frame until the runtime ends the response. */
async function readStream(
  path: string,
): Promise<{ status: number; frames: string[]; raw: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
  });
  if (response.body === null || !response.ok) {
    return { status: response.status, frames: [], raw: await response.text() };
  }
  const raw = await response.text();
  return {
    status: response.status,
    frames: raw.split("\n\n").filter((frame) => frame.length > 0 && !frame.startsWith(":")),
    raw,
  };
}

/** `id:` values in arrival order — the sequence contract, read off the wire. */
function seqsOf(frames: readonly string[]): number[] {
  return frames.map((frame) => Number(/^id: (\d+)$/m.exec(frame)?.[1] ?? Number.NaN));
}

describe("POST /v1/runs", () => {
  it("answers the run id and the stream url to follow it on", async () => {
    await listen();
    const { status, body: answer } = await post("/v1/runs", body);

    expect(status).toBe(200);
    expect(answer).toEqual({
      runId: "run_1",
      streamUrl: "/v1/runs/run_1/stream",
      queuePosition: null,
    });
  });

  it("refuses an api_key field rather than ignoring it (R7.8)", async () => {
    await listen();
    const { status, body: answer } = await post("/v1/runs", {
      ...body,
      apiKey: "sk-should-never-travel-CANARY",
    });

    // A closed schema is what makes R7.8 a property of the route. And the rejection
    // must not quote the key back: `details` names the count, never the value.
    expect(status).toBe(422);
    expect(answer.code).toBe("invalid_request");
    expect(JSON.stringify(answer)).not.toContain("sk-should-never");
  });

  it("rejects a body missing a mode, before anything is planned", async () => {
    const planned = vi.fn(async () => ({
      provider: "openai",
      model: "gpt-4o",
      open: () => controllable().stream,
    }));
    await listen((deps) => ({ ...deps, plan: planned }));

    const { sessionId, prompt, permissionMode, modelRef } = body;
    const { status } = await post("/v1/runs", { sessionId, prompt, permissionMode, modelRef });

    expect(status).toBe(422);
    expect(planned).not.toHaveBeenCalled();
  });

  it("lets a plan failure answer with its own status and code", async () => {
    plan = async () => {
      throw new HttpError(400, {
        code: ErrorCode.NO_KEY_CONFIGURED,
        message: "OpenAI needs an API key before it can be used. Add one in Settings.",
        details: null,
        retryable: false,
      });
    };
    await listen();

    const { status, body: answer } = await post("/v1/runs", body);
    expect(status).toBe(400);
    expect(answer.code).toBe("no_key_configured");
    // No Run was opened for a request that could never dispatch.
    expect(manager.record("run_1")).toBeNull();
  });

  it("queues the second Run and reports its position", async () => {
    await listen();
    await post("/v1/runs", body);
    const { body: answer } = await post("/v1/runs", { ...body, sessionId: "s2" });

    expect(answer.queuePosition).toBe(1);
    expect(sources.has("run_2")).toBe(false);
  });

  it("refuses with slot_queue_full once the queue is full", async () => {
    await listen();
    await post("/v1/runs", body);
    await post("/v1/runs", { ...body, sessionId: "s2" });
    const { status, body: answer } = await post("/v1/runs", { ...body, sessionId: "s3" });

    expect(status).toBe(429);
    expect(answer.code).toBe("slot_queue_full");
    expect(answer.retryable).toBe(true);
    // The refused Run left nothing behind for the stream route to attach to.
    expect(manager.record("run_3")).toBeNull();
  });
});

describe("GET /v1/runs/:id/stream (R16.3, R16.4)", () => {
  it("frames each chunk as id + data, and ends when the Run does", async () => {
    await listen();
    await post("/v1/runs", body);
    const source = sources.get("run_1");

    const reading = readStream("/v1/runs/run_1/stream");
    await new Promise((resolve) => setTimeout(resolve, 20));
    source?.push(textChunk("hello"));
    source?.push(terminal());
    source?.close();

    const { status, frames } = await reading;
    expect(status).toBe(200);
    expect(seqsOf(frames)).toEqual([1, 2]);
    expect(frames[0]).toContain('"type":"text-delta"');
    // The `seq` is also on the part itself, stamped by the framing stage.
    expect(frames[1]).toContain('"seq":2');
  });

  it("replays what was missed, then continues live", async () => {
    await listen();
    await post("/v1/runs", body);
    const source = sources.get("run_1");

    source?.push(textChunk("one"));
    source?.push(textChunk("two"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reading = readStream("/v1/runs/run_1/stream?fromSeq=1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    source?.push(terminal());
    source?.close();

    const { frames } = await reading;
    // `seq: 1` was already rendered, so it is not resent; 2 is replayed and 3 is live.
    expect(seqsOf(frames)).toEqual([2, 3]);
  });

  it("replays the whole transcript and ends for a Run that already finished", async () => {
    await listen();
    await post("/v1/runs", body);
    const source = sources.get("run_1");
    source?.push(textChunk("done"));
    source?.push(terminal());
    source?.close();
    await manager.driver("run_1")?.settled;

    const { status, frames } = await readStream("/v1/runs/run_1/stream");
    expect(status).toBe(200);
    expect(seqsOf(frames)).toEqual([1, 2]);
  });

  it("answers 404 run_not_found for a Run the runtime never had", async () => {
    await listen();
    const { status, raw } = await readStream("/v1/runs/run_nope/stream");
    expect(status).toBe(404);
    expect(JSON.parse(raw).code).toBe("run_not_found");
  });

  it("answers 409 resume_window_expired when the gap cannot be closed", async () => {
    await listen();
    await post("/v1/runs", body);
    const source = sources.get("run_1");

    // Overrun the 2048-entry window by two, so the oldest replayable `seq` is 3 and
    // a client asking to resume from 1 is asking for a chunk that no longer exists.
    // Done for real rather than with a shrunken ring: the capacity is the resume
    // guarantee, and a test that reconfigures it stops guarding the guarantee.
    for (let index = 0; index < RESUME_RING_CAPACITY + 2; index += 1) {
      source?.push(textChunk(`t${index}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.record("run_1")?.ring.oldestSeq).toBe(3);

    const { status, raw } = await readStream("/v1/runs/run_1/stream?fromSeq=1");
    expect(status).toBe(409);
    expect(JSON.parse(raw).code).toBe("resume_window_expired");
    expect(JSON.parse(raw).retryable).toBe(false);
  });

  it("accepts the oldest resumable position, one below the window's first seq", async () => {
    await listen();
    await post("/v1/runs", body);
    const source = sources.get("run_1");
    for (let index = 0; index < RESUME_RING_CAPACITY + 2; index += 1) {
      source?.push(textChunk(`t${index}`));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    // `fromSeq = oldest - 1` is the boundary: the client's next expected chunk is
    // still buffered, so the gap closes and the stream opens.
    const reading = readStream("/v1/runs/run_1/stream?fromSeq=2");
    await new Promise((resolve) => setTimeout(resolve, 20));
    source?.push(terminal());
    source?.close();
    const { status, frames } = await reading;

    expect(status).toBe(200);
    expect(seqsOf(frames)[0]).toBe(3);
  });

  it("rejects a malformed fromSeq rather than silently replaying everything", async () => {
    await listen();
    await post("/v1/runs", body);
    const { status, raw } = await readStream("/v1/runs/run_1/stream?fromSeq=banana");
    expect(status).toBe(422);
    expect(JSON.parse(raw).code).toBe("invalid_request");
  });
});

describe("POST /v1/runs/:id/cancel (R16.1)", () => {
  it("accepts the request rather than reporting the outcome", async () => {
    await listen();
    await post("/v1/runs", body);

    const { status, body: answer } = await post("/v1/runs/run_1/cancel");
    expect(status).toBe(202);
    expect(answer).toEqual({ accepted: true });
    expect(await manager.driver("run_1")?.settled).toBe("cancelled");
  });

  it("closes the attached stream with a cancelled row, then ends it", async () => {
    await listen();
    await post("/v1/runs", body);
    const reading = readStream("/v1/runs/run_1/stream");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await post("/v1/runs/run_1/cancel");
    const { frames } = await reading;

    // The stream terminates on its own — the client does not have to close it — and
    // the last thing it carries is the cancelled lifecycle.
    expect(frames.at(-1)).toContain('"state":"cancelled"');
    expect(seqsOf(frames)).toEqual([1]);
  });

  it("is idempotent for a Run that has already finished", async () => {
    await listen();
    await post("/v1/runs", body);
    sources.get("run_1")?.push(terminal());
    sources.get("run_1")?.close();
    await manager.driver("run_1")?.settled;

    const { status, body: answer } = await post("/v1/runs/run_1/cancel");
    expect(status).toBe(202);
    expect(answer).toEqual({ accepted: true });
  });

  it("answers 404 run_not_found for a Run the runtime never had", async () => {
    await listen();
    const { status, body: answer } = await post("/v1/runs/run_nope/cancel");
    expect(status).toBe(404);
    expect(answer.code).toBe("run_not_found");
  });
});

describe("admission (R3.6)", () => {
  it("refuses every Run route without the bearer token", async () => {
    await listen();
    expect((await post("/v1/runs", body, { token: null })).status).toBe(401);
    expect((await post("/v1/runs/run_1/cancel", undefined, { token: null })).status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${port}/v1/runs/run_1/stream`);
    expect(response.status).toBe(401);
    await response.text();
  });
});
