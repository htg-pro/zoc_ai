/**
 * Compaction unit tests — zoc-agent-chat-rebuild R34.1, R34.2, R34.4, R34.5, R34.8, R34.9.
 * Task 9.5's four guards, plus the surrounding contract:
 *
 * - the trigger fires at 85 percent and not at 84;
 * - the newest `RETAINED_TURN_FLOOR` turns survive every fold, including the case
 *   where those turns alone are over the threshold and the module must decline
 *   rather than breach the floor;
 * - the pin resolves from the newest `CompactionPart` after two successive folds;
 * - a summariser failure leaves the stored message list byte-identical.
 *
 * Token arithmetic is exact here rather than approximate: every fixture's text is a
 * multiple of `CHARS_PER_TOKEN`, so a threshold assertion is a statement about the
 * boundary and not about a rounding artefact.
 */

import { describe, expect, it, vi } from "vitest";
import type { CompactionPart } from "@zoc-studio/shared-types";

import {
  CHARS_PER_TOKEN,
  COMPACTION_THRESHOLD,
  RETAINED_TURN_FLOOR,
  SUMMARY_BUDGET_FRACTION,
  SUMMARY_TOKEN_BUDGET,
  type AssembledRequest,
  type CompactionPin,
  type CompactionWriter,
  type HistoryMessage,
  type Summarise,
  type SummariseInput,
  applyFold,
  censusOf,
  compactIfNeeded,
  compactNow,
  estimateTokens,
  isOverThreshold,
  measure,
  pinFrom,
  selectFold,
  summaryBudgetFor,
  turnsOf,
  viewOf,
} from "../compaction.ts";

/** Text worth exactly `n` tokens under the heuristic. */
const tok = (n: number): string => "x".repeat(n * CHARS_PER_TOKEN);

function req(options: {
  /** Token sizes per message, grouped by turn; the first of each turn is the user message. */
  readonly turns: readonly (readonly number[])[];
  readonly instructions?: number;
  readonly contextLimit?: number;
  readonly pin?: CompactionPin | null;
  readonly sessionMessageCount?: number;
}): AssembledRequest {
  const messages: HistoryMessage[] = [];
  options.turns.forEach((sizes, turn) => {
    sizes.forEach((size, index) => {
      messages.push({
        id: `t${turn}m${index}`,
        role: index === 0 ? "user" : "assistant",
        text: tok(size),
      });
    });
  });
  return {
    instructions: tok(options.instructions ?? 0),
    pin: options.pin ?? null,
    mentions: [],
    toolSchemas: [],
    messages,
    contextLimit: options.contextLimit ?? 100_000,
    sessionMessageCount: options.sessionMessageCount ?? messages.length,
  };
}

function recordingWriter(): { parts: CompactionPart[]; writer: CompactionWriter } {
  const parts: CompactionPart[] = [];
  let seq = 0;
  return {
    parts,
    writer: {
      compaction(payload) {
        seq += 1;
        const part: CompactionPart = {
          ...payload,
          type: "compaction",
          seq,
          runId: "run_1",
          messageId: "msg_1",
          ts: new Date(0).toISOString(),
          agentName: null,
        };
        parts.push(part);
        return part;
      },
    },
  };
}

const summariser = (text = tok(4)): Summarise => vi.fn(async () => ({ text }));

describe("the token estimate", () => {
  it("is zero for empty text and ceilings otherwise", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x")).toBe(1);
    expect(estimateTokens("xxxx")).toBe(1);
    expect(estimateTokens("xxxxx")).toBe(2);
  });

  it("counts the whole request, not just the message text (R34.1)", () => {
    // The reading that matters: 30 KB of rules is 30 KB of context.
    const assembled: AssembledRequest = {
      ...req({ turns: [[10]] }),
      instructions: tok(100),
      mentions: [tok(20), tok(5)],
      toolSchemas: [tok(50)],
    };
    const measured = measure(assembled);
    expect(measured.fixed).toBe(175);
    expect(measured.total).toBe(185);
  });

  it("counts the pinned summary once, on the pin", () => {
    const pin: CompactionPin = { compactionId: "c1", summary: tok(40), foldedMessageIds: ["old"] };
    const measured = measure(req({ turns: [[10]], pin }));
    expect(measured.pin).toBe(40);
    expect(measured.total).toBe(50);
  });
});

