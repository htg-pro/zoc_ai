/**
 * Streaming completions client (§3.3, R11.1/R12/R16.3).
 *
 * An abortable `fetch` POST to the Gateway `POST /v1/completions` (resolving the
 * loopback port like `agent-client.ts`) that parses the Server-Sent Events
 * stream, forwarding each `event: token` chunk (`{"text": …}`) to `onToken` and
 * resolving on the distinct `event: done` terminal. Network errors and aborts
 * are swallowed quietly so an unavailable Gateway never interrupts typing
 * (R16.3): the returned promise settles with no further `onToken` calls.
 */

import { resolveAgentPort } from "./agent-port";

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
  let port: number;
  try {
    port = await resolveAgentPort();
  } catch {
    return; // no sidecar → quiet (R16.3)
  }
  if (signal.aborted) return;

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
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
