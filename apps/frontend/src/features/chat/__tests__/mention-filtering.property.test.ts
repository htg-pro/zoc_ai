/**
 * Properties 24, 25, and 26 — the mention picker's three claims. R12.2, R12.3, R12.4.
 *
 * **Property 24 — filtering is sound and ordered.** *For any* candidate set and *any* query, every result
 * matches the query under the membership rule the popover promises, results are ordered best-first, and
 * the list is capped at fifty.
 *
 * **Property 25 — insertion round-trips.** *For any* draft with an active `@token` and *any* chosen
 * reference, the reference appears in the draft, the text on either side of the token is untouched, and
 * the popover closes — because the caret is no longer inside a mention.
 *
 * **Property 26 — keyboard navigation stays in range.** *For any* result count and *any* sequence of
 * arrow presses, the selection is a valid index into the list, or `-1` when the list is empty.
 *
 * ## Why soundness needs a rule of its own
 *
 * "Fuzzy matching" (R12.2) is not a specification, and `fuse.js` at a threshold loose enough to be useful
 * for paths returns candidates a user cannot see the connection to. So `mention-index.ts` states the
 * membership rule separately — an ordered case-insensitive subsequence — and Fuse decides only the order.
 * Property 24's first clause is about the rule and its second is about Fuse, which is the only way either
 * can be asserted without asserting against a library's internals.
 *
 * The non-vacuity clause is the one that keeps the pair honest: a filter that returned nothing would be
 * perfectly sound, so the property also requires that an exact prefix of a candidate's label finds it.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  MENTION_CATEGORIES,
  MENTION_RESULT_LIMIT,
  buildMentionIndex,
  clampSelection,
  groupByCategory,
  matchesQuery,
  mentionKindOf,
  nextSelection,
  type MentionCandidate,
} from "@/features/chat/composer/mention-index";
import { applyMention, detectMentionQuery } from "@/features/chat/composer/mention-query";

const RUNS = { numRuns: 200 } as const;

// ── Generators ────────────────────────────────────────────────────────

const segment = fc.stringMatching(/^[a-z]{2,8}$/);

const candidate: fc.Arbitrary<MentionCandidate> = fc
  .tuple(
    fc.array(segment, { minLength: 1, maxLength: 4 }),
    fc.constantFrom(...MENTION_CATEGORIES),
    fc.integer({ min: 0, max: 20_000 }),
    fc.hexaString({ minLength: 4, maxLength: 8 }),
  )
  .map(([segments, category, estimatedTokens, id]) => {
    const ref = `src/${segments.join("/")}.ts`;
    return {
      id: `${category}:${id}`,
      category,
      ref,
      label: `${segments.at(-1) ?? "file"}.ts`,
      detail: `src/${segments.slice(0, -1).join("/")}`,
      estimatedTokens,
    };
  });

/** A candidate set with distinct ids, which is what the popover's keys require. */
const candidates = fc.uniqueArray(candidate, {
  selector: (entry) => entry.id,
  minLength: 1,
  maxLength: 40,
});

