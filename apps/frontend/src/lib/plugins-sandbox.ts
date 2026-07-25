/**
 * Plugin execution sandbox (Part 5.1). One Web Worker per enabled plugin,
 * running `public/plugin-host.js`, exposing only a `zoc.*` API. Privileged
 * calls are proxied to the main thread; `terminal.run` is gated by the
 * permission engine. A crashing worker is isolated (marked errored +
 * terminated) without affecting the host or other plugins.
 *
 * The manager takes an injectable `workerFactory` (a real `Worker` by default)
 * and pure host-API handlers, so the message protocol, permission gating, and
 * failure isolation are unit-/property-testable with a fake worker — no real
 * Web Worker required.
 */
import type { Decision } from "./permissions-engine";

// ── message protocol ────────────────────────────────────────────────────
export interface ApiRequestMessage {
  type: "api-request";
  pluginId: string;
  reqId: number;
  api: string;
  method: string;
  args: unknown[];
}

export type WorkerMessage =
  | { type: "ready"; pluginId: string }
  | { type: "register-command"; pluginId: string; commandId: string }
  | ApiRequestMessage
  | { type: "invoke-result"; callId: number; ok: boolean; error?: string }
  | { type: "error"; pluginId: string; message: string };

export type HostMessage =
  | { type: "load"; pluginId: string; code: string }
  | { type: "invoke"; callId: number; commandId: string }
  | { type: "api-response"; reqId: number; ok: boolean; value?: unknown; error?: string };

/** The minimal worker surface the manager uses (a real `Worker` satisfies it). */
export interface SandboxWorker {
  postMessage(message: HostMessage): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerMessage }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface SandboxDeps {
  workerFactory: (pluginId: string) => SandboxWorker;
  checkTerminalPermission: (command: string) => Decision;
  runTerminal: (command: string) => Promise<string>;
  editor: { getText(): string; setText(text: string): void; getSelection(): string };
  storage: {
    get(pluginId: string, key: string): unknown;
    set(pluginId: string, key: string, value: unknown): void;
  };
  ui: { showMessage(message: string, level: string): void };
  onRegisterCommand: (pluginId: string, commandId: string) => void;
  onError: (pluginId: string, message: string) => void;
  onStop?: (pluginId: string) => void;
}

