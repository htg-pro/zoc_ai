/**
 * Property 2: The sequence allocator is gapless and strictly increasing.
 * Validates R7.7.
 *
 * Feature: zoc-agent-chat-rebuild, Property 2 (R7.7).
 *
 * The transport's exactly-once rendering (11.1) rests on exactly two facts about
 * `seq`: it never repeats, and it never skips. A repeat makes the transport
 * discard a real chunk as already-rendered; a skip makes it read a healthy stream
 * as a gap and tear down a working connection to re-attach. So this asserts both
 * directions rather than monotonicity, which is the weaker claim a `>` comparison
 * alone would buy.
 *
 * The cases with teeth are the ones where a second counter would be tempting:
 * the model's own native chunks interleaved with Zoc data parts, a reconciled
 * `text-end` closing a part already streamed, and a sub-agent writing onto the
 * parent's stream. All three draw here.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  FIRST_SEQ,
  SeqFraming,
  SequenceAllocator,
  TERMINAL_RUN_STATES,
  UNSTAMPED_SEQ,
  createRunWriter,
  encodeSseFrame,
  isTerminalRunState,
  isZocDataChunk,
  type BufferedChunk,
  type ChunkSink,
  type ChunkWriter,
  type OutboundChunk,
} from "../writer.ts";

const RUNS = { numRuns: 200 } as const;

/** Records both sink calls so their interleaving is assertable. */
interface Recorder extends ChunkSink {
  readonly appended: BufferedChunk[];
  readonly frames: string[];
  /** `append`/`broadcast` order as a flat log of `a`/`b` markers. */
  readonly calls: string[];
}

function recorder(): Recorder {
  const appended: BufferedChunk[] = [];
  const frames: string[] = [];
  const calls: string[] = [];
  return {
    appended,
    frames,
    calls,
    append(entry) {
      appended.push(entry);
      calls.push("a");
    },
    broadcast(_entry, frame) {
      frames.push(frame);
      calls.push("b");
    },
  };
}

/**
 * Wire a `RunWriter` straight into a `SeqFraming`, which is how 9.6 composes
 * them: the SDK's stream writer is the thing in the middle, and here it is a
 * pass-through so the test observes exactly what the framing stage sees.
 */
function harness() {
  const sink = recorder();
  const framing = new SeqFraming({ sink });
  const passthrough: ChunkWriter = { write: (chunk) => void framing.frame(chunk) };
  const writer = createRunWriter({
    runId: "run_1",
    messageId: "msg_1",
    writer: passthrough,
    now: () => new Date(0),
  });
  return { sink, framing, writer };
}

/** The emission kinds a Run makes that do not end it. */
const NON_TERMINAL_EMITS = [
  "native-text-start",
  "native-text-delta",
  "native-text-end",
  "native-reasoning-delta",
  "native-tool-input-start",
  "native-tool-output",
  "plan",
  "diff",
  "permission",
  "usage",
  "error",
  "compaction",
  "running",
  "awaiting-approval",
  "sub-agent-plan",
] as const;

type Emit = (typeof NON_TERMINAL_EMITS)[number];

type Harness = ReturnType<typeof harness>;

/**
 * Perform one emission.
 *
 * The `native-*` arms go through the framing stage directly, exactly as the
 * model's chunks do when 9.6 merges `agent.stream()` onto the same stream. They
 * are here because the property that matters is gaplessness across *both*
 * producers — a counter that only numbers Zoc parts leaves the transport blind
 * across most of a normal Run.
 */
