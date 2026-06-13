import { describe, expect, it } from "vitest";
import { sseJson } from "@/lib/sse";

function streamFromChunks(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("sseJson", () => {
  it("yields parsed JSON events", async () => {
    const original = global.fetch;
    global.fetch = async () =>
      streamFromChunks([
        "data: {\"n\":1}\n\n",
        "data: {\"n\":2}\n\ndata: {\"n\":3}\n\n",
      ]);
    try {
      const out: unknown[] = [];
      for await (const ev of sseJson<{ n: number }>("http://x")) out.push(ev);
      expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    } finally {
      global.fetch = original;
    }
  });

  it("concatenates multi-line data blocks", async () => {
    const original = global.fetch;
    global.fetch = async () => streamFromChunks(["data: {\"a\":\n", "data: 1}\n\n"]);
    try {
      const out: unknown[] = [];
      for await (const ev of sseJson<{ a: number }>("http://x")) out.push(ev);
      expect(out).toEqual([{ a: 1 }]);
    } finally {
      global.fetch = original;
    }
  });

  it("skips comment heartbeats", async () => {
    const original = global.fetch;
    global.fetch = async () => streamFromChunks([":keepalive\n\ndata: {\"ok\":true}\n\n"]);
    try {
      const out: unknown[] = [];
      for await (const ev of sseJson<{ ok: boolean }>("http://x")) out.push(ev);
      expect(out).toEqual([{ ok: true }]);
    } finally {
      global.fetch = original;
    }
  });

  it("throws on non-2xx", async () => {
    const original = global.fetch;
    global.fetch = async () =>
      new Response("nope", { status: 500, headers: { "content-type": "text/plain" } });
    try {
      await expect(async () => {
        for await (const _ of sseJson("http://x")) {
          /* drain */
        }
      }).rejects.toThrow(/http 500/);
    } finally {
      global.fetch = original;
    }
  });
});
