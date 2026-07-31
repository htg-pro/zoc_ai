/**
 * The re-homed inline-edit client — zoc-agent-chat-rebuild R2.1, R6.2, R6.5, R7.8, task 22.12's guard.
 *
 * Two halves, asserted separately because only one of them moved. `consumeInlineEditStream` is carried
 * over verbatim — ordered `token` frames, a single terminal `done` carrying the authoritative
 * replacement, quiet resolution on abort — and these are the same cases the legacy suite asserted, kept
 * intact so the port is provably behaviour-preserving. `streamInlineEdit`'s target changed completely:
 * the Agent_Runtime's `POST /v1/inline-edit`, a bearer header, and no credential on the wire.
 *
 * The legacy `features/agent/inline-edit-client.ts` and its own suite stay until 26.1 deletes that tree
 * wholesale. Nothing imports it now.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime-endpoint", () => ({
  resolveRuntimeEndpoint: vi.fn((signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return Promise.resolve({ port: 3011, token: "launch-token", baseUrl: "http://127.0.0.1:3011" });
  }),
  runtimeAuthHeaders: (runtime: { token: string }) =>
    runtime.token.length > 0 ? { authorization: `Bearer ${runtime.token}` } : {},
}));
vi.mock("@/lib/active-model-context", () => ({
  resolveActiveModelRequestContext: vi.fn(() =>
    Promise.resolve({
      provider: "local-llamacpp",
      model: "qwen2.5-coder",
      // Still on the shared resolver's shape; the assertions below prove neither reaches the body.
      apiKey: "should-never-travel",
      baseUrl: "http://127.0.0.1:9090/v1",
    }),
  ),
}));

import {
  consumeInlineEditStream,
  streamInlineEdit,
  type InlineEditRequest,
} from "@/features/chat/wire/inline-edit-client";

/** Build a fake SSE byte stream from pre-encoded frame chunks. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const tokenFrame = (text: string): string => `event: token\ndata: ${JSON.stringify({ text })}\n\n`;
const doneFrame = (text: string): string => `event: done\ndata: ${JSON.stringify({ text })}\n\n`;

const mockFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;

describe("Feature: zoc-agent-chat-rebuild, task 22.12: the SSE contract, carried over unchanged", () => {
  it("forwards token chunks in order and resolves with the done replacement", async () => {
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(
      sseBody([
        tokenFrame("const "),
        tokenFrame("x = "),
        tokenFrame("1;"),
        doneFrame("const x = 1;"),
      ]),
      { onToken: (c) => tokens.push(c) },
    );
    expect(tokens).toEqual(["const ", "x = ", "1;"]);
    expect(replacement).toBe("const x = 1;");
  });

  it("resolves with the fence-stripped done text even when it differs from the tokens", async () => {
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(
      sseBody([tokenFrame("```ts\n"), tokenFrame("foo()"), tokenFrame("\n```"), doneFrame("foo()")]),
      { onToken: (c) => tokens.push(c) },
    );
    // Tokens stream verbatim, fences included, for the live preview…
    expect(tokens).toEqual(["```ts\n", "foo()", "\n```"]);
    // …and the resolved replacement is the authoritative `done` payload.
    expect(replacement).toBe("foo()");
  });

  it("stops at the single done terminal and ignores any trailing frames", async () => {
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(
      sseBody([tokenFrame("a"), doneFrame("A"), tokenFrame("late"), doneFrame("SECOND")]),
      { onToken: (c) => tokens.push(c) },
    );
    expect(tokens).toEqual(["a"]);
    expect(replacement).toBe("A");
  });

  it("handles frames split arbitrarily across chunk boundaries", async () => {
    const whole = tokenFrame("hello") + doneFrame("hello");
    const parts = [whole.slice(0, 5), whole.slice(5, 12), whole.slice(12, 31), whole.slice(31)];
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(sseBody(parts), {
      onToken: (c) => tokens.push(c),
    });
    expect(tokens).toEqual(["hello"]);
    expect(replacement).toBe("hello");
  });

  it("supports CRLF frame separators", async () => {
    const crlf = (s: string): string => s.replace(/\n/gu, "\r\n");
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(
      sseBody([crlf(tokenFrame("x")), crlf(doneFrame("X"))]),
      { onToken: (c) => tokens.push(c) },
    );
    expect(tokens).toEqual(["x"]);
    expect(replacement).toBe("X");
  });

  it("resolves with an empty replacement for a done-only (no-op) stream", async () => {
    const replacement = await consumeInlineEditStream(sseBody([doneFrame("")]));
    expect(replacement).toBe("");
  });

  it("falls back to the concatenated tokens when the stream truncates before done", async () => {
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(
      sseBody([tokenFrame("par"), tokenFrame("tial")]),
      { onToken: (c) => tokens.push(c) },
    );
    expect(tokens).toEqual(["par", "tial"]);
    expect(replacement).toBe("partial");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.12: the runtime target", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const req: InlineEditRequest = {
    instruction: "make it async",
    code: "function f() {}",
    prefix: "",
    suffix: "",
    language: "typescript",
    filePath: "/f.ts",
  };

  const sentBody = (): Record<string, unknown> => {
    const [, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  };

  it("POSTs to the Agent_Runtime with the bearer token and resolves with the replacement", async () => {
    mockFetch().mockResolvedValue({
      ok: true,
      body: sseBody([tokenFrame("async "), doneFrame("async function f() {}")]),
    });
    const tokens: string[] = [];
    const replacement = await streamInlineEdit(req, { onToken: (c) => tokens.push(c) });

    expect(replacement).toBe("async function f() {}");
    expect(tokens).toEqual(["async "]);

    const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    // The runtime's route, not the Gateway's `/v1/agent/inline-edit`.
    expect(url).toBe("http://127.0.0.1:3011/v1/inline-edit");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer launch-token");
  });

  it("sends exactly the eight fields the runtime's closed schema accepts (R7.8)", async () => {
    mockFetch().mockResolvedValue({ ok: true, body: sseBody([doneFrame("edited")]) });
    await streamInlineEdit(req);

    expect(sentBody()).toEqual({
      instruction: "make it async",
      code: "function f() {}",
      prefix: "",
      suffix: "",
      language: "typescript",
      filePath: "/f.ts",
      provider: "local-llamacpp",
      model: "qwen2.5-coder",
    });
  });

  it("never puts the resolver's apiKey or baseUrl on the wire", async () => {
    mockFetch().mockResolvedValue({ ok: true, body: sseBody([doneFrame("edited")]) });
    await streamInlineEdit(req);

    const body = sentBody();
    // The active-model resolver still returns both — it is shared with the completions client and
    // predates the split — so a spread would silently reintroduce them and get every ⌘K rejected.
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("baseUrl");
    expect(JSON.stringify(body)).not.toContain("should-never-travel");
  });

  it("still honours a caller's explicit model override", async () => {
    mockFetch().mockResolvedValue({ ok: true, body: sseBody([doneFrame("edited")]) });
    await streamInlineEdit({ ...req, provider: "anthropic", model: "claude-opus-5" });

    expect(sentBody()).toMatchObject({ provider: "anthropic", model: "claude-opus-5" });
  });

  it("resolves to an empty string quietly when already aborted, without a request", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await streamInlineEdit(req, { signal: controller.signal })).toBe("");
    expect(mockFetch()).not.toHaveBeenCalled();
  });

  it("rejects on a non-ok response, because ⌘K has somewhere to show an error", async () => {
    mockFetch().mockResolvedValue({ ok: false, status: 500, body: null });
    await expect(streamInlineEdit(req)).rejects.toThrow(/HTTP 500/u);
  });

  it("rejects when the runtime never became ready", async () => {
    const { resolveRuntimeEndpoint } = await import("@/lib/runtime-endpoint");
    (resolveRuntimeEndpoint as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("the agent runtime did not become ready"),
    );
    await expect(streamInlineEdit(req)).rejects.toThrow(/did not become ready/u);
  });
});
