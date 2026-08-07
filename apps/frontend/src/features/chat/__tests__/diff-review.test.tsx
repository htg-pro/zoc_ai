/**
 * Per-hunk diff review — zoc-agent-chat-rebuild R22.1, R10.2, R10.3, R10.8, task 22.13.
 *
 * R22.1 names "per-Hunk diff review for each of the four file actions" as one area of the renderer's unit
 * suite, and 22.13 names the four things it must reach: accept, reject, the apply count, and the stale
 * strip. That is the review *loop* — press a control, watch the decision land, watch the number that
 * decides what gets written change with it.
 *
 * ## What this covers that the four files around it do not
 *
 * `plan-card.test.tsx` (task 18.2) is the card: badges, the omitted gutter column on a create and a
 * delete, both paths on a rename, the receipt. It touches a hunk control twice, to prove the footer reads
 * what a row wrote. `plan-review.property.test.ts` (Properties 20–22) is `hunk-selection.ts` alone, with
 * no tree at all. `hunk-keyboard.property.test.tsx` (Property 56) is the same loop from the keyboard. Both
 * properties are *optional* — the plan makes every property test optional and 22.13 is the task that is
 * not — so the pointer path, which is how the review is actually driven, is asserted here as fixed cases.
 *
 * Two claims in particular exist nowhere else:
 *
 * **`undecided` is a value, not an absence.** A control pressed twice returns its hunk to `undecided`
 * rather than to `rejected` (`HunkRow` explains why the pair is not a checkbox), and the row states which
 * of the three it is. Nothing else asserts the return trip.
 *
 * **A file that goes stale mid-review drops its own accepted hunks and nothing else.** 18.2's stale file
 * arrives stale with no decisions on it, so it cannot show the subtraction. Here the reviewer accepts
 * hunks in two files and *then* one of them moves on disk, which is R10.8's second moment — the file
 * changes during the minutes a reviewer spends reading — and the footer's number, the button's number,
 * and the payload's length all fall together.
 *
 * ## Why a controlled harness rather than a fixed `decisions` prop
 *
 * `DiffReview` is told what the decisions are and reports what the user pressed; the toggle-back
 * semantics live in that round trip, so a static `decisions={{}}` would report "accepted" twice and the
 * return to `undecided` would be untestable. The harness closes the loop the way `PlanRow` closes it
 * through the store, which keeps these cases about the diff rather than about the card.
 */

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DiffPart, Hunk, HunkAction } from "@zoc-studio/shared-types";

import { DiffReview, STALE_COPY } from "@/features/chat/review/DiffReview";
import { PlanRow } from "@/features/chat/review/PlanRow";
import { FILE_LEVEL_DECISION, type HunkDecision } from "@/features/chat/store";
import { resetChatSurface } from "./transcript-harness";

const PLAN_ID = "plan_1";

/** A two-line change: one line out, two in, so `+2 −1` is legible on the row. */
const MODIFY_PATCH = "-const before = 1;\n+const after = 1;\n+const extra = 2;\n";

function hunk(id: string, patch = MODIFY_PATCH, overrides: Partial<Hunk> = {}): Hunk {
  return { hunkId: id, oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, patch, ...overrides };
}

function diffOf(
  path: string,
  action: HunkAction,
  hunks: readonly Hunk[],
  sourcePath: string | null = null,
): DiffPart {
  return {
    type: "diff",
    seq: 1,
    runId: "run_1",
    messageId: "msg_1",
    ts: "2026-08-02T10:00:00.000Z",
    agentName: null,
    planId: PLAN_ID,
    path,
    action,
    sourcePath,
    language: "typescript",
    hunks: [...hunks],
    baseDigest: "sha256:base",
    stale: false,
  };
}

