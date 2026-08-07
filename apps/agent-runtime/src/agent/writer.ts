/**
 * Agent_Runtime stream writer and sequence allocator — zoc-agent-chat-rebuild
 * R7.1, R7.7, R16.3.
 *
 * Feature: zoc-agent-chat-rebuild, R7.1, R7.7, R16.3.
 *
 * Two collaborating pieces, split for one structural reason.
 *
 * `RunWriter` builds the seven Zoc data parts and hands them to the AI SDK's
 * `UIMessageStreamWriter`. `createSeqFraming` is the transform every chunk on the
 * merged stream passes through on its way to a socket — and it is the **only**
 * place `seq` is allocated.
 *
 * Why allocation lives at the framing stage rather than in `RunWriter`, which is
 * the obvious place to put it and where the design sketch showed it: the stream
 * the client sees is `createUIMessageStream` merging *two* producers — the Zoc
 * data parts this writer emits, and the model's own text/reasoning/tool chunks
 * that `agent.stream()` produces (9.6). If `RunWriter` numbered its own parts,
 * the model's chunks would either be unnumbered — leaving the transport's gap
 * detection blind across most of a normal Run — or numbered by a second counter,
 * which is the duplicate-or-gap bug the whole protocol exists to rule out. One
 * counter at the point of serialisation gives numbers in the order the client
 * actually receives them, which is the only order that means anything to a
 * client reconciling against `lastRenderedSeq`.
 *
 * Three consequences worth stating, because each is a plausible "cleanup":
 *
 *   - **`seq` rides on the SSE `id:` field, not only inside the payload.** A
 *     native `text-delta` chunk has nowhere to put a `seq` — the SDK owns that
 *     shape. Putting the number on the frame means one rule covers native and
 *     data chunks alike, and a bare `EventSource` reconnect (which sends
 *     `Last-Event-ID`) lands on exactly the protocol `?fromSeq=` uses instead of
 *     a second one that can disagree.
 *   - **A data part's `seq` field is stamped here too**, not at construction. It
 *     is declared on `PartBase` because the persisted transcript needs it; the
 *     placeholder a typed writer sets is overwritten by the allocator before the
 *     chunk is framed. Reading `part.seq` before framing gets `UNSTAMPED_SEQ`.
 *   - **Reconciled emissions consume a number.** A `done`/`text-end` chunk that
 *     closes a part already streamed is an emission and takes the next `seq`.
 *     Reusing the delta's number to "correct in place" would make two frames
 *     share an id, and the transport would discard the second as already seen.
 *
 * Sub-agent parts (M2, 29.1) need no special handling: there is one framing
 * stage per Run, so a child writing onto the parent's merged stream draws from
 * the parent's counter by construction rather than by discipline.
 */

import type {
  CompactionPart,
  DiffPart,
  ErrorPart,
  MessagePart,
  PartBase,
  PermissionRequestPart,
  PlanPart,
  RunLifecyclePart,
  SourcePart,
  UsagePart,
} from "@zoc-studio/shared-types";

/** The first number a Run's first emission carries (R7.7). */
export const FIRST_SEQ = 1;

/**
 * The value a typed writer puts in `seq` before the allocator stamps the real
 * one. Zero rather than -1 or null so the field stays a `number` and a part that
 * escapes unstamped is obvious rather than type-error-adjacent.
 */
export const UNSTAMPED_SEQ = 0;

/**
 * The seven `data-zoc-*` parts with an M1 producer.
 *
 * Seven, not the eight the part map declares at 1.4. `zoc-source` has no M1
 * producer — provider-native web search lands at M2's 36.3 and brings its writer
 * with it. A writer for a part nothing emits is dead code that reads as a
 * supported feature, and the map is already final on the wire, so nothing waits
 * on it.
 *
 * `zoc-compaction` *is* here and is not a placeholder: 9.5 emits one part per
 * compaction through this writer and `CompactionRow` (16.3) renders it. R34 is an
 * M1 requirement.
 *
 * Mirrors `ZocDataParts` in `apps/frontend/src/features/chat/wire/ui-message.ts`
 * minus that one key. Declared here rather than imported because an app must not
 * import from another app's source tree; both sides derive every part from
 * `@zoc-studio/shared-types`, so the two cannot drift in the part *shapes* — only
 * in which keys exist, which is what `writer.contract.test.ts` guards.
 */
