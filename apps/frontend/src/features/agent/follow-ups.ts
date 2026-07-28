/**
 * follow-ups.ts — derive the suggested next prompts shown after a run settles
 * (R21.1, R21.3).
 *
 * Pure and bounded: at most {@link MAX_FOLLOW_UPS} chips, each carrying
 * non-empty prompt text, derived only from the run's own outcome. When nothing
 * useful can be derived the result is empty, so the renderer shows no chips
 * (R21.3). Chips are attached to the `run-summary` row's `runId` by the caller,
 * so a new run's rows replace them (R21.4).
 */
import type { RunPhase } from "./run-lifecycle";
import type { ReportedStage } from "./stage-report";

export interface FollowUpChip {
  id: string;
  label: string;
  prompt: string;
}

export const MAX_FOLLOW_UPS = 3;

export interface FollowUpSummary {
  outcome: RunPhase;
  filesChanged: number;
  failedStage: ReportedStage | null;
  checksFailed: boolean;
}

/** Derive zero to three follow-up chips from a terminal run outcome. */
export function deriveFollowUps(summary: FollowUpSummary): readonly FollowUpChip[] {
  const chips: FollowUpChip[] = [];

  const add = (id: string, label: string, prompt: string): void => {
    if (chips.length >= MAX_FOLLOW_UPS) return;
    if (prompt.trim().length === 0) return;
    if (chips.some((chip) => chip.id === id)) return;
    chips.push({ id, label, prompt });
  };

  switch (summary.outcome) {
    case "done": {
      if (summary.checksFailed) {
        add("fix-checks", "Fix failing checks", "Fix the failing checks from that run.");
      }
      if (summary.filesChanged > 0) {
        add("review-changes", "Review the changes", "Walk me through the changes you just made.");
        add("write-tests", "Add tests", "Add tests covering the changes you just made.");
      } else {
        add("explain", "Explain the result", "Explain what you found and why no files changed.");
      }
      break;
    }
    case "failed": {
      if (summary.failedStage) {
        add(
          "retry-stage",
          "Retry and explain",
          `Retry, and explain what went wrong in the ${summary.failedStage} stage.`,
        );
      } else {
        add("retry", "Retry", "Try that again.");
      }
      add("diagnose", "Diagnose the failure", "Explain why that run failed and how to fix it.");
      break;
    }
    case "cancelled":
    case "interrupted": {
      add("resume", "Resume", "Continue where you left off.");
      break;
    }
    default:
      break;
  }

  return chips.slice(0, MAX_FOLLOW_UPS);
}
