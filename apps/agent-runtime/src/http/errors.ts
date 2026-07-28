/**
 * Agent_Runtime error envelope — zoc-agent-chat-rebuild R7.5, R9.8, R16.6.
 *
 * One shape for every failure the runtime can report, whether it leaves as an
 * HTTP body or as a streamed `ErrorPart`. It is the Gateway's four-field
 * envelope verbatim, so the Chat_Surface needs exactly one normaliser for
 * Workspace_Services HTTP errors, Agent_Runtime HTTP errors, and stream parts.
 *
 * Two invariants are enforced here rather than trusted at each call site,
 * because "remember not to interpolate the path" is not a guarantee:
 *
 *   - `message` is a human sentence. No run id, no filesystem path, no
 *     credential, no type name. It is what a user reads.
 *   - `details` is bounded to 600 characters and is never a raw provider body.
 *     A provider that answers with a 40 kB HTML error page must not turn into a
 *     40 kB transcript row.
 */

/** Hard ceiling on `details` (R9.8). */
export const DETAILS_LIMIT = 600;

/**
 * The Zoc code set. Codes are stable strings, not an enum, because they cross
 * the wire and are matched by the surface; renaming one is a wire change.
 */
export const ErrorCode = {
  // ── Admission and transport ──────────────────────────────────────────
  REMOTE_REFUSED: "remote_refused",
  UNAUTHORIZED: "unauthorized",
  /**
   * The schema class (R7.5). The literal is `invalid_request` rather than a
   * Node-side invention because `errors.py` already answers with that string,
   * and one code per class is what lets the renderer keep a single normaliser
   * across Workspace_Services, the runtime's HTTP errors, and stream parts.
   */
  INVALID_REQUEST: "invalid_request",
  NOT_FOUND: "not_found",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  INTERNAL: "internal",

  // ── Run lifecycle ────────────────────────────────────────────────────
  RUN_NOT_FOUND: "run_not_found",
  RESUME_WINDOW_EXPIRED: "resume_window_expired",
  STREAM_LOST: "stream_lost",
  CANCELLED: "cancelled",
  RUNTIME_UNAVAILABLE: "runtime_unavailable",
  SLOT_QUEUE_FULL: "slot_queue_full",

  // ── Policy and permission ────────────────────────────────────────────
  MODE_NOT_PERMITTED: "mode_not_permitted",
  PERMISSION_DENIED: "permission_denied",
  PERMISSION_TIMEOUT: "permission_timeout",
  ALREADY_DECIDED: "already_decided",
  DECISION_WINDOW_EXPIRED: "decision_window_expired",

  // ── Tools and plan ───────────────────────────────────────────────────
  TOOL_SCHEMA_INVALID: "tool_schema_invalid",
  PLAN_INVALID: "plan_invalid",
  WORKSPACE_UNAVAILABLE: "workspace_unavailable",
  HUNK_STALE: "hunk_stale",

  // ── Provider ─────────────────────────────────────────────────────────
  PROVIDER_AUTH_FAILED: "provider_auth_failed",
  PROVIDER_RATE_LIMITED: "provider_rate_limited",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  PROVIDER_TIMEOUT: "provider_timeout",
  CONTEXT_LENGTH_EXCEEDED: "context_length_exceeded",
  CONTENT_FILTERED: "content_filtered",
  MODEL_NOT_FOUND: "model_not_found",
  NO_KEY_CONFIGURED: "no_key_configured",

  // ── Compaction ───────────────────────────────────────────────────────
  COMPACTION_FAILED: "compaction_failed",
} as const;

export type ZocErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly details: string | null;
  readonly retryable: boolean;
}

/** Clamp `details` and normalise the empty case to `null`. */
export function boundDetails(details: unknown): string | null {
  if (details === null || details === undefined) return null;
  const text = typeof details === "string" ? details : safeStringify(details);
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= DETAILS_LIMIT
    ? trimmed
    : `${trimmed.slice(0, DETAILS_LIMIT - 1)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function envelope(
  code: string,
  message: string,
  options: { details?: unknown; retryable?: boolean } = {},
): ErrorEnvelope {
  return Object.freeze({
    code,
    message,
    details: boundDetails(options.details),
    retryable: options.retryable ?? false,
  });
}

/**
 * A failure that already knows its HTTP status and envelope.
 *
 * Throwing this from a route handler is the only sanctioned way to produce a
 * non-2xx body, so no handler has to remember the envelope shape.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly envelope: ErrorEnvelope;

  constructor(status: number, env: ErrorEnvelope) {
    super(env.message);
    this.name = "HttpError";
    this.status = status;
    this.envelope = env;
  }

  static badRequest(code: string, message: string, details?: unknown): HttpError {
    return new HttpError(400, envelope(code, message, { details }));
  }

  static unprocessable(message: string, details?: unknown): HttpError {
    return new HttpError(
      422,
      envelope(ErrorCode.INVALID_REQUEST, message, { details, retryable: false }),
    );
  }

  static notFound(code: string, message: string): HttpError {
    return new HttpError(404, envelope(code, message));
  }

  static conflict(code: string, message: string): HttpError {
    return new HttpError(409, envelope(code, message));
  }

  static gone(code: string, message: string): HttpError {
    return new HttpError(410, envelope(code, message));
  }
}
