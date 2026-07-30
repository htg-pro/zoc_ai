/**
 * `propose_plan` — zoc-agent-chat-rebuild R10.1, R10.9, R11.5, R32.8, R32.9.
 *
 * The plan tool the registry declares and does not implement. It lives here
 * rather than in `registry.ts` because it is the one tool whose `execute` writes
 * a Message_Part and can *pause*: in `Plan` mode it hands control to 8.4's plan
 * gate and awaits a decision inside `execute`, which keeps one Run one stream
 * with one `seq` space (R32.9). `registry.ts` stays free of both the writer and
 * the approval broker.
 *
 * ## Why the plan is a tool call rather than an `Output.object()` generation
 *
 * `plan-output.ts` owns the schema and a one-retry generation helper, and both
 * are still the right shape for a dedicated plan *request*. But the plan the loop
 * produces mid-Run has to arrive as a step the model chose to take — the loop
 * decides when it knows enough to plan — and a tool call is the only construct
 * that lets the model make that decision. The schema is shared, so a plan
 * produced either way validates identically.
 *
 * ## Three things happen in a fixed order, and the order is the contract
 *
 *   1. **Validate**, including the duplicate-path rule the JSON schema cannot
 *      express. A malformed plan comes back as a tool *result* the model can fix,
 *      not a thrown error that ends the Run — the model's next attempt is the
 *      retry, so `generatePlanWithOneRetry`'s policy is not duplicated here.
 *   2. **Declare the paths** the plan touches, before any write can be attempted.
 *      This is what R11.5's out-of-plan-path check reads; declaring after the
 *      gate would leave a window in which the plan is approved and the path set
 *      is still empty, so every write in it would look out-of-plan.
 *   3. **Write the plan part, then pause.** `planGated` writes before it awaits,
 *      so the user is deciding about a plan already rendered in front of them.
 */

import { tool, type Tool } from "ai";
import type { PlanFile } from "@zoc-studio/shared-types";

import { PlanInvalidError, planSchema, validatePlan } from "../agent/plan-output.ts";
import type { PlanGateResult } from "../permissions/plan-gate.ts";

/** The plan tool's registry name. Matches `mode_router.py`'s vocabulary. */
export const PLAN_TOOL = "propose_plan";

/** The plan as the writer takes it — `PartPayload<PlanPart>`, structurally. */
export interface PlanRecord {
  readonly planId: string;
  readonly title: string;
  readonly files: PlanFile[];
  readonly verificationCommand?: string | null;
}

export interface PlanToolDeps {
  /**
   * Emit the plan part. `RunWriter.plan` bound to the Run.
   *
   * Typed structurally rather than as `RunWriter` so this module needs neither
   * the writer's class nor its `seq` machinery to be testable.
   */
  writePlan(plan: PlanRecord): unknown;
  /**
   * 8.4's plan gate. Pauses for a decision in `Plan` mode and passes straight
   * through in the other two, so this module has no mode branch of its own.
   */
  planGated(input: {
    planId: string;
    writePlan: () => void | Promise<void>;
  }): Promise<PlanGateResult>;
  /** Record the plan's declared paths for R11.5's out-of-plan-path check. */
  declarePaths(paths: readonly string[]): void;
  /** Injected in tests so a plan id is assertable. */
  newPlanId?(): string;
}

let planCounter = 0;

function nextPlanId(): string {
  planCounter += 1;
  return `plan_${Date.now().toString(36)}_${planCounter.toString(36)}`;
}

/**
 * Every path a plan puts under the out-of-plan-path check.
 *
 * A rename declares **both** ends. Declaring only the target would make the
 * removal of the source an out-of-plan write, which forces an approval prompt on
 * exactly the half of a rename the user already approved.
 */
export function declaredPathsOf(files: readonly PlanFile[]): readonly string[] {
  const paths: string[] = [];
  for (const file of files) {
    paths.push(file.path);
    if (typeof file.sourcePath === "string" && file.sourcePath.length > 0) {
      paths.push(file.sourcePath);
    }
  }
  return [...new Set(paths)];
}

/**
 * The refusal shape a malformed or rejected plan returns to the model.
 *
 * `ok: false` rather than a throw, for the same reason every workspace failure
 * is a result: the model can act on a message and cannot act on a dead Run.
 */
export interface PlanToolRefusal {
  readonly ok: false;
  readonly approved: false;
  readonly planId: string | null;
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly retryable: false;
}

export interface PlanToolAccepted {
  readonly ok: true;
  readonly approved: true;
  readonly planId: string;
  readonly fileCount: number;
  readonly message: string;
}

export type PlanToolResult = PlanToolAccepted | PlanToolRefusal;

export function createProposePlanTool(deps: PlanToolDeps): Tool {
  const mintId = deps.newPlanId ?? nextPlanId;

  return tool({
    description:
      "Propose a multi-file change plan before writing anything. Every file you " +
      "intend to change must appear here first, with its line counts and a " +
      "one-sentence rationale. In Plan mode this pauses for the user's approval " +
      "and returns whether it was granted.",
    inputSchema: planSchema,
    execute: async (input): Promise<PlanToolResult> => {
      let draft;
      try {
        draft = validatePlan(input);
      } catch (cause) {
        if (!(cause instanceof PlanInvalidError)) throw cause;
        return {
          ok: false,
          approved: false,
          planId: null,
          code: cause.code,
          message: cause.message,
          detail: cause.detail,
          retryable: false,
        };
      }

      const planId = mintId();
      // Before the gate, deliberately: see the header's step 2.
      deps.declarePaths(declaredPathsOf(draft.files));

      const outcome = await deps.planGated({
        planId,
        writePlan: () => {
          deps.writePlan({
            planId,
            title: draft.title,
            files: draft.files,
            verificationCommand: draft.verificationCommand,
          });
        },
      });

      if (!outcome.ok) {
        return {
          ok: false,
          approved: false,
          planId: outcome.planId,
          code: outcome.code,
          message: outcome.message,
          retryable: false,
        };
      }

      return {
        ok: true,
        approved: true,
        planId,
        fileCount: draft.files.length,
        message:
          "The plan was accepted. Apply it with " + `workspace_apply_hunks using planId ${planId}.`,
      };
    },
  });
}
