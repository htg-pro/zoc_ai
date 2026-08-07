/**
 * The compact-now route — zoc-agent-chat-rebuild R34.4, R34.5, design.md:2496.
 *
 * Feature: zoc-agent-chat-rebuild, R34.4, R34.5.
 *
 * ```
 * POST /v1/sessions/:id/compact
 *   { }                            no body fields: the Session's own model and
 *                                  history are the entire input (R34.8)
 *   → 200 { compactionId, foldedTurnCount, contextTokensBefore, contextTokensAfter }
 *   → 404 { code: "not_found" }
 *   → 409 { code: "compaction_run_active" }
 *   → 409 { code: "compaction_not_needed" }
 *   → 502 { code: "compaction_failed", retryable: true }
 * ```
 *
 * **`POST` on the Session, not on a Run.** Compaction is a property of the
 * Session — R34.4 says "the active Session" — and a Run is the thing it must not
 * overlap. That is also why the route answers with the record's figures: a manual
 * fold has no stream for the caller to read the outcome from.
 *
 * Everything the route needs that it cannot compute — whether a Run is streaming,
 * the Session's assembled request, and a writer and summariser bound to the
 * Session's own model — arrives through {@link CompactionRouteDeps}. That keeps
 * the run store (9.3), the message store, and the provider registry out of this
 * file, and it is what lets the route be tested without any of the three.
 */

import { compactNow, type AssembledRequest, type CompactionContext } from "../agent/compaction.ts";
import { ErrorCode, HttpError } from "./errors.ts";
import { json, type Router } from "./routes.ts";

/** A Session prepared for a manual fold. */
export interface CompactionTarget {
  /**
   * The request as it would be assembled for the Session's next Run.
   *
   * The manual path measures the same thing the automatic one does, so the
   * figures the route returns describe the context the next Run will actually
   * dispatch rather than a hypothetical one.
   */
  readonly request: AssembledRequest;
  /**
   * The writer and summariser for this fold.
   *
   * The writer is the one-shot described at design.md:2511 — over the Session's
   * most recent `runId` with a fresh `messageId`, seeded past that Run's last
   * emitted `seq` so R7.7's whole-Run sequence invariant still holds. The
   * summariser is bound to the Session's own model (R34.8), which is what keeps a
   * local Session's fold on loopback.
   */
  readonly context: CompactionContext;
}

export interface CompactionRouteDeps {
  /** Whether a Run is streaming on this Session (9.3's run store). */
  hasActiveRun(sessionId: string): boolean;
  /** The fold's inputs, or `null` when the Session is unknown. */
  prepare(sessionId: string): Promise<CompactionTarget | null>;
}

export function registerCompactionRoutes(router: Router, deps: CompactionRouteDeps): void {
  router.post("/v1/sessions/:id/compact", async ({ res, params }) => {
    const sessionId = params.id as string;

    // Checked before the request is assembled: assembling context for a Session
    // that must not be folded is work thrown away, and the surface disables the
    // control while a Run streams, so reaching here is the race, not the norm.
    if (deps.hasActiveRun(sessionId)) {
      throw HttpError.conflict(
        ErrorCode.COMPACTION_RUN_ACTIVE,
        "This session has a run in progress. Compaction can start once it finishes.",
      );
    }

    const target = await deps.prepare(sessionId);
    if (target === null) {
      throw HttpError.notFound(ErrorCode.NOT_FOUND, "There is no session with that id.");
    }

    const outcome = await compactNow(target.context, sessionId, target.request);

    switch (outcome.kind) {
      case "folded": {
        const record = outcome.record;
        if (record === undefined) {
          // Unreachable: `folded` carries a record by construction. Throwing
          // rather than asserting keeps that a checked fact.
          throw HttpError.badGateway(
            ErrorCode.COMPACTION_FAILED,
            "The conversation was compacted but the record could not be read back.",
          );
        }
        json(res, 200, {
          compactionId: record.compactionId,
          foldedTurnCount: record.foldedTurnCount,
          contextTokensBefore: record.contextTokensBefore,
          contextTokensAfter: record.contextTokensAfter,
        });
        return;
      }

      // `insufficient-history` cannot arise from `compactNow` — it declines only
      // when nothing is foldable — but both mean the same thing to the caller, so
      // both answer with the same 409 rather than leaving one unhandled.
      case "not-needed":
      case "insufficient-history":
        throw HttpError.conflict(
          ErrorCode.COMPACTION_NOT_NEEDED,
          "This conversation is short enough that there is nothing to compact yet.",
        );

      case "failed":
        throw HttpError.badGateway(
          ErrorCode.COMPACTION_FAILED,
          "The conversation could not be summarised, so nothing was changed.",
          outcome.error?.message,
        );
    }
  });
}
