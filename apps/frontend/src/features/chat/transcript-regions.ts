/**
 * The transcript's two regions — zoc-agent-chat-rebuild R8.1, R20.3, R20.4, R20.7, task 17.1.
 *
 * The virtualisation design in one function. `Transcript.tsx` draws two stacked regions in one
 * scroll container: a virtualised region holding every settled row, and an always-mounted tail
 * holding the in-flight Run's rows. {@link transcriptRegions} is the split, kept out of the
 * component for the reason `reasoning-duration.ts` gives — a module exporting both a component and
 * a function is a fast-refresh boundary, and the properties import the function.
 *
 * ## Why the tail is excluded from the virtualiser rather than measured more carefully
 *
 * The last row grows on every text delta (R8.1). A virtualiser handed a growing item re-measures
 * it, recomputes the total size, and adjusts the scroll offset — per delta, at up to 40 deltas per
 * second (R20.3). No estimate is good enough to stop that, because the item's height is genuinely
 * changing. A Run produces rows in the tens, so the tail is cheap to mount whole, and the
 * virtualiser only ever sees items whose height is final.
 *
 * ## Why rows are cached per message
 *
 * R8.1 says a text append must not re-render earlier messages, and Property 6 asserts it. The row
 * slots are memoised, so the assertion reduces to: does a settled message produce the *same row
 * objects* after a delta lands on the message after it? It does, because the AI SDK replaces only
 * the message it changed — `replaceMessage` deep-clones that one and carries the rest over by
 * reference — so a `WeakMap` keyed by the message object is a sound cache and a settled row's
 * identity survives for the lifetime of the Session.
 *
 * The tail message is deliberately never cached: its identity changes on every delta, so caching it
 * would fill the map with one entry per delta and serve nothing.
 */

import { rowsOfMessage, type RowFactoryOptions, type TranscriptRow } from "./transcript-model";
import type { ZocUIMessage } from "./wire/ui-message";

/**
 * Per-message row cache. Keyed by the message object, which is why it is a `WeakMap`: a Session
 * switch drops the messages and the cache empties itself.
 */
export type RowCache = WeakMap<ZocUIMessage, readonly TranscriptRow[]>;

export interface TranscriptRegions {
  /** Every row whose height is final. Virtualised. */
  readonly settled: readonly TranscriptRow[];
  /** The in-flight Run's rows. Always mounted, never virtualised. */
  readonly streaming: readonly TranscriptRow[];
}

export interface RegionOptions {
  /**
   * True while a Run is streaming. The trailing assistant message is the tail only while this
   * holds — on a terminal state the same rows move into the settled region in one commit, which is
   * the "appended in one commit" step the design describes.
   */
  readonly inFlight: boolean;
  /** Injected so `Transcript` can hold it in a ref; omitted, every call recomputes. */
  readonly cache?: RowCache;
  /** Passed through to the row factory — currently the tool-kind resolver (22.1). */
  readonly factory?: RowFactoryOptions;
  /**
   * Rows that precede the message list: R23.2's migrated legacy events, which are not
   * `ZocUIMessage`s and never will be. A seam for 24.2 rather than a guess at its shape — the rows
   * are built by `collapseHistorical` and handed in already ordered.
   */
  readonly historicalRows?: readonly TranscriptRow[];
}

/**
 * The index of the first message belonging to the unvirtualised tail.
 *
 * Equal to `messages.length` when there is no tail. The tail is the trailing *assistant* message
 * only: while `status` is `submitted` the last message is the user's, which does not grow, so
 * putting it in the tail would empty the virtualised region for no benefit.
 */
export function tailIndexOf(messages: readonly ZocUIMessage[], inFlight: boolean): number {
  if (!inFlight || messages.length === 0) return messages.length;
  return messages[messages.length - 1]?.role === "assistant"
    ? messages.length - 1
    : messages.length;
}

