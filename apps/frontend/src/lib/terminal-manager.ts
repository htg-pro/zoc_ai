/**
 * Terminal manager (develop.md Phase 8).
 *
 * Owns the live xterm.js instances + their PTY sessions (via the agent
 * sidecar) OUTSIDE React, keyed by the store's terminal id. Each instance keeps
 * a detached container <div> that the `TerminalPane` mounts/unmounts as the user
 * switches bottom-dock tabs — so scrollback and the running shell persist across
 * tab switches and only go away on an explicit close.
 *
 * The store holds the serializable session metadata (title/profile/status); this
 * module holds everything that can't live in a store (DOM nodes, sockets).
 */
import { getAgentClient, type TerminalStreamEvent } from "./agent-client";
import type { TerminalProfile } from "./store";

interface Instance {
  id: string;
  container: HTMLDivElement;
  // Loosely typed to avoid a hard dependency on xterm types in the lib layer.
  term: { write: (d: string) => void; dispose: () => void; onData: (cb: (d: string) => void) => void; cols: number; rows: number; focus: () => void; clear: () => void } & Record<string, unknown>;
  fit: { fit: () => void };
  abort: AbortController | null;
  backendId: string | null;
  observer: ResizeObserver | null;
  mockBuf: string;
}

type ExitCb = (id: string, code: number | null) => void;
type OpenLinkCb = (path: string, line?: number) => void;

const instances = new Map<string, Instance>();
let onExit: ExitCb = () => undefined;
let onOpenLink: OpenLinkCb = () => undefined;

export function setTerminalCallbacks(cbs: { onExit?: ExitCb; onOpenLink?: OpenLinkCb }): void {
  if (cbs.onExit) onExit = cbs.onExit;
  if (cbs.onOpenLink) onOpenLink = cbs.onOpenLink;
}

export function hasTerminal(id: string): boolean {
  return instances.has(id);
}

/** Create the xterm + PTY for `id` if it doesn't exist yet (idempotent). */
export async function createTerminal(
  id: string,
  profile: TerminalProfile,
  cwd?: string | null,
): Promise<void> {
  if (instances.has(id)) return;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const container = document.createElement("div");
  container.className = "h-full w-full min-h-0";
  const term = new Terminal({
    fontFamily: "JetBrains Mono, ui-monospace, monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: "#0a0a0d", foreground: "#e6e6e8", cursor: "#a78bfa" },
    convertEol: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  const inst: Instance = {
    id,
    container,
    term: term as unknown as Instance["term"],
    fit,
    abort: null,
    backendId: null,
    observer: null,
    mockBuf: "",
  };
  instances.set(id, inst);

  registerLinks(term);

  // Try a real PTY through the sidecar; fall back to a local-echo mock offline.
  try {
    const client = await getAgentClient();
    const session = await client.spawnTerminal(profile.command, {
      cols: term.cols,
      rows: term.rows,
      args: profile.args,
      ...(cwd ? { cwd } : {}),
    });
    inst.backendId = session.id;
    const abort = new AbortController();
    inst.abort = abort;
    void streamInto(client, session.id, inst, abort.signal);
    term.onData((data: string) => {
      if (inst.backendId) void client.writeTerminal(inst.backendId, data).catch(() => undefined);
    });
  } catch (err) {
    term.writeln("\x1b[38;5;141m$ \x1b[0m# agent sidecar offline — mock terminal");
    term.writeln(`\x1b[2m${(err as Error).message}\x1b[0m`);
    term.write("\x1b[38;5;141m$ \x1b[0m");
    wireMock(inst);
  }
}

async function streamInto(
  client: Awaited<ReturnType<typeof getAgentClient>>,
  backendId: string,
  inst: Instance,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const ev of client.terminalStream(backendId, signal) as AsyncIterable<TerminalStreamEvent>) {
      if (ev.type === "data") inst.term.write(ev.chunk);
      else if (ev.type === "exit") {
        inst.term.write(`\r\n\x1b[2m[process exited with code ${ev.code ?? "?"}]\x1b[0m\r\n`);
        onExit(inst.id, ev.code ?? null);
      } else if (ev.type === "error") {
        inst.term.write(`\r\n\x1b[31m[error: ${ev.message}]\x1b[0m\r\n`);
      }
    }
  } catch {
    /* aborted on dispose */
  }
}

