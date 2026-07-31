/**
 * The completions client — zoc-agent-chat-rebuild R2.1, R6.2, R6.5, R7.8, task 22.11's guard.
 *
 * Two things are under test and they pull in opposite directions. The **contract** must be preserved
 * verbatim across the move — ordered `token` frames, one `done` terminal, and silence on every failure,
 * because Monaco calls this on every keystroke. The **target** must change completely: the Agent_Runtime
 * rather than the Gateway, a bearer header, and no credential in the body.
 *
 * The credential assertion is the load-bearing one. The runtime's body schema is a `z.strictObject`, so a
 * request still carrying `apiKey` is rejected — and since this client swallows failures by design, that
 * rejection would surface as autocomplete quietly never working rather than as an error anyone could see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime-endpoint", () => ({
  resolveRuntimeEndpoint: vi.fn((signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return Promise.resolve({ port: 3011, token: "launch-token", baseUrl: "http://127.0.0.1:3011" });
  }),
  runtimeAuthHeaders: (runtime: { token: string }) =>
    runtime.token.length > 0 ? { authorization: `Bearer ${runtime.token}` } : {},
}));
vi.mock("../active-model-context", () => ({
  resolveActiveModelRequestContext: vi.fn(() =>
    Promise.resolve({
      provider: "openai",
      model: "gpt-4o-mini",
      // Still returned by the shared resolver, which the inline-edit path also uses. The point of this
      // fixture is that the client must *not* forward these two.
      apiKey: "test-key",
      baseUrl: "https://api.example/v1",
    }),
  ),
}));

import { streamCompletion } from "../completions-client";

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function tokenFrame(text: string): string {
  return `event: token\ndata: ${JSON.stringify({ text })}\n\n`;
}

const DONE = "event: done\ndata: {}\n\n";

const mockFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;

const lastRequest = (): { url: string; init: RequestInit } => {
  const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
  return { url, init };
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const body = { prefix: "a", suffix: "b", language: "python", filePath: "/f.py" };

describe("Feature: zoc-agent-chat-rebuild, task 22.11: the completions client targets the runtime", () => {
  beforeEach(() => {
    mockFetch().mockResolvedValue({ ok: true, body: sseBody([tokenFrame("x"), DONE]) });
  });

  it("posts to the Agent_Runtime with the per-launch bearer token", async () => {
    await streamCompletion(body, () => undefined, new AbortController().signal);
    const { url, init } = lastRequest();
    expect(url).toBe("http://127.0.0.1:3011/v1/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer launch-token");
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });

  it("sends the model selection and nothing resembling a credential (R7.8)", async () => {
    await streamCompletion(body, () => undefined, new AbortController().signal);
    const payload = JSON.parse(lastRequest().init.body as string) as Record<string, unknown>;

    expect(payload).toEqual({
      prefix: "a",
      suffix: "b",
      language: "python",
      filePath: "/f.py",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    // Named separately from the equality above, because this is the assertion whose failure is silent
    // in production: the runtime's schema is closed, so either field turns every completion into a 422
    // the client swallows.
    expect(payload).not.toHaveProperty("apiKey");
    expect(payload).not.toHaveProperty("baseUrl");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.11: the preserved contract", () => {
  it("forwards token chunks in order and resolves on done", async () => {
    mockFetch().mockResolvedValue({
      ok: true,
      body: sseBody([tokenFrame("foo"), tokenFrame("("), tokenFrame("bar)"), DONE]),
    });
    const tokens: string[] = [];
    await streamCompletion(body, (c) => tokens.push(c), new AbortController().signal);
    expect(tokens).toEqual(["foo", "(", "bar)"]);
  });

  it("stops forwarding at the done terminal", async () => {
    mockFetch().mockResolvedValue({
      ok: true,
      body: sseBody([tokenFrame("x"), DONE, tokenFrame("after-done")]),
    });
    const tokens: string[] = [];
    await streamCompletion(body, (c) => tokens.push(c), new AbortController().signal);
    expect(tokens).toEqual(["x"]);
  });

  it("settles quietly with no tokens when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tokens: string[] = [];
    await expect(
      streamCompletion(body, (c) => tokens.push(c), controller.signal),
    ).resolves.toBeUndefined();
    expect(tokens).toEqual([]);
    // Never reached the network: the endpoint resolver rethrows an aborted signal.
    expect(mockFetch()).not.toHaveBeenCalled();
  });

  it("settles quietly when fetch rejects (network error / abort)", async () => {
    mockFetch().mockRejectedValue(new Error("boom"));
    const tokens: string[] = [];
    await expect(
      streamCompletion(body, (c) => tokens.push(c), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(tokens).toEqual([]);
  });

  it("settles quietly when the runtime is unavailable", async () => {
    const { resolveRuntimeEndpoint } = await import("../runtime-endpoint");
    (resolveRuntimeEndpoint as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("the runtime did not become ready"),
    );
    const tokens: string[] = [];
    await expect(
      streamCompletion(body, (c) => tokens.push(c), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(tokens).toEqual([]);
  });

  it("emits no tokens for an immediate empty (done-only) completion", async () => {
    mockFetch().mockResolvedValue({ ok: true, body: sseBody([DONE]) });
    const tokens: string[] = [];
    await streamCompletion(body, (c) => tokens.push(c), new AbortController().signal);
    expect(tokens).toEqual([]);
  });

  it("settles quietly on a non-200", async () => {
    mockFetch().mockResolvedValue({ ok: false, body: null });
    const tokens: string[] = [];
    await streamCompletion(body, (c) => tokens.push(c), new AbortController().signal);
    expect(tokens).toEqual([]);
  });
});
