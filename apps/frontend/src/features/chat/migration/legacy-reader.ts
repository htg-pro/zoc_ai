/**
 * The legacy conversation reader — zoc-agent-chat-rebuild R23.1, R23.2, R23.4, R23.5, R23.6, task 24.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 24.1 (R23.1, R23.2, R23.4, R23.5, R23.6).
 *
 * A pre-upgrade conversation is a list of records from the Legacy_Panel's 19-kind `AgentEvent`
 * contract. This module turns one into a Session the Chat_Surface can render, and it is the only
 * place that knows the old vocabulary.
 *
 * ## Three outcomes per event, and why "unmapped" is not a failure
 *
 * {@link mapLegacyEvent} returns one of three things, and the three-way split is the whole design:
 *
 * - **Mapped parts** where a Message_Part says the same thing. `thinking` really is a `reasoning`
 *   part; `done` really is a `run-lifecycle` part.
 * - **Nothing**, for a telemetry-only event. `plan-update` is a status flip on a step the `plan`
 *   event already rendered — replaying it as a row would show the same step three times.
 * - **A historical row**, for a user-facing event with no counterpart. `stage`, `review`,
 *   `recovery-attempt` and friends were things a user *saw*, so dropping them would silently shorten
 *   their history. R23.2 asks for "a neutral historical row rather than failing", and that is this.
 *
 * The distinction that matters is the second versus the third. Both produce no Message_Part, and
 * conflating them either buries the transcript in status flips or quietly deletes evidence. So the
 * classification is a table ({@link UNMAPPED}) rather than a fallback: an event kind that is neither
 * mapped nor listed there is a *new* kind the reader has not been taught, and it becomes a historical
 * row too — which is the safe direction, and R23.2's actual requirement.
 *
 * ## Why the reader never throws
 *
 * R23.2 says a legacy event with no equivalent must not fail the conversation, and R23.4 says an
 * unreadable *conversation* must not take the others down. Those are two different scopes, so there
 * are two mechanisms: `mapLegacyEvent` is total over its input — it accepts `unknown` and degrades a
 * record it cannot understand into a historical row — and {@link readLegacyConversation} catches per
 * conversation, reporting one of the four {@link LegacyFailureReason}s. A malformed event costs one
 * row; a malformed conversation costs one conversation.
 *
 * ## Read-only by construction (R23.5)
 *
 * The reader depends on {@link LegacyStore}, which has two methods and both are reads. There is no
 * write path to forget to avoid — a caller cannot ask this module to modify the legacy store because
 * the port it is given cannot express it. That is R23.5 held by the type system rather than by
 * review, which matters because the failure it prevents is silent and permanent.
 */

// `AgentEvent` is deliberately *not* imported. The reader's input is a record written by a version
// of the app that no longer exists, so typing it as the current union would assert a guarantee the
// data does not carry — and would make the degradation paths below unreachable code rather than the
// load-bearing ones they are.
import type { MessagePart } from "@zoc-studio/shared-types";

import type { HistoricalEvent } from "../historical-rows";

// ── The read-only port (R23.5) ────────────────────────────────────────

/** One pre-upgrade conversation as the legacy store lists it. */
export interface LegacyConversationRef {
  readonly id: string;
  readonly title: string;
  /** ISO 8601. Orders the migrated Session list. */
  readonly updatedAt: string;
}

/**
 * The legacy store, reads only.
 *
 * Both methods are `GET`s against the retained Python endpoints. No `create`, no `update`, no
 * `delete`: R23.5 is a property of this interface, not of its callers.
 */
export interface LegacyStore {
  listConversations(): Promise<readonly LegacyConversationRef[]>;
  /** The raw event records, exactly as stored. Validation is this module's job, not the store's. */
  readEvents(conversationId: string): Promise<readonly unknown[]>;
}

// ── Mapping ───────────────────────────────────────────────────────────

