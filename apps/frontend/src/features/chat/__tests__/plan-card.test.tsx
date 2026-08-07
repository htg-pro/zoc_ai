/**
 * The plan card and the three non-modify diff shapes — zoc-agent-chat-rebuild R10.1, R10.7, R10.9,
 * R10.11, R10.12, R10.13, R10.14, R10.15, R16.7, task 18.2.
 *
 * The requirement-level claims the three properties do not reach, because each is about what is *drawn*
 * rather than about what is selected: the four action badges, the omitted gutter column on a create and
 * a delete, both paths on a rename, the footer's two numbers agreeing, discard writing nothing, and the
 * receipt a partial failure produces.
 *
 * ## Why the card is driven through the real store
 *
 * `PlanRow` reads `hunkDecisions` and `expanded` from `useChatSurface` by design — a hunk row writes a
 * decision and the footer three levels up reads it, which is the case the store exists for. Injecting a
 * decision map through props to test the footer would test a component that does not exist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PlanRow } from "@/features/chat/review/PlanRow";
import { applyReceiptOf } from "@/features/chat/review/apply-receipt";
import { INITIAL_CHAT_SURFACE_STATE, useChatSurface } from "@/features/chat/store";
import type { DiffPart, Hunk, HunkAction, PlanPart } from "@zoc-studio/shared-types";

const PLAN_ID = "plan_1";

beforeEach(() => {
  useChatSurface.setState(
    { ...INITIAL_CHAT_SURFACE_STATE, expanded: new Set<string>(), hunkDecisions: {} },
    false,
  );
});

afterEach(cleanup);

function hunk(id: string, patch: string, overrides: Partial<Hunk> = {}): Hunk {
  return { hunkId: id, oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, patch, ...overrides };
}

function diffOf(path: string, action: HunkAction, hunks: Hunk[], sourcePath?: string): DiffPart {
  return {
    type: "diff",
    seq: 1,
    runId: "run_1",
    messageId: "msg_1",
    ts: "2026-07-31T10:00:00.000Z",
    agentName: null,
    planId: PLAN_ID,
    path,
    action,
    sourcePath: sourcePath ?? null,
    language: "typescript",
    hunks,
    baseDigest: "sha256:base",
    stale: false,
  };
}

function planOf(diffs: readonly DiffPart[], verify: string | null = "pnpm test --run"): PlanPart {
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
      rationale: "why",
      addedLines: 4,
      removedLines: 2,
      hunkCount: diff.hunks.length,
    })),
    verificationCommand: verify,
  };
}

const MODIFY_PATCH = "-const before = 1;\n+const after = 1;\n+const extra = 2;\n";

function openFile(path: string): void {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(path.replace(".", "\\.")) }));
}

describe("Feature: zoc-agent-chat-rebuild, task 18.2: the plan card", () => {
  it("names the file count, the action, the counts, and the verify line (R10.1, R10.11)", () => {
    const diffs = [
      diffOf("src/a.ts", "modify", [hunk("h1", MODIFY_PATCH)]),
      diffOf("src/b.ts", "create", [hunk("h1", "+const created = 1;\n", { oldLines: 0 })]),
    ];
    render(<PlanRow plan={planOf(diffs)} diffs={diffs} />);

    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("verify: pnpm test --run")).toBeInTheDocument();
    // The badge letter and its shape, per file — the shape is what carries the action without colour.
    expect(document.querySelector('[data-zoc-action-badge="modify"]')).not.toBeNull();
    expect(document.querySelector('[data-zoc-action-shape="create"]')).not.toBeNull();
    // And the action reaches a screen reader as a word, since a spoken "A" means nothing.
    expect(screen.getByRole("button", { name: /^create src\/b\.ts/ })).toBeInTheDocument();
  });

  it("keeps the footer's count and the apply payload the same number", () => {
    const diffs = [
      diffOf("src/a.ts", "modify", [hunk("h1", MODIFY_PATCH), hunk("h2", MODIFY_PATCH)]),
    ];
    const onApply = vi.fn();
    render(<PlanRow plan={planOf(diffs)} diffs={diffs} onApply={onApply} />);

    expect(screen.getByText("0 of 2 hunks accepted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply (0)" })).toBeDisabled();
    expect(screen.getByText("Select at least one hunk to apply.")).toBeInTheDocument();

    openFile("src/a.ts");
    fireEvent.click(document.querySelectorAll("[data-zoc-hunk-accept]")[0] as HTMLElement);

    expect(screen.getByText("1 of 2 hunks accepted")).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Apply (1)" });
    expect(apply).toBeEnabled();

    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toEqual({
      planId: PLAN_ID,
      hunkIds: ["h1"],
      acceptedFiles: [],
      blockedPaths: [],
    });
  });

  it("confirms a discard, then clears the plan's decisions and writes nothing (R10.9)", () => {
    const diffs = [diffOf("src/a.ts", "modify", [hunk("h1", MODIFY_PATCH)])];
    const onDiscard = vi.fn();
    const onApply = vi.fn();
    render(<PlanRow plan={planOf(diffs)} diffs={diffs} onDiscard={onDiscard} onApply={onApply} />);

    openFile("src/a.ts");
    fireEvent.click(document.querySelector("[data-zoc-hunk-accept]") as HTMLElement);
    expect(useChatSurface.getState().hunkDecisions[PLAN_ID]).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    // A confirmation, and it states the fact that makes discarding safe.
    expect(screen.getByText("Discard the plan? Nothing has been written.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(useChatSurface.getState().hunkDecisions[PLAN_ID]).toBeUndefined();
    // The whole of R10.9 at this level: nothing on the discard path can send a hunk id.
    expect(onApply).not.toHaveBeenCalled();
  });

  it("renders a create with no pre-change column (R10.12)", () => {
    const diffs = [
      diffOf("src/new.ts", "create", [
        hunk("h1", "+const created = 1;\n+const also = 2;\n", { oldStart: 1, oldLines: 0 }),
      ]),
    ];
    render(<PlanRow plan={planOf(diffs)} diffs={diffs} />);
    openFile("src/new.ts");

    expect(screen.getByText("New file")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-zoc-line-old]").length).toBe(0);
    expect(document.querySelectorAll("[data-zoc-line-new]").length).toBe(2);
    // The header says which side the zero is on, rather than leaving `@@ -1,0 +1,2 @@` to be decoded.
    expect(screen.getByText("@@ new file, +2 @@")).toBeInTheDocument();
  });

  it("renders a delete with no post-change column (R10.13)", () => {
    const diffs = [
      diffOf("src/gone.ts", "delete", [
        hunk("h1", "-const removed = 1;\n", { newStart: 1, newLines: 0 }),
      ]),
    ];
    render(<PlanRow plan={planOf(diffs)} diffs={diffs} />);
    openFile("src/gone.ts");

    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-zoc-line-new]").length).toBe(0);
    expect(document.querySelectorAll("[data-zoc-line-old]").length).toBe(1);
    expect(screen.getByText("@@ deleted file, −1 @@")).toBeInTheDocument();
  });

  it("shows both ends of a rename, and reviews a hunkless one at file level (R10.14)", () => {
    const diffs = [diffOf("src/new-name.ts", "rename", [], "src/old-name.ts")];
    const onApply = vi.fn();
    render(<PlanRow plan={planOf(diffs)} diffs={diffs} onApply={onApply} />);

    // Both paths on the file row, before the diff is even open.
    expect(screen.getByText("src/old-name.ts → src/new-name.ts")).toBeInTheDocument();

    openFile("src/new-name.ts");
    expect(screen.getByText("Renamed from src/old-name.ts")).toBeInTheDocument();
    expect(screen.getByText("No content change to review.")).toBeInTheDocument();
    // No hunk list at all for zero hunks: an empty `role="list"` announced as "list, 0 items" would
    // tell a screen-reader user there was something to review here and that it is missing. (The plan's
    // own file list is a separate list and is still present, which is why this looks for the hunk one.)
    expect(document.querySelector("[data-zoc-hunk-list]")).toBeNull();
    expect(document.querySelector("[data-zoc-hunk-row]")).toBeNull();

    fireEvent.click(document.querySelector("[data-zoc-file-accept]") as HTMLElement);
    expect(screen.getByText("1 of 1 hunks accepted")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply (1)" }));
    expect(onApply.mock.calls[0]?.[0]).toEqual({
      planId: PLAN_ID,
      hunkIds: [],
      acceptedFiles: ["src/new-name.ts"],
      blockedPaths: [],
    });
  });

  it("blocks a stale file, offers regeneration, and leaves the rest applicable (R10.8)", () => {
    const diffs = [
      diffOf("src/stale.ts", "modify", [hunk("h1", MODIFY_PATCH)]),
      diffOf("src/fresh.ts", "modify", [hunk("h1", MODIFY_PATCH)]),
    ];
    const onRegenerate = vi.fn();
    const onApply = vi.fn();
    render(
      <PlanRow
        plan={planOf(diffs)}
        diffs={diffs}
        onDisk={new Map([["src/stale.ts", "sha256:moved"]])}
        onRegenerate={onRegenerate}
        onApply={onApply}
      />,
    );

    expect(screen.getByText("1 stale file")).toBeInTheDocument();

    openFile("src/fresh.ts");
    fireEvent.click(document.querySelector("[data-zoc-hunk-accept]") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Apply (1)" }));
    expect(onApply.mock.calls[0]?.[0]).toEqual({
      planId: PLAN_ID,
      hunkIds: ["h1"],
      acceptedFiles: [],
      blockedPaths: ["src/stale.ts"],
    });

    openFile("src/stale.ts");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledWith("src/stale.ts");
  });

  it("becomes a receipt naming the applied files and the checkpoint (R10.15)", () => {
    const diffs = [
      diffOf("src/created.ts", "create", [hunk("h1", "+a\n", { oldLines: 0 })]),
      diffOf("src/gone.ts", "delete", [hunk("h1", "-b\n", { newLines: 0 })]),
    ];
    const plan = planOf(diffs);
    const receipt = applyReceiptOf(plan, {
      checkpointId: "ckpt_9f",
      appliedPaths: ["src/created.ts", "src/gone.ts"],
      error: null,
    });
    const onRollback = vi.fn();

    render(<PlanRow plan={plan} diffs={diffs} receipt={receipt} onRollback={onRollback} />);

    expect(screen.getByText("Applied 2 files.")).toBeInTheDocument();
    expect(screen.getByText("checkpoint ckpt_9f")).toBeInTheDocument();
    // The rollback control says what it will do per file, because "roll back 2 files" would describe a
    // deletion as a restore.
    const rollback = screen.getByRole("button", {
      name: /remove the created src\/created\.ts, restore the deleted src\/gone\.ts/,
    });
    fireEvent.click(rollback);
    expect(onRollback).toHaveBeenCalledWith("ckpt_9f");
    // No review controls survive on a receipt: the decision has been made.
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
  });

  it("names exactly what landed when a Run fails part-way (R16.7)", () => {
    const diffs = [
      diffOf("src/one.ts", "modify", [hunk("h1", MODIFY_PATCH)]),
      diffOf("src/two.ts", "modify", [hunk("h1", MODIFY_PATCH)]),
      diffOf("src/three.ts", "modify", [hunk("h1", MODIFY_PATCH)]),
    ];
    const plan = planOf(diffs);
    const receipt = applyReceiptOf(plan, {
      checkpointId: "ckpt_partial",
      appliedPaths: ["src/one.ts"],
      error: { code: "tool_failed", message: "The command failed after the first file." },
    });

    render(<PlanRow plan={plan} diffs={diffs} receipt={receipt} onRollback={() => undefined} />);

    expect(screen.getByText("Wrote 1 file of 3 files before failing.")).toBeInTheDocument();
    expect(screen.getByText("The command failed after the first file.")).toBeInTheDocument();
    expect(document.querySelector('[data-zoc-receipt-file="src/one.ts"]')).not.toBeNull();
    // The two files that were not written are absent — the whole point of the property beside this test.
    expect(document.querySelector('[data-zoc-receipt-file="src/two.ts"]')).toBeNull();
    expect(document.querySelector('[data-zoc-receipt-file="src/three.ts"]')).toBeNull();
    expect(
      screen.getByRole("button", { name: /revert the change to src\/one\.ts/ }),
    ).toBeInTheDocument();
  });

  it("says so rather than offering a rollback that cannot work", () => {
    const diffs = [diffOf("src/a.ts", "modify", [hunk("h1", MODIFY_PATCH)])];
    const plan = planOf(diffs);
    const receipt = applyReceiptOf(plan, {
      checkpointId: null,
      appliedPaths: ["src/a.ts"],
      error: null,
    });

    render(<PlanRow plan={plan} diffs={diffs} receipt={receipt} onRollback={() => undefined} />);

    expect(screen.queryByRole("button", { name: /Roll back/ })).toBeNull();
    expect(
      screen.getByText("No checkpoint was created, so this cannot be rolled back here."),
    ).toBeInTheDocument();
  });
});
