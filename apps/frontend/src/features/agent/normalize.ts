/**
 * normalize.ts — the single Event_Normalizer (R9).
 *
 * Every `Agent_Event` becomes exactly one typed `FeedRow` or an explicit
 * `Discard`. This is the ONLY path by which an `Agent_Event` value reaches the
 * Chat_Renderer (R9.6): renderer modules import `FeedRow` and nothing from the
 * stream/event modules (enforced by an ESLint `no-restricted-imports` rule and
 * a structural test).
 *
 * It works over the camelCase `AgentEvent` union from `useAgentStream.ts` — the
 * one `EmitGate` validates every SSE frame against. Frames in the snake_case
 * `models.py` shape (optional `run_id`) are discarded as `malformed`, never
 * silently admitted, so a cross-run check always has a field to read.
 *
 * `FeedRow` is a frontend view model, deliberately NOT code-generated: rows
 * carry presentation state (`collapsed`, `truncated`, `count`) that has no
 * business on the wire (design D8).
 *
 * The fold is pure in `(events, ctx)` and deterministic in `seq` order. Token
 * events coalesce by a *derived* assistant identity (no token frame carries a
 * message id — see {@link assistantMessageId}); consecutive same-tool calls
 * group into a `tool-group`; and stage events fold into one `stage` row.
 */
import type { AgentEvents } from "@zoc-studio/shared-types";
import { sanitizeErrorForDisplay } from "@/lib/errors";
import { isSyntheticStageCommand } from "./stage-markers";
import {
  type ReportedStage,
  type StageReport,
  type StageEventLike,
  foldStageReports,
  isReportedStage,
  isStageState,
} from "./stage-report";
import type { RunPhase } from "./run-lifecycle";
import type { FollowUpChip } from "./follow-ups";
import { recordDiscard } from "./diagnostics";

export type ToolCallStatus = "running" | "succeeded" | "failed";

export interface DiffFileRow {
  path: string;
  adds: number;
  dels: number;
  diff: string;
  /** Recorded base hash for stale detection (R12.7); null when unknown. */
  baseHash: string | null;
}

export type FeedRowKind =
  | "user-message"
  | "assistant-message"
  | "reasoning"
  | "run-metadata"
  | "stage"
  | "tool-call"
  | "tool-group"
  | "diff"
  | "command"
  | "approval"
  | "plan-ready"
  | "run-summary"
  | "error"
  | "follow-ups";

interface RowBase {
  id: string;
  seq: number;
  runId: string;
}

export type FeedRow =
  | (RowBase & { kind: "user-message"; text: string })
  | (RowBase & {
      kind: "assistant-message";
      /** The derived coalescing key from {@link assistantMessageId}. */
      messageId: string;
      text: string;
      streaming: boolean;
    })
  | (RowBase & { kind: "reasoning"; text: string; collapsed: boolean; truncated: boolean })
  | (RowBase & {
      kind: "run-metadata";
      modelTier: AgentEvents.ModelTier;
      contextWindowTokens: number;
      fallbackReason: string | null;
    })
  | (RowBase & { kind: "stage"; stages: readonly StageReport[] })
  | (RowBase & {
      kind: "tool-call";
      tool: string;
      target: string | null;
      status: ToolCallStatus;
      result: string | null;
      failure: string | null;
      /** Lifecycle-coalescing key (commandId or a seq fallback). */
      key: string;
    })
  | (RowBase & {
      kind: "tool-group";
      tool: string;
      members: readonly Extract<FeedRow, { kind: "tool-call" }>[];
      count: number;
    })
  | (RowBase & {
      kind: "diff";
      files: readonly DiffFileRow[];
      decision: "pending" | "applied" | "rejected" | "stale";
    })
  | (RowBase & {
      kind: "command";
      command: string;
      status: string;
      exitCode: number | null;
      outputTail: string | null;
      mcpServerId: string | null;
    })
  | (RowBase & {
      kind: "approval";
      prompt: string;
      operation: string;
      /** The tool/operation name being gated, so the row is never ambiguous (R5.x). */
      tool: string | null;
      /** The target the operation acts on (path/command), when the event names one. */
      target: string | null;
      decision: "approve" | "reject" | null;
    })
  | (RowBase & {
      kind: "plan-ready";
      steps: readonly AgentEvents.PlanReadyStep[];
      verificationCommand: string | null;
    })
  | (RowBase & {
      kind: "run-summary";
      outcome: RunPhase;
      mode: "ask" | "plan" | "agent";
      elapsedMs: number;
      filesChanged: number;
      reason: string | null;
    })
  | (RowBase & {
      kind: "error";
      code: string;
      operation: string;
      message: string;
      retryable: boolean;
    })
  | (RowBase & { kind: "follow-ups"; chips: readonly FollowUpChip[] });