describe("the trigger (R34.1)", () => {
  const limit = 1000; // threshold 850, target 750

  it("fires at 85 percent and not at 84", () => {
    expect(isOverThreshold(measure(req({ turns: [[850]], contextLimit: limit })))).toBe(true);
    expect(isOverThreshold(measure(req({ turns: [[840]], contextLimit: limit })))).toBe(false);
    // One token below the boundary is still below it.
    expect(isOverThreshold(measure(req({ turns: [[849]], contextLimit: limit })))).toBe(false);
  });

  it("derives the boundary from the configured fraction rather than a literal", () => {
    const measured = measure(req({ turns: [[1]], contextLimit: limit }));
    expect(measured.threshold).toBe(Math.floor(limit * COMPACTION_THRESHOLD));
    expect(measured.target).toBeLessThan(measured.threshold);
  });

  it("does not fire on a request with no context limit", () => {
    expect(isOverThreshold(measure(req({ turns: [[999]], contextLimit: 0 })))).toBe(false);
  });

  it("leaves an under-threshold request alone and reports the census", async () => {
    const { writer, parts } = recordingWriter();
    const outcome = await compactIfNeeded(
      { writer, summarise: summariser() },
      "s1",
      req({ turns: [[10], [10], [10], [10], [10], [10]], contextLimit: limit }),
    );
    expect(outcome.kind).toBe("not-needed");
    expect(parts).toEqual([]);
    expect(outcome.census?.messagesInContext).toBe(6);
  });
});

describe("turn grouping", () => {
  it("groups a user message with everything that answered it", () => {
    const assembled = req({
      turns: [
        [10, 5, 5],
        [10, 20],
      ],
    });
    const turns = turnsOf(assembled.messages, measure(assembled).messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ start: 0, tokens: 20 });
    expect(turns[0]?.messageIds).toEqual(["t0m0", "t0m1", "t0m2"]);
    expect(turns[1]).toMatchObject({ start: 3, tokens: 30 });
  });

  it("does not treat a leading system message as a turn", () => {
    // The pinned summary is prepended as a system message at dispatch, and it must
    // never become the first fold candidate.
    const messages: HistoryMessage[] = [
      { id: "sum", role: "system", text: tok(50) },
      { id: "u0", role: "user", text: tok(10) },
    ];
    const turns = turnsOf(messages, [50, 10]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.messageIds).toEqual(["u0"]);
  });
});

describe("the retained floor (R34.2)", () => {
  const limit = 1000;

  it("never folds the newest RETAINED_TURN_FLOOR turns", async () => {
    const { writer, parts } = recordingWriter();
    // Eight turns of 110 tokens: 880 total, over the 850 threshold.
    const assembled = req({
      turns: Array.from({ length: 8 }, () => [110] as const),
      contextLimit: limit,
    });

    const outcome = await compactIfNeeded({ writer, summarise: summariser() }, "s1", assembled);
    expect(outcome.kind).toBe("folded");

    const folded = new Set(parts[0]?.foldedMessageIds);
    const retained = assembled.messages.slice(-RETAINED_TURN_FLOOR);
    for (const message of retained) expect(folded.has(message.id)).toBe(false);
    // And the surviving request still carries them.
    expect(outcome.request?.messages.map((m) => m.id)).toEqual(
      expect.arrayContaining(retained.map((m) => m.id)),
    );
  });

  it("declines rather than breaching the floor when the floor alone is over the threshold", async () => {
    const { writer, parts } = recordingWriter();
    const summarise = summariser();
    // Four turns at 300 each — the floor alone is 1200 against a 850 threshold.
    const assembled = req({
      turns: Array.from({ length: 6 }, () => [300] as const),
      contextLimit: limit,
    });

    const outcome = await compactIfNeeded({ writer, summarise }, "s1", assembled);
    expect(outcome.kind).toBe("insufficient-history");
    // No provider call, and no record: the honest outcome is the provider's own
    // context_window_exceeded, not a fold that destroys the question.
    expect(summarise).not.toHaveBeenCalled();
    expect(parts).toEqual([]);
  });

  it("declines when the whole conversation fits inside the floor", () => {
    const assembled = req({
      turns: Array.from({ length: RETAINED_TURN_FLOOR }, () => [500] as const),
      contextLimit: limit,
    });
    expect(selectFold(assembled, measure(assembled), { requireReduction: true })).toBeNull();
  });

  it("stops as soon as the projection clears the target rather than folding everything", () => {
    // Twelve small turns over the threshold: a couple of folds is enough, and
    // over-folding costs detail for no benefit.
    const assembled = req({
      turns: Array.from({ length: 12 }, () => [80] as const),
      contextLimit: 1100,
    });
    const measured = measure(assembled);
    const plan = selectFold(assembled, measured, { requireReduction: true });
    expect(plan).not.toBeNull();
    expect(plan?.foldedTurnCount).toBeLessThan(12 - RETAINED_TURN_FLOOR);
    expect(plan?.projected).toBeLessThanOrEqual(measured.target);
  });
});

