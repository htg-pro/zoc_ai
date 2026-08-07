/**
 * One `ToolLoopAgent` per Run, and the single stream every part travels on —
 * zoc-agent-chat-rebuild R5.1, R8.1, R8.2, R9.1, R15.6, R30.4, design.md:2322.
 *
 * Feature: zoc-agent-chat-rebuild, R5.1, R8.1, R8.2, R9.1, R15.6, R30.4.
 *
 * ## The agent is built inside `execute`, not before it
 *
 * Everything Run-scoped derives from the writer: the permission gate writes
 * refusals and approval requests, `propose_plan` writes the plan part, and the
 * `experimental_context` a tool reads carries both. The writer in turn needs the
 * SDK's `UIMessageStreamWriter`, which does not exist until `createUIMessageStream`
 * calls `execute`. So the order is fixed: open the stream, wrap the writer, bind
 * the Run's tools to it ({@link RunContext.bind}), *then* construct the agent.
 * Building the agent earlier would mean either a writer that outlives its stream
 * or a mutable `ctx.writer` slot every tool has to re-read on each call.
 *
 * ## The tool-input part is the SDK's, not ours (R9.1)
 *
 * Task 9.6 asks for `onToolCallStart` to emit the tool-input part before the tool
 * runs. `ToolLoopAgentSettings` in ai@6.0.235 has no such setting — the callback
 * exists on `generateText`/`streamText` and on `experimental_telemetry.integrations`
 * — and wiring it would be the wrong seam anyway, for three reasons that all point
 * the same way:
 *
 *   - `toUIMessageStream()` already emits `tool-input-start`, `tool-input-delta`,
 *     and `tool-input-available` as the model *generates* the call. That is
 *     strictly earlier than any execute-time hook, so the 200 ms timeline budget
 *     is met by the chunks that are already on the stream.
 *   - `executeToolCall` returns before `onToolCallStart` when a tool has no
 *     `execute`, so `declare_complete` would never produce one.
 *   - the telemetry composite swallows listener exceptions, which is acceptable
 *     for tracing and not for emitting a Message_Part.
 *
 * A second runtime-side tool-input part would also double-render: the client
 * reconciles tool parts by `toolCallId`. `RunWriter` therefore has no `toolInput`
 * method, and the ordering R9.1 wants is asserted on the merged stream instead.
 * Should a consumer ever need execute-time timing, `experimental_telemetry`
 * keyed off `experimental_context.runId` is the route — for observation, not
 * emission.
 *
 * ## The merge is a hand-rolled pump
 *
 * design.md:2331 sketches `writer.merge(result.toUIMessageStream(...))`. `merge`
 * pumps concurrently and settles independently of the result's own promises, so a
 * terminal lifecycle written after `await result.finishReason` can land *before*
 * the model's last text chunk. Reading the UI stream in a loop costs four lines
 * and buys two things `merge` cannot: the terminal `run-lifecycle` is provably the
 * last part of the Run (R7.7's ordering is only as good as the writes), and the
 * loop is the one place that sees every text delta, which is where Token_Rate
 * observes them (9.9).
 *
 * It buys a third thing the sketch cannot: the failure path. A provider that dies
 * mid-stream does not reject `agent.stream()` — `toUIMessageStream` turns the error
 * into a native `error` chunk. The pump drops that chunk and the Run reports the
 * failure once, as a `zoc-error` part with a taxonomy code (R14); `merge` would
 * forward the SDK's bare `errorText` alongside it.
 *
 * ## The stream hands out copies, not the writer's objects
 *
 * Because `onFinish` is supplied (R15.6 persists the assembled message), the SDK
 * assembles that message out of the chunk objects it is forwarding, and reseats an
 * earlier chunk's `data` when a later one repeats its reconciliation id. The two
 * `run-lifecycle` chunks repeat one by design. {@link privatiseChunks} is the last
 * stage on the way out for that reason.
 */

import {
  ToolLoopAgent,
  asSchema,
  createUIMessageStream,
  hasToolCall,
  jsonSchema,
  stepCountIs,
  type InferUIMessageChunk,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type Tool,
  type ToolCallOptions,
  type ToolSet,
  type UIMessage,
} from "ai";
import type {
  CompactionPart,
  ConversationMode,
  DiffPart,
  ErrorPart,
  PermissionRequestPart,
  PlanPart,
  RunLifecyclePart,
  SourcePart,
  UsagePart,
} from "@zoc-studio/shared-types";