function wireMock(inst: Instance): void {
  inst.term.onData((data: string) => {
    if (data === "\r") {
      inst.term.write("\r\n");
      inst.mockBuf = "";
      inst.term.write("\x1b[38;5;141m$ \x1b[0m");
    } else if (data === "\u007f") {
      if (inst.mockBuf.length > 0) {
        inst.mockBuf = inst.mockBuf.slice(0, -1);
        inst.term.write("\b \b");
      }
    } else {
      inst.mockBuf += data;
      inst.term.write(data);
    }
  });
}

const FILE_LINK_RE = /([\w./\\-]+\.[A-Za-z]{1,6}):(\d+)(?::(\d+))?/;

function registerLinks(term: unknown): void {
  const t = term as {
    registerLinkProvider?: (p: unknown) => void;
    buffer?: { active?: { getLine?: (i: number) => { translateToString?: () => string } | undefined } };
  };
  if (typeof t.registerLinkProvider !== "function") return;
  try {
    t.registerLinkProvider({
      provideLinks(lineNumber: number, callback: (links: unknown[] | undefined) => void) {
        const text = t.buffer?.active?.getLine?.(lineNumber - 1)?.translateToString?.() ?? "";
        const m = FILE_LINK_RE.exec(text);
        if (!m || m.index < 0) {
          callback(undefined);
          return;
        }
        const start = m.index + 1;
        callback([
          {
            range: { start: { x: start, y: lineNumber }, end: { x: start + m[0].length, y: lineNumber } },
            text: m[0],
            activate: () => onOpenLink(m[1], Number(m[2])),
          },
        ]);
      },
    });
  } catch {
    /* link provider API mismatch — links are a nice-to-have */
  }
}

export function mountTerminal(id: string, parent: HTMLElement): void {
  const inst = instances.get(id);
  if (!inst) return;
  parent.appendChild(inst.container);
  inst.fit.fit();
  inst.term.focus();
  const onResize = () => {
    inst.fit.fit();
    if (inst.backendId) {
      void getAgentClient()
        .then((c) => c.resizeTerminal(inst.backendId!, inst.term.cols, inst.term.rows))
        .catch(() => undefined);
    }
  };
  inst.observer?.disconnect();
  inst.observer = new ResizeObserver(onResize);
  inst.observer.observe(parent);
  onResize();
}

export function unmountTerminal(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  inst.observer?.disconnect();
  inst.observer = null;
  inst.container.remove();
}

export function findInTerminal(id: string, query: string, dir: "next" | "prev" = "next"): boolean {
  const inst = instances.get(id);
  if (!inst || !query) return false;
  // Dependency-free find: scan the buffer for the query and scroll to it.
  const term = inst.term as unknown as {
    buffer?: { active?: { length: number; getLine?: (i: number) => { translateToString?: () => string } | undefined } };
    scrollToLine?: (n: number) => void;
  };
  const len = term.buffer?.active?.length ?? 0;
  const q = query.toLowerCase();
  const order = dir === "next" ? range(0, len) : range(len - 1, -1, -1);
  for (const i of order) {
    const line = term.buffer?.active?.getLine?.(i)?.translateToString?.() ?? "";
    if (line.toLowerCase().includes(q)) {
      term.scrollToLine?.(i);
      return true;
    }
  }
  return false;
}

function range(start: number, end: number, step = 1): number[] {
  const out: number[] = [];
  for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i);
  return out;
}

export function clearTerminal(id: string): void {
  instances.get(id)?.term.clear();
}

/** Kill the backend PTY for `id` but keep the xterm (so scrollback stays). */
export async function killTerminal(id: string): Promise<void> {
  const inst = instances.get(id);
  if (!inst?.backendId) return;
  try {
    const client = await getAgentClient();
    await client.stopTerminal(inst.backendId);
  } catch {
    /* already gone */
  }
}

/** Fully dispose: kill the backend, abort the stream, destroy the xterm. */
export async function disposeTerminal(id: string): Promise<void> {
  const inst = instances.get(id);
  if (!inst) return;
  instances.delete(id);
  inst.abort?.abort();
  inst.observer?.disconnect();
  if (inst.backendId) {
    try {
      const client = await getAgentClient();
      await client.stopTerminal(inst.backendId);
    } catch {
      /* ignore */
    }
  }
  try {
    inst.term.dispose();
  } catch {
    /* ignore */
  }
  inst.container.remove();
}
