/**
 * Transcript history — zoc-agent-chat-rebuild R15.6, R23.5, R34.6.
 *
 * The adapter that closed the history gap. Before it, `loadHistory` answered `[]`
 * and `RunContext.persistence` was never supplied, so every Run was single-turn
 * and no Run was written down. Four claims are worth pinning, and three of them
 * are about what the flattening leaves out.
 *
 * 1. **The write is verbatim.** The Chat_Surface has to get its parts back, so the
 *    persist path hands the store the messages untouched.
 * 2. **The read is flattened, and reasoning is not in it.** A provider does not
 *    accept replayed thinking, and counting it would overstate what a resend costs.
 * 3. **A legacy row still carries its turn** (R23.5): a pre-rebuild record has
 *    `content` and no `parts`, and reading it as an empty message would silently
 *    drop a turn from an upgraded install's context.
 * 4. **Neither direction throws.** A transcript that cannot be read starts the Run
 *    single-turn; one that cannot be written costs the record, never the answer.
 */

import { describe, expect, it, vi } from "vitest";

import { WorkspaceClient } from "../../tools/workspace-client.ts";
import { pinFrom } from "../compaction.ts";
import {
  compactionPartsFrom,
  createTranscriptHistory,
  dataPartsFrom,
  flattenParts,
  historyFrom,
} from "../transcript-history.ts";

function clientWith(fetchImpl: typeof fetch): WorkspaceClient {
  return new WorkspaceClient({
    bridgeUrl: "http://127.0.0.1:9/bridge",
    servicesUrl: "http://127.0.0.1:9",
    token: "token-0123456789",
    fetchImpl,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const assistantRecord = {
  id: "m2",
  role: "assistant",
  parts: [
    { type: "step-start" },
    { type: "reasoning", text: "The parser is recursive descent, so…" },
    { type: "text", text: "Renamed the token enum." },
    {
      type: "tool-workspace_read",
      toolCallId: "call_1",
      toolName: "workspace_read",
      state: "output-available",
      input: { path: "src/lex.ts" },
      output: { content: "export enum Tok {}" },
    },
    {
      type: "data-zoc-diff",
      id: "diff_1",
      data: { type: "diff", seq: 4, runId: "run_1", messageId: "m2", checkpointId: "chk_9" },
    },
  ],
};

describe("flattenParts", () => {
  it("keeps text and tool traffic, and leaves reasoning and data parts out", () => {
    const text = flattenParts(assistantRecord);

    expect(text).toContain("Renamed the token enum.");
    expect(text).toContain("[tool workspace_read]");
    expect(text).toContain('"path":"src/lex.ts"');
    expect(text).toContain('"content":"export enum Tok {}"');
    // Reasoning: providers do not take replayed thinking as input.
    expect(text).not.toContain("recursive descent");
    // Data parts are the surface's record of the Run, not model input.
    expect(text).not.toContain("chk_9");
  });

  it("falls back to a legacy row's flat content (R23.5)", () => {
    expect(flattenParts({ id: "m1", role: "user", content: "explain the lexer", parts: [] })).toBe(
      "explain the lexer",
    );
  });

  it("prefers parts over content when both are present", () => {
    const text = flattenParts({
      id: "m1",
      role: "user",
      content: "stale mirror",
      parts: [{ type: "text", text: "the real turn" }],
    });
    expect(text).toBe("the real turn");
  });

  it("survives an unserialisable tool payload rather than losing the message", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const text = flattenParts({
      id: "m1",
      role: "assistant",
      parts: [
        { type: "tool-x", toolName: "x", input: circular },
        { type: "text", text: "still here" },
      ],
    });
    expect(text).toContain("still here");
  });
});

describe("historyFrom", () => {
  it("maps stored records to history in order, skipping what it cannot use", () => {
    const history = historyFrom([
      { id: "m1", role: "user", parts: [{ type: "text", text: "explain" }] },
      assistantRecord,
      // A `tool`-role row: in a UI message the tool result is already a part of
      // the assistant message, so a separate row would duplicate it.
      { id: "m3", role: "tool", parts: [{ type: "text", text: "duplicate" }] },
      { role: "user", parts: [] }, // no id
      "not an object",
      null,
    ]);

    expect(history.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(history[0]?.role).toBe("user");
    expect(history[1]?.text).toContain("Renamed the token enum.");
  });
});

describe("dataPartsFrom and the compaction pin (R34.6)", () => {
  it("unwraps `data-zoc-*` parts to their wire payloads", () => {
    const parts = dataPartsFrom([assistantRecord]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("diff");
  });

  it("derives the newest pin from a transcript that has compacted twice", () => {
    const records = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "data-zoc-compaction",
            id: "c1",
            data: {
              type: "compaction",
              seq: 3,
              runId: "run_1",
              messageId: "m1",
              ts: "2026-07-31T10:00:00.000Z",
              agentName: null,
              compactionId: "c1",
              summary: "first fold",
              foldedMessageIds: ["a", "b"],
              contextTokensBefore: 100,
              contextTokensAfter: 40,
              trigger: "automatic",
            },
          },
        ],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [
          {
            type: "data-zoc-compaction",
            id: "c2",
            data: {
              type: "compaction",
              seq: 9,
              runId: "run_2",
              messageId: "m2",
              ts: "2026-07-31T11:00:00.000Z",
              agentName: null,
              compactionId: "c2",
              summary: "second fold",
              foldedMessageIds: ["a", "b", "c"],
              contextTokensBefore: 120,
              contextTokensAfter: 50,
              trigger: "manual",
            },
          },
        ],
      },
    ];

    const pin = pinFrom(compactionPartsFrom(records));

    // A Session compacts more than once, and the pin is the newest fold — its
    // `foldedMessageIds` are the union, which is what keeps the derivation a read
    // of one part rather than a merge of several.
    expect(pin?.compactionId).toBe("c2");
    expect(pin?.foldedMessageIds).toEqual(["a", "b", "c"]);
  });

  it("answers no pin for a Session that has never compacted", () => {
    expect(pinFrom(compactionPartsFrom([assistantRecord]))).toBeNull();
  });
});