import { COMPLETION_TOOL, toToolMap, type ToolDescriptor } from "../tools/registry.ts";
import { isFallbackFailureCode } from "../providers/registry.ts";
import { ErrorCode, boundDetails } from "../http/errors.ts";
import { classifyRunError, isAbortFailure } from "./error-taxonomy.ts";
import {
  createNullTokenRateMeter,
  createTokenRateMeter,
  estimateTokens,
  type TokenRateMeter,
} from "./token-rate.ts";
import {
  censusOf,
  compactIfNeeded,
  type AssembledRequest,
  type CompactionContext,
} from "./compaction.ts";
import type { PermissionMode } from "../permissions/gate.ts";
import type { AssembledInstructions } from "./system-instructions.ts";
import { createRunWriter, type RunWriter } from "./writer.ts";
import { SourceAccumulator } from "./source-adapters.ts";
import { webSearchToolFor, withoutWebSearch } from "../tools/web-search.ts";

/** R8.2's step ceiling. A Run that has not finished in forty steps is looping. */
export const MAX_STEPS = 40;

/** Heading the folded summary appears under in the instructions. */
export const PIN_HEADING = "## Summary of earlier conversation";

// ── Token_Rate seam (R13.8, task 9.9) ─────────────────────────────────

/**
 * The rate meter, re-exported from where it is implemented.
 *
 * Declared here through 9.6 so that wiring the real meter replaced an *instance* rather
 * than a seam; 9.9 supplied the instance, and the definition moved to `token-rate.ts`
 * with it so there is one shape rather than a mirror to keep in agreement. `current()`
 * is nullable on purpose: zero tokens per second is a measurement, and no interval yet
 * is the absence of one (R13.8).
 */
export type { TokenRateMeter };
export { createNullTokenRateMeter, createTokenRateMeter };

// ── The UI message shape, mirrored rather than imported ────────────────

/**
 * The seven data parts M1 produces, keyed as the client reads them.
 *
 * A structural mirror of `apps/frontend/src/features/chat/wire/ui-message.ts`. An
 * app never imports another app's source tree, so the two agree by shape and are
 * held in agreement by the schema check rather than by a module boundary.
 * `zoc-source` is absent here because M1 has no producer for it (36.3).
 * A `type` rather than an `interface`, because `UIDataTypes` is
 * `Record<string, unknown>` and only an object type carries the implicit index
 * signature that satisfies it.
 */
type ZocDataParts = {
  "zoc-plan": PlanPart;
  "zoc-diff": DiffPart;
  "zoc-permission": PermissionRequestPart;
  "zoc-run": RunLifecyclePart;
  "zoc-usage": UsagePart;
  "zoc-error": ErrorPart;
  "zoc-source": SourcePart;
  "zoc-compaction": CompactionPart;
};

/**
 * Message-level metadata, written once at `start` and again at `finish`.
 *
 * `rulesSources` is R30.4's: the rule files that actually made it into the
 * instructions, which is what lets the surface show *which* rules applied to this
 * message rather than which rules exist.
 */
export interface RunMessageMetadata {
  runId: string;
  provider: string;
  model: string;
  conversationMode: ConversationMode;
  startedAt: string;
  finishedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCents: number | null;
  tokensPerSecond: number | null;
  messagesInContext: number;
  sessionMessageCount: number;
  messagesOutOfWindow: number;
  summaryActive: boolean;
  rulesSources: string[];
}

export type ZocUIMessage = UIMessage<RunMessageMetadata, ZocDataParts>;
export type ZocUIChunk = InferUIMessageChunk<ZocUIMessage>;

// ── Ports ─────────────────────────────────────────────────────────────

/**
 * R15.6's persistence. The completed Run's messages go to Workspace_Services.
 *
 * A port rather than a client because this module has no business knowing that
 * history lives behind the `messages` capability (R6.3), and because a Run has to
 * be streamable in a test without one.
 */
export interface RunPersistence {
  persist(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly messages: readonly ZocUIMessage[];
    readonly aborted: boolean;
  }): Promise<void>;
}

/** The Run's tools and gate, bound to the writer the stream just created. */
export interface RunBinding {
  /**
   * From `buildToolDescriptors` (7.4), with `tools/plan.ts`'s plan tool supplied
   * and every effectful `execute` already wrapped by the gate (8.3).
   */
  readonly descriptors: readonly ToolDescriptor[];
  /**
   * Extra entries for `experimental_context`: the gate, the workspace client, and
   * the plan-path set R11.5's check reads. Opaque here — a tool that needs one
   * reads it by name, and this module neither builds nor inspects them.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Registration-time provider tools, absent from older unit seams. */
  readonly providerTools?: {
    readonly descriptorsFor: (
      providerTools: readonly ToolDescriptor[],
    ) => readonly ToolDescriptor[];
    readonly authorizeWebSearch: () => Promise<boolean>;
  };
}

export type BindRun = (writer: RunWriter) => RunBinding;

/** Classify a provider or tool-loop failure. The taxonomy is `error-taxonomy.ts`. */
export type ClassifyRunError = (error: unknown) => {
  readonly code: string;
  readonly message: string;
  readonly details?: string | null;
  readonly retryable: boolean;
};

// ── Agent construction ────────────────────────────────────────────────

