/**
 * Hunk selection and staleness — zoc-agent-chat-rebuild R10.2, R10.3, R10.8, R10.9, task 18.1.
 *
 * What apply sends, and what a file changing on disk does to it. Deliberately a module of pure
 * functions: every claim R10.2, R10.3, R10.8, and R10.9 make is arithmetic over a plan, its diffs, and
 * the decision map, and none of it needs a rendered tree — which is what lets Properties 20, 21, and 22
 * assert against the real selection rather than against a component's idea of it.
 *
 * ## Three rules that look like details and are not
 *
 * **A stale file blocks itself and nothing else (R10.8).** One file changing under review must not
 * strand the rest of the plan; a reviewer who has accepted eleven hunks across four files should not
 * lose the eleven because the fifth file was touched. So staleness is per diff, and the blocked paths
 * are reported alongside the selection rather than replacing it.
 *
 * **`undecided` is the default and it is not `rejected` (R10.3).** They differ in what the footer says:
 * a plan with nothing decided reads "0 of 12 hunks accepted" and apply is disabled with a reason,
 * whereas a plan whose hunks were all explicitly rejected is a review the user finished. Both select
 * nothing, and conflating them would lose that distinction.
 *
 * **A pure rename has no hunks, so "at least one accepted hunk" is the wrong test.** A rename's whole
 * change is in the path, so its `DiffPart` legitimately carries zero hunks and its acceptance is a
 * file-level decision under the store's reserved {@link FILE_LEVEL_DECISION} key. That is why
 * {@link ApplySelection} carries `acceptedFiles` beside `hunkIds`, and why apply is enabled when
 * *either* is non-empty.
 *
 * ## The digest sentinel, and why absence is not emptiness
 *
 * A `create` diff is generated against a file that does not exist. Its `baseDigest` is
 * {@link ABSENT_DIGEST} rather than the digest of an empty string, so "the file was not there" and "the
 * file was there and was empty" are different facts — which is exactly what rollback needs to know to
 * choose between deleting a created file and truncating one (R10.15).
 */

import type { DiffPart, HunkAction, PlanPart } from "@zoc-studio/shared-types";

import { FILE_LEVEL_DECISION, type HunkDecisions } from "../store";

/**
 * The `baseDigest` a diff for a not-yet-existing file carries.
 *
 * A fixed sentinel rather than `sha256("")`, so a `create` whose target appeared under the user's feet
 * is detectable: the file now has a real digest, which differs from this, so the diff is stale and
 * apply is blocked for it rather than silently overwriting a file the plan never saw.
 */
export const ABSENT_DIGEST = "absent";

export interface ApplySelection {
  readonly planId: string;
  /** Accepted hunk ids from files that are not stale, in plan order. */
  readonly hunkIds: readonly string[];
  /** Paths accepted at the file level — a hunkless rename, and nothing else today. */
  readonly acceptedFiles: readonly string[];
  /** Paths whose diff is stale. Reported, not silently dropped: the card offers `Regenerate`. */
  readonly blockedPaths: readonly string[];
}

/**
 * A diff is stale when the file's current digest differs from the one it was generated against.
 *
 * Two sources, and the wire flag comes first: the runtime may already know the file moved (it holds the
 * lock and watches the tree), and a surface with no digest for the path would otherwise report a stale
 * diff as fresh. A path *absent* from `onDisk` is not stale — absence means "not measured here", and
 * treating unmeasured as changed would block every apply on a surface that has not yet read digests.
 * The one case where absence is meaningful, a `create`, is carried by {@link ABSENT_DIGEST} instead.
 */
export function isStale(diff: DiffPart, onDisk: ReadonlyMap<string, string>): boolean {
  if (diff.stale) return true;
  const current = onDisk.get(diff.path);
  return current !== undefined && current !== diff.baseDigest;
}

/**
 * What apply should carry: accepted hunks from files that are not stale (R10.2, R10.3, R10.8).
 *
 * `decisions` is the store's whole map rather than the plan's slice, and the plan id is read from
 * `plan`. One argument fewer to get wrong at a call site, and the alternative — passing
 * `decisions[planId]` — is a silent empty selection when a caller passes the wrong plan's slice.
 */