/** The plan a set of diffs implies, so the card's file rows and the diffs cannot disagree. */
function planOf(diffs: readonly DiffPart[]) {
  return {
    type: "plan" as const,
    seq: 1,
    runId: "run_1",
    messageId: "msg_1",
    ts: "2026-08-02T10:00:00.000Z",
    agentName: null,
    planId: PLAN_ID,
    title: "Tidy the review surface",
    files: diffs.map((diff) => ({
      path: diff.path,
      action: diff.action,
      sourcePath: diff.sourcePath ?? null,
      rationale: "why",
      addedLines: 2,
      removedLines: 1,
      hunkCount: diff.hunks.length,
    })),
    verificationCommand: null,
  };
}

interface ReviewProps {
  readonly diff: DiffPart;
  readonly stale?: boolean;
  /** Every decision the diff reports, hunk id first and {@link FILE_LEVEL_DECISION} for a file. */
  readonly onDecide?: (key: string, decision: HunkDecision) => void;
  readonly onRegenerate?: () => void;
}

/** `DiffReview` with its decisions held, which is what makes a second press observable. */
function Review({ diff, stale = false, onDecide, onRegenerate }: ReviewProps) {
  const [decisions, setDecisions] = useState<Readonly<Record<string, HunkDecision>>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());

  const record = (key: string, decision: HunkDecision): void => {
    onDecide?.(key, decision);
    setDecisions((previous) => ({ ...previous, [key]: decision }));
  };

  return (
    <DiffReview
      diff={diff}
      stale={stale}
      decisions={decisions}
      isExpanded={(hunkId) => open.has(hunkId)}
      onDecideHunk={record}
      onDecideFile={(decision) => {
        record(FILE_LEVEL_DECISION, decision);
      }}
      onExpandedChange={(hunkId, next) => {
        setOpen((previous) => {
          const copy = new Set(previous);
          if (next) copy.add(hunkId);
          else copy.delete(hunkId);
          return copy;
        });
      }}
      {...(onRegenerate === undefined ? {} : { onRegenerate })}
    />
  );
}

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

const press = (selector: string): void => {
  const node = el(selector);
  if (node === null) throw new Error(`no control matched ${selector}`);
  fireEvent.click(node);
};

/** One hunk row's controls, addressed through the row so a two-hunk file is unambiguous. */
const rowControl = (hunkId: string, control: "accept" | "reject"): HTMLElement => {
  const node = el(`[data-zoc-hunk-row="${hunkId}"] [data-zoc-hunk-${control}]`);
  if (node === null) throw new Error(`hunk ${hunkId} rendered no ${control} control`);
  return node;
};

const decisionOf = (hunkId: string): string | null =>
  el(`[data-zoc-hunk-row="${hunkId}"]`)?.getAttribute("data-decision") ?? null;

const pressedOn = (hunkId: string, control: "accept" | "reject"): string | null =>
  rowControl(hunkId, control).getAttribute("aria-pressed");

