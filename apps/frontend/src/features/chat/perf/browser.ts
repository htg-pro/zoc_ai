/**
 * A dependency-free Chrome DevTools Protocol client — zoc-agent-chat-rebuild task 17.6.
 *
 * Budgets 19.4 and 20.5 need two things no other test in this repo needs: a real compositor, so
 * animation-frame intervals mean something, and `Runtime.getHeapUsage` after a forced collection, so
 * a heap figure is a measurement rather than a guess. jsdom has neither, and the Tauri WebView exposes
 * neither API — so the two budgets run against headless Chromium over CDP.
 *
 * ## Why this is hand-written rather than `puppeteer`
 *
 * Puppeteer would add a ~170 MB browser download to every `pnpm install` in the repo, including CI
 * runs that never execute a `@perf` test, to use perhaps five of its methods. What is actually needed
 * is: launch a browser, open a tab, evaluate an expression, force a collection, and read two numbers.
 * Node's global `WebSocket` covers the transport, so the whole client is the file you are reading.
 *
 * Anything more elaborate — request interception, selector engines, screenshots — belongs to whatever
 * end-to-end harness the project grows later, not here.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Where a Chromium might be, in the order tried.
 *
 * `ZOC_PERF_CHROME` wins, so a fixed runner names its own binary rather than depending on what a
 * distribution happens to have installed.
 */
const CHROME_CANDIDATES: readonly (string | undefined)[] = [
  process.env.ZOC_PERF_CHROME,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** The first Chromium on disk, or `null` — which is what makes the `@perf` suite skip rather than fail. */
export function findChrome(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Milliseconds a single CDP command may take before it is treated as a hang.
 *
 * Per-command rather than global, because one command legitimately takes far longer than the rest: an
 * `evaluate` that drives a 30 s stream in the page does not return until the stream ends, and a fixed
 * ceiling would report the budget's own duration as a protocol hang.
 */
const COMMAND_TIMEOUT_MS = 30_000;

/** Milliseconds to wait for the browser to print its WebSocket endpoint. */
const LAUNCH_TIMEOUT_MS = 30_000;

interface PendingCommand {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

/**
 * One CDP connection, multiplexing commands and events over a single socket.
 *
 * Flat sessions (`flatten: true` on attach) rather than the legacy nested protocol, so a page command
 * is the same `send` with a `sessionId` and there is no second envelope to unwrap.
 */
class CdpConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (raw.length === 0) return;
      const message = JSON.parse(raw) as CdpMessage;
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== undefined) {
          entry.reject(new Error(message.error.message ?? "CDP command failed."));
        } else {
          entry.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method !== undefined) {
        for (const handler of this.handlers.get(message.method) ?? []) {
          handler(message.params ?? {});
        }
      }
    });
  }

  static async open(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve();
      });
      socket.addEventListener("error", () => {
        reject(new Error(`Could not connect to the browser at ${url}.`));
      });
    });
    return new CdpConnection(socket);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          resolve(result as T);
        },
        reject,
        timer,
      });
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
      );
    });
  }

  /** Resolve on the next occurrence of `method`. */
  once(method: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const handler = (params: Record<string, unknown>) => {
        this.handlers.get(method)?.delete(handler);
        resolve(params);
      };
      const existing = this.handlers.get(method) ?? new Set();
      existing.add(handler);
      this.handlers.set(method, existing);
    });
  }

  close(): void {
    for (const [, entry] of this.pending) clearTimeout(entry.timer);
    this.pending.clear();
    this.socket.close();
  }
}

export interface PerfBrowser {
  /** Load a URL and resolve when the page's load event has fired. */
  navigate(url: string): Promise<void>;
  /**
   * Evaluate an expression in the page and return its value.
   *
   * Promises are awaited and the result is returned by value, so a caller reads a plain object rather
   * than a remote object handle — which is the only reason this client needs no object graph at all.
   */
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  /** Force a garbage collection, so a heap reading is not dominated by uncollected garbage. */
  collectGarbage(): Promise<void>;
  /** Bytes of JavaScript heap in use, after whatever collection the caller forced. */
  heapUsedBytes(): Promise<number>;
  close(): Promise<void>;
}

/** Launch headless Chromium and open one page, ready to navigate. */
export async function launchPerfBrowser(binary: string): Promise<PerfBrowser> {
  const profile = mkdtempSync(path.join(tmpdir(), "zoc-perf-"));
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    binary,
    [
      "--headless=new",
      // Sandboxing is off because these runs happen inside containers that do not grant the
      // namespaces Chromium's sandbox needs, and the page under test is a local fixture.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // Nothing here should reach the network, and a background fetch would show up in the heap.
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      // A fixed window, so the number of rows in the viewport is not a property of the runner.
      "--window-size=1280,900",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const endpoint = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error("The browser did not report a DevTools endpoint."));
    }, LAUNCH_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = /ws:\/\/[^\s]+/.exec(buffer);
      if (match === null) return;
      clearTimeout(timer);
      child.stderr.off("data", onData);
      resolve(match[0]);
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The browser exited before it was ready (code ${String(code)}).`));
    });
  });

  const connection = await CdpConnection.open(endpoint);
  const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  await connection.send("Page.enable", {}, sessionId);
  await connection.send("Runtime.enable", {}, sessionId);
  await connection.send("HeapProfiler.enable", {}, sessionId);

  return {
    async navigate(url) {
      const loaded = connection.once("Page.loadEventFired");
      await connection.send("Page.navigate", { url }, sessionId);
      await loaded;
    },
    async evaluate<T>(expression: string, timeoutMs?: number) {
      const response = await connection.send<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
        timeoutMs,
      );
      if (response.exceptionDetails !== undefined) {
        const detail =
          response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "unknown error";
        throw new Error(`The page threw while evaluating: ${detail}`);
      }
      return response.result?.value as T;
    },
    async collectGarbage() {
      await connection.send("HeapProfiler.collectGarbage", {}, sessionId);
    },
    async heapUsedBytes() {
      const usage = await connection.send<{ usedSize?: number }>(
        "Runtime.getHeapUsage",
        {},
        sessionId,
      );
      return usage.usedSize ?? 0;
    },
    async close() {
      try {
        await connection.send("Target.closeTarget", { targetId });
      } catch {
        // The target may already be gone; the kill below is what actually matters.
      }
      connection.close();
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        child.on("exit", () => {
          resolve();
        });
        setTimeout(resolve, 2_000);
      });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