describe("the pin (R34.3, R34.6)", () => {
  const part = (over: Partial<CompactionPart>): CompactionPart => ({
    type: "compaction",
    seq: 1,
    runId: "run_1",
    messageId: "msg_1",
    ts: new Date(0).toISOString(),
    compactionId: "c1",
    foldedMessageIds: ["a"],
    foldedTurnCount: 1,
    contextTokensBefore: 100,
    contextTokensAfter: 10,
    summary: "first",
    ...over,
  });

  it("is null for a Session that has never compacted", () => {
    expect(pinFrom([])).toBeNull();
  });

  it("resolves from the newest CompactionPart after two successive folds", () => {
    const first = part({ seq: 4, compactionId: "c1", summary: "first" });
    const second = part({
      seq: 9,
      compactionId: "c2",
      summary: "second",
      foldedMessageIds: ["a", "b"],
    });

    // Deliberately out of order: "newest" is decided by seq, not by array position.
    const pin = pinFrom([second, first]);
    expect(pin).toEqual({
      compactionId: "c2",
      summary: "second",
      foldedMessageIds: ["a", "b"],
    });
  });

  it("drops the folded messages and prepends the summary at dispatch", () => {
    const stored: HistoryMessage[] = [
      { id: "a", role: "user", text: "old question" },
      { id: "b", role: "assistant", text: "old answer" },
      { id: "c", role: "user", text: "new question" },
    ];
    const view = viewOf(stored, {
      compactionId: "c2",
      summary: "they discussed the old thing",
      foldedMessageIds: ["a", "b"],
    });

    expect(view.map((m) => m.id)).toEqual(["c2:summary", "c"]);
    expect(view[0]?.role).toBe("system");
    // Stored history itself is untouched: compaction changes what the model sees,
    // not what the Session contains.
    expect(stored).toHaveLength(3);
  });

  it("returns stored history unchanged when there is no pin", () => {
    const stored: HistoryMessage[] = [{ id: "a", role: "user", text: "q" }];
    expect(viewOf(stored, null)).toBe(stored);
  });
});

describe("the summary budget", () => {
  it("is the flat ceiling on a large window and a fraction of a small one", () => {
    // A flat 1024 against a 1000-token window would price every fold as a net
    // loss, so the module would decline on exactly the models that need it.
    expect(summaryBudgetFor(200_000)).toBe(SUMMARY_TOKEN_BUDGET);
    expect(summaryBudgetFor(1000)).toBe(Math.floor(1000 * SUMMARY_BUDGET_FRACTION));
    expect(summaryBudgetFor(0)).toBe(1);
  });
});

/** A summariser that records what it was asked, so the inputs can be asserted. */
function recordingSummariser(text: string): {
  readonly calls: SummariseInput[];
  readonly summarise: Summarise;
} {
  const calls: SummariseInput[] = [];
  return {
    calls,
    summarise: async (input) => {
      calls.push(input);
      return { text };
    },
  };
}

