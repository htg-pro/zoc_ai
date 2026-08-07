/**
 * The inline-edit (⌘K) client — zoc-agent-chat-rebuild R2.1, R6.2, R6.5, R7.8, task 22.12.
 *
 * Feature: zoc-agent-chat-rebuild, task 22.12 (R2.1, R6.2, R6.5, R7.8).
 *
 * Re-homed from `features/agent/inline-edit-client.ts`, which 26.1 deletes, and retargeted from the
 * Gateway's `POST /v1/agent/inline-edit` to the Agent_Runtime's `POST /v1/inline-edit` (9.7). Inline edit
 * is a provider inference call, so it moves off Workspace_Services for the same reason autocomplete does
 * at 22.11 (R6.2).
 *
 * ## What is carried over verbatim, and why that is the point
 *
 * {@link consumeInlineEditStream} is unchanged: ordered `token` frames, a single terminal `done` whose
 * text is the authoritative replacement, and quiet resolution on abort. It is pure — a
 * `ReadableStream<Uint8Array>` in, a string out — so it is testable without a runtime, and it is the half
 * of this module that had no reason to change. `lib/inline-edit.ts` keeps the splice, context, and patch
 * helpers; nothing here touches them.
 *
 * ## What changed
 *
 * The credential is gone from the request type as well as from the body. R7.8 puts key resolution inside
 * the runtime, and the runtime's body schema is a `z.strictObject` — so `apiKey` and `baseUrl` would not
 * merely be ignored, they would make every ⌘K a 422. Removing them from {@link InlineEditRequest} is what
 * stops a caller reintroducing one: there is no field to set.
 *
 * Unlike the completions client, HTTP failures **reject** rather than resolving quietly. ⌘K is a
 * deliberate gesture with a visible overlay, so there is somewhere to put an error and a user waiting for
 * one; autocomplete has neither.
 */

import { resolveActiveModelRequestContext } from "@/lib/active-model-context";
import { resolveRuntimeEndpoint, runtimeAuthHeaders } from "@/lib/runtime-endpoint";

/** The runtime's `POST /v1/inline-edit` body, minus the credential it resolves itself. */
export interface InlineEditRequest {
  instruction: string;
  code: string;
  prefix: string;
  suffix: string;
  language: string;
  filePath: string;
  /** Overrides the active editor model. Omitted, the current selection is used. */
  provider?: string | null;
  model?: string | null;
}

export interface StreamInlineEditOptions {
  /** Called once per `token` frame, in order, with the incremental chunk. */
  onToken?: (chunk: string) => void;
  /** Aborts the request/stream; resolves quietly with what was received. */
  signal?: AbortSignal;
}

interface SseFrame {
  event: string;
  data: string;
}

/** Index of the earliest `\n\n` / `\r\n\r\n` frame terminator, or -1. */
function nextSeparator(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Parse one raw SSE frame into its `event` name and joined `data` payload. */
function parseFrame(raw: string): SseFrame {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:"))
      dataLines.push(line.slice("data:".length).replace(/^\s/, ""));
  }
  return { event, data: dataLines.join("\n") };
}

/** Pull `text` out of a `{"text": …}` data payload; "" when absent/invalid. */
function extractText(data: string): string {
  try {
    const parsed = JSON.parse(data) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

/**
 * PURE SSE consumer. Reads `stream`, forwarding each `token` frame's text to
 * `onToken` in order, and resolves with the final replacement carried by the
 * single terminal `done` frame. Processing stops at the first `done` frame, so
 * any trailing frames after it are ignored (single-`done` handling). If no
 * `done` arrives (a truncated stream or an abort), the ordered concatenation of
 * the received tokens is returned as a fallback. Mid-stream read errors are
 * swallowed quietly, mirroring the completions client.
 */
export async function consumeInlineEditStream(
  stream: ReadableStream<Uint8Array>,
  options: StreamInlineEditOptions = {},
): Promise<string> {
  const { onToken, signal } = options;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let accumulated = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = nextSeparator(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const frame = parseFrame(raw);
        if (frame.event === "done") {
          // Single terminal: the `done` text is the authoritative replacement.
          return extractText(frame.data);
        }
        if (frame.event === "token") {
          const text = extractText(frame.data);
          if (text) {
            accumulated += text; // ordered fallback if the stream truncates
            onToken?.(text);
          }
        }
      }
    }
  } catch {
    // Abort or mid-stream network error → resolve with what we have.
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return accumulated;
}

/**
 * Stream an inline edit from the Agent_Runtime. Resolves with the final replacement.
 *
 * Aborting via `options.signal` resolves quietly with the empty string; an unreachable runtime and an
 * HTTP failure both reject, so the ⌘K overlay can say what went wrong.
 */
export async function streamInlineEdit(
  req: InlineEditRequest,
  options: StreamInlineEditOptions = {},
): Promise<string> {
  const { signal } = options;
  if (signal?.aborted) return "";

  let runtime: Awaited<ReturnType<typeof resolveRuntimeEndpoint>>;
  let activeModel: Awaited<ReturnType<typeof resolveActiveModelRequestContext>>;
  try {
    [runtime, activeModel] = await Promise.all([
      resolveRuntimeEndpoint(signal),
      resolveActiveModelRequestContext(),
    ]);
  } catch (err) {
    if (signal?.aborted) return "";
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (signal?.aborted) return "";

  let res: Response;
  try {
    res = await fetch(`${runtime.baseUrl}/v1/inline-edit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...runtimeAuthHeaders(runtime),
      },
      // Field by field, and the model selection only. `activeModel` also carries `apiKey` and
      // `baseUrl` — it is shared with the completions client and predates the split — so a spread
      // here would put a credential on the wire and get the whole request rejected (R7.8).
      body: JSON.stringify({
        instruction: req.instruction,
        code: req.code,
        prefix: req.prefix,
        suffix: req.suffix,
        language: req.language,
        filePath: req.filePath,
        provider: req.provider ?? activeModel.provider,
        model: req.model ?? activeModel.model,
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return ""; // discarded → quiet
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!res.ok || !res.body) {
    throw new Error(`inline-edit request failed (HTTP ${res.status})`);
  }
  return consumeInlineEditStream(res.body, options);
}
