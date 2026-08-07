/**
 * The transcript row factory — zoc-agent-chat-rebuild R7.6, R8.1–R8.4, R9.x, R16.6, R34.3, R34.6,
 * task 17.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 17.1 (R7.6, R8.1, R8.4, R16.6, R34.3, R34.6).
 *
 * One `useChat` message reduced to the ordered rows the transcript draws. This is the single
 * `switch` over a part's discriminant that the design puts at the top of the Chat_Surface, and it
 * is a pure function over `ZocUIMessage.parts` rather than a component tree so that three things
 * are assertable without mounting anything: which rows a message produces, in what order, and what
 * happens to a discriminant nothing recognises (Property 3).
 *
 * ## The mapping is design.md's table, not an invention
 *
 * Five of the thirteen Message_Parts arrive as native AI SDK parts and eight as `data-zoc-*` parts.
 * The native ones carry their Zoc additions in a `zoc` namespace inside the part's provider
 * metadata — `kind`, `mcpServer`, `readPaths`, `writtenPaths` on a tool part; `elapsedMs` and
 * `redacted` on a reasoning part — which is what {@link zocMetaOf} reads.
 *
 * **The SDK splits one namespace across two fields.** A chunk's `providerMetadata` lands on
 * `resultProviderMetadata` for `output-available` and `output-error`, and on `callProviderMetadata`
 * for every other state. So both are read and merged with the result winning: a call's metadata is
 * what was known when the model asked, and a result's is what was true when it answered.
 *
 * ## Consecutive tool parts become one timeline, and that word is load-bearing
 *
 * The timeline is a semantic `<ol>` (16.1), so a run of tool calls is one row containing many
 * entries rather than many rows. *Consecutive* is what keeps ordering intact: an answer between two
 * tool calls splits them into two timelines, so the transcript still shows that the model said
 * something in between. Collecting every tool part of a message into a single timeline would move
 * text that arrived mid-run to the end.
 *
 * ## One arm classifies a part whose row is not built yet
 *
 * `sources` is recognised here and renders nothing until 36.4 builds it. That is deliberate rather than
 * an oversight: classifying it keeps it out of the unknown-discriminant path, so a provider's source
 * list never renders as "Unrecognised event" and never produces a log record. The row exists in
 * {@link TranscriptRow} and its renderer is the only thing missing. `plan` and `diff` were in this list
 * until 18.2 filled them, and `permission` until 19.1 did.
 *
 * ## A plan and its diffs are one row
 *
 * `DiffPart.planId` links them, and the review surface is one card whose file list is the way into
 * the diffs — so the factory attaches a plan's diffs to its row rather than emitting a diff row per
 * file for a renderer to correlate afterwards. A diff whose plan is absent from the message still
 * gets its own row, because a proposed change is not something to drop silently.
 *
 * ## The one side effect, and it is idempotent by construction
 *
 * The `default` arm calls `logUnknownPart`, which is a side effect in a function that is otherwise
 * pure. It belongs here rather than in the row: this is the place that *decided* the part was
 * unknown, and a row logging in an effect would log once per mount — and the virtualiser mounts and
 * unmounts rows as they scroll, so "once per Run" would quietly become "once per scroll". The
 * dedupe inside `logUnknownPart` is what makes calling it on every render harmless.
 */

import type { ToolKind } from "@zoc-studio/shared-types";
import type {
  CompactionPart,
  DiffPart,
  ErrorPart,
  PermissionRequestPart,
  PlanPart,
  RunLifecyclePart,
  SourcePart,
  UsagePart,
} from "@zoc-studio/shared-types";

import type { ToolEntryModel, ToolEntryState } from "./timeline/tool-entry-model";
import type { HistoricalItem } from "./historical-rows";
import type { ZocUIMessage } from "./wire/ui-message";
import { logUnknownPart } from "./unknown-parts";
import { attachmentsFromParts, type ComposerAttachment } from "./composer/attachment-model";

/** One row of the transcript. `id` is stable across renders and is the virtualiser's item key. */
interface AttributedRow {
  /** The sub-agent that produced this row; absent means the parent Run (R25.5). */
  readonly agentName?: string;
}

