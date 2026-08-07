/**
 * Property 37: Transcript persistence round-trips. R15.2, R15.6.
 *
 * *For any* Message_Part sequence for a Session, persisting it and then restoring it —
 * including across a simulated application restart — yields the same parts in the same
 * `seq` order, with the tool-timeline entries and the checkpoint references intact.
 *
 * ## Why this goes through the real client and a real JSON boundary
 *
 * The interesting failures in a persistence path are not logic errors, they are
 * *serialisation* losses, and every one of them is invisible to a test that hands an
 * object to a decoder and reads it straight back:
 *
 * - `undefined` fields vanish through `JSON.stringify`, so an optional field that the
 *   surface reads as "absent" and the store reads as "missing key" diverge silently.
 * - A `Date` becomes a string and never becomes a `Date` again.
 * - A field the store does not model — every `data-zoc-*` payload, which is most of the
 *   transcript — is only preserved if the store genuinely treats records as opaque.
 *
 * So the round trip below runs through {@link makeWorkspaceServicesClient}, a fake
 * Workspace_Services that keeps the **raw request text** and replays it, and
 * {@link restoreTranscript}. Nothing is compared until it has been through
 * `JSON.stringify` and `JSON.parse` at least once, which is what the real path does.
 *
 * ## Why the fake mirrors the Python store rather than being a Map
 *
 * `zocai_gateway/transcripts.py` does three things this property depends on: it stamps
 * `createdAt` on a record that has none, it refuses a record whose envelope it cannot
 * index by, and it skips an unreadable record on read instead of failing the transcript.
 * A fake without those would let the property pass against a store that has none of them.
 * The three behaviours are asserted here as the *store's* contract; the store's own tests
 * assert them against the real implementation, and the pair is what keeps the two honest.
 *
 * ## The restart clause
 *
 * "Across a restart" is the clause that catches state living in the wrong place — a
 * decoded transcript cached in a module, a client holding messages it wrote. It is
 * simulated by discarding the cached client, resetting the module registry, and reading
 * the stored bytes back through a freshly built one. The bytes are all that survives,
 * which is exactly the guarantee.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  makeWorkspaceServicesClient,
  resetWorkspaceServicesClient,
  type WorkspaceServicesClient,
} from "@/lib/workspace-services-client";
import {
  isRestorableMessage,
  restoreTranscript,
  wirePartsOf,
} from "@/features/chat/transcript-persistence";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { diffPart, runPartSequence } from "./arbitraries";
import type { MessagePart } from "@zoc-studio/shared-types";

const RUNS = { numRuns: 60 } as const;

// ── The fake Workspace_Services (mirrors `transcripts.py`) ─────────────────

const ROLES = new Set(["user", "assistant", "system", "tool"]);

/** Session id → the stored transcript, as the raw JSON text on disk. */
const disk = new Map<string, string>();

function normalise(record: unknown): Record<string, unknown> {
  if (typeof record !== "object" || record === null) throw new Error("not an object");
  const value = record as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id === "") throw new Error("no id");
  if (typeof value.role !== "string" || !ROLES.has(value.role)) throw new Error("bad role");
  if (value.parts !== undefined && !Array.isArray(value.parts)) throw new Error("bad parts");
  return {
    ...value,
    parts: value.parts ?? [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "2026-07-31T10:00:00.000Z",
  };
}

function readable(text: string | undefined): unknown[] {
  if (text === undefined) return [];
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) return [];
  const kept: unknown[] = [];
  for (const record of parsed) {
    try {
      kept.push(normalise(record));
    } catch {
      // Skipped, as the store does: one unreadable record costs that record.
    }
  }
  return kept;
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function fakeServices(url: string, init: RequestInit = {}): Promise<Response> {
  const match = /\/v1\/sessions\/([^/]+)\/messages$/.exec(url);
  if (match === null) return Promise.resolve(json({ detail: "not found" }, 404));
  const sessionId = decodeURIComponent(match[1]!);
  const method = init.method ?? "GET";

  if (method === "GET") {
    return Promise.resolve(json({ messages: readable(disk.get(sessionId)) }));
  }

  const body = JSON.parse(String(init.body)) as { messages?: unknown[]; message?: unknown };

  if (method === "PUT") {
    let records: Record<string, unknown>[];
    try {
      records = (body.messages ?? []).map(normalise);
    } catch (error) {
      // Validated before anything is written, so a bad batch leaves the previous
      // transcript in place rather than half-replaced.
      return Promise.resolve(json({ detail: String(error) }, 422));
    }
    disk.set(sessionId, JSON.stringify(records));
    return Promise.resolve(json({ messages: readable(disk.get(sessionId)) }));
  }

  if (method === "POST") {
    let record: Record<string, unknown>;
    try {
      record = normalise(body.message);
    } catch (error) {
      return Promise.resolve(json({ detail: String(error) }, 422));
    }
    const kept = readable(disk.get(sessionId)).filter(
      (item) => (item as { id?: unknown }).id !== record.id,
    );
    kept.push(record);
    disk.set(sessionId, JSON.stringify(kept));
    return Promise.resolve(json({ messages: readable(disk.get(sessionId)) }));
  }

  return Promise.resolve(json({ detail: "method not allowed" }, 405));
}

