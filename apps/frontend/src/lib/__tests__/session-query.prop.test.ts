// Feature: studio-ui-redesign, Property 1: Session grouping is total and order-preserving
// Feature: studio-ui-redesign, Property 2: Session statistics and filter counts are non-negative integers matching their predicate
// Feature: studio-ui-redesign, Property 3: Filtering and search partition the session set correctly
// Feature: studio-ui-redesign, Property 4: Sorting is deterministic, idempotent, and a permutation
// Feature: studio-ui-redesign, Property 5: Pin persistence round-trips
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Session } from "@zoc-studio/shared-types";
import {
  type SessionFilter,
  type SortOption,
  deserializePinned,
  filterSortSearch,
  groupSessions,
  localDayIndex,
  matchesFilter,
  matchesSearch,
  serializePinned,
  sessionStats,
  sortSessions,
  tabCounts,
  togglePinned,
} from "../session-query";
import { arbSessionsUniqueIds } from "../../__tests__/arbitraries";

const NOW = Date.parse("2050-06-15T12:00:00.000Z");

// An arbitrary subset of the session ids to use as the pinned set.
const arbWithPinned = arbSessionsUniqueIds.chain((sessions) =>
  fc
    .subarray(sessions.map((s) => s.id))
    .map((ids) => ({ sessions, pinned: new Set(ids) })),
);

const FILTERS: SessionFilter[] = ["all", "active", "pinned", "archived"];
const SORTS: SortOption[] = ["recent", "oldest", "title", "model"];