export type TranscriptRow = (
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly attachments?: readonly ComposerAttachment[];
    }
  | {
      readonly kind: "answer";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly citations?: SourcePart["citations"];
      readonly sources?: SourcePart["sources"];
    }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly terminal: boolean;
      readonly elapsedMs: number;
      readonly redacted: boolean;
    }
  | { readonly kind: "tools"; readonly id: string; readonly entries: readonly ToolEntryModel[] }
  | {
      readonly kind: "usage";
      readonly id: string;
      readonly usage: UsagePart;
      readonly model?: string;
    }
  | { readonly kind: "error"; readonly id: string; readonly error: ErrorPart | RunLifecyclePart }
  | { readonly kind: "compaction"; readonly id: string; readonly compaction: CompactionPart }
  | { readonly kind: "historical"; readonly id: string; readonly item: HistoricalItem }
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly plan: PlanPart;
      /**
       * The diffs belonging to this plan, from the same message.
       *
       * A plan and its diffs are one decision-tier card (R10.1, R10.2) — the file list *is* the way
       * into the diffs — so they are one row rather than a plan row followed by n diff rows that a
       * renderer would then have to correlate. The link is `DiffPart.planId`, which exists for exactly
       * this purpose.
       */
      readonly diffs: readonly DiffPart[];
    }
  | { readonly kind: "diff"; readonly id: string; readonly diff: DiffPart }
  | {
      readonly kind: "permission";
      readonly id: string;
      readonly request: PermissionRequestPart;
    }
  | { readonly kind: "sources"; readonly id: string; readonly source: SourcePart }
  | { readonly kind: "unknown"; readonly id: string; readonly discriminant: string }
) &
  AttributedRow;

/** The `TranscriptRow` kinds that have no renderer yet, named so the gap is a checked fact. */
export const ROWS_AWAITING_A_RENDERER: readonly TranscriptRow["kind"][] = [];

/** Run states past which nothing more arrives, which is what R8.4's collapse keys on. */
const TERMINAL_RUN_STATES: ReadonlySet<RunLifecyclePart["state"]> = new Set([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);

type MessagePartOf = ZocUIMessage["parts"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The `zoc` namespace inside a part's provider metadata, from whichever field carries it.
 *
 * Result before call, because a result's metadata is the later fact. Both are read because the SDK
 * routes a chunk's `providerMetadata` to one or the other depending on the state it arrived in, so
 * reading either alone loses half the tool lifecycle.
 */
export function zocMetaOf(part: unknown): Record<string, unknown> {
  if (!isRecord(part)) return {};
  const call = isRecord(part.callProviderMetadata) ? part.callProviderMetadata : {};
  const result = isRecord(part.resultProviderMetadata) ? part.resultProviderMetadata : {};
  const flat = isRecord(part.providerMetadata) ? part.providerMetadata : {};
  return {
    ...(isRecord(flat.zoc) ? flat.zoc : {}),
    ...(isRecord(call.zoc) ? call.zoc : {}),
    ...(isRecord(result.zoc) ? result.zoc : {}),
  };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathsOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value.filter((entry): entry is string => typeof entry === "string");
  return paths.length > 0 ? paths : undefined;
}

function agentNameOf(part: MessagePartOf): string | undefined {
  if (part.type.startsWith("data-zoc-")) {
    const data = (part as { data?: { agentName?: unknown } }).data;
    if (typeof data?.agentName === "string" && data.agentName.length > 0) return data.agentName;
  }
  return stringOf(zocMetaOf(part).agentName);
}

/** The `ToolKind` values, for validating one that arrived over the wire. */
const TOOL_KINDS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "execute",
  "search",
  "network",
  "mcp",
]);

/**
 * A tool's kind when the part carried none.
 *
 * **The authoritative answer is `providerMetadata.zoc.kind`**, which the runtime's registry knows
 * and this function does not. The fallback exists because a node shape is not optional — the
 * timeline encodes what a call did in its shape (R21.7), so a missing kind cannot render as a
 * missing node — and because a transcript restored from before the runtime populated the namespace
 * still has to draw. 22.1's `/v1/tools` catalogue is the durable answer and supersedes the guessing
 * here; a resolver can be injected in the meantime.
 *
 * The fallback is `read`, deliberately: it is the shape that claims the least. Guessing `write` for
 * an unknown tool would draw a filled node asserting a mutation that may never have happened, and a
 * reader scanning for writes would find one that is not there.
 */
