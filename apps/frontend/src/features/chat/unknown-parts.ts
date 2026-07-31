/**
 * The unknown-discriminant log — zoc-agent-chat-rebuild R7.6, task 16.3.
 *
 * R7.6 asks for three things when a Message_Part arrives with a discriminant the surface does
 * not know: a neutral placeholder row, **one log record per Run per discriminant**, and a stream
 * that keeps going. The row is {@link ../UnknownPartRow}; the stream continuing is the transcript
 * row factory's `default` branch never throwing (17.1). This module owns the middle one, and it
 * is here rather than inside the row for two reasons.
 *
 * **A component cannot hold the dedupe.** React may mount, unmount, and remount the same row —
 * a virtualiser scrolling it out of view and back does exactly that — so a `useEffect` in the
 * row would log once per mount, not once per Run. The state has to outlive the element.
 *
 * **"Once per Run" is arithmetic, so it is testable as arithmetic.** Property 3 asserts that the
 * number of log records equals the number of *distinct* unknown discriminants in a sequence, and
 * that is a claim about this function rather than about a rendered tree.
 *
 * ## What "log" means here
 *
 * A `console.warn`, not a telemetry event. `lib/telemetry.ts` is a closed schema of enums and
 * numbers by construction (no field can hold a wire string), and an unrecognised discriminant is
 * a developer breadcrumb about a version skew between the runtime and the renderer — the person
 * who needs it is reading a console or a log file, not an analytics dashboard.
 *
 * The record carries the `runId`, which the error-envelope rules would forbid. They apply to
 * user-facing `message` text (R9.8), and this is neither user-facing nor an envelope: without
 * the run id, "once per Run" is unverifiable from the log it is a claim about.
 */

/**
 * Runs tracked at once, before the oldest is forgotten.
 *
 * Bounded because the alternative is a `Map` that grows for the life of the process: one entry
 * per Run, held forever, for a condition that should never fire. Eviction is insertion-ordered
 * and the just-inserted Run is never the one evicted, so the only consequence of overflow is
 * that a discriminant could be logged a second time for a Run that has been quiet for 128 Runs —
 * a duplicated breadcrumb, against an unbounded leak.
 */
export const MAX_TRACKED_RUNS = 128;

/** Per-Run sets of discriminants already logged. Insertion-ordered, which the eviction uses. */
const loggedByRun = new Map<string, Set<string>>();

/**
 * Record an unrecognised Message_Part discriminant, at most once per Run (R7.6).
 *
 * Returns whether this call produced a log record, which is what lets a caller — and Property 3
 * — count records without reading the console.
 */
export function logUnknownPart(runId: string, discriminant: string): boolean {
  let logged = loggedByRun.get(runId);
  if (logged === undefined) {
    logged = new Set<string>();
    loggedByRun.set(runId, logged);
    if (loggedByRun.size > MAX_TRACKED_RUNS) {
      const oldest = loggedByRun.keys().next();
      // `oldest` cannot be the key just inserted: `Map` iterates in insertion order and the map
      // held MAX_TRACKED_RUNS entries before this one.
      if (oldest.done !== true) loggedByRun.delete(oldest.value);
    }
  }

  if (logged.has(discriminant)) return false;
  logged.add(discriminant);
  console.warn(
    `[chat] Unrecognised Message_Part discriminant "${discriminant}" in run ${runId}. ` +
      `Rendering a placeholder row and continuing to consume the stream (R7.6).`,
  );
  return true;
}

/**
 * Whether `discriminant` has already been logged for `runId`. Read-only, so a caller can ask
 * without becoming the thing that answers.
 */
export function hasLoggedUnknownPart(runId: string, discriminant: string): boolean {
  return loggedByRun.get(runId)?.has(discriminant) === true;
}

/**
 * Forget every recorded discriminant.
 *
 * Two callers, one function: a test isolating its own count, and a Session switch — the store's
 * `resetForSession` discards the transcript those Runs belonged to, so holding their
 * discriminants would only suppress a legitimate log if a run id were ever reused.
 */
export function resetUnknownPartLog(): void {
  loggedByRun.clear();
}
