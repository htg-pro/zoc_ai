/**
 * Plan/task progress selectors (R4.8, R9.1, R9.2, R9.3, R9.6).
 *
 * Pure: derives completed-count and the progress-bar fill ratio from the
 * shared `Plan` model. The requirements vocabulary maps onto `PlanStepStatus`:
 *   done       → "done"
 *   in_progress→ "running" | "repairing"
 *   queued     → "pending"
 * A step counts as complete only when its status is exactly `done` (R9.1).
 */
import type { Plan, PlanStep, TodoItem } from "@zoc-studio/shared-types";

export interface PlanProgress {
  /** Number of steps whose status is exactly `done`. */
  done: number;
  /** Total number of steps. */
  total: number;
  /** Fill ratio in [0,1]; 0 when there are no steps. */
  ratio: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function completedCount(steps: PlanStep[]): number {
  return steps.filter((s) => s.status === "done").length;
}

export function planProgress(plan: Plan | null | undefined): PlanProgress {
  const steps = plan?.steps ?? [];
  const total = steps.length;
  const done = completedCount(steps);
  const ratio = total > 0 ? clamp01(done / total) : 0;
  return { done, total, ratio };
}

/** Convenience: the fill ratio as an integer percentage in [0,100]. */
export function progressPercent(plan: Plan | null | undefined): number {
  return Math.round(planProgress(plan).ratio * 100);
}

/**
 * Progress for the agent-authored to-do list (the redesign's live plan).
 * A todo counts as complete only when its status is exactly `completed`,
 * mirroring `planProgress`'s `done`-only rule (R9.1, R9.6).
 */
export function todoProgress(todos: TodoItem[] | null | undefined): PlanProgress {
  const items = todos ?? [];
  const total = items.length;
  const done = items.filter((t) => t.status === "completed").length;
  const ratio = total > 0 ? clamp01(done / total) : 0;
  return { done, total, ratio };
}
