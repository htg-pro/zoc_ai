/**
 * Property 79: A compaction reduces context and never folds the retained floor.
 * Property 80: A failed compaction leaves stored history unchanged.
 * Validates R34.1, R34.2, R34.9.
 *
 * Feature: zoc-agent-chat-rebuild, Property 79 (R34.1, R34.2, R34.9).
 *
 * Property 79 runs at 200 iterations rather than the default 100 because every bug
 * it can catch is an off-by-one at the retained-turn floor, and the draws that
 * expose one — a conversation with exactly `RETAINED_TURN_FLOOR + 1` turns, a floor
 * that alone exceeds the threshold — are a thin band of the input space.
 *
 * Property 80 **injects** the summariser failure rather than causing one. R34.9's
 * guarantee is about ordering inside this module, not about how any particular
 * provider fails, and a property that needed a real provider to fail would need
 * the network to run.
 *
 * **Neither property needs a message store.** The plan's note about a temp
 * directory anticipated a runtime-side store; stored history actually lives on
 * Workspace_Services behind the `messages` capability (R6.3), and a failed
 * compaction produces no `CompactionPart` at all — so there is nothing to persist
 * and no write to observe. Asserting that no record is emitted checks the
 * invariant at the boundary where the write would originate, which is a stronger
 * statement than inspecting a directory afterwards.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CompactionPart } from "@zoc-studio/shared-types";

import {
  CHARS_PER_TOKEN,
  COMPACTION_THRESHOLD,
  RETAINED_TURN_FLOOR,
  type AssembledRequest,
  type CompactionWriter,
  type HistoryMessage,
  type Summarise,
  compactIfNeeded,
  compactNow,
  isOverThreshold,
  measure,
  pinFrom,
  turnsOf,
  viewOf,
} from "../compaction.ts";

/** Property 79 joins the 200-iteration set; Property 80 runs at the default. */
const RUNS_79 = { numRuns: 200 } as const;
const RUNS_80 = { numRuns: 100 } as const;

const tok = (n: number): string => "x".repeat(n * CHARS_PER_TOKEN);

/** The conversation and the fixed request cost, before a window is chosen for it. */
interface Shape {
  /** Token sizes per message, grouped by turn; the first of each turn is the user's. */
  readonly turns: readonly (readonly number[])[];
  readonly instructions: number;
  readonly mentions: readonly number[];
  readonly toolSchemas: readonly number[];
  /** The pinned summary's size, or null for a Session that has never compacted. */
  readonly pinTokens: number | null;
}

interface Scenario extends Shape {
  readonly contextLimit: number;
}

/** A turn: a user message plus up to three things that answered it. */
const turn = fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 4 });

/**
 * Turn counts weighted toward the retained floor.
 *
 * A uniform length draw visits the boundary case — one turn more than the floor,
 * so exactly one turn is foldable — about once in fifteen, and after the
 * threshold filter that is one or two cases in two hundred. Weighting the draw
 * puts the case this property exists for inside the sample rather than adjacent
 * to it.
 */
const turnsWith = (minTurns: number): fc.Arbitrary<readonly (readonly number[])[]> =>
  fc
    .oneof(
      {
        weight: 3,
        arbitrary: fc.integer({
          min: Math.max(minTurns, RETAINED_TURN_FLOOR),
          max: RETAINED_TURN_FLOOR + 3,
        }),
      },
      { weight: 2, arbitrary: fc.integer({ min: minTurns, max: 14 }) },
    )
    .chain((length) => fc.array(turn, { minLength: length, maxLength: length }));

const shapeWith = (minTurns: number): fc.Arbitrary<Shape> =>
  fc.record({
    turns: turnsWith(minTurns),
    // The fixed cost matters: R34.1's numerator is the whole request, so a draw
    // with heavy instructions is a draw where the trigger fires on fewer turns.
    instructions: fc.integer({ min: 0, max: 80 }),
    mentions: fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 3 }),
    toolSchemas: fc.array(fc.integer({ min: 1, max: 30 }), { maxLength: 2 }),
    pinTokens: fc.option(fc.integer({ min: 1, max: 80 }), { nil: null }),
  });

/**
 * Draw the window *from* the conversation rather than independently of it.
 *
 * An independent `contextLimit` looks like the more honest generator and is the
 * one that makes this property vacuous: the drawn token mass and the drawn window
 * are uncorrelated, so nearly every case lands comfortably under the trigger and
 * the fold branch — the branch with the floor arithmetic in it — is visited a
 * handful of times in two hundred. Choosing the window so the request sits at
 * `pressure` percent of the trigger puts the boundary itself in the input space,
 * which is where R34.2's off-by-one lives.
 *
 * The range spans all three outcomes: under 100 is under the trigger, a little
 * over folds, and far enough over that folding everything foldable still would
 * not clear the threshold is `insufficient-history`.
 */
const scenarioWith = (minTurns: number): fc.Arbitrary<Scenario> =>
  fc.tuple(shapeWith(minTurns), fc.integer({ min: 55, max: 140 })).map(([shape, pressure]) => {
    const mass = measure(build({ ...shape, contextLimit: 0 })).total;
    const threshold = Math.max(1, Math.round((mass * 100) / pressure));
    return { ...shape, contextLimit: Math.max(1, Math.ceil(threshold / COMPACTION_THRESHOLD)) };
  });