export interface BuildAgentInput {
  readonly model: LanguageModel;
  /** Already assembled, and already carrying the pin summary if there is one. */
  readonly instructions: string;
  readonly descriptors: readonly ToolDescriptor[];
  /** Whatever the Run bound, passed through untouched to every `execute`. */
  readonly experimentalContext: unknown;
  readonly onStepFinish?: (event: { readonly usage: LanguageModelUsage }) => void;
  readonly maxSteps?: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /**
   * Filled with the `toolCallId` of every call whose input the declared schema rejected,
   * so the stream boundary can code the resulting tool error precisely.
   *
   * A set rather than a marker inside the error's own message: the classification has to
   * survive the SDK reducing a thrown error to an `errorText`, and matching on text we
   * happen to have written is a wire between two lines of our own code pretending to be a
   * protocol.
   */
  readonly rejectedInputs?: Set<string>;
}

/**
 * One agent for one Run.
 *
 * Two stop conditions, and they are not redundant. `hasToolCall(COMPLETION_TOOL)`
 * is the model saying it is finished — the ordinary exit, and the only one that
 * carries a summary. `stepCountIs(MAX_STEPS)` is the loop that never says so.
 *
 * `toolChoice: "auto"` because every alternative removes a decision the model has
 * to make: `required` would force a tool call on a turn whose right answer is a
 * sentence, and `none` would make the registry ornamental.
 *
 * `allowSystemInMessages` is left at its default of `false`, which is why the
 * folded summary has to reach the model through `instructions` — see
 * {@link instructionsFor}.
 */
export function buildAgent(input: BuildAgentInput): ToolLoopAgent<never, ToolSet, never> {
  const tools = tolerantTools(toToolMap(input.descriptors), input.rejectedInputs);
  if (tools[COMPLETION_TOOL] === undefined) {
    // The registry guard catches this at construction; repeated here because a
    // missing terminal tool degrades silently into "every Run runs forty steps".
    throw new Error(
      `${COMPLETION_TOOL} is absent from the tool map, so stopWhen can only ever ` +
        "fire on the step ceiling.",
    );
  }

  return new ToolLoopAgent({
    model: input.model,
    instructions: input.instructions,
    tools,
    toolChoice: "auto",
    stopWhen: [stepCountIs(input.maxSteps ?? MAX_STEPS), hasToolCall(COMPLETION_TOOL)],
    experimental_context: input.experimentalContext,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.onStepFinish === undefined
      ? {}
      : { onStepFinish: (event) => input.onStepFinish?.({ usage: event.usage }) }),
  });
}

/**
 * Move each tool's input validation from the SDK's boundary into its own `execute`.
 *
 * **Why this exists: R22.3 requires a schema-invalid tool call to produce
 * `tool_schema_invalid` *without ending the Run*, and ai@6.0.235 ends it.**
 * `doParseToolCall` validates against `inputSchema` and throws `InvalidToolInputError` on
 * a mismatch; the loop rethrows unless `repairToolCall` returns a corrected call, and
 * "tell the model it was wrong and let it try again" is not something a repair function
 * can express. So the throw becomes the stream's failure and one mistyped argument kills a
 * Run the model would have fixed on its next step.
 *
 * The fix keeps the provider's view identical and changes only *where* the check runs. The
 * declared schema's JSON Schema is still what the model is shown — that is the whole
 * contract, and degrading it would trade a rare failure for a permanently worse prompt —
 * but the SDK's validator is replaced with one that always accepts, and the declared
 * validator runs inside `execute` instead. A mismatch is then a thrown error *from a tool*,
 * which the loop already reports as a `tool-output-error` and carries on from.
 *
 * **What this does not cover, deliberately.** `safeParseJSON` does the JSON parse and the
 * validation in one call, so genuinely unparseable input still throws before any validator
 * runs. That case keeps ending the Run, coded `tool_schema_invalid` by the taxonomy — and
 * it is a different failure: a model emitting invalid JSON has not mistyped an argument, it
 * has stopped producing tool calls.
 */
function tolerantTools(tools: ToolSet, rejected: Set<string> | undefined): ToolSet {
  if (rejected === undefined) return tools;

  const out: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const original = definition as Tool & {
      inputSchema?: Parameters<typeof asSchema>[0];
      execute?: (input: never, options: ToolCallOptions) => unknown;
    };
    // A tool with no `execute` is the terminal signal (R11.3): there is no body to move the
    // check into, and its input is never acted on.
    if (original.inputSchema === undefined || typeof original.execute !== "function") {
      out[name] = definition;
      continue;
    }

    const declared = asSchema(original.inputSchema);
    const execute = original.execute.bind(original) as (
      input: never,
      options: ToolCallOptions,
    ) => unknown;

    out[name] = {
      ...original,
      inputSchema: jsonSchema(declared.jsonSchema, {
        validate: (value: unknown) => ({ success: true as const, value }),
      }),
      execute: async (input: unknown, options: ToolCallOptions) => {
        const checked =
          declared.validate === undefined
            ? { success: true as const, value: input }
            : await declared.validate(input);

        if (!checked.success) {
          rejected.add(options.toolCallId);
          // The sentence is what the *model* reads back as the tool's failure, so it names
          // the tool and says the call did not run — enough to retry from, and free of any
          // path or identifier a user might see (R9.8).
          throw new Error(
            `The arguments for ${name} did not match its schema, so the call was not run.`,
          );
        }
        return execute(checked.value as never, options);
      },
    } as Tool;
  }
  return out;
}

