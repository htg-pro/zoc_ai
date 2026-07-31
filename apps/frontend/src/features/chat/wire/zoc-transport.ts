/**
 * The Chat_Surface's transport — zoc-agent-chat-rebuild R5.2, R7.7, R7.8, R16.1,
 * R16.3, R16.4, R16.5.
 *
 * `DefaultChatTransport` cannot be used, and the reason is not ergonomics. It owns three
 * things this one has to own instead:
 *
 *   - **The per-launch bearer token**, resolved through `runtime-endpoint.ts` rather than
 *     baked into a header at construction, because the runtime's port and token are
 *     discovered per launch and can change under a restart.
 *   - **The sequence contract (R7.7, R16.4).** A part at or below `lastRenderedSeq` is
 *     discarded and a gap forces a bounded re-attach, both *before* `useChat` sees a
 *     chunk. Rendering out of order is the failure this exists to prevent, and it is not
 *     something a hook can undo afterwards.
 *   - **Out-of-band cancellation (R16.1).** The AI SDK documents that abort and resumable
 *     streams are mutually exclusive, and R16.1 and R16.3 both apply — so cancel is a
 *     `POST /v1/runs/:id/cancel` and never `stop()`, and the fetch is left alone.
 *
 * `useChat` is configured with this transport and **without** `resume: true`: resumption
 * is the transport's job precisely so that the absence of `stop()` does not matter.
 *
 * ## What goes over the wire, and what does not
 *
 * Only the Session id, the newest user message, the mentions, the two mode axes, and the
 * model reference. Not the transcript: the runtime rehydrates history, so a 500-message
 * Session does not re-upload on every turn (R20.3, R20.5). And **no `api_key` field, by
 * construction** (R7.8) — the body is built from a fixed set of keys in one place, so
 * there is no path by which a credential could be spread into it.
 *
 * ## Failure is a part, not a rejection
 *
 * On re-attach exhaustion, or on a 409 / 404 that says the gap can never be closed, the
 * returned stream emits a synthetic `run-lifecycle{state:"interrupted", code:"stream_lost"}`
 * and closes normally. `useChat` then reaches a terminal state through the ordinary path
 * and R16.5's interrupted row renders with its "continue with what we have" affordance. A
 * rejected promise would leave the hook `error`-ed with a transcript it could not explain.
 */

import type { ChatTransport, UIMessageChunk } from "ai";
import type { ConversationMode, RunLifecyclePart } from "@zoc-studio/shared-types";

import type { ZocUIMessage } from "./ui-message";

/** R16.3's ceiling: at most five re-attach attempts. */
export const MAX_REATTACH_ATTEMPTS = 5;

/**
 * Base delays for the bounded re-attach, in milliseconds.
 *
 * Full jitter — `random(0, base)` rather than `base` — so a suspend/resume that wakes
 * every open Session at once does not produce a thundering re-attach at the same instant.
 * Worst-case elapsed before giving up is 7.75 s, which is inside the resume window the
 * runtime's 2048-part ring guarantees.
 */
export const REATTACH_BASE_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

/** The runtime endpoint, resolved per call so a restart's new port is picked up. */
export interface RuntimeEndpoint {
  readonly baseUrl: string;
  /** Empty in a browser preview, where admission is not enforced. */
  readonly token: string;
}

/** A mention as the request carries it (R12.3). */
export interface MentionRef {
  readonly kind: "file" | "symbol" | "terminal" | "doc";
  readonly ref: string;
  readonly label?: string;
  readonly content?: string;
}

export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl?: string | null;
}

/**
 * Everything about the *next* submission that lives outside the message list.
 *
 * Read through a function rather than passed at construction because all five change
 * between turns — the user switches mode, adds a mention, picks a different model — and a
 * transport constructed once per Session would otherwise hold the first turn's choices
 * forever.
 */
export interface SubmissionContext {
  readonly mode: ConversationMode;
  readonly permissionMode: "ask" | "auto" | "deny";
  readonly modelRef: ModelRef;
  readonly mentions: readonly MentionRef[];
}

/** One Run the transport is following, as the surface needs to see it. */
export interface ActiveRun {
  readonly runId: string;
  readonly streamUrl: string;
  /** The highest `seq` the renderer has committed. Re-attach resumes from here. */
  readonly lastRenderedSeq: number;
}