function build(scenario: Scenario): AssembledRequest {
  const messages: HistoryMessage[] = [];
  scenario.turns.forEach((sizes, index) => {
    sizes.forEach((size, offset) => {
      messages.push({
        id: `t${index}m${offset}`,
        role: offset === 0 ? "user" : "assistant",
        text: tok(size),
      });
    });
  });
  return {
    instructions: tok(scenario.instructions),
    pin:
      scenario.pinTokens === null
        ? null
        : {
            compactionId: "c0",
            summary: tok(scenario.pinTokens),
            // Ids of messages already folded, so no longer in `messages`: a second
            // fold must carry them forward or the pin would un-fold them.
            foldedMessageIds: ["gone0", "gone1"],
          },
    mentions: scenario.mentions.map(tok),
    toolSchemas: scenario.toolSchemas.map(tok),
    messages,
    contextLimit: scenario.contextLimit,
    sessionMessageCount: messages.length + (scenario.pinTokens === null ? 0 : 2),
  };
}

function writerInto(parts: CompactionPart[]): CompactionWriter {
  let seq = 0;
  return {
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
  };
}

function counted(implementation: Summarise): { calls: () => number; summarise: Summarise } {
  let calls = 0;
  return {
    calls: () => calls,
    summarise: async (input) => {
      calls += 1;
      return implementation(input);
    },
  };
}

/**
 * A summariser that spends its budget exactly.
 *
 * The worst case selection priced against, which is what makes the post-fold
 * figure an equality rather than a bound below.
 */
const withinBudget: Summarise = async (input) => ({ text: tok(input.maxTokens) });

describe("Property 79: a compaction reduces context and never folds the retained floor", () => {
  it("holds over arbitrary conversations, folds and declines alike (R34.1, R34.2)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioWith(0), async (drawn) => {
        const assembled = build(drawn);
        const measured = measure(assembled);
        const turns = turnsOf(assembled.messages, measured.messages);
        const foldable = turns.slice(0, Math.max(0, turns.length - RETAINED_TURN_FLOOR));
        const retained = new Set(
          turns.slice(Math.max(0, turns.length - RETAINED_TURN_FLOOR)).flatMap((t) => t.messageIds),
        );

        const parts: CompactionPart[] = [];
        const summariser = counted(withinBudget);
        const outcome = await compactIfNeeded(
          { writer: writerInto(parts), summarise: summariser.summarise },
          "s1",
          assembled,
        );

        // The trigger, and nothing else, decides whether anything happens at all.
        expect(outcome.kind === "not-needed").toBe(!isOverThreshold(measured));
        // A summariser that respects its budget cannot make an automatic fold fail:
        // selection prices the replacement at that budget and declines rather than
        // producing a fold that does not reduce.
        expect(outcome.kind).not.toBe("failed");

        if (outcome.kind !== "folded") {
          expect(parts).toEqual([]);
          expect(summariser.calls()).toBe(0);
          if (outcome.kind === "insufficient-history") {
            // Declining is only correct when nothing foldable would have cleared
            // the threshold. Otherwise this is a fold the module owed the caller.
            const everything = measured.pin + foldable.reduce((sum, t) => sum + t.tokens, 0);
            const bestCase = measured.total - everything + measured.summaryBudget;
            expect(foldable.length === 0 || bestCase > measured.threshold).toBe(true);
          }
          return;
        }

        const { record, request } = outcome;
        expect(record).toBeDefined();
        expect(request).toBeDefined();
        if (record === undefined || request === undefined) return;

        // 1. The floor survives — in the record, and in the request that ships.
        for (const id of record.foldedMessageIds) expect(retained.has(id)).toBe(false);
        for (const id of retained) expect(request.messages.some((m) => m.id === id)).toBe(true);

        // 2. Whole turns, oldest first. Never half of one: a folded tool result
        //    whose call is gone makes the model reason about a conversation that
        //    never happened.
        expect(record.foldedTurnCount).toBeGreaterThan(0);
        expect(record.foldedTurnCount).toBeLessThanOrEqual(foldable.length);
        expect(record.foldedMessageIds).toEqual([
          ...(assembled.pin?.foldedMessageIds ?? []),
          ...turns.slice(0, record.foldedTurnCount).flatMap((t) => t.messageIds),
        ]);

        // 3. It reduces, and it reduces past the trigger it fired on — a fold that
        //    left the request over the threshold would re-trigger immediately.
        expect(record.contextTokensBefore).toBe(measured.total);
        expect(record.contextTokensAfter).toBeLessThanOrEqual(record.contextTokensBefore);
        expect(record.contextTokensAfter).toBeLessThanOrEqual(measured.threshold);

        // 4. The reported figure describes the request the caller will dispatch,
        //    not an estimate of it.
        expect(measure(request).total).toBe(record.contextTokensAfter);

        // 5. Derivation and dispatch agree: rebuilding the view from the stored
        //    record over untouched stored history yields the same messages.
        const view = viewOf(assembled.messages, pinFrom(parts));
        expect(view.slice(1).map((m) => m.id)).toEqual(request.messages.map((m) => m.id));
        expect(view[0]?.role).toBe("system");
      }),
      RUNS_79,
    );
  });

  it("visits the fold, the decline, and the floor boundary often enough to mean something", async () => {
    const tally = { folded: 0, "not-needed": 0, "insufficient-history": 0, failed: 0 };
    let atFloorBoundary = 0;

    await fc.assert(
      fc.asyncProperty(scenarioWith(0), async (drawn) => {
        const assembled = build(drawn);
        const outcome = await compactIfNeeded(
          { writer: writerInto([]), summarise: withinBudget },
          "s1",
          assembled,
        );
        tally[outcome.kind] += 1;
        const turns = turnsOf(assembled.messages, measure(assembled).messages).length;
        if (outcome.kind === "folded" && turns === RETAINED_TURN_FLOOR + 1) atFloorBoundary += 1;
      }),
      RUNS_79,
    );

    // The failure mode a property test cannot report about itself: a generator
    // that stops producing folds leaves the property above green while asserting
    // almost nothing. This is the check on the generator, not on the module.
    expect(tally.folded, JSON.stringify(tally)).toBeGreaterThan(20);
    expect(tally["not-needed"], JSON.stringify(tally)).toBeGreaterThan(20);
    expect(tally["insufficient-history"], JSON.stringify(tally)).toBeGreaterThan(0);
    // The one-turn-past-the-floor case, where an off-by-one folds the turn the
    // user is mid-way through.
    expect(atFloorBoundary, `at floor boundary: ${atFloorBoundary}`).toBeGreaterThan(0);
  });
});