// ── Request shaping ───────────────────────────────────────────────────

/**
 * The instructions the model sees, with the folded summary appended.
 *
 * The summary cannot travel as a message. `viewOf` renders a pin as a
 * `role: "system"` entry — right for measuring and for a transcript view — and
 * `allowSystemInMessages` is `false`, so a system message in `messages` is a
 * thrown error rather than a summary the model reads. Appending it to the
 * instructions puts it exactly where a summary of earlier turns belongs: ahead of
 * every retained turn, and inside the cacheable prefix.
 */
export function instructionsFor(
  instructions: AssembledInstructions,
  request: AssembledRequest,
): string {
  if (request.pin === null) return instructions.instructions;
  return `${instructions.instructions}\n\n${PIN_HEADING}\n${request.pin.summary}`;
}

/**
 * The default `HistoryMessage` → `ModelMessage` conversion.
 *
 * Overridable through {@link RunContext.toModelMessages} because
 * `AssembledRequest` carries the shape compaction *measures* — an id, a role, and
 * the text it costs — and a real turn also carries tool calls and their results.
 * The richer conversion belongs to whatever assembled the request; this default is
 * what a text-only Run needs and what the tests use.
 *
 * System entries are dropped rather than passed through: the only one that can
 * appear is a pin, and it has already gone into the instructions.
 */
export function toModelMessages(request: AssembledRequest): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const newestUserIndex = request.messages.findLastIndex((message) => message.role === "user");
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") continue;
    if (
      message.role !== "user" ||
      index !== newestUserIndex ||
      (request.attachments?.length ?? 0) === 0
    ) {
      messages.push({ role: message.role, content: message.text });
      continue;
    }

    const documents = (request.attachments ?? []).filter(
      (attachment) => attachment.kind === "document" && attachment.text !== undefined,
    );
    const text = [
      message.text,
      ...documents.map(
        (attachment) => `\n\n[Attached document: ${attachment.name}]\n${attachment.text ?? ""}`,
      ),
    ].join("");
    const content: Extract<ModelMessage, { role: "user" }>["content"] = [
      { type: "text", text },
      ...(request.attachments ?? []).flatMap((attachment) => {
        if (attachment.kind !== "image" || attachment.dataUrl === undefined) return [];
        const comma = attachment.dataUrl.indexOf(",");
        const image = comma < 0 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1);
        return [{ type: "image" as const, image, mediaType: attachment.mediaType }];
      }),
    ];
    messages.push({ role: "user", content });
  }
  return messages;
}

/**
 * Whether a failure is our own cancellation.
 *
 * Delegated to the taxonomy rather than kept here as a local `name` check: `fetch`
 * wraps an aborted request, so the abort arrives under a `cause` two links down, and
 * a check that only looked at the top-level `name` reported a cancelled Run as
 * `internal`.
 */
function isAbort(error: unknown): boolean {
  return isAbortFailure(error);
}

/** The best available text for an error, for `details` and for a tool's own `errorText`. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const text = String(error);
  return text.length > 0 ? text : "unknown error";
}

/** Running totals across steps, so the one usage row climbs rather than flickers. */
interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

function addUsage(totals: UsageTotals, usage: LanguageModelUsage): void {
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.reasoningTokens += usage.outputTokenDetails.reasoningTokens ?? 0;
  totals.cachedInputTokens += usage.inputTokenDetails.cacheReadTokens ?? 0;
}

// ── The Run ───────────────────────────────────────────────────────────

export interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  /** The assistant message these parts belong to. Also the UI message's id. */
  readonly messageId: string;
  readonly provider: string;
  readonly model: string;
  readonly languageModel: LanguageModel;
  /** Later candidates in the configured routing chain (R27.5/R27.6). */
  readonly fallbackModels?: readonly RunModelCandidate[];
  readonly conversationMode: ConversationMode;
  readonly permissionMode: PermissionMode;
  /** 9.4's output. Its `appliedSources` become the message's `rulesSources`. */
  readonly instructions: AssembledInstructions;
  /** 9.4's assembled request, carrying the model's `contextLimit`. */
  readonly request: AssembledRequest;
  /** Binds the Run's tools and gate to the writer this module creates. */
  readonly bind: BindRun;
  /**
   * The automatic fold (R34.1), minus its writer.
   *
   * Omitting the writer is the point: `streamRun` supplies this Run's own, so the
   * `CompactionPart` is numbered in this Run's `seq` space and lands in the
   * transcript at the position where the fold actually happened. Absent, the Run
   * dispatches whatever was assembled.
   */
  readonly compaction?: Omit<CompactionContext, "writer">;
  readonly rate?: TokenRateMeter;
  readonly persistence?: RunPersistence;
  readonly classifyError?: ClassifyRunError;
  readonly toModelMessages?: (request: AssembledRequest) => ModelMessage[];
  readonly estimateCostCents?: (totals: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
  }) => number | null;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly maxSteps?: number;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface RunModelCandidate {
  readonly provider: string;
  readonly model: string;
  readonly languageModel: LanguageModel;
  readonly contextLimit: number;
  readonly classifyError?: ClassifyRunError;
  readonly estimateCostCents?: RunContext["estimateCostCents"];
}

/**
 * Everything one Run emits, on one stream, in one `seq` space (R7.7, R32.9).
 *
 * The order inside `execute` is the contract:
 *
 *   1. `start`, carrying the metadata — including R30.4's `rulesSources`, which
 *      the surface needs before any text arrives to say which rules applied.
 *   2. `running` lifecycle, so a Run that then fails still has a row to fail on.
 *   3. The automatic fold, if one is due. Before the dispatch it protects and
 *      after the writer exists, which is the only window in which its part can be
 *      both recorded and counted (R34.1).
 *   4. The model's own chunks, pumped through in order.
 *   5. `finish`, with the metadata brought up to date.
 *   6. A terminal lifecycle — `completed`, `cancelled`, or `failed` — which
 *      `SeqFraming` treats as the Run's last word and closes the stream on.
 *
 * Five before six, which is the reverse of the obvious order: see the comment at
 * the write itself.
 */
