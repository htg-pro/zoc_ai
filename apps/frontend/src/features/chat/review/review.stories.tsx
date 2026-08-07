/**
 * The plan and diff review surface — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * This is the surface where a look-check is worth most, because it is the one a user acts on: R10.2's
 * whole premise is that a reviewer can see what they are about to accept. Two of its states are
 * indistinguishable in an assertion and must not be on screen — a hunk nobody has decided yet, and a hunk
 * *locked* because its file changed underneath. One is waiting for the user; the other cannot be waited
 * for. `Hunks` puts them adjacent.
 *
 * The plan card writes hunk decisions to the chat-local store rather than through a handler, so `Plan`
 * below is live — accept a hunk and the footer's tally moves. `DiffReview` takes its decisions as a prop,
 * so that story holds them in `useState` instead. The split is the components' own, not the stories'.
 */
import { useState } from "react";
import type { Story } from "@ladle/react";

import type { HunkAction } from "@zoc-studio/shared-types";
import { StoryFrame, Variant } from "../story-frame";
import { DIFFS, DIFF_FRESH, DIFF_STALE, PLAN, RECEIPT } from "../story-fixtures";
import { FILE_LEVEL_DECISION, type HunkDecision } from "../store";
import { ActionBadge } from "./ActionBadge";
import { DiffReview } from "./DiffReview";
import { HunkRow } from "./HunkRow";
import { PlanRow } from "./PlanRow";

export default { title: "Chat / Review" };

const ACTIONS: readonly HunkAction[] = ["create", "modify", "delete", "rename"];

/** Digests that disagree with `DIFF_FRESH.baseDigest` — R10.8's *second* moment, the file changing mid-read. */
const DRIFTED = new Map([[DIFF_FRESH.path, "sha256:0000"]]);

/**
 * A body past `HUNK_COLLAPSE_LINES` (40), which is the only way the collapse exists on screen.
 *
 * Built here rather than in `story-fixtures.ts` because nothing else needs it, and a 48-line string
 * pasted into the fixtures module would be the largest thing in it for the smallest reason.
 */
const LONG_HUNK = {
  hunkId: "h-long",
  oldStart: 1,
  oldLines: 44,
  newStart: 1,
  newLines: 48,
  patch: [
    "@@ -1,44 +1,48 @@",
    ...Array.from({ length: 44 }, (_, index) =>
      index % 9 === 3
        ? `+  const row${String(index)} = rowsOfMessage(messages[${String(index)}]);`
        : `   const kept${String(index)} = cache.get(${String(index)});`,
    ),
    "+  return EMPTY_ROWS;",
    "+  // and three more lines past the fold",
    "+  // so the disclosure has something to disclose",
  ].join("\n"),
};

/**
 * The whole card, in the four states a plan passes through.
 *
 * `applied` is the one that changes what the card *is* rather than how it looks — R10.15 replaces the
 * review with its receipt, and the receipt is a partial one because a clean receipt needs no reading.
 */
export const Plan: Story = () => (
  <StoryFrame brief="Accept a hunk in the first variant: the footer's tally is the answer to 'what will Apply do', and it must never lag the rows.">
    <Variant
      label="under review"
      note="One file has no diff yet, and one is a hunkless rename (R10.3)."
      width={820}
    >
      <PlanRow
        plan={PLAN}
        diffs={DIFFS}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onRegenerate={() => undefined}
      />
    </Variant>
    <Variant
      label="a file drifted on disk"
      note="R10.8's second moment: the digest changed while the plan was being read, so this file cannot be applied."
      width={820}
    >
      <PlanRow
        plan={PLAN}
        diffs={DIFFS}
        onDisk={DRIFTED}
        onApply={() => undefined}
        onDiscard={() => undefined}
        onRegenerate={() => undefined}
      />
    </Variant>
    <Variant
      label="applied — partial receipt"
      note="R10.15 and R16.7: the card becomes the receipt, and offers rollback."
      width={820}
    >
      <PlanRow plan={PLAN} diffs={DIFFS} receipt={RECEIPT} onRollback={() => undefined} />
    </Variant>
    <Variant
      label="read-only viewer"
      note="R1.4: the tally stays, both controls and every hunk decision go. Nothing here can be pressed."
      width={820}
    >
      <PlanRow plan={PLAN} diffs={DIFFS} readOnly />
    </Variant>
  </StoryFrame>
);

