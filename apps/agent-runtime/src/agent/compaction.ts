/**
 * Context compaction — zoc-agent-chat-rebuild R34.1, R34.2, R34.4, R34.5, R34.8, R34.9.
 *
 * One module owns the whole mechanism, because its four parts — deciding to fold,
 * choosing what to fold, producing the summary, and keeping the summary alive —
 * are one decision each and share all their state.
 *
 * Three properties are load-bearing, and each one is a decision that would look
 * like an over-complication to a later reader who did not have to make it:
 *
 * 1. **Compaction changes what the model sees, not what the Session contains.**
 *    Stored history is never truncated. A fold produces a `CompactionPart`
 *    naming the folded message ids and a summary that replaces them, and the
 *    *view* over history is rebuilt from that part on every assembly. That is
 *    what lets the transcript keep rendering the folded turns to the user
 *    (R34.6) while the model receives the summary instead.
 * 2. **The pin is derived from the newest `CompactionPart`, never stored
 *    separately.** A `pinnedSummary` field on the Session would be a second
 *    place to read the pin from, and one of the two could go stale. Deriving it
 *    means the row the user reads and the context the model receives come from
 *    the same bytes — see {@link pinFrom}.
 * 3. **No partial fold is representable (R34.9).** The summarisation call happens
 *    *first*; the `CompactionPart` is constructed only from a successful result.
 *    There is no "mark these folded, now summarise" intermediate state, so there
 *    is nothing to roll back and stored history is unchanged by construction
 *    rather than by a cleanup path that could itself fail.
 *
 * **This module never selects a model.** R34.8 requires the Session's own model,
 * and the consequence is the requirement's whole point: a Session on
 * `local-llamacpp` compacts on loopback, so a zero-key local Session still makes
 * no outbound request (A6). Routing compaction to a cheap cloud model would have
 * been the obvious optimisation and it would have broken the offline guarantee
 * outright. That is why summarisation arrives as an injected {@link Summarise}
 * port bound to `ctx.model` by the caller: there is no model registry reachable
 * from this file to accidentally pick from.
 *
 * **`generateText`, not `Output.object()`.** R5.3's default is a structured
 * result, and a summary is not one — R34.2 wants `summary` as text and R34.7
 * renders it as read-only prose. Wrapping a paragraph in a single-field object
 * would add a schema-validation failure mode to a call whose output has no shape
 * to validate, and R34.9 would then have to report a compaction failure caused by
 * the compaction machinery rather than by the model. This is the one deliberate
 * exception to R5.3 and it is recorded here so a later pass does not "align" it.
 * The structured half of the record — folded ids, turn count, before and after
 * token counts — is computed here and never asked of the model, which is what
 * makes those figures trustworthy.
 */

import type { CompactionPart, MessagePart, PartBase } from "@zoc-studio/shared-types";

/** The fraction of the model's context window that triggers a fold (R34.1). */
export const COMPACTION_THRESHOLD = 0.85;

/**
 * How far below the threshold a fold aims, as a fraction of the window.
 *
 * Selection stops once the projected post-fold count is at or under
 * `(COMPACTION_THRESHOLD - COMPACTION_HEADROOM) × contextLimit`. Without the
 * headroom a fold would land exactly at the trigger point and the very next turn
 * would re-trigger it, which is a compaction per turn — the summariser call is a
 * real provider call, so that is a real cost. With it, a fold buys roughly ten
 * percent of the window before the next one. Revisable per A10 alongside the
 * threshold itself.
 */
export const COMPACTION_HEADROOM = 0.1;

/**
 * Turns at the newest end of the conversation that are never folded.
 *
 * Four is chosen against how the panel is actually used: a follow-up like "now do
 * the same for the other file" refers back through the last two or three
 * exchanges, and a model that has lost them answers a question nobody asked. Four
 * leaves one turn of margin past that.
 */
export const RETAINED_TURN_FLOOR = 4;

/**
 * The summary's token ceiling, and the ceiling selection projects against.
 *
 * Selection has to price the replacement before the replacement exists, so the
 * summariser is told a budget and the projection assumes it is spent in full.
 * Assuming the worst case means a fold can undershoot its target but never
 * overshoot into a post-fold request that is still over the threshold.
 */
export const SUMMARY_TOKEN_BUDGET = 1024;

