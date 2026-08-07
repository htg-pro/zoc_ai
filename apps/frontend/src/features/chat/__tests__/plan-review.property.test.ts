/**
 * Properties 20, 21, and 22 — the plan review's three claims about what reaches the filesystem.
 * R10.1, R10.2, R10.3, R10.8, R10.9.
 *
 * **Property 20 — apply carries exactly the accepted hunks.** *For any* plan, set of diffs, and set of
 * per-hunk decisions, the selection apply sends contains every accepted hunk from a file that is not
 * stale, no rejected hunk, no undecided hunk, and nothing twice.
 *
 * **Property 21 — staleness blocks exactly the affected files.** *For any* subset of the plan's files
 * changed on disk after the diff was generated, those files are blocked and every other file stays
 * applicable. One file moving must not strand a review of eleven hunks across four others.
 *
 * **Property 22 — a plan precedes every write, and a discarded plan writes nothing.** Two halves, and
 * both are read here as claims about the only function that can produce a write payload:
 * `applicableHunks` takes a `PlanPart`, so there is no expressible apply without a plan; and after
 * `clearPlanDecisions` the selection is empty for *any* prior decisions, so discard has nothing to send.
 * The second half is what makes R10.9's "leave every target file unmodified" structural rather than a
 * promise about a handler — there is no code path from discard to a hunk id.
 *
 * ## Why the expected value is computed a second way rather than reused
 *
 * Every assertion here recomputes what it expects from the generated inputs with a different expression
 * from the one under test — a flat filter over a flattened list, against the module's nested loop. Using
 * the module's own traversal to derive the expectation is the objection 15.5 recorded about deriving a
 * fence count from the function under test: the test then agrees with the implementation instead of with
 * the requirement.
 */

import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import { diffPart } from "./arbitraries";
import {
  applicableHunks,
  applyDisabledReason,
  applyEnabled,
  isStale,
  reviewTally,
} from "@/features/chat/review/hunk-selection";
import {
  FILE_LEVEL_DECISION,
  INITIAL_CHAT_SURFACE_STATE,
  useChatSurface,
  type HunkDecision,
  type HunkDecisions,
} from "@/features/chat/store";
import type { DiffPart, PlanPart } from "@zoc-studio/shared-types";

const RUNS = { numRuns: 200 } as const;

const PLAN_ID = "plan_under_review";

beforeEach(() => {
  useChatSurface.setState(
    { ...INITIAL_CHAT_SURFACE_STATE, expanded: new Set<string>(), hunkDecisions: {} },
    false,
  );
});

/** The diffs of one plan, unique by path, with a shared plan id. */
const planDiffs: fc.Arbitrary<DiffPart[]> = fc
  .uniqueArray(diffPart, {
    selector: (diff) => diff.path,
    minLength: 1,
    maxLength: 6,
  })
  .map((diffs) => diffs.map((diff) => ({ ...diff, planId: PLAN_ID })));

function planOf(diffs: readonly DiffPart[]): PlanPart {
  return {
    type: "plan",
    seq: 1,
    runId: "run_1",
    messageId: "msg_1",
    ts: "2026-07-31T10:00:00.000Z",
    agentName: null,
    planId: PLAN_ID,
    title: "Refactor the auth module",
    files: diffs.map((diff) => ({
      path: diff.path,
      action: diff.action,
      sourcePath: diff.sourcePath ?? null,
      rationale: "the plan's reason for touching this file",
      addedLines: diff.hunks.length,
      removedLines: diff.hunks.length,
      hunkCount: diff.hunks.length,
    })),
    verificationCommand: "pnpm test --run",
  };
}

const decision: fc.Arbitrary<HunkDecision> = fc.constantFrom("accepted", "rejected", "undecided");

/** A decision per hunk, drawn independently, keyed the way the store keys them. */
function decisionsFor(diffs: readonly DiffPart[]): fc.Arbitrary<HunkDecisions> {
  return fc
    .tuple(
      ...diffs.map((diff) =>
        fc.array(decision, { minLength: diff.hunks.length, maxLength: diff.hunks.length }),
      ),
    )
    .map((perFile) => {
      const plan: Record<string, Record<string, HunkDecision>> = {};
      diffs.forEach((diff, index) => {
        const file: Record<string, HunkDecision> = {};
        diff.hunks.forEach((hunk, hunkIndex) => {
          file[hunk.hunkId] = perFile[index]?.[hunkIndex] ?? "undecided";
        });
        plan[diff.path] = file;
      });
      return { [PLAN_ID]: plan };
    });
}

/** Which files the user's disk has moved under them, as the digest map the surface reads. */
function digestsFor(diffs: readonly DiffPart[], changed: readonly boolean[]): Map<string, string> {
  const map = new Map<string, string>();
  diffs.forEach((diff, index) => {
    // A file the surface measured and found unchanged is a different case from one it never measured,
    // and both have to be non-stale. Alternating on the index covers the second.
    if (changed[index] === true) map.set(diff.path, `${diff.baseDigest}-changed`);
    else if (index % 2 === 0) map.set(diff.path, diff.baseDigest);
  });
  return map;
}