export type DiscardReason =
  | "internal-frame" // R9.3 — <stage:...> markers and bookkeeping frames
  | "unknown-type" // R9.2
  | "malformed"
  | "cross-run"
  | "duplicate-seq"
  | "empty" // an empty reasoning/token payload
  | "lifecycle"; // consumed by the Run_Lifecycle_Controller, rendered from the record

export interface Discard {
  discarded: true;
  reason: DiscardReason;
  /** The unrecognized `type` value, recorded for diagnostics (R9.2). */
  rawType: string | null;
}

export interface NormalizeContext {
  /** The run the stream is bound to; events from any other run are discarded. */
  activeRunId: string | null;
  /** The user `Message.id` the active run answers (store.ts:408 / run-machine.ts:52). */
  boundMessageId: string | null;
  highestSeq: number;
}

/**
 * R9.5 — the assistant-message identity for a token event. Derived, because no
 * token frame carries a message id. A run answers exactly one bound user
 * message, so `(runId, boundMessageId)` is a stable one-row-per-run key.
 * `boundMessageId === null` (slash commands, retries) falls back to the run id.
 */
export function assistantMessageId(runId: string, boundMessageId: string | null): string {
  return boundMessageId ? `assistant:${runId}:${boundMessageId}` : `assistant:${runId}`;
}

/** The set of event types the normalizer recognizes (mapped or intentionally dropped). */
const KNOWN_TYPES: ReadonlySet<string> = new Set<string>([
  "token",
  "intent",
  "thinking",
  "plan",
  "plan-update",
  "plan-ready",
  "map-files",
  "read-files",
  "context-compressed",
  "edit-file",
  "command",
  "review",
  "summary",
  "approval",
  "permission",
  "recovery-attempt",
  "budget",
  "test-results",
  "stage",
  "done",
  "error",
]);

function discard(reason: DiscardReason, rawType: string | null): Discard {
  return { discarded: true, reason, rawType };
}

