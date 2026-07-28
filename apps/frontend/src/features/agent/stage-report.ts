/**
 * stage-report.ts — the six user-facing stages and a fold from wire stage events.
 *
 * The Gateway FSM has nine internal stages; the run stream projects them onto
 * six reported stages and emits one `StageEvent { stage, state, reason }` per
 * entry (design §6, gateway `stage_view.py`). The frontend never infers a stage
 * from thinking text (the retired `stageFromText` heuristic) — it folds the
 * ordered stage events into a well-formed six-stage report for the stage strip.
 *
 * The fold maintains the same invariants the Gateway projection guarantees, so
 * the strip is always renderable regardless of how partial the event history is
 * (R7.1–R7.4):
 *   - all six stages present, each with exactly one state,
 *   - at most one stage ACTIVE,
 *   - a stage that reached SUCCEEDED never leaves it,
 *   - a FAILED stage always carries a non-empty reason.
 */

export const REPORTED_STAGES = [
  "analyze",
  "plan",
  "edit",
  "check",
  "review",
  "summary",
] as const;

export type ReportedStage = (typeof REPORTED_STAGES)[number];

export type StageState = "pending" | "active" | "succeeded" | "failed" | "skipped";

export interface StageReport {
  stage: ReportedStage;
  state: StageState;
  /** Required (non-empty) when `state` is `failed` (R7.3); otherwise null. */
  reason: string | null;
}

/** The wire shape of a stage event, read defensively from the run stream. */
export interface StageEventLike {
  stage: ReportedStage;
  state: StageState;
  reason?: string | null;
}

const REPORTED_STAGE_SET: ReadonlySet<string> = new Set(REPORTED_STAGES);

export function isReportedStage(value: unknown): value is ReportedStage {
  return typeof value === "string" && REPORTED_STAGE_SET.has(value);
}

const STAGE_STATES: ReadonlySet<string> = new Set<StageState>([
  "pending",
  "active",
  "succeeded",
  "failed",
  "skipped",
]);

export function isStageState(value: unknown): value is StageState {
  return typeof value === "string" && STAGE_STATES.has(value);
}

const DEFAULT_FAILURE_REASON = "Stage failed";

/**
 * Fold ordered stage events into a well-formed six-stage report.
 *
 * `succeeded` is absorbing (Property 15); entering a stage `active` demotes any
 * previously active stage to `succeeded`, so at most one stage is ever active.
 */
export function foldStageReports(
  events: readonly StageEventLike[],
): StageReport[] {
  const state = new Map<ReportedStage, StageState>();
  const reason = new Map<ReportedStage, string>();
  for (const stage of REPORTED_STAGES) state.set(stage, "pending");

  for (const event of events) {
    if (!isReportedStage(event.stage) || !isStageState(event.state)) continue;
    const stage = event.stage;
    // `succeeded` is absorbing: once a stage succeeds it never reports otherwise.
    if (state.get(stage) === "succeeded") continue;

    if (event.state === "active") {
      for (const other of REPORTED_STAGES) {
        if (other !== stage && state.get(other) === "active") {
          state.set(other, "succeeded");
        }
      }
      state.set(stage, "active");
    } else {
      state.set(stage, event.state);
      if (event.state === "failed") {
        const text = (event.reason ?? "").trim();
        reason.set(stage, text.length > 0 ? text : DEFAULT_FAILURE_REASON);
      }
    }
  }

  return REPORTED_STAGES.map((stage) => {
    const s = state.get(stage) ?? "pending";
    return {
      stage,
      state: s,
      reason: s === "failed" ? reason.get(stage) ?? DEFAULT_FAILURE_REASON : null,
    };
  });
}

/** The stage marked active in a report, if any. */
export function activeStage(report: readonly StageReport[]): ReportedStage | null {
  return report.find((entry) => entry.state === "active")?.stage ?? null;
}

/** The first failed stage in a report, if any. */
export function failedStage(report: readonly StageReport[]): StageReport | null {
  return report.find((entry) => entry.state === "failed") ?? null;
}
