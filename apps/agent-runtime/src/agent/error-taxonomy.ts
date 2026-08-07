/**
 * The provider-failure mapping — zoc-agent-chat-rebuild R7.5, R13.7, R16.6, 9.8.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.8 (R7.5, R13.7, R16.6).
 *
 * One function, called at one place: the Run's stream boundary. Every AI SDK error,
 * every provider HTTP status, and every network failure becomes one of the codes in
 * the design's runtime-owned table, with a human sentence and bounded developer
 * detail. The Gateway's four-field envelope is adopted verbatim, so the surface
 * needs one normaliser for Workspace_Services HTTP errors, Agent_Runtime HTTP
 * errors, and streamed error parts rather than three.
 *
 * **Two invariants, enforced here rather than trusted at each arm.**
 *
 *   - `message` is a sentence a user reads. No run id, no path, no key, no
 *     `AI_APICallError`, no provider body. The arms below build messages from a
 *     fixed vocabulary plus a provider *label*, never from the error's own text.
 *   - `details` is developer text bounded to 600 characters and **never a raw
 *     provider body**. That is not fastidiousness: a provider error body commonly
 *     echoes the request it rejected, and the request carried the key. So the arms
 *     compose `details` out of the status code and parsed numbers, and
 *     `error.responseBody` is read only to *match patterns against* — never to
 *     forward.
 *
 * **The errors are recognised through the SDK's own `isInstance` guards.** `ai`
 * re-exports `APICallError`, `NoSuchModelError`, `TypeValidationError`,
 * `InvalidToolInputError`, `NoSuchToolError`, and `LoadAPIKeyError`, and each
 * carries a branded symbol its static guard checks. Sniffing `error.name` would
 * pass for a hand-rolled object with the right string and fail across a duplicated
 * copy of the package; the guards do neither.
 */

import {
  APICallError,
  InvalidToolInputError,
  LoadAPIKeyError,
  NoSuchModelError,
  NoSuchToolError,
  TypeValidationError,
} from "ai";

import { ErrorCode, boundDetails } from "../http/errors.ts";

/** The envelope, minus the HTTP status an `HttpError` would add. */
export interface ZocFailure {
  readonly code: string;
  readonly message: string;
  readonly details: string | null;
  readonly retryable: boolean;
}

/**
 * Context-overflow patterns.
 *
 * The first three alternatives are `model_runtime.py`'s `_context_window_error`
 * verbatim, so llama.cpp's overflow message maps identically on both sides — which
 * is the point of reusing them rather than writing new ones. The last two are
 * **additions**, and they are additions rather than a rewrite because the Python set
 * only ever had to recognise llama.cpp: OpenAI answers an overflow with `400
 * context_length_exceeded` and the sentence "maximum context length is N tokens",
 * neither of which matches the first three, so without them a cloud overflow lands
 * in the generic 4xx arm and the surface offers no "remove largest attachment"
 * action for the one failure that action exists for (R12.6).
 */
const CONTEXT_OVERFLOW_RE =
  /exceed_context_size_error|exceeds? the available context size|context window.*exceed|context_length_exceeded|maximum context length/i;

/** llama.cpp reports both numbers, escaped or not, depending on the layer. */
const PROMPT_TOKENS_RE = /n_prompt_tokens\\?"?\s*:\s*(\d+)/i;
const CONTEXT_SIZE_RE = /n_ctx\\?"?\s*:\s*(\d+)/i;

/** llama-server while the weights are still loading (R13.6). */
const LOADING_RE = /loading model|model is loading|not (?:yet )?loaded/i;

/** A provider declining to answer on policy grounds. */
const CONTENT_FILTER_RE = /content[_ -]?filter|content policy|safety (?:system|filter)|refusal/i;

/** Connection-level failures, by the code Node puts on the cause. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** What the classifier is allowed to name in a sentence. */
export interface FailureSubject {
  /** A display label — "OpenAI", "Local (llama.cpp)". Never an id or a URL. */
  readonly provider?: string | null;
  /** The model the user picked. Safe to name: they chose it and can see it. */
  readonly model?: string | null;
  /** True when the Run was cancelled, so an abort is not reported as a failure. */
  readonly cancelled?: boolean;
}