export interface ApiResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface PluginSandbox {
  load(pluginId: string, code: string): void;
  invokeCommand(pluginId: string, commandId: string): void;
  stop(pluginId: string): void;
  stopAll(): void;
  running(): ReadonlySet<string>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * Resolve one `api-request` against the host handlers. `terminal.run` is gated
 * by the permission engine: it runs iff the decision is `allow`, else it
 * resolves with `{ ok:false, error:"permission denied" }` and never runs.
 */
export async function resolveApiRequest(
  message: ApiRequestMessage,
  deps: SandboxDeps,
  owningPluginId = message.pluginId,
): Promise<ApiResult> {
  const { api, method, args } = message;
  try {
    if (api === "terminal" && method === "run") {
      const command = asString(args[0]);
      const decision = deps.checkTerminalPermission(command);
      if (decision.effect !== "allow") {
        return { ok: false, error: "permission denied" };
      }
      return { ok: true, value: await deps.runTerminal(command) };
    }
    if (api === "editor") {
      if (method === "getText") return { ok: true, value: deps.editor.getText() };
      if (method === "getSelection") return { ok: true, value: deps.editor.getSelection() };
      if (method === "setText") {
        deps.editor.setText(asString(args[0]));
        return { ok: true };
      }
    }
    if (api === "storage") {
      if (method === "get") {
        return { ok: true, value: deps.storage.get(owningPluginId, asString(args[0])) };
      }
      if (method === "set") {
        deps.storage.set(owningPluginId, asString(args[0]), args[1]);
        return { ok: true };
      }
    }
    if (api === "ui" && method === "showMessage") {
      deps.ui.showMessage(asString(args[0]), asString(args[1]));
      return { ok: true };
    }
    return { ok: false, error: `unknown api: ${api}.${method}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createPluginSandbox(deps: SandboxDeps): PluginSandbox {
  const workers = new Map<string, SandboxWorker>();
  const loadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingCalls = new Map<
    number,
    { pluginId: string; timer: ReturnType<typeof setTimeout> }
  >();
  let callSeq = 0;

  const clearLoadTimer = (pluginId: string): void => {
    const timer = loadTimers.get(pluginId);
    if (timer) clearTimeout(timer);
    loadTimers.delete(pluginId);
  };

  const stop = (pluginId: string): void => {
    const worker = workers.get(pluginId);
    workers.delete(pluginId);
    clearLoadTimer(pluginId);
    for (const [callId, pending] of pendingCalls) {
      if (pending.pluginId !== pluginId) continue;
      clearTimeout(pending.timer);
      pendingCalls.delete(callId);
    }
    if (worker) {
      try {
        worker.terminate();
      } catch {
        /* terminate is best-effort */
      }
    }
    try {
      deps.onStop?.(pluginId);
    } catch {
      /* a host notification must not keep an untrusted worker alive */
    }
  };

  const fail = (pluginId: string, message: string): void => {
    try {
      deps.onError(pluginId, message);
    } catch {
      /* host error reporting is isolated from sandbox teardown */
    } finally {
      stop(pluginId);
    }
  };

  const handleMessage = (
    pluginId: string,
    origin: SandboxWorker,
    incoming: WorkerMessage,
  ): void => {
    if (!incoming || typeof incoming !== "object" || typeof incoming.type !== "string") {
      fail(pluginId, "invalid worker message");
      return;
    }
    // Never trust the identity supplied by worker code; `pluginId` is the
    // manager-owned identity captured when this worker was created.
    switch (incoming.type) {
      case "register-command": {
        if (
          typeof incoming.commandId !== "string" ||
          incoming.commandId.trim() === "" ||
          incoming.commandId.length > 256
        ) {
          fail(pluginId, "invalid command registration");
          return;
        }
        try {
          deps.onRegisterCommand(pluginId, incoming.commandId);
        } catch (error) {
          fail(
            pluginId,
            `command registration failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case "api-request": {
        if (
          !Number.isSafeInteger(incoming.reqId) ||
          typeof incoming.api !== "string" ||
          typeof incoming.method !== "string" ||
          !Array.isArray(incoming.args)
        ) {
          fail(pluginId, "invalid API request");
          return;
        }
        void resolveApiRequest(incoming, deps, pluginId).then((result) => {
          if (workers.get(pluginId) !== origin) return;
          try {
            origin.postMessage({ type: "api-response", reqId: incoming.reqId, ...result });
          } catch (error) {
            fail(
              pluginId,
              `worker response failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        });
        break;
      }
      case "invoke-result": {
        const pending = pendingCalls.get(incoming.callId);
        if (!pending || pending.pluginId !== pluginId) {
          fail(pluginId, "invalid command invocation response");
          return;
        }
        clearTimeout(pending.timer);
        pendingCalls.delete(incoming.callId);
        if (!incoming.ok) {
          fail(pluginId, `command failed: ${incoming.error || "plugin handler rejected"}`);
        }
        break;
      }
      case "error":
        fail(pluginId, typeof incoming.message === "string" ? incoming.message : "plugin error");
        break;
      case "ready":
        clearLoadTimer(pluginId);
        break;
      default:
        fail(pluginId, "unknown worker message");
    }
  };

  return {
    load(pluginId, code) {
      if (workers.has(pluginId)) return; // one worker per plugin
      let worker: SandboxWorker;
      try {
        worker = deps.workerFactory(pluginId);
        if (
          !worker ||
          typeof worker.postMessage !== "function" ||
          typeof worker.terminate !== "function"
        ) {
          throw new Error("worker factory returned an invalid worker");
        }
        workers.set(pluginId, worker);
        worker.onmessage = (event) => {
          try {
            handleMessage(pluginId, worker, event.data);
          } catch (error) {
            fail(pluginId, error instanceof Error ? error.message : String(error));
          }
        };
        worker.onerror = (event) => fail(pluginId, event?.message ?? "worker error");
        loadTimers.set(
          pluginId,
          setTimeout(() => fail(pluginId, "plugin activation timed out"), 10_000),
        );
        worker.postMessage({ type: "load", pluginId, code });
      } catch (error) {
        fail(
          pluginId,
          `worker startup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    invokeCommand(pluginId, commandId) {
      const worker = workers.get(pluginId);
      if (!worker) return; // an unloaded plugin's command is not invocable
      callSeq += 1;
      const callId = callSeq;
      const timer = setTimeout(() => {
        pendingCalls.delete(callId);
        fail(pluginId, `command timed out: ${commandId}`);
      }, 30_000);
      pendingCalls.set(callId, { pluginId, timer });
      try {
        worker.postMessage({ type: "invoke", callId, commandId });
      } catch (error) {
        clearTimeout(timer);
        pendingCalls.delete(callId);
        fail(
          pluginId,
          `command dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    stop,
    stopAll() {
      for (const pluginId of [...workers.keys()]) stop(pluginId);
    },
    running() {
      return new Set(workers.keys());
    },
  };
}