/** Every way the summarisation step can fail, as this module can observe them. */
const FAILURE_MODES = [
  "throws",
  "throws-without-message",
  "aborted",
  "empty",
  "whitespace",
  "oversized",
] as const;

type FailureMode = (typeof FAILURE_MODES)[number];

function failing(mode: FailureMode, contextTokens: number): Summarise {
  return async () => {
    switch (mode) {
      case "throws":
        throw new Error("the provider refused");
      case "throws-without-message":
        throw new Error("");
      case "aborted":
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      case "empty":
        return { text: "" };
      case "whitespace":
        return { text: " \n\t " };
      case "oversized":
        // Larger than the whole request, so larger than anything it replaced.
        return { text: tok(contextTokens * 2 + 1) };
    }
  };
}

describe("Property 80: a failed compaction leaves stored history unchanged", () => {
  it("holds for every failure mode, on both the automatic and manual paths (R34.9)", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioWith(RETAINED_TURN_FLOOR + 1),
        fc.constantFrom(...FAILURE_MODES),
        fc.boolean(),
        async (drawn, mode, manual) => {
          const assembled = build(drawn);
          const before = JSON.stringify(assembled);
          const measuredBefore = measure(assembled);

          const parts: CompactionPart[] = [];
          const summariser = counted(failing(mode, measuredBefore.total));
          const ctx = { writer: writerInto(parts), summarise: summariser.summarise };
          const outcome = manual
            ? await compactNow(ctx, "s1", assembled)
            : await compactIfNeeded(ctx, "s1", assembled);

          // Byte-identical, whatever happened. `AssembledRequest` is immutable so
          // this cannot be a half-rewritten request the caller might dispatch.
          expect(JSON.stringify(assembled)).toBe(before);
          // And nothing was recorded, so there is no pin — the next Run assembles
          // exactly the context this one would have.
          expect(parts).toEqual([]);
          expect(outcome.record).toBeUndefined();
          expect(outcome.request).toBeUndefined();
          expect(measure(assembled)).toEqual(measuredBefore);

          if (summariser.calls() === 0) {
            // The summariser is skipped only when no fold was attempted at all,
            // which on the automatic path means the request was under the trigger.
            expect(outcome.kind === "not-needed" || outcome.kind === "insufficient-history").toBe(
              true,
            );
            return;
          }

          expect(outcome.kind).toBe("failed");
          expect(outcome.error).toMatchObject({ code: "compaction_failed", retryable: true });
          // Reported as a sentence a user can read, never as an empty string that
          // would render as a blank error row.
          expect(outcome.error?.message.length).toBeGreaterThan(0);
        },
      ),
      RUNS_80,
    );
  });

  it("attempts the fold on the manual path for every draw, so no mode goes untested", async () => {
    // Property 80 tolerates a skipped summariser because the automatic path may be
    // under the trigger. This pins that the manual path never is, which is what
    // makes the failure modes above genuinely exercised rather than optionally so.
    await fc.assert(
      fc.asyncProperty(scenarioWith(RETAINED_TURN_FLOOR + 1), async (drawn) => {
        const summariser = counted(failing("throws", 1));
        const outcome = await compactNow(
          { writer: writerInto([]), summarise: summariser.summarise },
          "s1",
          build(drawn),
        );
        expect(summariser.calls()).toBe(1);
        expect(outcome.kind).toBe("failed");
      }),
      RUNS_80,
    );
  });
});
