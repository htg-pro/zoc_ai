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
  // Shared with the Gateway (errors.py) and the Desktop git guard (git.rs).
  modelNotReady: "model_not_ready",
  modelUnavailable: "model_unavailable",
  contextWindowExceeded: "context_window_exceeded",
  workspaceRebound: "workspace_rebound",
  gitNotARepository: "git_not_a_repository",
  gitCommandFailed: "git_command_failed",
  unknown: "unknown_error",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** The single error shape the UI renders and the store stores. */
export interface AppError {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
  /**
   * The HTTP status the gateway replied with, when the error originated from a
   * `GatewayRequestError`. Retained so a provider-authentication failure
   * (401/403) can be recognized and the offending provider marked invalid
   * without re-parsing the message (R4.5, R13.x).
   */
  status?: number;
}

/** HTTP statuses that mean "the provider rejected our credentials" (R4.5). */
export const AUTH_STATUSES: readonly number[] = [401, 403];

/** Provider-side error codes that also mean the credentials are invalid. */
const AUTH_CODES: ReadonlySet<string> = new Set([
  "authentication_error",
  "invalid_api_key",
  "unauthorized",
  "forbidden",
  "permission_denied",
]);

/**
 * Whether an error represents a provider-credential rejection — an HTTP
 * 401/403 or a recognized auth code. Used to mark exactly the failing provider
 * invalid on a run/request/stream (R4.5, R13.x) without touching others.
 */
export function isAuthError(
  error: { status?: number; code?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (typeof error.status === "number" && AUTH_STATUSES.includes(error.status)) {
    return true;
  }
  return typeof error.code === "string" && AUTH_CODES.has(error.code);
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
  [ErrorCodes.modelNotReady]:
    "The selected model isn't ready yet. Load it, then try again.",
  [ErrorCodes.modelUnavailable]:
    "The model provider is unavailable right now. Try again in a moment.",
  [ErrorCodes.contextWindowExceeded]:
    "The request is too large for this model's context window. Reduce attached context or increase the model context window in Settings, then retry.",
  [ErrorCodes.workspaceRebound]:
    "The workspace changed while the run was starting. Try again.",
  [ErrorCodes.gitNotARepository]:
    "This folder isn't a Git repository, so version-control actions are unavailable.",
  [ErrorCodes.gitCommandFailed]:
    "A Git command failed. See the Logs panel for details.",
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
 * Convert a possibly historical provider error into safe primary-surface copy.
 * Older diary/SSE records may still contain llama.cpp's escaped HTTP body; the
 * primary UI must never render that provider JSON verbatim.
 */
export function sanitizeErrorForDisplay(
  code: string,
  message: unknown,
): Pick<AppError, "code" | "message"> {
  const text = typeof message === "string" ? message.trim() : "";
  const looksLikeContextOverflow =
    code === ErrorCodes.contextWindowExceeded ||
    /exceed_context_size_error/i.test(text) ||
    (/n_prompt_tokens/i.test(text) && /\bn_ctx\b/i.test(text));

  if (looksLikeContextOverflow) {
    const promptTokens = text.match(/n_prompt_tokens[^0-9]{0,32}(\d+)/i)?.[1];
    const contextTokens = text.match(/\bn_ctx\b[^0-9]{0,32}(\d+)/i)?.[1];
    const counts =
      promptTokens && contextTokens
        ? `The request needs ${Number(promptTokens).toLocaleString()} tokens, but this model supports ${Number(contextTokens).toLocaleString()}. `
        : "";
    return {
      code: ErrorCodes.contextWindowExceeded,
      message: `${counts}Reduce attached context or increase the model context window in Settings, then retry.`,
    };
  }

  return {
    code: code.trim() || ErrorCodes.unknown,
    message: text
      ? clamp(text)
      : MESSAGES[code] ?? MESSAGES[ErrorCodes.unknown],
  };
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
  const safe = sanitizeErrorForDisplay(code, message);
  const details = typeof source.details === "string" ? source.details : undefined;
  // `GatewayRequestError` carries the HTTP status on the instance itself
  // (source === value here); a bare gateway envelope has no status. Preserve it
  // when present so auth (401/403) failures stay recognizable downstream.
  const statusValue =
    typeof source.status === "number"
      ? source.status
      : typeof (value as { status?: unknown }).status === "number"
        ? (value as { status: number }).status
        : undefined;
  return {
    code: safe.code,
    message: safe.message,
    ...(details ? { details: clamp(details) } : {}),
    ...(typeof source.retryable === "boolean" ? { retryable: source.retryable } : {}),
    ...(statusValue !== undefined ? { status: statusValue } : {}),
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
 * Map the Desktop git guard's typed error (`git.rs` `GitError`, serialized with
 * a kebab-case `kind`) onto an {@link AppError} carrying the shared code. Returns
 * `null` when `value` is not a recognizable `GitError`. `command-failed` carries
 * its stderr in `details` (destined for the Logs panel, never the chat feed).
 */
export function gitErrorToAppError(value: unknown): AppError | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "not-a-repository":
      return {
        code: ErrorCodes.gitNotARepository,
        message: MESSAGES[ErrorCodes.gitNotARepository],
      };
    case "no-workspace":
      return { code: ErrorCodes.noWorkspace, message: MESSAGES[ErrorCodes.noWorkspace] };
    case "command-failed": {
      const subcommand = typeof value.subcommand === "string" ? value.subcommand : "";
      const output = typeof value.output === "string" ? value.output : "";
      const detail = `${subcommand ? `git ${subcommand}: ` : ""}${output}`.trim();
      return {
        code: ErrorCodes.gitCommandFailed,
        message: MESSAGES[ErrorCodes.gitCommandFailed],
        ...(detail ? { details: clamp(detail) } : {}),
      };
    }
    case "git-unavailable": {
      const detail = typeof value.detail === "string" ? value.detail : "";
      return {
        code: ErrorCodes.gitCommandFailed,
        message: MESSAGES[ErrorCodes.gitCommandFailed],
        ...(detail ? { details: clamp(detail) } : {}),
      };
    }
    default:
      return null;
  }
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
      return sanitizeErrorForDisplay(fallbackCode, text);
    }
    return { code: fallbackCode, message: MESSAGES[fallbackCode] ?? MESSAGES[ErrorCodes.unknown] };
  }

  if (typeof value === "string" && value.trim()) {
    return sanitizeErrorForDisplay(fallbackCode, value);
  }

  if (isRecord(value)) {
    const message = value.message;
    if (typeof message === "string" && message.trim()) {
      return sanitizeErrorForDisplay(fallbackCode, message);
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
