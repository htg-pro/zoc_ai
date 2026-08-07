/**
 * The two editor inference routes over real HTTP — R6.2, 9.7.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.7 (R6.2).
 *
 * The assertions are all about frame shape and about failing quiet, because those
 * two are the whole contract: Monaco's inline-completions provider reads `event:
 * token` and `event: done` and treats anything else as no completion, and it has
 * nowhere to render an error. A route that answered 502 on a rate limit would turn a
 * missed completion into a broken editor.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdmission } from "../admission.ts";
import { createRequestListener } from "../../main.ts";
import { buildRoutes } from "../routes.ts";
import { registerEditorRoutes, type EditorGenerateRequest } from "../editor-routes.ts";
import { CompletionCache } from "../../agent/editor-inference.ts";

const TOKEN = "editor-token-0123456789abcdef";

let server: Server;
let port = 0;
let calls: EditorGenerateRequest[];
let chunks: string[];
let failAfter: number | null;
let cache: CompletionCache;
let clockMs: number;

function generate(request: EditorGenerateRequest): AsyncIterable<string> {
  calls.push(request);
  return (async function* stream() {
    for (const [index, chunk] of chunks.entries()) {
      if (failAfter !== null && index === failAfter) {
        throw new Error("the provider hung up");
      }
      yield chunk;
    }
  })();
}

beforeEach(async () => {
  calls = [];
  chunks = ["const ", "a = 1;"];
  failAfter = null;
  cache = new CompletionCache();
  clockMs = 0;

  const route = buildRoutes(
    { token: TOKEN, workspaceServicesUrl: "http://127.0.0.1:1", workspaceRoot: "/tmp" },
    (router) => registerEditorRoutes(router, { generate, cache, now: () => clockMs }),
  );
  server = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Sse {
  status: number;
  events: Array<{ event: string; data: unknown }>;
  raw: string;
}

async function sse(path: string, payload: unknown): Promise<Sse> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  const events = raw
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
      return { event, data: data.length > 0 ? (JSON.parse(data) as unknown) : null };
    });
  return { status: response.status, events, raw };
}

const completion = { prefix: "const ", suffix: "\n", language: "typescript", filePath: "a.ts" };

describe("POST /v1/completions", () => {
  it("streams one token per chunk in order, then exactly one done", async () => {
    const { status, events } = await sse("/v1/completions", completion);

    expect(status).toBe(200);
    expect(events).toEqual([
      { event: "token", data: { text: "const " } },
      { event: "token", data: { text: "a = 1;" } },
      { event: "done", data: {} },
    ]);
  });

  it("uses the FIM prompt for a FIM model and the fallback otherwise", async () => {
    await sse("/v1/completions", { ...completion, model: "codestral-latest" });
    expect(calls[0]?.prompt).toBe("<PRE>const <SUF>\n<MID>");

    await sse("/v1/completions", { ...completion, prefix: "x", model: "gpt-4o" });
    expect(calls[1]?.prompt).toContain("<CURSOR>");
  });

  it("applies the fixed sampling parameters and the stop sequences", async () => {
    await sse("/v1/completions", completion);
    expect(calls[0]).toMatchObject({
      temperature: 0.1,
      maxOutputTokens: 128,
      stopSequences: ["\n\n", "```"],
    });
  });

  it("serves a fresh cache hit with no model call at all", async () => {
    await sse("/v1/completions", completion);
    expect(calls).toHaveLength(1);

    const { events } = await sse("/v1/completions", completion);
    expect(calls).toHaveLength(1);
    // One token carrying the whole cached completion, then the terminal.
    expect(events).toEqual([
      { event: "token", data: { text: "const a = 1;" } },
      { event: "done", data: {} },
    ]);
  });

  it("recomputes once the entry has aged out", async () => {
    await sse("/v1/completions", completion);
    clockMs = 30_000;
    await sse("/v1/completions", completion);
    expect(calls).toHaveLength(2);
  });

  it("fails quiet when the model dies mid-stream, keeping what arrived", async () => {
    failAfter = 1;
    const { status, events } = await sse("/v1/completions", completion);

    expect(status).toBe(200);
    expect(events).toEqual([
      { event: "token", data: { text: "const " } },
      { event: "done", data: {} },
    ]);
  });

  it("fails quiet when the model produces nothing, with the terminal still sent", async () => {
    chunks = [];
    const { status, events } = await sse("/v1/completions", completion);
    expect(status).toBe(200);
    expect(events).toEqual([{ event: "done", data: {} }]);
  });

  it("does not cache a completion that failed halfway", async () => {
    failAfter = 1;
    await sse("/v1/completions", completion);
    failAfter = null;
    await sse("/v1/completions", completion);
    // A truncated answer served back for thirty seconds is worse than no answer.
    expect(calls).toHaveLength(2);
  });

  it("refuses an apiKey field rather than ignoring it (R7.8)", async () => {
    const { status, raw } = await sse("/v1/completions", {
      ...completion,
      apiKey: "sk-must-not-travel-CANARY",
    });
    expect(status).toBe(422);
    expect(raw).not.toContain("sk-must-not-travel");
    expect(calls).toEqual([]);
  });

  it("rejects a body with no prefix before opening the stream", async () => {
    const { status, events } = await sse("/v1/completions", { suffix: "", language: "ts" });
    expect(status).toBe(422);
    expect(events.some((frame) => frame.event === "done")).toBe(false);
  });
});

describe("POST /v1/inline-edit", () => {
  const edit = {
    instruction: "make it async",
    code: "function f() {}",
    prefix: "",
    suffix: "",
    language: "typescript",
    filePath: "a.ts",
  };

  it("streams tokens, then one done carrying the whole replacement", async () => {
    chunks = ["async function", " f() {}"];
    const { status, events } = await sse("/v1/inline-edit", edit);

    expect(status).toBe(200);
    expect(events).toEqual([
      { event: "token", data: { text: "async function" } },
      { event: "token", data: { text: " f() {}" } },
      { event: "done", data: { text: "async function f() {}" } },
    ]);
  });

  it("strips a fence the model wrapped the replacement in", async () => {
    // The chunks arrive fenced and are forwarded as they came — the animation is
    // cosmetic — but the `done` carries what Monaco will actually apply.
    chunks = ["```ts\n", "async function f() {}", "\n```"];
    const { events } = await sse("/v1/inline-edit", edit);
    expect(events.at(-1)).toEqual({ event: "done", data: { text: "async function f() {}" } });
  });

  it("sends no stop sequence, so a blank line cannot truncate the edit", async () => {
    await sse("/v1/inline-edit", edit);
    expect(calls[0]?.stopSequences).toEqual([]);
    expect(calls[0]).toMatchObject({ temperature: 0.1, maxOutputTokens: 512 });
  });

  it("builds the replacement-only prompt", async () => {
    await sse("/v1/inline-edit", edit);
    expect(calls[0]?.prompt).toContain("Return ONLY the replacement code");
    expect(calls[0]?.prompt).toContain("Instruction: make it async");
  });

  it("fails quiet, ending with a done carrying whatever arrived", async () => {
    chunks = ["partial"];
    failAfter = 0;
    const { status, events } = await sse("/v1/inline-edit", edit);
    expect(status).toBe(200);
    expect(events).toEqual([{ event: "done", data: { text: "" } }]);
  });

  it("requires an instruction", async () => {
    const { status } = await sse("/v1/inline-edit", { ...edit, instruction: "" });
    expect(status).toBe(422);
  });

  it("refuses both credential fields the Gateway's shape carries", async () => {
    expect((await sse("/v1/inline-edit", { ...edit, apiKey: "sk-x" })).status).toBe(422);
    expect((await sse("/v1/inline-edit", { ...edit, baseUrl: "http://evil" })).status).toBe(422);
  });
});

describe("admission (R3.6)", () => {
  it("refuses both editor routes without the bearer token", async () => {
    for (const path of ["/v1/completions", "/v1/inline-edit"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
      await response.text();
    }
    expect(calls).toEqual([]);
  });
});