/**
 * The same ceiling as a fraction of the window, which is what actually applies to
 * a small-context model.
 *
 * A flat 1024 tokens is a rounding error against a 200k window and most of a 1k
 * one, and taking the flat number on the small model would make every fold project
 * as a net loss — the module would decline every compaction on exactly the models
 * that need it most. The effective budget is the smaller of the two.
 */
export const SUMMARY_BUDGET_FRACTION = 0.05;

/** The effective summary budget for a given window. */
export function summaryBudgetFor(contextLimit: number): number {
  const limit = Math.max(0, contextLimit);
  return Math.max(1, Math.min(SUMMARY_TOKEN_BUDGET, Math.floor(limit * SUMMARY_BUDGET_FRACTION)));
}

/** The heuristic's characters-per-token divisor, matching the Python token gate. */
export const CHARS_PER_TOKEN = 4;

/**
 * The fallback token estimate: `ceil(len / 4)`.
 *
 * Deliberately the same arithmetic as `services/gateway/.../token_gate.py`, so a
 * count taken on either side of the process boundary agrees. The runtime counts
 * with the provider's own tokenizer where the SDK exposes one and falls back to
 * this; the heuristic's error is why R12.9 marks the figure as an estimate, and
 * the trigger is deliberately tolerant of it — 85 percent against a count that
 * can be ten percent low still fires before the window closes, which is why the
 * threshold is not 95.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Injectable token counter, so a provider tokenizer can replace the heuristic. */
export type CountTokens = (text: string) => number;

// ── The request being measured ─────────────────────────────────────────────

/** One stored message, reduced to what compaction needs of it. */
export interface HistoryMessage {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  /**
   * The message's text as the provider will receive it — assistant prose, tool
   * inputs, and tool results flattened together. Compaction counts and folds at
   * message granularity, so it needs one string per message rather than the part
   * list, and flattening is the caller's job because only the caller knows how
   * its parts serialise.
   */
  readonly text: string;
}

/**
 * The active pin, derived from the newest `CompactionPart` (see {@link pinFrom}).
 *
 * Carries the previous `foldedMessageIds` as well as the summary text because a
 * second compaction's ids are the union of the previous part's and the newly
 * folded ones — that union is what keeps pin derivation a read of one part.
 */
export interface CompactionPin {
  readonly compactionId: string;
  readonly summary: string;
  readonly foldedMessageIds: readonly string[];
}

/**
 * Everything the provider call will count against the window.
 *
 * Naming the components rather than accepting one pre-summed number is the point:
 * R34.1's numerator has to be the *whole* assembled request or the trigger reads
 * as "the message text", which is the one reading that makes it fire too late. A
 * Session with 30 KB of rules and a large mention set would sail past the real
 * limit while the counter read comfortable.
 */
export interface AssembledRequest {
  /** System instructions — rules sources plus workspace facts, from `assembleInstructions`. */
  readonly instructions: string;
  /** The active pin, or null when the Session has never compacted. */
  readonly pin: CompactionPin | null;
  /** Resolved `@`-mention payloads. */
  readonly mentions: readonly string[];
  /** Tool schemas the registry contributes to the request. */
  readonly toolSchemas: readonly string[];
  /**
   * The message history this request will send, oldest first — **excluding the
   * pinned summary**, which is carried on `pin` and prepended at dispatch by
   * {@link viewOf}.
   *
   * Carrying the summary in exactly one place is what keeps the arithmetic
   * honest: if it appeared both here and on `pin`, `measure` would count it
   * twice, the trigger would fire early, and `censusOf` would report a summary as
   * one of the Session's messages when it is not one.
   */
  readonly messages: readonly HistoryMessage[];
  /** The selected model's context window, in tokens. */
  readonly contextLimit: number;
  /** Messages stored in the Session, folded ones included. */
  readonly sessionMessageCount: number;
}

/** The four R12.8 facts the context indicator displays. */
export interface ContextCensus {
  readonly messagesInContext: number;
  readonly sessionMessageCount: number;
  readonly messagesOutOfWindow: number;
  readonly summaryActive: boolean;
}

/**
 * The census over an assembled request, after any fold has been applied.
 *
 * `sessionMessageCount` is floored at the in-context count so a caller that has
 * not counted stored history cannot produce a negative `messagesOutOfWindow` —
 * "minus three messages outside the window" is worse than an undercount, because
 * an undercount reads as a stale number and a negative reads as a broken product.
 */