/** One message's rows, from the cache when it is there. */
function cachedRows(
  message: ZocUIMessage,
  options: RegionOptions,
): readonly TranscriptRow[] {
  const hit = options.cache?.get(message);
  if (hit !== undefined) return hit;
  const rows = rowsOfMessage(message, options.factory ?? {});
  options.cache?.set(message, rows);
  return rows;
}

/** The settled and streaming regions for one message list. */
export function transcriptRegions(
  messages: readonly ZocUIMessage[],
  options: RegionOptions,
): TranscriptRegions {
  const tail = tailIndexOf(messages, options.inFlight);
  const settled: TranscriptRow[] = [...(options.historicalRows ?? [])];

  for (let index = 0; index < tail; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    settled.push(...cachedRows(message, options));
  }

  const tailMessage = tail < messages.length ? messages[tail] : undefined;
  const streaming =
    tailMessage === undefined ? [] : rowsOfMessage(tailMessage, options.factory ?? {});

  return { settled, streaming };
}

/**
 * Per-kind height estimates, in CSS pixels.
 *
 * A single average is what makes a scrollbar jump: a usage row and a diff differ by an order of
 * magnitude, so an average is wrong by that much for both, and every wrong estimate is corrected
 * visibly when the row is measured. These are deliberately close to the rendered heights of the
 * rows in `terminal-rows.test.tsx`'s fixtures at the default type scale.
 *
 * `permission` is small because the transcript draws only a muted "waiting for approval" line for
 * it — the request itself is pinned in the dock, outside this scroll container (19.1).
 */
export const ESTIMATED_ROW_HEIGHT: Readonly<Record<TranscriptRow["kind"], number>> = {
  user: 64,
  answer: 160,
  reasoning: 48,
  tools: 44,
  usage: 36,
  error: 96,
  compaction: 56,
  historical: 40,
  plan: 160,
  diff: 220,
  permission: 32,
  sources: 48,
  unknown: 40,
};

/** Rough height of one tool-timeline entry, collapsed. */
const TOOL_ENTRY_HEIGHT = 28;

/**
 * The estimate for one row.
 *
 * Per-kind, with a refinement for the kinds whose height is dominated by a count the row already
 * carries. A timeline of one call and a timeline of twelve are the same *kind*, and estimating both
 * at the same height is the single-average mistake reintroduced inside a kind.
 */
export function estimatedRowHeight(row: TranscriptRow | undefined): number {
  if (row === undefined) return ESTIMATED_ROW_HEIGHT.answer;
  switch (row.kind) {
    case "tools":
      return ESTIMATED_ROW_HEIGHT.tools + row.entries.length * TOOL_ENTRY_HEIGHT;
    case "plan":
      return ESTIMATED_ROW_HEIGHT.plan + row.plan.files.length * TOOL_ENTRY_HEIGHT;
    default:
      return ESTIMATED_ROW_HEIGHT[row.kind];
  }
}

/**
 * R20.4's threshold: the row count past which the requirement demands virtualisation.
 *
 * **Nothing branches on it.** The transcript virtualises unconditionally, because two code paths
 * through the anchoring and measurement logic would double the surface area of the hardest part of
 * the surface to test, and the short-transcript path is the one where anchoring has to be exactly
 * right. The constant is here because it is the number the requirement names, and Property 47 needs
 * a fixture that clears it.
 */
export const VIRTUALIZATION_FLOOR_ROWS = 60;

/**
 * The measured distance from the bottom that anchoring guarantees, in CSS pixels.
 *
 * Tighter than the 32 px entry condition in `store.ts`, and the gap between the two numbers is the
 * point: entering the anchored state is a judgement about intent — a trackpad's inertial overscroll
 * is not a scroll away — while *being* anchored is a promise that the newest row is on screen
 * (R20.7). Property 48 asserts the pair: un-anchor past 32 px, and hold within 8 px while anchored.
 */
export const ANCHOR_GUARANTEE_PX = 8;
