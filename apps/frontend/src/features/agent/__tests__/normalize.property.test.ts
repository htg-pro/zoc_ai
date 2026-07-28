// Feature: zoc-ai-agent-chat-overhaul, Property 21: Normalization is total and maps intent events to metadata
// Feature: zoc-ai-agent-chat-overhaul, Property 22: Stage markers are classified as internal frames
// Feature: zoc-ai-agent-chat-overhaul, Property 23: Token events coalesce into one row per derived message identity
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type FeedRow,
  type FeedRowKind,
  type NormalizeContext,
  assistantMessageId,
  isDiscard,
  normalizeEvent,
  normalizeEvents,
} from "../normalize";
import { SYNTHETIC_STAGE_PREFIX } from "../stage-markers";

const FEED_ROW_KINDS: ReadonlySet<FeedRowKind> = new Set<FeedRowKind>([
  "user-message",
  "assistant-message",
  "reasoning",
  "run-metadata",
  "stage",
  "tool-call",
  "tool-group",
  "diff",
  "command",
  "approval",
  "plan-ready",
  "run-summary",
  "error",
  "follow-ups",
]);

const KNOWN_TYPES = [
  "token",
  "intent",
  "thinking",
  "plan",
  "plan-update",
  "plan-ready",
  "map-files",
  "read-files",
  "context-compressed",
  "edit-file",
  "command",
  "review",
  "summary",
  "approval",
  "permission",
  "recovery-attempt",
  "budget",
  "test-results",
  "stage",
  "done",
  "error",
];

const baseCtx: NormalizeContext = {
  activeRunId: null,
  boundMessageId: null,
  highestSeq: Number.MIN_SAFE_INTEGER,
};

describe("normalizeEvent — totality (Property 21)", () => {
  it("returns exactly one renderable row or an explicit discard for any input, never throwing", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = normalizeEvent(value, baseCtx);
        if (isDiscard(result)) {
          expect(result.discarded).toBe(true);
          return;
        }
        // A row always carries a kind with a defined renderer.
        expect(FEED_ROW_KINDS.has(result.kind)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("discards an unrecognized type and records that type for diagnostics", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !KNOWN_TYPES.includes(s)),
        fc.integer(),
        fc.string({ minLength: 1 }),
        (type, seq, runId) => {
          const result = normalizeEvent({ type, seq, runId }, baseCtx);
          expect(isDiscard(result)).toBe(true);
          if (isDiscard(result)) {
            expect(result.reason).toBe("unknown-type");
            expect(result.rawType).toBe(type);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("maps an intent event to run-metadata, never an assistant message", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.string({ minLength: 1 }),
        fc.constantFrom("local-slm", "edge", "cloud"),
        fc.nat({ max: 2_000_000 }),
        fc.option(fc.string(), { nil: null }),
        (seq, runId, modelTier, contextWindowTokens, fallbackReason) => {
          const result = normalizeEvent(
            {
              type: "intent",
              seq,
              runId,
              ts: "t",
              text: "the prompt",
              modelTier,
              contextWindowTokens,
              fallbackReason,
            },
            { ...baseCtx, activeRunId: runId },
          );
          expect(isDiscard(result)).toBe(false);
          if (!isDiscard(result)) {
            expect(result.kind).toBe("run-metadata");
            if (result.kind === "run-metadata") {
              expect(result.modelTier).toBe(modelTier);
              expect(result.contextWindowTokens).toBe(contextWindowTokens);
              expect(result.fallbackReason).toBe(fallbackReason);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("stage-marker classification (Property 22)", () => {
  it("discards a command that begins with the stage-marker prefix as an internal frame", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), fc.string({ minLength: 1 }), (stage, seq, runId) => {
        const command = `${SYNTHETIC_STAGE_PREFIX}${stage}>`;
        const result = normalizeEvent(
          { type: "command", seq, runId, ts: "t", command },
          { ...baseCtx, activeRunId: runId },
        );
        expect(isDiscard(result)).toBe(true);
        if (isDiscard(result)) expect(result.reason).toBe("internal-frame");
      }),
      { numRuns: 200 },
    );
  });

  it("renders a command that only mentions the prefix later in the string", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer(), fc.string({ minLength: 1 }), (stage, seq, runId) => {
        const command = `echo '${SYNTHETIC_STAGE_PREFIX}${stage}>'`;
        const result = normalizeEvent(
          { type: "command", seq, runId, ts: "t", command },
          { ...baseCtx, activeRunId: runId },
        );
        expect(isDiscard(result)).toBe(false);
        if (!isDiscard(result)) expect(result.kind).toBe("tool-call");
      }),
      { numRuns: 200 },
    );
  });
});

describe("token coalescing (Property 23)", () => {
  it("produces one assistant row per derived identity with ordered concatenated text, idempotently", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            runId: fc.constantFrom("run-a", "run-b", "run-c"),
            text: fc.string(),
          }),
          { maxLength: 40 },
        ),
        (tokens) => {
          const events = tokens.map((t, index) => ({
            type: "token",
            seq: index,
            runId: t.runId,
            ts: "t",
            text: t.text,
          }));
          const ctx: NormalizeContext = {
            activeRunId: null,
            boundMessageId: "msg-1",
            highestSeq: -1,
          };
          const { rows } = normalizeEvents(events, ctx);
          const assistantRows = rows.filter(
            (r): r is Extract<FeedRow, { kind: "assistant-message" }> =>
              r.kind === "assistant-message",
          );

          // One row per distinct runId that produced a token.
          const runsSeen = new Set(tokens.map((t) => t.runId));
          expect(assistantRows.length).toBe(runsSeen.size);

          for (const runId of runsSeen) {
            const expected = tokens
              .filter((t) => t.runId === runId)
              .map((t) => t.text)
              .join("");
            const id = assistantMessageId(runId, "msg-1");
            const row = assistantRows.find((r) => r.messageId === id);
            expect(row).toBeDefined();
            expect(row?.text).toBe(expected);
          }

          // Idempotent: same events + ctx yield identical row ids.
          const second = normalizeEvents(events, ctx).rows;
          expect(second.map((r) => r.id)).toEqual(rows.map((r) => r.id));
        },
      ),
      { numRuns: 150 },
    );
  });
});


describe("historical provider-error sanitization", () => {
  it("never exposes raw llama.cpp context-overflow JSON in an error row", () => {
    const result = normalizeEvent(
      {
        type: "error",
        seq: 7,
        runId: "run-context",
        code: "run_failed",
        operation: "command",
        message:
          'http 400: {"type":"exceed_context_size_error","n_prompt_tokens":9444,"n_ctx":8192}',
        retryable: true,
      },
      { ...baseCtx, activeRunId: "run-context" },
    );

    expect(isDiscard(result)).toBe(false);
    if (!isDiscard(result) && result.kind === "error") {
      expect(result.code).toBe("context_window_exceeded");
      expect(result.message).toContain("Reduce attached context");
      expect(result.message).not.toContain("exceed_context_size_error");
      expect(result.message).not.toContain("{");
    }
  });
});