export interface ZocProducedParts {
  "zoc-plan": PlanPart;
  "zoc-diff": DiffPart;
  "zoc-permission": PermissionRequestPart;
  "zoc-run": RunLifecyclePart;
  "zoc-usage": UsagePart;
  "zoc-error": ErrorPart;
  "zoc-source": SourcePart;
  "zoc-compaction": CompactionPart;
}

export type ZocDataChunkType = `data-${keyof ZocProducedParts & string}`;

/** A `data-zoc-*` chunk as the AI SDK frames it: `type`, reconciliation `id`, payload. */
export interface ZocDataChunk<K extends keyof ZocProducedParts = keyof ZocProducedParts> {
  readonly type: `data-${K & string}`;
  readonly id: string;
  readonly data: ZocProducedParts[K];
}

/**
 * Anything that can go on the wire: a Zoc data chunk or one of the SDK's own.
 *
 * The native arm is `Record<string, unknown>` with a `type` rather than the SDK's
 * `UIMessageChunk` union, so this module does not have to restate twenty-odd
 * chunk shapes it never constructs and only ever passes through. The framing
 * stage's job for a native chunk is to number it, not to understand it.
 */
export type OutboundChunk = ZocDataChunk | ({ readonly type: string } & Record<string, unknown>);

/** The subset of `UIMessageStreamWriter` this module needs. Narrow for testability. */
export interface ChunkWriter {
  write(chunk: OutboundChunk): void;
}

/**
 * Everything a caller supplies for one data part: the part's own fields, minus
 * the five `PartBase` fields and the discriminant, all of which the writer fills.
 *
 * `agentName` is excluded rather than accepted because it is a property of *who
 * is writing*, not of the individual part — a sub-agent's every part carries its
 * name, and letting a call site pass one invites a stream where two parts from
 * the same agent disagree about it.
 */
export type PartPayload<P extends MessagePart> = Omit<P, keyof PartBase | "type">;

/**
 * The run states that end a Run.
 *
 * `queued`, `running`, and `awaiting-approval` are the three a Run can sit in and
 * still emit — `awaiting-approval` in particular is a Plan_Approval pause (8.4),
 * which is neither running nor over.
 */
export const TERMINAL_RUN_STATES = ["completed", "cancelled", "failed", "interrupted"] as const;

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

export function isTerminalRunState(state: string): state is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

// ── The allocator ─────────────────────────────────────────────────────

/**
 * The `seq` source for one Run.
 *
 * A class rather than a closure so a sub-agent framing stage could share it by
 * reference; a counter that is copied rather than shared is the same bug as a
 * second allocator, only harder to see.
 */
export class SequenceAllocator {
  private cursor = FIRST_SEQ - 1;

  /** The next number, one greater than the last, always. */
  next(): number {
    this.cursor += 1;
    return this.cursor;
  }

  /** The number most recently handed out; `FIRST_SEQ - 1` before the first. */
  get last(): number {
    return this.cursor;
  }

  /** How many numbers have been handed out. */
  get count(): number {
    return this.cursor - (FIRST_SEQ - 1);
  }
}

// ── SSE framing ───────────────────────────────────────────────────────

/** Response headers for a part stream. `no-transform` stops a proxy buffering it. */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
});

/**
 * Serialise one numbered chunk as a single SSE event.
 *
 * `JSON.stringify` cannot emit a raw newline — it escapes them inside strings and
 * produces none between tokens — so the payload is guaranteed to be one `data:`
 * line and the frame is guaranteed to be one event. A multi-line payload would
 * split into events whose second half parses as neither `id` nor `data`.
 */
export function encodeSseFrame(seq: number, chunk: OutboundChunk): string {
  return `id: ${seq}\ndata: ${JSON.stringify(chunk)}\n\n`;
}

/** An SSE comment. Keeps an idle connection warm without entering the sequence. */
export const SSE_KEEPALIVE = ": keepalive\n\n";

// ── The framing stage: allocate, buffer, frame ────────────────────────

/** One emission held for replay. */
export interface BufferedChunk {
  readonly seq: number;
  readonly chunk: OutboundChunk;
}

/**
 * Where numbered chunks go.
 *
 * Implemented by the run store (9.3): `append` pushes into the 2048-chunk resume
 * ring, `broadcast` fans out to whatever SSE responses are attached right now.
 * Two calls rather than one because the two have different failure modes — a
 * detached reader must not stop a chunk being buffered for the resume that
 * follows, which is exactly the mid-stream-disconnect case 11.1 recovers from.
 */
