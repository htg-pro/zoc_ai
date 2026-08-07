/**
 * First-part latency — zoc-agent-chat-rebuild R20.1, R20.2, task 20.10.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.10 (R20.1, R20.2).
 *
 * Two `performance` marks and the measure between them. The marks are set at the two moments a user would
 * recognise: `run:submit` when they pressed send, and `run:first-paint` when something appeared. Nothing in
 * the plan measured R20.1 or R20.2 before this, and the two points are the reason — a budget measured from
 * the HTTP request to the first chunk would be a budget on the provider, and a budget measured to the first
 * *chunk* rather than the first *paint* would omit exactly the work this rebuild changed.
 *
 * ## Why the marks are module state rather than a per-Run map
 *
 * A Session submits one Run at a time (M1), so there is one interval in flight. A map keyed by run id
 * sounds more careful and is worse: the surface sets `run:submit` before a run id exists — the id comes back
 * from the runtime — so the key would have to be back-filled, and a submission the gate refused would leak
 * an entry that nothing ever removes. One pending interval, cleared on the next submit, has no such state.
 *
 * ## Why `markFirstPaint` is idempotent
 *
 * It is called from a layout effect that runs on every commit of the streaming tail, which is up to sixty
 * times a second. The first call wins and the rest are free, so the mark means "first paint" rather than
 * "most recent paint".
 */

export const SUBMIT_MARK = "run:submit";
export const FIRST_PAINT_MARK = "run:first-paint";
export const FIRST_PART_MEASURE = "run:first-part";

/** True between a submit and the first paint that follows it. */
let awaitingFirstPaint = false;

/**
 * Mark a submission (R20.1's clock start).
 *
 * Called from the composer's send handler *before* the pre-submission gate runs, because the interval the
 * budget is about starts at the gesture rather than at the request — and a refusal simply never gets a
 * matching paint mark.
 */
export function markSubmit(): void {
  performance.clearMarks(SUBMIT_MARK);
  performance.clearMarks(FIRST_PAINT_MARK);
  performance.clearMeasures(FIRST_PART_MEASURE);
  performance.mark(SUBMIT_MARK);
  awaitingFirstPaint = true;
}

/**
 * Mark the first painted part of the Run that is in flight, and take the measure.
 *
 * A no-op unless a submit is awaiting a paint, so a re-render of a settled transcript — or a Run resumed
 * after a reload, which had no submit in this window — records nothing rather than a nonsense interval.
 */
export function markFirstPaint(): void {
  if (!awaitingFirstPaint) return;
  awaitingFirstPaint = false;
  performance.mark(FIRST_PAINT_MARK);
  try {
    performance.measure(FIRST_PART_MEASURE, SUBMIT_MARK, FIRST_PAINT_MARK);
  } catch {
    // A missing start mark means something cleared the buffer between the two calls. The measure is
    // telemetry, so losing one is not worth an exception on the render path.
  }
}

/** The most recent submit-to-first-paint interval in milliseconds, or `null` if there is none. */
export function firstPartLatencyMs(): number | null {
  const measures = performance.getEntriesByName(FIRST_PART_MEASURE, "measure");
  const latest = measures.at(-1);
  return latest === undefined ? null : latest.duration;
}

/** Drop every mark and measure. For tests, and for a Session switch. */
export function resetFirstPartLatency(): void {
  awaitingFirstPaint = false;
  performance.clearMarks(SUBMIT_MARK);
  performance.clearMarks(FIRST_PAINT_MARK);
  performance.clearMeasures(FIRST_PART_MEASURE);
}