describe("createTranscriptHistory", () => {
  it("reads a Session's transcript over GET and flattens it", async () => {
    const fetchImpl = vi.fn(async () => json({ messages: [assistantRecord] }));
    const history = createTranscriptHistory(clientWith(fetchImpl as unknown as typeof fetch));

    const prior = await history.loadHistory("sess/one");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/v1/sessions/sess%2Fone/messages");
    expect(init.method).toBe("GET");
    expect(prior.map((message) => message.id)).toEqual(["m2"]);
  });

  it("writes the completed messages verbatim over PUT", async () => {
    const fetchImpl = vi.fn(async () => json({ messages: [] }));
    const history = createTranscriptHistory(clientWith(fetchImpl as unknown as typeof fetch));

    await history.persist({
      sessionId: "s1",
      runId: "run_1",
      messages: [assistantRecord] as never,
      aborted: false,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/v1/sessions/s1/messages");
    // PUT, and the whole conversation: `onFinish` hands over every message, so an
    // append would double the history and a POST would be the wrong verb for a
    // write that has to be safe to retry.
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(String(init.body)) as { messages: unknown[] };
    expect(sent.messages).toEqual([assistantRecord]);
  });

  it("persists an aborted Run too, because the user read the partial answer", async () => {
    const fetchImpl = vi.fn(async () => json({ messages: [] }));
    const history = createTranscriptHistory(clientWith(fetchImpl as unknown as typeof fetch));

    await history.persist({
      sessionId: "s1",
      runId: "run_1",
      messages: [assistantRecord] as never,
      aborted: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("starts the Run single-turn when the store cannot answer, and says so", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const log = vi.fn();
    const history = createTranscriptHistory(clientWith(fetchImpl as unknown as typeof fetch), log);

    await expect(history.loadHistory("s1")).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith("transcript read failed", expect.stringContaining("workspace"));
  });

  it("never throws on a failed write — the answer outlives the record", async () => {
    const fetchImpl = vi.fn(async () => json({ message: "gone" }, 503));
    const log = vi.fn();
    const history = createTranscriptHistory(clientWith(fetchImpl as unknown as typeof fetch), log);

    await expect(
      history.persist({ sessionId: "s1", runId: "run_1", messages: [], aborted: false }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("transcript write failed", expect.stringContaining("run_1"));
  });
});
