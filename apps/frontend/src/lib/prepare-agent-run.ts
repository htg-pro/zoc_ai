/**
 * prepare-agent-run.ts — the mode vocabulary and the submit-boundary validation gate.
 *
 * Moved here from `features/agent/` by task 25.5, because `lib/model-availability.ts`,
 * `lib/composer-controls.ts`, and `lib/store.ts` all need this vocabulary and 26.1 deletes that tree.
 *
 * ## What deliberately did not move
 *
 * `routeModeForPrompt` and `prepareAgentRun` stayed behind in `features/agent/prepare-agent-run.ts`.
 * `routeModeForPrompt` rewrote a submitted Agent-mode prompt to Ask when it looked like a question — a
 * silent mode downgrade that Amendment 1 / R7.11 forbids, and that 26.1 says is "deliberately not
 * reproduced". `prepareAgentRun` is its only caller. Leaving both in the tree that dies is what makes
 * 26.1 delete them instead of inheriting them.
 *
 * `validateMessage` from `@/lib/composer-validate` remains the single empty/over-length rule; this
 * module calls it rather than restating it.
 *
 * Requirements: 1.4, 1.7, 4.5.
 */

import { validateMessage } from "@/lib/composer-validate";
import type { AgentMode } from "./gateway-client";

export type { AgentMode, AgentRunRequest } from "./gateway-client";

/** The modes the composer may select, as a runtime-checkable set. */
export const AGENT_MODES: readonly AgentMode[] = ["ask", "plan", "agent"] as const;

/** Whether `value` is one of the three supported modes. */
export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}

/**
 * Modes that require a resolved workspace root. Ask is read-only Q&A that
 * writes nothing and needs no directory (R1.7), so it is the one carve-out;
 * Plan reads files to build a plan and stages diffs against real paths, so a
 * root-less Plan run produces a plan about nothing and is refused (R1.4).
 */
export function modeRequiresWorkspace(mode: AgentMode): boolean {
  return mode !== "ask";
}

export type RunRequestCheck =
  | { ok: true; mode: AgentMode }
  | { ok: false; code: string; message: string };

/**
 * Validate a run submission before it reaches the transport (Phase 2B).
 *
 * Checks the three things that can actually be wrong at this boundary and that
 * previously failed deeper in the stack with an unhelpful message: an
 * unrecognised mode, an empty message, and Plan/Agent mode with no workspace
 * open. Ask is allowed without a workspace because it never reads or writes the
 * project (R1.7).
 *
 * Returning a code plus a user-readable sentence — rather than throwing — is
 * what lets the composer show the reason and stay enabled.
 */
export function validateRunRequest(params: {
  input: string;
  mode: unknown;
  workspaceRoot: string | null | undefined;
}): RunRequestCheck {
  if (!isAgentMode(params.mode)) {
    return {
      ok: false,
      code: "invalid_request",
      message: "That chat mode is not available. Pick Ask, Plan, or Agent.",
    };
  }
  if (!validateMessage(params.input).valid) {
    return {
      ok: false,
      code: "invalid_request",
      message: "Type a message before sending.",
    };
  }
  if (modeRequiresWorkspace(params.mode) && !(params.workspaceRoot ?? "").trim()) {
    return {
      ok: false,
      code: "no_workspace",
      message: `No workspace is open. Open a project folder before using ${
        params.mode === "plan" ? "Plan" : "Agent"
      } mode.`,
    };
  }
  return { ok: true, mode: params.mode };
}