describe("session-query", () => {
  it("Property 1: grouping is total and pin-aware", () => {
    fc.assert(
      fc.property(arbWithPinned, ({ sessions, pinned }) => {
        const g = groupSessions(sessions, pinned, NOW, 0);

        // Pinned bucket is exactly the pinned sessions.
        expect(g.pinned.every((s) => pinned.has(s.id))).toBe(true);
        // No pinned session appears in a recency bucket.
        for (const bucket of [g.today, g.yesterday, g.earlier]) {
          expect(bucket.some((s) => pinned.has(s.id))).toBe(false);
        }
        // Totality: every session lands in exactly one bucket.
        const total =
          g.pinned.length + g.today.length + g.yesterday.length + g.earlier.length;
        expect(total).toBe(sessions.length);

        // Every non-pinned session appears in exactly one recency bucket.
        const nonPinned = sessions.filter((s) => !pinned.has(s.id));
        const placed = [...g.today, ...g.yesterday, ...g.earlier].map((s) => s.id);
        expect(new Set(placed).size).toBe(placed.length);
        expect(placed.length).toBe(nonPinned.length);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 2: stat values and tab counts are non-negative integers matching predicates", () => {
    fc.assert(
      fc.property(arbWithPinned, ({ sessions, pinned }) => {
        const counts = tabCounts(sessions, pinned);
        for (const f of FILTERS) {
          const expected = sessions.filter((s) =>
            matchesFilter(s, f, pinned),
          ).length;
          expect(counts[f]).toBe(expected);
          expect(Number.isInteger(counts[f])).toBe(true);
          expect(counts[f]).toBeGreaterThanOrEqual(0);
        }

        const stats = sessionStats(sessions, NOW, () => 5);
        for (const v of Object.values(stats)) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
        expect(stats.activeSessions).toBe(
          sessions.filter((s) => s.status === "active").length,
        );
        expect(stats.modelsUsed).toBeLessThanOrEqual(sessions.length);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 2b: empty session list yields all-zero stats and counts", () => {
    const empty: Session[] = [];
    expect(tabCounts(empty, new Set())).toEqual({
      all: 0,
      active: 0,
      pinned: 0,
      archived: 0,
    });
    expect(sessionStats(empty, NOW)).toEqual({
      activeSessions: 0,
      runsThisWeek: 0,
      modelsUsed: 0,
      tokensUsed: 0,
    });
  });

  it("Property 3: filter+search yields exactly the sessions matching both predicates", () => {
    fc.assert(
      fc.property(
        arbWithPinned,
        fc.constantFrom(...FILTERS),
        fc.string({ maxLength: 6 }),
        fc.constantFrom(...SORTS),
        ({ sessions, pinned }, filter, query, sort) => {
          const shown = filterSortSearch(sessions, pinned, filter, query, sort);
          const shownIds = new Set(shown.map((s) => s.id));

          for (const s of sessions) {
            const expected =
              matchesFilter(s, filter, pinned) && matchesSearch(s, query);
            expect(shownIds.has(s.id)).toBe(expected);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 4: sort is deterministic, idempotent, and a permutation", () => {
    fc.assert(
      fc.property(
        arbSessionsUniqueIds,
        fc.constantFrom(...SORTS),
        (sessions, sort) => {
          const once = sortSessions(sessions, sort);
          const again = sortSessions(sessions, sort);
          const twice = sortSessions(once, sort);

          // Deterministic + idempotent.
          expect(once.map((s) => s.id)).toEqual(again.map((s) => s.id));
          expect(twice.map((s) => s.id)).toEqual(once.map((s) => s.id));

          // Permutation: same multiset of ids.
          expect(once.map((s) => s.id).sort()).toEqual(
            sessions.map((s) => s.id).sort(),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 5: pin toggle + persist/reload inverts only the target's membership", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.hexaString({ minLength: 1, maxLength: 6 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.nat(),
        (ids, pick) => {
          const id = ids[pick % ids.length];
          const initial = new Set(ids.filter((_, i) => i % 2 === 0));
          const before = initial.has(id);

          const toggled = togglePinned(initial, id);
          const reloaded = deserializePinned(serializePinned(toggled));

          // Target membership inverted.
          expect(reloaded.has(id)).toBe(!before);
          // Every other id unchanged.
          for (const other of ids) {
            if (other === id) continue;
            expect(reloaded.has(other)).toBe(initial.has(other));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// Feature: chat-memory-session-system, Property 8: Day-bucketing consistent with display timezone
// Validates: Requirements 3.1
describe("session-query — Property 8: day-bucketing consistent with display timezone", () => {
  const MS_PER_DAY = 86_400_000;

  // Realistic display-timezone offsets in minutes (UTC-14 .. UTC+14).
  const arbTzOffset = fc.integer({ min: -14 * 60, max: 14 * 60 });
  // Any epoch ms within the bounded range used elsewhere (round-trips through ISO).
  const arbEpochMs = fc.integer({ min: 0, max: 4_102_444_800_000 });
  // A local calendar day index. min=1 keeps constructed epochs positive even
  // after subtracting the largest negative-equivalent offset shift.
  const arbDayIndex = fc.integer({ min: 1, max: 47_000 });
  // An offset within a single local day, in ms.
  const arbWithinDay = fc.integer({ min: 0, max: MS_PER_DAY - 1 });

  // Build the ISO timestamp whose local day (under `off`) is exactly `day`,
  // shifted `withinDay` ms into that day.
  const isoForLocalDay = (day: number, off: number, withinDay: number): string =>
    new Date(day * MS_PER_DAY + off * 60_000 + withinDay).toISOString();

  it("localDayIndex is deterministic (equal inputs yield equal outputs)", () => {
    fc.assert(
      fc.property(arbEpochMs, arbTzOffset, (ms, off) => {
        const iso = new Date(ms).toISOString();
        expect(localDayIndex(iso, off)).toBe(localDayIndex(iso, off));
      }),
      { numRuns: 300 },
    );
  });

  it("two timestamps within the same local day share an index", () => {
    fc.assert(
      fc.property(
        arbDayIndex,
        arbTzOffset,
        arbWithinDay,
        arbWithinDay,
        (day, off, a, b) => {
          const iso1 = isoForLocalDay(day, off, a);
          const iso2 = isoForLocalDay(day, off, b);
          // Both land on the intended local day, hence share an index.
          expect(localDayIndex(iso1, off)).toBe(day);
          expect(localDayIndex(iso2, off)).toBe(day);
          expect(localDayIndex(iso1, off)).toBe(localDayIndex(iso2, off));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("consecutive local days differ by exactly 1", () => {
    fc.assert(
      fc.property(arbDayIndex, arbTzOffset, arbWithinDay, (day, off, within) => {
        const isoToday = isoForLocalDay(day, off, within);
        const isoNext = isoForLocalDay(day + 1, off, within);
        expect(localDayIndex(isoNext, off) - localDayIndex(isoToday, off)).toBe(1);
      }),
      { numRuns: 300 },
    );
  });

  it("local midnight is the first instant of its day; one ms earlier is the prior day", () => {
    fc.assert(
      fc.property(arbDayIndex, arbTzOffset, (day, off) => {
        const midnight = isoForLocalDay(day, off, 0);
        const justBefore = new Date(
          day * MS_PER_DAY + off * 60_000 - 1,
        ).toISOString();
        expect(localDayIndex(midnight, off)).toBe(day);
        expect(localDayIndex(justBefore, off)).toBe(day - 1);
      }),
      { numRuns: 300 },
    );
  });

  it("every non-pinned session lands in exactly one labeled bucket, consistent with localDayIndex and now", () => {
    fc.assert(
      fc.property(arbWithPinned, arbTzOffset, ({ sessions, pinned }, off) => {
        const g = groupSessions(sessions, pinned, NOW, off);
        const nowDay = Math.floor((NOW - off * 60_000) / MS_PER_DAY);
        const nonPinned = sessions.filter((s) => !pinned.has(s.id));

        for (const s of nonPinned) {
          const inToday = g.today.includes(s);
          const inYesterday = g.yesterday.includes(s);
          const inEarlier = g.earlier.includes(s);
          // Exactly one labeled bucket.
          expect([inToday, inYesterday, inEarlier].filter(Boolean).length).toBe(1);

          // Bucket choice agrees with localDayIndex relative to now.
          const day = localDayIndex(s.updated_at, off);
          if (day === nowDay) expect(inToday).toBe(true);
          else if (day === nowDay - 1) expect(inYesterday).toBe(true);
          else expect(inEarlier).toBe(true);
        }

        // The three labeled buckets partition the non-pinned sessions.
        expect(g.today.length + g.yesterday.length + g.earlier.length).toBe(
          nonPinned.length,
        );
      }),
      { numRuns: 300 },
    );
  });
});