export function censusOf(assembled: AssembledRequest): ContextCensus {
  const messagesInContext = assembled.messages.length;
  const sessionMessageCount = Math.max(assembled.sessionMessageCount, messagesInContext);
  return {
    messagesInContext,
    sessionMessageCount,
    messagesOutOfWindow: sessionMessageCount - messagesInContext,
    summaryActive: (assembled.pin?.summary.length ?? 0) > 0,
  };
}

// ── Measurement ────────────────────────────────────────────────────────────

/** A request's token cost, split so selection can subtract what it folds. */
export interface RequestMeasure {
  /** Instructions, mentions, tool schemas — the cost no fold can reduce. */
  readonly fixed: number;
  /** The active pin's summary, which a new fold supersedes rather than keeps. */
  readonly pin: number;
  /** Per-message cost, index-aligned with `assembled.messages`. */
  readonly messages: readonly number[];
  readonly total: number;
  /** `floor(contextLimit × COMPACTION_THRESHOLD)`. */
  readonly threshold: number;
  /** `floor(contextLimit × (COMPACTION_THRESHOLD − COMPACTION_HEADROOM))`. */
  readonly target: number;
  /** The replacement summary's ceiling for this window — see {@link summaryBudgetFor}. */
  readonly summaryBudget: number;
}

export function measure(
  assembled: AssembledRequest,
  count: CountTokens = estimateTokens,
): RequestMeasure {
  const sum = (parts: readonly string[]): number =>
    parts.reduce((running, part) => running + count(part), 0);

  const fixed =
    count(assembled.instructions) + sum(assembled.mentions) + sum(assembled.toolSchemas);
  const pin = assembled.pin === null ? 0 : count(assembled.pin.summary);
  const messages = assembled.messages.map((message) => count(message.text));
  const limit = Math.max(0, assembled.contextLimit);

  return {
    fixed,
    pin,
    messages,
    total: fixed + pin + messages.reduce((running, value) => running + value, 0),
    threshold: Math.floor(limit * COMPACTION_THRESHOLD),
    target: Math.floor(limit * (COMPACTION_THRESHOLD - COMPACTION_HEADROOM)),
    summaryBudget: summaryBudgetFor(limit),
  };
}

/**
 * Whether the request is at or over the trigger (R34.1).
 *
 * At-or-over, not over: 85 percent exactly is the threshold being reached, and a
 * strict comparison would make the guard test for "fires at 85% and not at 84%"
 * pass for the wrong reason.
 */
export function isOverThreshold(measured: RequestMeasure): boolean {
  return measured.threshold > 0 && measured.total >= measured.threshold;
}

// ── Turns ──────────────────────────────────────────────────────────────────

/**
 * One conversational turn: a user message plus every message that answered it.
 *
 * Whole turns only, and that is the constraint the rest of selection is built
 * around. Folding half a turn leaves a tool result whose call is gone, or an
 * answer whose question is gone, and a model reading that reasons about a
 * conversation that never happened.
 */
export interface Turn {
  /** Index into `assembled.messages` where the turn's user message sits. */
  readonly start: number;
  readonly messageIds: readonly string[];
  readonly tokens: number;
}

/**
 * Group messages into turns, oldest first.
 *
 * Messages before the first `user` message are *not* a turn — a system-role
 * preamble (the pinned summary is prepended as one) belongs to the request, not to
 * the conversation, and treating it as a turn would make it the first fold
 * candidate. The pinned summary is never a fold candidate: it is the compressed
 * form of everything already folded, so feeding it back through selection would
 * make each compaction a summary of a summary and the detail loss would compound
 * silently.
 */
export function turnsOf(
  messages: readonly HistoryMessage[],
  tokens: readonly number[],
): readonly Turn[] {
  const turns: Turn[] = [];
  let current: { start: number; messageIds: string[]; tokens: number } | null = null;

  messages.forEach((message, index) => {
    if (message.role === "user") {
      if (current !== null) turns.push(current);
      current = { start: index, messageIds: [message.id], tokens: tokens[index] ?? 0 };
      return;
    }
    if (current === null) return; // preamble: not part of any turn
    current.messageIds.push(message.id);
    current.tokens += tokens[index] ?? 0;
  });

  if (current !== null) turns.push(current);
  return turns;
}

// ── The pin ────────────────────────────────────────────────────────────────

