/**
 * The panel's derived state — zoc-agent-chat-rebuild R3.8, R13.9, R14.8, R16.5, R16.6, task 22.8.
 *
 * Feature: zoc-agent-chat-rebuild, task 22.8 (R3.8, R13.9, R14.8, R16.5, R16.6).
 *
 * Everything `ChatPanel` shows that is a *function* of `useChat`'s status and the transcript, extracted
 * so it can be asserted without mounting the panel. The panel itself is then wiring: providers, one
 * `useChat` instance, and a layout.
 *
 * ## Why the pill's state is not `useChat`'s status
 *
 * `status` has four values and the pill draws eight (16.3's `RunPillState`). The four missing ones —
 * queued, awaiting-approval, cancelled, interrupted — are all things only a `run-lifecycle` part knows,
 * and three of them are terminal states a `ready` status cannot distinguish: a Run the user cancelled
 * and a Run that completed both leave the hook `ready`. So the lifecycle part is authoritative for what
 * a Run *ended as*, and `status` is authoritative only for whether one is in flight at all.
 *
 * ## Why the rate is dropped the moment the Run settles
 *
 * R13.9 puts the live Token_Rate on the pill and R13.10 puts the terminal figure on the usage row. Two
 * places, two different numbers, and the pill keeping its last value after the Run ends would show a
 * live figure for a Run that is not running — which reads as a measurement rather than as a leftover.
 */

import type { ConversationMode, RunLifecyclePart, UsagePart } from "@zoc-studio/shared-types";

import type { ContextCensus } from "./composer/context-figures";
import type { RunPillState } from "./header/RunStatusPill";
import type { ZocUIMessage } from "./wire/ui-message";

/** `useChat`'s four-value status, restated so this module does not import the hook. */
export type ChatRunStatus = "submitted" | "streaming" | "ready" | "error";

/** States during which a Run is still going, so the clock runs and the rate is shown. */
const ACTIVE_STATES: ReadonlySet<RunPillState> = new Set([
  "queued",
  "running",
  "awaiting-approval",
]);

const TERMINAL_STATES: ReadonlySet<RunLifecyclePart["state"]> = new Set([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);

export interface RunSnapshot {
  /** The newest Run in the transcript, or `null` for a Session that has never run. */
  readonly runId: string | null;
  readonly state: RunPillState;
  /** Epoch milliseconds the Run started, for the pill's elapsed clock. `null` when idle. */
  readonly startedAt: number | null;
  /** R13.9's live figure, present only while the Run is active. */
  readonly tokensPerSecond: number | null;
  /** R16.5: the Run's stream was lost, so the transcript is partial and can be continued. */
  readonly interrupted: boolean;
  /** R16.4/11.1: a Run is in flight, so the composer queues rather than sends. */
  readonly active: boolean;
}

export const IDLE_RUN: RunSnapshot = {
  runId: null,
  state: "idle",
  startedAt: null,
  tokensPerSecond: null,
  interrupted: false,
  active: false,
};

/** Epoch milliseconds for an ISO timestamp, or `null` when it does not parse. */
function epochOf(iso: string | null | undefined): number | null {
  if (iso === undefined || iso === null || iso.length === 0) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest `run-lifecycle` part in the transcript, and the earliest one sharing its `runId`.
 *
 * Both, in one pass, because the pill needs the newest state and the oldest timestamp of the *same*
 * Run: a Run that was queued and then started has two parts, and reading the start time off the newest
 * one would restart the clock at the transition.
 */
function lifecycleOf(messages: readonly ZocUIMessage[]): {
  newest: RunLifecyclePart | null;
  openedAt: number | null;
} {
  let newest: RunLifecyclePart | null = null;
  let openedAt: number | null = null;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-zoc-run") continue;
      const data = part.data;
      // Ordered by `seq` rather than by array position: a resumed stream replays, so a later element
      // can carry an earlier part (R16.4).
      if (newest === null || data.seq >= newest.seq) newest = data;
    }
  }

  if (newest !== null) {
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "data-zoc-run" || part.data.runId !== newest.runId) continue;
        const at = epochOf(part.data.ts);
        if (at !== null && (openedAt === null || at < openedAt)) openedAt = at;
      }
    }
  }

  return { newest, openedAt };
}