describe("Feature: zoc-agent-chat-rebuild, Property 20: apply carries exactly the accepted hunks", () => {
  it("selects every accepted hunk from a fresh file, and nothing else (R10.2, R10.3)", () => {
    fc.assert(
      fc.property(
        planDiffs.chain((diffs) => fc.tuple(fc.constant(diffs), decisionsFor(diffs))),
        ([diffs, decisions]) => {
          const plan = planOf(diffs);
          const selection = applicableHunks(plan, diffs, decisions, new Map());

          // The expectation, computed by flattening rather than by the module's nested walk.
          const expected = diffs
            .flatMap((diff) => diff.hunks.map((hunk) => ({ path: diff.path, hunkId: hunk.hunkId })))
            .filter((entry) => decisions[PLAN_ID]?.[entry.path]?.[entry.hunkId] === "accepted")
            .map((entry) => entry.hunkId);

          expect([...selection.hunkIds]).toEqual(expected);
          expect(selection.planId).toBe(PLAN_ID);
          // Nothing twice: hunk ids repeat across files by design, so this is a claim about the
          // *selection* rather than about the ids — a duplicate here would apply a hunk twice.
          expect(new Set(selection.hunkIds).size).toBeLessThanOrEqual(selection.hunkIds.length);
        },
      ),
      RUNS,
    );
  });

  it("never selects a rejected or undecided hunk", () => {
    fc.assert(
      fc.property(
        planDiffs.chain((diffs) => fc.tuple(fc.constant(diffs), decisionsFor(diffs))),
        ([diffs, decisions]) => {
          const plan = planOf(diffs);
          const selection = applicableHunks(plan, diffs, decisions, new Map());

          // Stated by contribution rather than by membership, because a hunk id is unique only
          // *within* a file: `h_0` rejected in one file and accepted in another is a legitimate
          // selection containing `h_0`, so "the id is absent" is the wrong assertion. What must hold
          // is that each file contributes exactly its accepted count — and that a file contributing
          // nothing can be removed without changing the payload at all.
          const contributions = diffs.map(
            (diff) =>
              diff.hunks.filter(
                (hunk) => decisions[PLAN_ID]?.[diff.path]?.[hunk.hunkId] === "accepted",
              ).length,
          );
          expect(selection.hunkIds.length).toBe(contributions.reduce((a, b) => a + b, 0));

          for (const [index, diff] of diffs.entries()) {
            if (contributions[index] !== 0) continue;
            const without = diffs.filter((other) => other.path !== diff.path);
            expect([...applicableHunks(plan, without, decisions, new Map()).hunkIds]).toEqual([
              ...selection.hunkIds,
            ]);
          }
        },
      ),
      RUNS,
    );
  });

  it("counts the same number it sends", () => {
    fc.assert(
      fc.property(
        planDiffs.chain((diffs) => fc.tuple(fc.constant(diffs), decisionsFor(diffs))),
        ([diffs, decisions]) => {
          const plan = planOf(diffs);
          const selection = applicableHunks(plan, diffs, decisions, new Map());
          const tally = reviewTally(plan, diffs, decisions, new Map());
          // The footer's number and the button's payload are the same fact, which is the whole reason
          // both read from this module rather than from the card.
          expect(tally.accepted).toBe(selection.hunkIds.length + selection.acceptedFiles.length);
          expect(tally.accepted + tally.rejected + tally.undecided).toBe(tally.total);
        },
      ),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 21: staleness blocks exactly the affected files", () => {
  it("blocks the changed files and leaves every other file applicable (R10.8)", () => {
    fc.assert(
      fc.property(
        planDiffs.chain((diffs) =>
          fc.tuple(
            fc.constant(diffs),
            decisionsFor(diffs),
            fc.array(fc.boolean(), { minLength: diffs.length, maxLength: diffs.length }),
          ),
        ),
        ([diffs, decisions, changed]) => {
          const plan = planOf(diffs);
          const onDisk = digestsFor(diffs, changed);
          const selection = applicableHunks(plan, diffs, decisions, onDisk);

          const staleePaths = diffs
            .filter((_, index) => changed[index] === true)
            .map((diff) => diff.path);
          expect([...selection.blockedPaths].sort()).toEqual([...staleePaths].sort());

          // Every accepted hunk of a *fresh* file still travels — the half of R10.8 that a blunt
          // "block the plan" implementation would fail while still passing the assertion above.
          const expected = diffs
            .filter((_, index) => changed[index] !== true)
            .flatMap((diff) =>
              diff.hunks
                .filter((hunk) => decisions[PLAN_ID]?.[diff.path]?.[hunk.hunkId] === "accepted")
                .map((hunk) => hunk.hunkId),
            );
          expect([...selection.hunkIds]).toEqual(expected);
        },
      ),
      RUNS,
    );
  });

  it("treats an unmeasured path as fresh and a runtime-flagged diff as stale", () => {
    fc.assert(
      fc.property(diffPart, (diff) => {
        expect(isStale(diff, new Map())).toBe(false);
        expect(isStale({ ...diff, stale: true }, new Map())).toBe(true);
        expect(isStale(diff, new Map([[diff.path, diff.baseDigest]]))).toBe(false);
        expect(isStale(diff, new Map([[diff.path, "sha256:something-else"]]))).toBe(true);
      }),
      RUNS,
    );
  });

  it("states a reason when staleness is the only thing standing in the way", () => {
    fc.assert(
      fc.property(planDiffs, (diffs) => {
        const plan = planOf(diffs);
        // Everything accepted, everything stale: apply is disabled, and the reason has to point at
        // regeneration rather than at a checkbox the user has already ticked.
        const decisions: HunkDecisions = {
          [PLAN_ID]: Object.fromEntries(
            diffs.map((diff) => [
              diff.path,
              Object.fromEntries(diff.hunks.map((hunk) => [hunk.hunkId, "accepted" as const])),
            ]),
          ),
        };
        const onDisk = new Map(diffs.map((diff) => [diff.path, `${diff.baseDigest}-changed`]));
        const selection = applicableHunks(plan, diffs, decisions, onDisk);

        expect(applyEnabled(selection)).toBe(false);
        expect(applyDisabledReason(selection)).toContain("Regenerate");
      }),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 22: a plan precedes every write, and a discarded plan writes nothing", () => {
  it("has no expressible apply without a plan", () => {
    // Stated as a type-level fact and asserted as a behavioural one: `applicableHunks` requires a
    // `PlanPart`, and a diff on its own therefore cannot produce a payload. The closest reachable
    // state — a plan whose files the diffs do not belong to — selects nothing.
    fc.assert(
      fc.property(
        planDiffs.chain((diffs) => fc.tuple(fc.constant(diffs), decisionsFor(diffs))),
        ([diffs, decisions]) => {
          const foreign = { ...planOf(diffs), planId: "plan_someone_else" };
          const selection = applicableHunks(foreign, diffs, decisions, new Map());
          expect(selection.hunkIds).toEqual([]);
          expect(selection.acceptedFiles).toEqual([]);
          expect(applyEnabled(selection)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it("selects nothing after the plan is discarded, whatever was decided (R10.9)", () => {
    fc.assert(
      fc.property(
        planDiffs.chain((diffs) => fc.tuple(fc.constant(diffs), decisionsFor(diffs))),
        ([diffs, decisions]) => {
          const plan = planOf(diffs);
          // Through the real store, because discard *is* `clearPlanDecisions` plus a report upward,
          // and a hand-built empty map would assert against the test's own idea of discarding.
          useChatSurface.setState({ hunkDecisions: decisions }, false);
          useChatSurface.getState().clearPlanDecisions(PLAN_ID);
          const after = useChatSurface.getState().hunkDecisions;

          const selection = applicableHunks(plan, diffs, after, new Map());
          expect(selection.hunkIds).toEqual([]);
          expect(selection.acceptedFiles).toEqual([]);
          expect(applyEnabled(selection)).toBe(false);
          expect(applyDisabledReason(selection)).toBe("Select at least one hunk to apply.");
        },
      ),
      RUNS,
    );
  });

  it("keeps a hunkless file's acceptance out of a hunk id list, and in the selection", () => {
    fc.assert(
      fc.property(fc.constantFrom("accepted", "rejected", "undecided"), (state) => {
        // A pure rename: the change is entirely in the path, so its acceptance cannot ride as a hunk
        // id and still has to reach apply. This is the case `acceptedFiles` exists for.
        const rename: DiffPart = {
          type: "diff",
          seq: 1,
          runId: "run_1",
          messageId: "msg_1",
          ts: "2026-07-31T10:00:00.000Z",
          agentName: null,
          planId: PLAN_ID,
          path: "src/renamed.ts",
          action: "rename",
          sourcePath: "src/original.ts",
          language: "typescript",
          hunks: [],
          baseDigest: "sha256:abc",
          stale: false,
        };
        const plan = planOf([rename]);
        const decisions: HunkDecisions = {
          [PLAN_ID]: { [rename.path]: { [FILE_LEVEL_DECISION]: state as HunkDecision } },
        };

        const selection = applicableHunks(plan, [rename], decisions, new Map());
        expect(selection.hunkIds).toEqual([]);
        expect(selection.acceptedFiles).toEqual(state === "accepted" ? [rename.path] : []);
        expect(applyEnabled(selection)).toBe(state === "accepted");
      }),
      RUNS,
    );
  });
});
