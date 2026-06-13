import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const tauriBridgeMock = vi.hoisted(() => ({
  agentPort: vi.fn(),
  agentStatus: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", () => tauriBridgeMock);

import {
  __cachedPort,
  __resetAgentClient,
  __resetLastSeq,
  getAgentClient,
  makeAgentClient,
} from "@/lib/agent-client";
import type { AgentEvent } from "@llama-studio/shared-types";

interface Captured {
  url: string;
  init: RequestInit;
}

let captured: Captured[];
let originalFetch: typeof fetch;

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.useRealTimers();
  __resetAgentClient();
  tauriBridgeMock.agentPort.mockReset();
  tauriBridgeMock.agentPort.mockResolvedValue(null);
  tauriBridgeMock.agentStatus.mockReset();
  tauriBridgeMock.agentStatus.mockResolvedValue(null);
  tauriBridgeMock.isTauri.mockReset();
  tauriBridgeMock.isTauri.mockReturnValue(false);
  captured = [];
  originalFetch = global.fetch;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.push({ url, init });
    if (url.endsWith("/health")) return mockJson({ status: "ok", version: "0.1" });
    if (url.endsWith("/v1/sessions")) {
      if (init.method === "POST") return mockJson({ id: "s2", title: "new" }, 201);
      return mockJson([{ id: "s1", title: "old" }]);
    }
    if (url.endsWith("/v1/sessions/s1")) {
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return mockJson({ id: "s1", title: "old" });
    }
    if (url.endsWith("/v1/providers")) return mockJson([{ kind: "mock" }]);
    if (url.endsWith("/v1/sessions/s1/index/status"))
      return mockJson({ workspace_root: "/", file_count: 1, chunk_count: 1, watching: true });
    if (url.endsWith("/v1/sessions/s1/index/query"))
      return mockJson([{ chunk: { file: "x", start_line: 0, end_line: 1, text: "y" }, score: 1 }]);
    if (url.endsWith("/v1/sessions/s1/index/reindex"))
      return mockJson({ workspace_root: "/", file_count: 1, chunk_count: 1, watching: true });
    if (url.endsWith("/v1/terminal")) return mockJson({ id: "t1", cmd: "bash" }, 201);
    if (url.endsWith("/v1/terminal/t1/input")) return mockJson({ ok: true });
    if (url.endsWith("/v1/terminal/t1/resize")) return mockJson({ ok: true });
    if (url.endsWith("/v1/terminal/t1/stop")) return mockJson({ id: "t1", status: "exited" });
    if (url.endsWith("/v1/sessions/s1/replit/plans/p1/revise")) return mockJson({ id: "p2", session_id: "s1", title: "revised", summary: "s", status: "draft", tasks: [], created_at: "t", updated_at: "t" });
    if (url.endsWith("/v1/sessions/s1/replit/tasks/t1/queue")) return mockJson({ id: "t1", session_id: "s1", title: "t", summary: "s", status: "queued", priority: "medium", depends_on: [], files_likely_changed: [], done_looks_like: [], test_plan: [], created_at: "t", updated_at: "t" });
    if (url.endsWith("/v1/sessions/s1/replit/tasks/t1/ready")) return mockJson({ id: "t1", session_id: "s1", title: "t", summary: "s", status: "ready", priority: "medium", depends_on: [], files_likely_changed: [], done_looks_like: [], test_plan: [], diff: "d", test_output: "NO ERROR", created_at: "t", updated_at: "t" });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

describe("agent-client", () => {
  const c = makeAgentClient(9999);

  it("uses the configured port for the base URL", () => {
    expect(c.baseUrl).toBe("http://127.0.0.1:9999");
  });

  it("waits for the desktop sidecar port before caching the client", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    tauriBridgeMock.isTauri.mockReturnValue(true);
    tauriBridgeMock.agentPort.mockResolvedValue(null);
    tauriBridgeMock.agentStatus.mockImplementation(async () => {
      statusCalls += 1;
      return {
        port: statusCalls >= 2 ? 4321 : null,
        running: statusCalls >= 2,
        restarts: 0,
        last_error: null,
      };
    });

    const pending = getAgentClient();
    await Promise.resolve();
    await Promise.resolve();
    expect(tauriBridgeMock.agentStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    const client = await pending;

    expect(client.port).toBe(4321);
    expect(__cachedPort()).toBe(4321);
    expect(captured.map((r) => r.url)).toContain("http://127.0.0.1:4321/health");
  });

  it("GETs /health", async () => {
    const r = await c.health();
    expect(r.status).toBe("ok");
    expect(captured[0].url).toBe("http://127.0.0.1:9999/health");
  });

  it("POSTs /v1/sessions with a JSON body", async () => {
    const s = await c.createSession({ title: "new", workspace_root: "/tmp" });
    expect(s.id).toBe("s2");
    const last = captured[captured.length - 1];
    expect(last.init.method).toBe("POST");
    expect(JSON.parse(last.init.body as string).title).toBe("new");
    expect((last.init.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("DELETEs a session", async () => {
    await c.deleteSession("s1");
    const last = captured[captured.length - 1];
    expect(last.url).toBe("http://127.0.0.1:9999/v1/sessions/s1");
    expect(last.init.method).toBe("DELETE");
  });

  it("spawns, writes, resizes, and stops a terminal", async () => {
    const t = await c.spawnTerminal("/bin/bash", { cols: 80, rows: 24 });
    expect(t.id).toBe("t1");
    await c.writeTerminal(t.id, "ls\n");
    await c.resizeTerminal(t.id, 100, 30);
    await c.stopTerminal(t.id);
    const paths = captured.map((c) => c.url);
    expect(paths).toContain("http://127.0.0.1:9999/v1/terminal/t1/input");
    expect(paths).toContain("http://127.0.0.1:9999/v1/terminal/t1/resize");
    expect(paths).toContain("http://127.0.0.1:9999/v1/terminal/t1/stop");
  });

  it("uses session-scoped index routes", async () => {
    const status = await c.indexStatus("s1");
    expect(status.workspace_root).toBe("/");
    const statusReq = captured[captured.length - 1];
    expect(statusReq.url).toBe("http://127.0.0.1:9999/v1/sessions/s1/index/status");

    const results = await c.indexQuery("s1", "hello", 5);
    expect(results).toHaveLength(1);
    const queryReq = captured[captured.length - 1];
    expect(queryReq.url).toBe("http://127.0.0.1:9999/v1/sessions/s1/index/query");
    expect(queryReq.init.method).toBe("POST");
    expect(JSON.parse(queryReq.init.body as string)).toEqual({ query: "hello", top_k: 5 });

    await c.indexRebuild("s1");
    const rebuildReq = captured[captured.length - 1];
    expect(rebuildReq.url).toBe("http://127.0.0.1:9999/v1/sessions/s1/index/reindex");
    expect(rebuildReq.init.method).toBe("POST");
  });

  it("uses Replit workflow revision and readiness routes", async () => {
    await c.reviseReplitPlan("s1", "p1", { prompt: "revise" });
    await c.queueReplitTask("s1", "t1");
    await c.markReplitTaskReady("s1", "t1");

    const paths = captured.map((r) => r.url);
    expect(paths).toContain("http://127.0.0.1:9999/v1/sessions/s1/replit/plans/p1/revise");
    expect(paths).toContain("http://127.0.0.1:9999/v1/sessions/s1/replit/tasks/t1/queue");
    expect(paths).toContain("http://127.0.0.1:9999/v1/sessions/s1/replit/tasks/t1/ready");
  });

  it("throws on non-2xx with a useful message", async () => {
    await expect(c.getSession("nope")).rejects.toThrow(/http 404/);
  });

  it("runAgent opens the SSE events stream, POSTs the trigger, and yields parsed events", async () => {
    __resetLastSeq("sX");
    const enc = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            'data: {"type":"token","session_id":"sX","seq":1,"at":"t","delta":"hi"}\n\n',
          ),
        );
        controller.enqueue(
          enc.encode(
            'data: {"type":"done","session_id":"sX","seq":2,"at":"t","ok":true}\n\n',
          ),
        );
        controller.close();
      },
    });

    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      captured.push({ url, init });
      if (url.includes("/agent/events")) {
        return new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.endsWith("/v1/sessions/sX/agent/run")) {
        return mockJson({ ok: true });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const events: AgentEvent[] = [];
    for await (const ev of c.runAgent("sX", { prompt: "hello", max_repair_attempts: 2 })) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual(["token", "done"]);

    const sseReq = captured.find((r) => r.url.includes("/agent/events"));
    expect(sseReq?.url).toBe(
      "http://127.0.0.1:9999/v1/sessions/sX/agent/events?since_seq=0",
    );

    const postReq = captured.find((r) => r.init.method === "POST");
    expect(postReq?.url).toBe("http://127.0.0.1:9999/v1/sessions/sX/agent/run");
    expect(JSON.parse(postReq?.init.body as string)).toEqual({ prompt: "hello", max_repair_attempts: 2 });
  });

  it("retries runAgent with a legacy prompt body when rich requests hit extra_forbidden", async () => {
    __resetLastSeq("sY");
    const enc = new TextEncoder();
    const makeSseBody = (events: string[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(enc.encode(event));
          controller.close();
        },
      });
    const sseBodies = [
      makeSseBody([]),
      makeSseBody([
        'data: {"type":"token","session_id":"sY","seq":1,"at":"t","delta":"ok"}\n\n',
        'data: {"type":"done","session_id":"sY","seq":2,"at":"t","ok":true}\n\n',
      ]),
    ];
    let postCount = 0;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      captured.push({ url, init });
      if (url.includes("/agent/events")) {
        return new Response(sseBodies.shift() ?? makeSseBody([]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.endsWith("/v1/sessions/sY/agent/run")) {
        postCount += 1;
        if (postCount === 1) {
          return mockJson(
            {
              detail: [
                {
                  type: "extra_forbidden",
                  loc: ["body", "workspacePath"],
                  msg: "Extra inputs are not permitted",
                },
              ],
            },
            422,
          );
        }
        return mockJson({ ok: true });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const events: AgentEvent[] = [];
    for await (const ev of c.runAgent("sY", {
      prompt: "hello",
      message: "hello",
      sessionId: "sY",
      workspacePath: "/tmp/project",
      openFiles: [],
      editorContent: "const ok = true;",
      mode: "agent",
      model: "gemma",
      maxRepairAttempts: 2,
    })) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual(["token", "done"]);
    const postReqs = captured.filter((r) => r.url.endsWith("/v1/sessions/sY/agent/run"));
    expect(postReqs).toHaveLength(2);
    expect(JSON.parse(postReqs[0].init.body as string).workspacePath).toBe("/tmp/project");
    const legacyBody = JSON.parse(postReqs[1].init.body as string) as { prompt: string };
    expect(legacyBody.prompt).toContain("hello");
    expect(legacyBody.prompt).toContain("workspace_root: /tmp/project");
    expect(legacyBody.prompt).toContain("active_editor_content");
    expect(legacyBody.prompt).toContain("do not ask the user to upload or paste project files");
  });

  it("retryApproval streams events while POSTing the retry trigger", async () => {
    __resetLastSeq("sR");
    const enc = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            'data: {"type":"token","session_id":"sR","seq":1,"at":"t","delta":"re"}\n\n',
          ),
        );
        controller.enqueue(
          enc.encode(
            'data: {"type":"done","session_id":"sR","seq":2,"at":"t","ok":true}\n\n',
          ),
        );
        controller.close();
      },
    });

    global.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input.toString();
      captured.push({ url, init });
      if (url.includes("/agent/events")) {
        return new Response(sseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.endsWith("/agent/approvals/c1/retry")) {
        return mockJson({ retried: true });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const events: AgentEvent[] = [];
    for await (const ev of c.retryApproval("sR", "c1")) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual(["token", "done"]);
    const postReq = captured.find((r) => r.init.method === "POST");
    expect(postReq?.url).toBe(
      "http://127.0.0.1:9999/v1/sessions/sR/agent/approvals/c1/retry",
    );
    expect(JSON.parse(postReq?.init.body as string)).toEqual({});
  });
});