/**
 * Derive the active pin from a Session's stored parts (R34.3, R34.6).
 *
 * The newest `CompactionPart` wins, by `seq`, with the later occurrence breaking a
 * tie. Both records survive in the transcript because each one records a real
 * event — **the pin is replaced, the record accumulates** — so "newest" has to be
 * decided here rather than by assuming the store holds only one.
 */
export function pinFrom(parts: readonly MessagePart[]): CompactionPin | null {
  let newest: CompactionPart | null = null;
  for (const part of parts) {
    if (part.type !== "compaction") continue;
    if (newest === null || part.seq >= newest.seq) newest = part;
  }
  if (newest === null) return null;
  return {
    compactionId: newest.compactionId,
    summary: newest.summary,
    foldedMessageIds: newest.foldedMessageIds,
  };
}

/**
 * Build the model's view of stored history: drop the folded messages, prepend the
 * summary as a system message.
 *
 * A filter and a prefix over *complete* stored history, which is what makes R34.6
 * a read of the transcript rather than a special case. Nothing here truncates.
 */
export function viewOf(
  stored: readonly HistoryMessage[],
  pin: CompactionPin | null,
): readonly HistoryMessage[] {
  if (pin === null) return stored;
  const folded = new Set(pin.foldedMessageIds);
  const kept = stored.filter((message) => !folded.has(message.id));
  return [
    { id: `${pin.compactionId}:summary`, role: "system" as const, text: pin.summary },
    ...kept,
  ];
}

// ── Selection ──────────────────────────────────────────────────────────────

/** A chosen fold, priced but not yet summarised. */
export interface FoldPlan {
  /** The turns to fold, oldest first. */
  readonly turns: readonly Turn[];
  /** Every message id the new record will name — the union with the previous pin's. */
  readonly foldedMessageIds: readonly string[];
  readonly foldedTurnCount: number;
  /** Tokens the folded turns cost, plus the superseded pin. */
  readonly reclaimed: number;
  readonly contextTokensBefore: number;
  /** The worst-case post-fold count: `before − reclaimed + summaryBudget`. */
  readonly projected: number;
}

/**
 * Choose which turns to fold, or `null` when no fold is worth making.
 *
 * Oldest first, stopping as soon as the projection is at or under the target.
 * **It does not fold everything it is allowed to fold:** over-folding costs detail
 * for no benefit, and the detail it costs is exactly the detail a follow-up
 * question is most likely to need.
 *
 * Returns `null` in two cases, and they are the same case from the caller's side —
 * there is nothing to fold that would not break the conversation:
 *
 * - Fewer than `RETAINED_TURN_FLOOR + 1` turns exist, so the floor covers all of
 *   them.
 * - Folding *every* foldable turn still leaves the request at or over the
 *   threshold, which is R34.1's `insufficient-history`. The correct outcome then
 *   is the provider's own `context_window_exceeded` with R12.6's
 *   remove-an-attachment action, not a fold that destroys the question.
 *
 * `requireReduction` is what separates the automatic path from the manual one: an
 * automatic fold exists to get under the threshold and declines when it cannot,
 * while a manual fold (R34.4) was asked for explicitly and folds everything
 * foldable regardless of where the count lands.
 */
export function selectFold(
  assembled: AssembledRequest,
  measured: RequestMeasure,
  options: { readonly requireReduction: boolean },
): FoldPlan | null {
  const turns = turnsOf(assembled.messages, measured.messages);
  const foldable = turns.slice(0, Math.max(0, turns.length - RETAINED_TURN_FLOOR));
  if (foldable.length === 0) return null;

  const before = measured.total;
  const project = (reclaimed: number): number => before - reclaimed + measured.summaryBudget;

  // The superseded pin is reclaimed by any fold: the new summary receives the old
  // one as input and its output replaces it, so the old text leaves the request.
  const everything = measured.pin + foldable.reduce((running, turn) => running + turn.tokens, 0);
  if (options.requireReduction && project(everything) > measured.threshold) return null;

  const chosen: Turn[] = [];
  let reclaimed = measured.pin;
  for (const turn of foldable) {
    chosen.push(turn);
    reclaimed += turn.tokens;
    if (options.requireReduction && project(reclaimed) <= measured.target) break;
  }

  return {
    turns: chosen,
    foldedMessageIds: [
      ...(assembled.pin?.foldedMessageIds ?? []),
      ...chosen.flatMap((turn) => turn.messageIds),
    ],
    foldedTurnCount: chosen.length,
    reclaimed,
    contextTokensBefore: before,
    projected: project(reclaimed),
  };
}

