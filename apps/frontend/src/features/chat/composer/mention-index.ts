/**
 * The mention index and its filter — zoc-agent-chat-rebuild R12.2, R12.4, R12.5, task 20.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.2 (R12.2, R12.4, R12.5).
 *
 * The popover's candidates, ranked. Four categories (R12.2's Files, Symbols, Terminal, Docs), one
 * pre-built `fuse.js` index over an in-memory snapshot, results capped at {@link MENTION_RESULT_LIMIT}.
 *
 * ## Why the filter is a predicate *and* a ranker
 *
 * `fuse.js` ranks well and bounds badly: at any threshold loose enough to be useful for paths it also
 * returns candidates a user cannot see the connection to, and "why is that in my list" is the complaint
 * that makes a picker feel broken. So two mechanisms with different jobs — {@link matchesQuery} decides
 * *membership* as an ordered case-insensitive subsequence, which is a rule a user can hold in their head,
 * and Fuse decides *order*. Property 24's soundness clause is a claim about the first and its ordering
 * clause is a claim about the second.
 *
 * ## Why an empty query lists rather than clears
 *
 * The popover opens on `@` with nothing typed yet. Returning no results there would read as "there is no
 * context available", so an empty query yields the head of the index in its own order — which is the
 * order the caller built it in, and therefore the caller's business rather than this module's.
 *
 * ## Why the index is built once
 *
 * R12.4's budget is keystroke-to-paint under 100 ms over a 20,000-path index. Building a Fuse index is
 * the expensive part and it does not depend on the query, so it happens when the snapshot changes — and
 * the per-keystroke cost is a search over a prepared index. The 60 ms debounce is the component's, not
 * this module's: a debounce is about *when* to ask, and this module answers.
 */

import Fuse, { type IFuseOptions } from "fuse.js";

/** R12.2's four categories, in the order the popover groups them. */
export const MENTION_CATEGORIES = ["files", "symbols", "terminal", "docs"] as const;

export type MentionCategory = (typeof MENTION_CATEGORIES)[number];

/** How many results the popover will show. */
export const MENTION_RESULT_LIMIT = 50;

/** How long the composer waits after a keystroke before searching (R12.4). */
export const MENTION_DEBOUNCE_MS = 60;

export interface MentionCandidate {
  /** Stable across snapshots, so a selection survives a re-index. */
  readonly id: string;
  readonly category: MentionCategory;
  /** What goes into the draft after `@`, and into the request (R12.3). */
  readonly ref: string;
  /** What the row shows. Usually the basename, so a long path is scannable. */
  readonly label: string;
  /** The second line of the row: the containing directory, a symbol's kind, a command's cwd. */
  readonly detail?: string;
  /** Estimated tokens this attachment would contribute (R12.5). */
  readonly estimatedTokens: number;
}

export interface MentionResult {
  readonly candidate: MentionCandidate;
  /** Fuse's distance: lower is better. Exposed so the ordering clause is assertable. */
  readonly score: number;
}

/**
 * How many admitted candidates are ranked before the list is cut to {@link MENTION_RESULT_LIMIT}.
 *
 * A latency ceiling, and the reason it exists is a measurement rather than a guess: ranking every candidate
 * a one-character query admits — roughly half a 20,000-path workspace — put the worst keystroke at 134 ms
 * against R12.2's 100 ms in Chromium. Ranking a bounded prefix of the admitted set brings it inside the
 * budget, at the cost of recall for a query so broad that the fiftieth result is already noise. Ten times
 * the number shown, so the cut is invisible for any query a user is steering with.
 */
export const MENTION_RANK_CEILING = 500;

/** A prepared index. Opaque on purpose: what it holds is this module's business. */
export interface MentionIndex {
  readonly candidates: readonly MentionCandidate[];
  readonly search: (query: string) => readonly MentionResult[];
}

/**
 * Fuse over the two fields a user types against, weighted so the label wins.
 *
 * `ignoreLocation` because a path's discriminating part is at the end — a user typing `Composer` means
 * `src/features/chat/composer/Composer.tsx`, and Fuse's default location bias would rank a shallow file
 * with an early accidental match above it.
 */
const FUSE_OPTIONS: IFuseOptions<MentionCandidate> = {
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
  keys: [
    { name: "label", weight: 0.7 },
    { name: "ref", weight: 0.3 },
  ],
};

/**
 * Whether `candidate` is a legitimate result for `query`.
 *
 * An ordered, case-insensitive subsequence of either the label or the ref: `cmpsr` matches
 * `Composer.tsx`, `psrmoc` does not. This is the membership rule the popover promises, and it is
 * deliberately stricter than Fuse's threshold — a result nobody can explain is worse than a result
 * missing.
 *
 * A query of only whitespace matches everything, because it is what the user has typed so far rather
 * than a filter they meant.
 */