export interface ChunkSink {
  append(entry: BufferedChunk): void;
  broadcast(entry: BufferedChunk, frame: string): void;
}

export interface SeqFramingOptions {
  readonly sink: ChunkSink;
  readonly allocator?: SequenceAllocator;
}

/**
 * The single allocation point for one Run.
 *
 * Closes permanently once a terminal `run-lifecycle` chunk has been framed. A
 * later chunk is **dropped and counted, not thrown**: a tool settling after
 * cancel is a normal race (9.7 abandons unsettled tools after a 1500 ms grace),
 * and throwing from that callback would turn a tidy cancellation into an
 * unhandled rejection on a stream that already closed correctly. Dropping in
 * silence would be worse than either, so `droppedAfterClose` makes it observable
 * and 9.10 asserts it.
 */
export class SeqFraming {
  private readonly sink: ChunkSink;
  private readonly allocator: SequenceAllocator;
  private terminal: TerminalRunState | null = null;
  private dropped = 0;

  constructor(options: SeqFramingOptions) {
    this.sink = options.sink;
    this.allocator = options.allocator ?? new SequenceAllocator();
  }

  get lastSeq(): number {
    return this.allocator.last;
  }

  get terminalState(): TerminalRunState | null {
    return this.terminal;
  }

  get closed(): boolean {
    return this.terminal !== null;
  }

  /** Chunks refused because the Run had already reached a terminal state. */
  get droppedAfterClose(): number {
    return this.dropped;
  }

  /**
   * Number, buffer, and frame one chunk.
   *
   * Order matters: `append` precedes `broadcast` so a chunk is in the resume ring
   * before any live reader can see it. The reverse order leaves a window where a
   * reader has rendered `seq: n` that a reconnect a millisecond later would be
   * told does not exist.
   */
  frame(chunk: OutboundChunk): BufferedChunk | null {
    if (this.terminal !== null) {
      this.dropped += 1;
      return null;
    }

    const seq = this.allocator.next();

    // Stamp the real number onto the part the persisted transcript keeps. The
    // typed writers set `UNSTAMPED_SEQ`; this is where it becomes true.
    if (isZocDataChunk(chunk)) {
      (chunk.data as { seq: number }).seq = seq;
    }

    const entry: BufferedChunk = { seq, chunk };
    this.sink.append(entry);
    this.sink.broadcast(entry, encodeSseFrame(seq, chunk));

    // Closing *after* delivery, so the chunk that ends the Run is the last one
    // out rather than the first one refused.
    if (isTerminalLifecycle(chunk)) {
      this.terminal = chunk.data.state as TerminalRunState;
    }
    return entry;
  }
}

export function isZocDataChunk(chunk: OutboundChunk): chunk is ZocDataChunk {
  return (
    typeof chunk.type === "string" &&
    chunk.type.startsWith("data-zoc-") &&
    typeof (chunk as ZocDataChunk).data === "object" &&
    (chunk as ZocDataChunk).data !== null
  );
}

function isTerminalLifecycle(chunk: OutboundChunk): chunk is ZocDataChunk<"zoc-run"> {
  if (chunk.type !== "data-zoc-run") return false;
  const state = (chunk as ZocDataChunk<"zoc-run">).data?.state;
  return typeof state === "string" && isTerminalRunState(state);
}

// ── The typed data-part writers ───────────────────────────────────────

export interface RunWriterOptions {
  readonly runId: string;
  readonly messageId: string;
  readonly writer: ChunkWriter;
  /** Injected in tests so a part's `ts` is assertable. */
  readonly now?: () => Date;
  /** Set only for a sub-agent writer; null through all of M1 (1.1). */
  readonly agentName?: string | null;
}

/**
 * Builds the seven Zoc data parts for one Run and writes them onto the merged
 * stream.
 *
 * Every method returns the part it wrote with `seq: UNSTAMPED_SEQ` — the object
 * is the same one the framing stage stamps, so a caller holding the return value
 * sees the real number once the chunk has been framed. Callers that need the
 * number synchronously do not exist by design; anything that did would be
 * reintroducing a second ordering.
 *
 * The reconciliation `id` on each chunk is chosen so that later writes *replace*
 * earlier ones on the client: one lifecycle row per Run that updates in place,
 * one usage row, one row per plan, one per file in a diff. `error` is the
 * exception — each error is its own row, so it gets a unique id.
 */
