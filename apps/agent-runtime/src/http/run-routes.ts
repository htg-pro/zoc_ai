/**
 * The three Run routes — zoc-agent-chat-rebuild R5.1, R16.1, R16.3, R16.4, 9.7.
 *
 * ```
 * POST /v1/runs                        → 200 { runId, streamUrl, queuePosition }
 *                                      → 422 { code: "invalid_request" }
 *                                      → 429 { code: "slot_queue_full" }
 * GET  /v1/runs/:id/stream?fromSeq=n   → 200 text/event-stream, replay then live
 *                                      → 404 { code: "run_not_found" }
 *                                      → 409 { code: "resume_window_expired" }
 * POST /v1/runs/:id/cancel             → 202 { accepted: true }
 *                                      → 404 { code: "run_not_found" }
 * ```
 *
 * **No `api_key` field on the submit body, by construction (R7.8).** The schema is
 * closed, so a client that sends one is rejected rather than quietly obeyed — which
 * is the difference between a credential that cannot travel this path and one that
 * merely usually does not.
 *
 * **Two seams, and the reason there are two.** {@link RunRoutesDeps.plan} resolves
 * the request's model reference and can fail; the {@link OpenRunStream} it returns
 * opens the stream and cannot be reached until the Run is admitted. The split is
 * where the difference between "this request is wrong" and "this Run has not
 * started yet" lives: a missing key or an unknown provider is a 4xx the caller must
 * read *now*, whereas reading history and dispatching to the provider must not
 * happen for a Run sitting fourth in the queue.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { RunManager, OpenRunStream } from "../agent/run-driver.ts";
import { SlotQueueFullError } from "../agent/run-store.ts";
import { SSE_HEADERS, encodeSseFrame } from "../agent/writer.ts";
import { ErrorCode, HttpError, envelope } from "./errors.ts";
import { json, type Router } from "./routes.ts";
import { readJsonBody, validate } from "./validate.ts";

/** How often an idle stream is nudged so an intermediary does not reap it. */
export const KEEPALIVE_MS = 15_000;

/**
 * A mention as it arrives on the wire.
 *
 * Four kinds, matching R12.1's four autocomplete categories. `ref` is the resolved
 * reference R12.3 requires the surface to attach — a workspace-relative path, a
 * symbol's qualified name, a terminal buffer id, a doc url — and it is what the
 * runtime resolves against the workspace. `content` is optional because the
 * surface sometimes already holds the text (a terminal selection has no path to
 * re-read), and unresolved chips never arrive at all: R12.7 excludes them from the
 * request, so anything here is expected to resolve.
 */
const mentionSchema = z.object({
  kind: z.enum(["file", "symbol", "terminal", "doc"]),
  ref: z.string().min(1).max(4096),
  label: z.string().min(1).max(512).optional(),
  content: z.string().max(1_000_000).optional(),
});

export type MentionRef = z.infer<typeof mentionSchema>;

const modelRefSchema = z.object({
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  baseUrl: z.string().max(2048).nullish(),
});

/**
 * `strictObject`, so an unknown field is a 422 rather than a shrug.
 *
 * This is where R7.8 is enforced rather than merely intended: `api_key` has no
 * member here, and a closed schema turns "the runtime ignores it" into "the
 * runtime refuses it". The two are indistinguishable to a correct client and very
 * different to a client that has started leaking a credential into a request body.
 */
const runBodySchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  prompt: z.string().min(1).max(200_000),
  mentions: z.array(mentionSchema).max(200).default([]),
  mode: z.enum(["ask", "plan", "agent"]),
  permissionMode: z.enum(["ask", "auto", "deny"]),
  modelRef: modelRefSchema,
});

export type RunRequest = z.infer<typeof runBodySchema>;

/** What `plan` resolved, plus the deferred dispatch. */
export interface RunPlan {
  /** A `providers/registry.ts` provider id, recorded on the Run. */
  readonly provider: string;
  readonly model: string;
  /** Opens the Run's chunk stream once a Slot is held. Normally `streamRun`. */
  readonly open: OpenRunStream;
}

export interface RunRoutesDeps {
  readonly manager: RunManager;
  /**
   * Resolve a submitted request into a dispatchable plan.
   *
   * Throws `HttpError` for anything the caller can fix — `no_key_configured`,
   * `model_not_found`, a non-loopback local endpoint. Nothing here is caught, so
   * those reach the client with their own status and code.
   */
  plan(request: RunRequest): Promise<RunPlan>;
  newRunId?(): string;
  newMessageId?(): string;
  keepaliveMs?: number;
}

/** `fromSeq` must be a whole number of parts already seen; nothing else parses. */
function parseFromSeq(raw: string | null): number {
  if (raw === null || raw.length === 0) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(
      422,
      envelope(ErrorCode.INVALID_REQUEST, "The resume position was not in the expected shape.", {
        details: "fromSeq: expected a non-negative integer",
        retryable: false,
      }),
    );
  }
  return value;
}

