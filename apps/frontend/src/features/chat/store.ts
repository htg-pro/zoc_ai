/**
 * The chat-local store — zoc-agent-chat-rebuild R2.3, R2.4, R10.3, R16.4, R20.7, R32.1.
 *
 * The Chat_Surface's UI state, and **only** its UI state. Three stores exist and the
 * boundary between them is a requirement rather than a preference:
 *
 *   - `useChat` (`@ai-sdk/react`) owns `messages`, `status`, and `error`. It is the only
 *     holder of streamed part data, and that is what makes R2.4 achievable: there is no
 *     second copy to keep out of `lib/store.ts`, because there is no second copy at all.
 *   - **This store** owns what the user has done to the transcript that is not itself
 *     transcript: the draft, the mentions, the per-hunk decisions, which rows are open,
 *     where the scroll is anchored, and the sequence floor each Run has been rendered to.
 *   - `useApp` (`lib/store.ts`) owns app-wide state and the Session list.
 *
 * **Nothing per-part and nothing per-stream lives here** (R2.4). `lastRenderedSeq` is the
 * one entry that looks like an exception and is not: it is a single integer per Run — the
 * dedupe floor R16.4 needs and the resume point 11.1's transport reads — not a buffer of
 * parts. Storing the parts here instead is exactly the mistake the requirement names.
 *
 * ## Why a store rather than component state
 *
 * Each of these is read by a component that does not own it. `lastRenderedSeq` is written
 * by the transport and read by the reconnect path; `anchored` is written by the
 * transcript's `onScroll` and read by the jump-to-latest control; `hunkDecisions` is
 * written by a hunk row and read by the apply footer three levels up. Threading any of
 * them through props would put the transcript's scroll state in the panel shell.
 *
 * ## The one shape worth explaining
 *
 * `hunkDecisions` is three levels deep — plan → path → hunk — rather than a flat
 * `hunkId → boolean`. Hunk ids are only unique **within a file**, so a flat map would
 * collide across files in one plan; and a regenerated diff for one file must clear that
 * file's decisions without touching the rest of the plan, which a flat map cannot express
 * as one operation.
 */

import { create } from "zustand";
import type { ConversationMode } from "@zoc-studio/shared-types";

import type { MentionRef } from "./wire/zoc-transport";

/**
 * A mention the user has selected and the surface has resolved.
 *
 * Structurally the transport's `MentionRef` plus the two facts only the surface knows: an
 * estimated token cost, for R12.5's pre-submission figure, and whether the reference still
 * resolves. R12.7 excludes an unresolved chip from the request rather than dropping the
 * chip, so "unresolved" has to be a state a chip can be *in* and not an absence.
 */
export interface ResolvedMention extends MentionRef {
  /** Stable per chip, so removing one does not re-key the others. */
  readonly id: string;
  /** Estimated tokens this attachment contributes (R12.5). */
  readonly estimatedTokens: number;
  /** False when the file was deleted or renamed after selection (R12.7). */
  readonly resolved: boolean;
}

/** The caret-relative `@token` under edit, from the composer's parser (20.1). */
export interface MentionQuery {
  /** Index of the `@` in the draft. */
  readonly start: number;
  /** The text typed after `@`, up to the caret. May be empty. */
  readonly query: string;
}

/** R10.3's three states. Absent from the map means `undecided`. */
export type HunkDecision = "accepted" | "rejected" | "undecided";

/**
 * The reserved key for a **file-level** decision.
 *
 * A pure rename produces a `DiffPart` with zero hunks — the change is entirely in the
 * path, so there is nothing to review line by line — and it still has to be acceptable.
 * design.md:2769 reserves this key for that decision rather than inventing a synthetic
 * hunk id, which would then have to be filtered out of every hunk count the user sees.
 */
export const FILE_LEVEL_DECISION = "__file__";

/** planId → path → hunkId → decision. */
export type HunkDecisions = Record<string, Record<string, Record<string, HunkDecision>>>;

export type Effort = "fast" | "balanced" | "thorough";

/** R20.7's anchoring threshold: roughly half a row. */
export const ANCHOR_THRESHOLD_PX = 32;

export interface ChatSurfaceState {
  // ── Composer ────────────────────────────────────────────────────────
  draft: string;
  mentions: ResolvedMention[];
  mentionQuery: MentionQuery | null;
  /**
   * The Conversation_Mode the next Run submits with (R32.1).
   *
   * Here rather than in `useApp` because it is a per-turn choice scoped to one Session.
   * Permission_Mode is the standing policy and stays app-wide — which is also why neither
   * axis is derived from the other and all nine combinations are reachable (R11.10).
   */
  conversationMode: ConversationMode;
  effort: Effort;

  // ── Review ──────────────────────────────────────────────────────────
  hunkDecisions: HunkDecisions;
  /** Row ids with their detail open. Ids, not indices, so a re-order is harmless. */
  expanded: Set<string>;