export class RunWriter {
  readonly runId: string;
  readonly messageId: string;
  readonly agentName: string | null;

  private readonly writer: ChunkWriter;
  private readonly now: () => Date;
  private errorOrdinal = 0;

  constructor(options: RunWriterOptions) {
    this.runId = options.runId;
    this.messageId = options.messageId;
    this.agentName = options.agentName ?? null;
    this.writer = options.writer;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * A writer for a sub-agent's parts (M2 29.1).
   *
   * Nothing about the counter is passed along: there is one framing stage per
   * Run, so a child's chunks are numbered by the parent's allocator because they
   * travel on the parent's stream. `agentName` is what makes them attributable
   * (R7.2) — a shared `seq` space is not a shared identity.
   */
  forSubAgent(agentName: string, messageId: string = this.messageId): RunWriter {
    return new RunWriter({
      runId: this.runId,
      messageId,
      writer: this.writer,
      now: this.now,
      agentName,
    });
  }

  plan(payload: PartPayload<PlanPart>): PlanPart {
    return this.data("zoc-plan", payload.planId, "plan", payload);
  }

  /** Reconciled per file, not per plan: a plan touching six files is six rows. */
  diff(payload: PartPayload<DiffPart>): DiffPart {
    return this.data("zoc-diff", `${payload.planId}:${payload.path}`, "diff", payload);
  }

  permission(payload: PartPayload<PermissionRequestPart>): PermissionRequestPart {
    return this.data("zoc-permission", payload.requestId, "permission-request", payload);
  }

  /** One row per Run, updated in place — hence `id` is the run id. */
  lifecycle(payload: PartPayload<RunLifecyclePart>): RunLifecyclePart {
    return this.data("zoc-run", this.runId, "run-lifecycle", payload);
  }

  /**
   * Token accounting, Token_Rate, and the context census on one part.
   *
   * One part rather than three so a reader cannot pair a count from one Run with
   * a limit from another (R12.8, R12.10) — the whole reason the census rides
   * alongside `contextLimit` at 1.1.
   */
  usage(payload: PartPayload<UsagePart>): UsagePart {
    return this.data("zoc-usage", this.runId, "usage", payload);
  }

  error(payload: PartPayload<ErrorPart>): ErrorPart {
    this.errorOrdinal += 1;
    return this.data("zoc-error", `${this.runId}:error:${this.errorOrdinal}`, "error", payload);
  }

  /** One growing source row per Run. */
  source(payload: PartPayload<SourcePart>): SourcePart {
    return this.data("zoc-source", this.runId, "source", payload);
  }

  /** A registration-time refusal for a provider tool that has no local execute. */
  providerToolError(payload: {
    readonly toolName: string;
    readonly kind: "network";
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }): void {
    const toolCallId = `${this.runId}:registration:${payload.toolName}`;
    this.writer.write({
      type: "tool-input-available",
      toolCallId,
      toolName: payload.toolName,
      input: {},
      providerExecuted: true,
      providerMetadata: { zoc: { kind: payload.kind } },
    });
    this.writer.write({
      type: "tool-output-error",
      toolCallId,
      errorText: payload.message,
      providerExecuted: true,
      providerMetadata: {
        zoc: {
          kind: payload.kind,
          code: payload.code,
          retryable: payload.retryable,
          details: null,
        },
      },
    });
  }

  compaction(payload: PartPayload<CompactionPart>): CompactionPart {
    return this.data("zoc-compaction", payload.compactionId, "compaction", payload);
  }

  private data<K extends keyof ZocProducedParts>(
    kind: K,
    id: string,
    type: ZocProducedParts[K]["type"],
    payload: PartPayload<ZocProducedParts[K]>,
  ): ZocProducedParts[K] {
    const part = {
      ...payload,
      type,
      seq: UNSTAMPED_SEQ,
      runId: this.runId,
      messageId: this.messageId,
      ts: this.now().toISOString(),
      agentName: this.agentName,
    } as unknown as ZocProducedParts[K];

    this.writer.write({ type: `data-${kind}`, id, data: part } as ZocDataChunk<K>);
    return part;
  }
}

export function createRunWriter(options: RunWriterOptions): RunWriter {
  return new RunWriter(options);
}

export function createSeqFraming(options: SeqFramingOptions): SeqFraming {
  return new SeqFraming(options);
}
