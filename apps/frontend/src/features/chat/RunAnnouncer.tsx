/**
 * Run lifecycle announcements — zoc-agent-chat-rebuild R21.2, task 23.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 23.1 (R21.2).
 *
 * R21.2 asks for two different things from one region: that the streaming transcript be marked
 * `aria-live="polite"`, and that Run **start**, **completion**, and **failure** be announced. The
 * first is `Transcript`'s streaming tail. The second is this, and it needs to be separate, because
 * the tail announces *text* — appending deltas — and a lifecycle event is not text that arrives. A
 * Run that fails before emitting a single character would otherwise be announced by silence.
 *
 * ## Why it announces transitions, not states
 *
 * The region's content is derived from a state *change*, never from the state itself. Rendering the
 * current state into a live region means every unrelated re-render re-asserts the same string, and
 * some screen readers re-announce on any mutation of a live region's subtree — so a settled Run
 * would announce "Run complete" again each time the panel re-rendered for an unrelated reason. The
 * previous state is held in a ref and the message is written only when the pair actually differs.
 *
 * ## Why `polite` and not `assertive`
 *
 * A Run completing does not interrupt what the user is doing. The one surface that legitimately
 * interrupts is the permission dock (R21.3), which is `assertive` because the Run is *blocked* on
 * the answer. Two assertive regions racing is how an approval prompt gets talked over.
 */
import { useEffect, useRef, useState } from "react";

import type { RunPillState } from "./header/RunStatusPill";

/**
 * The states that produce an announcement, and what each one says.
 *
 * A table rather than a chain of conditionals so that a state added to `RunPillState` and forgotten
 * here is a missing key rather than a silent fall-through — the same reason `RunStatusPill` draws
 * its label, glyph, and tint from one table.
 *
 * `queued` and `awaiting-approval` are deliberately absent. Queuing is not a start, and the dock
 * already announces the approval request with the tool and its paths (R21.3); announcing it twice is
 * how the paths get lost in the repetition.
 */
const ANNOUNCEMENT: Partial<Record<RunPillState, string>> = {
  running: "Run started",
  completed: "Run complete",
  failed: "Run failed",
  cancelled: "Run cancelled",
  interrupted: "Run interrupted",
};

export interface RunAnnouncerProps {
  /** The panel's authoritative Run state — the same value the pill draws. */
  state: RunPillState;
  /**
   * Appended to a failure announcement when the panel has one, so the reason travels with the
   * event rather than living only in a row the user has to go find.
   */
  failureDetail?: string | null;
}

export function RunAnnouncer({ state, failureDetail }: RunAnnouncerProps) {
  const [message, setMessage] = useState("");
  const previous = useRef<RunPillState | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = state;

    // The first commit is not a transition. A Session restored mid-Run, or a panel remounting onto a
    // settled transcript, would otherwise announce a Run the user did not just start.
    if (before === null || before === state) return;

    const base = ANNOUNCEMENT[state];
    if (base === undefined) {
      // Clearing matters: leaving the previous message in place means the next identical transition
      // writes the same string and mutates nothing, which some screen readers do not announce.
      setMessage("");
      return;
    }

    const detail = state === "failed" && failureDetail ? `: ${failureDetail}` : "";
    setMessage(`${base}${detail}`);
  }, [state, failureDetail]);

  return (
    <div
      className="sr-only"
      data-zoc-run-announcer=""
      role="status"
      aria-live="polite"
      // The whole message is read as a unit — "Run failed: rate limited" is one fact, and announcing
      // the appended half alone would report a reason with no event.
      aria-atomic="true"
    >
      {message}
    </div>
  );
}
