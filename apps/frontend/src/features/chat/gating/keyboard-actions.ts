/**
 * The Chat_Surface's keyboard gating — zoc-agent-chat-rebuild R23.3, R20.3, R20.4, task 24.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 24.2 (R23.3, R20.3, R20.4).
 *
 * The two pure resolutions behind the global submit and cancel shortcuts, re-authored here so that
 * `lib/key-bindings.ts` can reach them without importing from `features/agent` — which task 26.1
 * deletes, and which the bindings must outlive (R23.3).
 *
 * ## Why these are re-authored rather than re-exported
 *
 * They are six lines of logic with one dependency between them, and that dependency was a *type* from
 * a 246-line legacy module (`features/agent/model-availability.ts`) that carries `LlamaCppStatus`, a
 * supervisor state machine, and a provider availability map. Importing the type dragged the module
 * into the Chat_Surface's graph for the sake of `{ canStart: boolean }`.
 *
 * So {@link submitAction} takes a structural `{ canStart: boolean }` instead. The legacy `RunGate`
 * union satisfies it, which is what lets `key-bindings.ts` switch to this module today while still
 * building its gate the old way — the behaviour is identical and the import is gone. When 25.5
 * rewrites the app store, the same function accepts the Chat_Surface's own verdict unchanged.
 *
 * ## Why `evaluateRunGate` / `selectionAvailabilityMap` were never moved here
 *
 * 24.2 asks for them to move into this directory. They did not, and the reason is that a copy of the
 * legacy evaluator sitting beside the Chat_Surface's own gate would give the surface **two disagreeing
 * gates**: that decision is already re-authored as `composer/submission-gate.ts` (R32.13, task 20.2)
 * plus `ChatPanel`'s `gateReasonOf` / `isSubmittable` for the model-and-key half (R13.3, task 22.13).
 * Relocating a third opinion would defeat the very thing 24.2 is for — "a keyboard submit obeys exactly
 * the same gate as the button". What moved instead is the *consultation*: {@link registerChatKeyboard}
 * below, which is how `lib/key-bindings.ts` reaches the mounted composer's verdict rather than deriving
 * one. The legacy pair dies with `features/agent`'s last caller; the store still imports it.
 */

/** The shape both the legacy `RunGate` and the Chat_Surface's verdict satisfy. */
export interface StartVerdict {
  readonly canStart: boolean;
}

/**
 * The submit key resolves to a run start exactly when the gate allows it (R20.3).
 *
 * The whole point is that this consults the *same* verdict the Send control does. A second opinion
 * here is how a keyboard submit starts a Run the button would have refused.
 */
export function submitAction(gate: StartVerdict): "start" | "blocked" {
  return gate.canStart ? "start" : "blocked";
}

/**
 * The cancel key resolves to one cancellation, and only while a Run is active (R20.4).
 *
 * "One" is the load-bearing word: the caller fires this per keystroke, and a cancel issued against a
 * settled Run is a request the runtime has to reject — so the count is checked here rather than
 * relying on the endpoint to be idempotent.
 */
export function cancelAction(activeRunCount: number): "cancel" | "noop" {
  return activeRunCount > 0 ? "cancel" : "noop";
}

/* ── The Slot-state selector (R20.4) ───────────────────────────────────
 *
 * 24.2 replaces the legacy `activeRuns(trackedRuns)` count with a selector over Run state. In the
 * Chat_Surface a Run is not a record in a tracked list — it is the panel's `RunSnapshot.state`, and
 * "active" means the runtime still holds a Slot for it.
 */

/** The Run states the pill draws. Mirrors `header/RunStatusPill`'s union without importing a component. */
export type RunLifecycleState =
  | "idle"
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

/**
 * The states during which the runtime still holds a Slot, so the Run can still be cancelled.
 *
 * `awaiting-approval` is in the set and that is the case worth stating: the Run is not executing, but
 * it *is* occupying a Slot and waiting on the user — which is precisely when someone reaches for
 * `mod+.` rather than answering the prompt. Leaving it out would make the shortcut silently do
 * nothing in the one state where a user most wants out.
 */
const HOLDS_A_SLOT: ReadonlySet<RunLifecycleState> = new Set<RunLifecycleState>([
  "queued",
  "running",
  "awaiting-approval",
]);

/** Whether this Run still occupies a Slot. */
export function holdsSlot(state: RunLifecycleState): boolean {
  return HOLDS_A_SLOT.has(state);
}

/**
 * How many of the given Runs still hold a Slot — the input {@link cancelAction} expects.
 *
 * Takes a list rather than one state because 29.1 adds parent/child Runs, and a cancel cascade needs
 * the count rather than a boolean. One Run today is a one-element list.
 */
export function activeSlotCount(states: readonly RunLifecycleState[]): number {
  return states.filter(holdsSlot).length;
}

/* ── The mounted surface (R20.3, R20.4) ────────────────────────────────
 *
 * The other half of 24.2. `runGateForKeyboard` used to build a *second* gate out of `AppState` with the
 * legacy `evaluateRunGate`, because the Chat_Surface's own gate needs the selected model and no shell
 * supplied one until 25.6 mounted `ChatPanelHost`. One does now — so the composer publishes the verdict
 * it draws its own Send control from, and `lib/key-bindings.ts` reads that instead of holding an
 * opinion. The keystroke and the button are then the same gate by construction, not by agreement.
 *
 * A module-level slot rather than a React context, because the consumer is a `window` keydown listener
 * in `lib`, outside any tree. Every field is a thunk: the verdict changes on each keystroke, and a value
 * captured at registration would be exactly the stale gate this exists to prevent.
 *
 * ponytail: last registration wins, which is what one chat panel per window means. Key the slot by
 * window if a second panel is ever mounted alongside the first.
 */

export interface ChatKeyboardTarget {
  /** The live `enabled` of the Send control — the same expression, not a re-derivation of it. */
  readonly verdict: () => StartVerdict;
  /** The composer's own send handler, so the keystroke and the button run one code path. */
  readonly submit: () => void;
  /** The Runs the surface knows of, for {@link activeSlotCount}. */
  readonly runStates: () => readonly RunLifecycleState[];
  readonly cancel: () => void;
}

let mounted: ChatKeyboardTarget | null = null;

/** Publish the mounted surface's keyboard target. Returns the deregistration. */
export function registerChatKeyboard(target: ChatKeyboardTarget): () => void {
  mounted = target;
  return () => {
    // Guarded, because an unmount can land after the next surface has registered — React commits the
    // new tree's effects before the old tree's cleanup in a keyed remount, and clearing unconditionally
    // would leave the window with no target and both shortcuts silently dead.
    if (mounted === target) mounted = null;
  };
}

/**
 * The mounted surface, or `null` when there is none.
 *
 * A read-only viewer renders no composer (R1.4), so nothing registers and both shortcuts are inert
 * without either binding testing for a viewer — same for the shell before the panel's first commit.
 */
export function chatKeyboardTarget(): ChatKeyboardTarget | null {
  return mounted;
}