export function streamRun(ctx: RunContext): ReadableStream<ZocUIChunk> {
  const now = ctx.now ?? (() => new Date());
  const rate = ctx.rate ?? createNullTokenRateMeter();
  // Bound to nothing when the caller supplies none: `createRunErrorClassifier` is
  // how a Run passes its provider label in, and R13.7's "card naming the provider"
  // needs that label. Unbound, the sentences say "The model provider".
  const classify = ctx.classifyError ?? classifyRunError;
  const convert = ctx.toModelMessages ?? toModelMessages;
  const startedAt = now().toISOString();
  // Filled by the tool wrapper, read by the stream boundary two blocks down. One per Run,
  // because a `toolCallId` is only unique within one.
  const rejectedInputs = new Set<string>();
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };

  const assembled = createUIMessageStream<ZocUIMessage>({
    // The response message id and the `messageId` on every data part are the same
    // string: two ids for one message is a client that renders two.
    generateId: () => ctx.messageId,
    onError: (error) => classify(error).message,
    onFinish: async ({ messages, isAborted }) => {
      // R15.6. Aborted Runs are persisted too, flagged — the user saw the partial
      // answer, so a history that omits it is a history that lost a turn.
      await ctx.persistence?.persist({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        messages,
        aborted: isAborted,
      });
    },
    execute: async ({ writer }) => {
      const runWriter = createRunWriter({
        runId: ctx.runId,
        messageId: ctx.messageId,
        writer,
        now,
      });
      const sourceAccumulator = new SourceAccumulator();

      const emitSources = (toolName: string | null): void => {
        const snapshot = sourceAccumulator.snapshot();
        if (snapshot.sources.length === 0 && snapshot.citations.length === 0) return;
        runWriter.source({ ...snapshot, toolName });
      };

      let request = ctx.request;
      let census = censusOf(request);
      let active: RunModelCandidate = {
        provider: ctx.provider,
        model: ctx.model,
        languageModel: ctx.languageModel,
        contextLimit: request.contextLimit,
        classifyError: ctx.classifyError,
        estimateCostCents: ctx.estimateCostCents,
      };

      const metadata = (finishedAt: string | null): RunMessageMetadata => ({
        runId: ctx.runId,
        provider: active.provider,
        model: active.model,
        conversationMode: ctx.conversationMode,
        startedAt,
        finishedAt,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        estimatedCostCents: active.estimateCostCents?.(totals) ?? null,
        tokensPerSecond: rate.current(),
        messagesInContext: census.messagesInContext,
        sessionMessageCount: census.sessionMessageCount,
        messagesOutOfWindow: census.messagesOutOfWindow,
        summaryActive: census.summaryActive,
        rulesSources: [...ctx.instructions.appliedSources],
      });

      const emitUsage = (): void => {
        runWriter.usage({
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          reasoningTokens: totals.reasoningTokens,
          cachedInputTokens: totals.cachedInputTokens,
          contextLimit: request.contextLimit,
          estimatedCostCents: active.estimateCostCents?.(totals) ?? null,
          tokensPerSecond: rate.current(),
          messagesInContext: census.messagesInContext,
          sessionMessageCount: census.sessionMessageCount,
          messagesOutOfWindow: census.messagesOutOfWindow,
          summaryActive: census.summaryActive,
        });
      };

      writer.write({ type: "start", messageId: ctx.messageId, messageMetadata: metadata(null) });
      runWriter.lifecycle({ state: "running", provider: active.provider, model: active.model });

      if (ctx.compaction !== undefined) {
        const outcome = await compactIfNeeded(
          { ...ctx.compaction, writer: runWriter },
          ctx.sessionId,
          request,
        );
        if (outcome.kind === "folded" && outcome.request !== undefined) {
          request = outcome.request;
          census = outcome.census ?? censusOf(request);
          // The summariser was a provider call on the Session's own model, so its
          // tokens belong in the Session's cumulative total (R27.2). They are
          // excluded from `tokensPerSecond`, which measures the answer stream —
          // hence added here rather than through the rate meter.
          if (outcome.usage) {
            totals.inputTokens += outcome.usage.inputTokens;
            totals.outputTokens += outcome.usage.outputTokens;
          }
        } else if (outcome.kind === "failed") {
          // Not fatal: R34.9 leaves history untouched, so the Run proceeds on the
          // context it already had. Reported as a row because the next thing the
          // user may see is a context-length refusal, and this is its cause.
          runWriter.error({
            code: outcome.error?.code ?? ErrorCode.COMPACTION_FAILED,
            message:
              "The conversation could not be summarised, so this run uses the " + "full history.",
            details: outcome.error?.message ?? null,
            retryable: true,
          });
        }
      }

      const binding = ctx.bind(runWriter);

      const runAttempt = async (
        candidate: RunModelCandidate,
      ): Promise<{
        terminal: RunLifecyclePart["state"];
        failure: ReturnType<ClassifyRunError> | null;
      }> => {
        const classifyAttempt = candidate.classifyError ?? classifyRunError;
        const nativeSearch = webSearchToolFor(candidate.provider);
        let descriptors = binding.descriptors;
        let dispatchInstructions = instructionsFor(ctx.instructions, request);
        if (binding.providerTools !== undefined) {
          const searchEnabled =
            nativeSearch !== null && (await binding.providerTools.authorizeWebSearch());
          descriptors = binding.providerTools.descriptorsFor(searchEnabled ? [nativeSearch] : []);
          if (!searchEnabled) dispatchInstructions = withoutWebSearch(dispatchInstructions);
        }
        const agent = buildAgent({
          rejectedInputs,
          model: candidate.languageModel,
          instructions: dispatchInstructions,
          descriptors,
          experimentalContext: {
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            mode: ctx.conversationMode,
            permissionMode: ctx.permissionMode,
            writer: runWriter,
            rate,
            census,
            ...(binding.context ?? {}),
          },
          onStepFinish: ({ usage }) => {
            addUsage(totals, usage);
            rate.reconcile(totals.outputTokens);
            emitUsage();
          },
          ...(ctx.maxSteps === undefined ? {} : { maxSteps: ctx.maxSteps }),
          ...(ctx.temperature === undefined ? {} : { temperature: ctx.temperature }),
          ...(ctx.maxOutputTokens === undefined ? {} : { maxOutputTokens: ctx.maxOutputTokens }),
        });

        let terminal: RunLifecyclePart["state"] = "completed";
        let failure: ReturnType<ClassifyRunError> | null = null;
        const caught: { error: unknown } = { error: null };
        let streamFailed = false;
        let streamError: unknown = null;
        const searchToolCalls = new Set<string>();

        try {
          const result = await agent.stream({
            messages: convert(request),
            ...(ctx.signal === undefined ? {} : { abortSignal: ctx.signal }),
          });

          const stream = result.toUIMessageStream<ZocUIMessage>({
            sendReasoning: true,
            sendSources: true,
            sendStart: false,
            sendFinish: false,
            onError: (error) => {
              caught.error = error;
              return boundDetails(messageOf(error)) ?? "The step failed.";
            },
          });

          const reader = stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const enriched = annotateSearchChunk(
              value,
              nativeSearch?.name ?? null,
              searchToolCalls,
            );
            if (sourceAccumulator.ingestChunk(candidate.provider, enriched)) {
              emitSources(nativeSearch?.name ?? null);
            }
            if (enriched.type === "text-delta" || enriched.type === "reasoning-delta") {
              rate.observeDelta(estimateTokens(enriched.delta));
            }
            if (enriched.type === "tool-input-available") rate.pause();
            if (
              enriched.type === "tool-output-available" ||
              enriched.type === "tool-output-error" ||
              enriched.type === "tool-output-denied"
            ) {
              rate.resume();
            }
            if (enriched.type === "abort") terminal = "cancelled";
            if (enriched.type === "error") {
              streamFailed = true;
              streamError = caught.error;
              continue;
            }
            writer.write(codedToolError(enriched, rejectedInputs, searchToolCalls));
          }

          try {
            const [sources, providerMetadata] = await Promise.all([
              result.sources,
              result.providerMetadata,
            ]);
            if (sourceAccumulator.ingestResult(candidate.provider, { sources, providerMetadata })) {
              emitSources(nativeSearch?.name ?? null);
            }
          } catch {
            // The stream failure path below already owns provider promise failures.
          }
        } catch (error) {
          if (isAbort(error) || ctx.signal?.aborted === true) terminal = "cancelled";
          else {
            terminal = "failed";
            failure = classifyAttempt(error);
          }
        }

        if (streamFailed && terminal !== "cancelled") {
          if (isAbort(streamError) || ctx.signal?.aborted === true) terminal = "cancelled";
          else {
            terminal = "failed";
            failure = classifyAttempt(streamError);
          }
        }
        return { terminal, failure };
      };

      const candidates: RunModelCandidate[] = [active, ...(ctx.fallbackModels ?? [])];
      let terminal: RunLifecyclePart["state"] = "completed";
      let failure: ReturnType<ClassifyRunError> | null = null;

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index] as RunModelCandidate;
        active = candidate;
        if (request.contextLimit !== candidate.contextLimit) {
          request = { ...request, contextLimit: candidate.contextLimit };
          census = censusOf(request);
        }

        const outcome = await runAttempt(candidate);
        terminal = outcome.terminal;
        failure = outcome.failure;
        if (terminal === "cancelled" || failure === null) break;

        const fallback = candidates[index + 1];
        if (!isFallbackFailureCode(failure.code) || fallback === undefined) {
          if (isFallbackFailureCode(failure.code)) {
            failure = {
              code: ErrorCode.MODEL_UNAVAILABLE,
              message: "No model in the configured fallback chain is available.",
              details: failure.details,
              retryable: true,
            };
          }
          break;
        }

        const from = `${candidate.provider}/${candidate.model}`;
        const to = `${fallback.provider}/${fallback.model}`;
        const fallbackMessage = `${from} was unavailable, so this run is falling back to ${to}. ${failure.message}`;
        runWriter.error({
          code: ErrorCode.MODEL_FALLBACK,
          message: fallbackMessage,
          details: null,
          retryable: false,
        });
        runWriter.lifecycle({
          state: "running",
          code: ErrorCode.MODEL_FALLBACK,
          message: fallbackMessage,
          provider: fallback.provider,
          model: fallback.model,
        });
        terminal = "completed";
        failure = null;
      }

      if (failure !== null) {
        runWriter.error({
          code: failure.code,
          message: failure.message,
          details: failure.details ?? null,
          retryable: failure.retryable,
        });
      }
      emitUsage();
      // `finish` before the terminal lifecycle, not after. `SeqFraming` closes on
      // the terminal lifecycle and drops everything behind it, so a `finish`
      // written last is a `finish` the client never receives — and with it R15.2's
      // per-Run cost and rate on a restored transcript. The Message_Part ordering
      // the protocol cares about is unaffected: `finish` is an SDK chunk, not a
      // part, so the terminal lifecycle is still the Run's last part.
      writer.write({ type: "finish", messageMetadata: metadata(now().toISOString()) });
      runWriter.lifecycle({
        state: terminal,
        ...(failure === null ? {} : { code: failure.code, message: failure.message }),
        provider: active.provider,
        model: active.model,
      });
    },
  });

  return assembled.pipeThrough(privatiseChunks());
}

