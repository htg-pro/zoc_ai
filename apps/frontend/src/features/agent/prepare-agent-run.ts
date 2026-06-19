/**
 * prepare-agent-run.ts — the pure Composer run-decision function.
 *
 * `prepareAgentRun` is the single, side-effect-free decision point that the
 * rewired Composer submit path (task 4.1) calls before touching the transport.
 * Given the raw Composer input and the current Ask/Agent toggle, it decides
 * whether a run should be issued and, if so, produces exactly one run request:
 *
 *   - It trims the input.
 *   - If the trimmed input is empty / whitespace-only (or otherwise fails the
 *     shared guard), it produces NO run request and signals rejection by
 *     returning `null` (Requirement 4.5).
 *   - Otherwise it produces exactly one `AgentRunRequest` carrying the trimmed
 *     input and the selected `mode` ∈ {ask, agent} (Requirements 4.1, 4.2).
 *
 * Validation is NOT duplicated here. The single validation point is
 * `validateMessage` from `@/lib/composer-validate` — the same guard the
 * pre-merge Composer used — so empty/whitespace-only (and over-length) input
 * is rejected by exactly one rule across the app.
 *
 * The return shape aligns with `AgentRunRequest` from the sibling
 * `gateway-client.ts`, so the result can be handed straight to `postAgentRun`
 * without any reshaping.
 *
 * Requirements: 4.1 (Ask → mode=ask), 4.2 (Agent → mode=agent),
 * 4.5 (reject empty/whitespace-only input, send no request).
 */

import { validateMessage } from "@/lib/composer-validate";
import type { AgentMode, AgentRunRequest } from "./gateway-client";

export type { AgentMode, AgentRunRequest } from "./gateway-client";

const EDIT_INTENT_RE =
  /\b(add|apply|build|change|create|debug|delete|edit|fix|generate|implement|install|modify|move|patch|refactor|remove|rename|repair|replace|resolve|run|scaffold|test|update|write)\b/i;

const QUESTION_OR_CHAT_RE =
  /^(hi|hello|hey|yo|thanks|thank you|what\b|why\b|how\b|where\b|when\b|who\b|which\b|can you explain\b|could you explain\b|explain\b|summari[sz]e\b|tell me\b)/i;

/**
 * Agent mode is for mutating/build tasks. Plain greetings and read-only code
 * questions should still produce a chat answer, even if the toggle was left on
 * Agent from the previous task.
 */
export function routeModeForPrompt(input: string, mode: AgentMode): AgentMode {
  if (mode !== "agent") {
    return mode;
  }
  const text = input.trim();
  if (!text) {
    return mode;
  }
  if (EDIT_INTENT_RE.test(text)) {
    return "agent";
  }
  if (QUESTION_OR_CHAT_RE.test(text) || text.endsWith("?")) {
    return "ask";
  }
  return mode;
}

/**
 * Decide whether the given Composer input should start a run.
 *
 * @param input The raw Composer message text (untrimmed).
 * @param mode  The current Ask/Agent toggle value.
 * @returns Exactly one {@link AgentRunRequest} carrying the trimmed input and
 *          `mode` when the input is sendable; `null` when the input is
 *          empty/whitespace-only (or otherwise invalid) and no run request
 *          should be produced.
 */
export function prepareAgentRun(input: string, mode: AgentMode): AgentRunRequest | null {
  // Single validation point — do not duplicate the empty/whitespace rule.
  if (!validateMessage(input).valid) {
    return null;
  }
  // Exactly one request, carrying the trimmed input and the selected mode.
  const trimmed = input.trim();
  return { input: trimmed, mode: routeModeForPrompt(trimmed, mode) };
}
