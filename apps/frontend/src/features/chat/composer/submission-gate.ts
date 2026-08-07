/**
 * The pre-submission gate — zoc-agent-chat-rebuild R32.2, R32.6, R32.13, R32.14, R32.15, task 20.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.2 (R32.2, R32.6, R32.13, R32.14, R32.15).
 *
 * R32.13's renderer half: the Chat_Surface evaluates the Capability_Policy *before* submitting a Run, and
 * the Agent_Runtime's verdict governs where the two differ. Which makes this a courtesy check rather than
 * an enforcement point, and the distinction is worth stating because it decides what belongs here. Its
 * job is to refuse a submission that *cannot* succeed, quickly and with a reason, instead of sending it
 * and rendering the runtime's refusal a round trip later.
 *
 * ## Three cases, and one of them is a permit
 *
 * A refusal-only reading of R32.14 and R32.15 gets the third backwards. `Ask` with no workspace root is
 * **permitted** (R32.6) — a question about code the user has open in another window is a legitimate Run,
 * and refusing it would make the mode useless in the case it exists for. So the carve-out is expressed as
 * a predicate over the mode rather than as an exception inside a refusal, which is the shape
 * `modeRequiresWorkspace` had in the legacy panel and the reason it is re-authored here rather than
 * rewritten.
 *
 * ## Every refusal keeps the composer enabled
 *
 * R32.14 and R32.15 both say so, and it is not a UI detail: the two refusals are things the user can fix
 * in one action — pick a different mode, open a folder — and a disabled composer would hide the draft
 * they would fix it for. So a refusal is a *reason to show*, never a reason to disable, and
 * {@link SubmissionRefusal} carries no "disabled" flag for a caller to misread.
 *
 * ## Why the message never names a path
 *
 * The same rule the runtime's envelopes follow (R32.12): these strings are rendered verbatim, and a
 * workspace root in one of them would put an absolute filesystem path in a screenshot. The sentence names
 * the *mode*, which is what the user has to change.
 */

import { checkCapability } from "@zoc-studio/agent-runtime/policy";
import type { ConversationMode } from "@zoc-studio/shared-types";

import { validateMessage, MAX_MESSAGE_LENGTH } from "@/lib/composer-validate";

/** The codes a pre-submission refusal can carry. Both are the runtime's own. */
export const SUBMISSION_CODES = {
  invalidRequest: "invalid_request",
  noWorkspace: "no_workspace",
  emptyDraft: "empty_draft",
  draftTooLong: "draft_too_long",
} as const;

export type SubmissionCode = (typeof SUBMISSION_CODES)[keyof typeof SUBMISSION_CODES];

export interface SubmissionRefusal {
  readonly permitted: false;
  readonly code: SubmissionCode;
  /** Rendered verbatim. Free of identifiers and filesystem paths (R32.12). */
  readonly message: string;
}

export interface SubmissionPermit {
  readonly permitted: true;
  /** The mode the Run will be submitted with — the selected one, always (R32.2). */
  readonly mode: ConversationMode;
}

export type SubmissionVerdict = SubmissionPermit | SubmissionRefusal;

export interface SubmissionInput {
  /** The composer's selected mode. May be an arbitrary string: R32.14 is about exactly that case. */
  readonly mode: string;
  /** The resolved workspace root, or null/empty when none is open. */
  readonly workspaceRoot: string | null;
  readonly draft: string;
}

/** The three modes, named in the R32.14 sentence so a user is told what to pick instead. */
const MODES: readonly ConversationMode[] = ["ask", "plan", "agent"];

function isConversationMode(value: string): value is ConversationMode {
  return (MODES as readonly string[]).includes(value);
}

/**
 * Whether a mode needs a workspace root (R32.6, R32.15).
 *
 * Derived from the Capability_Policy rather than hard-coded: a mode that may write or execute needs
 * somewhere to do it, and a mode that may only ever read does not. `Plan` qualifies through its
 * post-approval verdict, which is the correct reading — a plan whose approval could never be acted on is
 * not a plan.
 */
export function modeRequiresWorkspace(mode: ConversationMode): boolean {
  return (
    checkCapability(mode, false, "write").permitted ||
    checkCapability(mode, true, "write").permitted
  );
}

/** The label a sentence uses for a mode. Capitalised, because the control's items are. */
function modeLabel(mode: ConversationMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    case "agent":
      return "Agent";
  }
}

/**
 * Whether this submission can be sent, and why not.
 *
 * Ordered so the answer is the most actionable one. An out-of-range mode is checked first because every
 * later check would be reasoning about a mode that does not exist; the draft is checked before the
 * workspace because an empty composer is not a mode problem.
 */
export function checkSubmission(input: SubmissionInput): SubmissionVerdict {
  if (!isConversationMode(input.mode)) {
    return {
      permitted: false,
      code: SUBMISSION_CODES.invalidRequest,
      // Names the three, because "invalid mode" leaves the user to guess what is valid (R32.14).
      message: `That is not a mode Zoc AI offers. Choose ${MODES.map(modeLabel).join(", ")}.`,
    };
  }

  const validation = validateMessage(input.draft);
  if (!validation.valid) {
    return validation.reason === "empty"
      ? {
          permitted: false,
          code: SUBMISSION_CODES.emptyDraft,
          // Rendered by nothing: `SendControl` disables silently on an empty draft, because a user who
          // has typed nothing does not need to be told they have typed nothing.
          message: "Type something to send.",
        }
      : {
          permitted: false,
          code: SUBMISSION_CODES.draftTooLong,
          message: `That message is ${String(validation.length)} characters. The limit is ${String(
            MAX_MESSAGE_LENGTH,
          )}.`,
        };
  }

  const hasWorkspace = (input.workspaceRoot ?? "").trim().length > 0;
  if (!hasWorkspace && modeRequiresWorkspace(input.mode)) {
    return {
      permitted: false,
      code: SUBMISSION_CODES.noWorkspace,
      // Names the mode rather than the missing path: the path is the thing the user does not have, and
      // the mode is the thing they can change (R32.15, R32.12).
      message: `${modeLabel(input.mode)} needs a folder open. Open one, or switch to ${modeLabel("ask")}.`,
    };
  }

  return { permitted: true, mode: input.mode };
}

/**
 * Whether a refusal is one the composer shows a sentence for.
 *
 * `empty_draft` is the exception: the control is simply inert until something is typed, and a sentence
 * there would be the panel narrating the obvious on every empty draft.
 */
export function refusalIsWorthStating(verdict: SubmissionVerdict): boolean {
  return !verdict.permitted && verdict.code !== SUBMISSION_CODES.emptyDraft;
}