// ── Summarisation ──────────────────────────────────────────────────────────

export interface SummariseInput {
  readonly sessionId: string;
  /** The turns being folded, oldest first, as the provider will read them. */
  readonly messages: readonly HistoryMessage[];
  /**
   * The superseded summary, or null on a first compaction.
   *
   * Passed as *input context* rather than as something to preserve verbatim: a
   * second compaction folds the previous summary's content, and its own output
   * replaces it.
   */
  readonly previousSummary: string | null;
  /** The budget selection priced the replacement against. */
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export interface SummariseResult {
  readonly text: string;
  /**
   * The summarisation call's own token usage.
   *
   * Reported rather than hidden: it is a provider call, it costs money on a cloud
   * model, and omitting it would make the Session's cumulative total (R27.2)
   * wrong. The caller adds it to the Run's `UsagePart` totals. It is excluded from
   * `tokensPerSecond` — that meter measures the answer stream, and a summarisation
   * is not the answer.
   */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/**
 * The summariser, bound to the Session's own model by the caller (R34.8).
 *
 * A port rather than a call into a provider registry so this module has no way to
 * reach a model of its own — the offline guarantee is structural, not a rule
 * someone has to remember.
 */
export type Summarise = (input: SummariseInput) => Promise<SummariseResult>;

/** The slice of `RunWriter` compaction needs (9.1). Narrow, so tests need no writer. */
export interface CompactionWriter {
  compaction(payload: Omit<CompactionPart, keyof PartBase | "type">): CompactionPart;
}

/**
 * What compaction needs from the Run it is folding for.
 *
 * Structural rather than the concrete `RunContext` (9.6), so this module compiles
 * and tests before the agent builder exists and cannot acquire a dependency on
 * anything else the Run carries.
 */
export interface CompactionContext {
  readonly writer: CompactionWriter;
  readonly summarise: Summarise;
  /** The provider's tokenizer where one is exposed; the heuristic otherwise. */
  readonly countTokens?: CountTokens;
  /** Injectable so a record's id is stable in a test. */
  readonly newCompactionId?: () => string;
  readonly signal?: AbortSignal;
}

export interface CompactionOutcome {
  readonly kind: "folded" | "not-needed" | "insufficient-history" | "failed";
  /** The emitted record. Present only on `folded` — see the file header's point 3. */
  readonly record?: CompactionPart;
  /**
   * The request with the fold applied, for the caller to dispatch in place of the
   * one it passed in.
   *
   * Returned rather than mutated because `AssembledRequest` is immutable, and it is
   * immutable so that a failed compaction cannot have left a half-rewritten
   * request behind for the caller to dispatch by accident.
   */
  readonly request?: AssembledRequest;
  readonly census?: ContextCensus;
  readonly usage?: SummariseResult["usage"];
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: true };
}

const FAILED = (message: string): CompactionOutcome => ({
  kind: "failed",
  error: { code: "compaction_failed", message, retryable: true },
});

let compactionCounter = 0;

function nextCompactionId(): string {
  compactionCounter += 1;
  return `cmp_${Date.now().toString(36)}_${compactionCounter.toString(36)}`;
}

/**
 * Apply a fold to a request: drop the folded messages, replace the pin.
 *
 * The dropped messages leave *this request*, not the Session — `sessionMessageCount`
 * is carried through unchanged, which is what lets `censusOf` keep reporting how
 * many messages sit outside the window.
 */
export function applyFold(
  assembled: AssembledRequest,
  plan: FoldPlan,
  pin: CompactionPin,
): AssembledRequest {
  const folded = new Set(plan.turns.flatMap((turn) => turn.messageIds));
  return {
    ...assembled,
    pin,
    messages: assembled.messages.filter((message) => !folded.has(message.id)),
  };
}

/**
 * Summarise, then record. The order is R34.9's whole mechanism.
 *
 * Every failure path returns before `writer.compaction` is reached, so there is no
 * state to undo — a failed compaction cannot produce a record, and without a
 * record there is no pin, so the next Run assembles exactly the context this one
 * would have.
 */
async function fold(
  ctx: CompactionContext,
  sessionId: string,
  assembled: AssembledRequest,
  measured: RequestMeasure,
  plan: FoldPlan,
): Promise<CompactionOutcome> {
  const count = ctx.countTokens ?? estimateTokens;
  const foldedIds = new Set(plan.turns.flatMap((turn) => turn.messageIds));

  let summary: SummariseResult;
  try {
    summary = await ctx.summarise({
      sessionId,
      messages: assembled.messages.filter((message) => foldedIds.has(message.id)),
      previousSummary: assembled.pin?.summary ?? null,
      maxTokens: measured.summaryBudget,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (cause) {
    return FAILED(
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "The summary could not be produced.",
    );
  }

  const text = summary.text.trim();
  // An empty summary is a failure, not an empty fold: a record whose summary says
  // nothing would pin the context to nothing and silently delete the folded turns
  // from what the model sees.
  if (text.length === 0) return FAILED("The summariser returned an empty summary.");

  const contextTokensAfter = measured.total - plan.reclaimed + count(text);
  // The wire model refuses a record whose token count grew, and refusing here as
  // well means the refusal is a reported failure rather than a validation throw
  // from inside the writer. It happens when a small fold produces a large summary.
  if (contextTokensAfter > plan.contextTokensBefore) {
    return FAILED("The summary was larger than the turns it replaced.");
  }

  const record = ctx.writer.compaction({
    compactionId: (ctx.newCompactionId ?? nextCompactionId)(),
    foldedMessageIds: [...plan.foldedMessageIds],
    foldedTurnCount: plan.foldedTurnCount,
    contextTokensBefore: plan.contextTokensBefore,
    contextTokensAfter,
    summary: text,
  });

  const request = applyFold(assembled, plan, {
    compactionId: record.compactionId,
    summary: text,
    foldedMessageIds: record.foldedMessageIds,
  });

  return {
    kind: "folded",
    record,
    request,
    census: censusOf(request),
    ...(summary.usage ? { usage: summary.usage } : {}),
  };
}

/**
 * Fold if the assembled request is at or over the threshold (R34.1).
 *
 * **Where this is called from matters as much as what it does.** It sits inside
 * `createUIMessageStream`'s `execute`, between `assembleRequest()` and
 * `agent.stream()`. That is the only place the check can live: before assembly
 * there is nothing to count, and after dispatch it is too late. Because the
 * `RunWriter` already exists there, the `CompactionPart` draws its `seq` from the
 * Run's own allocator like any other part.
 *
 * A fold therefore never interrupts a Run in flight. Mid-Run growth from tool
 * results is bounded by `stopWhen: stepCountIs(40)` and handled by the provider's
 * own context error mapping to `context_window_exceeded`, not by compacting under
 * the loop's feet.
 */
export async function compactIfNeeded(
  ctx: CompactionContext,
  sessionId: string,
  assembled: AssembledRequest,
): Promise<CompactionOutcome> {
  const measured = measure(assembled, ctx.countTokens ?? estimateTokens);
  if (!isOverThreshold(measured)) {
    return { kind: "not-needed", census: censusOf(assembled) };
  }

  const plan = selectFold(assembled, measured, { requireReduction: true });
  if (plan === null) {
    return { kind: "insufficient-history", census: censusOf(assembled) };
  }
  return fold(ctx, sessionId, assembled, measured, plan);
}

/**
 * Fold unconditionally, for the compact-now control (R34.4, R34.5).
 *
 * No threshold check — the user asked. Folds everything outside the retained floor
 * rather than the minimum that would clear a threshold, because there is no
 * threshold to clear and "reclaim context" is what the control promises.
 *
 * `not-needed` when fewer than `RETAINED_TURN_FLOOR + 1` turns exist: the floor
 * covers the whole conversation, so nothing is foldable. The route turns that into
 * `409 compaction_not_needed`.
 *
 * The route's other 409 — `compaction_run_active` — is not decided here. Whether a
 * Run is streaming on the Session is the run store's fact (9.3), and folding under
 * an in-flight Run would make the transcript claim a fold that the Run's provider
 * call never saw, with a `contextTokensAfter` describing a request nobody sent.
 */
export async function compactNow(
  ctx: CompactionContext,
  sessionId: string,
  assembled: AssembledRequest,
): Promise<CompactionOutcome> {
  const measured = measure(assembled, ctx.countTokens ?? estimateTokens);
  const plan = selectFold(assembled, measured, { requireReduction: false });
  if (plan === null) {
    return { kind: "not-needed", census: censusOf(assembled) };
  }
  return fold(ctx, sessionId, assembled, measured, plan);
}