describe("Feature: zoc-agent-chat-rebuild, Property 24: mention filtering is sound and ordered", () => {
  it("returns only candidates that match the query, best first, capped at fifty (R12.2)", () => {
    fc.assert(
      fc.property(candidates, fc.stringMatching(/^[a-z]{0,6}$/), (pool, query) => {
        const results = buildMentionIndex(pool).search(query);

        expect(results.length).toBeLessThanOrEqual(MENTION_RESULT_LIMIT);
        for (const result of results) {
          // Soundness: the membership rule, not Fuse's threshold.
          expect(
            matchesQuery(result.candidate, query),
            `${result.candidate.label} does not match ${query}`,
          ).toBe(true);
        }
        // Ordering: Fuse's score is a distance, so best-first is non-decreasing.
        const scores = results.map((result) => result.score);
        for (let index = 1; index < scores.length; index += 1) {
          expect(scores[index]).toBeGreaterThanOrEqual(scores[index - 1] ?? 0);
        }
      }),
      RUNS,
    );
  });

  it("finds a candidate by an exact prefix of its label, so soundness is not vacuous", () => {
    fc.assert(
      fc.property(candidates, fc.integer({ min: 0, max: 39 }), (pool, pick) => {
        const target = pool[pick % pool.length];
        expect(target).toBeDefined();
        if (target === undefined) return;
        const query = target.label.slice(0, Math.max(2, Math.min(4, target.label.length)));

        const results = buildMentionIndex(pool).search(query);
        expect(results.some((result) => result.candidate.id === target.id)).toBe(true);
      }),
      RUNS,
    );
  });

  it("lists the head of the index for an empty query rather than nothing", () => {
    fc.assert(
      fc.property(candidates, (pool) => {
        // The popover opens on `@` with nothing typed. An empty list there would read as "there is no
        // context available", which is a different and wrong statement.
        const results = buildMentionIndex(pool).search("");
        expect(results.length).toBe(Math.min(pool.length, MENTION_RESULT_LIMIT));
        expect(results[0]?.candidate.id).toBe(pool[0]?.id);
      }),
      RUNS,
    );
  });

  it("groups by category without losing rank or inventing empty groups", () => {
    fc.assert(
      fc.property(candidates, fc.stringMatching(/^[a-z]{0,4}$/), (pool, query) => {
        const results = buildMentionIndex(pool).search(query);
        const groups = groupByCategory(results);

        for (const group of groups) {
          expect(group.results.length).toBeGreaterThan(0);
          // Rank within a group is the rank in the whole list.
          const positions = group.results.map((result) => results.indexOf(result));
          expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        }
        expect(groups.reduce((total, group) => total + group.results.length, 0)).toBe(
          results.length,
        );
      }),
      RUNS,
    );
  });

  it("maps every category onto a wire kind", () => {
    // The two vocabularies differ by a plural, and a cast between them is how `"files"` ends up on a
    // field typed `"file"`.
    for (const category of MENTION_CATEGORIES) {
      expect(["file", "symbol", "terminal", "doc"]).toContain(mentionKindOf(category));
    }
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 25: mention insertion round-trips", () => {
  it("inserts the reference, preserves the surrounding text, and closes the popover (R12.3)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z ]{0,20}$/),
        fc.stringMatching(/^[a-z]{0,6}$/),
        fc.stringMatching(/^[a-z ]{0,20}$/),
        fc.array(segment, { minLength: 1, maxLength: 3 }),
        (before, typed, after, refSegments) => {
          // A draft with an active mention: the `@` is at the start or after a space, by construction.
          const prefix = before.length === 0 || before.endsWith(" ") ? before : `${before} `;
          const draft = `${prefix}@${typed}${after}`;
          const caret = prefix.length + 1 + typed.length;

          const query = detectMentionQuery(draft, caret);
          expect(query).not.toBeNull();
          if (query === null) return;

          const ref = `src/${refSegments.join("/")}.ts`;
          const applied = applyMention(draft, query.start, caret, ref);

          expect(applied.text).toContain(`@${ref} `);
          // Everything the user typed on either side of the token survives.
          expect(applied.text.startsWith(prefix)).toBe(true);
          expect(applied.text.endsWith(after)).toBe(true);
          // The caret lands after the trailing space, which is what closes the popover: there is no
          // active `@token` at the new caret.
          expect(detectMentionQuery(applied.text, applied.caret)).toBeNull();
        },
      ),
      RUNS,
    );
  });

  it("opens only at input start or after whitespace (R12.1)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,10}$/),
        fc.stringMatching(/^[a-z]{0,6}$/),
        (before, typed) => {
          // `user@example` is not a mention, and the parser must not scan past the `@` to find an earlier
          // one — which is the bug that opens the popover on the wrong token.
          const glued = `${before}@${typed}`;
          expect(detectMentionQuery(glued, glued.length)).toBeNull();

          const spaced = `${before} @${typed}`;
          expect(detectMentionQuery(spaced, spaced.length)).not.toBeNull();
        },
      ),
      RUNS,
    );
  });

  it("closes on whitespace after the token", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,8}$/), (typed) => {
        const draft = `@${typed} `;
        expect(detectMentionQuery(draft, draft.length)).toBeNull();
      }),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 26: mention keyboard navigation stays in range", () => {
  it("keeps the selection inside the list across any sequence of moves (R12.4)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.array(fc.constantFrom(1 as const, -1 as const), { minLength: 1, maxLength: 40 }),
        (count, moves) => {
          let selection = count === 0 ? -1 : 0;
          for (const delta of moves) {
            selection = nextSelection(selection, count, delta);
            if (count === 0) {
              // An empty list has no selection at all: `0` would name a row that is not there, and
              // `Enter` would insert nothing.
              expect(selection).toBe(-1);
            } else {
              expect(selection).toBeGreaterThanOrEqual(0);
              expect(selection).toBeLessThan(count);
            }
          }
        },
      ),
      RUNS,
    );
  });

  it("wraps at both ends, because a picker is a menu", () => {
    expect(nextSelection(0, 3, -1)).toBe(2);
    expect(nextSelection(2, 3, 1)).toBe(0);
    // From no selection, down goes to the first and up goes to the last.
    expect(nextSelection(-1, 3, 1)).toBe(0);
    expect(nextSelection(-1, 3, -1)).toBe(2);
  });

  it("clamps a stale selection into a list that shrank under it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 80 }),
        fc.integer({ min: 0, max: 40 }),
        (current, count) => {
          const clamped = clampSelection(current, count);
          if (count === 0) expect(clamped).toBe(-1);
          else {
            expect(clamped).toBeGreaterThanOrEqual(0);
            expect(clamped).toBeLessThan(count);
          }
        },
      ),
      RUNS,
    );
  });
});