/**
 * Give a tool error a taxonomy code, if it does not already carry one.
 *
 * The native tool part has an `errorText` and nothing else, so design.md:1187 puts `code`,
 * `retryable`, and `details` in `providerMetadata.zoc` — and without them the surface
 * renders a failed tool it cannot classify: no retry decision, no way to tell a malformed
 * call apart from a workspace outage.
 *
 * **An input-schema failure does not end the Run**, which is the point of enriching rather
 * than escalating. `zod` rejected what the model produced, the loop reports it back as the
 * tool's result, and the model usually corrects itself on the next step — so this is a row
 * in the timeline, not a terminal state (R22.3).
 *
 * Anything that already carries `providerMetadata.zoc` passes through untouched: the
 * permission gate and the driver's abandonment both set their own, and overwriting a
 * `permission_denied` with a generic code would lose the only field that says why.
 */
function codedToolError(
  chunk: ZocUIChunk,
  rejectedInputs: ReadonlySet<string>,
  searchToolCalls: ReadonlySet<string>,
): ZocUIChunk {
  if (chunk.type !== "tool-input-error" && chunk.type !== "tool-output-error") return chunk;

  const existing = (chunk as { providerMetadata?: Record<string, unknown> }).providerMetadata;
  const existingZoc =
    typeof existing?.zoc === "object" && existing.zoc !== null
      ? (existing.zoc as Record<string, unknown>)
      : {};
  if (typeof existingZoc.code === "string") return chunk;

  const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId;
  const schemaRejected =
    chunk.type === "tool-input-error" ||
    (typeof toolCallId === "string" && rejectedInputs.has(toolCallId));
  const searchFailed = typeof toolCallId === "string" && searchToolCalls.has(toolCallId);

  const coded = searchFailed
    ? { code: ErrorCode.WEB_SEARCH_FAILED, retryable: true }
    : schemaRejected
      ? { code: ErrorCode.TOOL_SCHEMA_INVALID, retryable: false }
      : // A tool whose `execute` threw for some other reason. The workspace tools return
        // outcomes rather than throwing by construction, so reaching here is a defect in a
        // tool rather than something the model can fix — hence `internal` and no retry.
        { code: ErrorCode.INTERNAL, retryable: false };

  return {
    ...chunk,
    providerMetadata: {
      ...(existing ?? {}),
      zoc: { ...existingZoc, ...coded, details: existingZoc.details ?? null },
    },
  } as unknown as ZocUIChunk;
}