export interface ZocTransportOptions {
  readonly endpoint: (signal?: AbortSignal) => Promise<RuntimeEndpoint>;
  readonly submission: () => SubmissionContext;
  /**
   * The active Run for a Session, for `reconnectToStream` after a reload.
   *
   * The surface owns this because it owns `lastRenderedSeq`: the transport advances the
   * number as chunks pass through, but only the renderer knows what it committed, and
   * R16.4's contract is about what was *rendered* rather than what was received.
   */
  readonly activeRun?: (sessionId: string) => ActiveRun | null;
  /** Called whenever a Run is opened or its `seq` advances, so the surface can persist it. */
  readonly onRunProgress?: (run: ActiveRun & { sessionId: string }) => void;
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests; production sleeps for real. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so the jitter is deterministic. */
  readonly random?: () => number;
}

/** The four-field envelope every Zoc failure carries (R16.6). */
export interface ZocErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly details: string | null;
  readonly retryable: boolean;
}

/**
 * A runtime HTTP failure, normalised.
 *
 * Thrown from `sendMessages` rather than turned into a part: a Run that was never opened
 * has no transcript to append to, and `useChat` surfacing the rejection is the correct
 * outcome — R7.5's "card naming the rejected field" is rendered off this.
 */
export class RuntimeRequestError extends Error {
  readonly status: number;
  readonly envelope: ZocErrorEnvelope;

  constructor(status: number, envelope: ZocErrorEnvelope) {
    super(envelope.message);
    this.name = "RuntimeRequestError";
    this.status = status;
    this.envelope = envelope;
  }
}

async function runtimeError(response: Response): Promise<RuntimeRequestError> {
  let envelope: Partial<ZocErrorEnvelope> = {};
  try {
    envelope = (await response.json()) as Partial<ZocErrorEnvelope>;
  } catch {
    /* a non-JSON body is still a failure, just an unlabelled one */
  }
  return new RuntimeRequestError(response.status, {
    code: envelope.code ?? "internal",
    message: envelope.message ?? "The agent runtime could not start this run.",
    details: envelope.details ?? null,
    retryable: envelope.retryable ?? false,
  });
}

/** The last user message's text, which is the only message the request carries. */
function lastUserText(messages: readonly ZocUIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) return text;
  }
  return "";
}

/** One SSE frame, split into its `id:` and `data:` lines. */
interface Frame {
  readonly seq: number | null;
  readonly chunk: UIMessageChunk;
}

/**
 * Parse one SSE event.
 *
 * A comment-only frame — the runtime's keepalive — yields `null`, and so does anything
 * whose `data:` is not JSON. Both are skipped rather than failing the stream: a keepalive
 * is normal, and a frame the client cannot parse is one the client cannot render either,
 * so tearing down the connection over it would turn a rendering gap into a lost Run.
 */
function parseFrame(raw: string): Frame | null {
  let seq: number | null = null;
  let data: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) {
      const parsed = Number(line.slice(3).trim());
      if (Number.isInteger(parsed)) seq = parsed;
    } else if (line.startsWith("data:")) {
      data = line.slice(5).trim();
    }
  }
  if (data === null || data.length === 0) return null;
  try {
    return { seq, chunk: JSON.parse(data) as UIMessageChunk };
  } catch {
    return null;
  }
}

/**
 * The synthetic terminal for a Run whose stream could not be recovered (R16.5).
 *
 * A `data-zoc-run` part rather than an `error` chunk, and that is the point: the surface
 * already renders a lifecycle row per Run and reconciles it by `runId`, so an interrupted
 * Run updates the row the user is looking at instead of adding an unexplained error
 * beneath it.
 */
function interruptedChunk(runId: string, messageId: string, seq: number): UIMessageChunk {
  const part: RunLifecyclePart = {
    type: "run-lifecycle",
    seq,
    runId,
    messageId,
    ts: new Date().toISOString(),
    agentName: null,
    state: "interrupted",
    code: "stream_lost",
    message: "The connection to this run was lost. The transcript above is what arrived.",
  };
  return { type: "data-zoc-run", id: runId, data: part } as unknown as UIMessageChunk;
}

