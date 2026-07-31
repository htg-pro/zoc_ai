/**
 * Properties 27, 29, and 82 — what the context meter promises. R12.5, R12.7, R12.8.
 *
 * **Property 27 — context cost is present and monotonic.** *For any* set of attachments, the cost shown
 * before submission exists, and adding an attachment never lowers it while removing one never raises it.
 *
 * **Property 29 — unresolved mentions are excluded.** *For any* mix of resolved and unresolved chips, the
 * request carries only the resolved ones and the cost counts only the resolved ones — while every chip
 * stays on screen.
 *
 * **Property 82 — the three context facts are present for a Session that has never compacted.** *For any*
 * Session with no fold, the meter states messages-in-context out of the total, messages outside the
 * window, and that no summary is pinned.
 *
 * ## Why monotonicity is the interesting half of Property 27
 *
 * "Present" is easy and would pass for a figure that was simply wrong. Monotonicity is what rules out the
 * plausible bugs: a cost that counted unresolved chips would *drop* when a chip resolved, and one that
 * double-counted the census would rise when an attachment was removed. Both are invisible in a single
 * reading and obvious under a sequence of them.
 *
 * ## Why Property 82's "never compacted" case is worth its own property
 *
 * `summaryActive: false` and "the surface does not know whether a summary is active" render identically if
 * the third fact is omitted when it is false. The property requires all three facts to be *stated*, which
 * is what makes the absence of a summary a fact rather than a gap.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { sessionHistory } from "./arbitraries";
import {
  attachedTokenCost,
  censusSentence,
  contextFigures,
  formatTokens,
  removalCandidates,
  type ContextCensus,
  type ModelReference,
} from "@/features/chat/composer/context-figures";
import { requestableMentions, type ResolvedMention } from "@/features/chat/store";

const RUNS = { numRuns: 200 } as const;

const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

const mention: fc.Arbitrary<ResolvedMention> = fc
  .tuple(
    fc.hexaString({ minLength: 4, maxLength: 8 }),
    fc.integer({ min: 0, max: 40_000 }),
    fc.boolean(),
  )
  .map(([id, estimatedTokens, resolved]) => ({
    id: `m_${id}`,
    kind: "file" as const,
    ref: `src/${id}.ts`,
    estimatedTokens,
    resolved,
  }));

const mentions = fc.uniqueArray(mention, {
  selector: (entry) => entry.id,
  maxLength: 12,
});

function censusOf(overrides: Partial<ContextCensus> = {}): ContextCensus {
  return {
    messagesInContext: 12,
    sessionMessageCount: 40,
    messagesOutOfWindow: 28,
    summaryActive: false,
    consumedTokens: 4_000,
    measuredAgainst: MODEL,
    ...overrides,
  };
}

describe("Feature: zoc-agent-chat-rebuild, Property 27: context cost is present and monotonic", () => {
  it("shows a cost for any set of attachments (R12.5)", () => {
    fc.assert(
      fc.property(mentions, (attached) => {
        const figures = contextFigures({ model: MODEL, census: censusOf(), mentions: attached });
        expect(Number.isFinite(figures.usage.consumed)).toBe(true);
        expect(figures.usage.consumed).toBeGreaterThanOrEqual(0);
        expect(figures.attachedTokens).toBe(attachedTokenCost(attached));
        // A figure the user can read, not a raw integer beside a limit in a different unit.
        expect(formatTokens(figures.usage.consumed).length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("never falls when an attachment is added", () => {
    fc.assert(
      fc.property(mentions, mention, (attached, extra) => {
        fc.pre(!attached.some((entry) => entry.id === extra.id));
        const before = contextFigures({ model: MODEL, census: censusOf(), mentions: attached });
        const after = contextFigures({
          model: MODEL,
          census: censusOf(),
          mentions: [...attached, extra],
        });
        expect(after.usage.consumed).toBeGreaterThanOrEqual(before.usage.consumed);
      }),
      RUNS,
    );
  });

  it("never rises when an attachment is removed", () => {
    fc.assert(
      fc.property(
        mentions.filter((entries) => entries.length > 0),
        fc.nat(),
        (attached, pick) => {
          const index = pick % attached.length;
          const before = contextFigures({ model: MODEL, census: censusOf(), mentions: attached });
          const after = contextFigures({
            model: MODEL,
            census: censusOf(),
            mentions: attached.filter((_, position) => position !== index),
          });
          expect(after.usage.consumed).toBeLessThanOrEqual(before.usage.consumed);
        },
      ),
      RUNS,
    );
  });

  it("orders the removal offer largest first, totally", () => {
    fc.assert(
      fc.property(mentions, (attached) => {
        const ordered = removalCandidates(attached);
        // Resolved only: removing an unresolved chip frees nothing, because it is already out of the
        // request.
        expect(ordered.every((entry) => entry.resolved)).toBe(true);
        for (let index = 1; index < ordered.length; index += 1) {
          const previous = ordered[index - 1];
          const current = ordered[index];
          if (previous === undefined || current === undefined) continue;
          expect(previous.estimatedTokens).toBeGreaterThanOrEqual(current.estimatedTokens);
          // Ties break on id, so the order is total and the dialog's pre-selected row cannot move under
          // the user's cursor between renders.
          if (previous.estimatedTokens === current.estimatedTokens) {
            expect(previous.id.localeCompare(current.id)).toBeLessThan(0);
          }
        }
      }),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 29: unresolved mentions are excluded", () => {
  it("keeps unresolved chips out of the request and out of the cost (R12.7)", () => {
    fc.assert(
      fc.property(mentions, (attached) => {
        const requestable = requestableMentions(attached);
        expect(requestable.every((entry) => entry.resolved)).toBe(true);
        expect(requestable.length).toBe(attached.filter((entry) => entry.resolved).length);

        const figures = contextFigures({ model: MODEL, census: censusOf(), mentions: attached });
        const resolvedCost = attached
          .filter((entry) => entry.resolved)
          .reduce((total, entry) => total + entry.estimatedTokens, 0);
        expect(figures.attachedTokens).toBe(resolvedCost);
      }),
      RUNS,
    );
  });

  it("counts an unresolved chip as free, so resolving one raises the cost", () => {
    fc.assert(
      fc.property(mention.filter((entry) => entry.estimatedTokens > 0), (entry) => {
        // The direction that catches the bug: a cost that counted unresolved chips would *fall* when a
        // chip resolved, which is the opposite of what a user would expect and impossible to notice in a
        // single reading.
        const unresolved = contextFigures({
          model: MODEL,
          census: censusOf(),
          mentions: [{ ...entry, resolved: false }],
        });
        const resolved = contextFigures({
          model: MODEL,
          census: censusOf(),
          mentions: [{ ...entry, resolved: true }],
        });
        expect(resolved.usage.consumed).toBeGreaterThan(unresolved.usage.consumed);
      }),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 82: the three context facts are present for a Session that has never compacted", () => {
  it("states all three facts, and states the absence of a summary (R12.8)", () => {
    fc.assert(
      fc.property(
        sessionHistory.filter((fixture) => fixture.compactions.length === 0),
        (fixture) => {
          const total = fixture.session.messages.length;
          // A window that holds the newest twelve, which is the shape the runtime reports.
          const inContext = Math.min(total, 12);
          const figures = contextFigures({
            model: MODEL,
            census: censusOf({
              messagesInContext: inContext,
              sessionMessageCount: total,
              messagesOutOfWindow: total - inContext,
              summaryActive: false,
            }),
            mentions: [],
          });

          const sentence = censusSentence(figures);
          // Fact one: in context out of the total.
          expect(sentence).toContain(`${String(inContext)} of ${String(total)} messages in context`);
          // Fact two: what falls outside.
          expect(sentence).toContain(`${String(total - inContext)} message`);
          // Fact three, stated rather than omitted: "no summary" and "the surface does not know" are
          // different, and only the first is true here.
          expect(sentence).toContain("no compaction summary");
          expect(figures.census.summaryActive).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("says a summary is pinned when one is", () => {
    const figures = contextFigures({
      model: MODEL,
      census: censusOf({ summaryActive: true }),
      mentions: [],
    });
    expect(censusSentence(figures)).toContain("a compaction summary is pinned");
  });

  it("marks a client-side estimate as one (R12.9)", () => {
    const estimated = contextFigures({
      model: MODEL,
      census: censusOf({ measuredAgainst: null }),
      mentions: [],
    });
    expect(estimated.estimated).toBe(true);
    expect(censusSentence(estimated)).toContain("estimated");

    const reported = contextFigures({ model: MODEL, census: censusOf(), mentions: [] });
    expect(reported.estimated).toBe(false);
    expect(censusSentence(reported)).not.toContain("estimated");
  });
});
