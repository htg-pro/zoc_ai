import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-port", () => ({
  resolveAgentPort: vi.fn(async () => 8765),
}));
vi.mock("@/lib/active-model-context", () => ({
  resolveActiveModelRequestContext: vi.fn(async () => ({
    provider: "llamacpp",
    model: "qwen2.5-coder",
    apiKey: null,
    baseUrl: "http://127.0.0.1:9090/v1",
  })),
}));

import {
  consumeInlineEditStream,
  streamInlineEdit,
  type InlineEditRequest,
} from "../inline-edit-client";

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

describe("consumeInlineEditStream — pure SSE parsing (Part 8.2)", () => {
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

  it("resolves with the (fence-stripped) done text even when it differs from the tokens", async () => {
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(
      sseBody([tokenFrame("```ts\n"), tokenFrame("foo()"), tokenFrame("\n```"), doneFrame("foo()")]),
      { onToken: (c) => tokens.push(c) },
    );
    // Tokens are streamed verbatim (fences included) for the live preview…
    expect(tokens).toEqual(["```ts\n", "foo()", "\n```"]);
    // …but the resolved replacement is the authoritative `done` payload.
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
    const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(
      sseBody([crlf(tokenFrame("x")), crlf(doneFrame("X"))]),
      { onToken: (c) => tokens.push(c) },
    );
    expect(tokens).toEqual(["x"]);
    expect(replacement).toBe("X");
  });

  it("resolves with an empty replacement for a done-only (no-op) stream", async () => {
    const tokens: string[] = [];
    const replacement = await consumeInlineEditStream(sseBody([doneFrame("")]), {
      onToken: (c) => tokens.push(c),
    });
    expect(tokens).toEqual([]);
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

describe("streamInlineEdit — fetch + gateway wiring", () => {
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

  it("POSTs a camelCase body to /v1/agent/inline-edit and resolves with the replacement", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseBody([tokenFrame("async "), doneFrame("async function f() {}")]),
    });
    const tokens: string[] = [];
    const replacement = await streamInlineEdit(req, { onToken: (c) => tokens.push(c) });

    expect(replacement).toBe("async function f() {}");
    expect(tokens).toEqual(["async "]);

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:8765/v1/agent/inline-edit");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      instruction: "make it async",
      code: "function f() {}",
      filePath: "/f.ts",
      language: "typescript",
      provider: "llamacpp",
      model: "qwen2.5-coder",
      apiKey: null,
      baseUrl: "http://127.0.0.1:9090/v1",
    });
    // camelCase keys are sent (not snake_case).
    expect(Object.keys(sent)).toEqual(
      expect.arrayContaining(["filePath", "baseUrl", "apiKey", "provider", "model"]),
    );
  });

  it("preserves explicit model-context overrides from the caller", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseBody([doneFrame("edited")]),
    });

    await streamInlineEdit({
      ...req,
      provider: "anthropic",
      model: "claude-test",
      apiKey: "caller-key",
      baseUrl: "https://caller.example/v1",
    });

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      apiKey: "caller-key",
      baseUrl: "https://caller.example/v1",
    });
  });

  it("resolves to an empty string quietly when already aborted (no fetch)", async () => {
    const controller = new AbortController();
    controller.abort();
    const replacement = await streamInlineEdit(req, { signal: controller.signal });
    expect(replacement).toBe("");
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects when the gateway responds non-ok", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
    });
    await expect(streamInlineEdit(req)).rejects.toThrow(/HTTP 500/);
  });
});
