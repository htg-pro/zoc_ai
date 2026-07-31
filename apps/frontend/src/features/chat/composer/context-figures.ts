/**
 * The context meter's figures — zoc-agent-chat-rebuild R12.5, R12.6, R12.8, R12.9, R12.10, R34.4,
 * task 20.3.
 *
 * Everything the meter displays, as one value derived in one place. The reason it is one function rather
 * than five is R12.10: a figure computed for one model must never be shown against another's window, and
 * the way that goes wrong is a component that reads a limit from one source and a count from another.
 * {@link contextFigures} takes the model reference *and* the census together, so a caller physically
 * cannot pair them wrongly — and Property 83 watches every committed render to prove it.
 *
 * ## Reported and estimated are different states, not a formatting choice
 *
 * R12.9 asks the indicator to say when it is an estimate. Two situations are: before a Session's first
 * Run, when no `UsagePart` exists at all; and after a model change, when the last `UsagePart`'s figures
 * were counted against the previous model's tokenizer and window. The second is the one a naive
 * implementation misses, because a `UsagePart` *is* present — it is just about a different model. So the
 * source is compared with the current model reference rather than merely checked for existence.
 *
 * ## Why the overflow gate names attachments rather than tokens
 *
 * R12.6 says block submission, name the mentions that must be removed, and offer removing the largest
 * first. A meter that reported "4,200 over" would leave the user to work out which chip to drop; the
 * dialog opens on a list ordered by size descending with the largest pre-selected, so the default action
 * is the one the requirement asks for and the arithmetic is the surface's rather than the user's.
 */

import { contextUsage, type ContextUsage } from "@/lib/context-usage";

import type { ResolvedMention } from "../store";

/** Which model a figure was computed against, so two figures can be told apart (R12.10). */
export interface ModelReference {
  readonly provider: string;
  readonly modelId: string;
  /** The model's context window, in tokens. */
  readonly contextLimit: number;
}

/** Two model references name the same model. */
export function sameModel(a: ModelReference | null, b: ModelReference | null): boolean {
  if (a === null || b === null) return a === b;
  return a.provider === b.provider && a.modelId === b.modelId && a.contextLimit === b.contextLimit;
}

/**
 * The four facts R12.8 asks for, as the runtime reported them.
 *
 * Structurally `UsagePart`'s census fields, restated here because the meter also renders them from
 * `ZocMessageMetadata` on a restored Session (1.4) and from a client-side estimate before the first Run —
 * three sources, one shape.
 */
export interface ContextCensus {
  readonly messagesInContext: number;
  readonly sessionMessageCount: number;
  readonly messagesOutOfWindow: number;
  readonly summaryActive: boolean;
  /** Tokens the runtime reported for the last Run, or the surface's estimate. */
  readonly consumedTokens: number;
  /**
   * The model the figures were computed against, or `null` for a client-side estimate.
   *
   * Null *and* a mismatch both mean "estimate", which is why this is a reference rather than a boolean:
   * a `UsagePart` from the previous model is present, real, and about the wrong window.
   */
  readonly measuredAgainst: ModelReference | null;
}

export interface ContextFigures {
  readonly usage: ContextUsage;
  readonly census: ContextCensus;
  /** R12.9: the figures are the surface's arithmetic, not the runtime's report. */
  readonly estimated: boolean;
  /** R12.5: what the attached mentions contribute, included in `usage.consumed`. */
  readonly attachedTokens: number;
  /** The model every figure here was computed against. */
  readonly model: ModelReference;
  /** R12.6: the attachments push the request past the window. */
  readonly overflowing: boolean;
  /** How many tokens over the window, or 0. */
  readonly overflowBy: number;
}

/**
 * The meter's figures for one model, one census, and one set of attachments.
 *
 * `consumed` is the census's own token figure plus what the attachments add, because R12.5 is about the
 * cost *of the next submission* — the transcript's cost is already in the census, and the chips are the
 * part the user can still change.
 */
