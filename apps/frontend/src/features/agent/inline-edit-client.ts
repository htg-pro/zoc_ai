/**
 * Streaming inline-edit (⌘K) client — Part 8.2.
 *
 * Mirrors `lib/completions-client.ts`: an abortable `fetch` POST to the Gateway
 * `POST /v1/agent/inline-edit` (resolving the loopback port the same way) that
 * parses the Server-Sent Events stream. Each `event: token` (`{"text": …}`) is
 * forwarded to `onToken` in order; the stream ends with exactly one
 * `event: done` (`{"text": …}`) whose text is the final, fence-stripped
 * replacement the promise resolves with.
 *
 * The SSE parsing is factored into the pure {@link consumeInlineEditStream}
 * (a `ReadableStream<Uint8Array>` → replacement string) so it is unit-testable
 * without a live Gateway or `fetch`.
 */

import { resolveAgentPort } from "@/lib/agent-port";
import { resolveActiveModelRequestContext } from "@/lib/active-model-context";

/** camelCase JSON body accepted by `POST /v1/agent/inline-edit`. */
export interface InlineEditRequest {
  instruction: string;
  code: string;
  prefix: string;
  suffix: string;
  language: string;
  filePath: string;
  provider?: string | null;
  model?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
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
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^\s/, ""));
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
 * Stream an inline edit from the Gateway. Resolves with the final replacement.
 * Aborting via `options.signal` resolves quietly; network/HTTP failures reject
 * so the ⌘K overlay can surface the error.
 */
export async function streamInlineEdit(
  req: InlineEditRequest,
  options: StreamInlineEditOptions = {},
): Promise<string> {
  const { signal } = options;
  if (signal?.aborted) return "";

  let port: number;
  let activeModel: Awaited<ReturnType<typeof resolveActiveModelRequestContext>>;
  try {
    [port, activeModel] = await Promise.all([
      resolveAgentPort(),
      resolveActiveModelRequestContext(),
    ]);
  } catch (err) {
    if (signal?.aborted) return "";
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (signal?.aborted) return "";

  const modelContext = {
    provider: req.provider ?? activeModel.provider,
    model: req.model ?? activeModel.model,
    apiKey: req.apiKey ?? activeModel.apiKey,
    baseUrl: req.baseUrl ?? activeModel.baseUrl,
  };

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/agent/inline-edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        instruction: req.instruction,
        code: req.code,
        prefix: req.prefix,
        suffix: req.suffix,
        language: req.language,
        filePath: req.filePath,
        ...modelContext,
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