export function inferToolKind(toolName: string): ToolKind {
  if (toolName.startsWith("mcp__")) return "mcp";
  if (
    toolName.includes("web_search") ||
    toolName.includes("google_search") ||
    toolName.includes("fetch")
  ) {
    return "network";
  }
  if (toolName.includes("search") || toolName.includes("grep")) return "search";
  if (toolName.includes("apply_hunks") || toolName.includes("restore")) return "write";
  if (toolName.includes("run_command") || toolName.includes("run_tests")) return "execute";
  return "read";
}

/** Every SDK tool-part state, reduced to the four the timeline draws. */
export function toolStateOf(state: string): ToolEntryState {
  switch (state) {
    case "output-available":
      return "succeeded";
    case "output-error":
      return "failed";
    case "output-denied":
      // A permission refusal, which is not a failure: the system worked as configured.
      return "denied";
    default:
      // `input-streaming`, `input-available`, `approval-requested`, `approval-responded` — the call
      // has not settled, and a call awaiting approval is still in flight from the timeline's side.
      return "running";
  }
}

/** Serialise a tool's input or output for the expanded detail (R9.3), leaving a string alone. */
function detailOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  try {
    return JSON.stringify(value, null, 2) ?? undefined;
  } catch {
    return String(value);
  }
}