export function matchesQuery(candidate: MentionCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    isSubsequence(needle, candidate.label.toLowerCase()) ||
    isSubsequence(needle, candidate.ref.toLowerCase())
  );
}

function isSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return cursor === needle.length;
}

/**
 * Build the index for a snapshot.
 *
 * ## Filter first, then rank — and that order is a measured decision
 *
 * The obvious implementation asks Fuse to score every candidate and filters its results. At 20,000 paths
 * that costs 30–60 ms per keystroke, and with the 60 ms debounce and the commit it put the worst keystroke
 * at 134 ms in Chromium — over R12.2's 100 ms, measured in the `@perf` tier rather than guessed at.
 *
 * So membership runs first, as one pass of {@link matchesQuery} over the snapshot, and Fuse ranks only the
 * survivors — bounded by {@link MENTION_RANK_CEILING}. Both clauses of Property 24 still hold by
 * construction: every result matched the rule to get in, and Fuse decided the order of those that did.
 */
export function buildMentionIndex(candidates: readonly MentionCandidate[]): MentionIndex {
  return {
    candidates,
    search(query) {
      const needle = query.trim();
      if (needle.length === 0) {
        // The head of the index, in the caller's order: the popover has just opened and has nothing to
        // rank by, and an empty list would read as "no context available".
        return candidates
          .slice(0, MENTION_RESULT_LIMIT)
          .map((candidate) => ({ candidate, score: 0 }));
      }

      const admitted: MentionCandidate[] = [];
      for (const candidate of candidates) {
        if (!matchesQuery(candidate, needle)) continue;
        admitted.push(candidate);
        if (admitted.length === MENTION_RANK_CEILING) break;
      }
      if (admitted.length === 0) return [];

      // A fresh Fuse over the survivors. Building one over a few hundred candidates is fractions of a
      // millisecond, which is why this is cheaper than reusing a prepared index over twenty thousand.
      const fuse = new Fuse(admitted, FUSE_OPTIONS);
      const ranked: MentionResult[] = [];
      for (const hit of fuse.search(needle)) {
        ranked.push({ candidate: hit.item, score: hit.score ?? 1 });
        if (ranked.length === MENTION_RESULT_LIMIT) break;
      }
      // Fuse's own threshold can drop a candidate the membership rule admitted. Falling back to the
      // admitted order keeps the popover from going empty on a query that genuinely matched — the rule the
      // user can hold in their head wins over the library's distance function.
      if (ranked.length === 0) {
        return admitted
          .slice(0, MENTION_RESULT_LIMIT)
          .map((candidate) => ({ candidate, score: 1 }));
      }
      return ranked;
    },
  };
}

/**
 * The wire's `kind` for a category.
 *
 * The two vocabularies differ by a plural: R12.1 names the *categories* the popover groups by — Files,
 * Symbols, Terminal, Docs — and `MentionRef.kind` names what one reference *is*. Mapping them explicitly
 * is what stops a cast from silently putting `"files"` on a request field typed `"file"`.
 */
export function mentionKindOf(category: MentionCategory): "file" | "symbol" | "terminal" | "doc" {
  switch (category) {
    case "files":
      return "file";
    case "symbols":
      return "symbol";
    case "terminal":
      return "terminal";
    case "docs":
      return "doc";
  }
}

/**
 * Group results by category, preserving rank within each group.
 *
 * The popover shows four sections, and a category with no results is omitted rather than rendered empty —
 * the same rule the timeline follows for a disclosure with nothing behind it.
 */
export function groupByCategory(
  results: readonly MentionResult[],
): readonly { readonly category: MentionCategory; readonly results: readonly MentionResult[] }[] {
  return MENTION_CATEGORIES.map((category) => ({
    category,
    results: results.filter((result) => result.candidate.category === category),
  })).filter((group) => group.results.length > 0);
}

/**
 * The next selection index for a keyboard move, wrapping at both ends (R12.4).
 *
 * Wrapping here and clamping in the diff review is not an inconsistency: a mention list is a menu the
 * user is cycling through to pick one of, where wrapping is the expected menu behaviour and `cmdk` does
 * it too. A hunk list is a document being walked, where reaching the end is information.
 *
 * An empty list has no selection at all — `-1` rather than `0`, because `0` would name a row that is not
 * there and the composer would insert nothing on `Enter`.
 */
export function nextSelection(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  const from = current < 0 ? (delta === 1 ? -1 : 0) : current;
  return (((from + delta) % count) + count) % count;
}

/** The selection to keep after the result list changed under it. */
export function clampSelection(current: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  return Math.min(current, count - 1);
}
