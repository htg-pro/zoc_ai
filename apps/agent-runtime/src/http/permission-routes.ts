/**
 * Permission HTTP surface — zoc-agent-chat-rebuild R11.7, R11.9, R32.9.
 *
 * Feature: zoc-agent-chat-rebuild, R11.7, R11.9, R32.9.
 *
 * Three routes:
 *
 *   POST /v1/runs/:id/approvals   — one endpoint, two decision kinds
 *   GET  /v1/permissions/audit    — Settings → Security reads the log back
 *   POST /v1/classify-intent      — the composer's cautious-mode warning
 *
 * The `kind` discriminant on the approvals body is what lets one route carry both
 * the per-tool approval and the coarser Plan_Approval. A second route would
 * duplicate the 409 and 410 handling and give a client two shapes to learn for
 * one concept.
 *
 * `/v1/classify-intent` exists so the composer's pre-flight warning and the gate's
 * forced-approval check run the **same** ruleset. A client-side copy of the
 * patterns would drift, and the direction it would drift is the dangerous one: a
 * composer that stops warning about something the gate still blocks.
 */

import { z } from "zod";

import { detectDestructiveIntent } from "../permissions/destructive-intent.ts";
import { rewritesVcsHistory } from "../permissions/gate.ts";
import type { ApprovalRegistry, DecisionResult } from "../permissions/approvals.ts";
import { ErrorCode, HttpError, envelope } from "./errors.ts";
import { json, type Router } from "./routes.ts";
import { readJsonBody, validate } from "./validate.ts";

const approvalBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    requestId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    scope: z.enum(["call", "run", "workspace"]).default("call"),
  }),
  z.object({
    kind: z.literal("plan"),
    planId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
  }),
]);

const classifyBodySchema = z.object({
  text: z.string().max(20_000),
});

/** What the permission routes need from the run registry. */
export interface PermissionRoutesDeps {
  /** The approval registry for a Run, or null when the Run is unknown/finished. */
  approvalsFor(runId: string): ApprovalRegistry | null;
  /** The runtime-side audit log, newest last. */
  auditEntries(limit: number): ReadonlyArray<Record<string, unknown>>;
}

function statusFor(result: DecisionResult): number {
  switch (result) {
    case "resolved":
      return 200;
    case "already-decided":
      return 409;
    case "expired":
      return 410;
    case "unknown":
      return 404;
  }
}

function throwFor(result: DecisionResult): never {
  switch (result) {
    case "already-decided":
      throw HttpError.conflict(ErrorCode.ALREADY_DECIDED, "That request has already been decided.");
    case "expired":
      throw HttpError.gone(
        ErrorCode.DECISION_WINDOW_EXPIRED,
        "That request expired before it was decided, so the action was cancelled.",
      );
    case "unknown":
      throw HttpError.notFound(ErrorCode.NOT_FOUND, "There is no pending request with that id.");
    case "resolved":
      // Not reachable: the caller checks for `resolved` first. Throwing rather
      // than falling through keeps the exhaustiveness real.
      throw new HttpError(500, envelope(ErrorCode.INTERNAL, "Unexpected approval state."));
  }
}

export function registerPermissionRoutes(router: Router, deps: PermissionRoutesDeps): void {
  router.post("/v1/runs/:id/approvals", async ({ req, res, params }) => {
    const runId = params.id as string;
    const body = validate(
      approvalBodySchema,
      await readJsonBody(req, 64 * 1024),
      "approval decision",
    );

    const registry = deps.approvalsFor(runId);
    if (registry === null) {
      throw HttpError.notFound(
        ErrorCode.RUN_NOT_FOUND,
        "That run is not active, so there is nothing to approve.",
      );
    }

    const result =
      body.kind === "tool"
        ? registry.decideTool(body.requestId, body.decision, body.scope)
        : registry.decidePlan(runId, body.planId, body.decision);

    if (result !== "resolved") throwFor(result);
    json(res, statusFor(result), { ok: true, decision: body.decision });
  });

  router.get("/v1/permissions/audit", ({ res, query }) => {
    const requested = Number.parseInt(query.get("limit") ?? "200", 10);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 200;
    json(res, 200, { entries: deps.auditEntries(limit) });
  });

  router.post("/v1/classify-intent", async ({ req, res }) => {
    const body = validate(
      classifyBodySchema,
      await readJsonBody(req, 64 * 1024),
      "intent classification",
    );
    const intent = detectDestructiveIntent(body.text);
    json(res, 200, {
      destructive: intent.destructive || rewritesVcsHistory(body.text),
      matched: intent.matched,
      rewritesVcsHistory: rewritesVcsHistory(body.text),
    });
  });
}