function apply({ framing, writer }: Harness, emit: Emit, i: number): void {
  switch (emit) {
    case "native-text-start":
      framing.frame({ type: "text-start", id: `t${i}` });
      return;
    case "native-text-delta":
      framing.frame({ type: "text-delta", id: `t${i}`, delta: `chunk ${i}` });
      return;
    case "native-text-end":
      // The reconciled case: closing a part already streamed. It must take a
      // *new* number — correcting in place by reusing the delta's `seq` is the
      // bug this arm exists to catch.
      framing.frame({ type: "text-end", id: `t${i}` });
      return;
    case "native-reasoning-delta":
      framing.frame({ type: "reasoning-delta", id: `r${i}`, delta: "thinking" });
      return;
    case "native-tool-input-start":
      framing.frame({
        type: "tool-input-start",
        toolCallId: `call_${i}`,
        toolName: "read_file",
      });
      return;
    case "native-tool-output":
      framing.frame({
        type: "tool-output-available",
        toolCallId: `call_${i}`,
        output: { ok: true },
      });
      return;
    case "plan":
      writer.plan({
        planId: `plan_${i}`,
        title: "Refactor",
        files: [
          {
            path: "src/a.ts",
            action: "modify",
            sourcePath: null,
            rationale: "why",
            addedLines: 3,
            removedLines: 1,
            hunkCount: 1,
          },
        ],
        verificationCommand: null,
      });
      return;
    case "diff":
      writer.diff({
        planId: `plan_${i}`,
        path: "src/a.ts",
        action: "modify",
        sourcePath: null,
        language: "typescript",
        hunks: [
          {
            hunkId: `h_${i}`,
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            patch: "@@ -1,2 +1,3 @@",
          },
        ],
        baseDigest: "digest",
        stale: false,
      });
      return;
    case "permission":
      writer.permission({
        requestId: `req_${i}`,
        toolCallId: `call_${i}`,
        toolName: "write_file",
        kind: "write",
        prompt: "Write src/a.ts?",
        paths: ["src/a.ts"],
        reason: "mode-ask",
        offeredScopes: ["call", "run"],
        expiresAt: new Date(0).toISOString(),
        decision: null,
        decidedScope: null,
      });
      return;
    case "usage":
      writer.usage({
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        contextLimit: 128_000,
        estimatedCostCents: null,
        tokensPerSecond: null,
        messagesInContext: 2,
        sessionMessageCount: 2,
        messagesOutOfWindow: 0,
        summaryActive: false,
      });
      return;
    case "error":
      writer.error({
        code: "provider_unavailable",
        message: "The provider is unavailable.",
        details: null,
        retryable: true,
      });
      return;
    case "compaction":
      writer.compaction({
        compactionId: `cmp_${i}`,
        foldedMessageIds: ["m1", "m2"],
        foldedTurnCount: 1,
        contextTokensBefore: 1000,
        contextTokensAfter: 400,
        summary: "Earlier turns summarised.",
      });
      return;
    case "running":
    case "awaiting-approval":
      writer.lifecycle({
        state: emit,
        queuePosition: null,
        code: null,
        message: null,
        provider: "openai",
        model: "gpt-5",
      });
      return;
    case "sub-agent-plan":
      // Draws from the parent's counter by construction (29.1): one framing
      // stage per Run, so a child on the parent's stream cannot have its own.
      writer.forSubAgent(`agent-${i % 3}`).plan({
        planId: `sub_${i}`,
        title: "Sub",
        files: [],
        verificationCommand: null,
      });
      return;
    default: {
      const exhaustive: never = emit;
      throw new Error(`unhandled emit ${String(exhaustive)}`);
    }
  }
}

const emitSequence = fc.array(fc.constantFrom(...NON_TERMINAL_EMITS), {
  minLength: 1,
  maxLength: 300,
});

function closeRun(h: Harness, state: (typeof TERMINAL_RUN_STATES)[number]): void {
  h.writer.lifecycle({
    state,
    queuePosition: null,
    code: state === "failed" ? "provider_unavailable" : null,
    message: null,
    provider: "openai",
    model: "gpt-5",
  });
}