/** One native tool part reduced to the timeline's model (R9.2, R9.3, R9.4, R9.6). */
export function toolEntryOf(
  part: MessagePartOf,
  options: RowFactoryOptions = {},
): ToolEntryModel | null {
  // A tool part is eight state-shaped variants of one type and the union's other members have none
  // of these fields, so the fields are read through an untyped view rather than narrowed. The
  // alternative — a type guard per state — would restate the SDK's own union to learn nothing.
  const raw = part as unknown as Record<string, unknown>;
  const toolCallId = stringOf(raw.toolCallId);
  if (toolCallId === undefined) return null;

  const toolName =
    part.type === "dynamic-tool"
      ? (stringOf(raw.toolName) ?? "tool")
      : String(part.type).slice("tool-".length);

  const meta = zocMetaOf(part);
  const declaredKind = stringOf(meta.kind);
  const kind: ToolKind =
    declaredKind !== undefined && TOOL_KINDS.has(declaredKind)
      ? (declaredKind as ToolKind)
      : (options.toolKindOf?.(toolName) ?? inferToolKind(toolName));

  const state = toolStateOf(String(raw.state));
  const errorText = stringOf(raw.errorText);
  const code = stringOf(meta.code);
  const input = detailOf(raw.input);
  const output = detailOf(raw.output);
  const summary = stringOf(meta.summary);
  const metric = stringOf(meta.metric);
  const agentName = stringOf(meta.agentName);
  const readPaths = pathsOf(meta.readPaths);
  const writtenPaths = pathsOf(meta.writtenPaths);

  return {
    toolCallId,
    toolName,
    kind,
    state,
    // R9.2 wants the duration always present, and the runtime is the only thing that can measure
    // it. Zero until it does, which reads as `0ms` rather than as a blank column.
    durationMs: numberOf(meta.durationMs) ?? 0,
    ...(summary === undefined ? {} : { summary }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(readPaths === undefined ? {} : { readPaths }),
    ...(writtenPaths === undefined ? {} : { writtenPaths }),
    ...(metric === undefined ? {} : { metric }),
    ...(agentName === undefined ? {} : { agentName }),
    ...(state === "failed" || state === "denied"
      ? {
          error: {
            code: code ?? "internal",
            message: errorText ?? stringOf(meta.message) ?? "The tool call failed.",
            retryable: meta.retryable === true,
          },
        }
      : {}),
  };
}

export interface RowFactoryOptions {
  /**
   * A tool name's kind, when the part arrived without one. Injected so 22.1's `/v1/tools`
   * catalogue can replace {@link inferToolKind} without this module learning about HTTP.
   */
  readonly toolKindOf?: (toolName: string) => ToolKind | undefined;
}

/** Whether a part is one of the SDK's tool parts, static or dynamic. */
export function isToolPart(part: MessagePartOf): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

/**
 * One message's rows, in transcript order.
 *
 * The `switch` R7.6 names. Every arm is explicit — including the four whose renderer is not built
 * and the four native part kinds M1 draws nothing for — so the `default` branch means "nothing
 * anywhere in this codebase knows this discriminant", which is the only reading that makes the
 * placeholder row and the log record honest.
 */
export function rowsOfMessage(
  message: ZocUIMessage,
  options: RowFactoryOptions = {},
): readonly TranscriptRow[] {
  const runId = message.metadata?.runId ?? message.id;
  const rows: TranscriptRow[] = [];
  let pendingTools: ToolEntryModel[] = [];
  let toolsStartedAt = 0;
  let deferred: TranscriptRow[] = [];

  // Two facts about the whole message that individual rows need. Derived here rather than taken
  // from the caller: both are properties of the parts, and a caller passing a stale `terminal`
  // would collapse a reasoning region mid-Run.
  const lifecycles = message.parts.filter(
    (part): part is Extract<MessagePartOf, { type: "data-zoc-run" }> =>
      part.type === "data-zoc-run",
  );
  const lastLifecycle = lifecycles.at(-1)?.data;
  const terminal = lastLifecycle !== undefined && TERMINAL_RUN_STATES.has(lastLifecycle.state);
  const model = message.metadata?.model ?? lastLifecycle?.model ?? undefined;
  // A dedicated error part outranks a failed lifecycle as the thing that explains a failure, so the
  // lifecycle only produces a row when nothing else will. Without this rule a failed Run renders its
  // reason twice; without the lifecycle fallback, the transport's interrupted terminal — which is a
  // `data-zoc-run` part and never an error part (11.1) — renders not at all.
  const hasErrorPart = message.parts.some((part) => part.type === "data-zoc-error");
  const sourcePart = message.parts
    .filter(
      (part): part is Extract<MessagePartOf, { type: "data-zoc-source" }> =>
        part.type === "data-zoc-source",
    )
    .at(-1)?.data;
  const assistantTextPartCount =
    message.role === "assistant" ? message.parts.filter((part) => part.type === "text").length : 0;
  const userAttachments =
    message.role === "user" ? attachmentsFromParts(message.parts as readonly unknown[]) : [];
  let userAttachmentsClaimed = false;

  // A pre-pass, because a plan's card renders its own diffs (18.2) and the parts arrive in whatever
  // order the runtime emitted them. Collecting first means the plan row is complete when it is built
  // rather than patched afterwards, and a diff whose plan is in this message never produces a second
  // row for the same decision.
  const diffsByPlan = new Map<string, DiffPart[]>();
  const plannedIds = new Set<string>();
  for (const part of message.parts) {
    if (part.type === "data-zoc-plan") plannedIds.add(part.data.planId);
    else if (part.type === "data-zoc-diff") {
      const existing = diffsByPlan.get(part.data.planId);
      if (existing === undefined) diffsByPlan.set(part.data.planId, [part.data]);
      else existing.push(part.data);
    }
  }

  const flushTools = () => {
    if (pendingTools.length > 0) {
      rows.push({
        kind: "tools",
        id: `${message.id}:tools:${String(toolsStartedAt)}`,
        entries: pendingTools,
      });
      pendingTools = [];
    }
    // Deferred placeholders land immediately after the timeline they interrupted. See `pushInert`.
    if (deferred.length > 0) {
      rows.push(...deferred);
      deferred = [];
    }
  };

  /** A row of its own, which ends the current timeline: order is what the flush preserves. */
  const push = (row: TranscriptRow) => {
    flushTools();
    rows.push(row);
  };

  /**
   * A row that must not perturb anything around it — the unknown-discriminant placeholder.
   *
   * Property 3 requires that a part nobody recognises leaves every recognized row exactly as it
   * would have been, and the naive implementation breaks that: an unknown part arriving between two
   * calls to the same tool would flush the timeline and split one row into two. So the placeholder is
   * held and emitted when the timeline next flushes, which keeps it as close to its arrival position
   * as inertness allows.
   */
  const pushInert = (row: TranscriptRow) => {
    if (pendingTools.length === 0) {
      rows.push(row);
      return;
    }
    deferred.push(row);
  };

  message.parts.forEach((part, index) => {
    // Row ids are index-based, and that is safe because `useChat` only ever appends parts and
    // reconciles a data part in place by its id — a part's index does not move once assigned.
    const id = `${message.id}:${String(index)}`;
    const agentName = agentNameOf(part);
    const attributed = <T extends TranscriptRow>(row: T): T =>
      (agentName === undefined ? row : { ...row, agentName }) as T;

    // Parts that draw nothing must also *break* nothing. The SDK emits `step-start` before every
    // step, so flushing on one would give a Run with a tool call per step one timeline per call and
    // destroy the grouping the timeline exists for. Same for the three other invisible kinds.
    if (
      part.type === "step-start" ||
      part.type === "file" ||
      part.type === "source-url" ||
      part.type === "source-document"
    ) {
      // `file` is M2's attachments (§33); the native source chunks are drawn by the reconciled
      // `data-zoc-source` row (36.4). All four are *recognised*, which is what distinguishes them
      // from the `default` arm: no placeholder, no log record.
      return;
    }

    if (isToolPart(part)) {
      const entry = toolEntryOf(part, options);
      if (entry !== null) {
        if (pendingTools.length === 0) toolsStartedAt = index;
        pendingTools.push(entry);
      }
      return;
    }

    switch (part.type) {
      case "text": {
        const partId = stringOf(zocMetaOf(part).partId);
        const citations =
          sourcePart === undefined
            ? []
            : partId === undefined
              ? assistantTextPartCount === 1
                ? sourcePart.citations
                : []
              : sourcePart.citations.filter((citation) => citation.partId === partId);
        push(
          message.role === "user"
            ? {
                kind: "user",
                id,
                text: part.text,
                ...(userAttachmentsClaimed || userAttachments.length === 0
                  ? {}
                  : { attachments: userAttachments }),
              }
            : attributed({
                kind: "answer",
                id,
                text: part.text,
                streaming: part.state === "streaming",
                ...(citations.length === 0 || sourcePart === undefined
                  ? {}
                  : { citations, sources: sourcePart.sources }),
              }),
        );
        if (message.role === "user") userAttachmentsClaimed = true;
        return;
      }

      case "reasoning": {
        const meta = zocMetaOf(part);
        push(
          attributed({
            kind: "reasoning",
            id,
            text: part.text,
            streaming: part.state === "streaming",
            terminal,
            // R8.3's duration and R8.4's redaction flag ride as part-level provider metadata, per the
            // design's mapping table. The runtime does not populate them yet; when it does, this is
            // the only line that has to change.
            elapsedMs: numberOf(meta.elapsedMs) ?? 0,
            redacted: meta.redacted === true,
          }),
        );
        return;
      }

      case "data-zoc-plan":
        push(
          attributed({
            kind: "plan",
            id,
            plan: part.data,
            diffs: diffsByPlan.get(part.data.planId) ?? [],
          }),
        );
        return;
      case "data-zoc-diff":
        // Already inside its plan's card. A diff whose plan is *not* in this message still gets a row
        // of its own: a transcript restored from a persisted Session whose plan part was dropped is
        // rare and recoverable, and silently rendering nothing would lose a proposed change.
        if (plannedIds.has(part.data.planId)) return;
        push(attributed({ kind: "diff", id, diff: part.data }));
        return;
      case "data-zoc-permission":
        push(attributed({ kind: "permission", id, request: part.data }));
        return;
      case "data-zoc-usage":
        push(
          attributed({
            kind: "usage",
            id,
            usage: part.data,
            ...(model === undefined ? {} : { model }),
          }),
        );
        return;
      case "data-zoc-error":
        push(attributed({ kind: "error", id, error: part.data }));
        return;
      case "data-zoc-compaction":
        push(attributed({ kind: "compaction", id, compaction: part.data }));
        return;
      case "data-zoc-source":
        push(attributed({ kind: "sources", id, source: part.data }));
        return;

      case "data-zoc-run":
        // Live lifecycle is the header's status pill, not a transcript row — a row per transition
        // would be the transition log the reconciled-by-id part exists to avoid. The exception is a
        // terminal failure nothing else explains.
        if (
          !hasErrorPart &&
          (part.data.state === "failed" || part.data.state === "interrupted") &&
          typeof part.data.code === "string" &&
          part.data.code.length > 0
        ) {
          push(attributed({ kind: "error", id, error: part.data }));
        }
        return;

      default: {
        // R7.6: a neutral placeholder, one log record per Run per discriminant, and a stream that
        // keeps going. `part` is `never` to TypeScript here, which is the point — reaching this arm
        // means the runtime is newer than the renderer.
        const discriminant = (part as { type: string }).type;
        logUnknownPart(runId, discriminant);
        pushInert({ kind: "unknown", id, discriminant });
        return;
      }
    }
  });

  flushTools();
  return rows;
}
