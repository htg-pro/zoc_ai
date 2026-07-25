/**
 * errors.ts — one normaliser for everything the UI might have to show a user.
 *
 * Why this exists. The chat panel used to render errors with
 * `` `Error: ${(err as Error).message}` ``. That cast is a lie: a `catch` block
 * receives `unknown`, and plenty of the things this app throws or rejects with
 * are not `Error` instances — Tauri `invoke` rejects with a plain string, a
 * `fetch` of a JSON error body yields an object, and `throw undefined` is legal
 * JavaScript. Every one of those produced the literal user-facing text
 * `Error: undefined`, and `String(err)` on an object produces the equally
 * useless `[object Object]`.
 *
 * So: nothing reaches the chat panel without passing through
 * {@link normalizeError}, which always yields
 * `{ code, message, details?, retryable? }` with a `message` fit to read.
 *
 * The normaliser also understands the gateway's structured envelope
 * (`services/gateway/src/zocai_gateway/errors.py`), including when it arrives
 * wrapped in FastAPI's `detail`, so a backend error keeps its code and its
 * human-readable sentence instead of being flattened to JSON.
 */

/** Machine-readable codes shared with the gateway's `ErrorCode`. */
export const ErrorCodes = {
  noWorkspace: "no_workspace",
  workspaceInvalid: "workspace_invalid",
  pathOutsideWorkspace: "path_outside_workspace",
  runNotFound: "run_not_found",
  runAlreadyFinished: "run_already_finished",
  runAttachFailed: "run_attach_failed",
  runCancelled: "run_cancelled",
  runFailed: "run_failed",
  cancelled: "cancelled",
  offline: "offline",
  terminalCwdInvalid: "terminal_cwd_invalid",
  terminalSpawnFailed: "terminal_spawn_failed",
  unknown: "unknown_error",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** The single error shape the UI renders and the store stores. */
export interface AppError {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
}

/** User-readable fallbacks for codes the UI can produce on its own. */
const MESSAGES: Record<string, string> = {
  [ErrorCodes.noWorkspace]:
    "No workspace is open. Open a project folder before using Agent mode.",
  [ErrorCodes.workspaceInvalid]:
    "The selected workspace folder is missing or is not a directory. Open the folder again.",
  [ErrorCodes.pathOutsideWorkspace]:
    "That path is outside the open workspace, so the action was blocked.",
  [ErrorCodes.runNotFound]:
    "The agent run ended before it could be attached. Please retry.",
  [ErrorCodes.runAlreadyFinished]: "That run has already finished.",
  [ErrorCodes.runAttachFailed]:
    "The agent run ended before it could be attached. Please retry.",
  [ErrorCodes.runCancelled]: "Stopped.",
  [ErrorCodes.runFailed]: "The run stopped because of an error. See logs for details.",
  [ErrorCodes.cancelled]: "Stopped.",
  [ErrorCodes.offline]:
    "The local agent service is not reachable. Check that the app finished starting up.",
  [ErrorCodes.terminalCwdInvalid]:
    "The terminal working directory is not inside the open workspace.",
  [ErrorCodes.terminalSpawnFailed]: "The terminal could not be started.",
  [ErrorCodes.unknown]: "Something went wrong. See logs for details.",
};

/** Bound `details` so a runaway payload cannot flood the chat panel. */
const MAX_DETAILS = 600;

function clamp(text: string): string {
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read a gateway envelope out of `value`, unwrapping FastAPI's `detail` when
 * present. Returns `null` when `value` is not an envelope.
 */
function readEnvelope(value: unknown): AppError | null {
  if (!isRecord(value)) return null;
  const source = isRecord(value.detail) ? value.detail : value;
  const code = source.code;
  const message = source.message;
  if (typeof code !== "string" || typeof message !== "string") return null;
  if (!code.trim() || !message.trim()) return null;
  const details = typeof source.details === "string" ? source.details : undefined;
  return {
    code,
    message,
    ...(details ? { details: clamp(details) } : {}),
    ...(typeof source.retryable === "boolean" ? { retryable: source.retryable } : {}),
  };
}

/**
 * Whether `value` represents a user-initiated abort rather than a failure.
 * These must never be rendered as errors — the user already knows.
 */
export function isAbort(value: unknown): boolean {
  if (typeof DOMException !== "undefined" && value instanceof DOMException) {
    return value.name === "AbortError";
  }
  return isRecord(value) && value.name === "AbortError";
}

/**
 * Turn anything at all into an {@link AppError}.
 *
 * Handles, in order: aborts, gateway envelopes (bare or wrapped in `detail`),
 * `Error` instances, strings, and finally values with no usable text — which
 * become the generic message rather than `undefined`.
 *
 * `fallbackCode` lets a call site say what kind of failure it was dealing with
 * when the thrown value carries no code of its own.
 */
export function normalizeError(
  value: unknown,
  fallbackCode: string = ErrorCodes.unknown,
): AppError {
  if (isAbort(value)) {
    return { code: ErrorCodes.cancelled, message: MESSAGES[ErrorCodes.cancelled] };
  }

  const envelope = readEnvelope(value);
  if (envelope) return envelope;

  if (value instanceof Error) {
    const text = value.message.trim();
    // An `Error` whose message is itself a JSON envelope (thrown by the JSON
    // transport after reading a response body) still carries the backend's code.
    if (text.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(text);
        const nested = readEnvelope(parsed);
        if (nested) return nested;
      } catch {
        /* not JSON after all — fall through to the plain message */
      }
    }
    if (text) {
      return { code: fallbackCode, message: text };
    }
    return { code: fallbackCode, message: MESSAGES[fallbackCode] ?? MESSAGES[ErrorCodes.unknown] };
  }

  if (typeof value === "string" && value.trim()) {
    return { code: fallbackCode, message: clamp(value.trim()) };
  }

  if (isRecord(value)) {
    const message = value.message;
    if (typeof message === "string" && message.trim()) {
      return { code: fallbackCode, message: clamp(message.trim()) };
    }
  }

  return {
    code: fallbackCode,
    message: MESSAGES[fallbackCode] ?? MESSAGES[ErrorCodes.unknown],
  };
}

/**
 * The single line shown in the chat panel.
 *
 * Deliberately just the message: internal ids and stack traces belong in
 * diagnostics, not in the primary error text (Phase 6).
 */
export function formatUserError(error: AppError): string {
  return error.message;
}

/**
 * A copyable diagnostics blob for the "copy diagnostics" affordance. Includes
 * the code and details that `formatUserError` deliberately omits.
 */
export function formatDiagnostics(error: AppError, context?: Record<string, unknown>): string {
  const lines = [`code: ${error.code}`, `message: ${error.message}`];
  if (error.details) lines.push(`details: ${error.details}`);
  if (error.retryable !== undefined) lines.push(`retryable: ${String(error.retryable)}`);
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${String(value)}`);
  }
  return lines.join("\n");
}
