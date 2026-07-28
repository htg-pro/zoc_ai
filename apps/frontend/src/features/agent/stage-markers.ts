/**
 * stage-markers.ts — the FSM's synthetic stage markers, recognised in one place.
 *
 * When the run FSM enters `ERROR_CLOSED` it reports the terminal close as a
 * `command` event whose `command` is a marker, not a shell command:
 *
 *     { type: "command", command: "<stage:error_closed>", errorTag: "…" }
 *
 * (See `default_stage_event_factory` in the gateway's `fsm.py` and
 * `_SYNTHETIC_STAGE_PREFIX` in `app.py`.) The frame is contract-conforming and
 * the session diary parses it back into a stage, so it stays on the bus — but
 * any renderer that prints `event.command` verbatim shows the user a literal
 * `<stage:error_closed>` where an explanation belongs.
 *
 * The rule lived only inside `rows.tsx`, which is a component module. The
 * folded-trace path (`agent-trace.ts`) is pure and cannot import React, so it
 * had no way to share the rule and leaked the raw marker. Keeping the predicate
 * here — with no React dependency — lets both paths agree.
 */

/** Prefix of every synthetic stage marker emitted in a `command` event. */
export const SYNTHETIC_STAGE_PREFIX = "<stage:";

/**
 * Whether a `command` event carries a synthetic stage marker rather than a real
 * command.
 *
 * Deliberately anchored to the start of the string: a genuine command that
 * merely *mentions* a marker (`echo '<stage:x>'`) is a real command and must
 * still render as one.
 */
export function isSyntheticStageCommand(command: string | null | undefined): boolean {
  return typeof command === "string" && command.startsWith(SYNTHETIC_STAGE_PREFIX);
}