function client(): WorkspaceServicesClient {
  return makeWorkspaceServicesClient(8712);
}

// ── The transcript generator ──────────────────────────────────────────────

/** The `data-` suffix each wire part is stored under, when it is a data part. */
const DATA_SUFFIX: Readonly<Record<string, string>> = {
  plan: "plan",
  diff: "diff",
  "permission-request": "permission",
  "run-lifecycle": "run",
  usage: "usage",
  error: "error",
  source: "source",
  compaction: "compaction",
};

/**
 * A wire part as `useChat` holds it.
 *
 * The eight data parts are wrapped (`{ type: "data-zoc-diff", id, data }`) and keep their
 * wire payload **verbatim**, `seq` included; the five native ones become the SDK's own
 * shapes, which is lossy on purpose — a run of `text` deltas coalesces into one part with
 * the joined text, and its `seq` belongs to the stream rather than to the stored row. That
 * split is the transport's, and it is mirrored rather than imported because what this
 * property is about is the *storage* of whatever the surface ended up holding.
 *
 * The consequence for the property is stated where it is asserted: the sequence claim is
 * over the parts that carry a `seq` in storage — the eight data parts, and the tool parts,
 * whose `seq` rides in `callProviderMetadata.zoc` because the timeline reads it there.
 */
function uiPartOf(part: MessagePart): unknown {
  const suffix = DATA_SUFFIX[part.type];
  if (suffix !== undefined) {
    return { type: `data-zoc-${suffix}`, id: `${part.type}_${String(part.seq)}`, data: part };
  }
  if (part.type === "text") {
    return { type: "text", text: part.delta, state: part.done ? "done" : "streaming" };
  }
  if (part.type === "reasoning") {
    return { type: "reasoning", text: part.delta, state: part.done ? "done" : "streaming" };
  }
  // The three tool parts become one UI tool part carrying the timeline facts the entry
  // model reads — the call id, the kind, the affected paths (R9.2, R21.4). Only
  // `tool-input` names the tool; the output and error parts are keyed by `toolCallId`,
  // which is why the call id rather than the name is what the timeline reconciles on.
  if (part.type === "tool-input") {
    return {
      type: `tool-${part.toolName}`,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      state: part.done ? "input-available" : "input-streaming",
      input: part.inputDelta,
      callProviderMetadata: { zoc: { seq: part.seq, kind: part.kind } },
    };
  }
  if (part.type === "tool-output") {
    return {
      type: "tool-dynamic",
      toolCallId: part.toolCallId,
      state: "output-available",
      input: {},
      output: part.output,
      resultProviderMetadata: {
        zoc: {
          seq: part.seq,
          durationMs: part.durationMs,
          summary: part.summary,
          readPaths: part.readPaths,
          writtenPaths: part.writtenPaths,
          truncated: part.truncated,
        },
      },
    };
  }
  if (part.type === "tool-error") {
    return {
      type: "tool-dynamic",
      toolCallId: part.toolCallId,
      state: "output-error",
      input: {},
      errorText: part.message,
      resultProviderMetadata: {
        zoc: { seq: part.seq, code: part.code, retryable: part.retryable },
      },
    };
  }
  // Exhaustive on purpose: a fourteenth part kind should fail this test rather than
  // fall through into a shape nothing stores.
  throw new Error(`no UI mapping for part type ${(part as { type: string }).type}`);
}

const metadata = {
  runId: "run_1",
  provider: "anthropic",
  model: "claude-opus-5",
  conversationMode: "agent",
  startedAt: "2026-07-31T10:00:00.000Z",
  finishedAt: "2026-07-31T10:00:12.000Z",
  inputTokens: 1_200,
  outputTokens: 340,
  estimatedCostCents: null,
  tokensPerSecond: 41.5,
  messagesInContext: 2,
  sessionMessageCount: 2,
  messagesOutOfWindow: 0,
  summaryActive: false,
  rulesSources: [".zoc/rules/style.md"],
} as const;

interface Fixture {
  readonly sessionId: string;
  readonly messages: readonly ZocUIMessage[];
  readonly wireParts: readonly MessagePart[];
}

