/**
 * The run status pill — zoc-agent-chat-rebuild R13.9, R16.1, R21.7, task 22.2.
 *
 * State, elapsed time, the live Token_Rate while a Run streams, and a cancel affordance while one is active.
 * Three coordinated signals rather than a colour: a text label, a shape, and a tint, which is R21.7 satisfied
 * by construction rather than by audit.
 *
 * ## Token_Rate appears in exactly three places, and this is one
 *
 * The live figure belongs here while the Run streams (R13.9). The *mean* from a model's benchmark history
 * belongs on the picker's rows (R13.11). The *terminal* figure belongs to the usage row (R13.10, 16.3) —
 * which is why this pill drops the number the moment the Run settles rather than freezing the last sample:
 * a stale rate beside a finished Run is a figure that describes nothing, and the row underneath already has
 * the authoritative one.
 *
 * ## Why cancel is here and why it is out of band
 *
 * The pill is where the Run's state is, so it is where stopping it belongs. The call goes through the
 * transport's `POST /v1/runs/:id/cancel` (11.1) rather than `stop()`, because the AI SDK documents abort and
 * resumable streams as mutually exclusive and R16.1 needs both — and the outcome arrives as a cancelled
 * lifecycle part on the stream the panel is already reading, which is the only channel that can report
 * *which* tools were abandoned.
 */
import { CircleDot, CircleSlash, Loader2, OctagonX, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatTokenRate } from "../usage-figures";
import { formatRunElapsed } from "./model-catalogue";

/** The Run states the pill draws. `useChat`'s status plus the terminal lifecycle states. */
export type RunPillState =
  | "idle"
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

interface PillLook {
  readonly label: string;
  readonly colour: string;
  readonly Glyph: typeof CircleDot;
  readonly spin?: boolean;
}

/**
 * The label, glyph, and tint per state — all three, from one table.
 *
 * One table rather than three lookups so a state cannot acquire a colour without a word: R21.7's requirement
 * is that state survives without colour perception, and the way that breaks is a new state added to a colour
 * map and forgotten in a label map.
 */
const LOOKS: Readonly<Record<RunPillState, PillLook>> = {
  idle: { label: "Idle", colour: "var(--zoc-text-faint)", Glyph: CircleDot },
  queued: { label: "Queued", colour: "var(--zoc-text-muted)", Glyph: Loader2, spin: true },
  running: { label: "Running", colour: "var(--zoc-agent)", Glyph: Loader2, spin: true },
  "awaiting-approval": {
    // The one state whose tint is ember, and it is ember for the same reason the dock is: the Run is
    // blocked on the user (R17.2).
    label: "Waiting for you",
    colour: "var(--zoc-ember)",
    Glyph: CircleDot,
  },
  completed: { label: "Done", colour: "var(--zoc-success)", Glyph: CircleDot },
  cancelled: { label: "Cancelled", colour: "var(--zoc-text-muted)", Glyph: CircleSlash },
  failed: { label: "Failed", colour: "var(--zoc-error)", Glyph: OctagonX },
  interrupted: { label: "Interrupted", colour: "var(--zoc-error)", Glyph: CircleSlash },
};

/** States during which a Run can still be cancelled. */
const ACTIVE: ReadonlySet<RunPillState> = new Set([
  "queued",
  "running",
  "awaiting-approval",
]);

export interface RunStatusPillProps {
  state: RunPillState;
  /** Milliseconds since the Run started. The panel owns the clock. */
  elapsedMs: number;
  /** The streaming Run's live rate (R13.9). Omitted once the Run settles. */
  tokensPerSecond?: number | null;
  onCancel?: () => void;
  className?: string;
}

export function RunStatusPill({
  state,
  elapsedMs,
  tokensPerSecond,
  onCancel,
  className,
}: RunStatusPillProps) {
  const look = LOOKS[state];
  const active = ACTIVE.has(state);
  // Only while active: a rate beside a finished Run describes nothing, and the usage row owns the terminal
  // figure (R13.10).
  const rate = active ? formatTokenRate(tokensPerSecond ?? null) : null;

  return (
    <div
      className={cn("flex shrink-0 items-center gap-1.5", className)}
      data-zoc-run-pill={state}
      // One live region for the whole pill, so a state change is announced as "Running, 0:14" rather than as
      // three separate updates.
      aria-live="polite"
      style={{ fontSize: "var(--zoc-text-label)" }}
    >
      <look.Glyph
        aria-hidden
        className={cn("size-3 shrink-0", look.spin === true && "animate-spin")}
        style={{ color: look.colour }}
      />
      <span data-zoc-run-label="" style={{ color: look.colour }}>
        {look.label}
      </span>
      {state === "idle" ? null : (
        <span
          className="tabular-nums"
          data-zoc-run-elapsed=""
          style={{ color: "var(--zoc-text-muted)" }}
        >
          {formatRunElapsed(elapsedMs)}
        </span>
      )}
      {rate === null ? null : (
        <span
          className="tabular-nums"
          data-zoc-run-rate=""
          style={{ color: "var(--zoc-text-muted)" }}
        >
          {rate}
        </span>
      )}
      {active && onCancel !== undefined ? (
        <button
          type="button"
          data-zoc-run-cancel=""
          aria-label="Stop this run"
          onClick={onCancel}
          className="rounded-[var(--zoc-radius-chip)] p-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          style={{ color: "var(--zoc-text-muted)" }}
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