beforeEach(resetChatSurface);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.13: per-hunk diff review (R22.1)", () => {
  it("accepts one hunk without touching its neighbour (R10.2)", () => {
    const onDecide = vi.fn();
    render(
      <Review diff={diffOf("src/a.ts", "modify", [hunk("h1"), hunk("h2")])} onDecide={onDecide} />,
    );

    // A fresh file says nothing about staleness, which is what makes the strip's later appearance
    // information rather than furniture.
    expect(el("[data-zoc-diff-stale]")).toBeNull();
    expect(all("[data-zoc-hunk-row]")).toHaveLength(2);

    fireEvent.click(rowControl("h1", "accept"));

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("h1", "accepted");
    // The decision is on the row and on the control, not only in the control's colour (R21.7): one
    // attribute a screen reader reads, one a test can read, and neither is a shade of green.
    expect(decisionOf("h1")).toBe("accepted");
    expect(pressedOn("h1", "accept")).toBe("true");
    expect(pressedOn("h1", "reject")).toBe("false");
    // A decision is one hunk's. R10.2's "per-Hunk" is the whole point of the row.
    expect(decisionOf("h2")).toBe("undecided");
    expect(pressedOn("h2", "accept")).toBe("false");
  });

  it("rejects a hunk, and a rejected hunk is not an undecided one (R10.3)", () => {
    const onDecide = vi.fn();
    render(
      <Review diff={diffOf("src/a.ts", "modify", [hunk("h1"), hunk("h2")])} onDecide={onDecide} />,
    );

    fireEvent.click(rowControl("h2", "reject"));

    expect(onDecide).toHaveBeenCalledWith("h2", "rejected");
    expect(pressedOn("h2", "reject")).toBe("true");
    // The two states are different values, which is the distinction the footer's "0 of 2" depends on
    // being able to make: a review nobody started and a review that turned everything down both select
    // nothing, and they are not the same fact about the user's attention.
    expect(decisionOf("h2")).toBe("rejected");
    expect(decisionOf("h1")).toBe("undecided");
  });

  it("returns a hunk to undecided when its own control is pressed again", () => {
    const onDecide = vi.fn();
    render(<Review diff={diffOf("src/a.ts", "modify", [hunk("h1")])} onDecide={onDecide} />);

    fireEvent.click(rowControl("h1", "accept"));
    fireEvent.click(rowControl("h1", "accept"));

    // `undecided`, not `rejected`. A checkbox would have to unset to "not wanted", which would make "I
    // have not looked at this yet" unreachable once the box had ever been ticked.
    expect(onDecide).toHaveBeenLastCalledWith("h1", "undecided");
    expect(decisionOf("h1")).toBe("undecided");
    expect(pressedOn("h1", "accept")).toBe("false");
    expect(pressedOn("h1", "reject")).toBe("false");
  });

  it("flips straight to the other decision when the other control is pressed", () => {
    const onDecide = vi.fn();
    render(<Review diff={diffOf("src/a.ts", "modify", [hunk("h1")])} onDecide={onDecide} />);

    fireEvent.click(rowControl("h1", "accept"));
    fireEvent.click(rowControl("h1", "reject"));

    // No detour through `undecided`: changing one's mind is one press, not two.
    expect(onDecide.mock.calls).toEqual([
      ["h1", "accepted"],
      ["h1", "rejected"],
    ]);
    expect(decisionOf("h1")).toBe("rejected");
    expect(pressedOn("h1", "accept")).toBe("false");
  });

  // R22.1's "for each of the four file actions", at the level it names: a hunk in any of the four is a
  // hunk the reviewer decides. The shapes differ — a create has no pre-change side, a delete no
  // post-change side, a rename carries a second path — and none of that changes the loop.
  const HUNKED: readonly (readonly [HunkAction, string, string, Partial<Hunk>, string])[] = [
    ["modify", "src/mod.ts", "Modified", {}, MODIFY_PATCH],
    ["create", "src/new.ts", "New file", { oldStart: 1, oldLines: 0 }, "+const made = 1;\n"],
    ["delete", "src/old.ts", "Deleted", { newStart: 1, newLines: 0 }, "-const gone = 1;\n"],
    ["rename", "src/moved.ts", "Renamed from src/was.ts", {}, MODIFY_PATCH],
  ];

  it.each(HUNKED)(
    "reviews a %s per hunk, stating the action in words",
    (action, path, label, overrides, patch) => {
      const onDecide = vi.fn();
      const source = action === "rename" ? "src/was.ts" : null;
      render(
        <Review
          diff={diffOf(path, action, [hunk("h1", patch, overrides)], source)}
          onDecide={onDecide}
        />,
      );

      // The action is a sentence, never only the badge letter the card draws.
      expect(el(`[data-zoc-diff-action="${action}"]`)?.textContent).toBe(label);
      expect(el(`[data-zoc-hunk-list="${path}"]`)?.getAttribute("role")).toBe("list");
      // Named for a screen reader by file and line range (R21.5), so "press A here" has a subject.
      expect(el('[data-zoc-hunk-row="h1"]')?.getAttribute("aria-label")).toContain(path);

      fireEvent.click(rowControl("h1", "accept"));
      expect(onDecide).toHaveBeenCalledWith("h1", "accepted");
      expect(decisionOf("h1")).toBe("accepted");
    },
  );

  it("reviews a hunkless rename at file level, and takes that decision back too (R10.14)", () => {
    const onDecide = vi.fn();
    const diff = diffOf("src/renamed.ts", "rename", [], "src/original.ts");
    const view = render(<Review diff={diff} onDecide={onDecide} />);

    // Both ends of the move, and no list: an empty `role="list"` is announced as "list, 0 items", which
    // tells a screen-reader user something is missing here.
    expect(el('[data-zoc-diff-source-path="src/original.ts"]')?.textContent).toBe(
      "src/original.ts → src/renamed.ts",
    );
    expect(el("[data-zoc-hunk-list]")).toBeNull();
    expect(el("[data-zoc-diff-file-decision]")?.getAttribute("data-zoc-diff-file-decision")).toBe(
      "undecided",
    );

    press("[data-zoc-file-accept]");
    expect(onDecide).toHaveBeenCalledWith(FILE_LEVEL_DECISION, "accepted");
    expect(el("[data-zoc-diff-file-decision]")?.getAttribute("data-zoc-diff-file-decision")).toBe(
      "accepted",
    );

    press("[data-zoc-file-accept]");
    expect(onDecide).toHaveBeenLastCalledWith(FILE_LEVEL_DECISION, "undecided");
    view.unmount();

    // And a stale rename offers no file decision at all, on the same terms as a stale hunk: the path may
    // no longer be the one the plan measured.
    render(<Review diff={diff} stale />);
    expect(el("[data-zoc-diff-stale]")).not.toBeNull();
    expect(el("[data-zoc-file-accept]")).toBeNull();
    expect(el("[data-zoc-file-reject]")).toBeNull();
  });

  it("states why a stale file cannot be decided, and offers the action that helps (R10.8)", () => {
    const onRegenerate = vi.fn();
    render(
      <Review
        diff={diffOf("src/stale.ts", "modify", [hunk("h1"), hunk("h2")])}
        stale
        onRegenerate={onRegenerate}
      />,
    );

    expect(el("[data-zoc-diff-stale]")?.textContent).toContain(STALE_COPY);

    // The diff is still readable — a reviewer needs to see what was proposed in order to want it
    // regenerated — and every accept/reject pair is *absent* rather than disabled, because a disabled
    // control asks the reader to work out why it is disabled.
    expect(all("[data-zoc-hunk-row]")).toHaveLength(2);
    expect(all("[data-zoc-hunk-line]").length).toBeGreaterThan(0);
    expect(all("[data-zoc-hunk-accept]")).toHaveLength(0);
    expect(all("[data-zoc-hunk-reject]")).toHaveLength(0);
    expect(all("button").filter((node) => node.hasAttribute("disabled"))).toHaveLength(0);
    // The rows say so themselves, so the reason a control is missing is on the row rather than inferred
    // from the strip several rows above.
    expect(all("[data-zoc-hunk-row]").every((node) => node.hasAttribute("data-locked"))).toBe(true);

    press("[data-zoc-diff-regenerate]");
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("offers no regeneration when the host has none to offer", () => {
    // The affordance is the card's to supply, and it supplies one only for a stale file it can
    // regenerate. A control that fired nothing would be worse than no control.
    render(<Review diff={diffOf("src/stale.ts", "modify", [hunk("h1")])} stale />);
    expect(el("[data-zoc-diff-stale]")).not.toBeNull();
    expect(el("[data-zoc-diff-regenerate]")).toBeNull();
  });

  it("counts what apply would send, and sends what it counted (R10.2, R10.3, R10.8)", () => {
    // The apply count, through the real card and the real store, because the number is the commit point:
    // the footer's sentence, the button's label, and the payload's length are one fact three times, and a
    // test that checked only the sentence would pass against a footer that counted every hunk.
    const diffs = [
      diffOf("src/mixed.ts", "modify", [hunk("h1"), hunk("h2"), hunk("h3")]),
      diffOf("src/renamed.ts", "rename", [], "src/original.ts"),
      diffOf("src/moved.ts", "modify", [hunk("m1"), hunk("m2")]),
    ];
    const plan = planOf(diffs);
    const onApply = vi.fn();
    const view = render(<PlanRow plan={plan} diffs={diffs} onApply={onApply} />);

    expect(el("[data-zoc-plan-tally]")?.textContent).toBe("0 of 6 hunks accepted");
    expect(screen.getByRole("button", { name: "Apply (0)" })).toBeDisabled();

    const open = (path: string): void => {
      press(`[data-zoc-plan-file-trigger="${path}"]`);
    };

    open("src/mixed.ts");
    fireEvent.click(rowControl("h1", "accept"));
    fireEvent.click(rowControl("h2", "reject"));
    // h3 is left undecided on purpose: three states across one file, so the tally has to distinguish
    // them rather than count decisions.
    open("src/renamed.ts");
    press("[data-zoc-file-accept]");
    open("src/moved.ts");
    fireEvent.click(rowControl("m1", "accept"));
    fireEvent.click(rowControl("m2", "accept"));

    // Four accepted of six reviewable changes — the hunkless rename counts as one, because a rename is a
    // decision and "0 of 0" beside an enabled apply button would be nonsense.
    expect(el("[data-zoc-plan-tally]")?.textContent).toBe("4 of 6 hunks accepted");
    expect(el("[data-zoc-plan-stale-count]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply (4)" }));
    expect(onApply.mock.calls[0]?.[0]).toEqual({
      planId: PLAN_ID,
      hunkIds: ["h1", "m1", "m2"],
      acceptedFiles: ["src/renamed.ts"],
      blockedPaths: [],
    });

    // R10.8's second moment: the file moves under the reviewer, minutes into the review, with two of its
    // hunks already accepted.
    view.rerender(
      <PlanRow
        plan={plan}
        diffs={diffs}
        onDisk={new Map([["src/moved.ts", "sha256:changed"]])}
        onApply={onApply}
      />,
    );

    // The stale file leaves the arithmetic entirely — its two accepted hunks and its two reviewable
    // changes both go — and the other two files keep every decision made about them.
    expect(el("[data-zoc-plan-tally]")?.textContent).toBe("2 of 4 hunks accepted");
    expect(el("[data-zoc-plan-stale-count]")?.textContent).toBe("1 stale file");
    fireEvent.click(screen.getByRole("button", { name: "Apply (2)" }));
    expect(onApply.mock.calls[1]?.[0]).toEqual({
      planId: PLAN_ID,
      hunkIds: ["h1"],
      acceptedFiles: ["src/renamed.ts"],
      blockedPaths: ["src/moved.ts"],
    });
  });

  it("blocks apply for a whole review that is stale, and says which action helps", () => {
    // Not "select at least one hunk", which would send the user looking for a control that a stale file
    // does not have. The reason names staleness because `Regenerate` is what they need.
    const diffs = [diffOf("src/only.ts", "modify", [hunk("h1")])];
    render(
      <PlanRow
        plan={planOf(diffs)}
        diffs={diffs}
        onDisk={new Map([["src/only.ts", "sha256:changed"]])}
        onRegenerate={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Apply (0)" })).toBeDisabled();
    expect(el("[data-zoc-plan-apply-reason]")?.textContent).toBe(
      "Every accepted change is in a stale file. Regenerate to review the current content.",
    );
  });
});