/** Walk `cause` chains, which is where `fetch` puts the interesting part. */
function causes(error: unknown, depth = 6): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let step = 0; step < depth && current !== null && current !== undefined; step += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function errnoOf(error: unknown): string | null {
  for (const link of causes(error)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

function nameOf(error: unknown): string {
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

/**
 * Whether this is our own `AbortController` firing.
 *
 * Checked before everything else. A cancel that lands mid-request surfaces as an
 * abort *and*, on some providers, as a socket error a moment later — and a Run the
 * user stopped is not a Run that failed, so the first reading wins.
 */
export function isAbortFailure(error: unknown): boolean {
  return causes(error).some((link) => {
    const name = nameOf(link);
    return name === "AbortError" || name === "TimeoutError" || errnoOf(link) === "ABORT_ERR";
  });
}

/** The text an `APICallError` carries, for pattern matching only — never forwarded. */
function haystackOf(error: APICallError): string {
  const data = error.data === undefined ? "" : safeText(error.data);
  return `${error.message}\n${error.responseBody ?? ""}\n${data}`;
}

function safeText(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function retryAfterPresent(error: APICallError): boolean {
  const headers = error.responseHeaders ?? {};
  return Object.keys(headers).some((name) => name.toLowerCase() === "retry-after");
}

function label(subject: FailureSubject): string {
  const provider = subject.provider?.trim();
  return provider === undefined || provider.length === 0 ? "The model provider" : provider;
}

/**
 * Map one failure onto the Zoc code set.
 *
 * Arms are ordered by specificity, not by likelihood, and the order is the contract:
 * an abort outranks everything, a context overflow outranks the 400 it arrives as,
 * and a loopback connection refusal outranks the generic network arm because
 * "start your local model" is a different instruction from "the provider is down".
 */
export function classifyRunError(error: unknown, subject: FailureSubject = {}): ZocFailure {
  if (isAbortFailure(error) || subject.cancelled === true) {
    return {
      code: ErrorCode.RUN_CANCELLED,
      message: "Run cancelled.",
      details: null,
      retryable: false,
    };
  }

  if (APICallError.isInstance(error)) return fromApiCall(error, subject);
  if (NoSuchModelError.isInstance(error)) {
    return {
      code: ErrorCode.MODEL_UNAVAILABLE,
      message: `${label(subject)} does not offer that model. Pick another in the model picker.`,
      details: boundDetails(subject.model ?? null),
      retryable: true,
    };
  }
  if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) {
    return {
      code: ErrorCode.TOOL_SCHEMA_INVALID,
      // Non-fatal by design: the model usually corrects itself on the next step, so
      // the sentence says what happened without suggesting the Run is over.
      message: "The model called a tool incorrectly. It will usually correct itself.",
      details: null,
      retryable: false,
    };
  }
  if (TypeValidationError.isInstance(error)) {
    return {
      code: ErrorCode.PLAN_INVALID,
      message: "The model's plan did not match the expected shape, so it was rejected.",
      details: null,
      retryable: true,
    };
  }
  if (LoadAPIKeyError.isInstance(error)) {
    return {
      code: ErrorCode.NO_KEY_CONFIGURED,
      message: `${label(subject)} needs an API key before it can be used. Add one in Settings.`,
      details: null,
      retryable: false,
    };
  }

  const errno = errnoOf(error);
  if (errno !== null && TIMEOUT_CODES.has(errno)) {
    return {
      code: ErrorCode.MODEL_UNAVAILABLE,
      message: `${label(subject)} did not answer in time.`,
      details: boundDetails(errno),
      retryable: true,
    };
  }
  if (errno !== null && UNREACHABLE_CODES.has(errno)) {
    return {
      code: ErrorCode.MODEL_UNAVAILABLE,
      message: `${label(subject)} could not be reached.`,
      details: boundDetails(errno),
      retryable: true,
    };
  }

  return {
    code: ErrorCode.INTERNAL,
    message: "The agent runtime hit an unexpected error.",
    // The thrown message is withheld on purpose: an arbitrary throw is the one case
    // where nothing is known about what the string contains, and R9.8's rule is not
    // "usually safe".
    details: null,
    retryable: false,
  };
}

function fromApiCall(error: APICallError, subject: FailureSubject): ZocFailure {
  const status = error.statusCode;
  const haystack = haystackOf(error);
  const provider = label(subject);

  // Before the status arms: an overflow arrives as a 400 from OpenAI and a 500 from
  // llama.cpp, so classifying on status first would split one failure into two codes
  // and neither would be the one R12.6's action is bound to.
  if (CONTEXT_OVERFLOW_RE.test(haystack)) return contextOverflow(haystack);

  if (status === 401 || status === 403) {
    return {
      code: ErrorCode.PROVIDER_AUTH_FAILED,
      // R13.7: the key the user entered is left in place, so the sentence asks them
      // to check it rather than telling them it has been discarded.
      message: `${provider} rejected the API key. Check it in Settings.`,
      details: boundDetails(`HTTP ${status}`),
      retryable: false,
    };
  }

  if (status === 429 || retryAfterPresent(error)) {
    return {
      code: ErrorCode.PROVIDER_RATE_LIMITED,
      message: `${provider} is rate limiting this key. Try again shortly.`,
      details: boundDetails(status === undefined ? "retry-after" : `HTTP ${status}`),
      retryable: true,
    };
  }

  if (CONTENT_FILTER_RE.test(haystack)) {
    return {
      code: ErrorCode.PROVIDER_CONTENT_FILTERED,
      message: `${provider} declined to answer this request.`,
      details: null,
      retryable: false,
    };
  }

  if (status === 503 && LOADING_RE.test(haystack)) {
    return {
      code: ErrorCode.MODEL_NOT_READY,
      message: "The local model is still loading. It will be ready shortly.",
      details: null,
      retryable: true,
    };
  }

  const errno = errnoOf(error);
  if (
    (status === undefined || status === 0) &&
    errno !== null &&
    UNREACHABLE_CODES.has(errno) &&
    isLoopback(error.url)
  ) {
    return {
      code: ErrorCode.LOCAL_ENDPOINT_UNREACHABLE,
      // A different instruction from "the provider is down", which is why this arm
      // outranks the generic network one: the user can fix this one themselves.
      message: "The local model server is not running. Start it, then try again.",
      details: boundDetails(errno),
      retryable: true,
    };
  }

  if (status === undefined || status >= 500) {
    return {
      code: ErrorCode.MODEL_UNAVAILABLE,
      message: `${provider} is not answering right now.`,
      details: boundDetails(status === undefined ? (errno ?? "network error") : `HTTP ${status}`),
      retryable: true,
    };
  }

  // A remaining 4xx is a request the provider rejected on its merits, and the same
  // request will be rejected again — so `retryable` is false and the code says the
  // request was the problem rather than the model.
  return {
    code: ErrorCode.INVALID_REQUEST,
    message: `${provider} rejected the request.`,
    details: boundDetails(`HTTP ${status}`),
    retryable: false,
  };
}

/**
 * The overflow message, with the two numbers when llama.cpp reported them.
 *
 * Ported from `ModelContextWindowError`, including the deliberate omission: the
 * provider body is parsed for the counts and then discarded, because retaining it
 * would put escaped JSON — and whatever of the request it quoted — into the
 * transcript.
 */
function contextOverflow(haystack: string): ZocFailure {
  const promptTokens = Number(PROMPT_TOKENS_RE.exec(haystack)?.[1] ?? Number.NaN);
  const contextTokens = Number(CONTEXT_SIZE_RE.exec(haystack)?.[1] ?? Number.NaN);
  const known = Number.isFinite(promptTokens) && Number.isFinite(contextTokens);

  return {
    code: ErrorCode.CONTEXT_WINDOW_EXCEEDED,
    message: known
      ? `This request needs ${promptTokens.toLocaleString("en-US")} tokens, but the model ` +
        `allows ${contextTokens.toLocaleString("en-US")}. Remove some attached context and retry.`
      : "This request is too large for the model's context window. Remove some " +
        "attached context and retry.",
    details: known ? boundDetails(`prompt ${promptTokens}, limit ${contextTokens}`) : null,
    // Retryable *after trimming*, which is what R12.6's "remove largest attachment"
    // action does. A bare retry of the same request fails identically, so the flag is
    // an invitation to the action rather than to the button.
    retryable: true,
  };
}

/**
 * A classifier bound to one Run's provider and model.
 *
 * The seam `streamRun` consumes is `(error) => …` with no second argument, and the
 * provider label is exactly what R13.7's "card naming the provider" needs, so it is
 * bound once when the Run is built rather than threaded through every call site.
 */
export function createRunErrorClassifier(subject: FailureSubject): (error: unknown) => ZocFailure {
  return (error) => classifyRunError(error, subject);
}
