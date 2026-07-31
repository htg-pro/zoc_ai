/**
 * The consequence line — zoc-agent-chat-rebuild R11.10, R32.1, R32.3, R32.4, task 20.2.
 *
 * One muted sentence under the composer's control row, stating what the current *pair* of modes permits.
 * Two three-value controls in one panel is a real confusability problem — Conversation_Mode governs what
 * Zoc AI may attempt at all, Permission_Mode governs what it may do without asking — and the interaction
 * between them is the part a user cannot infer from either label.
 *
 * ## The sentences are derived, not written
 *
 * Nine combinations, and none of them is a string constant. Each sentence is assembled from flags read
 * out of the **Capability_Policy itself** — `checkCapability` from `@zoc-studio/agent-runtime/policy`,
 * the same table the gate enforces — composed with what Permission_Mode does to a capability the policy
 * has already permitted. So the copy cannot promise something the gate refuses, or hide something it
 * allows, and the guard beside this module asserts each sentence against the verdicts it describes.
 *
 * A table of nine strings would have been shorter and would have drifted the first time a policy cell
 * changed, in the direction that matters: a sentence saying "asks before each change" over a mode that
 * has stopped asking.
 *
 * ## The three identical `Ask` sentences are the point
 *
 * Under `Ask` nothing beyond `read` is permitted in either approval state, so Permission_Mode has nothing
 * to gate and all three pairs read the same. Collapsing them to one case would hide exactly that fact,
 * which is the single most useful thing to know about how the two axes interact — so they are produced
 * by the same derivation and are equal *because the policy says so*, which the guard asserts.
 */

import { checkCapability } from "@zoc-studio/agent-runtime/policy";
import type { ConversationMode } from "@zoc-studio/shared-types";

/** The header's axis (R11.1). Mirrors the runtime's `PermissionMode` without importing the gate. */
export type PermissionMode = "ask" | "auto" | "deny";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto", "deny"];

export const CONVERSATION_MODES: readonly ConversationMode[] = ["ask", "plan", "agent"];

export interface ModeConsequence {
  /** May change files with no plan approved — `agent` only, per the policy table. */
  readonly mayChangeNow: boolean;
  /** May change files once a plan is approved — `plan` and `agent`. */
  readonly mayChangeAfterPlanApproval: boolean;
  /** Nothing beyond reading is permitted in either approval state, so Approval is inert. */
  readonly approvalIsInert: boolean;
  /** Permission_Mode is `ask` and there is something for it to ask about. */
  readonly asksFirst: boolean;
  /** Permission_Mode is `deny` and there is something for it to refuse. */
  readonly refusesChanges: boolean;
  /** The line the composer renders. */
  readonly sentence: string;
}

/** What the Conversation_Mode does, before Permission_Mode is composed onto it. */
function attemptClauseOf(mode: ConversationMode): string {
  switch (mode) {
    case "ask":
      return "Answers and reads files.";
    case "plan":
      return "Proposes a plan and reads files.";
    case "agent":
      return "Works on its own.";
  }
}

/**
 * The consequence of one (Conversation_Mode, Permission_Mode) pair.
 *
 * The two capability probes are the whole derivation: `write` with no plan approved, and `write` with one
 * approved. `execute` is not probed separately because the policy grants and withholds the two together
 * in all eighteen cells — and if that ever stops being true, the guard's exhaustive walk is what will say
 * so.
 */
export function modeConsequence(
  mode: ConversationMode,
  permissionMode: PermissionMode,
): ModeConsequence {
  const mayChangeNow = checkCapability(mode, false, "write").permitted;
  const mayChangeAfterPlanApproval = checkCapability(mode, true, "write").permitted;
  const approvalIsInert = !mayChangeNow && !mayChangeAfterPlanApproval;
  const asksFirst = !approvalIsInert && permissionMode === "ask";
  const refusesChanges = !approvalIsInert && permissionMode === "deny";

  const clauses = [attemptClauseOf(mode)];

  if (approvalIsInert) {
    // Named rather than omitted: a user who has just set Approval to `auto` and sees no change in
    // behaviour needs to be told the control is inert here rather than broken.
    clauses.push("It cannot change anything, so Approval does not apply.");
  } else if (refusesChanges) {
    clauses.push("Every change is refused, so it can only read and report.");
  } else if (mode === "plan") {
    clauses.push(
      asksFirst
        ? "Changes wait for you to approve the plan, then ask again for each step."
        : "Once you approve the plan, changes proceed without asking.",
    );
  } else {
    clauses.push(asksFirst ? "It asks before each change." : "It changes files without asking.");
  }

  // R11.6's forced approvals survive `auto`, and that is the one thing a user reading "without asking"
  // most needs qualifying. Only said where it is true: under `ask` everything asks anyway, and under
  // `deny` nothing proceeds.
  if (!approvalIsInert && permissionMode === "auto") {
    clauses.push("Destructive actions still ask.");
  }

  return {
    mayChangeNow,
    mayChangeAfterPlanApproval,
    approvalIsInert,
    asksFirst,
    refusesChanges,
    sentence: clauses.join(" "),
  };
}

/** Every pair, for the guard and for a story that shows all nine at once. */
export function everyModePair(): readonly {
  readonly mode: ConversationMode;
  readonly permissionMode: PermissionMode;
  readonly consequence: ModeConsequence;
}[] {
  return CONVERSATION_MODES.flatMap((mode) =>
    PERMISSION_MODES.map((permissionMode) => ({
      mode,
      permissionMode,
      consequence: modeConsequence(mode, permissionMode),
    })),
  );
}
