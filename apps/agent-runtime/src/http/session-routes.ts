/**
 * The Session title route — zoc-agent-chat-rebuild R6.2, R15.3, R15.12, 9.7.
 *
 * ```
 * POST /v1/sessions/:id/title
 *   { }                        the Session's own messages and model are the
 *                              entire input
 *   → 200 { title }
 *   → 404 { code: "not_found" }
 *   → 409 { code: "title_not_needed" }
 *   → 502 { code: "title_generation_failed", retryable: true }
 * ```
 *
 * **It is on the runtime because it is a provider call (R6.2).** Naming a Session
 * from its messages is inference, so it sits beside `/v1/inline-edit` and
 * `/v1/completions` rather than on Workspace_Services — and it runs on the
 * Session's *own* selected model, which is R34.8's constraint applied to a second
 * call: a Session on `local-llamacpp` must not start reaching the network in order
 * to name itself.
 *
 * **No Workspace_Services client appears in {@link SessionRoutesDeps}, and that is
 * the point.** R15.12's runtime half is "the Gateway is not involved", and the way
 * to hold that is for this module to have no way to reach it, rather than for a
 * later reader to notice it should not.
 *
 * **R15.3's auto-title is this same route.** One title generator, called once after
 * the first message persists and again whenever the user regenerates — not a
 * client-side heuristic for the first title and a model call for the rest.
 */

import { ErrorCode, HttpError } from "./errors.ts";
import { json, type Router } from "./routes.ts";

/**
 * The longest title that reaches the wire.
 *
 * Enforced here as well as in the instruction because the instruction is a request
 * and this is a guarantee: a model that answers with a paragraph must not be able
 * to make a Session row unreadable, and the Session list has no other defence.
 */
export const MAX_TITLE_CHARS = 80;

export type TitleOutcome =
  | { readonly kind: "titled"; readonly title: string }
  /** The Session has no messages yet (R15.12). */
  | { readonly kind: "not-needed" }
  | { readonly kind: "failed"; readonly error?: { readonly message?: string } };

export interface SessionRoutesDeps {
  /**
   * Generate a title from the Session's messages, or `null` when there is no such
   * Session.
   *
   * Returns an outcome rather than throwing, matching `compactNow`: "the Session is
   * empty" and "the model call failed" are both ordinary results of asking, and a
   * caller that has to catch to distinguish them will eventually catch one as the
   * other.
   */
  generateTitle(sessionId: string): Promise<TitleOutcome | null>;
}

/**
 * Trim, collapse, and clip one line of title.
 *
 * A model asked for a short title returns quotation marks, a trailing full stop, a
 * leading "Title:", or a newline often enough that stripping them is part of the
 * contract rather than a nicety — the alternative is a Session list where a third
 * of the rows are quoted and the rest are not.
 */
export function tidyTitle(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const unlabelled = oneLine.replace(/^(?:title|session)\s*[:\-—]\s*/i, "");
  const unquoted = unlabelled.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  const unstopped = unquoted.replace(/[.!?]+$/, "").trim();
  return unstopped.length > MAX_TITLE_CHARS
    ? `${unstopped.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : unstopped;
}

export function registerSessionRoutes(router: Router, deps: SessionRoutesDeps): void {
  router.post("/v1/sessions/:id/title", async ({ res, params }) => {
    const sessionId = params.id as string;
    const outcome = await deps.generateTitle(sessionId);

    if (outcome === null) {
      throw HttpError.notFound(ErrorCode.NOT_FOUND, "There is no session with that id.");
    }

    switch (outcome.kind) {
      case "not-needed":
        throw HttpError.conflict(
          ErrorCode.TITLE_NOT_NEEDED,
          "This conversation has no messages yet, so there is nothing to name it after.",
        );

      case "failed":
        throw HttpError.badGateway(
          ErrorCode.TITLE_GENERATION_FAILED,
          "The title could not be generated, so the current one is unchanged.",
          outcome.error?.message,
        );

      case "titled": {
        const title = tidyTitle(outcome.title);
        if (title.length === 0) {
          // An empty answer is a failed one. Reporting success with `""` would leave
          // the Session apparently renamed to nothing, which R15.12 explicitly rules
          // out — a Session is never left untitled.
          throw HttpError.badGateway(
            ErrorCode.TITLE_GENERATION_FAILED,
            "The title could not be generated, so the current one is unchanged.",
            "the model returned no usable text",
          );
        }
        json(res, 200, { title });
        return;
      }
    }
  });
}
