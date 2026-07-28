/**
 * Plan_Approval — zoc-agent-chat-rebuild R10.9, R32.5, R32.7, R32.8, R32.9.
 *
 * The coarse gate, beside the per-tool one. **It is not a second Run.**
 *
 * `planGated` wraps `propose_plan` in `Plan` mode only. It writes the plan part,
 * emits `run-lifecycle{state:"awaiting-approval"}`, and then awaits a deferred
 * **inside** `execute` — the identical mechanism `gated()` uses, for the
 * identical reason: the agent invocation never ends, so one Run stays one stream
 * with one `seq` space and Plan_Approval allocates no second Run identifier.
 *
 * ## Why it is not wrapped in the other two modes
 *
 * - **`Ask`** reaches no approval gate at all (R32.5). There is nothing an
 *   approval could unlock, because `ask:*:write` and `ask:*:execute` are refused
 *   in both approval states.
 * - **`Agent`** already holds every Capability an approval would unlock (R32.10).
 *   Wrapping it there would produce a prompt whose only effect is a delay.
 *
 * ## Why the approve path needs no second code path
 *
 * Approval flips `planApproval.approved` to `true` and resolves the deferred.
 * From that instant the *same* Capability_Policy table permits `write` and
 * `execute` for the remainder of the same Run — `plan:true:write` was already
 * `true`. There is no unlock routine, because the unlock is a table lookup that
 * now reads differently.
 *
 * The reject path resolves the deferred with a refusal rather than leaving it
 * pending, so the loop continues and the Run reports what it *would* have done
 * instead of hanging until the ten-minute deadline.
 */

import { APPROVAL_TIMEOUT_MS, type GateContext } from "./gate.ts";

export type PlanDecision = "approve" | "reject" | "timeout";

export interface PlanApprovalOutcome {
  readonly decision: PlanDecision;
}

/** The registry the HTTP approval route resolves a plan decision against. */
export interface PlanApprovalBroker {
  awaitDecision(input: {
    runId: string;
    planId: string;
    timeoutMs: number;
  }): Promise<PlanApprovalOutcome>;
}

export interface PlanGateContext extends GateContext {
  readonly planBroker: PlanApprovalBroker;
}

/** The shape a rejected or lapsed plan proposal returns to the model. */
export interface PlanRefusal {
  readonly ok: false;
  readonly approved: false;
  readonly planId: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
}

export interface PlanApproved {
  readonly ok: true;
  readonly approved: true;
  readonly planId: string;
}

export type PlanGateResult = PlanApproved | PlanRefusal;

/**
 * Should `propose_plan` be gated for this Run?
 *
 * A predicate rather than an inline `if` at the call site, so the answer is in
 * one place and the two "not wrapped" cases above are asserted directly.
 */
export function planApprovalApplies(mode: GateContext["mode"]): boolean {
  return mode === "plan";
}

/**
 * Wrap the plan proposal in the approval gate.
 *
 * `writePlan` is the caller's plan emission — it runs *before* the pause, so the
 * user has the plan in front of them while deciding. Pausing first and writing
 * afterwards would ask for approval of something not yet rendered.
 */
export function createPlanGate(ctx: PlanGateContext) {
  const timeoutMs = ctx.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;

  return async function planGated(input: {
    planId: string;
    writePlan: () => void | Promise<void>;
  }): Promise<PlanGateResult> {
    // Not gated outside `Plan` mode. `Agent` already holds the Capabilities an
    // approval would unlock; `Ask` can never hold them.
    if (!planApprovalApplies(ctx.mode)) {
      await input.writePlan();
      return { ok: true, approved: true, planId: input.planId };
    }

    await input.writePlan();
    ctx.writer.awaitingApproval(input.planId);

    const outcome = await ctx.planBroker.awaitDecision({
      runId: ctx.runId,
      planId: input.planId,
      timeoutMs,
    });

    if (outcome.decision === "approve") {
      // Transitions at most once, and only forward.
      ctx.planApproval.approved = true;
      ctx.planApproval.planId = input.planId;
      ctx.planApproval.approvedAt = (ctx.now ?? (() => new Date()))().toISOString();
      return { ok: true, approved: true, planId: input.planId };
    }

    // Rejected or lapsed: `planApproval` stays false, so the Capability_Policy
    // continues to refuse `write` and `execute` for the rest of this Run without
    // any further bookkeeping.
    const code = outcome.decision === "timeout" ? "permission_timeout" : "permission_denied";
    const message =
      outcome.decision === "timeout"
        ? "The plan approval timed out, so nothing was changed."
        : "You declined the plan, so nothing was changed.";
    return {
      ok: false,
      approved: false,
      planId: input.planId,
      code,
      message,
      retryable: false,
    };
  };
}

/**
 * A deferred with an attached deadline.
 *
 * Extracted because both brokers need exactly this and the failure mode is
 * subtle: a timer that is not cleared on resolution keeps the process alive past
 * the Run, which in a long-lived supervisor is a slow leak rather than a visible
 * bug.
 */
export function createDeferredWithDeadline<T>(
  timeoutMs: number,
  onTimeout: () => T,
): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  settled: () => boolean;
} {
  let settle: ((value: T) => void) | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<T>((resolvePromise) => {
    settle = (value: T) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolvePromise(value);
    };
    timer = setTimeout(() => settle?.(onTimeout()), timeoutMs);
    // Do not hold the event loop open waiting for an approval nobody will give.
    timer.unref?.();
  });

  return {
    promise,
    resolve: (value: T) => settle?.(value),
    settled: () => settled,
  };
}

/** An in-memory plan-approval broker, one per runtime process. */
export function createPlanApprovalBroker(): PlanApprovalBroker & {
  decide(runId: string, planId: string, decision: PlanDecision): boolean;
  pending(): readonly string[];
} {
  const waiting = new Map<
    string,
    ReturnType<typeof createDeferredWithDeadline<PlanApprovalOutcome>>
  >();
  const keyFor = (runId: string, planId: string) => `${runId}::${planId}`;

  return {
    awaitDecision({ runId, planId, timeoutMs }) {
      const key = keyFor(runId, planId);
      const deferred = createDeferredWithDeadline<PlanApprovalOutcome>(timeoutMs, () => ({
        decision: "timeout",
      }));
      waiting.set(key, deferred);
      return deferred.promise.finally(() => waiting.delete(key));
    },
    /** Returns false when there is nothing waiting — the 409 case at 8.5. */
    decide(runId, planId, decision) {
      const deferred = waiting.get(keyFor(runId, planId));
      if (deferred === undefined || deferred.settled()) return false;
      deferred.resolve({ decision });
      return true;
    },
    pending: () => [...waiting.keys()],
  };
}