describe("two successive folds (R34.3, R34.6)", () => {
  const limit = 1000; // threshold 850, target 750, summary budget 50

  it("unions the folded ids, replaces the pin, and keeps both records", async () => {
    const { writer, parts } = recordingWriter();
    const first = recordingSummariser(tok(4));
    // Eight turns of 110: 880 tokens against a 850 threshold.
    const assembled = req({
      turns: Array.from({ length: 8 }, () => [110] as const),
      contextLimit: limit,
    });

    const one = await compactIfNeeded(
      { writer, summarise: first.summarise, newCompactionId: () => "c1" },
      "s1",
      assembled,
    );

    expect(one.kind).toBe("folded");
    expect(one.record).toMatchObject({
      compactionId: "c1",
      foldedTurnCount: 2,
      foldedMessageIds: ["t0m0", "t1m0"],
      contextTokensBefore: 880,
      contextTokensAfter: 664,
    });
    expect(first.calls[0]?.previousSummary).toBeNull();
    expect(first.calls[0]?.messages.map((m) => m.id)).toEqual(["t0m0", "t1m0"]);
    expect(first.calls[0]?.maxTokens).toBe(measure(assembled).summaryBudget);

    const afterOne = one.request;
    if (afterOne === undefined) throw new Error("a fold must return the rewritten request");
    // 664 tokens is comfortably under the threshold, so the second fold is the
    // manual one — which is the realistic sequence, not a contrivance.
    expect(isOverThreshold(measure(afterOne))).toBe(false);

    const second = recordingSummariser(tok(5));
    const two = await compactNow(
      { writer, summarise: second.summarise, newCompactionId: () => "c2" },
      "s1",
      afterOne,
    );

    expect(two.record).toMatchObject({
      compactionId: "c2",
      foldedTurnCount: 2,
      // The union with the previous record's ids: that is what keeps pin
      // derivation a read of one part rather than a fold over all of them.
      foldedMessageIds: ["t0m0", "t1m0", "t2m0", "t3m0"],
      contextTokensBefore: 664,
      contextTokensAfter: 445,
    });
    // The superseded summary is input to the new one, not text to carry forward.
    expect(second.calls[0]?.previousSummary).toBe(tok(4));
    // And only the newly folded turns are summarised: the rest already left.
    expect(second.calls[0]?.messages.map((m) => m.id)).toEqual(["t2m0", "t3m0"]);

    // The pin is replaced; the record accumulates.
    expect(parts.map((part) => part.compactionId)).toEqual(["c1", "c2"]);
    expect(pinFrom(parts)).toEqual({
      compactionId: "c2",
      summary: tok(5),
      foldedMessageIds: ["t0m0", "t1m0", "t2m0", "t3m0"],
    });

    // Derivation and dispatch agree: rebuilding the view from the stored parts
    // over untouched stored history yields the request the second fold produced.
    expect(viewOf(assembled.messages, pinFrom(parts)).map((m) => m.id)).toEqual([
      "c2:summary",
      "t4m0",
      "t5m0",
      "t6m0",
      "t7m0",
    ]);
    expect(two.census).toEqual({
      messagesInContext: 4,
      sessionMessageCount: 8,
      messagesOutOfWindow: 4,
      summaryActive: true,
    });
  });
});

describe("a failed summariser (R34.9)", () => {
  /** Eight turns of 110 against a 850 threshold: a fold is due, and 220 tokens of it. */
  const overThreshold = (): AssembledRequest =>
    req({ turns: Array.from({ length: 8 }, () => [110] as const), contextLimit: 1000 });

  async function failsWith(summarise: Summarise): Promise<{
    readonly outcome: Awaited<ReturnType<typeof compactIfNeeded>>;
    readonly parts: CompactionPart[];
    readonly messagesUnchanged: boolean;
  }> {
    const { writer, parts } = recordingWriter();
    const assembled = overThreshold();
    const before = JSON.stringify(assembled.messages);
    const outcome = await compactIfNeeded({ writer, summarise }, "s1", assembled);
    return { outcome, parts, messagesUnchanged: JSON.stringify(assembled.messages) === before };
  }

  it("reports compaction_failed and leaves the stored messages byte-identical", async () => {
    const { outcome, parts, messagesUnchanged } = await failsWith(async () => {
      throw new Error("the provider refused");
    });

    expect(outcome.kind).toBe("failed");
    expect(outcome.error).toEqual({
      code: "compaction_failed",
      message: "the provider refused",
      retryable: true,
    });
    // No record, so no pin, so the next Run assembles exactly this context. There
    // is no rollback path here because there is no state to roll back.
    expect(parts).toEqual([]);
    expect(outcome.record).toBeUndefined();
    expect(outcome.request).toBeUndefined();
    expect(messagesUnchanged).toBe(true);
  });

  it("treats a whitespace-only summary as a failure, not an empty fold", async () => {
    // A record whose summary says nothing would pin the context to nothing and
    // silently delete the folded turns from what the model sees.
    const { outcome, parts } = await failsWith(async () => ({ text: "   \n\t " }));
    expect(outcome.kind).toBe("failed");
    expect(outcome.error?.message).toContain("empty");
    expect(parts).toEqual([]);
  });

  it("refuses a summary larger than the turns it replaced", async () => {
    // 300 tokens of summary against 220 tokens of folded turns. The wire model's
    // own validator refuses this, and refusing here makes it a reported failure
    // rather than a throw from inside the writer.
    const { outcome, parts } = await failsWith(async () => ({ text: tok(300) }));
    expect(outcome.kind).toBe("failed");
    expect(outcome.error?.message).toContain("larger");
    expect(parts).toEqual([]);
  });

  it("still gives a usable message when the failure carries none", async () => {
    const { outcome } = await failsWith(async () => {
      throw new Error("");
    });
    expect(outcome.error?.message).toBe("The summary could not be produced.");
  });
});

