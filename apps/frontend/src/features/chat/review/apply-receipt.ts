/**
 * The apply receipt and the rollback report — zoc-agent-chat-rebuild R10.5, R10.7, R10.15, R16.7,
 * task 18.2.
 *
 * After an apply, the plan card stops being a review and becomes a record: which files were written,
 * under which checkpoint, and what rolling back would do to each of them. This module is that record,
 * as a value — so Property 23's claim ("a partial failure names exactly what was applied") is an
 * assertion about a function rather than about a rendered card.
 *
 * ## Why a partial failure and a clean apply produce the same shape
 *
 * R16.7 asks that a Run failing after some hunks were applied name exactly the files that were written.
 * That is the same question a successful apply answers, reached from the other side — so it is the same
 * receipt with `partial: true` and a different sentence, rather than a second surface. A second surface
 * is how the two drift: the failure path is the one that is rarely seen and easily left behind.
 *
 * ## Why the rollback phrasing is per file rather than a count
 *
 * "Roll back 4 files" is ambiguous in exactly the case R10.15 exists for: rolling back a create
 * *removes* a file, and a user who reads "restore" and gets a deletion has been told the wrong thing.
 * So each file carries its own phrase, derived from the action the plan declared for it.
 *
 * ## What this module does not do
 *
 * It never decides *whether* rollback is possible from the shape of the plan. `rollbackable` is
 * `checkpointId !== null` and at least one file written, because the checkpoint is Workspace_Services'
 * to produce (R10.5) and a surface inferring "there must be a checkpoint" would offer a control that
 * fails when it is pressed.
 */

import type { HunkAction, PlanPart } from "@zoc-studio/shared-types";

export interface AppliedFile {
  readonly path: string;
  /**
   * The action the plan declared. Absent when the applied path is not in the plan at all, which is an
   * upstream bug — and the file is still named, because R16.7 asks what was written rather than what
   * was expected to be written.
   */
  readonly action?: HunkAction;
  /** A rename's origin, so the receipt can name both ends of the move (R10.14). */
  readonly sourcePath?: string;
}

/** What Workspace_Services reported, reduced to what the receipt needs (R10.5, R16.7). */
export interface ApplyOutcome {
  /** Null when no checkpoint was created, which makes the apply unrollbackable and says so. */
  readonly checkpointId: string | null;
  /** Exactly the paths written, in apply order. */
  readonly appliedPaths: readonly string[];
  /** Present when the Run failed after writing some of them (R16.7). */
  readonly error?: { readonly code: string; readonly message: string } | null;
}

export interface ApplyReceipt {
  readonly checkpointId: string | null;
  readonly files: readonly AppliedFile[];
  /** True when the apply stopped part-way: some files written, and a failure to explain. */
  readonly partial: boolean;
  readonly rollbackable: boolean;
  /** One sentence naming what landed. */
  readonly summary: string;
  /** What rolling back does, per file and in plain words. */
  readonly rollbackActions: readonly string[];
  /** The failure's own sentence, when there was one. */
  readonly failure: string | null;
}

/** What rolling back one file does, in the words the control uses. */
export function rollbackPhraseOf(file: AppliedFile): string {
  switch (file.action) {
    case "create":
      return `remove the created ${file.path}`;
    case "delete":
      return `restore the deleted ${file.path}`;
    case "rename":
      return file.sourcePath === undefined
        ? `return ${file.path} to its original path`
        : `return ${file.path} to ${file.sourcePath}`;
    case "modify":
      return `revert the change to ${file.path}`;
    default:
      // No declared action, so the phrase claims the least it can while still naming the file.
      return `revert ${file.path}`;
  }
}

function pluralFiles(count: number): string {
  return count === 1 ? "1 file" : `${String(count)} files`;
}

/**
 * The receipt for an apply, complete or partial.
 *
 * The file list is built from `outcome.appliedPaths` and not from the plan's accepted set: they agree
 * on a clean apply and differ on exactly the failure R16.7 is about, and the receipt has to be right
 * about the failure. Order is apply order for the same reason rollback replays in reverse — a receipt
 * sorted by path would lose the sequence the checkpoint has to undo.
 */
export function applyReceiptOf(plan: PlanPart, outcome: ApplyOutcome): ApplyReceipt {
  const declared = new Map(plan.files.map((file) => [file.path, file]));

  const files: AppliedFile[] = outcome.appliedPaths.map((path) => {
    const planFile = declared.get(path);
    if (planFile === undefined) return { path };
    return {
      path,
      action: planFile.action,
      ...(planFile.sourcePath === null || planFile.sourcePath === undefined
        ? {}
        : { sourcePath: planFile.sourcePath }),
    };
  });

  const failed = outcome.error !== null && outcome.error !== undefined;
  const partial = failed && files.length > 0;
  const rollbackable = outcome.checkpointId !== null && files.length > 0;

  const summary = (() => {
    if (files.length === 0) {
      return failed ? "No file was written." : "Nothing was applied.";
    }
    if (partial) {
      return `Wrote ${pluralFiles(files.length)} of ${pluralFiles(plan.files.length)} before failing.`;
    }
    return `Applied ${pluralFiles(files.length)}.`;
  })();

  return {
    checkpointId: outcome.checkpointId,
    files,
    partial,
    rollbackable,
    summary,
    rollbackActions: files.map(rollbackPhraseOf),
    failure: failed ? (outcome.error?.message ?? "The apply failed.") : null,
  };
}

/**
 * R10.7's sentence: the restored file count and the checkpoint identifier, both named.
 *
 * The count is the number of entries actually replayed rather than the number the receipt listed, so a
 * rollback that could only restore part of the checkpoint reports what it did — the requirement asks
 * for the restored count, and a receipt's count restated would be a claim the rollback did not make.
 */
export function rollbackReport(result: {
  readonly checkpointId: string;
  readonly restoredCount: number;
}): string {
  return `Restored ${pluralFiles(result.restoredCount)} from checkpoint ${result.checkpointId}.`;
}