/** The newest `UsagePart` for one Run, which is where the live rate comes from (R13.9). */
function rateOf(messages: readonly ZocUIMessage[], runId: string): number | null {
  let newest: UsagePart | null = null;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-zoc-usage" || part.data.runId !== runId) continue;
      if (newest === null || part.data.seq >= newest.seq) newest = part.data;
    }
  }
  const rate = newest?.tokensPerSecond;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * What the header's pill and the composer read about the newest Run.
 *
 * The order of the three rules is the whole logic, and it is this order because each one is about
 * something the next cannot see:
 *
 *   1. **A pending approval wins.** The dock is blocking progress, so "Waiting for you" is what the Run
 *      is doing — and the hook is still `streaming`, which would otherwise read as "Running" beside a
 *      dock the user has to answer. Passed in rather than re-derived here because the dock already owns
 *      the deadline arithmetic that decides whether a request is still pending (19.1).
 *   2. **In flight follows the lifecycle, defaulting to running.** `queued` is a real state the runtime
 *      reports with a position (9.3) and the hook has no vocabulary for it.
 *   3. **Settled follows the lifecycle's terminal state.** `ready` cannot tell completed from cancelled.
 *      A hook `error` with no terminal part is a failure the transport threw before a Run opened (11.1),
 *      which is the one case where `status` is the only evidence there is.
 */
export function runSnapshotOf(input: {
  readonly messages: readonly ZocUIMessage[];
  readonly status: ChatRunStatus;
  /** True while the dock is showing an undecided request (R11.8). */
  readonly awaitingApproval: boolean;
}): RunSnapshot {
  const { newest, openedAt } = lifecycleOf(input.messages);
  const inFlight = input.status === "submitted" || input.status === "streaming";

  const state: RunPillState = ((): RunPillState => {
    if (input.awaitingApproval && (inFlight || newest !== null)) return "awaiting-approval";
    if (inFlight) return newest?.state === "queued" ? "queued" : "running";
    if (newest !== null && TERMINAL_STATES.has(newest.state)) return newest.state;
    if (input.status === "error") return "failed";
    return newest === null ? "idle" : "running";
  })();

  const active = ACTIVE_STATES.has(state);
  const runId = newest?.runId ?? null;

  return {
    runId,
    state,
    startedAt: active ? openedAt : null,
    // Dropped the moment the Run settles: the usage row owns the terminal figure (R13.10).
    tokensPerSecond: active && runId !== null ? rateOf(input.messages, runId) : null,
    interrupted: !inFlight && newest?.state === "interrupted",
    active,
  };
}

/**
 * The context census, from the newest Run that reported one (R12.8, R12.9, R12.10).
 *
 * Three sources exist for these figures and this is the one place that picks between them: a streamed
 * `UsagePart`, which is the only one carrying `contextLimit`; the message metadata 1.4 mirrors onto a
 * finished turn, so a restored Session shows real numbers before its next Run; and, for a Session that
 * has never run, nothing — which is reported as an estimate rather than as zero consumption.
 *
 * `measuredAgainst` is built from the metadata's own provider and model paired with the usage part's own
 * limit, never from the currently selected model. That is the whole of R12.10: a census carried over from
 * the previous model must compare *unequal* to the current one so the meter says "estimated" instead of
 * showing last model's count against this model's window.
 *
 * `consumedTokens` is the last Run's input plus its output. The input was the context the runtime sent,
 * and the output has since joined the transcript, so their sum is what the next turn starts from — which
 * is the figure R12.5 is about.
 */
export function censusOf(messages: readonly ZocUIMessage[]): ContextCensus {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    const metadata = message.metadata;
    if (metadata === undefined) continue;

    let usage: UsagePart | null = null;
    for (const part of message.parts) {
      if (part.type !== "data-zoc-usage") continue;
      if (usage === null || part.data.seq >= usage.seq) usage = part.data;
    }

    const limit = usage?.contextLimit ?? 0;
    return {
      messagesInContext: usage?.messagesInContext ?? metadata.messagesInContext,
      sessionMessageCount: usage?.sessionMessageCount ?? metadata.sessionMessageCount,
      messagesOutOfWindow: usage?.messagesOutOfWindow ?? metadata.messagesOutOfWindow,
      summaryActive: usage?.summaryActive ?? metadata.summaryActive,
      consumedTokens:
        (usage?.inputTokens ?? metadata.inputTokens) +
        (usage?.outputTokens ?? metadata.outputTokens),
      // A turn with no `UsagePart` has no limit to name, so it cannot claim to have been measured
      // against a model — which is exactly R12.9's estimate case.
      measuredAgainst:
        limit > 0
          ? { provider: metadata.provider, modelId: metadata.model, contextLimit: limit }
          : null,
    };
  }

  return {
    messagesInContext: 0,
    sessionMessageCount: messages.length,
    messagesOutOfWindow: 0,
    summaryActive: false,
    consumedTokens: 0,
    measuredAgainst: null,
  };
}

