/**
 * Cross-cutting constants mirrored from the agent backend.
 *
 * Keep these in lockstep with their Python counterparts.
 */

/**
 * Error set on a tool call that was cancelled because the agent restarted
 * while it was waiting for the user's approval decision.
 *
 * Mirror of `ORPHANED_APPROVAL_MESSAGE` in
 * `services/agent/src/llama_studio_agent/reconcile.py`. Used by the UI to
 * detect a restart-cancelled approval and offer a one-click retry.
 */
export const ORPHANED_APPROVAL_MESSAGE =
  "approval lost: the agent restarted while this tool call was waiting for" +
  " your decision. Re-run the request to try again.";