/** What one legacy event became. */
export type LegacyMapping =
  /** Message_Parts that say the same thing the legacy event said. */
  | { readonly outcome: "mapped"; readonly parts: readonly MessagePart[] }
  /** Telemetry: the event carried no user-facing fact of its own. */
  | { readonly outcome: "skipped"; readonly why: string }
  /** User-facing, with no Message_Part counterpart (R23.2). */
  | { readonly outcome: "historical"; readonly label: string };

/**
 * Event kinds that are deliberately dropped, with the reason each is telemetry rather than history.
 *
 * Every entry here is a claim that the *same fact* reaches the transcript by another route. That is
 * why the reasons are recorded rather than implied: "we drop plan-update" is a bug report waiting to
 * happen, and "the plan event already rendered this step, and its final status is on the plan part"
 * is a decision someone can check.
 */
const UNMAPPED: Readonly<Record<string, string>> = {
  // The step and its status both belong to the `plan` event's items; replaying each flip would show
  // one step once per transition.
  "plan-update": "a status flip on a step the plan event already rendered",
  // Compression *counts* reach the transcript as a compaction part from `context-compressed`; this
  // event is the pre-flight notice with no figures of its own.
  "map-files": "a read/write projection, superseded by the tool calls that actually ran",
};

/** The seven kinds with a faithful Message_Part counterpart. */
const MAPPED_KINDS: ReadonlySet<string> = new Set([
  "intent",
  "thinking",
  "summary",
  "plan-ready",
  "context-compressed",
  "edit-file",
  "read-files",
  "command",
  "test-results",
  "approval",
  "permission",
  "budget",
  "done",
]);

/**
 * The label a historical row shows, per kind.
 *
 * A function rather than a table because three of them read a field off the event — `Stage: analyze`
 * is more use than `Stage`, and the collapsing rule in `historical-rows.ts` shows only the latest of
 * a run, so that field is the entire content of the row.
 */
function historicalLabel(event: Record<string, unknown>): string {
  const kind = String(event["type"] ?? "unknown");
  switch (kind) {
    case "stage": {
      const stage = String(event["stage"] ?? "");
      const state = String(event["state"] ?? "");
      return stage === "" ? "Stage" : `Stage: ${stage}${state === "" ? "" : ` (${state})`}`;
    }
    case "plan":
      return "Plan";
    case "review":
      return "Review";
    case "recovery-attempt":
      return `Recovery attempt ${String(event["attempt"] ?? "")}`.trim();
    default:
      return kind;
  }
}

/** Context the mapper needs but cannot derive from one event. */
export interface MapContext {
  /** The Message every part of this Run belongs to. */
  readonly messageId: string;
  /** The reader's re-numbered sequence for this event (R23.2's invariant). */
  readonly seq: number;
}

