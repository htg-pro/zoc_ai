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
  getAgentClient,
  makeAgentClient,
} from "@/lib/agent-client";

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
    if (url.endsWith("/v1/sessions/s1/index/fs-changed")) return mockJson({ accepted: 1 }, 202);
    if (url.endsWith("/v1/terminal")) return mockJson({ id: "t1", cmd: "bash" }, 201);
    if (url.endsWith("/v1/terminal/t1/input")) return mockJson({ ok: true });
    if (url.endsWith("/v1/terminal/t1/resize")) return mockJson({ ok: true });
    if (url.endsWith("/v1/terminal/t1/stop")) return mockJson({ id: "t1", status: "exited" });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

// NOTE (zoc-agent-ecosystem-merge, task 9.2): the agent run / event / approval
// transport tests (runAgent SSE, retryApproval, reconnect, seq-cursor resume)
// were removed with the transport itself. The Gateway run loop is now covered
// by the `useAgentStream` / gateway-client tests. The cases below cover the
// surviving editor-support endpoints (port resolution, sessions, terminal,
// index) that remain in `agent-client.ts`.
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

    const changed = await c.indexFilesChanged("s1", ["/workspace/src/app.ts"]);
    expect(changed.accepted).toBe(1);
    const changedReq = captured[captured.length - 1];
    expect(changedReq.url).toBe(
      "http://127.0.0.1:9999/v1/sessions/s1/index/fs-changed",
    );
    expect(changedReq.init.method).toBe("POST");
    expect(JSON.parse(changedReq.init.body as string)).toEqual({
      paths: ["/workspace/src/app.ts"],
    });
  });

  it("throws on non-2xx with a useful message", async () => {
    await expect(c.getSession("nope")).rejects.toThrow(/http 404/);
  });
});