/** A user turn plus an assistant turn carrying a generated part sequence. */
const transcript: fc.Arbitrary<Fixture> = fc
  .tuple(
    fc.hexaString({ minLength: 4, maxLength: 10 }),
    runPartSequence,
    fc.array(diffPart, { maxLength: 2 }),
    fc.string({ maxLength: 60 }),
  )
  .map(([id, parts, diffs, prompt]) => {
    const wireParts = [
      ...parts,
      ...diffs.map((part, index) => ({ ...part, seq: parts.length + index + 1 })),
    ];
    const messages: ZocUIMessage[] = [
      {
        id: `msg_user_${id}`,
        role: "user",
        metadata,
        parts: [{ type: "text", text: prompt }],
      } as unknown as ZocUIMessage,
      {
        id: `msg_assistant_${id}`,
        role: "assistant",
        metadata,
        parts: wireParts.map(uiPartOf),
      } as unknown as ZocUIMessage,
    ];
    return { sessionId: `sess_${id}`, messages, wireParts };
  });

/** The stored record minus the field the store adds, so equality is about the message. */
function withoutStamp(record: unknown): unknown {
  const { createdAt, ...rest } = record as Record<string, unknown>;
  void createdAt;
  return rest;
}

/**
 * The `seq` of every part that carries one in storage, in transcript order.
 *
 * Data parts carry it on the wire payload; a tool part carries it in
 * `callProviderMetadata.zoc`, which is where the timeline reads it. A native text or
 * reasoning part carries none — it is a coalesced run of deltas, and the number belonged
 * to the stream. Asserting over the ones that *have* a seq is the claim R7.7 actually
 * makes about a stored transcript; asserting over all of them would be asserting that the
 * SDK's own part shapes carry a field they never had.
 */
function storedSeqs(messages: readonly ZocUIMessage[]): readonly number[] {
  const seqs: number[] = [];
  for (const message of messages) {
    for (const part of message.parts as readonly Record<string, unknown>[]) {
      const type = typeof part.type === "string" ? part.type : "";
      if (type.startsWith("data-zoc-")) {
        const data = part.data as { seq?: unknown } | undefined;
        if (typeof data?.seq === "number") seqs.push(data.seq);
        continue;
      }
      if (type.startsWith("tool-")) {
        const call = (part.callProviderMetadata as { zoc?: { seq?: unknown } } | undefined)?.zoc;
        const result = (part.resultProviderMetadata as { zoc?: { seq?: unknown } } | undefined)
          ?.zoc;
        const seq = typeof call?.seq === "number" ? call.seq : result?.seq;
        if (typeof seq === "number") seqs.push(seq);
      }
    }
  }
  return seqs;
}

beforeEach(() => {
  disk.clear();
  vi.stubGlobal("fetch", vi.fn(fakeServices));
  resetWorkspaceServicesClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetWorkspaceServicesClient();
});