  // ── Streaming discipline ────────────────────────────────────────────
  /** Highest `seq` rendered per Run: R16.4's dedupe floor and 11.1's resume point. */
  lastRenderedSeq: Record<string, number>;
  pendingApprovalId: string | null;

  // ── Scrolling ───────────────────────────────────────────────────────
  /** True while the viewport is pinned to the newest row (R20.7). */
  anchored: boolean;
  /** Rows appended since the view un-anchored, for R20.8's jump control. */
  rowsSinceUnanchored: number;
}

export interface ChatSurfaceActions {
  setDraft(draft: string): void;
  setMentionQuery(query: MentionQuery | null): void;
  addMention(mention: ResolvedMention): void;
  removeMention(id: string): void;
  /** Mark a chip unresolved rather than dropping it (R12.7). */
  markMentionUnresolved(id: string): void;
  setConversationMode(mode: ConversationMode): void;
  setEffort(effort: Effort): void;

  decideHunk(planId: string, path: string, hunkId: string, decision: HunkDecision): void;
  /** Accept or reject a hunkless file — a pure rename (design.md:2769). */
  decideFile(planId: string, path: string, decision: HunkDecision): void;
  /** Clear one file's decisions when its diff is regenerated (R10.8). */
  clearFileDecisions(planId: string, path: string): void;
  clearPlanDecisions(planId: string): void;

  toggleExpanded(rowId: string): void;
  setExpanded(rowId: string, open: boolean): void;

  recordRenderedSeq(runId: string, seq: number): void;
  forgetRun(runId: string): void;
  setPendingApprovalId(requestId: string | null): void;

  setAnchored(anchored: boolean): void;
  /** Derive `anchored` from a scroll position, per R20.7's measured rule. */
  observeScroll(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }): void;
  noteRowAppended(): void;

  /** Reset everything that is scoped to one Session, on a Session switch. */
  resetForSession(): void;
}

export type ChatSurfaceStore = ChatSurfaceState & ChatSurfaceActions;

export const INITIAL_CHAT_SURFACE_STATE: ChatSurfaceState = {
  draft: "",
  mentions: [],
  mentionQuery: null,
  // R32.1's default. `Agent` rather than `Ask`, because it is the mode a Session with no
  // prior submission restores to (Property 78) and the one the product is for.
  conversationMode: "agent",
  effort: "balanced",
  hunkDecisions: {},
  expanded: new Set<string>(),
  lastRenderedSeq: {},
  pendingApprovalId: null,
  // A fresh transcript is at the bottom because it is empty.
  anchored: true,
  rowsSinceUnanchored: 0,
};

/**
 * Set one decision without disturbing its siblings.
 *
 * Written as a helper rather than inline in three actions because the nesting is where a
 * mistake would be invisible: a spread that dropped a level would clear every other file's
 * decisions in the same plan, and the user would see it as their review silently resetting.
 */
function withDecision(
  decisions: HunkDecisions,
  planId: string,
  path: string,
  key: string,
  decision: HunkDecision,
): HunkDecisions {
  const plan = decisions[planId] ?? {};
  const file = plan[path] ?? {};
  return {
    ...decisions,
    [planId]: { ...plan, [path]: { ...file, [key]: decision } },
  };
}

/**
 * A copy of `record` without `key`.
 *
 * Written as a helper rather than as rest-destructuring at each of the three call sites,
 * because the destructuring form binds a variable it never reads and the lint rule is right
 * to say so — `ignoreRestSiblings` would silence it everywhere in the app to permit an
 * idiom used three times in one file.
 */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next: Record<string, T> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name !== key) next[name] = value;
  }
  return next;
}

