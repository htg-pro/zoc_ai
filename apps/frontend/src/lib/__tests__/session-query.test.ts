// Feature: chat-memory-session-system, Task 4.3
// Unit tests for `localDayIndex` boundary and NaN cases (Requirements 3.3, 3.4).
import { describe, expect, it } from "vitest";
import type { Session, SessionStatus } from "@zoc-studio/shared-types";
import { groupSessions, localDayIndex } from "../session-query";

const MS_PER_DAY = 86_400_000;

/** Minimal valid Session with a given id and updated_at timestamp. */
function makeSession(
  id: string,
  updatedAt: string,
  status: SessionStatus = "active",
): Session {
  return {
    id,
    title: id,
    status,
    workspace_root: "/tmp/ws",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: updatedAt,
    messages: [],
    tool_calls: [],
  };
}

/**
 * The UTC instant (epoch ms) that the function treats as the first instant of
 * local calendar day `dayIndex` under `tzOffsetMinutes`. Derived directly from
 * the function's own definition: localDayIndex floors
 * `(t - tzOffsetMinutes*60_000) / MS_PER_DAY`, so the start of day `D` is the
 * smallest `t` with `(t - off) === D * MS_PER_DAY`.
 */
function localMidnightMs(dayIndex: number, tzOffsetMinutes: number): number {
  return dayIndex * MS_PER_DAY + tzOffsetMinutes * 60_000;
}

describe("localDayIndex — local-midnight half-open boundary (R3.3)", () => {
  it("treats local midnight (UTC offset 0) as the first instant of its day", () => {
    // 2024-06-01T00:00:00.000Z is an exact day boundary in UTC.
    const startOfDay = localDayIndex("2024-06-01T00:00:00.000Z", 0);
    // The instant itself belongs to June 1.
    expect(localDayIndex("2024-06-01T00:00:00.000Z", 0)).toBe(startOfDay);
    // One millisecond before midnight falls in the prior day.
    expect(localDayIndex("2024-05-31T23:59:59.999Z", 0)).toBe(startOfDay - 1);
    // One millisecond after midnight stays in the same day.
    expect(localDayIndex("2024-06-01T00:00:00.001Z", 0)).toBe(startOfDay);
  });

  it("places the last instant of a day in that same day (half-open upper bound)", () => {
    const day = localDayIndex("2024-06-01T12:00:00.000Z", 0);
    // 23:59:59.999 is still the same day...
    expect(localDayIndex("2024-06-01T23:59:59.999Z", 0)).toBe(day);
    // ...and the next midnight begins the next day.
    expect(localDayIndex("2024-06-02T00:00:00.000Z", 0)).toBe(day + 1);
  });

  it.each([
    ["UTC", 0],
    ["UTC+5:30 (India)", 330],
    ["UTC-8 (US Pacific)", -480],
    ["UTC+1 (CET)", 60],
  ])(
    "honors the injected offset %s: midnight is the day's first instant, one ms before is the prior day",
    (_label, offset) => {
      // Use a fixed reference day index so the test is deterministic.
      const dayIndex = Math.floor(
        Date.parse("2024-06-01T00:00:00.000Z") / MS_PER_DAY,
      );
      const midnightMs = localMidnightMs(dayIndex, offset);

      const midnightIso = new Date(midnightMs).toISOString();
      const justBeforeIso = new Date(midnightMs - 1).toISOString();
      const justAfterIso = new Date(midnightMs + 1).toISOString();

      // Local midnight is the first instant of `dayIndex`.
      expect(localDayIndex(midnightIso, offset)).toBe(dayIndex);
      // One millisecond before is the prior local day.
      expect(localDayIndex(justBeforeIso, offset)).toBe(dayIndex - 1);
      // One millisecond after is still the same local day.
      expect(localDayIndex(justAfterIso, offset)).toBe(dayIndex);
    },
  );

  it("is deterministic for identical inputs", () => {
    const a = localDayIndex("2024-06-01T08:30:00.000Z", 330);
    const b = localDayIndex("2024-06-01T08:30:00.000Z", 330);
    expect(a).toBe(b);
  });
});

describe("localDayIndex — unparseable timestamps (R3.4)", () => {
  it.each([
    ["empty string", ""],
    ["garbage text", "not-a-date"],
    ["whitespace", "   "],
    ["partial nonsense", "2024-13-45T99:99:99Z"],
  ])("returns NEGATIVE_INFINITY for %s without throwing", (_label, iso) => {
    let result: number | undefined;
    expect(() => {
      result = localDayIndex(iso, 0);
    }).not.toThrow();
    expect(result).toBe(Number.NEGATIVE_INFINITY);
  });

  it("returns NEGATIVE_INFINITY regardless of the offset", () => {
    expect(localDayIndex("nonsense", 0)).toBe(Number.NEGATIVE_INFINITY);
    expect(localDayIndex("nonsense", 330)).toBe(Number.NEGATIVE_INFINITY);
    expect(localDayIndex("nonsense", -480)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("groupSessions — NaN timestamps bucket into Earlier (R3.4)", () => {
  const NOW = Date.parse("2024-06-15T12:00:00.000Z");
  const NO_PINS = new Set<string>();

  it("places a session with an unparseable updated_at into 'earlier' without throwing", () => {
    const sessions = [makeSession("bad", "not-a-date")];
    let groups!: ReturnType<typeof groupSessions>;
    expect(() => {
      groups = groupSessions(sessions, NO_PINS, NOW, 0);
    }).not.toThrow();

    expect(groups.earlier.map((s) => s.id)).toEqual(["bad"]);
    expect(groups.today).toHaveLength(0);
    expect(groups.yesterday).toHaveLength(0);
  });

  it("does not affect the day buckets assigned to other sessions", () => {
    const sessions = [
      makeSession("today", "2024-06-15T09:00:00.000Z"),
      makeSession("yesterday", "2024-06-14T09:00:00.000Z"),
      makeSession("bad", "garbage"),
      makeSession("old", "2024-01-01T09:00:00.000Z"),
    ];

    const groups = groupSessions(sessions, NO_PINS, NOW, 0);

    expect(groups.today.map((s) => s.id)).toEqual(["today"]);
    expect(groups.yesterday.map((s) => s.id)).toEqual(["yesterday"]);
    // Both the unparseable session and the genuinely old one land in 'earlier'.
    expect(groups.earlier.map((s) => s.id).sort()).toEqual(["bad", "old"]);

    // Totality preserved: every session is placed exactly once.
    const total =
      groups.pinned.length +
      groups.today.length +
      groups.yesterday.length +
      groups.earlier.length;
    expect(total).toBe(sessions.length);
  });
});