describe("the compact-now control (R34.4, R34.5)", () => {
  it("folds a comfortably small conversation because the user asked", async () => {
    const { writer, parts } = recordingWriter();
    const assembled = req({
      turns: Array.from({ length: 10 }, () => [10] as const),
      contextLimit: 100_000,
    });
    expect(isOverThreshold(measure(assembled))).toBe(false);

    const outcome = await compactNow({ writer, summarise: summariser(tok(1)) }, "s1", assembled);

    expect(outcome.kind).toBe("folded");
    // Everything outside the floor, not the minimum that would clear a threshold:
    // there is no threshold to clear, and "reclaim context" is what the control
    // promises.
    expect(outcome.record?.foldedTurnCount).toBe(10 - RETAINED_TURN_FLOOR);
    expect(parts).toHaveLength(1);
    expect(outcome.census).toEqual({
      messagesInContext: RETAINED_TURN_FLOOR,
      sessionMessageCount: 10,
      messagesOutOfWindow: 10 - RETAINED_TURN_FLOOR,
      summaryActive: true,
    });
  });

  it("declines without calling the summariser when the floor is the conversation", async () => {
    const { writer, parts } = recordingWriter();
    const summarise = summariser();
    const outcome = await compactNow(
      { writer, summarise },
      "s1",
      req({ turns: Array.from({ length: RETAINED_TURN_FLOOR }, () => [10] as const) }),
    );

    // The route turns this into 409 compaction_not_needed.
    expect(outcome.kind).toBe("not-needed");
    expect(summarise).not.toHaveBeenCalled();
    expect(parts).toEqual([]);
  });

  it("reports the summarisation's own usage so the Session total stays right (R27.2)", async () => {
    const { writer } = recordingWriter();
    const usage = { inputTokens: 400, outputTokens: 30 };
    const outcome = await compactNow(
      { writer, summarise: async () => ({ text: "folded", usage }) },
      "s1",
      req({ turns: Array.from({ length: 6 }, () => [10] as const) }),
    );
    expect(outcome.usage).toEqual(usage);
  });
});

describe("the request rewrite", () => {
  it("drops the folded messages without touching the caller's request", () => {
    const assembled = req({
      turns: Array.from({ length: 5 }, () => [10] as const),
      sessionMessageCount: 20,
    });
    const plan = selectFold(assembled, measure(assembled), { requireReduction: false });
    if (plan === null) throw new Error("five turns leave one foldable turn");

    const pin: CompactionPin = {
      compactionId: "c1",
      summary: "a summary",
      foldedMessageIds: ["t0m0"],
    };
    const rewritten = applyFold(assembled, plan, pin);

    expect(rewritten).not.toBe(assembled);
    expect(assembled.messages).toHaveLength(5);
    expect(rewritten.messages.map((m) => m.id)).toEqual(["t1m0", "t2m0", "t3m0", "t4m0"]);
    expect(rewritten.pin).toBe(pin);
    // The messages left this request, not the Session — which is what keeps the
    // census able to report how many sit outside the window.
    expect(rewritten.sessionMessageCount).toBe(20);
  });

  it("never reports a negative count outside the window", () => {
    // A caller that has not counted stored history undercounts; "minus three
    // messages outside the window" would read as a broken product.
    expect(censusOf(req({ turns: [[10], [10], [10]], sessionMessageCount: 0 }))).toEqual({
      messagesInContext: 3,
      sessionMessageCount: 3,
      messagesOutOfWindow: 0,
      summaryActive: false,
    });
  });

  it("reports the summary as active only when the pin carries text", () => {
    const pin: CompactionPin = { compactionId: "c1", summary: "", foldedMessageIds: ["x"] };
    expect(censusOf(req({ turns: [[10]] })).summaryActive).toBe(false);
    expect(censusOf(req({ turns: [[10]], pin })).summaryActive).toBe(false);
    expect(censusOf(req({ turns: [[10]], pin: { ...pin, summary: "text" } })).summaryActive).toBe(
      true,
    );
  });
});