/** The three Conversation_Modes, restated so a hand-edited transcript cannot smuggle a fourth in. */
const CONVERSATION_MODES: ReadonlySet<string> = new Set(["ask", "plan", "agent"]);

/**
 * The Conversation_Mode a restored Session should reopen in (R32.16).
 *
 * The newest message metadata that names one, which is the mode of the **last submission** — the runtime
 * writes `conversationMode` onto every finished turn precisely so this can be read without replaying
 * parts (see `ZocMessageMetadata`).
 *
 * `agent` for a Session with no submissions, per Amendment 11. That default is a decision rather than a
 * fallback: an empty mode would leave the composer's control with no selected value, and the two
 * remaining candidates are worse — `ask` silently downgrades what a returning user asked for last time
 * on any Session whose first Run never finished, and reading the *previous* Session's mode would make the
 * control's value depend on navigation history.
 *
 * Validated rather than trusted, for the same reason `restoreTranscript` checks its envelope: this value
 * comes off a file on the user's disk, and an unknown string reaching the mode control would render a
 * segmented control with nothing selected.
 */
export function conversationModeOf(messages: readonly ZocUIMessage[]): ConversationMode {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const mode: unknown = messages[index]?.metadata?.conversationMode;
    if (typeof mode === "string" && CONVERSATION_MODES.has(mode)) return mode as ConversationMode;
  }
  return "agent";
}

/**
 * The mark's state for a Run state (R18.7).
 *
 * Eight pill states collapse onto the mark's four, and the interesting arm is `cancelled` → `idle`
 * rather than `failed`: a Run the user stopped is not a failure, and painting the mark red for it would
 * tell the user their own decision went wrong. `awaiting-approval` reads as `running` because the Run has
 * not ended — it is waiting, which from the mark's point of view is activity.
 */
export function markStateOf(state: RunPillState): "idle" | "running" | "complete" | "failed" {
  switch (state) {
    case "queued":
    case "running":
    case "awaiting-approval":
      return "running";
    case "completed":
      return "complete";
    case "failed":
    case "interrupted":
      return "failed";
    case "idle":
    case "cancelled":
      return "idle";
  }
}

/** One of the empty state's three starting points. */
export interface Suggestion {
  readonly id: string;
  /** The chip's text, short enough to sit on one line. */
  readonly label: string;
  /** What pressing it puts in the composer. Full sentences, because that is what gets sent. */
  readonly prompt: string;
}

/** The last path segment, with either separator, or `null` for a root that names nothing. */
export function rootName(workspaceRoot: string | null): string | null {
  if (workspaceRoot === null) return null;
  const trimmed = workspaceRoot.replace(/[/\\]+$/u, "");
  if (trimmed.length === 0) return null;
  const segments = trimmed.split(/[/\\]/u);
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? null : last;
}

/**
 * Three starting points, derived from the open workspace.
 *
 * Workspace-derived rather than a fixed list because a generic prompt is one the user has to rewrite
 * before it is useful, and rewriting it is more work than typing their own. Naming the folder makes the
 * first chip immediately sendable, which is the only reason a suggestion chip earns its place.
 *
 * With no workspace open, the chips are about opening one instead of about code — a suggestion that
 * cannot be answered is worse than no suggestion, and R32.13 blocks a write-capable Run without a root
 * anyway.
 */
export function suggestionsFor(workspaceRoot: string | null): readonly Suggestion[] {
  const name = rootName(workspaceRoot);
  if (name === null) {
    return [
      {
        id: "open-folder",
        label: "How do I open a project?",
        prompt: "How do I open a project folder in Zoc Studio?",
      },
      {
        id: "what-can-you-do",
        label: "What can you do?",
        prompt: "What can you help me with in this editor?",
      },
      {
        id: "explain-modes",
        label: "Explain the modes",
        prompt: "Explain the difference between Ask, Plan, and Agent mode.",
      },
    ];
  }

  return [
    {
      id: "explain-structure",
      label: `How is ${name} structured?`,
      prompt: `Explain how ${name} is structured — the main directories and what each one is for.`,
    },
    {
      id: "review-changes",
      label: "Review my changes",
      prompt: "Review my uncommitted changes and tell me what looks wrong.",
    },
    {
      id: "find-tests",
      label: "Where are the tests?",
      prompt: `Where are the tests in ${name}, and how do I run them?`,
    },
  ];
}
