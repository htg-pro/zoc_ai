/**
 * Streaming completions client — zoc-agent-chat-rebuild R2.1, R6.2, R6.5, R7.8, task 22.11.
 *
 * An abortable `fetch` POST to the **Agent_Runtime**'s `POST /v1/completions`, resolving the endpoint
 * and the per-launch bearer token through `runtime-endpoint.ts` (3.3). It parses the Server-Sent Events
 * stream, forwarding each `event: token` chunk (`{"text": …}`) to `onToken` and resolving on the distinct
 * `event: done` terminal. Network errors and aborts are swallowed quietly so an unavailable runtime never
 * interrupts typing (R16.3): the returned promise settles with no further `onToken` calls.
 *
 * ## Why this moved off Workspace_Services
 *
 * Editor autocomplete is a provider inference call, and R6.2 puts provider inference in the runtime — the
 * same reason inline edit moved at 22.12. The Gateway's `routes/completions.py` stays in place until 26.2
 * deletes it; nothing calls it after this.
 *
 * ## What changed, and what deliberately did not
 *
 * **The body no longer carries a credential.** R7.8 puts key resolution inside the runtime, so `apiKey`
 * and `baseUrl` are gone and only the model *selection* travels. That is not optional politeness: the
 * runtime's body schema is a `z.strictObject`, so a request still carrying them is rejected — and because
 * this client fails quiet by contract, that rejection would present as autocomplete simply never
 * appearing. The two fields are dropped explicitly rather than spread, which is what makes it impossible
 * to reintroduce one by widening `ActiveModelRequestContext`.
 *
 * **Everything else is verbatim.** The frame parser, the `event: done` terminal, and the
 * swallow-everything failure contract are unchanged — Monaco calls this on every keystroke, so a toast
 * per failure is unusable, and the parser is the half of this module that had no reason to move.
 */

import { resolveActiveModelRequestContext } from "./active-model-context";
import { resolveRuntimeEndpoint, runtimeAuthHeaders } from "./runtime-endpoint";

export interface CompletionRequestBody {
  prefix: string;
  suffix: string;
  language: string;
  filePath: string;
}

interface SseFrame {
  event: string;
  data: string;
}

function nextSeparator(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^\s/, ""));
  }
  if (dataLines.length === 0) return { event, data: "" };
  return { event, data: dataLines.join("\n") };
}

function extractText(data: string): string {
  try {
    const parsed = JSON.parse(data) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

export async function streamCompletion(
  body: CompletionRequestBody,
  onToken: (chunk: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let runtime: Awaited<ReturnType<typeof resolveRuntimeEndpoint>>;
  let modelContext: Awaited<ReturnType<typeof resolveActiveModelRequestContext>>;
  try {
    [runtime, modelContext] = await Promise.all([
      resolveRuntimeEndpoint(signal),
      resolveActiveModelRequestContext(),
    ]);
  } catch {
    return; // no runtime/model context → quiet (R16.3)
  }
  if (signal.aborted) return;

  let res: Response;
  try {
    res = await fetch(`${runtime.baseUrl}/v1/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...runtimeAuthHeaders(runtime),
      },
      // Named field by field rather than spread: the runtime's schema is closed, and `apiKey` and
      // `baseUrl` must not travel (R7.8).
      body: JSON.stringify({
        prefix: body.prefix,
        suffix: body.suffix,
        language: body.language,
        filePath: body.filePath,
        provider: modelContext.provider,
        model: modelContext.model,
      }),
      signal,
    });
  } catch {
    return; // network error / abort → quiet
  }
  if (!res.ok || !res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = nextSeparator(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const frame = parseFrame(raw);
        if (!frame) continue;
        if (frame.event === "done") return; // distinct terminal (R12.3)
        if (frame.event === "token") {
          const text = extractText(frame.data);
          if (text) onToken(text); // one token per event, in order (R12.1/R12.2)
        }
      }
    }
  } catch {
    // Abort or mid-stream network error → quiet (R16.3).
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}