export function applicableHunks(
  plan: PlanPart,
  diffs: readonly DiffPart[],
  decisions: HunkDecisions,
  onDisk: ReadonlyMap<string, string>,
): ApplySelection {
  const planDecisions = decisions[plan.planId] ?? {};
  const hunkIds: string[] = [];
  const acceptedFiles: string[] = [];
  const blockedPaths: string[] = [];

  for (const diff of diffs) {
    if (diff.planId !== plan.planId) continue;
    if (isStale(diff, onDisk)) {
      blockedPaths.push(diff.path);
      continue;
    }
    const fileDecisions = planDecisions[diff.path] ?? {};
    for (const hunk of diff.hunks) {
      if (fileDecisions[hunk.hunkId] === "accepted") hunkIds.push(hunk.hunkId);
    }
    // The file-level decision travels only for a change that has no hunks to carry it. A modify whose
    // hunks were all rejected must not be applied because the *file* was ticked at some earlier point.
    if (diff.hunks.length === 0 && fileDecisions[FILE_LEVEL_DECISION] === "accepted") {
      acceptedFiles.push(diff.path);
    }
  }

  return { planId: plan.planId, hunkIds, acceptedFiles, blockedPaths };
}

/** Whether apply has anything to do. R10.3's "only the accepted Hunks", read as a precondition. */
export function applyEnabled(selection: ApplySelection): boolean {
  return selection.hunkIds.length > 0 || selection.acceptedFiles.length > 0;
}

/**
 * Why apply is disabled, as a sentence, or `null` when it is not.
 *
 * The reason is stated rather than the control silently doing nothing: a disabled button with no
 * explanation is a control that teaches the user the panel is broken. Staleness is named first when it
 * is the only thing standing in the way, because `Regenerate` is then the action the user wants and
 * "select at least one hunk" would send them looking for a checkbox that cannot help.
 */
export function applyDisabledReason(selection: ApplySelection): string | null {
  if (applyEnabled(selection)) return null;
  if (selection.blockedPaths.length > 0) {
    const files = selection.blockedPaths.length === 1 ? "file" : "files";
    return `Every accepted change is in a stale ${files}. Regenerate to review the current content.`;
  }
  return "Select at least one hunk to apply.";
}

export interface ReviewTally {
  /** Hunks accepted across every non-stale file in the plan. */
  readonly accepted: number;
  /** Every reviewable change in the plan: hunks, plus one per hunkless file. */
  readonly total: number;
  readonly rejected: number;
  readonly undecided: number;
  readonly staleFiles: number;
}

/**
 * The footer's `n of m hunks accepted`, counted once so the number beside `Apply` and the number in the
 * sentence cannot disagree.
 *
 * `total` counts a hunkless file as one reviewable change, for the same reason `acceptedFiles` exists: a
 * pure rename is a decision the user has to make, and a plan reading "0 of 0" beside an enabled apply
 * button would be nonsense. Stale files contribute to `staleFiles` and to nothing else — their hunks are
 * not decisions the user can act on until the diff is regenerated.
 */
export function reviewTally(
  plan: PlanPart,
  diffs: readonly DiffPart[],
  decisions: HunkDecisions,
  onDisk: ReadonlyMap<string, string>,
): ReviewTally {
  const planDecisions = decisions[plan.planId] ?? {};
  let accepted = 0;
  let rejected = 0;
  let total = 0;
  let staleFiles = 0;

  for (const diff of diffs) {
    if (diff.planId !== plan.planId) continue;
    if (isStale(diff, onDisk)) {
      staleFiles += 1;
      continue;
    }
    const fileDecisions = planDecisions[diff.path] ?? {};
    if (diff.hunks.length === 0) {
      total += 1;
      if (fileDecisions[FILE_LEVEL_DECISION] === "accepted") accepted += 1;
      else if (fileDecisions[FILE_LEVEL_DECISION] === "rejected") rejected += 1;
      continue;
    }
    for (const hunk of diff.hunks) {
      total += 1;
      if (fileDecisions[hunk.hunkId] === "accepted") accepted += 1;
      else if (fileDecisions[hunk.hunkId] === "rejected") rejected += 1;
    }
  }

  return { accepted, total, rejected, undecided: total - accepted - rejected, staleFiles };
}

/** The plan file for a path, so a diff can render the action the plan declared for it. */
export function planFileOf(plan: PlanPart, path: string): PlanPart["files"][number] | undefined {
  return plan.files.find((file) => file.path === path);
}

/**
 * The action a diff renders as.
 *
 * `DiffPart` carries its own `action`, and the plan carries one per file; they agree in every
 * well-formed plan. The diff wins when they do not, because the diff is the thing being reviewed — a
 * plan row claiming `modify` beside a diff with no pre-change side would be a plan row to fix, not a
 * reason to render the diff wrongly.
 */
export function actionOf(diff: DiffPart): HunkAction {
  return diff.action;
}