export function isDiscard(value: FeedRow | Discard): value is Discard {
  return (value as Discard).discarded === true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function numberOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolCallStatus(status: unknown, exitCode: unknown): ToolCallStatus {
  if (status === "fail" || (typeof exitCode === "number" && exitCode !== 0)) return "failed";
  if (status === "pass" || status === "skipped" || (typeof exitCode === "number" && exitCode === 0))
    return "succeeded";
  return "running";
}

function commandTool(mcpServerId: string | null): string {
  return mcpServerId ? `mcp:${mcpServerId}` : "shell";
}

/**
 * R9.1 — normalize one event into exactly one row or an explicit discard.
 * Total: never throws for any input.
 */
export function normalizeEvent(event: unknown, ctx: NormalizeContext): FeedRow | Discard {
  const record = asRecord(event);
  if (!record) return discard("malformed", null);

  const type = record.type;
  if (typeof type !== "string") return discard("malformed", null);
  const seq = record.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return discard("malformed", type);

  // The camelCase union declares `runId`; snake-cased frames are not admitted.
  const runId = typeof record.runId === "string" ? record.runId : null;

  // Cross-run replays are discarded (only when both ids are present).
  if (runId !== null && ctx.activeRunId !== null && runId !== ctx.activeRunId) {
    return discard("cross-run", type);
  }

  if (!KNOWN_TYPES.has(type)) return discard("unknown-type", type);

  // An error frame may legitimately omit `runId`; everything else requires it.
  if (runId === null && type !== "error") return discard("malformed", type);
  const rid = runId ?? ctx.activeRunId ?? "";

  const base = (kind: FeedRow["kind"]): RowBase & { kind: FeedRow["kind"] } => ({
    kind,
    id: `${kind}:${rid}:${seq}`,
    seq,
    runId: rid,
  });

  switch (type) {
    case "token": {
      const text = typeof record.text === "string" ? record.text : "";
      const messageId = assistantMessageId(rid, ctx.boundMessageId);
      return {
        ...base("assistant-message"),
        kind: "assistant-message",
        id: messageId,
        messageId,
        text,
        streaming: record.done !== true,
      };
    }

    case "summary": {
      // The run's final summary prose is assistant content; keep it on its own
      // derived identity so it does not merge with streamed tokens.
      const text = typeof record.text === "string" ? record.text : "";
      const messageId = `${assistantMessageId(rid, ctx.boundMessageId)}:summary`;
      return {
        ...base("assistant-message"),
        kind: "assistant-message",
        id: messageId,
        messageId,
        text,
        streaming: false,
      };
    }

    case "thinking": {
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (text.length === 0) return discard("empty", type); // R6.5
      return {
        ...base("reasoning"),
        kind: "reasoning",
        text,
        collapsed: true, // R6.4/R10.5 — collapsed by default
        truncated: record.truncated === true,
      };
    }

    case "intent": {
      // R9.4 — intent becomes run-metadata, never an assistant message.
      const tier = record.modelTier;
      const modelTier: AgentEvents.ModelTier =
        tier === "local-slm" || tier === "edge" || tier === "cloud" ? tier : "cloud";
      return {
        ...base("run-metadata"),
        kind: "run-metadata",
        modelTier,
        contextWindowTokens: numberOr(record.contextWindowTokens, 0),
        fallbackReason: stringOrNull(record.fallbackReason),
      };
    }

    case "stage": {
      const stageValue = record.stage;
      const stateValue = record.state;
      if (!isReportedStage(stageValue) || !isStageState(stateValue)) {
        return discard("malformed", type);
      }
      const rawReason = stringOrNull(record.reason);
      const one: StageEventLike = {
        stage: stageValue,
        state: stateValue,
        reason: rawReason
          ? sanitizeErrorForDisplay("run_failed", rawReason).message
          : null,
      };
      return { ...base("stage"), kind: "stage", stages: foldStageReports([one]) };
    }

    case "command": {
      const command = typeof record.command === "string" ? record.command : "";
      // R9.3 — a synthetic <stage:...> marker is an internal frame, not a command.
      if (isSyntheticStageCommand(command)) return discard("internal-frame", type);
      const mcpServerId = stringOrNull(record.mcpServerId);
      const status = toolCallStatus(record.status, record.exitCode);
      const outputTail = stringOrNull(record.outputTail) ?? stringOrNull(record.outputDelta);
      const commandId = stringOrNull(record.commandId);
      return {
        ...base("tool-call"),
        kind: "tool-call",
        id: `tool:${rid}:${commandId ?? seq}`,
        tool: commandTool(mcpServerId),
        target: command.length > 0 ? command : null,
        status,
        result: outputTail,
        failure: status === "failed" ? stringOrNull(record.errorTag) ?? outputTail : null,
        key: commandId ?? `${rid}:${seq}`,
      };
    }

    case "edit-file": {
      const status = record.status;
      // Staleness is decided live by comparing the file's current
      // SHA-256/existence to `baseHash` (R12.7) — never from a failed status.
      const decision: "pending" | "applied" | "rejected" | "stale" =
        status === "done" ? "applied" : "pending";
      const file: DiffFileRow = {
        path: typeof record.path === "string" ? record.path : "",
        adds: numberOr(record.adds, 0),
        dels: numberOr(record.dels, 0),
        diff: typeof record.diff === "string" ? record.diff : "",
        baseHash: stringOrNull(record.base_hash) ?? stringOrNull(record.baseHash),
      };
      return { ...base("diff"), kind: "diff", files: [file], decision };
    }

    case "review": {
      const rawFiles = Array.isArray(record.files) ? record.files : [];
      const files: DiffFileRow[] = rawFiles.map((f) => {
        const fr = asRecord(f) ?? {};
        return {
          path: typeof fr.path === "string" ? fr.path : "",
          adds: numberOr(fr.adds, 0),
          dels: numberOr(fr.dels, 0),
          diff: typeof fr.diff === "string" ? fr.diff : "",
          baseHash: stringOrNull(fr.base_hash) ?? stringOrNull(fr.baseHash),
        };
      });
      return { ...base("diff"), kind: "diff", files, decision: "pending" };
    }

    case "plan-ready": {
      const steps = Array.isArray(record.steps) ? (record.steps as AgentEvents.PlanReadyStep[]) : [];
      return {
        ...base("plan-ready"),
        kind: "plan-ready",
        steps,
        verificationCommand: stringOrNull(record.verificationCommand),
      };
    }

    case "approval": {
      const decisionValue = record.decision;
      const decision: "approve" | "reject" | null =
        decisionValue === "approve" || decisionValue === "reject" ? decisionValue : null;
      // Preserve the tool/target that make the approval unambiguous rather than
      // discarding them (R5.x): the wire event may name the gated tool as
      // `tool`/`name` and its subject as `target`/`path`.
      const tool = stringOrNull(record.tool) ?? stringOrNull(record.name);
      const target = stringOrNull(record.target) ?? stringOrNull(record.path);
      return {
        ...base("approval"),
        kind: "approval",
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        operation:
          stringOrNull(record.operation) ??
          tool ??
          (typeof record.prompt === "string" ? record.prompt : "this operation"),
        tool,
        target,
        decision,
      };
    }

    case "error": {
      const safe = sanitizeErrorForDisplay(
        stringOrNull(record.code) ?? "error",
        typeof record.message === "string" ? record.message : "The run reported an error.",
      );
      return {
        ...base("error"),
        kind: "error",
        code: safe.code,
        operation: stringOrNull(record.operation) ?? "run",
        message: safe.message,
        retryable: record.retryable === true,
      };
    }

    // Terminal frame — consumed by the Run_Lifecycle_Controller; the summary row
    // is rendered from the run record, not from this frame (design §7).
    case "done":
      return discard("lifecycle", type);

    // Known bookkeeping/diagnostic frames with no user-facing row.
    case "plan":
    case "plan-update":
    case "map-files":
    case "read-files":
    case "context-compressed":
    case "permission":
    case "recovery-attempt":
    case "budget":
    case "test-results":
      return discard("internal-frame", type);

    default:
      return discard("unknown-type", type);
  }
}

/**
 * Fold a whole stream into rows plus the discards. Deterministic in `seq`
 * order and pure in `ctx`; normalizing the same list twice with the same
 * context yields identical row identifiers.
 */
export function normalizeEvents(
  events: readonly unknown[],
  ctx: NormalizeContext,
): { rows: FeedRow[]; discards: Discard[] } {
  // Stable sort by seq so the fold is order-independent and deterministic.
  const indexed = events.map((event, index) => ({ event, index }));
  indexed.sort((a, b) => {
    const sa = numberOr(asRecord(a.event)?.seq, Number.POSITIVE_INFINITY);
    const sb = numberOr(asRecord(b.event)?.seq, Number.POSITIVE_INFINITY);
    return sa !== sb ? sa - sb : a.index - b.index;
  });

  const discards: Discard[] = [];
  const raw: FeedRow[] = [];
  let cursor = ctx.highestSeq;

  for (const { event } of indexed) {
    const seq = numberOr(asRecord(event)?.seq, null);
    if (seq !== null && seq <= cursor) {
      discards.push(discard("duplicate-seq", stringOrNull(asRecord(event)?.type)));
      continue;
    }
    const result = normalizeEvent(event, { ...ctx, highestSeq: cursor });
    if (isDiscard(result)) {
      discards.push(result);
      continue;
    }
    if (seq !== null) cursor = seq;
    raw.push(result);
  }

  const rows = groupToolCalls(coalesce(raw));

  for (const d of discards) recordDiscard(d.reason, d.rawType);
  return { rows, discards };
}

/**
 * Coalesce assistant-message rows by `messageId`, tool-call rows by `key`, and
 * stage rows into one folded report. Order is preserved: a coalesced row keeps
 * the position of its first occurrence.
 */
function coalesce(rows: readonly FeedRow[]): FeedRow[] {
  const out: FeedRow[] = [];
  const messageIndex = new Map<string, number>();
  const toolIndex = new Map<string, number>();
  let stageAt = -1;
  const stageEvents: StageEventLike[] = [];

  for (const row of rows) {
    if (row.kind === "assistant-message") {
      const existing = messageIndex.get(row.messageId);
      if (existing === undefined) {
        messageIndex.set(row.messageId, out.length);
        out.push({ ...row });
      } else {
        const prev = out[existing] as Extract<FeedRow, { kind: "assistant-message" }>;
        out[existing] = { ...prev, text: prev.text + row.text, streaming: row.streaming };
      }
      continue;
    }

    if (row.kind === "tool-call") {
      const existing = toolIndex.get(row.key);
      if (existing === undefined) {
        toolIndex.set(row.key, out.length);
        out.push({ ...row });
      } else {
        const prev = out[existing] as Extract<FeedRow, { kind: "tool-call" }>;
        out[existing] = {
          ...prev,
          status: row.status,
          target: row.target ?? prev.target,
          result:
            prev.result && row.result
              ? `${prev.result}${row.result}`
              : row.result ?? prev.result,
          failure: row.failure ?? prev.failure,
        };
      }
      continue;
    }

    if (row.kind === "stage") {
      // Rebuild the six-stage report from every stage event seen so far, keeping
      // one stage row at the position of the first stage event.
      // (Each stage row already carries the single event's projection; we need
      //  the underlying events, so we reconstruct from the folded report.)
      const active = row.stages.filter(
        (s) => s.state !== "pending",
      );
      for (const s of active) {
        stageEvents.push({ stage: s.stage, state: s.state, reason: s.reason });
      }
      if (stageAt === -1) {
        stageAt = out.length;
        out.push({ ...row, stages: foldStageReports(stageEvents) });
      } else {
        const prev = out[stageAt] as Extract<FeedRow, { kind: "stage" }>;
        out[stageAt] = { ...prev, stages: foldStageReports(stageEvents) };
      }
      continue;
    }

    out.push(row);
  }

  return out;
}

/**
 * Group runs of consecutive same-tool `tool-call` rows into `tool-group` rows
 * labelled with the member count (R11.6). A run of length one stays a
 * standalone tool-call. Flattening a group reproduces the original order.
 */
function groupToolCalls(rows: readonly FeedRow[]): FeedRow[] {
  const out: FeedRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind !== "tool-call") {
      out.push(row);
      i += 1;
      continue;
    }
    const members: Extract<FeedRow, { kind: "tool-call" }>[] = [row];
    let j = i + 1;
    while (j < rows.length && rows[j].kind === "tool-call") {
      const next = rows[j] as Extract<FeedRow, { kind: "tool-call" }>;
      if (next.tool !== row.tool) break;
      members.push(next);
      j += 1;
    }
    if (members.length > 1) {
      const first = members[0];
      out.push({
        kind: "tool-group",
        id: `tool-group:${first.runId}:${first.seq}`,
        seq: first.seq,
        runId: first.runId,
        tool: first.tool,
        members,
        count: members.length,
      });
    } else {
      out.push(row);
    }
    i = j;
  }
  return out;
}

/** The reported stage carried by a `stage` row, for the lifecycle/strip. */
export function latestStageFromRows(rows: readonly FeedRow[]): ReportedStage | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "stage") {
      const active = row.stages.find((s) => s.state === "active");
      if (active) return active.stage;
    }
  }
  return null;
}