export class ZocChatTransport implements ChatTransport<ZocUIMessage> {
  private readonly options: ZocTransportOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: ZocTransportOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => globalThis.setTimeout(done, ms)));
    this.random = options.random ?? Math.random;
  }

  async sendMessages(opts: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: ZocUIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const endpoint = await this.options.endpoint(opts.abortSignal);
    const submission = this.options.submission();

    // Built key by key from a fixed set, which is where R7.8 is enforced rather than
    // intended: there is no spread of caller-supplied options into this object, so no
    // path exists by which an `api_key` could join it.
    const body = {
      // `chatId` is `useChat`'s vocabulary; Zoc names it `sessionId` everywhere (R35.5).
      sessionId: opts.chatId,
      prompt: lastUserText(opts.messages),
      mentions: submission.mentions.map((mention) => ({
        kind: mention.kind,
        ref: mention.ref,
        ...(mention.label === undefined ? {} : { label: mention.label }),
        ...(mention.content === undefined ? {} : { content: mention.content }),
      })),
      mode: submission.mode,
      permissionMode: submission.permissionMode,
      modelRef: {
        provider: submission.modelRef.provider,
        modelId: submission.modelRef.modelId,
        ...(submission.modelRef.baseUrl == null ? {} : { baseUrl: submission.modelRef.baseUrl }),
      },
    };

    const response = await this.fetchImpl(`${endpoint.baseUrl}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(endpoint) },
      body: JSON.stringify(body),
      // Deliberately *not* `opts.abortSignal`: aborting the submission would leave a Run
      // the runtime has admitted with no reader, and cancellation is `cancel()` below.
    });
    if (!response.ok) throw await runtimeError(response);

    const opened = (await response.json()) as { runId: string; streamUrl: string };
    this.options.onRunProgress?.({
      sessionId: opts.chatId,
      runId: opened.runId,
      streamUrl: opened.streamUrl,
      lastRenderedSeq: 0,
    });

    return this.attach(opts.chatId, opened.runId, opened.streamUrl, 0);
  }

  /** Re-attach after a reload or an explicit resume (R16.3). */
  async reconnectToStream(opts: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    const active = this.options.activeRun?.(opts.chatId) ?? null;
    if (active === null) return null;
    return this.attach(opts.chatId, active.runId, active.streamUrl, active.lastRenderedSeq);
  }

  /**
   * Cancel out of band (R16.1).
   *
   * Never `stop()`, and never aborting the stream's fetch: the outcome arrives as a
   * cancelled lifecycle part on the stream the caller is already reading, which is the
   * only channel that can report *which* tools were abandoned. Failures are swallowed
   * because a cancel that did not land leaves the Run running and the stop button is not a
   * place to render an error — the Run's own terminal row is.
   */
  async cancel(runId: string): Promise<void> {
    try {
      const endpoint = await this.options.endpoint();
      await this.fetchImpl(`${endpoint.baseUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: authHeaders(endpoint),
      });
    } catch {
      /* the Run's terminal row is the report, not this call */
    }
  }

  /**
   * Decide one pending approval (R11.7, R11.8).
   *
   * Unlike {@link cancel}, a failure here is **not** swallowed. The three ways this call fails are all
   * things the user has to be told: the request was already decided (409, from another window on a
   * shared Session), the window closed before the click landed (410, R11.9), or the Run is gone (404).
   * A dock that silently kept asking after any of those would be asking a question nothing can answer.
   *
   * The scope rides on an approval and is ignored for a rejection, which is the runtime's own shape —
   * one route, one body, `kind: "tool"` discriminating it from a Plan_Approval.
   */
  async decideApproval(
    runId: string,
    request: {
      requestId: string;
      decision: "approve" | "reject";
      scope?: "call" | "run" | "workspace";
    },
  ): Promise<void> {
    const endpoint = await this.options.endpoint();
    const response = await this.fetchImpl(
      `${endpoint.baseUrl}/v1/runs/${encodeURIComponent(runId)}/approvals`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(endpoint) },
        body: JSON.stringify({
          kind: "tool",
          requestId: request.requestId,
          decision: request.decision,
          scope: request.scope ?? "call",
        }),
      },
    );
    if (!response.ok) throw await runtimeError(response);
  }

  /**
   * Open the SSE stream and enforce the sequence contract on the way out.
   *
   * The loop is over *attempts*, not over frames, because a gap is handled by starting a
   * new attempt from `lastRenderedSeq` — which is the same operation as recovering from a
   * dropped socket, and collapsing them into one path is what keeps the attempt budget
   * meaningful. Three rules, in order:
   *
   *   - `seq <= lastRenderedSeq` is a duplicate and is dropped (R16.4). A replay always
   *     produces some, because the runtime replays from `fromSeq` exclusive and a client
   *     may have rendered further than it last reported.
   *   - `seq > lastRenderedSeq + 1` is a gap. The connection is torn down and re-attached
   *     rather than the part being rendered, because a renderer that has painted `seq 9`
   *     cannot un-paint it when `seq 7` arrives.
   *   - a frame with no `id:` is a chunk outside the sequence space — the runtime does not
   *     emit one, but a proxy that rewrote the stream could — and is passed through
   *     untouched rather than being counted as a gap.
   *
   * A terminal lifecycle ends the stream for good: `settled` is set before the reader can
   * report `done`, so a socket that closes *after* a terminal part is a clean end rather
   * than a drop worth retrying.
   */
  private attach(
    sessionId: string,
    runId: string,
    streamUrl: string,
    fromSeq: number,
  ): ReadableStream<UIMessageChunk> {
    let lastRenderedSeq = fromSeq;
    let settled = false;
    // Bound rather than aliased through `this`: the `start` callback below is invoked by
    // the stream, so it needs the two methods it calls captured explicitly.
    const pump = this.pump.bind(this);
    const sleep = this.sleep;
    const random = this.random;
    const onRunProgress = this.options.onRunProgress;

    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        for (let attempt = 0; attempt <= MAX_REATTACH_ATTEMPTS; attempt += 1) {
          if (attempt > 0) {
            const base = REATTACH_BASE_DELAYS_MS[attempt - 1] ?? 0;
            // Full jitter: `random(0, base)`, not `base`.
            await sleep(Math.floor(random() * base));
          }

          let outcome: "done" | "gap" | "dropped" | "unrecoverable";
          try {
            outcome = await pump(streamUrl, lastRenderedSeq, {
              emit: (chunk) => controller.enqueue(chunk),
              advance: (seq) => {
                lastRenderedSeq = seq;
                onRunProgress?.({ sessionId, runId, streamUrl, lastRenderedSeq: seq });
              },
              terminal: () => {
                settled = true;
              },
            });
          } catch {
            // A thrown fetch is a dropped socket, which is exactly what the budget is for.
            outcome = "dropped";
          }

          if (outcome === "done" || settled) {
            controller.close();
            return;
          }
          if (outcome === "unrecoverable") break;
          // `gap` and `dropped` both re-attach, from whatever was last rendered.
        }

        // Budget exhausted, or the runtime said the gap can never be closed. R16.5: one
        // honest interrupted row rather than a stream that simply stops.
        controller.enqueue(interruptedChunk(runId, `msg_${runId}`, lastRenderedSeq + 1));
        controller.close();
      },
    });
  }

  /**
   * Read one connection to exhaustion, a gap, or a terminal part.
   *
   * Returns rather than throwing for the recoverable outcomes so the caller's attempt loop
   * stays the only place that decides whether to try again.
   */
  private async pump(
    streamUrl: string,
    fromSeq: number,
    sink: {
      emit: (chunk: UIMessageChunk) => void;
      advance: (seq: number) => void;
      terminal: () => void;
    },
  ): Promise<"done" | "gap" | "dropped" | "unrecoverable"> {
    const endpoint = await this.options.endpoint();
    const response = await this.fetchImpl(
      `${endpoint.baseUrl}${streamUrl}?fromSeq=${String(fromSeq)}`,
      { headers: { accept: "text/event-stream", ...authHeaders(endpoint) } },
    );

    // 409 `resume_window_expired` and 404 `run_not_found` are both "this gap can never be
    // closed", so retrying would burn the budget to reach the same answer.
    if (response.status === 409 || response.status === 404) {
      await response.text();
      return "unrecoverable";
    }
    if (!response.ok || response.body === null) {
      await response.text().catch(() => "");
      return "dropped";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let expected = fromSeq;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; an incomplete tail stays buffered.
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf("\n\n");

        const frame = parseFrame(raw);
        if (frame === null) continue;

        if (frame.seq === null) {
          sink.emit(frame.chunk);
          continue;
        }
        if (frame.seq <= expected) continue;
        if (frame.seq > expected + 1) {
          await reader.cancel().catch(() => undefined);
          return "gap";
        }

        expected = frame.seq;
        sink.emit(frame.chunk);
        sink.advance(frame.seq);
        if (isTerminalLifecycle(frame.chunk)) {
          sink.terminal();
          await reader.cancel().catch(() => undefined);
          return "done";
        }
      }
    }

    // The socket closed with no terminal part. Recoverable: the Run may still be running.
    return "dropped";
  }
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);

function isTerminalLifecycle(chunk: UIMessageChunk): boolean {
  if ((chunk as { type?: string }).type !== "data-zoc-run") return false;
  const state = (chunk as { data?: { state?: unknown } }).data?.state;
  return typeof state === "string" && TERMINAL_STATES.has(state);
}

function authHeaders(endpoint: RuntimeEndpoint): Record<string, string> {
  return endpoint.token.length > 0 ? { authorization: `Bearer ${endpoint.token}` } : {};
}