/** `PartBase`, which every mapped part carries identically. */
function base(event: Record<string, unknown>, context: MapContext) {
  return {
    seq: context.seq,
    runId: String(event["runId"] ?? ""),
    messageId: context.messageId,
    ts: String(event["ts"] ?? ""),
  };
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/**
 * One legacy event as Message_Parts, nothing, or a historical row.
 *
 * **Total over `unknown` on purpose.** The input is a record read off disk that was written by a
 * version of the app that no longer exists, so "it will be an `AgentEvent`" is an assumption, not a
 * type. A record that is not an object, or carries no `type`, degrades to a historical row — the
 * same outcome as an unrecognised kind, because from the reader's position they are the same
 * situation: something was stored, and it cannot be replayed as a part.
 */
export function mapLegacyEvent(event: unknown, context: MapContext): LegacyMapping {
  if (event === null || typeof event !== "object") {
    return { outcome: "historical", label: "Unreadable record" };
  }

  const record = event as Record<string, unknown>;
  const kind = str(record["type"]);

  const skip = UNMAPPED[kind];
  if (skip !== undefined) return { outcome: "skipped", why: skip };

  if (!MAPPED_KINDS.has(kind)) {
    return { outcome: "historical", label: historicalLabel(record) };
  }

  const parts = partsFor(kind, record, context);
  // A mapped kind whose payload was too damaged to build a part falls back to history rather than
  // vanishing: the event was user-facing, which is why it was in `MAPPED_KINDS` at all.
  if (parts.length === 0) return { outcome: "historical", label: historicalLabel(record) };
  return { outcome: "mapped", parts };
}

/** A synthetic id for a legacy record that predates the concept. Stable per event. */
function syntheticId(prefix: string, record: Record<string, unknown>): string {
  return `${prefix}_${str(record["runId"], "run")}_${String(num(record["seq"], 0))}`;
}

function partsFor(
  kind: string,
  record: Record<string, unknown>,
  context: MapContext,
): readonly MessagePart[] {
  const partBase = base(record, context);

  switch (kind) {
    // The agent restating the task, and its closing prose. Both are assistant text.
    case "intent":
    case "summary": {
      const text = str(record["text"]);
      if (text === "") return [];
      return [
        {
          ...partBase,
          type: "text",
          partId: syntheticId("txt", record),
          delta: text,
          done: true,
        },
      ];
    }

    case "thinking": {
      const text = str(record["text"]);
      if (text === "") return [];
      return [
        {
          ...partBase,
          type: "reasoning",
          partId: syntheticId("rsn", record),
          delta: text,
          elapsedMs: num(record["elapsedMs"]),
          done: true,
          // `truncated` is the legacy flag for "we did not keep all of this", which is the closest
          // thing it had to redaction. Mapping it to `redacted` keeps the row honest about being
          // partial rather than presenting a cut-off thought as a complete one.
          redacted: record["truncated"] === true,
        },
      ];
    }

    case "plan-ready": {
      const steps = Array.isArray(record["steps"]) ? record["steps"] : [];
      if (steps.length === 0) return [];
      return [
        {
          ...partBase,
          type: "plan",
          planId: syntheticId("plan", record),
          title: "Migrated plan",
          files: steps.map((step) => {
            const s = (step ?? {}) as Record<string, unknown>;
            return {
              path: str(s["file"]),
              action: (["create", "modify", "delete", "rename"].includes(str(s["action"]))
                ? str(s["action"])
                : "modify") as "create" | "modify" | "delete" | "rename",
              rationale: str(s["rationale"]),
              // The legacy step carried a diff but no line counts. Zeroes rather than a guess: a
              // fabricated `+41 −0` on a migrated plan is a number a user would trust.
              addedLines: 0,
              removedLines: 0,
              hunkCount: typeof s["diff"] === "string" && s["diff"] !== "" ? 1 : 0,
            };
          }),
          ...(str(record["verificationCommand"]) === ""
            ? {}
            : { verificationCommand: str(record["verificationCommand"]) }),
        },
      ];
    }

    case "context-compressed": {
      return [
        {
          ...partBase,
          type: "compaction",
          compactionId: syntheticId("cmp", record),
          // The legacy event named no messages, and inventing ids would produce a fold that points
          // at nothing. An empty fold renders as a compaction marker with no expandable turns, which
          // is exactly what is known.
          foldedMessageIds: [],
          foldedTurnCount: 0,
          contextTokensBefore: num(record["originalTokens"]),
          contextTokensAfter: num(record["compressedTokens"]),
          summary: "Context compressed before the upgrade",
        },
      ];
    }

    case "edit-file": {
      const path = str(record["path"]);
      const diff = str(record["diff"]);
      if (path === "") return [];
      return [
        {
          ...partBase,
          type: "diff",
          planId: syntheticId("plan", record),
          path,
          action: "modify",
          hunks:
            diff === ""
              ? []
              : [
                  {
                    // The legacy diff was one blob per file with no hunk boundaries recorded. It is
                    // presented as a single hunk carrying the whole patch rather than re-parsed:
                    // splitting it here would invent line numbers, and a migrated diff is read, not
                    // applied.
                    hunkId: syntheticId("hunk", record),
                    oldStart: 0,
                    oldLines: num(record["dels"]),
                    newStart: 0,
                    newLines: num(record["adds"]),
                    patch: diff,
                  },
                ],
          baseDigest: str(record["baseHash"]),
          // Always stale: the workspace has moved on since this was written, and offering to apply a
          // pre-upgrade diff against today's files is the one thing this migration must not do.
          stale: true,
        },
      ];
    }

    case "read-files": {
      const files = Array.isArray(record["files"]) ? record["files"] : [];
      const paths = files
        .map((file) => str((file as Record<string, unknown>)["path"]))
        .filter((p) => p !== "");
      if (paths.length === 0) return [];
      return [
        {
          ...partBase,
          type: "tool-output",
          toolCallId: syntheticId("call", record),
          durationMs: 0,
          summary: `Read ${String(paths.length)} file${paths.length === 1 ? "" : "s"}`,
          output: "",
          readPaths: paths,
          writtenPaths: [],
          truncated: false,
        },
      ];
    }

    case "command": {
      const command = str(record["command"]);
      if (command === "") return [];
      const status = str(record["status"]);
      const failed = status === "fail";
      const shared = {
        ...partBase,
        toolCallId: syntheticId("call", record),
        durationMs: 0,
      };
      if (failed) {
        return [
          {
            ...shared,
            type: "tool-error",
            code: str(record["errorTag"], "command_failed"),
            message: `${command} exited ${String(num(record["exitCode"], 1))}`,
            details: str(record["outputTail"]),
            // A pre-upgrade command cannot be retried into today's workspace.
            retryable: false,
          },
        ];
      }
      return [
        {
          ...shared,
          type: "tool-output",
          summary: command,
          output: str(record["outputTail"]),
          readPaths: [],
          writtenPaths: [],
          truncated: false,
        },
      ];
    }

    case "test-results": {
      const command = str(record["command"]);
      const passed = num(record["passed"]);
      const failed = num(record["failed"]);
      const shared = {
        ...partBase,
        toolCallId: syntheticId("call", record),
        durationMs: num(record["durationMs"]),
      };
      if (str(record["status"]) === "fail") {
        return [
          {
            ...shared,
            type: "tool-error",
            code: record["timedOut"] === true ? "tests_timed_out" : "tests_failed",
            message: `${String(failed)} failed, ${String(passed)} passed`,
            details: str(record["outputTail"]),
            retryable: false,
          },
        ];
      }
      return [
        {
          ...shared,
          type: "tool-output",
          summary: `${String(passed)} passed${command === "" ? "" : ` — ${command}`}`,
          output: str(record["outputTail"]),
          readPaths: [],
          writtenPaths: [],
          truncated: false,
        },
      ];
    }

    // Both legacy permission shapes become a decided request. They are already resolved — the
    // decision is in the record — so the part is rendered as history, never as a live prompt.
    case "approval":
    case "permission": {
      const isApproval = kind === "approval";
      const prompt = isApproval ? str(record["prompt"]) : str(record["reason"]);
      const name = isApproval
        ? str(record["operation"], "approval")
        : str(record["name"], "permission");
      const effect = str(record["effect"]);
      const decision = isApproval
        ? str(record["decision"]) === "approve"
          ? "approve"
          : str(record["decision"]) === "reject"
            ? "reject"
            : null
        : effect === "allow"
          ? "approve"
          : effect === "deny"
            ? "reject"
            : null;
      return [
        {
          ...partBase,
          type: "permission-request",
          requestId: syntheticId("req", record),
          toolCallId: syntheticId("call", record),
          toolName: name,
          kind: "execute",
          prompt,
          paths: str(record["target"]) === "" ? [] : [str(record["target"])],
          reason: "mode-ask",
          offeredScopes: ["call"],
          // Already expired by construction: a migrated request must never present as pending, and
          // the dock's own filter keys off this.
          expiresAt: str(record["ts"]),
          decision,
        },
      ];
    }

    case "budget": {
      return [
        {
          ...partBase,
          type: "usage",
          inputTokens: num(record["tokensUsed"]),
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          contextLimit: num(record["tokenLimit"]),
          messagesInContext: 0,
          sessionMessageCount: 0,
          messagesOutOfWindow: 0,
          summaryActive: false,
        },
      ];
    }

    case "done": {
      const ok = record["ok"] === true;
      return [
        {
          ...partBase,
          type: "run-lifecycle",
          state: ok ? "completed" : "failed",
          ...(str(record["reason"]) === "" ? {} : { message: str(record["reason"]) }),
        },
      ];
    }

    default:
      return [];
  }
}

// ── Reading a whole conversation ──────────────────────────────────────

/** Why a stored conversation could not be read (R23.4). */
export type LegacyFailureReason = "fetch-failed" | "malformed-json" | "schema-rejected" | "partial";

/** The human sentence each reason shows on the unreadable card. */
export const FAILURE_MESSAGE: Readonly<Record<LegacyFailureReason, string>> = {
  "fetch-failed": "Could not be loaded from the previous version's store.",
  "malformed-json": "The stored record is not readable JSON.",
  "schema-rejected": "The stored events are not in a recognised format.",
  partial: "Some turns could not be read and were skipped.",
};

/** One migrated conversation, presented as a Session (R23.6). */
export interface MigratedSession {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  /** Every mapped part, in the reader's re-numbered order. */
  readonly parts: readonly MessagePart[];
  /** Every user-facing event with no counterpart (R23.2). */
  readonly historical: readonly HistoricalEvent[];
  /**
   * Set when the conversation read *partially* — some turns rendered, some did not. The count is
   * what the card names, because "3 turns could not be read" is actionable and "something failed"
   * is not.
   */
  readonly skipped?: { readonly reason: LegacyFailureReason; readonly count: number };
}

/** A conversation that could not be read at all, isolated from the rest (R23.4). */
export interface UnreadableSession {
  readonly id: string;
  readonly title: string;
  readonly reason: LegacyFailureReason;
  readonly message: string;
}

export interface LegacyReadResult {
  readonly sessions: readonly MigratedSession[];
  readonly unreadable: readonly UnreadableSession[];
}

/**
 * Order the raw records and give each a fresh sequence starting at 1.
 *
 * **Timestamp first, original sequence as the tiebreak.** The legacy store allocated `seq` per Run,
 * so two Runs in one conversation both start at 1 and sorting on it alone interleaves them. The
 * timestamp orders across Runs; the original `seq` orders within one, where timestamps collide
 * because several events were written in the same millisecond. Sorting on either alone produces a
 * transcript that reads out of order, which is the failure R23.2's "in order" names.
 */
export function orderAndRenumber(records: readonly unknown[]): readonly {
  record: unknown;
  seq: number;
  originalSeq: number;
}[] {
  const decorated = records.map((record, index) => {
    const asRecord =
      record !== null && typeof record === "object" ? (record as Record<string, unknown>) : {};
    const parsed = Date.parse(str(asRecord["ts"]));
    return {
      record,
      // An unparseable timestamp sorts to the front rather than throwing the whole list out — it
      // keeps its neighbours' relative order through the index tiebreak below.
      time: Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed,
      originalSeq: num(asRecord["seq"], 0),
      index,
    };
  });

  decorated.sort((a, b) => a.time - b.time || a.originalSeq - b.originalSeq || a.index - b.index);

  return decorated.map((entry, position) => ({
    record: entry.record,
    seq: position + 1,
    originalSeq: entry.originalSeq,
  }));
}

/**
 * Read one conversation into a Session, isolating its own failure (R23.4).
 *
 * Never throws. Every exit is either a `MigratedSession` or an `UnreadableSession`, because the
 * caller is iterating a list and one bad conversation must not end the loop.
 */
export async function readLegacyConversation(
  store: LegacyStore,
  ref: LegacyConversationRef,
): Promise<MigratedSession | UnreadableSession> {
  let raw: readonly unknown[];
  try {
    raw = await store.readEvents(ref.id);
  } catch (cause) {
    // `SyntaxError` is what a `JSON.parse` of a truncated record throws, and it is a different story
    // from a transport failure: one says the record is corrupt, the other says the store is not
    // answering. R23.4 asks for the reason, so the two are not collapsed.
    const reason: LegacyFailureReason =
      cause instanceof SyntaxError ? "malformed-json" : "fetch-failed";
    return { id: ref.id, title: ref.title, reason, message: FAILURE_MESSAGE[reason] };
  }

  if (!Array.isArray(raw)) {
    return {
      id: ref.id,
      title: ref.title,
      reason: "schema-rejected",
      message: FAILURE_MESSAGE["schema-rejected"],
    };
  }

  const ordered = orderAndRenumber(raw);
  const messageId = `migrated_${ref.id}`;
  const parts: MessagePart[] = [];
  const historical: HistoricalEvent[] = [];
  let unreadableRecords = 0;

  for (const entry of ordered) {
    const mapping = mapLegacyEvent(entry.record, { messageId, seq: entry.seq });
    if (mapping.outcome === "mapped") {
      parts.push(...mapping.parts);
      continue;
    }
    if (mapping.outcome === "skipped") continue;

    const asRecord =
      entry.record !== null && typeof entry.record === "object"
        ? (entry.record as Record<string, unknown>)
        : {};
    if (str(asRecord["type"]) === "") unreadableRecords += 1;

    historical.push({
      id: `hist_${ref.id}_${String(entry.seq)}`,
      runId: str(asRecord["runId"]),
      seq: entry.seq,
      kind: str(asRecord["type"], "unknown"),
      label: mapping.label,
      ts: str(asRecord["ts"]),
      raw: entry.record,
      originalSeq: entry.originalSeq,
    });
  }

  // Every record failed to identify itself: this is not a conversation with some odd turns, it is a
  // file that is not a conversation. Reporting it as read would present a wall of "Unreadable
  // record" rows as though they were history.
  if (ordered.length > 0 && unreadableRecords === ordered.length) {
    return {
      id: ref.id,
      title: ref.title,
      reason: "schema-rejected",
      message: FAILURE_MESSAGE["schema-rejected"],
    };
  }

  return {
    id: ref.id,
    title: ref.title,
    updatedAt: ref.updatedAt,
    parts,
    historical,
    ...(unreadableRecords > 0
      ? { skipped: { reason: "partial" as const, count: unreadableRecords } }
      : {}),
  };
}

/** True for the failure branch of {@link readLegacyConversation}. */
export function isUnreadable(
  result: MigratedSession | UnreadableSession,
): result is UnreadableSession {
  return "reason" in result;
}

/**
 * Every pre-upgrade conversation, as Sessions plus the ones that could not be read (R23.1, R23.4).
 *
 * A failure to *list* is total — there is nothing to isolate, because no conversation was named — so
 * it returns two empty lists rather than inventing an unreadable entry for a conversation whose id
 * is not known.
 */
export async function readLegacyConversations(store: LegacyStore): Promise<LegacyReadResult> {
  let refs: readonly LegacyConversationRef[];
  try {
    refs = await store.listConversations();
  } catch {
    return { sessions: [], unreadable: [] };
  }

  const results = await Promise.all(refs.map((ref) => readLegacyConversation(store, ref)));

  return {
    sessions: results.filter((result): result is MigratedSession => !isUnreadable(result)),
    unreadable: results.filter(isUnreadable),
  };
}
