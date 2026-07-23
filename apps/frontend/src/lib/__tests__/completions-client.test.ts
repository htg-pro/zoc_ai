import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent-port", () => ({
  resolveAgentPort: vi.fn(async () => 8765),
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const body = { prefix: "a", suffix: "b", language: "python", filePath: "/f.py" };

describe("completions-client streamCompletion (task 10.2)", () => {
  it("forwards token chunks in order and resolves on done", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseBody([tokenFrame("foo"), tokenFrame("("), tokenFrame("bar)"), DONE]),
    });
    const tokens: string[] = [];
    await streamCompletion(body, (c) => tokens.push(c), new AbortController().signal);
    expect(tokens).toEqual(["foo", "(", "bar)"]);
  });

  it("stops forwarding at the done terminal", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
  });

  it("settles quietly when fetch rejects (network error / abort)", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const tokens: string[] = [];
    await expect(
      streamCompletion(body, (c) => tokens.push(c), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(tokens).toEqual([]);
  });

  it("emits no tokens for an immediate empty (done-only) completion", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseBody([DONE]),
    });
    const tokens: string[] = [];
    await streamCompletion(body, (c) => tokens.push(c), new AbortController().signal);
    expect(tokens).toEqual([]);
  });
});