export const useChatSurface = create<ChatSurfaceStore>((set, get) => ({
  ...INITIAL_CHAT_SURFACE_STATE,

  setDraft: (draft) => set({ draft }),
  setMentionQuery: (mentionQuery) => set({ mentionQuery }),

  addMention: (mention) =>
    set((state) =>
      // Idempotent by id, because the popover can fire twice on a fast double-accept and a
      // duplicate chip is both a duplicate token cost and a chip the user cannot remove.
      state.mentions.some((existing) => existing.id === mention.id)
        ? state
        : { mentions: [...state.mentions, mention] },
    ),

  removeMention: (id) =>
    set((state) => ({ mentions: state.mentions.filter((mention) => mention.id !== id) })),

  markMentionUnresolved: (id) =>
    set((state) => ({
      mentions: state.mentions.map((mention) =>
        mention.id === id ? { ...mention, resolved: false } : mention,
      ),
    })),

  setConversationMode: (conversationMode) => set({ conversationMode }),
  setEffort: (effort) => set({ effort }),

  decideHunk: (planId, path, hunkId, decision) =>
    set((state) => ({
      hunkDecisions: withDecision(state.hunkDecisions, planId, path, hunkId, decision),
    })),

  decideFile: (planId, path, decision) =>
    set((state) => ({
      hunkDecisions: withDecision(state.hunkDecisions, planId, path, FILE_LEVEL_DECISION, decision),
    })),

  clearFileDecisions: (planId, path) =>
    set((state) => {
      const plan = state.hunkDecisions[planId];
      if (plan === undefined || !(path in plan)) return state;
      // The path is removed rather than set to `{}`, so "no decisions" and "decided
      // nothing" are one state — `undecided` is the absence, per R10.3's default.
      return {
        hunkDecisions: { ...state.hunkDecisions, [planId]: omitKey(plan, path) },
      };
    }),

  clearPlanDecisions: (planId) =>
    set((state) => {
      if (!(planId in state.hunkDecisions)) return state;
      return { hunkDecisions: omitKey(state.hunkDecisions, planId) };
    }),

  toggleExpanded: (rowId) =>
    set((state) => {
      const next = new Set(state.expanded);
      if (!next.delete(rowId)) next.add(rowId);
      return { expanded: next };
    }),

  setExpanded: (rowId, open) =>
    set((state) => {
      if (state.expanded.has(rowId) === open) return state;
      const next = new Set(state.expanded);
      if (open) next.add(rowId);
      else next.delete(rowId);
      return { expanded: next };
    }),

  recordRenderedSeq: (runId, seq) =>
    set((state) => {
      const current = state.lastRenderedSeq[runId] ?? 0;
      // Monotone by construction. A resume replays from an exclusive floor, so a late
      // duplicate must not move the floor backwards and re-admit a part already rendered
      // (R16.4).
      if (seq <= current) return state;
      return { lastRenderedSeq: { ...state.lastRenderedSeq, [runId]: seq } };
    }),

  forgetRun: (runId) =>
    set((state) => {
      if (!(runId in state.lastRenderedSeq)) return state;
      return { lastRenderedSeq: omitKey(state.lastRenderedSeq, runId) };
    }),

  setPendingApprovalId: (pendingApprovalId) => set({ pendingApprovalId }),

  setAnchored: (anchored) =>
    set((state) =>
      state.anchored === anchored
        ? state
        : // Re-anchoring clears the backlog: the rows the count referred to are now on
          // screen, so a non-zero count beside no jump control is a stale number.
          { anchored, rowsSinceUnanchored: anchored ? 0 : state.rowsSinceUnanchored },
    ),

  observeScroll: ({ scrollHeight, scrollTop, clientHeight }) => {
    // R20.7's rule, measured rather than inferred from a scroll direction: 32 px is large
    // enough that a trackpad's inertial overscroll does not un-anchor the view, and small
    // enough that a deliberate one-row scroll up does.
    const distance = scrollHeight - scrollTop - clientHeight;
    get().setAnchored(distance <= ANCHOR_THRESHOLD_PX);
  },

  noteRowAppended: () =>
    set((state) =>
      state.anchored ? state : { rowsSinceUnanchored: state.rowsSinceUnanchored + 1 },
    ),

  resetForSession: () =>
    set({
      ...INITIAL_CHAT_SURFACE_STATE,
      // Fresh collections, not the module-level ones: sharing the initial `Set` and the
      // initial objects across resets would let one Session's expansions leak into the next.
      expanded: new Set<string>(),
      mentions: [],
      hunkDecisions: {},
      lastRenderedSeq: {},
    }),
}));

/**
 * The decision for one hunk, defaulting to `undecided`.
 *
 * A selector rather than a raw map read at every call site, so `undecided` being the
 * absence of an entry is a fact expressed once.
 */
export function hunkDecisionOf(
  decisions: HunkDecisions,
  planId: string,
  path: string,
  hunkId: string,
): HunkDecision {
  return decisions[planId]?.[path]?.[hunkId] ?? "undecided";
}

/** The file-level decision for a hunkless file, defaulting to `undecided`. */
export function fileDecisionOf(
  decisions: HunkDecisions,
  planId: string,
  path: string,
): HunkDecision {
  return hunkDecisionOf(decisions, planId, path, FILE_LEVEL_DECISION);
}

/**
 * Mentions that belong in the next request (R12.7).
 *
 * Unresolved chips stay in the store so the composer can render them struck through, and
 * are excluded here — one place, so a caller cannot forget.
 */
export function requestableMentions(
  mentions: readonly ResolvedMention[],
): readonly ResolvedMention[] {
  return mentions.filter((mention) => mention.resolved);
}

/** Estimated attached-context cost, for R12.5's pre-submission figure. */
export function attachedTokenCost(mentions: readonly ResolvedMention[]): number {
  return requestableMentions(mentions).reduce(
    (total, mention) => total + Math.max(0, mention.estimatedTokens),
    0,
  );
}