describe("Feature: zoc-agent-chat-rebuild, Property 37: transcript persistence round-trips", () => {
  it("restores every part in sequence order, across a simulated restart (R15.6)", async () => {
    await fc.assert(
      fc.asyncProperty(transcript, async ({ sessionId, messages }) => {
        disk.clear();

        await client().replaceMessages(sessionId, messages);

        // The restart: nothing but the stored bytes survives.
        resetWorkspaceServicesClient();
        const restored = restoreTranscript(await client().listMessages(sessionId));

        expect(restored.skipped).toBe(0);
        // The strongest form of the claim: field for field, including every
        // `data-zoc-*` payload the store does not model and the per-Run metadata the
        // usage row and the context meter read on restore.
        expect(restored.messages.map(withoutStamp)).toEqual(messages.map(withoutStamp));

        // And the ordering clause the property names, over the parts that carry a
        // `seq` once stored.
        expect(storedSeqs(restored.messages)).toEqual(storedSeqs(messages));
        expect(storedSeqs(restored.messages)).toEqual(
          [...storedSeqs(restored.messages)].sort((a, b) => a - b),
        );
      }),
      RUNS,
    );
  });

  it("keeps every fact the diff review re-derives from a restored transcript (R10.3, R10.7)", async () => {
    await fc.assert(
      fc.asyncProperty(transcript, async ({ sessionId, messages, wireParts }) => {
        disk.clear();
        const expected = wireParts.filter((part) => part.type === "diff");

        await client().replaceMessages(sessionId, messages);
        resetWorkspaceServicesClient();
        const restored = restoreTranscript(await client().listMessages(sessionId));

        const diffs = wirePartsOf(restored.messages).filter(
          (part) => (part as MessagePart).type === "diff",
        );

        // `planId`, `path`, `action`, `hunks`, `baseDigest`, and `stale` — the whole
        // payload, because staleness is decided against `baseDigest` on reopen and a
        // hunk that lost its id cannot be accepted or rejected at all. The
        // *checkpoint* a Run produced is not in here: it comes from the checkpoints
        // capability, which the panel reads separately (R10.5).
        expect(diffs).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("keeps the tool-timeline entries a restored transcript has to draw (R9.2, R21.4)", async () => {
    await fc.assert(
      fc.asyncProperty(transcript, async ({ sessionId, messages }) => {
        disk.clear();
        const toolPartsBefore = messages
          .flatMap((message) => message.parts as readonly unknown[])
          .filter((part) => String((part as { type?: string }).type).startsWith("tool-"));

        await client().replaceMessages(sessionId, messages);
        resetWorkspaceServicesClient();
        const restored = restoreTranscript(await client().listMessages(sessionId));

        const toolPartsAfter = restored.messages
          .flatMap((message) => message.parts as readonly unknown[])
          .filter((part) => String((part as { type?: string }).type).startsWith("tool-"));

        // Including `callProviderMetadata.zoc`, which is where the kind and the seq
        // live: a timeline that loses them draws every restored call as an
        // unclassified read.
        expect(toolPartsAfter).toEqual(toolPartsBefore);
      }),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 37: what persistence must not do", () => {
  it("does not disturb another Session's stored bytes (R23.5)", async () => {
    await fc.assert(
      fc.asyncProperty(transcript, transcript, async (first, second) => {
        fc.pre(first.sessionId !== second.sessionId);
        disk.clear();

        await client().replaceMessages(first.sessionId, first.messages);
        const before = disk.get(first.sessionId);

        await client().replaceMessages(second.sessionId, second.messages);
        await client().postMessage(second.sessionId, second.messages[0]);

        expect(disk.get(first.sessionId)).toBe(before);
      }),
      { numRuns: 30 },
    );
  });

  it("re-reads the user turn the renderer recorded before the Run (R15.7)", async () => {
    const fixture = await fc.sample(transcript, 1)[0]!;
    const [userTurn] = fixture.messages;

    await client().postMessage(fixture.sessionId, userTurn);
    resetWorkspaceServicesClient();
    const restored = restoreTranscript(await client().listMessages(fixture.sessionId));

    expect(restored.messages.map((message) => message.id)).toEqual([userTurn!.id]);
  });

  it("replaces rather than duplicates when the runtime rewrites the same turn", async () => {
    const fixture = await fc.sample(transcript, 1)[0]!;

    await client().postMessage(fixture.sessionId, fixture.messages[0]);
    await client().replaceMessages(fixture.sessionId, fixture.messages);
    const restored = restoreTranscript(await client().listMessages(fixture.sessionId));

    // The renderer's user turn and the runtime's copy of it are one message. Two
    // rows for one id renders the prompt twice.
    expect(restored.messages.map((message) => message.id)).toEqual(
      fixture.messages.map((message) => message.id),
    );
  });

  it("drops an unrenderable record and counts it, rather than failing the transcript", async () => {
    const fixture = await fc.sample(transcript, 1)[0]!;
    await client().replaceMessages(fixture.sessionId, fixture.messages);

    // A hand edit, a bad merge, a partial write: the file is on the user's disk.
    const stored = JSON.parse(disk.get(fixture.sessionId) ?? "[]") as unknown[];
    stored.splice(1, 0, { role: "assistant", parts: [] }, { id: "x", role: "narrator" });
    disk.set(fixture.sessionId, JSON.stringify(stored));

    const restored = restoreTranscript(
      // Straight from disk rather than through the client, because the store already
      // filters what it cannot index by — this asserts the *surface's* own guard.
      JSON.parse(disk.get(fixture.sessionId) ?? "[]") as unknown[],
    );

    expect(restored.messages.map((message) => message.id)).toEqual(
      fixture.messages.map((message) => message.id),
    );
    expect(restored.skipped).toBe(2);
  });

  it("accepts a record with no metadata, because a missing figure is not a lost turn", () => {
    expect(isRestorableMessage({ id: "m1", role: "user", parts: [] })).toBe(true);
    expect(isRestorableMessage({ id: "m1", role: "user" })).toBe(false);
    expect(isRestorableMessage({ role: "user", parts: [] })).toBe(false);
    expect(isRestorableMessage({ id: "", role: "user", parts: [] })).toBe(false);
    expect(isRestorableMessage({ id: "m1", role: "narrator", parts: [] })).toBe(false);
  });
});