/** Add the text part id and authoritative network kind to native SDK chunks. */
function annotateSearchChunk(
  chunk: ZocUIChunk,
  searchToolName: string | null,
  searchToolCalls: Set<string>,
): ZocUIChunk {
  const raw = chunk as unknown as Record<string, unknown>;
  const additions: Record<string, unknown> = {};

  if (chunk.type === "text-start" || chunk.type === "text-delta" || chunk.type === "text-end") {
    additions.partId = chunk.id;
  }

  const toolName = typeof raw.toolName === "string" ? raw.toolName : null;
  const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : null;
  if (searchToolName !== null && toolName === searchToolName && toolCallId !== null) {
    searchToolCalls.add(toolCallId);
  }
  if (toolCallId !== null && searchToolCalls.has(toolCallId)) additions.kind = "network";

  if (Object.keys(additions).length === 0) return chunk;
  const providerMetadata =
    typeof raw.providerMetadata === "object" && raw.providerMetadata !== null
      ? (raw.providerMetadata as Record<string, unknown>)
      : {};
  const existingZoc =
    typeof providerMetadata.zoc === "object" && providerMetadata.zoc !== null
      ? (providerMetadata.zoc as Record<string, unknown>)
      : {};
  return {
    ...chunk,
    providerMetadata: { ...providerMetadata, zoc: { ...existingZoc, ...additions } },
  } as ZocUIChunk;
}

/**
 * A pass-through that hands every chunk on as a copy the stream alone owns.
 *
 * `createUIMessageStream` inserts `processUIMessageStream` whenever an `onFinish`
 * is supplied — which this module always supplies, because R15.6 persists the
 * assembled message. That stage builds the message out of the very chunk objects
 * it forwards: a data chunk is pushed into `message.parts` as itself, and a later
 * chunk carrying the same reconciliation id is folded in by
 * `existingUIPart.data = dataChunk.data`. Correct for the message it is building,
 * wrong for the stream it is forwarding: the two `zoc-run` lifecycle chunks share
 * a reconciliation id by design (`writer.ts` keys it on the run id so the surface
 * updates one row in place), so the terminal write reseats the payload of the
 * `running` chunk that went out before it. A reader that has not yet serialised
 * the first one then serialises `completed` twice, and the surface never sees the
 * Run start.
 *
 * The copy is taken here rather than in `RunWriter` because the aliasing is
 * introduced downstream of the writer — by then the object is the SDK's. One
 * shallow copy of the chunk and of its `data` suffices: the mutation reseats the
 * reference, it does not reach into the payload. And because a `TransformStream`
 * runs one chunk through synchronously before accepting the next, the copy of
 * chunk *n* is complete before chunk *n+1* can be processed upstream, which is
 * what makes this a fix rather than a narrower race.
 */
function privatiseChunks(): TransformStream<ZocUIChunk, ZocUIChunk> {
  return new TransformStream<ZocUIChunk, ZocUIChunk>({
    transform(chunk, controller) {
      controller.enqueue(privateCopy(chunk));
    },
  });
}

/**
 * A `data-*` chunk copied one level deep; anything else passed straight back.
 *
 * The assertion is unavoidable rather than lazy: TypeScript does not track that a
 * spread which replaces `data` leaves `type` and `data` correlated, so copying a
 * seven-member discriminated union widens to the cross product of its arms. The
 * runtime shape is the input's, field for field.
 */
function privateCopy(chunk: ZocUIChunk): ZocUIChunk {
  const data: unknown = (chunk as { data?: unknown }).data;
  if (!chunk.type.startsWith("data-") || typeof data !== "object" || data === null) {
    return chunk;
  }
  return { ...chunk, data: { ...data } } as unknown as ZocUIChunk;
}
