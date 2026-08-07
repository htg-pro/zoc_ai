/**
 * The approval broker — zoc-agent-chat-rebuild R11.7, R11.9, R32.9.
 *
 * Feature: zoc-agent-chat-rebuild, R11.7, R11.9, R32.9.
 *
 * Holds the pending approval requests a Run is blocked on, so the HTTP route can
 * resolve one from outside the tool call that opened it. The deferred lives here
 * rather than in the route because the route is stateless and the Run is not.
 *
 * **One endpoint carries both decision kinds**, discriminated by `kind`: the
 * per-tool approval and the coarser Plan_Approval. That is why this module and
 * `plan-gate.ts` are adjacent — a second route would duplicate the 409 and 410
 * handling for no gain.
 *
 * The three status codes the route needs come from this module's return values
 * rather than from route-level bookkeeping:
 *   - `"resolved"` → 200
 *   - `"already-decided"` → 409, because a second decision on one request is a
 *     client bug worth surfacing rather than a no-op worth hiding
 *   - `"expired"` → 410, distinct from 409 because the request *was* valid and
 *     the user simply took too long, which is a different thing to tell them
 */

import {
  createDeferredWithDeadline,
  type PlanApprovalBroker,
  type PlanApprovalOutcome,
  type PlanDecision,
} from "./plan-gate.ts";
import type { ApprovalBroker, ApprovalOutcome, GrantScope } from "./gate.ts";

export type DecisionResult = "resolved" | "already-decided" | "expired" | "unknown";

/** A pending request, as the surface's dock needs to render it. */
export interface PendingApproval {
  readonly requestId: string;
  readonly runId: string;
  readonly toolName: string;
  readonly reason: string;
  readonly paths: readonly string[];
  readonly offeredScopes: readonly GrantScope[];
  readonly expiresAt: string;
}

interface Entry {
  readonly pending: PendingApproval;
  readonly deferred: ReturnType<typeof createDeferredWithDeadline<ApprovalOutcome>>;
}

export interface ApprovalRegistry extends ApprovalBroker, PlanApprovalBroker {
  /** Resolve a per-tool approval. */
  decideTool(requestId: string, decision: "approve" | "reject", scope: GrantScope): DecisionResult;
  /** Resolve a Plan_Approval. */
  decidePlan(runId: string, planId: string, decision: PlanDecision): DecisionResult;
  /** Everything currently blocking, for the dock and for diagnostics. */
  pending(): readonly PendingApproval[];
  /** Drop everything for a Run, called when the Run reaches a terminal state. */
  releaseRun(runId: string): void;
}

export function createApprovalRegistry(options: { runId: string }): ApprovalRegistry {
  const tools = new Map<string, Entry>();
  const plans = new Map<
    string,
    ReturnType<typeof createDeferredWithDeadline<PlanApprovalOutcome>>
  >();
  const expiredTools = new Set<string>();
  const decidedTools = new Set<string>();
  const planKey = (runId: string, planId: string) => `${runId}::${planId}`;

  return {
    async request(input) {
      const expiresAt = new Date(Date.now() + input.timeoutMs).toISOString();
      const deferred = createDeferredWithDeadline<ApprovalOutcome>(input.timeoutMs, () => {
        expiredTools.add(input.requestId);
        return { decision: "timeout", scope: "call" };
      });
      tools.set(input.requestId, {
        pending: {
          requestId: input.requestId,
          runId: options.runId,
          toolName: input.toolName,
          reason: input.reason,
          paths: input.paths,
          offeredScopes: input.offeredScopes,
          expiresAt,
        },
        deferred,
      });
      try {
        return await deferred.promise;
      } finally {
        tools.delete(input.requestId);
      }
    },

    decideTool(requestId, decision, scope) {
      const entry = tools.get(requestId);
      if (entry === undefined) {
        // Ordering matters: an expired request must read as 410, not 409, and
        // both must beat "unknown".
        if (expiredTools.has(requestId)) return "expired";
        if (decidedTools.has(requestId)) return "already-decided";
        return "unknown";
      }
      if (entry.deferred.settled()) {
        return expiredTools.has(requestId) ? "expired" : "already-decided";
      }
      // A scope the request did not offer is silently narrowed rather than
      // rejected: the safe reading of an out-of-range scope is the narrowest one,
      // and failing the call would leave the Run blocked on a client bug.
      const honoured = entry.pending.offeredScopes.includes(scope) ? scope : "call";
      decidedTools.add(requestId);
      entry.deferred.resolve({ decision, scope: honoured });
      return "resolved";
    },

    async awaitDecision({ runId, planId, timeoutMs }) {
      const key = planKey(runId, planId);
      const deferred = createDeferredWithDeadline<PlanApprovalOutcome>(timeoutMs, () => ({
        decision: "timeout",
      }));
      plans.set(key, deferred);
      try {
        return await deferred.promise;
      } finally {
        plans.delete(key);
      }
    },

    decidePlan(runId, planId, decision) {
      const deferred = plans.get(planKey(runId, planId));
      if (deferred === undefined) return "unknown";
      if (deferred.settled()) return "already-decided";
      deferred.resolve({ decision });
      return "resolved";
    },

    pending() {
      return [...tools.values()].map((entry) => entry.pending);
    },

    releaseRun(runId) {
      for (const [requestId, entry] of tools) {
        if (entry.pending.runId !== runId) continue;
        entry.deferred.resolve({ decision: "reject", scope: "call" });
        tools.delete(requestId);
      }
      for (const [key, deferred] of plans) {
        if (!key.startsWith(`${runId}::`)) continue;
        deferred.resolve({ decision: "reject" });
        plans.delete(key);
      }
    },
  };
}
