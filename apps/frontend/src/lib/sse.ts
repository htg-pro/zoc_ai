/**
 * Minimal text/event-stream parser exposed as an async iterator over typed
 * JSON payloads. Each yielded value is the parsed `data:` line; multi-line
 * `data:` blocks are concatenated with newlines per the SSE spec.
 *
 * We intentionally avoid `EventSource` because:
 *   - it can't POST (the agent run endpoint wants a JSON body), and
 *   - it can't be aborted mid-stream from JS without disposing the object.
 */

export interface SseOptions extends RequestInit {
  signal?: AbortSignal;
}

export async function* sseJson<T = unknown>(
  url: string,
  init: SseOptions = {},
): AsyncIterable<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Accept", "text/event-stream");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok || !res.body) {
    const detail = res.status === 404
      ? `SSE ${url} → http 404 (session not found — the agent may need a valid session created first)`
      : `SSE ${url} → http ${res.status}`;
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          const ev = parseEvent(buffer);
          if (ev !== undefined) yield ev as T;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE events are separated by a blank line (\n\n or \r\n\r\n).
      while ((sep = nextSeparator(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const ev = parseEvent(raw);
        if (ev !== undefined) yield ev as T;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function nextSeparator(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseEvent(raw: string): unknown {
  const lines = raw.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
  }
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join("\n");
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}
