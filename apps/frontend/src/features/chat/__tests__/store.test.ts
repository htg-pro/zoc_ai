/**
 * The chat-local store — zoc-agent-chat-rebuild task 15.1 (R2.3, R2.4, R10.3, R16.4,
 * R20.7, R32.1).
 *
 * The task names no guard, and most of this store is a setter that needs none. What is
 * tested here is the part with invariants: the three-level decision map, whose whole reason
 * for existing is that a shallower shape loses data; the monotone `seq` floor, where a
 * regression re-renders a part the user has already seen; and the anchoring rule, which is
 * a measured threshold rather than a flag.
 *
 * Property 20 (apply carries exactly the accepted hunks) and Property 48 (scroll anchoring
 * holds in both branches) both read this store and both belong to later tasks — 18.x and
 * 17.x. These are the unit-level facts those properties will rest on.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  ANCHOR_THRESHOLD_PX,
  FILE_LEVEL_DECISION,
  INITIAL_CHAT_SURFACE_STATE,
  attachedTokenCost,
  fileDecisionOf,
  hunkDecisionOf,
  requestableMentions,
  useChatSurface,
  type ResolvedMention,
} from "@/features/chat/store";

function mention(overrides: Partial<ResolvedMention> = {}): ResolvedMention {
  return {
    id: "m1",
    kind: "file",
    ref: "src/a.ts",
    estimatedTokens: 100,
    resolved: true,
    ...overrides,
  };
}

const store = () => useChatSurface.getState();

beforeEach(() => {
  useChatSurface.setState(
    {
      ...INITIAL_CHAT_SURFACE_STATE,
      expanded: new Set<string>(),
      mentions: [],
      hunkDecisions: {},
      lastRenderedSeq: {},
    },
    false,
  );
});

describe("the three-level hunk-decision map (R10.3)", () => {
  it("keeps decisions for the same hunk id in different files apart", () => {
    // The reason the map is three levels deep: hunk ids are unique only *within* a file, so
    // a flat `hunkId → decision` map would have the second write overwrite the first.
    store().decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    store().decideHunk("plan_1", "src/b.ts", "h1", "rejected");

    const { hunkDecisions } = store();
    expect(hunkDecisionOf(hunkDecisions, "plan_1", "src/a.ts", "h1")).toBe("accepted");
    expect(hunkDecisionOf(hunkDecisions, "plan_1", "src/b.ts", "h1")).toBe("rejected");
  });

  it("defaults to undecided, which is the absence of an entry", () => {
    expect(hunkDecisionOf({}, "plan_1", "src/a.ts", "h1")).toBe("undecided");
    store().decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    expect(hunkDecisionOf(store().hunkDecisions, "plan_1", "src/a.ts", "h9")).toBe("undecided");
  });

  it("clears one file's decisions without touching the rest of the plan (R10.8)", () => {
    // The operation the shape exists for. A regenerated diff invalidates one file's review;
    // the other files' decisions are still the user's and must survive.
    store().decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    store().decideHunk("plan_1", "src/a.ts", "h2", "rejected");
    store().decideHunk("plan_1", "src/b.ts", "h1", "accepted");

    store().clearFileDecisions("plan_1", "src/a.ts");

    const { hunkDecisions } = store();
    expect(hunkDecisionOf(hunkDecisions, "plan_1", "src/a.ts", "h1")).toBe("undecided");
    expect(hunkDecisionOf(hunkDecisions, "plan_1", "src/a.ts", "h2")).toBe("undecided");
    expect(hunkDecisionOf(hunkDecisions, "plan_1", "src/b.ts", "h1")).toBe("accepted");
    // Removed rather than emptied, so "no decisions" and "decided nothing" are one state.
    expect(hunkDecisions.plan_1?.["src/a.ts"]).toBeUndefined();
  });

  it("clears one plan without touching another", () => {
    store().decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    store().decideHunk("plan_2", "src/a.ts", "h1", "accepted");

    store().clearPlanDecisions("plan_1");

    expect(hunkDecisionOf(store().hunkDecisions, "plan_1", "src/a.ts", "h1")).toBe("undecided");
    expect(hunkDecisionOf(store().hunkDecisions, "plan_2", "src/a.ts", "h1")).toBe("accepted");
  });

  it("holds a file-level decision under a reserved key, for a hunkless rename", () => {
    // design.md:2769: a pure rename has zero hunks and still has to be acceptable. The
    // reserved key rather than a synthetic hunk id, which would then have to be filtered
    // out of every hunk count the user sees.
    store().decideFile("plan_1", "src/renamed.ts", "accepted");

    expect(fileDecisionOf(store().hunkDecisions, "plan_1", "src/renamed.ts")).toBe("accepted");
    expect(Object.keys(store().hunkDecisions.plan_1?.["src/renamed.ts"] ?? {})).toEqual([
      FILE_LEVEL_DECISION,
    ]);
  });

  it("does not confuse a file-level decision with a hunk decision", () => {
    store().decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    expect(fileDecisionOf(store().hunkDecisions, "plan_1", "src/a.ts")).toBe("undecided");
  });

  it("leaves the map untouched when clearing something that was never decided", () => {
    store().decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    const before = store().hunkDecisions;

    store().clearFileDecisions("plan_1", "src/never.ts");
    store().clearPlanDecisions("plan_nope");

    // Reference equality: a no-op that produced a new object would re-render every
    // subscriber for nothing.
    expect(store().hunkDecisions).toBe(before);
  });
});

describe("the sequence floor (R16.4)", () => {
  it("advances only forward, so a late duplicate cannot re-admit a rendered part", () => {
    // A resume replays from an *exclusive* floor. A floor that moved backwards would ask the
    // runtime for parts already on screen and render them a second time.
    store().recordRenderedSeq("run_1", 5);
    store().recordRenderedSeq("run_1", 3);
    store().recordRenderedSeq("run_1", 5);

    expect(store().lastRenderedSeq.run_1).toBe(5);
  });

  it("tracks each Run separately", () => {
    store().recordRenderedSeq("run_1", 7);
    store().recordRenderedSeq("run_2", 2);

    expect(store().lastRenderedSeq).toEqual({ run_1: 7, run_2: 2 });
  });

  it("starts at zero for an unknown Run, which is the whole-transcript resume point", () => {
    expect(store().lastRenderedSeq.run_new ?? 0).toBe(0);
  });

  it("forgets a Run without disturbing the others", () => {
    store().recordRenderedSeq("run_1", 4);
    store().recordRenderedSeq("run_2", 9);

    store().forgetRun("run_1");

    expect(store().lastRenderedSeq).toEqual({ run_2: 9 });
  });

  it("holds one integer per Run and never a part", () => {
    // R2.4's line, asserted structurally: this is the one entry in the store that looks like
    // per-stream data and is not.
    store().recordRenderedSeq("run_1", 12);
    for (const value of Object.values(store().lastRenderedSeq)) {
      expect(typeof value).toBe("number");
    }
  });
});

describe("scroll anchoring (R20.7, R20.8)", () => {
  it("anchors within the threshold and un-anchors outside it", () => {
    // The measured rule rather than a scroll-direction guess. 32 px is roughly half a row:
    // large enough that inertial overscroll does not un-anchor, small enough that a
    // deliberate one-row scroll up does.
    store().observeScroll({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 });
    expect(store().anchored).toBe(true);

    store().observeScroll({
      scrollHeight: 1000,
      scrollTop: 900 - ANCHOR_THRESHOLD_PX,
      clientHeight: 100,
    });
    expect(store().anchored).toBe(true);

    store().observeScroll({
      scrollHeight: 1000,
      scrollTop: 900 - ANCHOR_THRESHOLD_PX - 1,
      clientHeight: 100,
    });
    expect(store().anchored).toBe(false);
  });

  it("counts rows appended only while un-anchored", () => {
    store().noteRowAppended();
    // Anchored: the row is on screen, so there is nothing to catch up on.
    expect(store().rowsSinceUnanchored).toBe(0);

    store().setAnchored(false);
    store().noteRowAppended();
    store().noteRowAppended();
    expect(store().rowsSinceUnanchored).toBe(2);
  });

  it("clears the backlog on re-anchoring", () => {
    // Otherwise the jump control's count outlives the control itself, and a stale number
    // sits beside a transcript that is already at the bottom.
    store().setAnchored(false);
    store().noteRowAppended();
    store().setAnchored(true);

    expect(store().rowsSinceUnanchored).toBe(0);
  });

  it("treats a viewport taller than its content as anchored", () => {
    // A short transcript: the distance is negative, which is inside the threshold and must
    // not read as scrolled away.
    store().observeScroll({ scrollHeight: 200, scrollTop: 0, clientHeight: 600 });
    expect(store().anchored).toBe(true);
  });
});

describe("mentions (R12.5, R12.7)", () => {
  it("keeps an unresolved chip and excludes it from the request", () => {
    // R12.7 excludes the chip from the request rather than dropping it, so the user can see
    // *why* their attachment is not being sent. "Unresolved" therefore has to be a state a
    // chip can be in, not an absence.
    store().addMention(mention({ id: "a" }));
    store().addMention(mention({ id: "b", ref: "src/gone.ts" }));
    store().markMentionUnresolved("b");

    expect(store().mentions).toHaveLength(2);
    expect(requestableMentions(store().mentions).map((m) => m.id)).toEqual(["a"]);
  });

  it("counts only requestable mentions toward the attached cost", () => {
    store().addMention(mention({ id: "a", estimatedTokens: 300 }));
    store().addMention(mention({ id: "b", estimatedTokens: 700 }));
    expect(attachedTokenCost(store().mentions)).toBe(1000);

    store().markMentionUnresolved("b");
    // The figure the composer shows is what the request will actually cost, so an excluded
    // chip must not inflate it.
    expect(attachedTokenCost(store().mentions)).toBe(300);
  });

  it("ignores a duplicate add by id", () => {
    // The popover can fire twice on a fast double-accept, and a duplicate chip is both a
    // doubled token cost and a chip the user cannot remove.
    store().addMention(mention({ id: "a" }));
    store().addMention(mention({ id: "a" }));
    expect(store().mentions).toHaveLength(1);
  });

  it("removes by id and leaves the others in order", () => {
    for (const id of ["a", "b", "c"]) store().addMention(mention({ id }));
    store().removeMention("b");
    expect(store().mentions.map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("never reports a negative cost for a bad estimate", () => {
    store().addMention(mention({ id: "a", estimatedTokens: -50 }));
    expect(attachedTokenCost(store().mentions)).toBe(0);
  });
});

describe("expanded rows and session scope", () => {
  it("toggles a row by stable id", () => {
    store().toggleExpanded("row_1");
    expect(store().expanded.has("row_1")).toBe(true);
    store().toggleExpanded("row_1");
    expect(store().expanded.has("row_1")).toBe(false);
  });

  it("sets an explicit open state idempotently", () => {
    store().setExpanded("row_1", true);
    const first = store().expanded;
    store().setExpanded("row_1", true);
    // A no-op must not produce a new `Set`, or every expanded row re-renders on a redundant
    // open — which is what a controlled `Collapsible` does on each render.
    expect(store().expanded).toBe(first);
  });

  it("resets everything Session-scoped, with fresh collections", () => {
    store().setDraft("half a question");
    store().addMention(mention());
    store().decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    store().toggleExpanded("row_1");
    store().recordRenderedSeq("run_1", 4);
    store().setAnchored(false);
    store().setPendingApprovalId("req_1");
    const staleExpanded = store().expanded;

    store().resetForSession();

    expect(store().draft).toBe("");
    expect(store().mentions).toEqual([]);
    expect(store().hunkDecisions).toEqual({});
    expect(store().expanded.size).toBe(0);
    expect(store().lastRenderedSeq).toEqual({});
    expect(store().anchored).toBe(true);
    expect(store().pendingApprovalId).toBeNull();
    // A *new* Set, not the previous one emptied and not the module-level initial one:
    // sharing either would let one Session's expansions leak into the next.
    expect(store().expanded).not.toBe(staleExpanded);
    expect(store().expanded).not.toBe(INITIAL_CHAT_SURFACE_STATE.expanded);
  });

  it("defaults the conversation mode to agent (R32.1)", () => {
    expect(store().conversationMode).toBe("agent");
    store().setConversationMode("plan");
    store().resetForSession();
    // Property 78 restores `Agent` for a Session with no submissions, and the reset is the
    // path a Session switch takes.
    expect(store().conversationMode).toBe("agent");
  });
});