describe("Property 2: the sequence allocator is gapless and strictly increasing (R7.7)", () => {
  it("numbers 1..n across native and Zoc emissions alike, with no gap or repeat", () => {
    fc.assert(
      fc.property(emitSequence, (emits) => {
        const h = harness();
        emits.forEach((emit, i) => apply(h, emit, i));

        const seqs = h.sink.appended.map((entry) => entry.seq);
        expect(seqs).toHaveLength(emits.length);
        // Gapless *and* strictly increasing in one assertion: the only sequence
        // satisfying `seq[i] === FIRST_SEQ + i` is 1, 2, 3, … with no repeat.
        expect(seqs).toEqual(seqs.map((_, i) => FIRST_SEQ + i));
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(h.framing.lastSeq).toBe(emits.length);
      }),
      RUNS,
    );
  });

  it("stamps the real seq onto every data part it buffers", () => {
    fc.assert(
      fc.property(emitSequence, (emits) => {
        const h = harness();
        emits.forEach((emit, i) => apply(h, emit, i));

        for (const entry of h.sink.appended) {
          if (!isZocDataChunk(entry.chunk)) continue;
          // The placeholder must never survive to the buffer: a persisted
          // transcript carrying `seq: 0` is a transcript that cannot be resumed
          // against or ordered by anything but arrival.
          expect(entry.chunk.data.seq).not.toBe(UNSTAMPED_SEQ);
          expect(entry.chunk.data.seq).toBe(entry.seq);
          expect(entry.chunk.data.runId).toBe("run_1");
        }
      }),
      RUNS,
    );
  });

  it("keeps a sub-agent's parts on the parent's counter while staying attributable", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.string({ minLength: 1, maxLength: 6 })), {
          minLength: 1,
          maxLength: 120,
        }),
        (steps) => {
          const h = harness();
          steps.forEach(([useChild, name], i) => {
            const target = useChild ? h.writer.forSubAgent(name) : h.writer;
            target.plan({
              planId: `plan_${i}`,
              title: "t",
              files: [],
              verificationCommand: null,
            });
          });

          const entries = h.sink.appended;
          expect(entries.map((e) => e.seq)).toEqual(steps.map((_, i) => FIRST_SEQ + i));

          // A shared `seq` space is not a shared identity: attribution (R7.2)
          // has to survive sharing the counter.
          steps.forEach(([useChild, name], i) => {
            const chunk = entries[i]?.chunk;
            expect(isZocDataChunk(chunk as OutboundChunk)).toBe(true);
            const data = (chunk as { data: { agentName: string | null } }).data;
            expect(data.agentName).toBe(useChild ? name : null);
          });
        },
      ),
      RUNS,
    );
  });

  it("buffers before broadcasting, so no reader can outrun the resume ring", () => {
    fc.assert(
      fc.property(emitSequence, (emits) => {
        const h = harness();
        emits.forEach((emit, i) => apply(h, emit, i));

        // Strict `ab` alternation: every chunk hit the ring before it hit a
        // socket. The reverse order leaves a window where a rendered `seq` is
        // one a reconnect would be told never existed.
        expect(h.sink.calls.join("")).toBe("ab".repeat(emits.length));
        expect(h.sink.frames).toHaveLength(emits.length);
      }),
      RUNS,
    );
  });

  it("stops allocating after a terminal lifecycle chunk, counting the drops", () => {
    fc.assert(
      fc.property(
        emitSequence,
        fc.constantFrom(...TERMINAL_RUN_STATES),
        emitSequence,
        (before, terminal, after) => {
          const h = harness();
          before.forEach((emit, i) => apply(h, emit, i));
          closeRun(h, terminal);

          // The chunk that ends the Run is the last one *out*, not the first
          // refused — so it gets a number.
          expect(h.framing.lastSeq).toBe(before.length + 1);
          expect(h.framing.closed).toBe(true);
          expect(h.framing.terminalState).toBe(terminal);
          expect(isTerminalRunState(terminal)).toBe(true);

          // A tool settling after cancel is a normal race: dropped and counted,
          // never thrown, never emitted.
          after.forEach((emit, i) => apply(h, emit, i));
          expect(h.framing.lastSeq).toBe(before.length + 1);
          expect(h.framing.droppedAfterClose).toBe(after.length);
          expect(h.sink.appended).toHaveLength(before.length + 1);
        },
      ),
      RUNS,
    );
  });

  it("frames every emission as exactly one SSE event whose id is its seq", () => {
    fc.assert(
      fc.property(emitSequence, (emits) => {
        const h = harness();
        emits.forEach((emit, i) => apply(h, emit, i));

        h.sink.frames.forEach((frame, i) => {
          const seq = FIRST_SEQ + i;
          const prefix = `id: ${seq}\ndata: `;
          expect(frame.startsWith(prefix)).toBe(true);
          expect(frame.endsWith("\n\n")).toBe(true);
          // Exactly two lines: a raw newline in the payload would split one
          // event into two, and the second would parse as neither id nor data.
          expect(frame.slice(0, -2).split("\n")).toHaveLength(2);

          const parsed = JSON.parse(frame.slice(prefix.length, -2)) as OutboundChunk;
          expect(typeof parsed.type).toBe("string");
          if (isZocDataChunk(parsed)) expect(parsed.data.seq).toBe(seq);
        });
      }),
      RUNS,
    );
  });

  it("round-trips any chunk through its own frame encoder", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.string(),
        fc.string({ minLength: 1, maxLength: 8 }),
        (seq, delta, id) => {
          const chunk: OutboundChunk = { type: "text-delta", id, delta };
          const frame = encodeSseFrame(seq, chunk);
          const lines = frame.slice(0, -2).split("\n");
          expect(lines).toHaveLength(2);
          expect(lines[0]).toBe(`id: ${seq}`);
          expect(JSON.parse((lines[1] as string).slice("data: ".length))).toEqual(chunk);
        },
      ),
      RUNS,
    );
  });
});

describe("provider-executed tool refusals", () => {
  it("emits exactly one permission_denied tool error for a denied web search", () => {
    const h = harness();

    h.writer.providerToolError({
      toolName: "web_search",
      kind: "network",
      code: "permission_denied",
      message: "Web search is blocked because permission mode is set to deny.",
      retryable: false,
    });

    const chunks = h.sink.appended.map((entry) => entry.chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      type: "tool-input-available",
      toolName: "web_search",
      providerExecuted: true,
      providerMetadata: { zoc: { kind: "network" } },
    });
    expect(chunks.filter((chunk) => chunk.type === "tool-output-error")).toEqual([
      expect.objectContaining({
        type: "tool-output-error",
        errorText: "Web search is blocked because permission mode is set to deny.",
        providerExecuted: true,
        providerMetadata: {
          zoc: {
            kind: "network",
            code: "permission_denied",
            retryable: false,
            details: null,
          },
        },
      }),
    ]);
  });
});

describe("SequenceAllocator", () => {
  it("starts at FIRST_SEQ and increments by exactly one", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_000 }), (count) => {
        const allocator = new SequenceAllocator();
        expect(allocator.last).toBe(FIRST_SEQ - 1);
        expect(allocator.count).toBe(0);

        const drawn: number[] = [];
        for (let i = 0; i < count; i += 1) drawn.push(allocator.next());

        expect(drawn[0]).toBe(FIRST_SEQ);
        expect(drawn.at(-1)).toBe(count);
        expect(allocator.count).toBe(count);
        for (let i = 1; i < drawn.length; i += 1) {
          expect((drawn[i] as number) - (drawn[i - 1] as number)).toBe(1);
        }
      }),
      { numRuns: 60 },
    );
  });
});