export function registerRunRoutes(router: Router, deps: RunRoutesDeps): void {
  const newRunId = deps.newRunId ?? (() => `run_${randomUUID()}`);
  const newMessageId = deps.newMessageId ?? (() => `msg_${randomUUID()}`);
  const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS;

  router.post("/v1/runs", async ({ req, res }) => {
    const body = validate(runBodySchema, await readJsonBody(req), "run request");
    const plan = await deps.plan(body);

    const runId = newRunId();
    const messageId = newMessageId();

    let admitted;
    try {
      admitted = deps.manager.submit({
        runId,
        messageId,
        sessionId: body.sessionId,
        provider: plan.provider,
        model: plan.model,
        conversationMode: body.mode,
        permissionMode: body.permissionMode,
        open: plan.open,
      });
    } catch (error) {
      if (error instanceof SlotQueueFullError) {
        // 429 rather than 503: the runtime is working exactly as configured and the
        // request is refused because of load, which is the one case where a client
        // backing off and retrying is the correct response rather than a guess.
        throw new HttpError(
          429,
          envelope(
            ErrorCode.SLOT_QUEUE_FULL,
            "Too many runs are already waiting. Let one finish and try again.",
            { retryable: true },
          ),
        );
      }
      throw error;
    }

    json(res, 200, {
      runId,
      streamUrl: `/v1/runs/${encodeURIComponent(runId)}/stream`,
      queuePosition: admitted.queuePosition,
    });
  });

  /**
   * Replay, then live (R16.3).
   *
   * **Nothing between the replay and the subscription may await.** `frame()`
   * appends to the ring and broadcasts to readers in one synchronous step, and it
   * is only ever reached from the driver's `await reader.read()` loop — so as long
   * as this handler holds the thread from `replayFrom` through the last replayed
   * frame and the `subscribe` call, no chunk can be emitted in the window between
   * them. One `await` in that span reopens it, and the symptom would be a single
   * missing `seq` under load, which the client reads as a gap and answers with a
   * re-attach: self-healing, silent, and permanent.
   */
  router.get("/v1/runs/:id/stream", ({ req, res, params, query }) => {
    const runId = params.id as string;
    const fromSeq = parseFromSeq(query.get("fromSeq"));

    const record = deps.manager.record(runId);
    if (record === null) {
      throw HttpError.notFound(
        ErrorCode.RUN_NOT_FOUND,
        "That run is no longer available to follow.",
      );
    }

    const replay = record.replayFrom(fromSeq);
    if (!replay.ok) {
      throw HttpError.conflict(
        ErrorCode.RESUME_WINDOW_EXPIRED,
        "Too much of this run has scrolled past to reconnect to it cleanly.",
      );
    }

    res.writeHead(200, SSE_HEADERS);
    for (const entry of replay.chunks) {
      res.write(encodeSseFrame(entry.seq, entry.chunk));
    }

    // A Run that has already finished has nothing left to stream; the replay above
    // *is* its whole transcript. Ending here rather than holding the socket open is
    // what makes a reconnect after the Run completed terminate instead of hanging.
    if (record.finished) {
      res.end();
      return;
    }

    let open = true;
    const unsubscribe = record.subscribe((frame) => {
      if (!open) return false;
      // `write` returning false is backpressure, not failure: the socket is alive
      // and Node buffers. Reaping on it would drop a reader mid-Run precisely when
      // that reader is slowest, which is when it can least afford a re-attach.
      res.write(frame);
      return true;
    });

    const keepalive = setInterval(() => {
      if (open) record.keepalive();
    }, keepaliveMs);
    keepalive.unref?.();

    const detach = (): void => {
      if (!open) return;
      open = false;
      clearInterval(keepalive);
      unsubscribe();
    };

    // Either end can go first: the client navigates away, or the Run settles.
    req.on("close", detach);
    res.on("close", detach);
    const driver = deps.manager.driver(runId);
    if (driver === null) {
      detach();
      res.end();
      return;
    }
    void driver.settled.then(() => {
      detach();
      res.end();
    });
  });

  /**
   * Cancel (R16.1).
   *
   * `202`, not `200`, and not "when it stopped": the runtime has accepted the
   * request, and the Run stops within the grace. The outcome travels as a part on
   * the stream the caller is already reading, which is the only channel that can
   * report *which* tools were abandoned.
   *
   * A Run that has already settled answers `202` as well. Cancel is idempotent, and
   * the alternative — a 404 or a 409 for a Run that finished a moment before the
   * click landed — would make the stop button report an error for a race it won.
   */
  router.post("/v1/runs/:id/cancel", ({ res, params }) => {
    const runId = params.id as string;
    if (deps.manager.record(runId) === null) {
      throw HttpError.notFound(
        ErrorCode.RUN_NOT_FOUND,
        "That run is no longer available to cancel.",
      );
    }
    deps.manager.cancel(runId);
    json(res, 202, { accepted: true });
  });
}
