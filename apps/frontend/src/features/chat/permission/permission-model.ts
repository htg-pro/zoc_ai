/**
 * The approval dock's model — zoc-agent-chat-rebuild R11.7, R11.8, R11.9, R21.3, task 19.1.
 *
 * Which request is pending, how long it has left, what its scopes and reason are called, and the
 * accessible name R21.3 asks for. Split from the components for the reason the rest of the feature
 * splits: Properties 18 and 55 are claims about *which* request is on screen and *what it announces*,
 * and neither should have to mount a dock to be asserted.
 *
 * ## Why the pending request is derived rather than stored
 *
 * A `PermissionRequestPart` is reconciled in place by id — the runtime re-emits it with `decision` set
 * once a decision lands — so "is this request still pending" is a fact about the transcript rather than
 * about the surface. Keeping a copy in the store would mean two sources for one answer, and the copy is
 * the one that goes stale when a decision arrives from another window (R1.4's shared Session) or when
 * the runtime times the request out (R11.9).
 *
 * `pendingApprovalId` in the store is not that copy: it is the *focus* bookkeeping — which request the
 * dock has already moved focus to — which is genuinely surface state and cannot be derived from a part.
 *
 * ## Why one request at a time
 *
 * The gate awaits a decision before the tool call proceeds, and a Run runs one tool call at a time, so a
 * Session has at most one pending request in M1. The oldest is rendered rather than the newest so that a
 * queue, if M2's parallel Runs ever produce one, drains in the order the requests were asked — a stack
 * would leave the first question unanswered longest.
 */

import type { PermissionRequestPart } from "@zoc-studio/shared-types";

import type { ZocUIMessage } from "../wire/ui-message";

/** R11.9's window. The runtime owns the timeout; this is what the countdown counts down to. */
export const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

export type ApprovalScope = "call" | "run" | "workspace";

/** The narrowest scope, and the default a grant starts at. */
export const DEFAULT_SCOPE: ApprovalScope = "call";

/**
 * The chip labels, in the order the dock offers them: narrowest first.
 *
 * "This call" rather than "Once" because the unit is the call and a user should be able to tell that
 * approving twice is two decisions. R11.7 names all three.
 */
export const SCOPE_LABELS: Readonly<Record<ApprovalScope, string>> = {
  call: "This call",
  run: "This run",
  workspace: "This workspace",
};

/** What each scope actually grants, for the chip's accessible description. */
export const SCOPE_DESCRIPTIONS: Readonly<Record<ApprovalScope, string>> = {
  call: "Allow this one call and ask again next time.",
  run: "Allow this tool for the rest of this run.",
  workspace: "Allow this tool in this workspace until you change it.",
};

/**
 * Why the request exists (R11.2, R11.5, R11.6).
 *
 * Named rather than omitted because the three reasons are the difference between "you asked to be
 * asked" and "this would have happened without asking if it were not dangerous" — and only the second
 * justifies interrupting a user who chose `auto`.
 */
export const REASON_LABELS: Readonly<Record<PermissionRequestPart["reason"], string>> = {
  "mode-ask": "Approval mode is on",
  "out-of-plan-path": "Outside the plan's paths",
  destructive: "Destructive action",
};

/** Whether a request is still awaiting a decision. */
export function isPending(request: PermissionRequestPart): boolean {
  return request.decision === null || request.decision === undefined;
}

/** Milliseconds left before the runtime cancels the call (R11.9). Never negative. */
export function remainingMs(request: PermissionRequestPart, now: number): number {
  const expires = Date.parse(request.expiresAt);
  // An unparseable deadline reads as the full window rather than as expired: the runtime is the thing
  // that times a request out, and a surface that hid the controls over a malformed timestamp would
  // make an answerable question unanswerable.
  if (!Number.isFinite(expires)) return APPROVAL_WINDOW_MS;
  return Math.max(0, expires - now);
}

/** Whether the window has closed. The runtime's timeout part is the authority; this is the display. */
export function hasExpired(request: PermissionRequestPart, now: number): boolean {
  return remainingMs(request, now) === 0;
}

/**
 * `m:ss left`, or `expired`.
 *
 * Seconds are zero-padded and minutes are not, which is how a clock reads. Rounded *up*, so a request
 * with 900 ms left shows `0:01 left` rather than `0:00 left` beside two live buttons.
 */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "expired";
  const seconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${rest.toString().padStart(2, "0")} left`;
}

/**
 * R21.3's accessible name: the requested tool and every affected path.
 *
 * *Every* path, not a count and not a truncation. The visible row middle-truncates a long path and
 * collapses past three into a count, because a dock is one line — but a screen-reader user deciding
 * whether to approve a write needs the paths, and "and 4 more" is exactly the information they are being
 * asked about. The visible collapse and this name therefore disagree on purpose.
 */
export function approvalAccessibleName(request: PermissionRequestPart): string {
  const reason = REASON_LABELS[request.reason];
  if (request.paths.length === 0) {
    return `Approve ${request.toolName}? ${reason}.`;
  }
  const paths = request.paths.join(", ");
  const noun = request.paths.length === 1 ? "path" : "paths";
  return `Approve ${request.toolName}? ${reason}. Affected ${noun}: ${paths}.`;
}

/** The scopes to offer, narrowest first, ignoring anything the runtime did not offer (R11.7). */
export function offeredScopesOf(request: PermissionRequestPart): readonly ApprovalScope[] {
  const order: readonly ApprovalScope[] = ["call", "run", "workspace"];
  const offered = new Set(request.offeredScopes);
  const kept = order.filter((scope) => offered.has(scope));
  // A request offering none is a request that can still be approved for this one call: the gate always
  // permits the narrowest grant, and rendering no chips at all would read as "no way to say yes".
  return kept.length === 0 ? [DEFAULT_SCOPE] : kept;
}

/** Every permission part in a message list, oldest first by `seq`. */
export function permissionRequestsOf(
  messages: readonly ZocUIMessage[],
): readonly PermissionRequestPart[] {
  const requests: PermissionRequestPart[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-zoc-permission") requests.push(part.data);
    }
  }
  // Sorted rather than assumed: parts arrive in `seq` order within a Run, and a restored transcript
  // interleaves Runs. A stable sort keeps two requests with one `seq` in arrival order.
  return [...requests].sort((a, b) => a.seq - b.seq);
}

/**
 * The request the dock should render, or `null`.
 *
 * Undecided *and* unexpired. An expired request is left to the runtime's timeout part rather than
 * rendered with dead controls — R11.9 makes the cancellation the runtime's, and a dock still asking a
 * question the runtime has already answered is worse than a dock that has moved on.
 */
export function pendingRequestOf(
  messages: readonly ZocUIMessage[],
  now: number,
): PermissionRequestPart | null {
  for (const request of permissionRequestsOf(messages)) {
    if (isPending(request) && !hasExpired(request, now)) return request;
  }
  return null;
}