/**
 * One file's diff, with the decisions held locally so the accept and reject paths are walkable.
 *
 * The stale variant is the R10.4 check: the file-level `Regenerate` is offered *instead of* the hunk
 * decisions, not beside them, because deciding hunks against a body that no longer matches the file is
 * the mistake the lock exists to prevent.
 */
export const Diff: Story = () => {
  const [decisions, setDecisions] = useState<Readonly<Record<string, HunkDecision>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <StoryFrame brief="Decide a hunk, then the file. The file-level decision must visibly govern the hunks rather than sitting beside them.">
      <Variant label="fresh" width={820}>
        <DiffReview
          diff={DIFF_FRESH}
          stale={false}
          decisions={decisions}
          isExpanded={(hunkId) => expanded.has(hunkId)}
          onDecideHunk={(hunkId, decision) => {
            setDecisions((current) => ({ ...current, [hunkId]: decision }));
          }}
          onDecideFile={(decision) => {
            setDecisions((current) => ({ ...current, [FILE_LEVEL_DECISION]: decision }));
          }}
          onExpandedChange={(hunkId, next) => {
            setExpanded((current) => {
              const updated = new Set(current);
              if (next) updated.add(hunkId);
              else updated.delete(hunkId);
              return updated;
            });
          }}
          onRegenerate={() => undefined}
        />
      </Variant>
      <Variant
        label="stale"
        note="R10.4: the hunks are locked and Regenerate is the only move."
        width={820}
      >
        <DiffReview
          diff={DIFF_STALE}
          stale
          decisions={{}}
          isExpanded={() => false}
          onDecideHunk={() => undefined}
          onDecideFile={() => undefined}
          onExpandedChange={() => undefined}
          onRegenerate={() => undefined}
        />
      </Variant>
      <Variant label="read-only" note="No controls at all — not disabled ones (R1.4)." width={820}>
        <DiffReview
          diff={DIFF_FRESH}
          stale={false}
          decisions={{ h1: "accepted" }}
          isExpanded={() => false}
          onDecideHunk={() => undefined}
          onDecideFile={() => undefined}
          onExpandedChange={() => undefined}
          readOnly
        />
      </Variant>
    </StoryFrame>
  );
};

/**
 * The hunk row on its own: every decision, the lock, and the 40-line fold.
 *
 * Undecided and locked sit next to each other deliberately. Both are rows the user has not accepted, and
 * only one of them is still their move.
 */
export const Hunks: Story = () => {
  const [open, setOpen] = useState(false);
  const hunk = DIFF_FRESH.hunks[0];
  if (hunk === undefined) return <StoryFrame brief="The fixture diff no longer carries a hunk." />;
  return (
    <StoryFrame brief="Compare undecided against locked. If they read the same, a reviewer will wait for a row that is never coming to them.">
      {(["undecided", "accepted", "rejected"] as const).map((decision) => (
        <Variant key={decision} label={decision} width={780}>
          <HunkRow
            path={DIFF_FRESH.path}
            action="modify"
            hunk={hunk}
            decision={decision}
            expanded={false}
            onExpandedChange={() => undefined}
            onDecide={() => undefined}
          />
        </Variant>
      ))}
      <Variant
        label="locked"
        note="The file is stale. Undecidable, and the rest of the plan is not."
        width={780}
      >
        <HunkRow
          path={DIFF_STALE.path}
          action="modify"
          hunk={hunk}
          decision="undecided"
          locked
          expanded={false}
          onExpandedChange={() => undefined}
          onDecide={() => undefined}
        />
      </Variant>
      <Variant
        label={open ? "long body — expanded" : "long body — folded at 40 lines"}
        note="Toggle it. The fold keeps a long file's plan card scrollable; the disclosure has to say how much is hidden."
        width={780}
      >
        <HunkRow
          path={DIFF_FRESH.path}
          action="modify"
          hunk={LONG_HUNK}
          decision="undecided"
          expanded={open}
          onExpandedChange={setOpen}
          onDecide={() => undefined}
        />
      </Variant>
    </StoryFrame>
  );
};

/** The four actions. `rename` is the only one that names two paths, which is why it has a badge at all. */
export const Actions: Story = () => (
  <StoryFrame brief="Four actions at their shipped size. `delete` must be findable without reading it.">
    <Variant label="every action">
      <div className="flex items-center gap-3">
        {ACTIONS.map((action) => (
          <ActionBadge key={action} action={action} />
        ))}
      </div>
    </Variant>
  </StoryFrame>
);