export function contextFigures(input: {
  readonly model: ModelReference;
  readonly census: ContextCensus;
  readonly mentions: readonly ResolvedMention[];
}): ContextFigures {
  const attachedTokens = attachedTokenCost(input.mentions);
  const consumed = Math.max(0, input.census.consumedTokens) + attachedTokens;
  const usage = contextUsage(consumed, input.model.contextLimit);
  const overflowBy = Math.max(0, consumed - input.model.contextLimit);

  return {
    usage,
    census: input.census,
    // The mismatch case is the one that matters: a `UsagePart` counted against the previous model is
    // present and is not a measurement of *this* model's window.
    estimated: !sameModel(input.census.measuredAgainst, input.model),
    attachedTokens,
    model: input.model,
    overflowing: input.model.contextLimit > 0 && overflowBy > 0,
    overflowBy,
  };
}

/** What the resolved attachments contribute. Unresolved chips contribute nothing (R12.7). */
export function attachedTokenCost(mentions: readonly ResolvedMention[]): number {
  return mentions
    .filter((mention) => mention.resolved)
    .reduce((total, mention) => total + Math.max(0, mention.estimatedTokens), 0);
}

/**
 * The attachments to offer removing, largest first (R12.6).
 *
 * Ties break on `id` so the order is total and therefore stable: two attachments of the same size in a
 * list that reshuffles between renders would move the pre-selected row under the user's cursor.
 * Unresolved chips are excluded because removing one frees nothing — they are already out of the request.
 */
export function removalCandidates(
  mentions: readonly ResolvedMention[],
): readonly ResolvedMention[] {
  return [...mentions]
    .filter((mention) => mention.resolved)
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.id.localeCompare(b.id));
}

/**
 * The smallest prefix of {@link removalCandidates} that clears the overflow.
 *
 * "Offer removing the largest first" read as an action rather than a hint: this is what the dialog
 * pre-selects. Greedy from the largest is optimal for the question being asked — the fewest attachments
 * removed — because removing the largest first minimises the count needed to reach any target.
 */
export function removalToClear(
  figures: ContextFigures,
  mentions: readonly ResolvedMention[],
): readonly ResolvedMention[] {
  if (!figures.overflowing) return [];
  const selected: ResolvedMention[] = [];
  let freed = 0;
  for (const mention of removalCandidates(mentions)) {
    selected.push(mention);
    freed += Math.max(0, mention.estimatedTokens);
    if (freed >= figures.overflowBy) break;
  }
  return selected;
}

/** `12.4k` — the figure the meter shows, because `12,417 / 200,000` is two numbers nobody reads. */
export function formatTokens(count: number): string {
  const safe = Math.max(0, Math.round(count));
  if (safe < 1_000) return String(safe);
  const thousands = safe / 1_000;
  // One decimal below 100k and none above: `12.4k` is a figure, `124.3k` is noise.
  return thousands < 100
    ? `${thousands.toFixed(1).replace(/\.0$/, "")}k`
    : `${String(Math.round(thousands))}k`;
}

/**
 * The census as one sentence, for the meter's tooltip and its accessible name (R12.8).
 *
 * All four facts, always, in a fixed order. A summary that is not active is stated as absent rather than
 * omitted, because "no summary" and "the surface does not know" are different and only one of them is
 * true here.
 */
export function censusSentence(figures: ContextFigures): string {
  const { census } = figures;
  const parts = [
    `${String(census.messagesInContext)} of ${String(census.sessionMessageCount)} messages in context`,
    census.messagesOutOfWindow === 1
      ? "1 message outside the window"
      : `${String(census.messagesOutOfWindow)} messages outside the window`,
    census.summaryActive ? "a compaction summary is pinned" : "no compaction summary",
  ];
  if (figures.estimated) parts.push("estimated");
  return parts.join(", ");
}
